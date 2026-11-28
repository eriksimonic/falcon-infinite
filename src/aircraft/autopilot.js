// F-16 autopilot (FBW attitude/altitude hold) and ILS approach computer.
//
// Control sign conventions (verified against flight.js / main.js):
//   cmd.pitch > 0  -> nose up.
//   cmd.roll  > 0  -> bank LEFT (main.js maps KeyA to +1), i.e. the opposite of
//                     flight.rollDeg, which is positive for a right bank.
// The autopilot works in aviation bank-angle degrees (right positive, matching
// flight.rollDeg / HUD) and negates only when it builds the stick command.
import { emit } from '../core/events.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const FT_PER_M = 3.280839895;
const M_PER_NM = 1852;

const ALT_PITCH_LIMIT = 12;   // degrees, max climb/descent pitch in ALT_HDG
const BANK_LIMIT = 28;        // degrees, max bank in ALT_HDG
const ATT_PITCH_LIMIT = 30;   // degrees, ATT mode target pitch clamp
const ATT_BANK_LIMIT = 60;    // degrees, ATT mode target bank clamp

const MANUAL_STICK = 0.35;    // |stick| above this hands control back to the pilot
const SMOOTHING = 0.25;       // per-frame command low-pass (smooth FBW feel)

const LOC_FULL_SCALE_DEG = 5;   // localizer full-scale deflection
const GS_FULL_SCALE_DEG = 1.2;  // glideslope full-scale deflection
const GS_ANGLE_DEG = 3;         // standard 3 degree glideslope
const ILS_RANGE_M = 18000;      // localizer reception range
const ILS_MAX_OFF_DEG = 45;     // max angular offset from extended centreline

// ---- Smart autoland / auto-refuel flight-plan geometry.
const AP_GS_DEG = 3.2;                      // autoland glideslope (deg)
const AP_GS_TAN = Math.tan(AP_GS_DEG * RAD);
const FAF_BACK_M = 6500;                    // final approach fix behind the threshold
const PATTERN_BASE_BACK_M = 8200;           // base-entry point behind the threshold
const PATTERN_BASE_OFFSET_M = 2400;         // lateral offset of the base-entry point
const PATTERN_EXIT_RADIUS_M = 2200;         // base point capture radius
const SEL_TURN_COST_M_PER_DEG = 55;         // runway-end selection: metres per degree of turn
const CONTACT_ALT_DROP_M = 8.5;             // aim point below the tanker (2..12 m box)

const LAND_LEGS = [
  { id: 'PATTERN', label: 'Base / Downwind Entry' },
  { id: 'INTERCEPT', label: 'FAF Alignment' },
  { id: 'FINAL', label: '3° Glideslope' },
  { id: 'FLARE', label: 'Flare' },
  { id: 'ROLLOUT', label: 'Rollout' },
];

const REFUEL_LEGS = [
  { id: 'RENDEZVOUS', label: 'Lead Intercept' },
  { id: 'JOIN', label: 'Trail & Speed Match' },
  { id: 'CONTACT', label: 'Boom Box Hold & Refuel' },
];

// Radar-altitude callouts, in feet above ground. "MINIMUMS" shares the 200 ft
// decision height and is announced right after the 200 ft altitude callout.
const CALLOUTS = [
  { key: '500', text: 'Five hundred', aglFt: 500 },
  { key: '200', text: 'Two hundred', aglFt: 200 },
  { key: 'MINIMUMS', text: 'Minimums', aglFt: 200 },
  { key: '100', text: 'One hundred', aglFt: 100 },
  { key: '50', text: 'Fifty', aglFt: 50 },
];
const CALLOUT_RESET_AGL_M = 220; // climbing above ~720 ft arms a new approach

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrap180(deg) {
  let d = (deg + 180) % 360;
  if (d < 0) d += 360;
  return d - 180;
}

// Shortest signed difference target - current, in -180..+180.
function headingError(target, current) {
  return wrap180((target || 0) - (current || 0));
}

function norm360(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Bank (deg, right positive) needed to hold a turn rate omega at `speed`. */
function orbitBankDeg(omega, tSpeed, speed) {
  if (!Number.isFinite(omega) || Math.abs(omega) < 1e-9 || !(tSpeed > 1) || !(speed > 1)) return 0;
  const bank = Math.atan2(speed * speed * Math.abs(omega) / (tSpeed * 9.81), 1) * DEG;
  return omega > 0 ? bank : -bank;
}

// Approach speed schedule: 78 m/s on-speed 2.5 km from the threshold, rising
// linearly with distance to go (175 m/s at 10 km). A continuous schedule is
// what lets the autothrottle fly the deceleration instead of the speedbrake;
// a stepped target made the aircraft arrive over-speed at every step.
const APPROACH_VREF_MS = 78;
const APPROACH_SPEED_SLOPE = 0.0105; // m/s per metre of distance-to-go
function approachSpeedSchedule(dist) {
  return clamp(APPROACH_VREF_MS + (dist - 2500) * APPROACH_SPEED_SLOPE, APPROACH_VREF_MS, 175);
}

function runwayNumber(headingDeg) {
  let n = Math.round((((headingDeg % 360) + 360) % 360) / 10);
  if (n === 0) n = 36;
  return String(n).padStart(2, '0');
}

export class AutopilotSystem {
  constructor() {
    this.mode = 'OFF';
    this.targetAlt = 0;
    this.targetHeading = 0;
    this.targetPitch = 0;
    this.targetRoll = 0;

    this._pitchCmd = 0;
    this._rollCmd = 0;
    this._yawCmd = 0;

    // Smart-mode state: human-readable sub-phase (INTERCEPT / FINAL / FLARE /
    // ROLLOUT / RENDEZVOUS / JOIN / CONTACT), the target's label, and a
    // one-shot completion notice drained by the presentation layer.
    this.phase = '';
    this.targetLabel = '';
    this._completeMsg = null;

    // Explicit multi-leg flight plan for the smart modes. Each step is
    // { id, label, status: 'done'|'active'|'pending', detail? }.
    this.plan = [];
    this._distM = 0;
    this._etaSec = 0;

    // Latched approach state (AUTO_LAND).
    this._airport = null;
    this._airportCode = '';
    this._runwayHeading = null;
    this._runwayLabel = '';
    this._side = 1;
    this._finalCaptured = false;
    this._patternComplete = false;
    // Latched speedbrake state: the airbrake only ever opens on a genuine
    // overspeed and stays stowed until the speed has truly decayed.
    this._airbrake = false;
    // Slow autothrottle integrator that learns the power needed to hold the
    // approach speed schedule (the proportional law alone settles fast).
    this._spdTrim = 0;
    // Slow autothrottle integrator for the live tanker (learns the drag trim).
    this._throttleTrim = 0;
  }

  /** Build a fresh plan from leg templates. */
  _buildPlan(legs) {
    this.plan = legs.map((leg) => ({ id: leg.id, label: leg.label, status: 'pending' }));
  }

  /** Mark every leg as complete (mode finished cleanly). */
  _completePlan() {
    for (const step of this.plan) step.status = 'done';
  }

  /** Advance the plan's done/active/pending markers to the live phase. */
  _syncPlan() {
    let reached = false;
    for (const step of this.plan) {
      if (step.id === this.phase) {
        step.status = 'active';
        reached = true;
      } else {
        step.status = reached ? 'pending' : 'done';
      }
    }
  }

  _setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this._syncPlan();
  }

  /** Structured snapshot of what the smart mode is doing and its progress. */
  getPlanSummary() {
    return {
      mode: this.mode,
      targetLabel: this.targetLabel,
      runwayLabel: this._runwayLabel,
      phase: this.phase,
      distM: this._distM,
      etaSec: this._etaSec,
      steps: this.plan,
    };
  }

  /**
   * Engage the smart autoland computer for `airport`.
   * Refused for a missing/crashed airframe or a missing airport.
   * @returns {boolean} true when the mode engaged
   */
  engageAutoLand(flight, airport) {
    if (!flight || flight.crashed || !airport) return false;
    this.mode = 'AUTO_LAND';
    this.targetLabel = airport.code || airport.name || 'AIRBASE';
    this._airport = airport;
    this._airportCode = airport.code || airport.name || '';
    this._completeMsg = null;
    this._airbrake = false;
    this._spdTrim = 0;
    this._resetCommand();
    this._buildPlan(LAND_LEGS);

    const pos = flight.position || { x: 0, y: 0, z: 0 };
    const acHeading = flight.heading || 0;
    const apHeading = norm360(airport.heading || 0);
    const recip = norm360(apHeading + 180);
    const half = (airport.length || 0) * 0.5;
    const cx = airport.x || 0;
    const cz = airport.z || 0;

    // Choose the runway end ONCE, by the cost of reaching its 6.5 km final
    // approach fix: distance plus a heading-turn penalty. Latching this kills
    // the old mid-turn runway flip / figure-eight loop.
    const selectionCost = (rwy) => {
      const fx = Math.sin(rwy * RAD);
      const fz = -Math.cos(rwy * RAD);
      const fafX = cx - fx * (half + FAF_BACK_M);
      const fafZ = cz - fz * (half + FAF_BACK_M);
      const reach = Math.hypot(pos.x - fafX, pos.z - fafZ);
      return reach + Math.abs(headingError(rwy, acHeading)) * SEL_TURN_COST_M_PER_DEG;
    };
    this._runwayHeading = selectionCost(apHeading) <= selectionCost(recip) ? apHeading : recip;
    this._runwayLabel = 'RWY ' + runwayNumber(this._runwayHeading);

    const fx = Math.sin(this._runwayHeading * RAD);
    const fz = -Math.cos(this._runwayHeading * RAD);
    const rx = Math.cos(this._runwayHeading * RAD);
    const rz = Math.sin(this._runwayHeading * RAD);
    const thX = cx - fx * half;
    const thZ = cz - fz * half;
    const along = (pos.x - thX) * fx + (pos.z - thZ) * fz;
    const lateral = (pos.x - thX) * rx + (pos.z - thZ) * rz;
    const dist = Math.hypot(pos.x - thX, pos.z - thZ);
    const hdgErr = Math.abs(headingError(this._runwayHeading, acHeading));

    // Latch the side of the runway the pattern arcs around for the whole approach.
    this._side = lateral >= 0 ? 1 : -1;
    this._finalCaptured = !flight.onGround && along < 250
      && Math.abs(lateral) < 1600 && dist < 9500 && hdgErr < 45;

    if (flight.onGround) {
      this.phase = 'ROLLOUT';
    } else if (this._finalCaptured) {
      this.phase = 'FINAL';
    } else if (along > -3500 || Math.abs(lateral) > 2600 || hdgErr > 65) {
      this.phase = 'PATTERN';
    } else {
      this.phase = 'INTERCEPT';
    }
    this._patternComplete = this.phase !== 'PATTERN';
    this._syncPlan();
    this._distM = dist;
    this._etaSec = dist / 40;
    return true;
  }

  /**
   * Engage the smart air-to-air refuelling computer for `tanker`.
   * Refused on the ground, after a crash, or without a tanker.
   * @returns {boolean} true when the mode engaged
   */
  engageAutoRefuel(flight, tanker) {
    if (!flight || flight.onGround || flight.crashed || !tanker) return false;
    this.mode = 'AUTO_REFUEL';
    this.phase = 'RENDEZVOUS';
    this.targetLabel = 'KC-135';
    this._runwayHeading = null;
    this._runwayLabel = '';
    this._throttleTrim = 0;
    this._airbrake = false;
    this._completeMsg = null;
    this._resetCommand();
    this._buildPlan(REFUEL_LEGS);
    this._syncPlan();
    this._distM = 0;
    this._etaSec = 0;
    return true;
  }

  /** Returns and clears the pending completion notice, or null. */
  consumeNotice() {
    const msg = this._completeMsg;
    this._completeMsg = null;
    return msg;
  }

  /** OFF -> ALT_HDG -> ATT -> OFF. Engagement is refused on the ground or in a stall. */
  cycleMode(flight) {
    if (!flight || flight.onGround || flight.stall || flight.crashed) {
      this.disengage();
      return this.mode;
    }
    const next = this.mode === 'OFF' ? 'ALT_HDG' : this.mode === 'ALT_HDG' ? 'ATT' : 'OFF';
    this.mode = next;
    if (next !== 'OFF') this._latch(flight);
    else this._resetCommand();
    return this.mode;
  }

  disengage() {
    this.mode = 'OFF';
    this.phase = '';
    this._airbrake = false;
    this._spdTrim = 0;
    this._resetCommand();
  }

  _resetCommand() {
    this._pitchCmd = 0;
    this._rollCmd = 0;
    this._yawCmd = 0;
  }

  /**
   * Latched speedbrake: engage only on a genuine overspeed, release once the
   * speed has decayed well back inside the schedule. The wide gap between
   * `engageOver` and `releaseOver` is the hysteresis that stops the HUD BRK
   * light and the tail paddles chattering on approach.
   */
  _updateAirbrake(speed, spdTarget, engageOver = 30, releaseOver = 10) {
    if (this._airbrake) {
      if (speed <= spdTarget + releaseOver) this._airbrake = false;
    } else if (speed > spdTarget + engageOver) {
      this._airbrake = true;
    }
    return this._airbrake;
  }

  /**
   * Descent-aware approach autothrottle: proportional speed law on a low
   * descent baseline plus a slow trim integrator. Without the trim the
   * proportional law settles several m/s fast on a glideslope, and that
   * permanent overspeed is what used to keep the speedbrake fighting the
   * throttle through the whole approach.
   */
  _approachThrottle(spdTarget, speed, base, gain, lo = 0.02, hi = 0.92) {
    this._spdTrim = clamp(this._spdTrim + (spdTarget - speed) * 0.00008, -0.30, 0.30);
    return clamp(base + (spdTarget - speed) * gain + this._spdTrim, lo, hi);
  }

  /** Snapshot the aircraft state the autopilot is asked to hold. */
  _latch(flight) {
    this.targetAlt = flight.position ? flight.position.y : 0;
    this.targetHeading = flight.heading || 0;
    this.targetPitch = flight.pitchDeg || 0;
    this.targetRoll = flight.rollDeg || 0;
    this._pitchCmd = 0;
    this._rollCmd = 0;
    this._yawCmd = 0;
  }

  /**
   * Shared inner attitude loop: pitch/bank target (degrees, right-bank
   * positive) -> smoothed stick commands. Yaw is eased back to neutral.
   * Optional gains let the precision smart modes run lighter pitch gains.
   */
  _flyAttitude(flight, baseCmd, pitchTarget, bankTarget, opts = null) {
    const cmd = baseCmd || { pitch: 0, roll: 0, yaw: 0 };
    const pitchGain = opts && Number.isFinite(opts.pitchGain) ? opts.pitchGain : 0.09;
    const rollGain = opts && Number.isFinite(opts.rollGain) ? opts.rollGain : 0.05;
    const pitchDamp = opts && Number.isFinite(opts.pitchDamp) ? opts.pitchDamp : 1.0;
    const rollDamp = opts && Number.isFinite(opts.rollDamp) ? opts.rollDamp : 0.35;
    const pitchLimit = opts && Number.isFinite(opts.pitchLimit) ? opts.pitchLimit : 1;
    const rollLimit = opts && Number.isFinite(opts.rollLimit) ? opts.rollLimit : 1;
    const pitchRate = flight.rates ? flight.rates.x || 0 : 0;
    const rollRate = flight.rates ? flight.rates.z || 0 : 0;
    const pitch = clamp((pitchTarget - (flight.pitchDeg || 0)) * pitchGain - pitchRate * pitchDamp, -pitchLimit, pitchLimit);
    // rollDeg positive = right bank; +stick rolls left, so invert.
    const roll = clamp(-((bankTarget - (flight.rollDeg || 0)) * rollGain) - rollRate * rollDamp, -rollLimit, rollLimit);
    this._pitchCmd += (pitch - this._pitchCmd) * SMOOTHING;
    this._rollCmd += (roll - this._rollCmd) * SMOOTHING;
    this._yawCmd += (0 - this._yawCmd) * SMOOTHING;
    return { ...cmd, pitch: this._pitchCmd, roll: this._rollCmd, yaw: this._yawCmd };
  }

  /** Terrain floor ahead of the jet (sampled at the current point and 600 m out). */
  _terrainFloor(flight, context) {
    const sample = context && context.terrainHeight;
    const pos = flight.position;
    if (typeof sample !== 'function' || !pos) return 0;
    const hdg = (flight.heading || 0) * RAD;
    const h0 = sample(pos.x, pos.z);
    const h1 = sample(pos.x + Math.sin(hdg) * 600, pos.z - Math.cos(hdg) * 600);
    const a = Number.isFinite(h0) ? h0 : 0;
    const b = Number.isFinite(h1) ? h1 : 0;
    return Math.max(a, b);
  }

  /**
   * Blend the pilot's stick command with the autopilot laws.
   * Returns baseCmd untouched (same object) whenever the jet is not being flown
   * by the autopilot, and a fresh { ...baseCmd, pitch, roll } object otherwise.
   */
  computeCommand(flight, baseCmd, context = null) {
    const cmd = baseCmd || { pitch: 0, roll: 0, yaw: 0 };
    if (this.mode === 'OFF') return baseCmd;
    // Smart modes own the ground phase (ROLLOUT), so ground contact only
    // disengages the classic hold modes below.
    if (!flight || flight.crashed || flight.stall) {
      this.disengage();
      return baseCmd;
    }
    // Any deliberate stick input takes priority and clicks the autopilot off,
    // including the smart modes: the pilot is always in command.
    if (Math.abs(cmd.pitch || 0) > MANUAL_STICK || Math.abs(cmd.roll || 0) > MANUAL_STICK) {
      this.disengage();
      return baseCmd;
    }
    if (this.mode === 'AUTO_LAND') return this._computeAutoLand(flight, baseCmd, context);
    if (this.mode === 'AUTO_REFUEL') {
      if (flight.onGround) {
        this.disengage();
        return baseCmd;
      }
      return this._computeAutoRefuel(flight, baseCmd, context);
    }
    if (flight.onGround) {
      this.disengage();
      return baseCmd;
    }

    let pitchTarget;
    let bankTarget;
    if (this.mode === 'ATT') {
      pitchTarget = clamp(this.targetPitch, -ATT_PITCH_LIMIT, ATT_PITCH_LIMIT);
      bankTarget = clamp(this.targetRoll, -ATT_BANK_LIMIT, ATT_BANK_LIMIT);
    } else {
      // ---- ALT_HDG: altitude via vertical-speed -> flight path -> pitch attitude.
      const alt = flight.position ? flight.position.y : 0;
      const vs = flight.verticalSpeed || 0;
      const altErr = this.targetAlt - alt;
      const speed = Math.max(40, flight.speed || 0);
      // Desired climb rate, damped by actual climb rate to avoid zoom climbs.
      const vsTarget = clamp(altErr * 0.08 - vs * 0.25, -10, 10);
      const flightPathDeg = Math.asin(clamp(vsTarget / speed, -0.4, 0.4)) * DEG;
      const aoaDeg = (flight.aoa || 0) * DEG;
      pitchTarget = clamp(flightPathDeg + aoaDeg, -ALT_PITCH_LIMIT, ALT_PITCH_LIMIT);

      const hdgErr = headingError(this.targetHeading, flight.heading || 0);
      bankTarget = clamp(hdgErr * 2.2, -BANK_LIMIT, BANK_LIMIT);
    }

    // Inner attitude loops: angle error -> body-rate request, rate damped.
    const pitchRate = flight.rates ? flight.rates.x || 0 : 0;
    const rollRate = flight.rates ? flight.rates.z || 0 : 0;
    const pitchDeg = flight.pitchDeg || 0;
    const rollDeg = flight.rollDeg || 0;

    let pitch = (pitchTarget - pitchDeg) * 0.09 - pitchRate * 1.0;
    // rollDeg positive = right bank; +stick rolls left, so invert.
    let roll = -((bankTarget - rollDeg) * 0.05) - rollRate * 0.35;

    pitch = clamp(pitch, -1, 1);
    roll = clamp(roll, -1, 1);

    // Low-pass the surfaces for a smooth, non-twitchy hand-off.
    this._pitchCmd += (pitch - this._pitchCmd) * SMOOTHING;
    this._rollCmd += (roll - this._rollCmd) * SMOOTHING;

    return { ...cmd, pitch: this._pitchCmd, roll: this._rollCmd };
  }

  // ---- Smart autoland: pattern -> FAF intercept -> 3.2° final -> flare -> rollout.
  _computeAutoLand(flight, baseCmd, context) {
    const cmd = baseCmd || { pitch: 0, roll: 0, yaw: 0 };
    const airport = (context && context.airport) || this._airport;
    if (!airport || !Number.isFinite(this._runwayHeading)) {
      this.disengage();
      return baseCmd;
    }

    const pos = flight.position || { x: 0, y: 0, z: 0 };
    const rwy = this._runwayHeading;
    const fx = Math.sin(rwy * RAD);
    const fz = -Math.cos(rwy * RAD);
    const rx = Math.cos(rwy * RAD);
    const rz = Math.sin(rwy * RAD);
    const elev = airport.elevation || 0;
    const half = (airport.length || 0) * 0.5;
    const thX = (airport.x || 0) - fx * half;
    const thZ = (airport.z || 0) - fz * half;

    const offX = pos.x - thX;
    const offZ = pos.z - thZ;
    const along = offX * fx + offZ * fz;       // < 0 = before threshold
    const lateral = offX * rx + offZ * rz;     // > 0 = right of centreline
    const dist = Math.hypot(offX, offZ);
    const speed = flight.speed || 0;
    const acHeading = flight.heading || 0;
    const hdgErr = headingError(rwy, acHeading);
    const floorAlt = this._terrainFloor(flight, context) + 220;
    const agl = Number.isFinite(flight.agl) ? flight.agl : pos.y - elev;

    this._distM = dist;
    this._etaSec = dist / Math.max(speed, 40);

    // ------------------------------------------------------------- rollout
    if (flight.onGround) {
      this._setPhase('ROLLOUT');
      flight.targetThrottle = 0;
      flight.gearDown = true;
      flight.gearTarget = 1;
      flight.flapsIndex = 2;
      // Aerobrake with the airframe above 72 m/s, wheel brakes below it.
      flight.brake = speed < 72;
      if (speed < 3.0) {
        this._completeMsg = 'AUTO-LAND COMPLETE · ' + this.targetLabel;
        this._completePlan();
        this.disengage();
        return baseCmd;
      }
      const yawTarget = clamp(-headingError(rwy, acHeading) * 0.04, -0.5, 0.5);
      const pitchTarget = speed > 55 ? 0.12 : 0;
      this._pitchCmd += (pitchTarget - this._pitchCmd) * SMOOTHING;
      this._rollCmd += (0 - this._rollCmd) * SMOOTHING;
      this._yawCmd += (yawTarget - this._yawCmd) * SMOOTHING;
      // flight.js copies brake from the command each frame, so mirror the
      // rollout decision into cmd.brake as well as the flight state.
      return { ...cmd, pitch: this._pitchCmd, roll: this._rollCmd, yaw: this._yawCmd, brake: flight.brake };
    }

    // Missed approach / go-around: drop the capture and fly a fresh pattern.
    // A normal flare floats past the threshold, so only go around while still
    // high or past the far end of the runway.
    const runwayEnd = (airport.length || 3000) - 150;
    if (this._finalCaptured && (this.phase === 'FINAL' || this.phase === 'FLARE')
        && ((along > 400 && agl > 30) || along > runwayEnd)) {
      this._finalCaptured = false;
      this._patternComplete = false;
      this._side = lateral >= 0 ? 1 : -1;
      this.phase = 'PATTERN';
      this._syncPlan();
    }

    // ------------------------------------------------------------- pattern
    if (this.phase === 'PATTERN') {
      const baseX = thX - fx * PATTERN_BASE_BACK_M + rx * this._side * PATTERN_BASE_OFFSET_M;
      const baseZ = thZ - fz * PATTERN_BASE_BACK_M + rz * this._side * PATTERN_BASE_OFFSET_M;
      const toBase = Math.hypot(baseX - pos.x, baseZ - pos.z);
      const exitPattern = toBase <= 3000
        || (along < -4800 && Math.abs(lateral) < 2400 && Math.abs(hdgErr) < 65);

      if (exitPattern) {
        this._patternComplete = true;
        this._setPhase('INTERCEPT');
      } else {
        const altTarget = Math.max(elev + 520, floorAlt + 260);
        const spdTarget = toBase < 3000 ? 130 : 155;
        const hdgTarget = norm360(Math.atan2(baseX - pos.x, -(baseZ - pos.z)) * DEG);
        const toGo = Math.max(900, toBase);
        const pathDeg = Math.atan2(altTarget - pos.y, toGo) * DEG;
        const pitchTarget = clamp(pathDeg + (flight.aoa || 0) * DEG, -14, 10);
        const bankTarget = clamp(headingError(hdgTarget, acHeading) * 2.0, -45, 45);
        flight.targetThrottle = this._approachThrottle(spdTarget, speed, 0.36, 0.025, 0.02, 0.92);
        const brake = this._updateAirbrake(speed, spdTarget, 32, 10);
        flight.brake = brake;
        const out = this._flyAttitude(flight, cmd, pitchTarget, bankTarget,
          { pitchGain: 0.07, pitchDamp: 0.9, rollLimit: 0.85 });
        out.brake = brake;
        return out;
      }
    }

    // Capture latch: aligned laterally, close enough, roughly on heading and
    // not still cranked into the intercept turn (or the localizer inherits a
    // large cross-track error it cannot remove before the threshold).
    if (!this._finalCaptured
        && along < 250 && Math.abs(lateral) < 1600 && dist < 9500
        && Math.abs(hdgErr) < 45 && Math.abs(flight.rollDeg || 0) < 20) {
      this._finalCaptured = true;
    }

    // ----------------------------------------------------------- intercept
    if (!this._finalCaptured) {
      this._setPhase('INTERCEPT');
      // Pure-pursuit carrot on the extended centreline for the aim point,
      // but steer with a damped COURSE intercept. Chasing the carrot bearing
      // alone orbits whenever the jet is off-axis, so the localizer-style
      // cross-track law rolls out on runwayHeading as the error decays.
      let carrotAlong = along + Math.max(1200, Math.min(2800, Math.abs(lateral) * 1.5));
      if (along < -7000) carrotAlong = -FAF_BACK_M;
      carrotAlong = clamp(carrotAlong, -7000, -3200);
      const aimX = thX + fx * carrotAlong;
      const aimZ = thZ + fz * carrotAlong;
      const altTarget = Math.max(elev + Math.max(310, Math.min(600, (-along) * AP_GS_TAN)), floorAlt);
      const spdTarget = approachSpeedSchedule(dist);
      const latVel = this._lateralSpeed(flight, rx, rz, hdgErr);
      const hdgTarget = norm360(rwy + clamp(-lateral * 0.030 - latVel * 0.25, -40, 40));
      const toGo = Math.max(900, Math.hypot(aimX - pos.x, aimZ - pos.z));
      const pathDeg = clamp(Math.atan2(altTarget - pos.y, toGo) * DEG, -8, 8);
      const pitchTarget = clamp(pathDeg + (flight.aoa || 0) * DEG, -16, 11);
      const bankTarget = clamp(headingError(hdgTarget, acHeading) * 2.2, -40, 40);
      flight.targetThrottle = this._approachThrottle(spdTarget, speed, 0.36, 0.025, 0.02, 0.92);
      const brake = this._updateAirbrake(speed, spdTarget, 28, 8);
      flight.brake = brake;
      const out = this._flyAttitude(flight, cmd, pitchTarget, bankTarget,
        { pitchGain: 0.07, pitchDamp: 0.9, rollLimit: 0.85 });
      out.brake = brake;
      return out;
    }

    // --------------------------------------------------------------- flare
    if (this.phase === 'FINAL' && agl < 18 && dist < 1800) {
      this._setPhase('FLARE');
    }
    if (this.phase === 'FLARE') {
      flight.gearDown = true;
      flight.gearTarget = 1;
      flight.flapsIndex = 2;
      flight.targetThrottle = 0.03;
      this._airbrake = false;
      flight.brake = false;
      const vs = flight.verticalSpeed || 0;
      // Flare attitude with sink-rate feedback so touchdown stays < 2.5 m/s.
      const pitchTarget = clamp(5.5 + (2.0 + vs) * 0.35, 2.0, 7.5);
      const bankTarget = clamp(-lateral * 0.02, -4, 4);
      const out = this._flyAttitude(flight, cmd, pitchTarget, bankTarget,
        { pitchGain: 0.055, pitchDamp: 1.1 });
      out.brake = false;
      return out;
    }

    // --------------------------------------------------------------- final
    this._setPhase('FINAL');
    // Gear ALWAYS down before touchdown: by 6.5 km on speed, or 4.5 km regardless.
    if ((dist < 6500 && speed < 145) || dist < 4500) {
      flight.gearDown = true;
      flight.gearTarget = 1;
      flight.flapsIndex = 2;
    }

    const tdDist = Math.max(0, -along + 180);
    const gsAlt = elev + clamp(tdDist * AP_GS_TAN, 3, 900);
    const vsNominal = -speed * Math.sin(AP_GS_DEG * RAD);
    // Damp the vertical speed against the NOMINAL glideslope sink, not zero —
    // damping against zero leaves a permanent altitude bias above the path.
    const vsErr = (flight.verticalSpeed || 0) - vsNominal;
    const vsTarget = clamp(vsNominal + (gsAlt - pos.y) * 0.22 - vsErr * 0.20, -14, 8);

    // Damped localizer: lateral position + lateral velocity (kills S-turns).
    const latVel = this._lateralSpeed(flight, rx, rz, hdgErr);
    const hdgTarget = rwy + clamp(-lateral * 0.07 - latVel * 0.25, -26, 26);
    const bankLimit = agl < 120 ? 10 : 25;
    const bankTarget = clamp(headingError(hdgTarget, acHeading) * 2.2, -bankLimit, bankLimit);

    const spdTarget = approachSpeedSchedule(dist);
    const pathDeg = Math.asin(clamp(vsTarget / Math.max(speed, 50), -1, 1)) * DEG;
    const pitchTarget = clamp(pathDeg + (flight.aoa || 0) * DEG, -16, 12);

    // Gear and flaps are already hanging out here, so the throttle owns the
    // speed on the path; the speedbrake only wakes up on a real overspeed.
    flight.targetThrottle = this._approachThrottle(spdTarget, speed, 0.30, 0.028, 0.04, 0.92);
    const brake = this._updateAirbrake(speed, spdTarget, 26, 8);
    flight.brake = brake;
    const out = this._flyAttitude(flight, cmd, pitchTarget, bankTarget,
      { pitchGain: 0.075, pitchDamp: 0.9 });
    out.brake = brake;
    return out;
  }

  /** Lateral (right-positive) ground speed in runway axes. */
  _lateralSpeed(flight, rx, rz, hdgErrDeg) {
    const v = flight.velocity;
    if (v && Number.isFinite(v.x) && Number.isFinite(v.z)) return v.x * rx + v.z * rz;
    return -(flight.speed || 0) * Math.sin((hdgErrDeg || 0) * RAD);
  }

  // ---- Smart air-to-air refuelling: rendezvous -> join -> boom contact hold.
  _computeAutoRefuel(flight, baseCmd, context) {
    const cmd = baseCmd || { pitch: 0, roll: 0, yaw: 0 };
    const tanker = context && context.tanker;
    if (!tanker || !tanker.position) {
      this.disengage();
      return baseCmd;
    }

    const fuel = context && context.fuel;
    const fuelPct = fuel
      ? (Number.isFinite(fuel.pct) ? fuel.pct
        : Number.isFinite(fuel.fraction) ? fuel.fraction : 0)
      : 0;
    if (fuelPct >= 0.995) {
      this._completeMsg = 'REFUEL COMPLETE · BREAKING AWAY';
      this.mode = 'ALT_HDG';
      this.phase = '';
      this._latch(flight);
      return baseCmd;
    }

    const pos = flight.position || { x: 0, y: 0, z: 0 };
    const speed = flight.speed || 0;
    const acHeading = flight.heading || 0;
    const tpos = tanker.position;

    // Tanker body axes on the horizontal plane: velocity when the tanker
    // reports it (live KC-135), otherwise the reported heading.
    let tfx;
    let tfz;
    let tSpeed;
    const vel = tanker.velocity;
    if (vel && Number.isFinite(vel.x) && Number.isFinite(vel.z)) {
      const vh = Math.hypot(vel.x, vel.z);
      if (vh > 1e-6) {
        tfx = vel.x / vh;
        tfz = vel.z / vh;
      } else {
        const h = (tanker.heading || 0) * RAD;
        tfx = Math.sin(h);
        tfz = -Math.cos(h);
      }
      tSpeed = Number.isFinite(tanker.speed) ? tanker.speed : vh;
    } else {
      const h = (tanker.heading || 0) * RAD;
      tfx = Math.sin(h);
      tfz = -Math.cos(h);
      tSpeed = Number.isFinite(tanker.speed) ? tanker.speed : 0;
    }
    const trx = -tfz;
    const trz = tfx;
    const tankerHdg = norm360(Math.atan2(tfx, -tfz) * DEG);

    // Orbit turn rate: the live TankerSystem reports `_omega`; a straight-line
    // test tanker has no radius and therefore omega = 0 (no bank feedforward).
    const omega = Number.isFinite(tanker._omega)
      ? tanker._omega
      : (Number.isFinite(tanker.radius) && tanker.radius > 100 && tSpeed > 1
        ? tSpeed / tanker.radius : 0);
    const hasOrbit = Number.isFinite(tanker.radius) && tanker.radius > 100;
    const tankerBankDeg = Math.atan2(tSpeed * omega, 9.81) * DEG;

    // Boom contact point: 22 m aft and 8.5 m below the tanker, squarely inside
    // the FuelSystem contact box (12–34 m aft, 2–12 m below, ±10 m lateral).
    const boomX = tpos.x - 22 * tfx;
    const boomZ = tpos.z - 22 * tfz;
    const boomY = tpos.y - CONTACT_ALT_DROP_M;

    const dx = boomX - pos.x;
    const dz = boomZ - pos.z;
    const hDist = Math.hypot(dx, dz);

    // Formation errors in tanker axes: offset from the boom (right-positive)
    // and distance ahead of it along the tanker's nose.
    const latErr = dx * trx + dz * trz;
    const alongErr = dx * tfx + dz * tfz;
    // Relative lateral velocity (jet minus tanker) for the contact damper.
    let latVelRel = 0;
    const fv = flight.velocity;
    if (fv && Number.isFinite(fv.x) && Number.isFinite(fv.z) && vel
        && Number.isFinite(vel.x) && Number.isFinite(vel.z)) {
      latVelRel = (fv.x - vel.x) * trx + (fv.z - vel.z) * trz;
    }

    const ground = this._terrainFloor(flight, context);
    const aoaDeg = (flight.aoa || 0) * DEG;
    const vs = flight.verticalSpeed || 0;

    // Clean configuration for the join-up.
    flight.gearDown = false;
    flight.gearTarget = 0;
    flight.flapsIndex = 0;

    this._distM = hDist;
    this._etaSec = hDist / Math.max(Math.abs(speed - tSpeed), 25);

    let hdgTarget;
    let bankTarget;
    let vsTarget;
    let spdTarget;
    let throttleGain = 0.025;
    let brakeEngageOver = 28;
    let brakeReleaseOver = 8;
    let aimDist = hDist;

    // ------------------------------------------------ polar orbit join law
    // A live TankerSystem orbits clockwise at R = tanker.radius. Working in
    // orbit polar coordinates (arc lag behind the boom + radial offset from the
    // circle) is stable at ANY range: the jet intercepts the circle once and
    // then rides it, instead of chasing a straight-line point that keeps
    // curving away. Only the last 110 m hands over to the locked CONTACT law.
    if (hasOrbit && hDist > 110) {
      this._setPhase(hDist > 750 ? 'RENDEZVOUS' : 'JOIN');
      const R = tanker.radius;
      const orbitDir = omega < 0 ? -1 : 1;

      // Orbit centre: an explicit anchor when the tanker exposes one, else
      // reversed out of the live tangent. For the clockwise orbit the right
      // normal of the velocity (-tfz, tfx) points INWARD, so centre = pos +
      // right * R (verified: pos + (-cos a, -sin a) * R = anchor).
      const anchor = tanker.anchor;
      let ax;
      let az;
      if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.z)) {
        ax = anchor.x;
        az = anchor.z;
      } else {
        ax = tpos.x + (-tfz) * R * orbitDir;
        az = tpos.z + tfx * R * orbitDir;
      }

      const angTanker = Math.atan2(tpos.z - az, tpos.x - ax);
      // Boom station: 22 m aft of the tanker along the orbit.
      const angBoom = angTanker - (22 / R) * orbitDir;
      const dxA = pos.x - ax;
      const dzA = pos.z - az;
      const rJet = Math.hypot(dxA, dzA);
      const angJet = Math.atan2(dzA, dxA);

      // Signed angular lag behind the boom along the orbit: > 0 = behind the
      // tanker (must close up), < 0 = ahead of the boom (must fall back).
      const dAng = Math.atan2(Math.sin(angBoom - angJet), Math.cos(angBoom - angJet));
      const arcErr = dAng * R;
      const rErr = rJet - R; // > 0 = outside the circle, < 0 = inside

      // Tangent heading at the jet's own angle, then bias into/out of the
      // circle so the radial error decays without leaving the orbit.
      const tanX = -Math.sin(angJet);
      const tanZ = Math.cos(angJet);
      const tanHdg = norm360(Math.atan2(tanX, -tanZ) * DEG);

      hdgTarget = norm360(tanHdg + clamp(rErr * 0.045, -38, 38));
      bankTarget = clamp(orbitBankDeg(omega, tSpeed, speed)
        + headingError(hdgTarget, acHeading) * 2.2, -40, 40);

      // Critically damped speed schedule along the arc: close up from behind,
      // fall back when ahead — the two never cross paths or overshoot.
      if (arcErr > 0) {
        spdTarget = clamp(tSpeed + arcErr * 0.06, tSpeed + 4, 260);
        if (hDist <= 750) spdTarget = Math.min(spdTarget, tSpeed + 35);
      } else {
        spdTarget = clamp(tSpeed + arcErr * 0.06, Math.max(115, tSpeed - 42), tSpeed);
      }

      const altTarget = Math.max(boomY, ground + 220);
      vsTarget = clamp((altTarget - pos.y) * 0.25 - vs * 0.45, -12, 12);

      const fpDeg = Math.asin(clamp(vsTarget / Math.max(speed, 50), -1, 1)) * DEG;
      const pitch = clamp(fpDeg + aoaDeg, -14, 12);
      flight.targetThrottle = this._refuelThrottle(hasOrbit, spdTarget, speed, throttleGain);
      const brake = this._updateAirbrake(speed, spdTarget, 28, 8);
      flight.brake = brake;
      const out = this._flyAttitude(flight, cmd, pitch, bankTarget,
        { pitchGain: 0.07, pitchDamp: 0.9, rollLimit: 0.9 });
      out.brake = brake;
      return out;
    }

    if (hDist > 1200) {
      // -------------------------------------------------------- rendezvous
      this._setPhase('RENDEZVOUS');
      const leadT = clamp(hDist / 260, 0, 10);
      let predX;
      let predZ;
      if (Math.abs(omega) > 1e-6) {
        // Predict along the tanker's circular orbit: recover the orbit centre
        // from position + velocity + turn rate, then rotate the radius vector.
        const cx = tpos.x - (vel ? vel.z : 0) / omega;
        const cz = tpos.z + (vel ? vel.x : 0) / omega;
        const r = Math.hypot(tpos.x - cx, tpos.z - cz);
        const a = Math.atan2(tpos.z - cz, tpos.x - cx) + omega * leadT;
        predX = cx + r * Math.cos(a);
        predZ = cz + r * Math.sin(a);
      } else {
        predX = tpos.x + tfx * tSpeed * leadT;
        predZ = tpos.z + tfz * tSpeed * leadT;
      }
      // Aim 180 m behind the predicted point so the merge is a gentle join,
      // not a crossing pass. Orbiting tankers are handled by the polar-orbit
      // law above, so this branch is the straight-line / no-radius case.
      const aimX = predX - 180 * tfx;
      const aimZ = predZ - 180 * tfz;
      aimDist = Math.hypot(aimX - pos.x, aimZ - pos.z);
      hdgTarget = norm360(Math.atan2(aimX - pos.x, -(aimZ - pos.z)) * DEG);
      bankTarget = clamp(headingError(hdgTarget, acHeading) * 2.2, -28, 28);
      const altTarget = Math.max(boomY, ground + 220);
      const toGo = Math.max(600, aimDist);
      const pathDeg = Math.atan2(altTarget - pos.y, toGo) * DEG;
      vsTarget = null;
      spdTarget = clamp(tSpeed + hDist * 0.035, tSpeed + 18, 265);
      const pitch = clamp(pathDeg + aoaDeg, -14, 11);
      flight.targetThrottle = this._refuelThrottle(hasOrbit, spdTarget, speed, throttleGain);
      const brake = this._updateAirbrake(speed, spdTarget, brakeEngageOver, brakeReleaseOver);
      flight.brake = brake;
      const out = this._flyAttitude(flight, cmd, pitch, bankTarget,
        { pitchGain: 0.07, pitchDamp: 0.9 });
      out.brake = brake;
      return out;
    }

    if (hDist > (hasOrbit ? 110 : 90)) {
      // -------------------------------------------------------------- join
      // (Orbiting tankers hand over to CONTACT at 110 m, straight-line at 90.)
      this._setPhase('JOIN');
      const trail = clamp((hDist - 90) * 0.15, 0, 80);
      const aimX = boomX - tfx * trail;
      const aimZ = boomZ - tfz * trail;
      aimDist = Math.hypot(aimX - pos.x, aimZ - pos.z);
      hdgTarget = norm360(Math.atan2(aimX - pos.x, -(aimZ - pos.z)) * DEG);
      // Orbit-matched feedforward bank curves the jet into the tanker's turn.
      bankTarget = clamp(orbitBankDeg(omega, tSpeed, speed) * 0.9
        + headingError(hdgTarget, acHeading) * 2.2, -40, 40);
      vsTarget = clamp((boomY - pos.y) * 0.35 - vs * 0.45, -6, 6);
      spdTarget = hasOrbit
        ? tSpeed + clamp((hDist - 22) * 0.04, -6, 30)
        : clamp(tSpeed + (hDist - 22) * 0.075, tSpeed - 12, tSpeed + 28);
    } else {
      // ----------------------------------------------------------- contact
      this._setPhase('CONTACT');
      hdgTarget = tankerHdg + clamp(latErr * 0.45 - latVelRel * 0.25, -16, 16);
      // Full turn-rate feedforward bank: the bank that holds the tanker's
      // orbit at the jet's current speed (20.3° at 165 m/s).
      bankTarget = clamp(orbitBankDeg(omega, tSpeed, speed)
        + headingError(hdgTarget, acHeading) * 2.4, -36, 36);
      vsTarget = clamp((boomY - pos.y) * 0.45 - vs * 0.55, -8, 8);
      spdTarget = tSpeed + clamp(alongErr * 0.16, -14, 14);
      throttleGain = 0.028;
      // On the boom the throttle alone trims speed: the speedbrake stays shut
      // unless the jet is genuinely 18 m/s fast (and then releases at +5).
      brakeEngageOver = 18;
      brakeReleaseOver = 5;
    }

    bankTarget = clamp(bankTarget, -36, 36);
    let pitch;
    if (vsTarget === null) {
      pitch = clamp(Math.atan2(Math.max(boomY, ground + 220) - pos.y, Math.max(600, aimDist)) * DEG + aoaDeg, -14, 11);
    } else {
      const fpDeg = Math.asin(clamp(vsTarget / Math.max(speed, 50), -1, 1)) * DEG;
      pitch = clamp(fpDeg + aoaDeg, -14, 12);
    }

    flight.targetThrottle = this._refuelThrottle(hasOrbit, spdTarget, speed, throttleGain);
    const brake = this._updateAirbrake(speed, spdTarget, brakeEngageOver, brakeReleaseOver);
    flight.brake = brake;
    const out = this._flyAttitude(flight, cmd, pitch, bankTarget,
      { pitchGain: 0.07, pitchDamp: 0.9 });
    out.brake = brake;
    return out;
  }

  /**
   * Refuel autothrottle. The legacy 0.45 baseline is exactly what the stub /
   * kinematic unit tests expect; against a live orbiting tanker an integrator
   * learns the real drag trim so the jet holds speed (and therefore the boom
   * box) instead of settling fast and drifting ahead of the tanker.
   */
  _refuelThrottle(hasOrbit, spdTarget, speed, gain) {
    if (hasOrbit) {
      this._throttleTrim = clamp(this._throttleTrim + (spdTarget - speed) * 0.00004, -0.34, 0.34);
    }
    const trim = hasOrbit ? this._throttleTrim : 0;
    return clamp(0.45 + (spdTarget - speed) * gain + trim, 0.02, 0.92);
  }
}

export class ILSComputer {
  constructor() {
    this.active = false;
    this.locDev = 0;
    this.gsDev = 0;
    this.distNm = 0;
    this.runwayLabel = '';
    this.runwayHeading = 0;
    this.airport = null;
    this.threshold = { x: 0, z: 0 };
    this.lastCallout = null;

    this._approachId = null;
    this._announced = new Set();
  }

  /**
   * @param {number} dt seconds (reserved for smoothing; deviations stay crisp)
   * @param {object} flight FlightModel (or compatible: position, heading, onGround, agl)
   * @param {object|null} airport { x, z, elevation, heading, length, width, code, name }
   */
  update(dt, flight, airport) {
    if (!airport || !flight || !flight.position) {
      this._clearApproach();
      return this;
    }

    const apHeading = ((airport.heading || 0) % 360 + 360) % 360;
    const recip = (apHeading + 180) % 360;
    const acHeading = flight.heading || 0;
    // Land on the runway end the aircraft is most closely aligned with.
    const runwayHeading = Math.abs(wrap180(acHeading - apHeading))
      <= Math.abs(wrap180(acHeading - recip))
      ? apHeading
      : recip;

    const fwdX = Math.sin(runwayHeading * RAD);
    const fwdZ = -Math.cos(runwayHeading * RAD);
    const rightX = Math.cos(runwayHeading * RAD);
    const rightZ = Math.sin(runwayHeading * RAD);
    const half = (airport.length || 0) * 0.5;

    // Threshold = near end of the runway when approaching along runwayHeading.
    const thX = (airport.x || 0) - fwdX * half;
    const thZ = (airport.z || 0) - fwdZ * half;

    const offX = flight.position.x - thX;
    const offZ = flight.position.z - thZ;
    const along = offX * fwdX + offZ * fwdZ;    // < 0 = before the threshold
    const lateral = offX * rightX + offZ * rightZ; // > 0 = right of centreline
    const dist = Math.hypot(offX, offZ);
    const distNm = dist / M_PER_NM;

    // Angular offset from the extended centreline (only defined short of it).
    const behind = Math.max(0, -along);
    const offAngleDeg = behind > 1 ? Math.atan2(lateral, behind) * DEG : lateral === 0 ? 0 : 90 * Math.sign(lateral);
    const onApproachSide = along <= 0 && Math.abs(offAngleDeg) <= ILS_MAX_OFF_DEG;

    this.airport = airport;
    this.runwayHeading = runwayHeading;
    this.threshold.x = thX;
    this.threshold.z = thZ;
    this.distNm = distNm;
    this.runwayLabel = 'RWY ' + runwayNumber(runwayHeading);
    this.active = !flight.onGround && !flight.crashed && dist <= ILS_RANGE_M && onApproachSide;

    if (!this.active) {
      this.locDev = 0;
      this.gsDev = 0;
      // Still allow a fresh approach after a go-around / new airport.
      this._maybeArm(flight, airport, dist);
      return this;
    }

    // Localizer: +1 tells the pilot to fly right (aircraft left of centreline).
    this.locDev = clamp(-offAngleDeg / LOC_FULL_SCALE_DEG, -1, 1);

    // Glideslope: compare actual elevation angle to the threshold with 3 degrees.
    const elevation = airport.elevation || 0;
    const height = Math.max(1, (flight.position.y || 0) - elevation);
    const actualAngle = Math.atan2(height, Math.max(1, dist)) * DEG;
    this.gsDev = clamp(-(actualAngle - GS_ANGLE_DEG) / GS_FULL_SCALE_DEG, -1, 1);

    this._approachId = airport.id ?? airport.code ?? null;
    this._updateCallouts(flight, airport, dist);
    return this;
  }

  _clearApproach() {
    this.active = false;
    this.locDev = 0;
    this.gsDev = 0;
    this.distNm = 0;
    this.runwayLabel = '';
    this.airport = null;
    this._approachId = null;
    this._announced.clear();
  }

  _maybeArm(flight, airport, dist) {
    // A new field resets the callout sequence so the next approach is fresh.
    const id = airport.id ?? airport.code ?? null;
    if (id !== this._approachId) {
      this._approachId = id;
      this._announced.clear();
      return;
    }
    // Landed, out of range, or climbed away off the approach: arm a new sequence.
    if (dist > ILS_RANGE_M || flight.onGround || this._agl(flight, airport) > CALLOUT_RESET_AGL_M) {
      this._announced.clear();
    }
  }

  _agl(flight, airport) {
    if (Number.isFinite(flight.agl)) return Math.max(0, flight.agl);
    return Math.max(0, (flight.position.y || 0) - (airport.elevation || 0));
  }

  _updateCallouts(flight, airport, dist) {
    const aglM = this._agl(flight, airport);

    // Climbing away (go-around) re-arms the whole sequence.
    if (aglM > CALLOUT_RESET_AGL_M) {
      this._announced.clear();
      return;
    }

    for (const c of CALLOUTS) {
      if (this._announced.has(c.key)) continue;
      if (aglM > c.aglFt / FT_PER_M) continue; // not yet reached
      this._announced.add(c.key);
      const payload = {
        callout: c.key,
        text: c.text,
        aglFt: Math.round(aglM * FT_PER_M),
        airport,
        airportCode: airport.code || '',
        runwayLabel: this.runwayLabel,
        distNm: dist / M_PER_NM,
      };
      this.lastCallout = payload;
      emit('ils:callout', payload);
    }
  }

  /**
   * Grade a touchdown. impactMs = downward vertical speed in m/s,
   * bankDeg = bank angle at contact (absolute value matters).
   */
  gradeTouchdown(impactMs, bankDeg) {
    const impact = Number.isFinite(impactMs) ? Math.max(0, impactMs) : 0;
    const bank = Number.isFinite(bankDeg) ? Math.abs(bankDeg) : 0;
    const fpm = Math.round(impact * 196.85);

    let grade;
    let color;
    if (impact < 1.4 && bank < 4) {
      grade = 'BUTTER';
      color = 'green';
    } else if (impact < 2.8) {
      grade = 'SMOOTH';
      color = 'green';
    } else if (impact < 4.8) {
      grade = 'FIRM';
      color = 'amber';
    } else {
      grade = 'HARD';
      color = 'red';
    }
    return { grade, fpm, color };
  }
}