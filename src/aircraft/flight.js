// Flight dynamics: FBW-style rate control, lift/drag/thrust, ground handling.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, smoothstep } from '../world/noise.js';

const G = 9.80665;
const RHO0 = 1.225;
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
    this.gForce = 1;
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
    const hdg = Math.atan2(f.x, -f.z);
    const flatRight = _tmp.set(Math.cos(hdg), 0, Math.sin(hdg));
    const bank = Math.atan2(-right.y, up.y);
    return bank * 180 / Math.PI;
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
    this.targetThrottle = clamp(this.targetThrottle + (cmd.throttleDelta || 0) * 0.55 * dt, 0, 1);
    this.throttle += clamp(this.targetThrottle - this.throttle, -0.7 * dt, 0.55 * dt);
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
    const rho = RHO0 * Math.exp(-alt / 8500);
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

    // ---------------------------------------------------------------- aero
    const S = CONFIG.aircraft.wingArea;
    const flap = this.flapPos;
    const flapCl = 0.16 * flap;
    const flapCd = 0.014 * flap;
    const gearCd = (1 - this.gearPos) * 0.026;
    const brakeCd = this.brake && !this.onGround ? 0.035 : 0;

    let clAlpha = 4.35;
    let clMax = 1.50 + flapCl;
    let cl = 0.10 + clAlpha * alpha + flapCl;
    let stalled = false;
    const stallAlpha = 0.335 + flap * 0.012;
    const lowSpeedStall = airspeed < 195; // m/s (~380 kt): above this the wing is not stalled
    if (alpha > stallAlpha) {
      const over = (alpha - stallAlpha) / 0.18;
      if (lowSpeedStall) {
        cl = clMax * (1 - smoothstep(0, 0.55, over) * 0.78);
        stalled = true;
      } else {
        cl = clMax;
      }
    }
    cl = clamp(cl, -clMax, clMax);

    const q = 0.5 * rho * airspeed * airspeed;
    const lift = q * S * cl;
    const cd = 0.0195 + 0.042 * cl * cl + flapCd + gearCd + brakeCd
      + (stalled ? smoothstep(stallAlpha, stallAlpha + 0.25, alpha) * 0.09 : 0);
    const drag = q * S * cd;

    // ---------------------------------------------------------------- engine
    const dry = CONFIG.aircraft.maxThrust;
    const ab = CONFIG.aircraft.afterburner;
    const thrust = this.throttle <= 0.001 ? 1200
      : this.afterburner
        ? dry + (ab - dry) * clamp((this.throttle - 0.89) / 0.11, 0, 1)
        : 2600 + this.throttle * (dry - 2600);

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
    _force.y -= CONFIG.aircraft.mass * G;

    // ---------------------------------------------------------------- control
    const auth = clamp(Math.sqrt(q / 6500), 0.08, 1.0);
    const resp = 1 - Math.exp(-5.5 * dt);
    this.controls.pitch += (cmd.pitch - this.controls.pitch) * resp;
    this.controls.roll += (cmd.roll - this.controls.roll) * resp;
    this.controls.yaw += (cmd.yaw - this.controls.yaw) * resp;

    const maxPitch = 0.62 * auth;
    const maxRoll = 2.2 * auth;
    const maxYaw = 0.36 * auth;

    let tPitch = this.controls.pitch * maxPitch;
    let tRoll = this.controls.roll * maxRoll;
    let tYaw = this.controls.yaw * maxYaw;

    // weathervane stability + induced roll from sideslip
    tYaw -= beta * 1.5 * auth * 0.35;
    tRoll += beta * 0.6 * auth * 0.2;

    // FBW envelope protection: AoA and G limiters keep high-speed pulls from
    // departing controlled flight. Below ~150 m/s the limiter relaxes so a
    // genuine low-speed stall is still possible.
    if (this.controls.pitch > 0) {
      const aoaLimit = 0.30;
      if (alpha > 0.20) {
        const f = clamp((aoaLimit + 0.02 - alpha) / 0.12, 0, 1);
        tPitch *= f;
      }
      if (this.gForce > 8.0) {
        tPitch *= clamp((10.0 - this.gForce) / 2.0, 0, 1);
      }
    }
    if (alpha > 0.31) tPitch -= (alpha - 0.31) * 2.2;

    // stall buffet / nose drop
    if (stalled) {
      tPitch -= (alpha - stallAlpha) * 2.8;
      this._stallWarn = 1;
    } else {
      this._stallWarn = Math.max(0, this._stallWarn - dt * 2);
    }

    if (this.onGround) {
      // ground: keep wings level, allow rotation, subtle crosswind weathervaning at speed
      const groundSpd = Math.hypot(this.velocity.x, this.velocity.z);
      const speedFactor = clamp(groundSpd / 22, 0, 1);
      tRoll = this.controls.roll * 0.25;
      tPitch = this.controls.pitch * 0.34;
      const xwindYaw = clamp(this.crosswind * 0.0045, -0.09, 0.09) * clamp(groundSpd / 35, 0, 1);
      tYaw = this.controls.yaw * 0.55 * speedFactor + xwindYaw;
      this.wheelSteer = tYaw;
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

      // Translational chop forces (N, scaled to 10.8t jet).
      const mass = CONFIG.aircraft.mass;
      _force.x += Math.sin(this._time * 2.3 + _tmp.x) * turb * mass * 0.24;
      _force.z += Math.cos(this._time * 1.9 + _tmp.z) * turb * mass * 0.24;
      _force.y += (Math.sin(this._time * 3.4 + _tmp.x * 0.5) * 0.42 + _wind.y * 0.14) * turb * mass * 0.7;
    }
    this.turbulence = turb;

    // integrate orientation
    if (this.onGround) {
      // prevent roll while wheels are down
      this.rates.z *= 0.55;
    }
    _dq.set(this.rates.x * dt * 0.5, this.rates.y * dt * 0.5, this.rates.z * dt * 0.5, 1).normalize();
    this.quaternion.multiply(_dq).normalize();

    // ---------------------------------------------------------------- motion
    const accel = _force.multiplyScalar(1 / CONFIG.aircraft.mass);

    if (this.onGround) {
      // rolling friction, lateral tire grip (prevents wind sliding a parked jet), and brakes
      const rolling = this.brake ? 0.55 : 0.022;
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
      const weight = CONFIG.aircraft.mass * G;
      if (lift > weight * 1.02 && airspeed > 48) {
        this.onGround = false;
        this.velocity.y = clamp((lift - weight) / CONFIG.aircraft.mass * 0.25, 0.9, 6);
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
    this.gForce = (lift / (CONFIG.aircraft.mass * G)) * Math.cos(alpha) + Math.cos(this.rates.x) * 0;
    this.stall = stalled && !this.onGround;
    this.load = Math.abs(lift) / (CONFIG.aircraft.mass * G);

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