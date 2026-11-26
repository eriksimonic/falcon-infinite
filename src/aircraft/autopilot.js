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
    this._resetCommand();
  }

  _resetCommand() {
    this._pitchCmd = 0;
    this._rollCmd = 0;
  }

  /** Snapshot the aircraft state the autopilot is asked to hold. */
  _latch(flight) {
    this.targetAlt = flight.position ? flight.position.y : 0;
    this.targetHeading = flight.heading || 0;
    this.targetPitch = flight.pitchDeg || 0;
    this.targetRoll = flight.rollDeg || 0;
    this._pitchCmd = 0;
    this._rollCmd = 0;
  }

  /**
   * Blend the pilot's stick command with the autopilot laws.
   * Returns baseCmd untouched (same object) whenever the jet is not being flown
   * by the autopilot, and a fresh { ...baseCmd, pitch, roll } object otherwise.
   */
  computeCommand(flight, baseCmd) {
    const cmd = baseCmd || { pitch: 0, roll: 0, yaw: 0 };
    if (this.mode === 'OFF') return baseCmd;
    if (!flight || flight.onGround || flight.crashed || flight.stall) {
      this.disengage();
      return baseCmd;
    }
    // Any deliberate stick input takes priority and clicks the autopilot off.
    if (Math.abs(cmd.pitch || 0) > MANUAL_STICK || Math.abs(cmd.roll || 0) > MANUAL_STICK) {
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