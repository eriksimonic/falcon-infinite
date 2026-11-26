// Fuel management and a KC-135 Stratotanker for aerial refuelling.
//
// FuelSystem models internal F-16C fuel: idle / military / afterburner flow,
// a light altitude-density derate, gravity refuelling while parked on a
// runway, and hose-and-drogue style transfer when the player holds the boom
// contact box. Burn rates are tuned for gameplay: a full 7000 lb load gives
// roughly 12 minutes of dry cruise or 3.5 minutes of continuous afterburner.
//
// TankerSystem flies a deterministic, banked circular orbit around a patrol
// anchor ahead of the spawn point. It owns its own procedural KC-135 mesh
// (only when a scene is supplied) and reports the boom contact envelope.
//
// The module is headless-safe: pass `null` for the scene and every mesh field
// stays null. No DOM access and no Math.random anywhere.
//
// World conventions (ARCHITECTURE.md):
//   1 unit = 1 metre, Y up, sea level y = 0.
//   North = -Z, East = +X. headingDeg = atan2(dx, -dz) clockwise from north.
//   Aircraft local axes: nose -Z, up +Y, right +X.

import * as THREE from 'three';

export const MAX_FUEL_LB = 7000;
export const BINGO_LB = 1500;

// Fuel flow, lb/s.
export const IDLE_BURN_LB_S = 0.6;
export const MIL_BURN_LB_S = 6.8;
export const AB_BURN_LB_S = 28.0;
export const GROUND_REFUEL_LB_S = 420;
export const AIR_REFUEL_LB_S = 360;

// Tanker orbit / boom envelope constants.
export const TANKER_ORBIT_RADIUS = 7500;
export const TANKER_ORBIT_ALTITUDE = 3000;
export const TANKER_SPEED = 165;

const AB_START = 0.89; // flight.js treats throttle > 0.89 as afterburner
const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Boom contact box, relative to the tanker body.
const CONTACT_AFT_MIN = 12;
const CONTACT_AFT_MAX = 34;
const CONTACT_BELOW_MIN = 2;
const CONTACT_BELOW_MAX = 12;
const CONTACT_LATERAL_MAX = 10;
const CONTACT_CLOSURE_MAX = 22; // m/s relative speed

// Wider "almost there" envelope used for director-light guidance in the HUD.
const PRECONTACT_AFT_MIN = 6;
const PRECONTACT_AFT_MAX = 46;
const PRECONTACT_BELOW_MIN = 1;
const PRECONTACT_BELOW_MAX = 20;
const PRECONTACT_LATERAL_MAX = 22;
const PRECONTACT_CLOSURE_MAX = 45;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function norm360(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** ISA density ratio sigma, clamped so the model stays sane up high. */
function densityRatio(altM) {
  const h = clamp(altM, 0, 20000);
  return clamp(Math.pow(1 - 2.25577e-5 * h, 4.2559), 0.05, 1);
}

/** Fuel flow follows density only weakly — a slight altitude derate. */
function flowFactor(altM) {
  return 0.72 + 0.28 * densityRatio(altM);
}

// ---------------------------------------------------------------------------
// FuelSystem
// ---------------------------------------------------------------------------

export class FuelSystem {
  constructor() {
    // Mirrored as both instance and static constants for callers that prefer
    // either `fuel.MAX_FUEL_LB` or `FuelSystem.MAX_FUEL_LB`.
    this.MAX_FUEL_LB = MAX_FUEL_LB;
    this.BINGO_LB = BINGO_LB;
    this.fuelLb = MAX_FUEL_LB;
    this.fraction = 1.0;
    this.burnRateLbSec = 0;
    this.bingo = false;
    this.empty = false;
    this.refueling = false;
    this.reset();
  }

  static get MAX_FUEL_LB() {
    return MAX_FUEL_LB;
  }

  static get BINGO_LB() {
    return BINGO_LB;
  }

  /** Reset to a known fuel load (default full internal fuel). */
  reset(fuelLb = MAX_FUEL_LB) {
    const load = Number.isFinite(fuelLb) ? clamp(fuelLb, 0, MAX_FUEL_LB) : MAX_FUEL_LB;
    this.fuelLb = load;
    this.fraction = load / MAX_FUEL_LB;
    this.burnRateLbSec = 0;
    this.bingo = load <= BINGO_LB;
    this.empty = load <= 0.1;
    this.refueling = false;
  }

  /**
   * Advance fuel state.
   * @param {number} dt seconds
   * @param {object|null} flight FlightModel-like object (throttle, speed,
   *   onGround, position). Missing fields default to a level, idle aircraft.
   * @param {boolean} tankerContact true while inside the tanker boom box.
   */
  update(dt, flight, tankerContact = false) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const f = flight || {};

    const throttle = clamp(Number.isFinite(f.throttle) ? f.throttle : 0, 0, 1);
    let alt = 0;
    if (f.position && Number.isFinite(f.position.y)) alt = f.position.y;
    else if (Number.isFinite(f.altitude)) alt = f.altitude;

    // Piecewise flow: idle -> military at the AB gate -> full afterburner.
    let flow;
    if (throttle <= AB_START) {
      flow = IDLE_BURN_LB_S + (MIL_BURN_LB_S - IDLE_BURN_LB_S) * (throttle / AB_START);
    } else {
      flow = MIL_BURN_LB_S + (AB_BURN_LB_S - MIL_BURN_LB_S) * ((throttle - AB_START) / (1 - AB_START));
    }
    flow *= flowFactor(alt);

    let fuel = this.fuelLb - flow * step;

    // Gravity refuel: chocks / stopped on a runway with the engine at idle.
    const speed = Number.isFinite(f.speed) ? f.speed : 0;
    const groundRefuel = f.onGround === true && speed < 3 && throttle < 0.05;
    if (groundRefuel) fuel += GROUND_REFUEL_LB_S * step;

    // Aerial refuel from the tanker boom.
    const refueling = tankerContact === true;
    if (refueling) fuel += AIR_REFUEL_LB_S * step;

    fuel = clamp(fuel, 0, MAX_FUEL_LB);

    const wasBingo = this.bingo;
    this.fuelLb = fuel;
    this.fraction = fuel / MAX_FUEL_LB;
    this.burnRateLbSec = fuel <= 0 ? 0 : flow;
    this.bingo = fuel <= BINGO_LB;
    this.empty = fuel <= 0.1;
    this.refueling = refueling;

    return {
      fuelLb: this.fuelLb,
      maxFuelLb: MAX_FUEL_LB,
      fraction: this.fraction,
      burnRateLbSec: this.burnRateLbSec,
      bingo: this.bingo,
      bingoTriggered: this.bingo && !wasBingo,
      empty: this.empty,
      refueling: this.refueling,
    };
  }
}

// ---------------------------------------------------------------------------
// Procedural KC-135 mesh helpers
// ---------------------------------------------------------------------------

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.78,
    metalness: opts.metalness ?? 0.18,
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

/** Cylinder spanning a -> b (used for the refuelling boom). */
function tube(parent, a, b, rA, rB, color, opts) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-6) return null;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rB, rA, len, 12), mat(color, opts));
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  parent.add(m);
  return m;
}

/** Tapered, swept wing planform lying in the XZ plane (nose = -Z). */
function wingGeometry(sign) {
  const s = new THREE.Shape();
  s.moveTo(0, 3.4); // root leading edge
  s.lineTo(sign * 19.0, -1.2); // tip leading edge (swept aft)
  s.lineTo(sign * 19.0, -3.9); // tip trailing edge
  s.lineTo(0, -4.6); // root trailing edge
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.5, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -0.25, 0); // centre the extrusion thickness on y = 0
  return geo;
}

// Shared scratch vectors — no allocations in the hot path.
const _player = new THREE.Vector3();
const _playerVel = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _delta = new THREE.Vector3();

function readVec(v, out) {
  if (!v) return false;
  if (v.isVector3) {
    out.copy(v);
    return true;
  }
  if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
    out.set(v.x, v.y, v.z);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// TankerSystem
// ---------------------------------------------------------------------------

export class TankerSystem {
  constructor(scene = null) {
    this.scene = scene || null;
    this.radius = TANKER_ORBIT_RADIUS;
    this.orbitAltitude = TANKER_ORBIT_ALTITUDE;
    this.speed = TANKER_SPEED;

    this.anchor = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.angle = 0;
    this.contact = false;
    this.preContact = false;

    this.group = null;
    this.mesh = null;
    this._lights = null;
    this._time = 0;
    this._bank = 0;
    this._omega = this.speed / this.radius;

    this._buildMesh();
    this.reset(null);
  }

  /** Dispose any tanker meshes and detach from the scene. */
  dispose() {
    if (!this.group) return;
    this.group.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry) o.geometry.dispose();
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of materials) if (m) m.dispose();
    });
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group = null;
    this.mesh = null;
    this._lights = null;
  }

  /**
   * Anchor the patrol orbit ahead of a spawn point and park the tanker on the
   * near side of the circle (about 2.3 km from the spawn at 3000 m).
   * @param {{x:number, y?:number, z:number, heading?:number}|null} spawn
   */
  reset(spawn) {
    const s = spawn || {};
    const sx = Number.isFinite(s.x) ? s.x : 0;
    const sz = Number.isFinite(s.z) ? s.z : 0;
    const heading = Number.isFinite(s.heading) ? s.heading : 0;

    // ~5 km ahead of the spawn with a lateral offset — inside the F-16's
    // comfortable join-up range after takeoff.
    const h = heading * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const rx = Math.cos(h);
    const rz = Math.sin(h);
    this.anchor.set(
      sx + fx * 5000 + rx * 1400,
      this.orbitAltitude,
      sz + fz * 5000 + rz * 1400,
    );

    // Start on the orbit point nearest the spawn (deterministic, no RNG).
    this.angle = Math.atan2(sz - this.anchor.z, sx - this.anchor.x);
    this._omega = this.speed / this.radius;
    this._time = 0;
    this.contact = false;
    this.preContact = false;
    this._advance(0);
  }

  /**
   * Advance the orbit and evaluate the boom contact box.
   * @param {number} dt seconds
   * @param {object|null} flight player FlightModel-like object
   */
  update(dt, flight) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this._time += step;
    this._advance(step);
    this._pulseLights();

    const hasPos = flight ? readVec(flight.position, _player) : false;

    // Relative speed: prefer the actual velocity vectors, fall back to
    // comparing scalar airspeeds when only `speed` is supplied.
    let relSpeed = this.speed;
    if (flight) {
      if (readVec(flight.velocity, _playerVel) && _playerVel.lengthSq() > 1e-4) {
        _delta.subVectors(_playerVel, this.velocity);
        relSpeed = _delta.length();
      } else if (Number.isFinite(flight.speed)) {
        relSpeed = Math.abs(flight.speed - this.speed);
      }
    }

    this.contact = false;
    this.preContact = false;

    let distanceM = 0;
    let bearingDeg = 0;

    if (hasPos) {
      // Tanker body axes on the horizontal plane.
      _fwd.set(this.velocity.x, 0, this.velocity.z);
      if (_fwd.lengthSq() < 1e-8) {
        _fwd.set(Math.sin(this.heading * DEG), 0, -Math.cos(this.heading * DEG));
      }
      _fwd.normalize();
      _right.set(-_fwd.z, 0, _fwd.x);

      _rel.subVectors(_player, this.position);
      const aft = -_rel.dot(_fwd);
      const below = -_rel.y;
      const lateral = Math.abs(_rel.dot(_right));
      const EPS = 1e-6; // box bounds are inclusive; float noise must not flake

      this.contact = aft >= CONTACT_AFT_MIN - EPS && aft <= CONTACT_AFT_MAX + EPS
        && below >= CONTACT_BELOW_MIN - EPS && below <= CONTACT_BELOW_MAX + EPS
        && lateral <= CONTACT_LATERAL_MAX + EPS
        && relSpeed < CONTACT_CLOSURE_MAX;

      this.preContact = this.contact || (
        aft >= PRECONTACT_AFT_MIN - EPS && aft <= PRECONTACT_AFT_MAX + EPS
        && below >= PRECONTACT_BELOW_MIN - EPS && below <= PRECONTACT_BELOW_MAX + EPS
        && lateral <= PRECONTACT_LATERAL_MAX + EPS
        && relSpeed < PRECONTACT_CLOSURE_MAX
      );

      _rel.subVectors(this.position, _player);
      distanceM = _rel.length();
      bearingDeg = norm360(Math.atan2(_rel.x, -_rel.z) * RAD2DEG);
    }

    return {
      active: true,
      position: this.position,
      heading: this.heading,
      speed: this.speed,
      distanceM,
      bearingDeg,
      contact: this.contact,
      preContact: this.preContact,
    };
  }

  /** Integrate the circular orbit and refresh state + mesh pose. */
  _advance(step) {
    this.angle += this._omega * step;
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);

    this.position.set(
      this.anchor.x + this.radius * c,
      this.anchor.y,
      this.anchor.z + this.radius * s,
    );

    const tangential = this._omega * this.radius; // = this.speed
    this.velocity.set(-s * tangential, 0, c * tangential);
    this.heading = norm360(Math.atan2(this.velocity.x, -this.velocity.z) * RAD2DEG);

    // Coordinated turn: bank angle = atan(v^2 / (r g)). Racetrack is flown
    // clockwise, so the right wing is down (negative roll about local Z).
    this._bank = Math.atan2((tangential * tangential) / this.radius, 9.81);

    if (this.group) {
      this.group.position.copy(this.position);
      this.group.rotation.set(0, -this.heading * DEG, -this._bank);
    }
  }

  _pulseLights() {
    if (!this._lights) return;
    for (let i = 0; i < this._lights.length; i++) {
      const m = this._lights[i].material;
      m.emissiveIntensity = 1.5 + 0.9 * (0.5 + 0.5 * Math.sin(this._time * 2.4 + i * 2.1));
    }
  }

  /** Build the KC-135. No-op (and no allocation) when scene is null. */
  _buildMesh() {
    if (!this.scene) {
      this.group = null;
      this.mesh = null;
      this._lights = null;
      return;
    }

    const GREY = 0x9ba1a6;
    const BELLY = 0x7c8288;
    const DARK = 0x3d4247;

    const g = new THREE.Group();
    g.name = 'kc135-tanker';
    g.rotation.order = 'YXZ';

    // --- fuselage (nose points -Z) ---------------------------------------
    const hull = new THREE.Mesh(
      new THREE.CylinderGeometry(2.05, 2.05, 34, 20),
      mat(GREY, { roughness: 0.52, metalness: 0.28 }),
    );
    hull.rotation.x = Math.PI / 2;
    g.add(hull);

    const belly = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.5, 26, 14),
      mat(BELLY, { roughness: 0.6, metalness: 0.2 }),
    );
    belly.rotation.x = Math.PI / 2;
    belly.position.set(0, -1.25, 1.5);
    g.add(belly);

    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(2.05, 5.4, 20),
      mat(0x878d92, { roughness: 0.55, metalness: 0.3 }),
    );
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -18.4;
    g.add(nose);

    const tailCone = new THREE.Mesh(
      new THREE.ConeGeometry(2.05, 4.6, 20),
      mat(0x878d92, { roughness: 0.6, metalness: 0.25 }),
    );
    tailCone.rotation.x = Math.PI / 2;
    tailCone.position.z = 18.3;
    g.add(tailCone);

    // Cockpit glazing band.
    box(g, 3.3, 0.85, 2.8, 0, 1.5, -14.7, 0x28313a, { metalness: 0.65, roughness: 0.22 });
    // Refuelling receptacle fairing on the spine.
    box(g, 1.5, 0.5, 4.2, 0, 2.0, 1.2, GREY, { roughness: 0.6 });

    // --- swept wings ------------------------------------------------------
    for (const sign of [-1, 1]) {
      const wing = new THREE.Mesh(
        wingGeometry(sign),
        mat(GREY, { roughness: 0.62, metalness: 0.2, side: THREE.DoubleSide }),
      );
      wing.position.y = -0.55;
      g.add(wing);

      const nav = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 8, 6),
        sign > 0
          ? mat(0x300000, { emissive: 0xff2a12, emissiveIntensity: 2.2 })
          : mat(0x002000, { emissive: 0x22ff55, emissiveIntensity: 2.2 }),
      );
      nav.position.set(sign * 18.9, -0.45, 2.7);
      g.add(nav);
    }

    // --- tail surfaces ----------------------------------------------------
    const fin = box(g, 0.55, 8.8, 5.4, 0, 4.8, 15.3, GREY, { roughness: 0.62 });
    fin.rotation.x = 0.28; // swept back
    const finTip = box(g, 0.62, 1.2, 3.0, 0, 8.95, 16.5, 0x8b9196, { roughness: 0.58 });
    finTip.rotation.x = 0.28;
    for (const sign of [-1, 1]) {
      const stab = box(g, 6.2, 0.35, 2.9, sign * 3.6, 0.85, 17.5, GREY, { roughness: 0.65 });
      stab.rotation.y = -0.22 * sign;
    }
    const tailLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 8, 6),
      mat(0x303030, { emissive: 0xffffff, emissiveIntensity: 2.0 }),
    );
    tailLight.position.set(0, 0.6, 20.7);
    g.add(tailLight);

    // --- four underwing turbofan pods ------------------------------------
    const engines = [];
    for (const x of [-12.2, -5.8, 5.8, 12.2]) {
      const pod = new THREE.Group();
      pod.position.set(x, -1.95, 0.9);

      const nacelle = new THREE.Mesh(
        new THREE.CylinderGeometry(1.0, 1.18, 4.8, 16),
        mat(0x8f959a, { roughness: 0.45, metalness: 0.35 }),
      );
      nacelle.rotation.x = Math.PI / 2;
      pod.add(nacelle);

      const intake = new THREE.Mesh(
        new THREE.CircleGeometry(0.98, 16),
        mat(0x161a1c, { metalness: 0.5, roughness: 0.35 }),
      );
      intake.position.z = -2.42;
      intake.rotation.y = Math.PI;
      pod.add(intake);

      const exhaust = new THREE.Mesh(
        new THREE.CircleGeometry(0.72, 14),
        mat(0x241f1b, { emissive: 0x2a1b10, emissiveIntensity: 0.7 }),
      );
      exhaust.position.z = 2.42;
      pod.add(exhaust);

      g.add(pod);
      engines.push(pod);

      // Pylon up to the wing.
      box(g, 0.55, 1.1, 2.8, x, -1.05, 0.9, DARK, { metalness: 0.35 });
    }

    // --- angled aft refuelling boom --------------------------------------
    const boom = new THREE.Group();
    const boomRoot = new THREE.Vector3(0, -1.9, 14.0);
    const boomTip = new THREE.Vector3(0, -6.4, 28.6);
    const probeTip = new THREE.Vector3(0, -6.9, 31.4);
    tube(boom, boomRoot, boomTip, 0.5, 0.3, 0x777d82, { metalness: 0.45, roughness: 0.4 });
    tube(boom, boomTip, probeTip, 0.16, 0.08, 0xb9bec2, { metalness: 0.7, roughness: 0.25 });
    // Boom control fins.
    box(boom, 2.6, 0.12, 0.9, 0, -6.05, 27.1, DARK, { metalness: 0.4 });
    box(boom, 0.12, 2.3, 0.9, 0, -6.05, 27.1, DARK, { metalness: 0.4 });
    g.add(boom);

    // --- belly director lights (white / amber) ---------------------------
    const lights = [];
    const colours = [0xfff2d0, 0xffb43c, 0xffffff];
    const lightZ = [2.0, 6.2, 10.4];
    for (let i = 0; i < lightZ.length; i++) {
      box(g, 1.1, 0.22, 0.55, 0, -2.72, lightZ[i], 0x23262a, { metalness: 0.4 });
      const light = new THREE.Mesh(
        new THREE.SphereGeometry(0.34, 10, 8),
        mat(0x1a1a18, { emissive: colours[i], emissiveIntensity: 2.2 }),
      );
      light.position.set(0, -2.92, lightZ[i]);
      g.add(light);
      lights.push(light);
    }

    g.userData.engines = engines;
    g.userData.boom = boom;
    g.userData.directorLights = lights;
    g.userData.boomTip = probeTip.clone();

    this.group = g;
    this.mesh = g;
    this._lights = lights;
    this.scene.add(g);
  }
}