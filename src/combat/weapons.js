// Weapons, ballistics, CCIP dive-bombing solution and countermeasure flares.
//
// Headless safe: `scene` may be null (unit tests / dedicated servers), in which
// case no Three.js objects are created or added. Simulation state lives in
// plain THREE.Vector3 maths so the same code runs with or without a renderer.
import * as THREE from 'three';
import { mulberry32 } from '../world/noise.js';

export const WEAPON_TYPES = ['GUN', 'AIM9', 'MK82', 'BFFG'];

const G = 9.81;
const GUN_YAW_LIMIT = 0.004; // rad, realistic M61 dispersion cone

export const WEAPONS = {
  GUN: {
    name: 'M61A1 Vulcan 20mm',
    cooldown: 0.07, // ~850 RPM
    muzzleSpeed: 1030,
    dispersion: GUN_YAW_LIMIT,
    damage: 18,
    splashRadius: 6,
    ttl: 3.0,
    drag: 0,
  },
  AIM9: {
    name: 'AIM-9 Sidewinder',
    cooldown: 0.8,
    launchSpeed: 40, // m/s boost off the rail, added to aircraft velocity
    accel: 180, // m/s² rocket burn
    burnTime: 2.6,
    maxSpeed: 880,
    fuseRadius: 18,
    navConstant: 3.5,
    maxLateralAccel: 400, // ~40 g structural limit
    damage: 120,
    splashRadius: 32,
    ttl: 14,
  },
  MK82: {
    name: 'Mk-82 500lb',
    cooldown: 0.45,
    ejectSpeed: 2.5, // m/s downward ejection
    drag: 1e-4, // low aerodynamic drag coefficient (per m/s)
    // Feature 21: a true 500 lb blast — leaves a crater-sized kill zone.
    damage: 180,
    splashRadius: 75,
    ttl: 90,
  },
  BFFG: {
    // Feature 23: "Big Falcon Gun" tactical plasma-thermobaric mega-ordnance.
    name: 'BFFG-9000 Mega-Ordnance',
    cooldown: 2.5,
    launchSpeed: 240,
    accel: 95,
    burnTime: 1.8,
    maxSpeed: 560,
    drag: 4e-5,
    damage: 5000,
    splashRadius: 420, // levels an entire city district
    ttl: 35,
  },
  FLARE: {
    name: 'M206 flare',
    cooldown: 0.25,
    burnTime: 4.5,
    drag: 0.004,
    trailInterval: 0.1,
  },
};

export const DEFAULT_AMMO = { GUN: 510, AIM9: 4, MK82: 6, BFFG: 2, FLARE: 30 };

// Feature 23: BFFG rocket-motor step shared by the live projectile and the CCIP
// predictor, so the on-screen reticle matches the round that actually flies.
const BFFG_BURN_GRAVITY = 0.35; // gentle arc while the motor boosts
const BFFG_COAST_GRAVITY = 1.0;
const BFFG_MIN_COAST_SPEED = 140; // m/s, never stall out mid-air
function bffgStep(pos, vel, h, age, def) {
  const burning = age <= def.burnTime;
  let speed = vel.length();
  if (burning) speed = Math.min(def.maxSpeed, speed + def.accel * h);
  speed = Math.max(burning ? 1 : BFFG_MIN_COAST_SPEED, speed - def.drag * speed * speed * h);
  if (speed > 1e-6) vel.setLength(speed);
  vel.y -= G * (burning ? BFFG_BURN_GRAVITY : BFFG_COAST_GRAVITY) * h;
  pos.addScaledVector(vel, h);
}

const _vMid = new THREE.Vector3();
const _acc1 = new THREE.Vector3();
const _acc2 = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _los = new THREE.Vector3();
const _vRel = new THREE.Vector3();
const _omega = new THREE.Vector3();
const _aCmd = new THREE.Vector3();
const _prevPos = new THREE.Vector3();
const _segA = new THREE.Vector3();
const _segD = new THREE.Vector3();
const _segP = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _targetVel = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _eject = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// Dedicated scratch vectors for the gun/aim solvers, kept apart from the
// guidance temporaries so the two can never clobber each other mid-frame.
const _gMuzzle = new THREE.Vector3();
const _gForward = new THREE.Vector3();
const _gOwn = new THREE.Vector3();
const _gPos = new THREE.Vector3();
const _gVel = new THREE.Vector3();
const _gPrev = new THREE.Vector3();
const _gAim = new THREE.Vector3();
const _gTP = new THREE.Vector3();
const _gTV = new THREE.Vector3();
const _gPT = new THREE.Vector3();
const _gD = new THREE.Vector3();

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

// Closest distance between point (px,py,pz) and segment a→b.
// Leaves the closest point on the segment in _segP.
function segmentDistance(a, b, px, py, pz) {
  _segA.set(px, py, pz);
  _segD.copy(b).sub(a);
  const len2 = _segD.lengthSq();
  const t = len2 > 1e-9 ? clamp(_tmp.copy(_segA).sub(a).dot(_segD) / len2, 0, 1) : 0;
  _segP.copy(a).addScaledVector(_segD, t);
  return _segP.distanceTo(_segA);
}

// Midpoint-integrated ballistic step: gravity plus quadratic-ish drag.
function ballisticStep(pos, vel, dt, dragK) {
  const speed = vel.length();
  _acc1.set(0, -G, 0);
  if (dragK > 0 && speed > 1e-6) _acc1.addScaledVector(vel, -dragK * speed);
  _vMid.copy(vel).addScaledVector(_acc1, dt * 0.5);
  pos.addScaledVector(_vMid, dt);
  const s2 = _vMid.length();
  _acc2.set(0, -G, 0);
  if (dragK > 0 && s2 > 1e-6) _acc2.addScaledVector(_vMid, -dragK * s2);
  vel.addScaledVector(_acc2, dt);
}

export class WeaponSystem {
  constructor(scene) {
    this.scene = scene || null;

    this.selected = 'GUN';
    this.ammo = { ...DEFAULT_AMMO };
    this.projectiles = [];
    this.flares = [];
    this.ccip = { valid: false, x: 0, y: 0, z: 0, timeToImpact: 0 };

    // --- Feature 12A: exact 3D aiming state -------------------------------
    // boresightPoint: true 3D line-of-sight along the nose/gun axis.
    // ccipOrigin:     point on the 3D flight path the bomb fall line starts at.
    // gunSolution:    zero-dispersion 20 mm impact / lead solution for the HUD.
    this.boresightPoint = { valid: false, x: 0, y: 0, z: 0 };
    this.ccipOrigin = { valid: false, x: 0, y: 0, z: 0 };
    this.gunSolution = {
      valid: false,
      aimPoint: { x: 0, y: 0, z: 0 },
      impactValid: false,
      impactPoint: { x: 0, y: 0, z: 0 },
      leadValid: false,
      leadPoint: { x: 0, y: 0, z: 0 },
      range: 0,
      tof: 0,
    };
    this._resetAimState();

    this._cooldown = { GUN: 0, AIM9: 0, MK82: 0, BFFG: 0, FLARE: 0 };
    this._gunSide = 1;
    this._aim9Side = 1;
    this._mk82Side = 1;
    this._rand = mulberry32(0x5eed1234);
    this._time = 0;
  }

  // ------------------------------------------------------------------ loadout
  reset() {
    for (const p of this.projectiles) this._disposeMesh(p.mesh);
    for (const f of this.flares) this._disposeMesh(f.mesh);

    this.projectiles.length = 0;
    this.flares.length = 0;
    this.ammo = { ...DEFAULT_AMMO };

    for (const k of Object.keys(this._cooldown)) this._cooldown[k] = 0;
    this._gunSide = 1;
    this._aim9Side = 1;
    this._mk82Side = 1;
    this.ccip.valid = false;
    this.ccip.timeToImpact = 0;
    this._resetAimState();
    return this;
  }

  cycleWeapon() {
    const i = WEAPON_TYPES.indexOf(this.selected);
    this.selected = WEAPON_TYPES[(i + 1) % WEAPON_TYPES.length];
    return this.selected;
  }

  selectWeapon(type) {
    if (WEAPON_TYPES.includes(type)) this.selected = type;
    return this.selected;
  }

  // --------------------------------------------------------------------- fire
  fire(flight, lockedTarget = null) {
    const type = this.selected;
    const def = WEAPONS[type];
    if (!def || !flight || !flight.position) return { fired: false, type };

    if (this.ammo[type] <= 0) return { fired: false, type, reason: 'empty' };
    if (this._cooldown[type] > 0) return { fired: false, type, reason: 'cooldown' };
    this._armCooldown(type);

    const q = flight.quaternion || _q.identity();
    const forward = _dir.set(0, 0, -1).applyQuaternion(q);
    const velocity = (flight.velocity || _tmp.set(0, 0, 0)).clone();
    const origin = flight.position.clone();

    if (type === 'GUN') {
      const muzzle = _tmp.set(-0.75, 0.25, -2.5).applyQuaternion(q).add(origin);
      _up.set(0, 1, 0).applyQuaternion(q);
      _right.set(1, 0, 0).applyQuaternion(q);
      // Seeded dispersion inside a ±0.004 rad cone.
      const da = (this._rand() * 2 - 1) * def.dispersion;
      const db = (this._rand() * 2 - 1) * def.dispersion;
      const aim = forward.clone().addScaledVector(_right, da).addScaledVector(_up, db).normalize();
      const v = velocity.addScaledVector(aim, def.muzzleSpeed);

      this.ammo.GUN--;
      this._spawn({
        type,
        position: muzzle.clone(),
        velocity: v,
        ttl: def.ttl,
        damage: def.damage,
        splashRadius: def.splashRadius,
        target: null,
        targetId: null,
        drag: def.drag,
      });
      return { fired: true, type, position: muzzle.clone(), velocity: v.clone(), targetId: null };
    }

    if (type === 'AIM9') {
      const side = this._aim9Side;
      this._aim9Side = -this._aim9Side;
      const rail = _tmp.set(side * 4.95, -0.1, -0.2).applyQuaternion(q).add(origin);
      const v = velocity.addScaledVector(forward, def.launchSpeed);
      const valid = !!(lockedTarget && lockedTarget.alive !== false && lockedTarget.position);
      const targetId = valid ? (lockedTarget.id != null ? lockedTarget.id : null) : null;

      this.ammo.AIM9--;
      this._spawn({
        type,
        position: rail.clone(),
        velocity: v,
        ttl: def.ttl,
        damage: def.damage,
        splashRadius: def.splashRadius,
        target: valid ? lockedTarget : null,
        targetId,
        speed: v.length(),
        age: 0,
        burnTime: def.burnTime,
        accel: def.accel,
        maxSpeed: def.maxSpeed,
        fuseRadius: def.fuseRadius,
        drag: 0,
        side,
      });
      return { fired: true, type, position: rail.clone(), velocity: v.clone(), targetId };
    }

    // Feature 23: BFFG — centerline mega-ordnance rail, boosted off the jet.
    if (type === 'BFFG') {
      const rail = _tmp.set(0, -1.35, -3.4).applyQuaternion(q).add(origin);
      const v = velocity.clone().addScaledVector(forward, def.launchSpeed);

      this.ammo.BFFG--;
      this._spawn({
        type,
        position: rail.clone(),
        velocity: v,
        ttl: def.ttl,
        damage: def.damage,
        splashRadius: def.splashRadius,
        target: null,
        targetId: null,
        drag: def.drag,
        speed: v.length(),
        age: 0,
        burnTime: def.burnTime,
        accel: def.accel,
        maxSpeed: def.maxSpeed,
      });
      return { fired: true, type, position: rail.clone(), velocity: v.clone(), targetId: null };
    }

    // Mk-82
    const side = this._mk82Side;
    this._mk82Side = -this._mk82Side;
    const pylon = _tmp.set(side * 2.1, -0.55, 0).applyQuaternion(q).add(origin);
    // Ejection is along the aircraft's local -Y (belly), not world-down, so a
    // banked or inverted release throws the bomb away from the airframe.
    _eject.set(0, -def.ejectSpeed, 0).applyQuaternion(q);
    const v = velocity.clone().add(_eject);

    this.ammo.MK82--;
    this._spawn({
      type,
      position: pylon.clone(),
      velocity: v,
      ttl: def.ttl,
      damage: def.damage,
      splashRadius: def.splashRadius,
      target: null,
      targetId: null,
      drag: def.drag,
      side,
    });
    return { fired: true, type, position: pylon.clone(), velocity: v.clone(), targetId: null };
  }

  deployFlare(flight) {
    const def = WEAPONS.FLARE;
    if (!flight || !flight.position) return { deployed: false };
    if (this.ammo.FLARE <= 0 || this._cooldown.FLARE > 0) return { deployed: false };

    const q = flight.quaternion || _q.identity();
    const base = flight.position;
    const velocity = flight.velocity || new THREE.Vector3();
    _eject.set(0, -10, 12).applyQuaternion(q); // downward / aft ejection

    const pair = [-1.2, 1.2];
    for (const lateral of pair) {
      const pos = _tmp.set(lateral, -5, 18).applyQuaternion(q).add(base).clone();
      const v = velocity.clone().add(_eject);
      const flare = {
        position: pos,
        velocity: v,
        ttl: def.burnTime,
        age: 0,
        trailTimer: 0,
        burning: true,
        mesh: null,
        side: lateral,
      };
      if (this.scene) {
        flare.mesh = this._makeMesh('flare', pos);
      }
      this.flares.push(flare);
    }

    this.ammo.FLARE--;
    this._cooldown.FLARE = def.cooldown;
    const center = _tmp.set(0, -5, 18).applyQuaternion(q).add(base).clone();
    return { deployed: true, position: center };
  }

  // -------------------------------------------------------------- gun solution
  // Feature 12A: exact zero-dispersion gun solution. The muzzle, muzzle
  // velocity, gravity and integrator are identical to `fire()` for 'GUN', so
  // the returned impact point is where an actual round goes (dispersion aside).
  computeGunSolution(flight, world, lockedTarget = null) {
    const sol = this.gunSolution;
    sol.valid = false;
    sol.impactValid = false;
    sol.leadValid = false;
    sol.range = 0;
    sol.tof = 0;

    if (!flight || !flight.position) return sol;

    const def = WEAPONS.GUN;
    const q = flight.quaternion || _q.identity();
    const forward = _gForward.set(0, 0, -1).applyQuaternion(q);
    const muzzle = _gMuzzle.set(-0.75, 0.25, -2.5).applyQuaternion(q).add(flight.position);
    const ownVel = _gOwn.set(0, 0, 0);
    if (flight.velocity) ownVel.copy(flight.velocity);

    this._setBoresight(muzzle, forward);

    const pos = _gPos.copy(muzzle);
    const vel = _gVel.copy(ownVel).addScaledVector(forward, def.muzzleSpeed);

    const targetValid = !!(lockedTarget && lockedTarget.alive !== false && lockedTarget.position);
    // Reference range: the distance along the trajectory at which `aimPoint`
    // is reported when the round does not hit terrain first.
    let refRange = 900;
    if (targetValid) {
      refRange = clamp(muzzle.distanceTo(lockedTarget.position), 120, 2200);
    }

    const step = 0.05;
    const maxTime = def.ttl;
    let t = 0;
    let travelled = 0;
    let prevTravelled = 0;
    let captureRange = true;
    let rangeSampleValid = false;
    let rangeTof = 0;
    let impactTof = 0;
    let impactDist = 0;

    while (t < maxTime - 1e-9) {
      const h = Math.min(step, maxTime - t);
      _gPrev.copy(pos);
      prevTravelled = travelled;
      const prevGh = this._heightAt(world, _gPrev.x, _gPrev.z);
      ballisticStep(pos, vel, h, def.drag);
      travelled += _gPrev.distanceTo(pos);
      t += h;

      // Interpolated ballistic point at the reference range.
      if (captureRange && travelled >= refRange) {
        const span = travelled - prevTravelled;
        const f = span > 1e-9 ? clamp((refRange - prevTravelled) / span, 0, 1) : 0;
        _gAim.set(
          _gPrev.x + (pos.x - _gPrev.x) * f,
          _gPrev.y + (pos.y - _gPrev.y) * f,
          _gPrev.z + (pos.z - _gPrev.z) * f,
        );
        rangeTof = t - h + h * f;
        rangeSampleValid = true;
        captureRange = false;
      }

      // Exact terrain crossing with linear interpolation (matches fire()).
      const gh = this._heightAt(world, pos.x, pos.z);
      if (pos.y <= gh) {
        const dy1 = _gPrev.y - prevGh;
        const dy2 = pos.y - gh;
        const denom = dy1 - dy2;
        const f = denom > 1e-6 ? clamp(dy1 / denom, 0, 1) : 0;
        const ix = _gPrev.x + (pos.x - _gPrev.x) * f;
        const iy = _gPrev.y + (pos.y - _gPrev.y) * f;
        const iz = _gPrev.z + (pos.z - _gPrev.z) * f;
        sol.impactValid = true;
        sol.impactPoint.x = ix;
        sol.impactPoint.y = iy;
        sol.impactPoint.z = iz;
        impactTof = t - h + h * f;
        impactDist = Math.hypot(ix - muzzle.x, iy - muzzle.y, iz - muzzle.z);
        break;
      }
    }

    // aimPoint: where the nose bore should point for the current engagement.
    let aimTof = 0;
    if (sol.impactValid && (!targetValid || impactDist <= refRange)) {
      // Terrain reached first (or pure strafe): aim exactly at the impact.
      sol.aimPoint.x = sol.impactPoint.x;
      sol.aimPoint.y = sol.impactPoint.y;
      sol.aimPoint.z = sol.impactPoint.z;
      aimTof = impactTof;
    } else if (rangeSampleValid) {
      sol.aimPoint.x = _gAim.x;
      sol.aimPoint.y = _gAim.y;
      sol.aimPoint.z = _gAim.z;
      aimTof = rangeTof;
    } else {
      // Fallback: last integrated point (terrain hit before the sample).
      sol.aimPoint.x = pos.x;
      sol.aimPoint.y = pos.y;
      sol.aimPoint.z = pos.z;
      aimTof = sol.impactValid ? impactTof : t;
    }
    sol.valid = true;
    sol.range = Math.hypot(
      sol.aimPoint.x - muzzle.x,
      sol.aimPoint.y - muzzle.y,
      sol.aimPoint.z - muzzle.z,
    );
    sol.tof = aimTof;

    // ---------------------------------------------------- ballistic lead point
    if (targetValid) {
      const tp = _gTP.set(lockedTarget.position.x, lockedTarget.position.y, lockedTarget.position.z);
      const tv = _gTV.set(0, 0, 0);
      if (lockedTarget.velocity) {
        tv.set(lockedTarget.velocity.x, lockedTarget.velocity.y, lockedTarget.velocity.z);
      }

      let tof = clamp(muzzle.distanceTo(tp) / def.muzzleSpeed, 0.05, 2.8);
      for (let i = 0; i < 3; i++) {
        // Future target position, less ownship drift, plus bullet drop.
        _gPT.copy(tp).addScaledVector(tv, tof);
        _gD.copy(_gPT).sub(muzzle).addScaledVector(ownVel, -tof);
        _gD.y += 0.5 * G * tof * tof;
        tof = clamp(_gD.length() / def.muzzleSpeed, 0.05, 2.8);
      }
      // Re-evaluate at the converged time of flight so the point is exact.
      _gPT.copy(tp).addScaledVector(tv, tof);
      _gD.copy(_gPT).sub(muzzle).addScaledVector(ownVel, -tof);
      _gD.y += 0.5 * G * tof * tof;

      sol.leadPoint.x = muzzle.x + _gD.x;
      sol.leadPoint.y = muzzle.y + _gD.y;
      sol.leadPoint.z = muzzle.z + _gD.z;
      sol.leadValid = tof < 2.8 && _gD.dot(forward) > 0 && _gD.lengthSq() > 1e-6;
      if (sol.leadValid) {
        // The solution the pilot actually flies to: range/time to the lead point.
        sol.range = _gD.length();
        sol.tof = tof;
      }
    }

    return sol;
  }

  _setBoresight(muzzle, forward) {
    const b = this.boresightPoint;
    b.valid = true;
    b.x = muzzle.x + forward.x * 1200;
    b.y = muzzle.y + forward.y * 1200;
    b.z = muzzle.z + forward.z * 1200;
  }

  _updateBoresight(flight) {
    const q = flight.quaternion || _q.identity();
    _gForward.set(0, 0, -1).applyQuaternion(q);
    _gMuzzle.set(-0.75, 0.25, -2.5).applyQuaternion(q).add(flight.position);
    this._setBoresight(_gMuzzle, _gForward);
  }

  _resetAimState() {
    for (const p of [this.boresightPoint, this.ccipOrigin]) {
      p.valid = false;
      p.x = 0;
      p.y = 0;
      p.z = 0;
    }
    const sol = this.gunSolution;
    sol.valid = false;
    sol.impactValid = false;
    sol.leadValid = false;
    sol.range = 0;
    sol.tof = 0;
    for (const p of [sol.aimPoint, sol.impactPoint, sol.leadPoint]) {
      p.x = 0;
      p.y = 0;
      p.z = 0;
    }
  }

  // --------------------------------------------------------------------- CCIP
  computeCCIP(flight, world) {
    const def = WEAPONS.MK82;
    if (!flight || !flight.position) {
      this.ccip.valid = false;
      this.ccipOrigin.valid = false;
      return this.ccip;
    }

    const q = flight.quaternion || _q.identity();
    // Match the pylon of the *next* bomb so the pipper matches the release.
    const side = this._mk82Side;
    const pos = _tmp.set(side * 2.1, -0.55, 0).applyQuaternion(q).add(flight.position);
    const vel = (flight.velocity ? flight.velocity.clone() : new THREE.Vector3());
    // Identical local -Y ejection to `fire()` so the pipper predicts the bomb
    // that is actually about to leave the pylon, bank angle included.
    _eject.set(0, -def.ejectSpeed, 0).applyQuaternion(q);
    vel.add(_eject);

    // 3D origin of the bomb fall line: 1.2 s ahead along the aircraft's true
    // flight path velocity, so the HUD line starts on the trajectory rather
    // than at an arbitrary screen coordinate.
    if (flight.velocity) {
      this.ccipOrigin.valid = true;
      this.ccipOrigin.x = flight.position.x + flight.velocity.x * 1.2;
      this.ccipOrigin.y = flight.position.y + flight.velocity.y * 1.2;
      this.ccipOrigin.z = flight.position.z + flight.velocity.z * 1.2;
    } else {
      this.ccipOrigin.valid = false;
    }

    // 45 s of fall covers a level release from ~9,000 m; 0.06 s steps keep the
    // integrated line within a couple of metres of the real 0.02 s trajectory
    // and cannot ridge-hop the way the old 0.15 s step could.
    const step = 0.06;
    const maxTime = 45;
    let t = 0;
    let crossed = false;

    const prev = new THREE.Vector3();
    const hAt = (x, z) => this._heightAt(world, x, z);

    while (t < maxTime - 1e-9) {
      const hStep = Math.min(step, maxTime - t);
      prev.copy(pos);
      const prevGh = hAt(prev.x, prev.z);
      ballisticStep(pos, vel, hStep, def.drag);
      t += hStep;

      const gh = hAt(pos.x, pos.z);
      if (pos.y <= gh) {
        const dy1 = prev.y - prevGh;
        const dy2 = pos.y - gh;
        const denom = dy1 - dy2;
        const f = denom > 1e-6 ? clamp(dy1 / denom, 0, 1) : 0;
        const x = prev.x + (pos.x - prev.x) * f;
        const z = prev.z + (pos.z - prev.z) * f;
        this.ccip.valid = true;
        this.ccip.x = x;
        this.ccip.y = hAt(x, z);
        this.ccip.z = z;
        this.ccip.timeToImpact = t - hStep + hStep * f;
        crossed = true;
        break;
      }
    }

    if (!crossed) {
      this.ccip.valid = false;
      this.ccip.timeToImpact = 0;
    }
    return this.ccip;
  }

  // Feature 23: live BFFG impact solution. Mirrors `fire()`'s launch state and
  // the projectile's boosted flight (0.35 G during burn, 1.0 G after) so the
  // HUD can project a real reticle for the mega-ordnance.
  computeBFFGCCIP(flight, world) {
    const def = WEAPONS.BFFG;
    if (!flight || !flight.position) {
      this.ccip.valid = false;
      this.ccipOrigin.valid = false;
      return this.ccip;
    }

    const q = flight.quaternion || _q.identity();
    _gForward.set(0, 0, -1).applyQuaternion(q);
    const pos = _tmp.set(0, -1.35, -3.4).applyQuaternion(q).add(flight.position).clone();
    const vel = (flight.velocity ? flight.velocity.clone() : new THREE.Vector3());
    vel.addScaledVector(_gForward, def.launchSpeed);

    if (flight.velocity) {
      this.ccipOrigin.valid = true;
      this.ccipOrigin.x = flight.position.x + flight.velocity.x * 1.2;
      this.ccipOrigin.y = flight.position.y + flight.velocity.y * 1.2;
      this.ccipOrigin.z = flight.position.z + flight.velocity.z * 1.2;
    } else {
      this.ccipOrigin.valid = false;
    }

    // Same 0.02 s substep the live projectile uses, so the pipper and the
    // detonation agree to within a step.
    const step = 0.02;
    const maxTime = def.ttl;
    let age = 0;
    let crossed = false;
    const prev = new THREE.Vector3();

    while (age < maxTime - 1e-9) {
      const h = Math.min(step, maxTime - age);
      prev.copy(pos);
      const prevGh = this._heightAt(world, prev.x, prev.z);
      age += h;
      bffgStep(pos, vel, h, age, def);

      const gh = this._heightAt(world, pos.x, pos.z);
      if (pos.y <= gh) {
        const dy1 = prev.y - prevGh;
        const dy2 = pos.y - gh;
        const denom = dy1 - dy2;
        const f = denom > 1e-6 ? clamp(dy1 / denom, 0, 1) : 0;
        const x = prev.x + (pos.x - prev.x) * f;
        const z = prev.z + (pos.z - prev.z) * f;
        this.ccip.valid = true;
        this.ccip.x = x;
        this.ccip.y = this._heightAt(world, x, z);
        this.ccip.z = z;
        this.ccip.timeToImpact = age - h + h * f;
        crossed = true;
        break;
      }
    }

    if (!crossed) {
      this.ccip.valid = false;
      this.ccip.timeToImpact = 0;
    }
    return this.ccip;
  }

  // ------------------------------------------------------------------- update
  update(dt, flight, world, targets = [], lockedTarget = null) {
    const events = [];
    if (!(dt > 0)) return events;
    this._time += dt;

    for (const k of Object.keys(this._cooldown)) {
      const floor = WEAPONS[k] ? -WEAPONS[k].cooldown : 0;
      this._cooldown[k] = Math.max(floor, this._cooldown[k] - dt);
    }

    const alive = [];
    for (const p of this.projectiles) {
      let remaining = dt;
      while (remaining > 1e-6 && !p.dead) {
        const h = Math.min(0.02, remaining);
        remaining -= h;
        this._stepProjectile(p, h, world, targets, events);
      }
      if (p.dead) {
        this._disposeMesh(p.mesh);
      } else {
        if (p.mesh) {
          p.mesh.position.copy(p.position);
          this._orientMesh(p.mesh, p.velocity);
        }
        alive.push(p);
      }
    }
    this.projectiles = alive;

    this._updateFlares(dt, world, events);

    if (flight && flight.position) this._updateBoresight(flight);

    if (this.selected === 'GUN') {
      this.computeGunSolution(flight, world, lockedTarget);
    } else {
      // Stale solutions must never drive the HUD after a weapon change.
      const sol = this.gunSolution;
      sol.valid = false;
      sol.impactValid = false;
      sol.leadValid = false;
      sol.range = 0;
      sol.tof = 0;
    }

    if (this.selected === 'MK82' && flight) {
      this.computeCCIP(flight, world);
    } else if (this.selected === 'BFFG' && flight) {
      this.computeBFFGCCIP(flight, world);
    } else {
      this.ccip.valid = false;
      this.ccipOrigin.valid = false;
    }

    return events;
  }

  // --------------------------------------------------------------- internals
  _armCooldown(type) {
    const def = WEAPONS[type];
    if (type === 'GUN') {
      // Carry the sub-frame overshoot so sustained fire averages ~850 RPM
      // instead of losing a frame per round at 60 fps.
      this._cooldown.GUN = Math.min(def.cooldown, this._cooldown.GUN + def.cooldown);
    } else {
      this._cooldown[type] = def.cooldown;
    }
  }

  _spawn(p) {
    const proj = {
      id: (this._id = (this._id || 0) + 1),
      type: p.type,
      position: p.position,
      velocity: p.velocity,
      ttl: p.ttl,
      age: p.age || 0,
      damage: p.damage,
      splashRadius: p.splashRadius,
      target: p.target || null,
      targetId: p.targetId != null ? p.targetId : null,
      drag: p.drag || 0,
      speed: p.speed || 0,
      burnTime: p.burnTime || 0,
      accel: p.accel || 0,
      maxSpeed: p.maxSpeed || 0,
      fuseRadius: p.fuseRadius || 0,
      trailTimer: 0,
      dead: false,
      mesh: null,
    };
    proj.speed = proj.speed || proj.velocity.length();
    if (this.scene) proj.mesh = this._makeMesh(p.type, proj.position);
    this.projectiles.push(proj);
    return proj;
  }

  _stepProjectile(p, h, world, targets, events) {
    p.age += h;
    _prevPos.copy(p.position);

    if (p.type === 'AIM9') {
      // A rocket with no (live) target cannot guide: after the motor burns out
      // gravity bends its path down so a stray round lands instead of flying
      // dead level into infinity.
      const guided = !!(p.target && p.target.alive !== false && p.target.position);
      if (p.age <= p.burnTime) {
        p.speed = Math.min(p.maxSpeed, p.speed + p.accel * h);
      } else {
        p.speed = Math.max(250, p.speed * (1 - 0.012 * h)); // coast
      }
      this._guide(p, h);
      if (!guided && p.age > p.burnTime) p.velocity.y -= G * h;
      if (p.velocity.lengthSq() > 1e-6) p.velocity.setLength(p.speed);
      p.position.addScaledVector(p.velocity, h);

      // Proximity fuse / direct hit.
      const fuse = p.fuseRadius;
      let bestD = Infinity;
      let hitId = null;
      let hitPos = null;
      for (const t of targets) {
        if (!t || t.alive === false || !t.position) continue;
        _targetPos.set(t.position.x, t.position.y, t.position.z);
        const d = segmentDistance(_prevPos, p.position, _targetPos.x, _targetPos.y, _targetPos.z);
        if (d <= fuse && d < bestD) {
          bestD = d;
          hitId = t.id != null ? t.id : null;
          hitPos = _segP.clone();
        }
      }
      if (hitId !== null) {
        p.position.copy(hitPos || p.position);
        this._impact(p, events, hitId);
        p.dead = true;
        return;
      }
      this._trail(p, events, h, 0.05, 0xffd9a0, 0.8);
    } else if (p.type === 'BFFG') {
      // Feature 23: rocket-boosted mega-ordnance with a gentle gravity arc
      // during the burn and full gravity once the motor cuts out.
      bffgStep(p.position, p.velocity, h, p.age, WEAPONS.BFFG);
      p.speed = p.velocity.length();
      this._trail(p, events, h, 0.03, 0x66f7ff, 2.8);
    } else if (p.type === 'MK82') {
      ballisticStep(p.position, p.velocity, h, p.drag);
      // Thin condensation/smoke trail: lets the player trace the fall line all
      // the way to the CCIP impact point in external views.
      this._trail(p, events, h, 0.08, 0xd8dfe6, 0.85);
    } else {
      // GUN tracer: gravity, no meaningful drag.
      ballisticStep(p.position, p.velocity, h, 0);
    }

    if (p.type === 'GUN') {
      for (const t of targets) {
        if (!t || t.alive === false || !t.position) continue;
        _targetPos.set(t.position.x, t.position.y, t.position.z);
        const d = segmentDistance(_prevPos, p.position, _targetPos.x, _targetPos.y, _targetPos.z);
        if (d <= (t.hitRadius || 2) + 1.5) {
          p.position.copy(_segP);
          this._impact(p, events, t.id != null ? t.id : null);
          p.dead = true;
          return;
        }
      }
    }

    // Feature 23: 3D building side/roof impacts for every weapon. A projectile
    // entering a standing building detonates on the facade at the exact wall
    // point rather than tunnelling through to the ground behind it.
    if (world && world.buildings && typeof world.buildings.hitBuilding === 'function') {
      const bHit = world.buildings.hitBuilding(_prevPos, p.position);
      if (bHit) {
        p.position.set(bHit.x, bHit.y, bHit.z);
        this._impact(p, events, this._splashTargetId(p, targets), true);
        p.dead = true;
        return;
      }
    }

    // Terrain / sea impact.
    const gh = this._heightAt(world, p.position.x, p.position.z);
    if (p.position.y <= gh) {
      const prevGh = this._heightAt(world, _prevPos.x, _prevPos.z);
      const dy1 = _prevPos.y - prevGh;
      const dy2 = p.position.y - gh;
      const denom = dy1 - dy2;
      const f = denom > 1e-6 ? clamp(dy1 / denom, 0, 1) : 0;
      p.position.x = _prevPos.x + (p.position.x - _prevPos.x) * f;
      p.position.z = _prevPos.z + (p.position.z - _prevPos.z) * f;
      p.position.y = gh;
      this._impact(p, events, this._splashTargetId(p, targets));
      p.dead = true;
      return;
    }

    if (p.age >= p.ttl) p.dead = true;
  }

  _guide(p, h) {
    const target = p.target;
    if (!target || target.alive === false || !target.position) return;

    _targetPos.set(target.position.x, target.position.y, target.position.z);
    _toTarget.copy(_targetPos).sub(p.position);
    const range = _toTarget.length();
    if (range < 1e-3) return;

    _los.copy(_toTarget).divideScalar(range);
    if (target.velocity) {
      _targetVel.set(target.velocity.x, target.velocity.y, target.velocity.z);
    } else {
      _targetVel.set(0, 0, 0);
    }
    _vRel.copy(_targetVel).sub(p.velocity);

    // True proportional navigation: a = N * Vc * (Ω × u_los).
    _omega.copy(_toTarget).cross(_vRel).divideScalar(range * range);
    const closing = Math.max(0, -_vRel.dot(_los));
    _aCmd.copy(_omega).cross(_los).multiplyScalar(WEAPONS.AIM9.navConstant * closing);

    const mag = _aCmd.length();
    const limit = WEAPONS.AIM9.maxLateralAccel;
    if (mag > limit) _aCmd.multiplyScalar(limit / mag);

    p.velocity.addScaledVector(_aCmd, h);
  }

  _splashTargetId(p, targets) {
    let bestId = null;
    let best = Infinity;
    for (const t of targets) {
      if (!t || t.alive === false || !t.position) continue;
      _targetPos.set(t.position.x, t.position.y, t.position.z);
      const d = p.position.distanceTo(_targetPos);
      if (d <= p.splashRadius && d < best) {
        best = d;
        bestId = t.id != null ? t.id : null;
      }
    }
    return bestId;
  }

  _impact(p, events, hitTargetId, hitBuilding = false) {
    const ev = {
      kind: 'impact',
      weapon: p.type,
      position: { x: p.position.x, y: p.position.y, z: p.position.z },
      hitTargetId: hitTargetId != null ? hitTargetId : null,
      splashRadius: p.splashRadius,
      damage: p.damage,
    };
    if (hitBuilding === true) ev.hitBuilding = true;
    events.push(ev);
  }

  _trail(p, events, h, interval, color, size) {
    p.trailTimer -= h;
    if (p.trailTimer > 0) return;
    p.trailTimer = interval;
    events.push({
      kind: 'trail',
      position: { x: p.position.x, y: p.position.y, z: p.position.z },
      color,
      size,
    });
  }

  _updateFlares(dt, world, events) {
    const def = WEAPONS.FLARE;
    const alive = [];
    for (const f of this.flares) {
      f.ttl -= dt;
      f.age += dt;
      if (f.ttl <= 0) {
        this._disposeMesh(f.mesh);
        continue;
      }
      ballisticStep(f.position, f.velocity, dt, def.drag);
      f.trailTimer -= dt;
      if (f.burning && f.trailTimer <= 0) {
        f.trailTimer = def.trailInterval;
        events.push({
          kind: 'trail',
          position: { x: f.position.x, y: f.position.y, z: f.position.z },
          color: 0xff7a1a,
          size: 1.2,
        });
      }
      const gh = this._heightAt(world, f.position.x, f.position.z);
      if (f.position.y <= gh + 0.2) {
        f.position.y = gh;
        f.velocity.set(0, 0, 0);
        f.burning = false;
      }
      if (f.mesh) f.mesh.position.copy(f.position);
      alive.push(f);
    }
    this.flares = alive;
  }

  _heightAt(world, x, z) {
    if (world && typeof world.heightAt === 'function') {
      const h = world.heightAt(x, z);
      return Number.isFinite(h) ? h : 0;
    }
    return 0;
  }

  // ------------------------------------------------------------------ visuals
  _makeMesh(type, position) {
    // Feature 23: BFFG mega-ordnance — cyan-white plasma warhead core ringed by
    // golden-amber stabilizers, sized to read clearly from the chase cam.
    if (type === 'BFFG') {
      const group = new THREE.Group();

      // Warhead core: bright plasma sphere with a white-hot centre.
      const coreGeo = new THREE.SphereGeometry(0.95, 14, 10);
      const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0x66f7ff }));
      core.position.z = -0.6;
      const glowGeo = new THREE.SphereGeometry(0.44, 10, 8);
      const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0xf2ffff }));
      glow.position.z = -0.6;
      group.add(core, glow);

      // Golden-amber stabilizer rings, perpendicular to the flight axis (+Z).
      for (const [radius, z] of [[1.25, -1.2], [1.05, 0.1]]) {
        const ringGeo = new THREE.TorusGeometry(radius, 0.13, 6, 18);
        const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffc857 }));
        ring.position.z = z;
        group.add(ring);
      }

      // Rocket motor / nozzle section aft of the warhead.
      const bodyGeo = new THREE.CylinderGeometry(0.55, 0.72, 1.9, 12);
      bodyGeo.rotateX(Math.PI / 2);
      const body = new THREE.Mesh(bodyGeo, new THREE.MeshBasicMaterial({ color: 0xffc857 }));
      body.position.z = 1.5;
      group.add(body);

      group.position.copy(position);
      group.frustumCulled = false;
      for (const child of group.children) child.frustumCulled = false;
      this.scene.add(group);
      return group;
    }

    // Mk-82 is a two-part group (olive body + amber nose band) so the fall line
    // reads clearly from the chase cam. Its long axis lies along local +Z,
    // which is the axis `_orientMesh` aligns to the velocity vector.
    if (type === 'MK82') {
      const bodyGeo = new THREE.CapsuleGeometry(0.24, 1.72, 4, 8); // ≈ 2.2 m long
      bodyGeo.rotateX(Math.PI / 2);
      const body = new THREE.Mesh(bodyGeo, new THREE.MeshBasicMaterial({ color: 0x4a5238 }));

      const bandGeo = new THREE.CylinderGeometry(0.246, 0.246, 0.18, 10);
      bandGeo.rotateX(Math.PI / 2);
      const band = new THREE.Mesh(bandGeo, new THREE.MeshBasicMaterial({ color: 0xd9a13a }));
      band.position.z = 0.75;

      const group = new THREE.Group();
      group.add(body, band);
      group.position.copy(position);
      group.frustumCulled = false;
      for (const child of group.children) child.frustumCulled = false;
      this.scene.add(group);
      return group;
    }

    let geometry;
    let material;
    if (type === 'GUN') {
      geometry = new THREE.BoxGeometry(0.08, 0.08, 2.2);
      material = new THREE.MeshBasicMaterial({ color: 0xffc24a });
    } else if (type === 'AIM9') {
      geometry = new THREE.CylinderGeometry(0.06, 0.06, 2.9, 6);
      geometry.rotateX(Math.PI / 2);
      material = new THREE.MeshBasicMaterial({ color: 0xe6ebef });
    } else {
      geometry = new THREE.SphereGeometry(0.35, 6, 5);
      material = new THREE.MeshBasicMaterial({ color: 0xff7a1a });
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return mesh;
  }

  _orientMesh(mesh, velocity) {
    if (velocity.lengthSq() < 1e-6) return;
    _tmp.copy(velocity).normalize();
    mesh.quaternion.setFromUnitVectors(Z_AXIS, _tmp);
  }

  _disposeMesh(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    // Geometries/materials may be nested (the Mk-82 is a group).
    mesh.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mat = obj.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else if (mat) mat.dispose();
    });
  }
}