// Flight dynamics: NASA TP-1538 / Stevens & Lewis F-16C Block 50 aerodynamics,
// F110-GE-129 thrust model and an FBW FLCS (G/AoA limiting, 1G auto-trim,
// ARI + yaw damper), with ground handling.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, smoothstep } from '../world/noise.js';

const G = 9.80665;          // m/s^2
const RHO0 = 1.225;         // kg/m^3, ISA sea level
const R_AIR = 287.05;       // J/(kg K)
const GAMMA_AIR = 1.4;
const T0 = 288.15;          // K
const P0 = 101325;          // Pa
const WINGSPAN = 9.96;      // m, F-16C
const FT_PER_M = 3.280839895;

// F110-GE-129 installation losses (uninstalled bench thrust -> installed).
const INSTALL_DRY = 0.76;
const INSTALL_AB = 0.86;

// FLCS envelope limits (CAT I, clean airframe).
const G_LIMIT_POS = 9.0;
const G_LIMIT_NEG = -3.0;
const AOA_LIMIT_HI = 0.32;   // rad (~18.3 deg) at high energy
const AOA_LIMIT_LO = 0.41;   // rad (~23.5 deg) with the limiter relaxed

// CAT III (heavy A/G stores) stores mode: asymmetric-roll and structural limits.
const G_LIMIT_POS_STORES = 6.5;
const AOA_LIMIT_STORES = 0.279;  // rad (~16 deg) high-energy AoA cap
const ROLL_SCALE_STORES = 0.76;  // wing/pylon roll inertia penalty

// F-16C Block 50 operating weight empty, kg.
const EMPTY_MASS_KG = 8570;
const LB_TO_KG = 0.45359237;

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _vBody = new THREE.Vector3();
const _vHat = new THREE.Vector3();
const _liftDir = new THREE.Vector3();
const _force = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _invQ = new THREE.Quaternion();
const _tmp = new THREE.Vector3();
const _prevWind = new THREE.Vector3();
const _windDelta = new THREE.Vector3();

/**
 * Exact ISA troposphere / lower-stratosphere model.
 * @param {number} altitudeM pressure altitude, m
 * @returns {{T:number,p:number,rho:number,a:number}} temperature (K), pressure
 *   (Pa), density (kg/m^3) and speed of sound (m/s).
 */
export function isaAtmosphere(altitudeM) {
  const h = Math.max(0, Number.isFinite(altitudeM) ? altitudeM : 0);
  let T;
  let p;
  if (h <= 11000) {
    T = T0 - 0.0065 * h;
    p = P0 * Math.pow(T / T0, 5.25588);
  } else {
    T = 216.65;
    p = 22632.1 * Math.exp(-G * (h - 11000) / (R_AIR * T));
  }
  const rho = p / (R_AIR * T);
  const a = Math.sqrt(GAMMA_AIR * R_AIR * T);
  return { T, p, rho, a };
}

/** TP-1538 style transonic wave-drag hump, continuous in Mach. */
function waveDragCd(mach) {
  if (mach <= 0.82) return 0;
  if (mach < 1.08) return 0.024 * smoothstep(0.82, 1.08, mach);
  if (mach < 1.6) return 0.024 - 0.008 * smoothstep(1.08, 1.6, mach);
  return 0.016;
}

/** Supersonic intake spillage / boattail drag that caps low-altitude dash. */
function intakeSpillageCd(mach) {
  return 0.030 * smoothstep(1.02, 1.35, mach);
}

export class FlightModel {
  constructor() {
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.rates = new THREE.Vector3(); // body: x pitch, y yaw, z roll
    this.controls = { pitch: 0, roll: 0, yaw: 0 };

    this.throttle = 0;
    this.targetThrottle = 0;
    this.gearDown = true;
    this.gearPos = 1;
    this.gearTarget = 1;
    this.flapsIndex = 1;
    this.flapPos = 0.5;
    this.brake = false;

    this.speed = 0;
    this.aoa = 0;
    this.beta = 0;
    this.gForce = 1;
    this.gLoad = 1;
    this.stall = false;
    this.onGround = true;
    this.crashed = false;
    this.crashReason = '';
    this.agl = 0;
    this.verticalSpeed = 0;
    this.turbulence = 0;
    this.load = 0;
    this.afterburner = false;
    this.wheelSteer = 0;
    this.wind = new THREE.Vector3();
    this.windSpeed = 0;
    this.windDir = 0;
    this.windGust = 0;
    this.headwind = 0;
    this.crosswind = 0;

    // NASA TP-1538 air data / FLCS telemetry.
    this.massKg = CONFIG.aircraft.mass;
    this.storesMassKg = 0;
    this.storesDragCd = 0;
    this.catMode = 'CAT I';
    this.brakeTemp = 0;      // 0..1 carbon brake heat
    this.antiSkid = false;
    this.aerobraking = false;
    this.mach = 0;
    this.ias = 0;
    this.qBar = 0;
    this.lefDeg = -2;
    this.buffet = 0;
    this.gLoc = 0;

    this._time = 0;
    this._stallWarn = 0;
    this._lastOnGround = true;
    this._landing = null;
    this._windInit = false;
  }

  reset(spawn) {
    this.position.set(spawn.x, spawn.y, spawn.z);
    const h = (spawn.heading || 0) * Math.PI / 180;
    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -h);
    this.velocity.set(0, 0, 0);
    this.rates.set(0, 0, 0);
    this.throttle = 0;
    this.targetThrottle = 0;
    this.gearDown = true;
    this.gearPos = 1;
    this.gearTarget = 1;
    this.flapsIndex = 1;
    this.flapPos = 0.5;
    this.brake = false;
    this.speed = 0;
    this.aoa = 0;
    this.beta = 0;
    this.gForce = 1;
    this.gLoad = 1;
    this.stall = false;
    this.onGround = true;
    this.crashed = false;
    this.crashReason = '';
    this.afterburner = false;
    this.agl = 0;
    this.verticalSpeed = 0;
    this.controls.pitch = this.controls.roll = this.controls.yaw = 0;
    this._lastOnGround = true;
    this._liftoff = 0;
    this.wind.set(0, 0, 0);
    this.windSpeed = 0;
    this.windDir = 0;
    this.windGust = 0;
    this.headwind = 0;
    this.crosswind = 0;
    this._windInit = false;

    this.massKg = CONFIG.aircraft.mass;
    this.storesMassKg = 0;
    this.storesDragCd = 0;
    this.catMode = 'CAT I';
    this.brakeTemp = 0;
    this.antiSkid = false;
    this.aerobraking = false;
    this.mach = 0;
    this.ias = 0;
    this.qBar = 0;
    this.lefDeg = -2;
    this.buffet = 0;
    this.gLoc = 0;
  }

  /**
   * Live stores/fuel coupling. Updates mass, parasitic store drag and the
   * FLCS stores mode (CAT I / CAT III). Allocation-free; safe to call each
   * time the loadout changes (and never required for the baseline airframe).
   * @param {{fuelLb?:number, aim9?:number, mk82?:number, bffg?:number}} loadout
   */
  setLoadout(loadout) {
    if (!loadout) return;
    const fuelLb = Number.isFinite(loadout.fuelLb) ? Math.max(0, loadout.fuelLb) : 4916;
    const aim9 = Math.max(0, loadout.aim9 || 0);
    const mk82 = Math.max(0, loadout.mk82 || 0);
    const bffg = Math.max(0, loadout.bffg || 0);
    this.storesMassKg = aim9 * 85 + mk82 * 241 + bffg * 650;
    this.storesDragCd = aim9 * 0.0008 + mk82 * 0.0022 + bffg * 0.0042;
    this.massKg = EMPTY_MASS_KG + fuelLb * LB_TO_KG + this.storesMassKg;
    this.catMode = (mk82 > 0 || bffg > 0) ? 'CAT III' : 'CAT I';
  }

  get forward() {
    return _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
  }

  get heading() {
    const f = this.forward;
    let h = Math.atan2(f.x, -f.z) * 180 / Math.PI;
    if (h < 0) h += 360;
    return h;
  }

  get pitchDeg() {
    return Math.asin(clamp(this.forward.y, -1, 1)) * 180 / Math.PI;
  }

  get rollDeg() {
    const f = this.forward;
    const right = _right.set(1, 0, 0).applyQuaternion(this.quaternion);
    // bank angle relative to horizon
    const up = _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const bank = Math.atan2(-right.y, up.y);
    return bank * 180 / Math.PI;
  }

  /** Air data (Mach, calibrated airspeed, dynamic pressure) for HUD/MCP use. */
  get indicatedAirspeedKt() {
    return this.ias * 1.94384;
  }

  get trueAirspeedKt() {
    return this.speed * 1.94384;
  }

  get altitudeFt() {
    return this.position.y * FT_PER_M;
  }

  /**
   * @param {number} dt seconds
   * @param {{pitch:number,roll:number,yaw:number,throttleDelta:number,gearToggle:boolean,flapsToggle:boolean,brake:boolean}} cmd
   * @param {{heightAt:(x:number,z:number)=>number, slopeAt?:(x:number,z:number)=>number}} world
   * @param {object} weather
   */
  update(dt, cmd, world, weather) {
    dt = Math.min(dt, 0.05);
    if (this.crashed) return;
    this._time += dt;

    // ---------------------------------------------------------------- systems
    this.targetThrottle = clamp(this.targetThrottle + (cmd.throttleDelta || 0) * 0.8 * dt, 0, 1);
    // F110 spool: faster above 50% RPM, more inertia from idle.
    const spoolErr = this.targetThrottle - this.throttle;
    const spoolRate = spoolErr >= 0
      ? (this.throttle < 0.5 ? 0.38 : 0.65)
      : (this.throttle > 0.5 ? 0.85 : 0.45);
    this.throttle = clamp(this.throttle + clamp(spoolErr, -spoolRate * dt, spoolRate * dt), 0, 1);
    this.afterburner = this.throttle > 0.89;

    if (cmd.gearToggle) {
      this.gearTarget = this.gearTarget > 0.5 ? 0 : 1;
      this.gearDown = this.gearTarget === 1;
    }
    this.gearPos += clamp(this.gearTarget - this.gearPos, -0.35 * dt, 0.35 * dt);

    if (cmd.flapsToggle) this.flapsIndex = (this.flapsIndex + 1) % 3;
    this.flapPos += clamp(this.flapsIndex / 2 - this.flapPos, -0.5 * dt, 0.5 * dt);

    this.brake = !!cmd.brake;

    // ---------------------------------------------------------------- air data
    const alt = Math.max(0, this.position.y);
    const isa = isaAtmosphere(alt);
    const rho = isa.rho;
    const pStatic = isa.p;
    const localSlope = world.slopeAt ? world.slopeAt(this.position.x, this.position.z) : 0;
    _prevWind.copy(this.wind);
    if (weather) {
      weather.windAt(this.position.x, this.position.z, alt, _wind, localSlope);
    } else {
      _wind.set(0, 0, 0);
    }
    this.wind.copy(_wind);
    const wHoriz = Math.hypot(_wind.x, _wind.z);
    this.windSpeed = wHoriz;
    // Aviation convention: direction wind is blowing FROM (0 = North, 90 = East).
    this.windDir = wHoriz > 0.05 ? ((Math.atan2(-_wind.x, _wind.z) * 180 / Math.PI) + 360) % 360 : 0;
    this.windGust = weather?.state?.gust ?? 0;

    if (this._windInit) {
      _windDelta.copy(_wind).sub(_prevWind).multiplyScalar(1 / Math.max(dt, 0.005));
    } else {
      _windDelta.set(0, 0, 0);
      this._windInit = true;
    }

    // When parked slowly on the runway, keep tires planted against wind creep
    // while still measuring true aerodynamic relative wind for liftoff/airspeed.
    _tmp.copy(this.velocity).sub(_wind);
    const airspeed = _tmp.length();

    _fwd.set(0, 0, -1).applyQuaternion(this.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.quaternion);

    // Headwind (+ opposing nose) and crosswind (+ from right).
    this.headwind = -_wind.dot(_fwd);
    this.crosswind = -_wind.dot(_right);

    _invQ.copy(this.quaternion).invert();
    _vBody.copy(_tmp).applyQuaternion(_invQ);

    let alpha = 0;
    let beta = 0;
    if (airspeed > 14) {
      const fz = Math.max(0.6, -_vBody.z);
      alpha = Math.atan2(-_vBody.y, fz);
      beta = Math.atan2(_vBody.x, fz);
    }
    alpha = clamp(alpha, -0.55, 0.55);
    beta = clamp(beta, -0.6, 0.6);
    this.aoa = alpha;
    this.beta = beta;

    // Standard atmosphere air data (TP-1538 / HUD instrumentation).
    this.mach = airspeed / isa.a;
    this.qBar = 0.5 * rho * airspeed * airspeed;
    this.ias = airspeed * Math.sqrt(rho / RHO0);
    const q = this.qBar;
    const M = this.mach;

    // ------------------------------------- runway braking / aerobrake state
    // Aerobraking: high-alpha ground roll above ~93 kt, holding the tail low.
    // Anti-skid modulates brake pressure at speed on a wet or dry runway.
    const groundSpd = Math.hypot(this.velocity.x, this.velocity.z);
    const wet = weather?.state?.rain ? clamp(weather.state.rain, 0, 1) : 0;
    if (this.onGround) {
      this.aerobraking = airspeed > 48 && this.pitchDeg > 8;
      if (this.brake && groundSpd > 8) {
        this.brakeTemp = clamp(this.brakeTemp + dt * (0.045 + groundSpd * 0.0012), 0, 1);
        this.antiSkid = groundSpd > 35 || (wet > 0.2 && groundSpd > 15);
      } else {
        this.antiSkid = false;
        this.brakeTemp = Math.max(0, this.brakeTemp - dt * 0.025);
      }
    } else {
      this.aerobraking = false;
      this.antiSkid = false;
      this.brakeTemp = Math.max(0, this.brakeTemp - dt * 0.06);
    }

    // -------------------------------------------------- ground-effect (IGE)
    const ghStart = world.heightAt(this.position.x, this.position.z);
    const aglNow = Math.max(0, this.position.y - ghStart);
    const geFactor = (!this.onGround && aglNow > 0.05 && aglNow < 12)
      ? 1 - smoothstep(0, 12, aglNow)
      : 0;

    // ------------------------------------------- NASA TP-1538 LEF schedule
    // lefTarget = 1.38*alpha - 9.05*(q/p) + 1.45, locked at -2 above M 1.05.
    let lefTarget;
    if (M > 1.05) {
      lefTarget = -2; // supersonic minimum-wave-drag schedule
    } else {
      const alphaDeg = alpha * 180 / Math.PI;
      lefTarget = clamp(1.38 * alphaDeg - 9.05 * (q / Math.max(pStatic, 1)) + 1.45, -2, 25);
      if (this.gearPos > 0.5) lefTarget = Math.max(lefTarget, 15); // landing / takeoff droop
    }
    this.lefDeg += clamp(lefTarget - this.lefDeg, -25 * dt, 25 * dt);

    // ---------------------------------------------------------------- aero
    const S = CONFIG.aircraft.wingArea;
    const flap = this.flapPos;
    const flapCl = 0.22 * flap;
    const flapCd = 0.018 * flap;
    const gearCd = this.gearPos * 0.032; // FIXED: down = more drag
    const brakeCd = this.brake && !this.onGround ? 0.055 : 0;
    const lefLift = 0.011 * Math.max(0, this.lefDeg);

    // Compressibility-corrected lift-curve slope: PG rise subsonic, smooth
    // supersonic decay, blended through the transonic band (no discontinuity).
    const clSub = 4.25 * (1 + 0.35 * smoothstep(0.55, 0.85, M));
    const clSup = 4.25 / Math.sqrt(Math.max(M * M - 1, 0.45));
    const clCompress = smoothstep(0.9, 1.3, M);
    const clAlpha = clSub * (1 - clCompress) + clSup * clCompress;

    // LERX strake vortex lift above ~10 deg AoA.
    const vortexOnset = smoothstep(0.14, 0.30, Math.abs(alpha));
    const vortex = 0.35 * Math.sin(alpha) * Math.sin(alpha) * vortexOnset;

    const clMax = 1.84 + 0.35 * flapCl + 0.002 * Math.max(0, this.lefDeg);
    let cl = 0.06 + clAlpha * alpha + vortex + lefLift + flapCl;

    const stallAlpha = 0.38 + flap * 0.012;
    const lowSpeedStall = airspeed < 195; // m/s (~380 kt): above this the wing is not stalled
    let stalled = false;
    if (alpha > stallAlpha) {
      const over = (alpha - stallAlpha) / 0.18;
      if (lowSpeedStall) {
        cl = clMax * (1 - smoothstep(0, 0.55, over) * 0.80);
        stalled = true;
      } else {
        cl = Math.min(cl, clMax);
      }
    }
    cl = clamp(cl, -clMax * 0.85, clMax);

    // ---------------------------------------------------------- drag build-up
    // Oswald efficiency improves (k drops) in ground effect.
    let inducedK = 0.105 * (1 + 0.60 * smoothstep(0.12, 0.35, Math.abs(alpha)));
    inducedK *= 1 - 0.25 * geFactor;

    const separatedDrag = stalled ? smoothstep(stallAlpha, stallAlpha + 0.25, alpha) * 0.09 : 0;
    // Aerobraking adds high-alpha ground-roll drag (scales with elevator-up pitch).
    const aeroBrakeCd = this.aerobraking
      ? 0.028 * clamp((this.pitchDeg - 8) / 5, 0, 1)
      : 0;
    const cd = 0.0175                     // clean subsonic parasite drag
      + this.storesDragCd                 // live stores / pylon drag
      + waveDragCd(M)                     // transonic wave drag
      + intakeSpillageCd(M)               // supersonic intake/boattail drag
      + inducedK * cl * cl                // induced drag
      + flapCd + gearCd + brakeCd
      + aeroBrakeCd
      + separatedDrag;

    const liftAttached = q * S * cl;
    const lift = liftAttached * (1 + 0.10 * geFactor);
    const drag = q * S * cd;

    // Body-normal load factor (specific force) for the G-meter / FLCS.
    const nz = (lift * Math.cos(alpha) + drag * Math.sin(alpha)) / (this.massKg * G);

    // ---------------------------------------------------------------- engine
    const dry = CONFIG.aircraft.maxThrust;
    const ab = CONFIG.aircraft.afterburner;
    const sigma = rho / RHO0;
    const dryMax = dry * Math.pow(sigma, 0.72) * (1 + 0.25 * Math.pow(Math.min(M, 1.3), 1.4)) * INSTALL_DRY;
    const abMax = ab * Math.pow(sigma, 0.68) * (1 + 0.48 * Math.pow(Math.min(M, 2.0), 1.35)) * INSTALL_AB;
    let thrust;
    if (this.throttle <= 0.001) {
      thrust = 1200;
    } else if (this.throttle <= 0.89) {
      thrust = 2600 + (this.throttle / 0.89) * (dryMax - 2600);
    } else if (this.afterburner) {
      thrust = dryMax + clamp((this.throttle - 0.89) / 0.11, 0, 1) * (abMax - dryMax);
    } else {
      thrust = dryMax;
    }

    // ---------------------------------------------------------------- forces
    _force.set(0, 0, 0);
    if (airspeed > 0.05) {
      _vHat.copy(_tmp).multiplyScalar(1 / airspeed);
      // lift perpendicular to relative wind, in the aircraft vertical plane
      _liftDir.copy(_up).addScaledVector(_vHat, -_up.dot(_vHat));
      if (_liftDir.lengthSq() > 1e-6) _liftDir.normalize();
      _force.addScaledVector(_liftDir, lift);
      _force.addScaledVector(_vHat, -drag);
      // side force from sideslip
      _force.addScaledVector(_right, -q * S * 0.72 * beta);
    }
    _force.addScaledVector(_fwd, thrust);
    _force.y -= this.massKg * G;

    // ---------------------------------------------------------------- control
    const auth = clamp(Math.sqrt(q / 6500), 0.08, 1.0);
    const resp = 1 - Math.exp(-6.5 * dt);
    this.controls.pitch += (cmd.pitch - this.controls.pitch) * resp;
    this.controls.roll += (cmd.roll - this.controls.roll) * resp;
    this.controls.yaw += (cmd.yaw - this.controls.yaw) * resp;

    const maxPitch = 0.90 * auth;
    const rollSchedule = 1 - 0.65 * smoothstep(0.17, 0.35, Math.abs(alpha))
      - 0.20 * smoothstep(16000, 45000, q);
    // FLCS stores mode: CAT III (A/G stores on the wing) trims roll authority
    // for the heavier wing/pylon inertia; CAT I keeps the full F-16 roll rate.
    const storesMode = this.catMode === 'CAT III';
    const rollScale = storesMode ? ROLL_SCALE_STORES : 1;
    const maxRoll = clamp(4.1 * auth * rollSchedule * rollScale, 0.25, 4.2);
    const maxYaw = 0.36 * auth;
    const gLimitPos = storesMode ? G_LIMIT_POS_STORES : G_LIMIT_POS;

    let tPitch;
    let tRoll;
    let tYaw;

    if (this.onGround) {
      // ground: keep wings level, allow rotation, NWS + crosswind weathervane
      tRoll = this.controls.roll * 0.25;
      tPitch = this.controls.pitch * 0.34;
      // Aerobraking: hold high alpha without tail-striking, then settle the
      // nose once the jet has slowed below the aero-brake speed band.
      const pitchNow = this.pitchDeg;
      if (this.aerobraking && pitchNow > 13.5) {
        tPitch -= (pitchNow - 13.5) * 0.03;
      } else if (airspeed <= 48 && pitchNow > 0.5) {
        tPitch -= pitchNow * 0.008;
      }
      const nws = 1 - smoothstep(22, 35, groundSpd);
      const rudder = smoothstep(25, 45, groundSpd);
      const xwindYaw = clamp(this.crosswind * 0.0045, -0.09, 0.09) * clamp(groundSpd / 35, 0, 1);
      tYaw = this.controls.yaw * (0.10 + 0.55 * nws + 0.35 * rudder) + xwindYaw;
      this.wheelSteer = this.controls.yaw * 0.55 * nws;
    } else {
      // ---- FLCS pitch law: G-command with AoA limiting ----
      const bankCos = Math.sqrt(Math.max(0.05, 1 - _right.y * _right.y)); // cos(bank)
      const neutralStick = Math.abs(cmd.pitch) < 0.02;
      const gearDown = this.gearPos > 0.5;
      // 1G auto-trim only with neutral stick, clean config and real airspeed.
      const gCommand = !neutralStick || (this.ias > 85 && !gearDown && !stalled);
      const gDamp = 0.18 * clamp(this.ias / 100, 0, 1);

      if (gCommand) {
        let gTarget;
        if (neutralStick) {
          // Hold 1G in level flight, 1/cos(bank) in a banked turn.
          gTarget = clamp(1 / bankCos, 1, 2.5);
        } else {
          gTarget = cmd.pitch >= 0
            ? 1 + (gLimitPos - 1) * cmd.pitch
            : 1 + (1 - G_LIMIT_NEG) * cmd.pitch;
        }
        gTarget = clamp(gTarget, G_LIMIT_NEG, gLimitPos);
        tPitch = clamp((gTarget - nz) * 0.50 - this.rates.x * gDamp, -maxPitch, maxPitch);
      } else {
        // Hands-off / landing: AoA + pitch-rate command.
        tPitch = clamp(this.controls.pitch * maxPitch, -maxPitch, maxPitch);
      }

      // AoA limiter: tight at high energy, relaxing below ~140 kt so a genuine
      // low-speed departure is still possible. CAT III caps it harder (stores).
      const relax = 1 - clamp((this.ias - 40) / 32, 0, 1);
      const aoaHi = storesMode ? AOA_LIMIT_STORES : AOA_LIMIT_HI;
      const aoaLimit = aoaHi + (AOA_LIMIT_LO - aoaHi) * relax;
      if (this.controls.pitch > 0.05 && tPitch > 0) {
        if (alpha > aoaLimit * 0.80) {
          tPitch *= clamp((aoaLimit - alpha) / (aoaLimit * 0.20), 0, 1);
        }
        if (alpha > aoaLimit) tPitch -= (alpha - aoaLimit) * 3.0;
      }

      // Natural high-AoA pitch-down (aero centre / tail authority loss).
      if (alpha > 0.31) tPitch -= (alpha - 0.31) * 2.2;

      // stall buffet / nose drop
      if (stalled) {
        tPitch -= (alpha - stallAlpha) * 2.8;
        this._stallWarn = 1;
      } else {
        this._stallWarn = Math.max(0, this._stallWarn - dt * 2);
      }

      // ---- lateral / directional FLCS: roll, ARI, yaw damper ----
      tRoll = this.controls.roll * maxRoll;
      tYaw = this.controls.yaw * maxYaw;
      tYaw += this.controls.roll * 0.16 * auth;  // aileron-rudder interconnect
      tYaw -= beta * 2.4 * auth;                 // weathervane / sideslip damping
      tYaw -= this.rates.y * 0.35 * auth;        // yaw damper
      tRoll += beta * 0.6 * auth * 0.2;          // dihedral effect
    }

    this.rates.x += (tPitch - this.rates.x) * (1 - Math.exp(-7 * dt));
    this.rates.y += (tYaw - this.rates.y) * (1 - Math.exp(-4 * dt));
    this.rates.z += (tRoll - this.rates.z) * (1 - Math.exp(-8 * dt));

    // turbulence, gusts & wind shear
    let turb = 0;
    if (weather && !this.onGround) {
      _tmp.copy(this.position).multiplyScalar(0.01);
      const baseTurb = weather.state.turbulence || 0;
      const gust = this.windGust;
      const shearMag = clamp(_windDelta.length() / 14, 0, 1.5);
      turb = baseTurb * (0.65 + gust * 0.85) + shearMag * 0.35;

      // Aerodynamic gust bumps (noticeable wing-rock, pitch bump & vertical chop,
      // scaled to airframe mass while remaining controllable with FBW).
      const airScale = clamp(airspeed / 110, 0.35, 1.35);
      const pitchBump = (Math.sin(this._time * 2.1 + _tmp.x) * 0.055 + Math.sin(this._time * 5.3 + _tmp.z) * 0.032) * turb * airScale;
      const rollBump = (Math.sin(this._time * 1.6 + _tmp.z) * 0.085 + Math.cos(this._time * 4.1 + _tmp.x) * 0.045) * turb * airScale;
      const yawBump = Math.sin(this._time * 1.3 + _tmp.x * 0.7) * 0.025 * turb * airScale;
      this.rates.x += pitchBump * dt * 5.2;
      this.rates.z += rollBump * dt * 6.5;
      this.rates.y += yawBump * dt * 3.0;

      // Translational chop forces (N, scaled to the airframe mass).
      _force.x += Math.sin(this._time * 2.3 + _tmp.x) * turb * this.massKg * 0.24;
      _force.z += Math.cos(this._time * 1.9 + _tmp.z) * turb * this.massKg * 0.24;
      _force.y += (Math.sin(this._time * 3.4 + _tmp.x * 0.5) * 0.42 + _wind.y * 0.14) * turb * this.massKg * 0.7;
    }
    this.turbulence = turb;

    // Departure wing-rock when stalled (deterministic).
    if (stalled && !this.onGround) {
      this.rates.z += Math.sin(this._time * 12.7) * 0.90 * dt;
      this.rates.x += Math.sin(this._time * 9.3) * 0.35 * dt;
    }

    // integrate orientation
    if (this.onGround) {
      // prevent roll while wheels are down
      this.rates.z *= 0.55;
    }
    _dq.set(this.rates.x * dt * 0.5, this.rates.y * dt * 0.5, this.rates.z * dt * 0.5, 1).normalize();
    this.quaternion.multiply(_dq).normalize();

    // ---------------------------------------------------------------- motion
    const accel = _force.multiplyScalar(1 / this.massKg);

    if (this.onGround) {
      // rolling friction, lateral tire grip (prevents wind sliding a parked jet), and brakes
      // Anti-skid pulses brake pressure at speed; wet tires and hot (faded)
      // carbon brakes both bleed peak grip.
      let brakeGrip = 1;
      if (this.brake && groundSpd > 8) {
        if (this.antiSkid) brakeGrip *= 0.84 + 0.14 * Math.sin(this._time * 38);
        brakeGrip *= 1 - wet * 0.28;
        if (this.brakeTemp > 0.8) brakeGrip *= 1 - (this.brakeTemp - 0.8) * 0.6;
      }
      const rolling = this.brake ? 0.55 * brakeGrip : 0.018;
      const vHoriz = _tmp.set(this.velocity.x, 0, this.velocity.z);
      const spd = vHoriz.length();
      if (spd > 0.01) vHoriz.multiplyScalar(-rolling * G / Math.max(spd, 1));
      // Project ground acceleration mostly along forward heading when slow so crosswind doesn't push parked tires sideways
      const fwdHorizX = _fwd.x;
      const fwdHorizZ = _fwd.z;
      const fhLen = Math.hypot(fwdHorizX, fwdHorizZ) || 1;
      const fx = fwdHorizX / fhLen;
      const fz = fwdHorizZ / fhLen;
      const aFwd = accel.x * fx + accel.z * fz;
      const aLat = accel.x * (-fz) + accel.z * fx;
      const latDamp = this.brake ? 0.02 : (spd < 15 ? 0.08 : 0.28);
      const effAx = fx * aFwd + (-fz) * aLat * latDamp;
      const effAz = fz * aFwd + fx * aLat * latDamp;

      this.velocity.x = this.velocity.x + effAx * dt + vHoriz.x * dt;
      this.velocity.z = this.velocity.z + effAz * dt + vHoriz.z * dt;
      // damp lateral tire slip on runway
      const vLat = this.velocity.x * (-fz) + this.velocity.z * fx;
      const slipKill = 1 - Math.exp(-(this.brake ? 14 : 6.5) * dt);
      this.velocity.x -= (-fz) * vLat * slipKill;
      this.velocity.z -= fx * vLat * slipKill;
      this.velocity.y = 0;

      // lift off?
      const weight = this.massKg * G;
      if (lift > weight * 1.02 && airspeed > 48) {
        this.onGround = false;
        this.velocity.y = clamp((lift - weight) / this.massKg * 0.25, 0.9, 6);
        this._liftoff = 0.5;
      }
    } else {
      this.velocity.addScaledVector(accel, dt);
      // clamp extremely silly speeds
      const sp = this.velocity.length();
      if (sp > 900) this.velocity.multiplyScalar(900 / sp);
    }

    this.position.addScaledVector(this.velocity, dt);

    // ---------------------------------------------------------------- ground
    const gh = world.heightAt(this.position.x, this.position.z);
    const wheels = this.gearPos > 0.9 ? CONFIG.aircraft.gearHeight : CONFIG.aircraft.bellyHeight;
    this.agl = this.position.y - gh;
    this.verticalSpeed = this.velocity.y;

    const wasGround = this.onGround;
    if (this._liftoff > 0) this._liftoff -= dt;

    if (this.agl <= wheels + 0.06 && (this.velocity.y <= 0.05 || this.onGround)) {
      const impact = -this.velocity.y;
      const bank = this.rollDeg;
      const pitch = this.pitchDeg;
      const slope = world.slopeAt ? world.slopeAt(this.position.x, this.position.z) : 0;

      if (this.gearPos < 0.85) {
        this._crash('GEAR RETRACTED — BELLY IMPACT');
      } else if (!this.onGround && impact > 7.5) {
        this._crash('HARD LANDING — ' + Math.round(impact * 196.85) + ' FPM');
      } else if (!this.onGround && Math.abs(bank) > 16) {
        this._crash('WING STRIKE ON TOUCHDOWN');
      } else if (!this.onGround && (pitch > 19 || pitch < -4)) {
        this._crash('TAIL / NOSE STRIKE');
      } else if (slope > 0.32 && airspeed > 55) {
        this._crash('TERRAIN TOO STEEP');
      } else if (this.crashed) {
        // handled
      } else {
        if (!this.onGround) {
          this._landing = { impact, time: this._time };
          if (impact > 4.2) this._bump = impact;
        }
        this.onGround = true;
        this.position.y = gh + wheels;
        this.velocity.y = 0;
      }

      if (this.onGround) {
        // slope makes the aircraft slide downhill when slow
        const pitchLimitUp = (14 * Math.PI) / 180;
        const pitchLimitDown = (-2 * Math.PI) / 180;
        const pitch = (this.pitchDeg * Math.PI) / 180;
        if (pitch > pitchLimitUp) this.rates.x -= (pitch - pitchLimitUp) * 2.4;
        if (pitch < pitchLimitDown) this.rates.x += (pitchLimitDown - pitch) * 2.4;
        if (Math.abs(this.rollDeg) > 9) this._crash('WING TIP CONTACT');
      }
    } else if (this.onGround) {
      // left the ground
      this.onGround = false;
    }

    // flying into terrain (gear up or steep hill); allow the first moments after liftoff
    if (!this.onGround && this._liftoff <= 0 && this.velocity.y < -0.5
        && this.agl < wheels - 0.1 && !this.crashed) {
      this._crash('CONTROLLED FLIGHT INTO TERRAIN');
    }

    // ---------------------------------------------------------------- telemetry
    this.speed = airspeed;
    this.gForce = this.onGround ? 1 : nz;
    this.gLoad = this.gForce;
    this.stall = stalled && !this.onGround;
    this.load = Math.abs(lift) / (this.massKg * G);

    // TP-1538 buffet: AoA onset above 14 deg plus transonic shock buffet.
    const aoaBuffet = smoothstep(0.244, stallAlpha, Math.abs(alpha)) * (this.onGround ? 0 : 1);
    const transBuffet = 0.35 * smoothstep(0.92, 0.98, M) * (1 - smoothstep(1.00, 1.06, M));
    this.buffet = clamp(Math.max(aoaBuffet, transBuffet), 0, 1);

    // G-strain: accumulates above 7G / below -2.2G, recovers below 5G.
    const strain = Math.max(0, this.gForce - 7.0) / 2 + Math.max(0, -2.2 - this.gForce) / 1.2;
    if (strain > 0) this.gLoc = clamp(this.gLoc + strain * 0.055 * dt, 0, 1);
    else if (this.gForce < 5.0) this.gLoc = clamp(this.gLoc - 0.22 * dt, 0, 1);

    // touchdown sound event
    if (!wasGround && this.onGround && this._bump) {
      this.touchdown = this._bump;
      this._bump = 0;
    } else {
      this.touchdown = 0;
    }

    if (Math.abs(this.controls.roll) > 0.02) {
      this.aileron = this.controls.roll;
    } else {
      this.aileron = 0;
    }
  }

  _crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.velocity.multiplyScalar(0.1);
    this.onGround = false;
  }
}

// Helper for spawn quaternion / forward math in other modules.
export function headingQuaternion(headingDeg, out = new THREE.Quaternion()) {
  return out.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(headingDeg || 0) * Math.PI / 180);
}