// Feature 32 — flight & combat "juice".
//
// Pure simulation (no Three.js, no DOM), so it runs identically in the browser,
// in the headless test suite and on a dedicated server. It owns:
//
//   * Sustained-G blackout  — builds above 5.8 G (much faster above 7.5 G),
//     recovers below 4.5 G. Drives the vignette/desaturation post effect.
//   * Negative-G redout     — builds below -2.2 G, recovers above -1.0 G.
//   * G-strain (0..1)       — pilot G-breathing / grunt audio intensity.
//   * Mach 1.0 shockwave    — crossing 0.99 -> 1.0 fires a camera punch plus a
//     `machPulse` that decays over 0.8 s.
//   * Camera shake impulses — Vulcan bursts, missile launch, nearby explosions
//     and the carrier catapult, summed into smooth high-frequency + low
//     frequency offsets (metres / radians) ready to add to the camera.

const MIN_BLACKOUT_G = 5.8;
const SEVERE_G = 7.5;
const BLACKOUT_RECOVER_G = 4.5;

const REDOUT_G = -2.2;
const REDOUT_RECOVER_G = -1.0;

const MACH_CROSS_LOW = 0.99;
const MACH_CROSS_HIGH = 1.0;
const MACH_PULSE_TIME = 0.8;
const MACH_COOLDOWN = 1.5;

const MAX_IMPULSES = 24;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export {
  MIN_BLACKOUT_G,
  BLACKOUT_RECOVER_G,
  REDOUT_G,
  REDOUT_RECOVER_G,
  MACH_PULSE_TIME,
};

export class FlightJuiceSystem {
  constructor() {
    this.impulses = [];
    this.reset();
  }

  reset() {
    this.blackout = 0; // 0..1 grey-out / tunnel vision
    this.redout = 0; // 0..1 negative-G red wash
    this.gStrain = 0; // 0..1 pilot strain (G-breathing audio)
    this.machPulse = 0; // 1 -> 0 over MACH_PULSE_TIME
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeRoll = 0;
    this.prevMach = 0;
    this.machCooldown = 0;
    this.lastGLoad = 1;
    this.time = 0;
    this.impulses.length = 0;
    return this;
  }

  /**
   * Queue a decaying camera shake punch.
   * Vulcan 0.18, missile launch 0.35, explosions 0.4..1.0 (by distance),
   * carrier catapult 0.45.
   */
  addImpulse(intensity = 0.2, duration = 0.25) {
    const amp = Number.isFinite(intensity) ? clamp(intensity, 0, 4) : 0;
    if (amp <= 0) return this;
    const dur = Number.isFinite(duration) ? clamp(duration, 0.01, 5) : 0.25;
    if (this.impulses.length >= MAX_IMPULSES) this.impulses.shift();
    this.impulses.push({ intensity: amp, duration: dur, age: 0 });
    return this;
  }

  /**
   * @param {number} dt seconds
   * @param {{gLoad?: number, mach?: number, afterburner?: boolean,
   *          onGround?: boolean, speed?: number, buffet?: number}} [state]
   * @returns {{blackout:number, redout:number, gStrain:number, machPulse:number,
   *           shakeX:number, shakeY:number, shakeRoll:number,
   *           shockwaveCrossed:boolean}}
   */
  update(dt, state = {}) {
    const h = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const s = state || {};
    const gLoad = Number.isFinite(s.gLoad) ? s.gLoad : 1;
    const mach = Number.isFinite(s.mach) ? Math.max(0, s.mach) : 0;
    const speed = Number.isFinite(s.speed) ? Math.max(0, s.speed) : 0;
    const afterburner = !!s.afterburner;
    const onGround = !!s.onGround;
    // Aerodynamic buffet (AoA / transonic shock) adds airframe rumble.
    const buffet = Number.isFinite(s.buffet) ? clamp(s.buffet, 0, 1) : 0;

    this.time += h;
    this.lastGLoad = gLoad;

    // ---------------------------------------------------------- blackout / G
    if (gLoad > MIN_BLACKOUT_G) {
      let rate = 0.16 + (gLoad - MIN_BLACKOUT_G) * 0.1;
      if (gLoad > SEVERE_G) rate += (gLoad - SEVERE_G) * 0.3;
      this.blackout = Math.min(1, this.blackout + rate * h);
    } else if (gLoad < BLACKOUT_RECOVER_G) {
      const rate = 0.45 + (BLACKOUT_RECOVER_G - gLoad) * 0.08;
      this.blackout = Math.max(0, this.blackout - rate * h);
    } else {
      // The 4.5..5.8 G band holds, bleeding very slowly.
      this.blackout = Math.max(0, this.blackout - 0.05 * h);
    }

    // ------------------------------------------------------------- redout
    if (gLoad < REDOUT_G) {
      const rate = 0.22 + (REDOUT_G - gLoad) * 0.14;
      this.redout = Math.min(1, this.redout + rate * h);
    } else if (gLoad > REDOUT_RECOVER_G) {
      const rate = 0.45 + (gLoad - REDOUT_RECOVER_G) * 0.1;
      this.redout = Math.max(0, this.redout - rate * h);
    } else {
      this.redout = Math.max(0, this.redout - 0.05 * h);
    }

    // ------------------------------------------------------- muscle strain
    const positive = smoothstep(3.5, 9.0, gLoad);
    const negative = smoothstep(1.5, 6.0, -gLoad);
    const strainTarget = clamp(Math.max(positive, negative * 0.85), 0, 1);
    const k = Math.min(1, h * 5);
    this.gStrain += (strainTarget - this.gStrain) * k;

    // ------------------------------------------------------- Mach crossing
    this.machPulse = Math.max(0, this.machPulse - h / MACH_PULSE_TIME);
    this.machCooldown = Math.max(0, this.machCooldown - h);

    let shockwaveCrossed = false;
    if (this.prevMach < MACH_CROSS_LOW && mach >= MACH_CROSS_HIGH && this.machCooldown <= 0) {
      shockwaveCrossed = true;
      this.machPulse = 1;
      this.machCooldown = MACH_COOLDOWN;
      this.addImpulse(0.42, 0.35);
    }
    this.prevMach = mach;

    // ------------------------------------------------------- shake impulses
    let impulseAmp = 0;
    const list = this.impulses;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const imp = list[i];
      imp.age += h;
      if (imp.age >= imp.duration) continue;
      list[n++] = imp;
      const fall = 1 - imp.age / imp.duration;
      impulseAmp += imp.intensity * fall * fall;
    }
    list.length = n;

    // Continuous rumble: afterburner buzz, fast taxi/runway roll, Mach 1 edge,
    // plus aerodynamic buffet (AoA onset / transonic shock rumble).
    let rumble = 0;
    if (afterburner) rumble += 0.012 + Math.min(0.02, speed / 40000);
    if (onGround && speed > 30) rumble += 0.01 + Math.min(0.012, speed / 6000);
    if (this.machPulse > 0) rumble += this.machPulse * 0.006;
    if (buffet > 0) rumble += buffet * 0.045;

    const hi = impulseAmp + rumble;
    const t = this.time;
    this.shakeX =
      (Math.sin(t * 51.7) * 0.65 + Math.sin(t * 27.3 + 1.1) * 0.35) * hi;
    this.shakeY =
      (Math.sin(t * 43.1 + 2.3) * 0.55 + Math.sin(t * 17.9 + 0.4) * 0.45) * hi;
    this.shakeRoll =
      (Math.sin(t * 37.7 + 3.7) * 0.7 + Math.sin(t * 11.3 + 1.9) * 0.3) *
      (impulseAmp * 0.05 + rumble * 0.02);

    return {
      blackout: this.blackout,
      redout: this.redout,
      gStrain: this.gStrain,
      machPulse: this.machPulse,
      shakeX: this.shakeX,
      shakeY: this.shakeY,
      shakeRoll: this.shakeRoll,
      shockwaveCrossed,
    };
  }
}