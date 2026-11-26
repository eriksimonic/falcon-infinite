// Ground targets, radar sites, SAM batteries and patrolling aggressor bandits.
//
// TargetSystem owns every hostile in the theatre: procedural meshes (when a
// scene is supplied), a terrain-aware SAM/radar acquisition state machine,
// incoming enemy missiles with flare decoying, splash damage resolution and
// the RWR contact list consumed by the tactical overlay.
//
// All randomness is seeded (mulberry32). The module is headless-safe: pass
// `null` for the scene and every mesh field stays null.

import * as THREE from 'three';
import { mulberry32 } from '../world/noise.js';

const DEG = Math.PI / 180;

// Acquisition / weapon constants.
const MASK_AGL = 45;          // below this AGL terrain masks the radar
const LOCK_RANGE = 9500;      // sustained detection inside this range locks
const LOCK_TIME = 3.5;        // seconds of sustained detection before LOCK
const RELOAD_TIME = 11;       // seconds between SAM launches
const LAUNCH_STATE_TIME = 1.8;
const SAM_SPEED = 460;        // m/s
const SAM_TTL = 18;           // seconds of flight
const SAM_TURN_RATE = 30 * DEG;
const SAM_HIT_RADIUS = 24;    // proximity fuse against the player
const FLARE_INFLUENCE = 240;  // flare must pass this close to seduce a missile
const FLARE_GUARANTEE = 140;  // guaranteed decoy when manoeuvring

const KIND_INFO = {
  RADAR: { hitRadius: 18, radarRange: 14000, hp: 150, label: 'SA-6 RADAR' },
  SAM: { hitRadius: 14, radarRange: 14000, hp: 120, label: 'SA-2 BATTERY' },
  DEPOT: { hitRadius: 26, radarRange: 0, hp: 260, label: 'FUEL DEPOT' },
  BANDIT: { hitRadius: 16, radarRange: 11000, hp: 100, label: 'MIG-29' },
};

// Shared scratch vectors — no allocations in the hot path.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _los = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _omega = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function heightAt(world, x, z) {
  return world && typeof world.heightAt === 'function' ? world.heightAt(x, z) : 0;
}

function readVec(p, out) {
  if (!p) return null;
  if (p.isVector3) return out.copy(p);
  if (typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
    return out.set(p.x, p.y, p.z);
  }
  return null;
}

function flarePosition(flare, out) {
  if (!flare) return null;
  if (flare.isVector3) return out.copy(flare);
  if (readVec(flare.position, out)) return out;
  if (readVec(flare.mesh && flare.mesh.position, out)) return out;
  return null;
}

function flightForward(flight, out) {
  if (!flight) return null;
  const f = flight.forward;
  if (f && f.isVector3 && f.lengthSq() > 1e-8) return out.copy(f).normalize();
  if (flight.quaternion && flight.quaternion.isQuaternion) {
    return out.set(0, 0, -1).applyQuaternion(flight.quaternion).normalize();
  }
  if (flight.velocity && flight.velocity.lengthSq() > 1) {
    return out.copy(flight.velocity).normalize();
  }
  return null;
}

function playerManoeuvring(flight) {
  if (!flight) return false;
  const rates = flight.rates;
  if (rates) {
    if (Math.abs(rates.z || 0) > 0.25 || Math.abs(rates.x || 0) > 0.15) return true;
  }
  const roll = flight.rollDeg;
  if (Number.isFinite(roll) && Math.abs(roll) > 20) return true;
  const controls = flight.controls;
  if (controls && (Math.abs(controls.roll || 0) > 0.2 || Math.abs(controls.pitch || 0) > 0.2)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mesh helpers
// ---------------------------------------------------------------------------

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.82,
    metalness: opts.metalness ?? 0.12,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    flatShading: !!opts.flatShading,
  });
}

function box(parent, w, h, d, x, y, z, color, opts) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function cylinder(parent, rTop, rBottom, h, seg, x, y, z, color, opts) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), mat(color, opts));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function wingGeometry(sign) {
  const s = new THREE.Shape();
  s.moveTo(0, 1.2);
  s.lineTo(sign * 7.2, -1.0);
  s.lineTo(sign * 7.2, -2.0);
  s.lineTo(0, -1.8);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.22, bevelEnabled: false, curveSegments: 2 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0.04, 0);
  return geo;
}

function buildRadar() {
  const g = new THREE.Group();
  box(g, 30, 0.8, 30, 0, 0.4, 0, 0x8b897f, { roughness: 0.95 });
  box(g, 22, 0.25, 22, 0, 0.9, 0, 0x6f6d65, { roughness: 0.95 });

  // tower legs + platform
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(g, 0.5, 7.6, 0.5, sx * 1.7, 4.7, sz * 1.7, 0x4d4f4a, { metalness: 0.35 });
    }
  }
  box(g, 4.6, 0.5, 4.6, 0, 8.4, 0, 0x5b5d56, { metalness: 0.3 });

  const dish = new THREE.Group();
  dish.position.y = 9.1;
  const dishMesh = new THREE.Mesh(
    new THREE.SphereGeometry(5.4, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.34),
    mat(0x9aa0a3, { metalness: 0.55, roughness: 0.4, side: THREE.DoubleSide }),
  );
  dishMesh.rotation.x = Math.PI * 0.5 - 0.55;
  dishMesh.position.y = 6.2;
  dish.add(dishMesh);
  cylinder(dish, 0.18, 0.18, 5.6, 8, 0, 3.0, 0, 0x6e716f, { metalness: 0.6 });
  const horn = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 10, 8),
    mat(0x2d2f2e, { metalness: 0.5, emissive: 0x1a0500, emissiveIntensity: 0.6 }),
  );
  horn.position.set(0, 6.0, 0);
  dish.add(horn);
  g.add(dish);

  const beaconMat = mat(0x330000, { emissive: 0xff2a12, emissiveIntensity: 2.2 });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), beaconMat);
  beacon.position.set(0, 8.95, 0);
  g.add(beacon);

  g.userData.dish = dish;
  g.userData.beaconMat = beaconMat;
  return g;
}

function buildSam() {
  const g = new THREE.Group();
  // tracked transporter chassis
  box(g, 10.4, 1.05, 1.05, 0, 0.55, 1.95, 0x232320, { roughness: 0.95 });
  box(g, 10.4, 1.05, 1.05, 0, 0.55, -1.95, 0x232320, { roughness: 0.95 });
  box(g, 10, 2.2, 4.2, 0, 1.55, 0, 0x4e5a33, { roughness: 0.88 });
  box(g, 3.4, 1.9, 3.8, 3.6, 2.0, 0, 0x45502d, { roughness: 0.9 });
  box(g, 1.1, 0.55, 3.2, -4.5, 2.2, 0, 0x39422a, { roughness: 0.9 });
  // headlights
  box(g, 0.15, 0.35, 0.6, 5.2, 2.2, 1.2, 0x2b2a24, { emissive: 0xffe6a0, emissiveIntensity: 0.6 });

  const turret = new THREE.Group();
  turret.position.y = 2.85;
  cylinder(turret, 1.9, 2.15, 0.45, 18, 0, 0.15, 0, 0x3d452a, { metalness: 0.25 });
  const rack = new THREE.Group();
  rack.rotation.x = -0.5;
  for (let i = -1; i <= 1; i++) {
    box(rack, 0.3, 0.3, 7.2, i * 1.45, 0.28, 0.4, 0x2f3524, { metalness: 0.4 });
    // 3-rail loaded missile
    const m = cylinder(rack, 0.27, 0.27, 6.2, 10, i * 1.45, 0.68, 0.35, 0xb9b7a8, { roughness: 0.55 });
    m.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.27, 1.1, 10), mat(0x8c8a7d, { metalness: 0.3 }));
    nose.rotation.x = Math.PI / 2;
    nose.position.set(i * 1.45, 0.68, 3.9);
    rack.add(nose);
  }
  box(rack, 4.6, 0.35, 1.4, 0, 0.05, -2.2, 0x353b28, { metalness: 0.3 });
  turret.add(rack);
  g.add(turret);

  g.userData.turret = turret;
  return g;
}

function buildDepot() {
  const g = new THREE.Group();
  // pair of horizontal storage tanks
  for (const sx of [-7, 7]) {
    const tank = cylinder(g, 3.4, 3.4, 12, 20, sx, 4.6, 0, 0x6e735c, { roughness: 0.72, metalness: 0.25 });
    tank.rotation.z = Math.PI / 2;
    const band = cylinder(g, 3.48, 3.48, 0.35, 20, sx, 4.6, 0, 0x4a4f3c, { metalness: 0.35 });
    band.rotation.z = Math.PI / 2;
    box(g, 11.5, 1.1, 2.4, sx, 0.55, 2.4, 0x4a4a42, { roughness: 0.95 });
    box(g, 11.5, 1.1, 2.4, sx, 0.55, -2.4, 0x4a4a42, { roughness: 0.95 });
  }
  // hardened bunker
  box(g, 10, 4.6, 9, 0, 2.6, -12, 0x77776a, { roughness: 0.92 });
  const roof = cylinder(g, 4.5, 4.5, 10, 16, 0, 4.8, -12, 0x67675b, { roughness: 0.92 });
  roof.rotation.z = Math.PI / 2;
  box(g, 2.6, 2.2, 0.4, 0, 1.3, -7.45, 0x232320, { roughness: 1 });
  // perimeter fence markers
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    box(g, 0.35, 1.9, 0.35, Math.cos(a) * 18, 1.0, Math.sin(a) * 18, 0x3a3b32, {
      roughness: 0.95,
      metalness: 0.2,
    });
  }
  return g;
}

function buildBandit() {
  const g = new THREE.Group();
  const body = mat(0x43484c, { roughness: 0.55, metalness: 0.45 });
  const panel = mat(0x2f3336, { roughness: 0.6, metalness: 0.4 });

  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.25, 11, 14), body);
  fuselage.rotation.x = Math.PI / 2;
  fuselage.position.z = 0.4;
  g.add(fuselage);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.05, 3.4, 14), body);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -6.9;
  g.add(nose);

  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.78, 14, 10),
    mat(0x182630, { roughness: 0.18, metalness: 0.5, emissive: 0x0b1a22, emissiveIntensity: 0.5 }),
  );
  canopy.scale.set(0.85, 0.72, 1.9);
  canopy.position.set(0, 0.72, -2.9);
  g.add(canopy);

  // swept wings, twin tails, tailplanes
  for (const sign of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeometry(sign), panel);
    wing.position.y = -0.05;
    g.add(wing);

    const stab = new THREE.Mesh(wingGeometry(sign), panel);
    stab.scale.set(0.42, 0.8, 0.5);
    stab.position.set(0, 0.05, 3.6);
    g.add(stab);

    const fin = box(g, 0.2, 3.0, 2.4, sign * 1.15, 1.55, 2.9, 0x3a3f43, {
      roughness: 0.55,
      metalness: 0.4,
    });
    fin.rotation.x = -0.22;
    fin.rotation.z = sign * 0.14;

    const intake = box(g, 0.55, 1.05, 4.2, sign * 1.15, -0.75, -1.2, 0x2c3033, {
      roughness: 0.5,
      metalness: 0.5,
    });
    intake.rotation.x = 0.02;

    const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 5.2, 12), body);
    engine.rotation.x = Math.PI / 2;
    engine.position.set(sign * 0.82, -0.1, 1.6);
    g.add(engine);
  }

  const exhaustMat = mat(0x2b1608, { emissive: 0xff6a1a, emissiveIntensity: 1.8 });
  for (const sign of [-1, 1]) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.52, 0.85, 12), exhaustMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(sign * 0.82, -0.1, 4.35);
    g.add(nozzle);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.44, 2.2, 10), exhaustMat);
    flame.rotation.x = Math.PI / 2;
    flame.position.set(sign * 0.82, -0.1, 5.7);
    g.add(flame);
  }

  g.userData.exhaustMat = exhaustMat;
  return g;
}

function buildMissileMesh() {
  const g = new THREE.Group();
  const body = cylinder(g, 0.2, 0.22, 3.6, 10, 0, 0, 0, 0xb9b7a8, { roughness: 0.6 });
  body.rotation.x = Math.PI / 2;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.9, 10), mat(0x8c8a7d, { metalness: 0.3 }));
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 2.15;
  g.add(nose);
  for (let i = 0; i < 4; i++) {
    const fin = box(g, 0.05, 0.55, 0.45, 0, 0, -1.4, 0x6f6f68, { metalness: 0.3 });
    fin.rotation.z = i * Math.PI / 2;
    g.add(fin);
  }
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 8, 6),
    mat(0x331500, { emissive: 0xff9a3c, emissiveIntensity: 2.4 }),
  );
  glow.position.z = -1.9;
  g.add(glow);
  return g;
}

function charMesh(root, kind) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of materials) {
      if (!m) continue;
      if (m.color) m.color.setHex(0x1b1a17);
      if (m.emissive) m.emissive.setHex(0x000000);
      if ('emissiveIntensity' in m) m.emissiveIntensity = 0;
      if ('roughness' in m) m.roughness = 1;
      if ('metalness' in m) m.metalness = 0.04;
      m.needsUpdate = true;
    }
  });

  if (kind === 'BANDIT') {
    root.rotation.z += 1.1;
    root.rotation.x += 0.3;
    return;
  }

  const radius = kind === 'DEPOT' ? 22 : kind === 'RADAR' ? 13 : 11;
  const crater = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 20),
    new THREE.MeshBasicMaterial({ color: 0x0b0a09, transparent: true, opacity: 0.82, side: THREE.DoubleSide }),
  );
  crater.rotation.x = -Math.PI / 2;
  crater.position.y = 0.07;
  root.add(crater);
  root.rotation.y += 0.22;
}

function disposeObject(root) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry) o.geometry.dispose();
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of materials) {
      if (!m) continue;
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
  if (root.parent) root.parent.remove(root);
}

// ---------------------------------------------------------------------------
// TargetSystem
// ---------------------------------------------------------------------------

export class TargetSystem {
  constructor(scene = null) {
    this.scene = scene;
    this.targets = [];
    this.enemyMissiles = [];
    this.group = new THREE.Group();
    this.group.name = 'combat-targets';
    if (scene) scene.add(this.group);

    this._time = 0;
    this._missileSeq = 0;
  }

  /** Remove every target and missile, disposing their meshes. */
  clear() {
    for (const t of this.targets) disposeObject(t.mesh);
    for (const m of this.enemyMissiles) disposeObject(m.mesh);
    this.targets.length = 0;
    this.enemyMissiles.length = 0;
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    this._time = 0;
    this._missileSeq = 0;
  }

  /**
   * Spawn a deterministic target package.
   * @param {Array<{id?:string, kind:string, label?:string, x:number, z:number,
   *                alt?:number, orbitRadius?:number, speed?:number, heading?:number}>} specs
   * @param {{heightAt:(x:number,z:number)=>number}} world
   */
  spawnScenario(specs = [], world) {
    this.clear();
    const list = Array.isArray(specs) ? specs : [];

    for (let i = 0; i < list.length; i++) {
      const spec = list[i] || {};
      const kind = String(spec.kind || 'SAM').toUpperCase();
      const info = KIND_INFO[kind] || KIND_INFO.SAM;
      const id = spec.id || `${kind.toLowerCase()}-${i}`;
      const x = Number.isFinite(spec.x) ? spec.x : 0;
      const z = Number.isFinite(spec.z) ? spec.z : 0;
      const airborne = kind === 'BANDIT';
      const rng = mulberry32(hashString(id) ^ (i * 0x9e3779b1));

      const target = {
        id,
        kind,
        label: spec.label || info.label,
        airborne,
        position: new THREE.Vector3(x, 0, z),
        velocity: new THREE.Vector3(),
        heading: 0,
        hp: info.hp,
        maxHp: info.hp,
        alive: true,
        hitRadius: info.hitRadius,
        radarActive: false,
        radarRange: info.radarRange,
        lockState: 'IDLE',
        mesh: null,

        // internals (prefixed so the public shape stays clean)
        _rng: rng,
        _detect: 0,
        _cooldown: 0,
        _stateTimer: 0,
        _bank: 0,
        _phase: rng() * Math.PI * 2,
        _dish: null,
        _beaconMat: null,
        _turret: null,
        _exhaustMat: null,
      };

      if (airborne) {
        const orbitRadius = Number.isFinite(spec.orbitRadius) && spec.orbitRadius > 200
          ? spec.orbitRadius
          : 3200;
        const speed = Number.isFinite(spec.speed) && spec.speed > 20 ? spec.speed : 230;
        const px = x + Math.cos(target._phase) * orbitRadius;
        const pz = z + Math.sin(target._phase) * orbitRadius;
        const floor = heightAt(world, px, pz) + 350;
        const alt = Number.isFinite(spec.alt) ? spec.alt : floor + 1150;
        target.position.set(px, Math.max(alt, floor), pz);
        target._anchor = new THREE.Vector3(x, target.position.y, z);
        target._orbitRadius = orbitRadius;
        target._speed = speed;
        target.velocity.set(
          -Math.sin(target._phase) * speed,
          0,
          Math.cos(target._phase) * speed,
        );
        target.heading = Math.atan2(target.velocity.x, -target.velocity.z);
      } else {
        const y = heightAt(world, x, z);
        target.position.set(x, y, z);
        target.heading = Number.isFinite(spec.heading) ? spec.heading * DEG : 0;
      }

      if (this.scene) {
        const mesh = kind === 'RADAR' ? buildRadar()
          : kind === 'SAM' ? buildSam()
            : kind === 'DEPOT' ? buildDepot()
              : buildBandit();
        mesh.position.copy(target.position);
        mesh.rotation.y = -target.heading;
        mesh.name = `target-${id}`;
        this.group.add(mesh);
        target.mesh = mesh;
        target._dish = mesh.userData.dish || null;
        target._beaconMat = mesh.userData.beaconMat || null;
        target._turret = mesh.userData.turret || null;
        target._exhaustMat = mesh.userData.exhaustMat || null;
      }

      this.targets.push(target);
    }

    return this.targets;
  }

  /**
   * Resolve direct + splash damage from a weapon impact.
   * @param {{position:any, damage?:number, splashRadius?:number, hitTargetId?:string|null}} impactEvent
   * @returns {Array<{id:string, kind:string, label:string, position:THREE.Vector3}>}
   */
  applyImpact(impactEvent) {
    const destroyed = [];
    if (!impactEvent) return destroyed;
    if (!readVec(impactEvent.position, _a)) return destroyed;

    const splash = Number.isFinite(impactEvent.splashRadius) ? Math.max(0, impactEvent.splashRadius) : 0;
    const damage = Number.isFinite(impactEvent.damage) ? Math.max(0, impactEvent.damage) : 0;
    if (damage <= 0) return destroyed;

    for (const t of this.targets) {
      if (!t.alive) continue;

      const d = t.position.distanceTo(_a);
      let factor = 0;
      if (impactEvent.hitTargetId && impactEvent.hitTargetId === t.id) {
        factor = 1;
      } else if (d <= t.hitRadius) {
        factor = 1;
      } else if (splash > 0 && d <= t.hitRadius + splash) {
        factor = 1 - (d - t.hitRadius) / splash;
      }
      if (factor <= 0) continue;

      t.hp -= damage * factor;
      if (t.hp > 0) continue;

      t.hp = 0;
      t.alive = false;
      t.radarActive = false;
      t.lockState = 'IDLE';
      t.velocity.set(0, 0, 0);
      if (t.mesh) charMesh(t.mesh, t.kind);
      destroyed.push({
        id: t.id,
        kind: t.kind,
        label: t.label,
        position: t.position.clone(),
      });
    }

    return destroyed;
  }

  /**
   * Find the best target inside the current weapon's forward seeker cone.
   * AIM-9 prioritises airborne heat sources, with a short-range ground mode.
   */
  findLockTarget(flight, weaponType) {
    if (!flight || !flight.position) return null;
    const forward = flightForward(flight, _a);
    if (!forward) return null;

    const isAim9 = weaponType === 'AIM9';
    const maxAngleAir = 24 * DEG;
    const maxAngleGround = isAim9 ? 15 * DEG : 22 * DEG;
    const maxRangeAir = isAim9 ? 14000 : 16000;
    const maxRangeGround = isAim9 ? 6000 : 16000;

    let bestAir = null;
    let bestAirScore = Infinity;
    let bestGround = null;
    let bestGroundScore = Infinity;

    for (const t of this.targets) {
      if (!t.alive) continue;
      _b.subVectors(t.position, flight.position);
      const dist = _b.length();
      if (dist < 1e-3) continue;
      _b.divideScalar(dist);
      const angle = Math.acos(clamp(forward.dot(_b), -1, 1));

      if (t.airborne) {
        if (!isAim9) {
          if (dist <= maxRangeAir && angle <= maxAngleGround) {
            if (dist < bestGroundScore) {
              bestGroundScore = dist;
              bestGround = t;
            }
          }
          continue;
        }
        if (dist <= maxRangeAir && angle <= maxAngleAir) {
          const score = (angle / maxAngleAir) * 2 + (dist / maxRangeAir) * 0.5;
          if (score < bestAirScore) {
            bestAirScore = score;
            bestAir = t;
          }
        }
      } else if (dist <= maxRangeGround && angle <= maxAngleGround) {
        // AIM-9 ground mode favours boresight; GUN/MK-82 designate by range.
        const score = isAim9
          ? (angle / maxAngleGround) * 2 + (dist / maxRangeGround) * 0.5
          : dist;
        if (score < bestGroundScore) {
          bestGroundScore = score;
          bestGround = t;
        }
      }
    }

    if (isAim9) return bestAir || bestGround;
    return bestGround;
  }

  /**
   * Advance bandit patrols, radar/SAM acquisition, enemy missiles and RWR.
   * @returns {{events:Array, rwrContacts:Array}}
   */
  update(dt, flight, world, flares = []) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    this._time += dt;

    const events = [];
    const playerAlive = !!(flight && flight.position && !flight.crashed);

    for (const t of this.targets) {
      if (!t.alive) continue;
      if (t.airborne) {
        this._updateBandit(t, dt, flight, world, playerAlive);
      } else if (t.kind === 'RADAR' || t.kind === 'SAM') {
        this._updateSite(t, dt, flight, world, playerAlive);
      }
    }

    this._updateMissiles(dt, flight, world, Array.isArray(flares) ? flares : [], events, playerAlive);

    return { events, rwrContacts: this._rwrContacts(flight) };
  }

  // -------------------------------------------------------------------------
  // Bandit patrol
  // -------------------------------------------------------------------------

  _updateBandit(t, dt, flight, world, playerAlive) {
    const radius = t._orbitRadius;
    const speed = t._speed;
    const omega = speed / radius;
    t._phase += omega * dt;

    const cos = Math.cos(t._phase);
    const sin = Math.sin(t._phase);
    const x = t._anchor.x + cos * radius;
    const z = t._anchor.z + sin * radius;
    const gh = heightAt(world, x, z);
    const floor = gh + 350;
    if (t._anchor.y < floor) t._anchor.y = floor;

    t.position.set(x, t._anchor.y, z);
    t.velocity.set(-sin * speed, 0, cos * speed);
    t.heading = Math.atan2(t.velocity.x, -t.velocity.z);

    // Bank into the turn; exaggerate slightly for readability.
    const bankMag = clamp(0.35 * Math.atan((speed * speed) / (radius * 9.81)), 0.06, 0.55);
    const inwardX = t._anchor.x - x;
    const inwardZ = t._anchor.z - z;
    const turnSign = Math.sign(t.velocity.x * inwardZ - t.velocity.z * inwardX) || 1;
    const bankTarget = bankMag * turnSign;
    t._bank += (bankTarget - t._bank) * Math.min(1, dt * 2.5);

    if (t.mesh) {
      t.mesh.position.copy(t.position);
      t.mesh.rotation.set(0, -t.heading, 0);
      t.mesh.rotateZ(t._bank);
      if (t._exhaustMat) {
        t._exhaustMat.emissiveIntensity = 1.6 + Math.sin(this._time * 37 + t._phase) * 0.4;
      }
    }

    if (playerAlive) {
      const dist = t.position.distanceTo(flight.position);
      t.radarActive = dist <= t.radarRange;
      t.lockState = t.radarActive ? (dist <= 7000 ? 'LOCK' : 'SEARCH') : 'IDLE';
    } else {
      t.radarActive = false;
      t.lockState = 'IDLE';
    }
  }

  // -------------------------------------------------------------------------
  // SAM / radar acquisition
  // -------------------------------------------------------------------------

  _updateSite(t, dt, flight, world, playerAlive) {
    if (t._cooldown > 0) t._cooldown -= dt;
    if (t._stateTimer > 0) t._stateTimer -= dt;

    if (t._dish) t._dish.rotation.y += dt * (t.lockState === 'LOCK' ? 2.4 : 0.9);
    if (t._beaconMat) {
      t._beaconMat.emissiveIntensity = 1.6 + Math.sin(this._time * 3.2 + t._phase) * 0.7;
    }

    let detected = false;
    let dist = Infinity;
    let agl = 0;

    if (playerAlive) {
      dist = t.position.distanceTo(flight.position);
      const ground = heightAt(world, flight.position.x, flight.position.z);
      agl = flight.position.y - ground;
      detected = dist <= t.radarRange
        && agl >= MASK_AGL
        && this._lineOfSight(world, t.position, flight.position);
    }

    if (!detected) {
      t._detect = 0;
      t.lockState = 'IDLE';
      t.radarActive = false;
      this._aimTurret(t, dt, null);
      return;
    }

    t.radarActive = true;

    if (dist <= LOCK_RANGE) {
      t._detect += dt;
    } else {
      t._detect = Math.max(0, t._detect - dt * 1.5);
    }

    if (t.lockState === 'LAUNCH') {
      if (t._stateTimer <= 0) {
        t.lockState = t._detect >= LOCK_TIME ? 'LOCK' : 'SEARCH';
      }
    } else if (t.lockState === 'LOCK') {
      if (dist > LOCK_RANGE * 1.2) {
        t.lockState = 'SEARCH';
        t._detect = 0;
      }
    } else {
      t.lockState = t._detect >= LOCK_TIME ? 'LOCK' : 'SEARCH';
    }

    if (t.kind === 'SAM' && t.lockState === 'LOCK' && t._cooldown <= 0) {
      this._launchSam(t, flight);
      t.lockState = 'LAUNCH';
      t._stateTimer = LAUNCH_STATE_TIME;
      t._cooldown = RELOAD_TIME;
    }

    const tracking = t.lockState === 'LOCK' || t.lockState === 'LAUNCH';
    this._aimTurret(t, dt, tracking ? flight : null);
  }

  _aimTurret(t, dt, flight) {
    if (!t._turret) return;
    if (flight) {
      const desired = Math.atan2(
        flight.position.x - t.position.x,
        -(flight.position.z - t.position.z),
      ) + Math.PI;
      let delta = wrapAngle(desired - t._turret.rotation.y);
      t._turret.rotation.y += delta * Math.min(1, dt * 3);
    } else {
      t._turret.rotation.y += dt * 0.35;
    }
  }

  _lineOfSight(world, from, to) {
    if (!world || typeof world.heightAt !== 'function') return true;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const dy = to.y - from.y;
    for (let i = 1; i < 8; i++) {
      const f = i / 8;
      const y = from.y + 4 + dy * f;
      if (y < world.heightAt(from.x + dx * f, from.z + dz * f) + 2) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Enemy missiles
  // -------------------------------------------------------------------------

  _launchSam(t, flight) {
    const pos = new THREE.Vector3(t.position.x, t.position.y + 3.6, t.position.z);
    const aim = flight.position.clone();
    if (flight.velocity) {
      const lead = Math.min(2.5, pos.distanceTo(aim) / SAM_SPEED);
      aim.addScaledVector(flight.velocity, lead);
    }
    const dir = aim.sub(pos);
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize().multiplyScalar(SAM_SPEED);

    const id = `sam-${t.id}-${++this._missileSeq}`;
    const missile = {
      id,
      position: pos,
      velocity: dir,
      ttl: SAM_TTL,
      decoyed: false,
      sourceId: t.id,
      mesh: null,

      _speed: SAM_SPEED,
      _maxTurn: SAM_TURN_RATE,
      _rng: mulberry32(hashString(id) ^ 0x51ed270b),
      _decoyPos: null,
      _lastRange: null,
    };

    if (this.scene) {
      missile.mesh = buildMissileMesh();
      missile.mesh.position.copy(pos);
      missile.mesh.name = `missile-${id}`;
      this.group.add(missile.mesh);
    }

    this.enemyMissiles.push(missile);
    return missile;
  }

  _updateMissiles(dt, flight, world, flares, events, playerAlive) {
    const playerPos = playerAlive ? flight.position : null;

    for (let i = this.enemyMissiles.length - 1; i >= 0; i--) {
      const m = this.enemyMissiles[i];
      m.ttl -= dt;
      if (m.ttl <= 0) {
        this._removeMissile(i);
        continue;
      }

      if (playerPos) {
        const range = m.position.distanceTo(playerPos);
        if (m._lastRange === null) m._lastRange = range;
        const closing = m._lastRange > range || m.velocity.dot(_a.subVectors(playerPos, m.position)) > 0;

        if (!m.decoyed && closing && flares.length) {
          let bestFlare = null;
          let bestDist = Infinity;
          for (const flare of flares) {
            const fp = flarePosition(flare, _b);
            if (!fp) continue;
            const d = m.position.distanceTo(fp);
            if (d < bestDist) {
              bestDist = d;
              bestFlare = _c.copy(fp);
            }
          }
          if (bestFlare && bestDist <= FLARE_INFLUENCE) {
            const manoeuvring = playerManoeuvring(flight);
            let chance;
            if (bestDist <= FLARE_GUARANTEE) chance = manoeuvring ? 1 : 0.85;
            else chance = 0.55 * (1 - (bestDist - FLARE_GUARANTEE) / (FLARE_INFLUENCE - FLARE_GUARANTEE));
            if (m._rng() < chance) {
              m.decoyed = true;
              m._decoyPos = bestFlare.clone();
              // It veers off after the flare and burns out harmlessly.
              m.ttl = Math.min(m.ttl, 2.5);
            }
          }
        }
        m._lastRange = range;
      }

      // Guidance target: the player, or the flare the missile was seduced by.
      const aimPos = m.decoyed ? m._decoyPos : playerPos;
      if (aimPos) {
        if (m.decoyed && m.position.distanceTo(aimPos) < 70) {
          m.ttl = Math.min(m.ttl, 0.15);
        }
        this._guideMissile(m, aimPos, m.decoyed ? null : flight.velocity, dt);
      }

      m.position.addScaledVector(m.velocity, dt);

      if (!m.decoyed && playerPos && m.position.distanceTo(playerPos) < SAM_HIT_RADIUS) {
        events.push({
          kind: 'playerHit',
          sourceId: m.sourceId,
          position: playerPos.clone(),
        });
        this._removeMissile(i);
        continue;
      }

      if (m.mesh) {
        m.mesh.position.copy(m.position);
        _dir.copy(m.position).add(m.velocity);
        m.mesh.lookAt(_dir);
      }
    }
  }

  /** Turn-limited proportional navigation at constant speed. */
  _guideMissile(m, targetPos, targetVel, dt) {
    _los.subVectors(targetPos, m.position);
    const range = _los.length();
    if (range < 1e-4) return;

    _accel.set(0, 0, 0);
    if (targetVel) {
      _rel.subVectors(targetVel, m.velocity);
      const vc = -_los.dot(_rel) / range;
      if (vc > 0) {
        _omega.crossVectors(_los, _rel).divideScalar(Math.max(1, range * range));
        _dir.copy(_los).divideScalar(range);
        _accel.crossVectors(_omega, _dir).multiplyScalar(3.2 * vc);
      }
    }

    _desired.copy(m.velocity).addScaledVector(_accel, dt);
    if (_desired.lengthSq() < 1e-8) return;

    const angle = m.velocity.angleTo(_desired);
    const maxTurn = m._maxTurn * dt;
    if (angle > maxTurn && angle > 1e-6) {
      _q.setFromUnitVectors(_dir.copy(m.velocity).normalize(), _desired.normalize());
      _qp.identity().slerp(_q, maxTurn / angle);
      m.velocity.applyQuaternion(_qp);
    } else {
      m.velocity.copy(_desired);
    }
    m.velocity.normalize().multiplyScalar(m._speed);
  }

  _removeMissile(index) {
    const m = this.enemyMissiles[index];
    if (m) disposeObject(m.mesh);
    this.enemyMissiles.splice(index, 1);
  }

  // -------------------------------------------------------------------------
  // RWR
  // -------------------------------------------------------------------------

  _rwrContacts(flight) {
    const contacts = [];
    if (!flight || !flight.position) return contacts;

    const forward = flightForward(flight, _a);
    const heading = forward ? Math.atan2(forward.x, -forward.z) : 0;

    const push = (id, kind, pos, state, isMissile) => {
      const dx = pos.x - flight.position.x;
      const dz = pos.z - flight.position.z;
      const dy = pos.y - flight.position.y;
      const absBearing = Math.atan2(dx, -dz);
      contacts.push({
        id,
        kind,
        bearingRad: wrapAngle(absBearing - heading),
        distance: Math.hypot(dx, dy, dz),
        state,
        isMissile,
      });
    };

    for (const t of this.targets) {
      if (!t.alive || !t.radarActive) continue;
      const state = t.lockState === 'LAUNCH' ? 'LAUNCH'
        : t.lockState === 'LOCK' ? 'LOCK'
          : 'SEARCH';
      push(t.id, t.kind, t.position, state, false);
    }

    for (const m of this.enemyMissiles) {
      const source = this.targets.find((t) => t.id === m.sourceId);
      push(m.id, source ? source.kind : 'SAM', m.position, 'LAUNCH', true);
    }

    return contacts;
  }
}