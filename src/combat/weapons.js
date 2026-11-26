// Weapons, ballistics, CCIP dive-bombing solution and countermeasure flares.
//
// Headless safe: `scene` may be null (unit tests / dedicated servers), in which
// case no Three.js objects are created or added. Simulation state lives in
// plain THREE.Vector3 maths so the same code runs with or without a renderer.
import * as THREE from 'three';
import { mulberry32 } from '../world/noise.js';

export const WEAPON_TYPES = ['GUN', 'AIM9', 'MK82'];

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
    damage: 100,
    splashRadius: 24,
    ttl: 14,
  },
  MK82: {
    name: 'Mk-82 500lb',
    cooldown: 0.45,
    ejectSpeed: 2.5, // m/s downward ejection
    drag: 1e-4, // low aerodynamic drag coefficient (per m/s)
    damage: 140,
    splashRadius: 55,
    ttl: 90,
  },
  FLARE: {
    name: 'M206 flare',
    cooldown: 0.25,
    burnTime: 4.5,
    drag: 0.004,
    trailInterval: 0.1,
  },
};

export const DEFAULT_AMMO = { GUN: 510, AIM9: 4, MK82: 6, FLARE: 30 };

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

    this._cooldown = { GUN: 0, AIM9: 0, MK82: 0, FLARE: 0 };
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

    // Mk-82
    const side = this._mk82Side;
    this._mk82Side = -this._mk82Side;
    const pylon = _tmp.set(side * 2.1, -0.55, 0).applyQuaternion(q).add(origin);
    const v = velocity.clone();
    v.y -= def.ejectSpeed;

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

  // --------------------------------------------------------------------- CCIP
  computeCCIP(flight, world) {
    const def = WEAPONS.MK82;
    if (!flight || !flight.position) {
      this.ccip.valid = false;
      return this.ccip;
    }

    const q = flight.quaternion || _q.identity();
    // Match the pylon of the *next* bomb so the pipper matches the release.
    const side = this._mk82Side;
    const pos = _tmp.set(side * 2.1, -0.55, 0).applyQuaternion(q).add(flight.position);
    const vel = (flight.velocity ? flight.velocity.clone() : new THREE.Vector3());
    vel.y -= def.ejectSpeed;

    const step = 0.15;
    const maxTime = 18;
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

  // ------------------------------------------------------------------- update
  update(dt, flight, world, targets = []) {
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

    if (this.selected === 'MK82' && flight) {
      this.computeCCIP(flight, world);
    } else {
      this.ccip.valid = false;
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
      if (p.age <= p.burnTime) {
        p.speed = Math.min(p.maxSpeed, p.speed + p.accel * h);
      } else {
        p.speed = Math.max(250, p.speed * (1 - 0.012 * h)); // coast
      }
      this._guide(p, h);
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
    } else if (p.type === 'MK82') {
      ballisticStep(p.position, p.velocity, h, p.drag);
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

  _impact(p, events, hitTargetId) {
    events.push({
      kind: 'impact',
      weapon: p.type,
      position: { x: p.position.x, y: p.position.y, z: p.position.z },
      hitTargetId: hitTargetId != null ? hitTargetId : null,
      splashRadius: p.splashRadius,
      damage: p.damage,
    });
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
    let geometry;
    let material;
    if (type === 'GUN') {
      geometry = new THREE.BoxGeometry(0.08, 0.08, 2.2);
      material = new THREE.MeshBasicMaterial({ color: 0xffc24a });
    } else if (type === 'AIM9') {
      geometry = new THREE.CylinderGeometry(0.06, 0.06, 2.9, 6);
      geometry.rotateX(Math.PI / 2);
      material = new THREE.MeshBasicMaterial({ color: 0xe6ebef });
    } else if (type === 'MK82') {
      geometry = new THREE.CapsuleGeometry(0.22, 1.7, 4, 8);
      material = new THREE.MeshBasicMaterial({ color: 0x53603f });
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
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) mesh.material.dispose();
  }
}