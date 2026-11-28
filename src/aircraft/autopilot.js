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
  }

  /**
   * Engage the smart autoland computer for `airport`.
   * Refused for a missing/crashed airframe or a missing airport.
   * @returns {boolean} true when the mode engaged
   */
  engageAutoLand(flight, airport) {
    if (!flight || flight.crashed || !airport) return false;
    this.mode = 'AUTO_LAND';
    this.phase = flight.onGround ? 'ROLLOUT' : 'INTERCEPT';
    this.targetLabel = airport.code || airport.name || 'AIRBASE';
    this._resetCommand();
    this._completeMsg = null;
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
    this._resetCommand();
    this._completeMsg = null;
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
    this._resetCommand();
  }

  _resetCommand() {
    this._pitchCmd = 0;
    this._rollCmd = 0;
    this._yawCmd = 0;
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
   */
  _flyAttitude(flight, baseCmd, pitchTarget, bankTarget) {
    const cmd = baseCmd || { pitch: 0, roll: 0, yaw: 0 };
    const pitchRate = flight.rates ? flight.rates.x || 0 : 0;
    const rollRate = flight.rates ? flight.rates.z || 0 : 0;
    const pitch = clamp((pitchTarget - (flight.pitchDeg || 0)) * 0.09 - pitchRate, -1, 1);
    // rollDeg positive = right bank; +stick rolls left, so invert.
    const roll = clamp(-((bankTarget - (flight.rollDeg || 0)) * 0.05) - rollRate * 0.35, -1, 1);
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

  // ---- Smart autoland: gate interception -> 3.2° final -> flare -> rollout.
  _computeAutoLand(flight, baseCmd, context) {
    const cmd = baseCmd || { pitch: 0, roll: 0, yaw: 0 };
    const airport = context && context.airport;
    if (!airport) {
      this.disengage();
      return baseCmd;
    }

    const pos = flight.position || { x: 0, y: 0, z: 0 };
    const apHeading = ((airport.heading || 0) % 360 + 360) % 360;
    const recip = (apHeading + 180) % 360;
    const acHeading = flight.heading || 0;
    // Land on the runway end the aircraft is most closely aligned with.
    const runwayHeading = Math.abs(wrap180(acHeading - apHeading))
      <= Math.abs(wrap180(acHeading - recip)) ? apHeading : recip;

    const fwdX = Math.sin(runwayHeading * RAD);
    const fwdZ = -Math.cos(runwayHeading * RAD);
    const rightX = Math.cos(runwayHeading * RAD);
    const rightZ = Math.sin(runwayHeading * RAD);
    const elev = airport.elevation || 0;
    const half = (airport.length || 0) * 0.5;
    const thX = (airport.x || 0) - fwdX * half;
    const thZ = (airport.z || 0) - fwdZ * half;

    const offX = pos.x - thX;
    const offZ = pos.z - thZ;
    const along = offX * fwdX + offZ * fwdZ;       // < 0 = before threshold
    const lateral = offX * rightX + offZ * rightZ; // > 0 = right of centreline
    const dist = Math.hypot(offX, offZ);
    const speed = flight.speed || 0;

    // ------------------------------------------------------------- rollout
    if (flight.onGround) {
      this.phase = 'ROLLOUT';
      flight.targetThrottle = 0;
      flight.gearDown = true;
      // Aerobrake with the airframe above 72 m/s, wheel brakes below it.
      flight.brake = speed < 72;
      if (speed < 3.0) {
        this._completeMsg = 'AUTO-LAND COMPLETE · ' + this.targetLabel;
        this.disengage();
        return baseCmd;
      }
      const yawTarget = clamp(-headingError(runwayHeading, acHeading) * 0.04, -0.5, 0.5);
      const pitchTarget = speed > 55 ? 0.12 : 0;
      this._pitchCmd += (pitchTarget - this._pitchCmd) * SMOOTHING;
      this._rollCmd += (0 - this._rollCmd) * SMOOTHING;
      this._yawCmd += (yawTarget - this._yawCmd) * SMOOTHING;
      // flight.js copies brake from the command each frame, so mirror the
      // rollout decision into cmd.brake as well as the flight state.
      return { ...cmd, pitch: this._pitchCmd, roll: this._rollCmd, yaw: this._yawCmd, brake: flight.brake };
    }

    // ------------------------------------------------------------ airborne
    // Keep the intercept at least 220 m above the highest nearby terrain.
    const floorAlt = this._terrainFloor(flight, context) + 220;
    const gateDist = 5200;
    const gateX = thX - fwdX * gateDist;
    const gateZ = thZ - fwdZ * gateDist;
    const gateAlt = Math.max(elev + 310, floorAlt);

    const inFinal = along < 250 && Math.abs(lateral) < 1600 && dist < 9500
      && Math.abs(headingError(runwayHeading, acHeading)) < 45;
    this.phase = inFinal ? 'FINAL' : 'INTERCEPT';

    let hdgTarget;
    let altTarget;
    let spdTarget;
    let aimX;
    let aimZ;

    if (this.phase === 'INTERCEPT') {
      hdgTarget = norm360(Math.atan2(gateX - pos.x, -(gateZ - pos.z)) * DEG);
      altTarget = gateAlt;
      spdTarget = dist > 10000 ? 175 : 115;
      aimX = gateX;
      aimZ = gateZ;
    } else {
      // Localizer: runway heading plus a lateral intercept correction.
      hdgTarget = runwayHeading + clamp(-lateral * 0.025, -24, 24);
      // 3.2° glideslope to a touchdown point 180 m past the threshold.
      const tdDist = Math.max(0, -along + 180);
      altTarget = elev + clamp(tdDist * Math.tan(3.2 * RAD), 4, 900);
      if (dist < 6500 && speed < 140) {
        flight.gearDown = true;
        flight.flapsIndex = 2;
      }
      spdTarget = dist > 10000 ? 175 : dist > 5200 ? 115 : 78;
      aimX = thX + fwdX * 180;
      aimZ = thZ + fwdZ * 180;
    }

    const agl = Number.isFinite(flight.agl) ? flight.agl : (pos.y - elev);
    if (this.phase === 'FINAL' && agl < 18 && dist < 1600) {
      this.phase = 'FLARE';
      flight.gearDown = true;
      flight.flapsIndex = 2;
      flight.targetThrottle = 0.03;
      return this._flyAttitude(flight, baseCmd, 6.5, clamp(-lateral * 0.015, -5, 5));
    }

    // Proportional autothrottle: 175 m/s inbound, 115 m/s to the gate,
    // 78 m/s (about 152 kt) on-speed down the glideslope.
    flight.targetThrottle = clamp(0.45 + (spdTarget - speed) * 0.022, 0.04, 0.92);

    // Pure pursuit for the gate; on final, track the 3.2° line with a
    // proportional correction so being high captures instead of drifting.
    let pathDeg;
    if (this.phase === 'FINAL') {
      pathDeg = -3.2 + Math.atan2(altTarget - pos.y, 1200) * DEG;
    } else {
      const toGo = Math.max(150, Math.hypot(aimX - pos.x, aimZ - pos.z));
      pathDeg = Math.atan2(altTarget - pos.y, toGo) * DEG;
    }
    const pitchTarget = clamp(pathDeg + (flight.aoa || 0) * DEG, -20, 12);
    const bankTarget = clamp(headingError(hdgTarget, acHeading) * 2.2, -25, 25);
    return this._flyAttitude(flight, baseCmd, pitchTarget, bankTarget);
  }

  // ---- Smart air-to-air refuelling: rendezvous -> join -> boom contact hold.
  _computeAutoRefuel(flight, baseCmd, context) {
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

    // Boom contact point: 22 m aft and 9 m below the tanker, squarely inside
    // the FuelSystem contact box (12–34 m aft, 2–12 m below, ±10 m lateral).
    const boomX = tpos.x - 22 * tfx;
    const boomZ = tpos.z - 22 * tfz;
    const boomY = tpos.y - 9.0;

    const dx = boomX - pos.x;
    const dz = boomZ - pos.z;
    const hDist = Math.hypot(dx, dz);
    const bearing = norm360(Math.atan2(dx, -dz) * DEG);

    // Formation errors in tanker axes: offset from the boom (right-positive)
    // and target distance ahead along the tanker's nose.
    const latErr = dx * trx + dz * trz;
    const alongErr = dx * tfx + dz * tfz;

    const ground = this._terrainFloor(flight, context);
    flight.gearDown = false;
    flight.flapsIndex = 0;

    let hdgTarget;
    let altTarget;
    let spdTarget;
    let aimX;
    let aimZ;

    if (hDist > 750) {
      this.phase = 'RENDEZVOUS';
      // Lead point 180 m behind the tanker, kept clear of the terrain.
      const leadX = tpos.x - 180 * tfx;
      const leadZ = tpos.z - 180 * tfz;
      hdgTarget = norm360(Math.atan2(leadX - pos.x, -(leadZ - pos.z)) * DEG);
      altTarget = Math.max(boomY, ground + 220);
      spdTarget = clamp(tSpeed + hDist * 0.035, tSpeed + 12, 260);
      aimX = leadX;
      aimZ = leadZ;
    } else if (hDist > 90) {
      this.phase = 'JOIN';
      // Aim at the boom while blending the heading toward the tanker's.
      hdgTarget = bearing + clamp(headingError(tanker.heading || 0, bearing), -20, 20) * 0.6;
      altTarget = boomY;
      spdTarget = clamp(tSpeed + (hDist - 25) * 0.08, tSpeed + 2, tSpeed + 28);
      aimX = boomX;
      aimZ = boomZ;
    } else {
      this.phase = 'CONTACT';
      hdgTarget = (tanker.heading || 0) + clamp(latErr * 0.35, -12, 12);
      altTarget = boomY;
      spdTarget = tSpeed + clamp(alongErr * 0.14, -14, 14);
      aimX = boomX;
      aimZ = boomZ;
    }

    flight.targetThrottle = clamp(0.45 + (spdTarget - speed) * 0.022, 0.04, 0.92);

    // Pure pursuit: point the velocity vector at the aim point so the jet
    // settles onto the tanker's altitude with no proportional offset.
    const toGo = Math.max(120, Math.hypot(aimX - pos.x, aimZ - pos.z));
    const pathDeg = Math.atan2(altTarget - pos.y, toGo) * DEG;
    const pitchTarget = clamp(pathDeg + (flight.aoa || 0) * DEG, -12, 10);
    const bankTarget = clamp(headingError(hdgTarget, flight.heading || 0) * 2.2, -28, 28);
    return this._flyAttitude(flight, baseCmd, pitchTarget, bankTarget);
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