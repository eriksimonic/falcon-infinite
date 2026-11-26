// Ambient air traffic: four deterministic high-altitude airliners crossing the
// sky within 45 km of the player, each dragging twin white contrail ribbons,
// plus an optional F-16 wingman ("VIPER 1-2") holding fingertip formation.
//
// Seeded with mulberry32 only — the sky is identical on every run. Works with
// `scene === null` for headless tests; meshes/contrails are built lazily only
// when a scene is supplied.
import * as THREE from 'three';
import { clamp, mulberry32, SEED } from '../world/noise.js';

const AIRLINER_COUNT = 4;
const RANGE = 45000;          // m — recycle radius around the player
const MIN_ALT = 6500;         // m
const MAX_ALT = 10500;        // m
const TRAIL_POINTS = 26;

// Fingertip formation in the player's frame: +X right, +Y up, +Z aft.
const FORMATION = new THREE.Vector3(22, 2, 18);
const WINGMAN_MIN_SPEED = 75;  // m/s

const _v = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

export class AirTrafficSystem {
  constructor(scene = null) {
    this.scene = scene || null;

    this.wingmanEnabled = true;
    this.wingmanActive = false;
    this.wingmanPos = new THREE.Vector3();
    this.wingmanQuaternion = new THREE.Quaternion();

    this.airliners = [];
    this._seed = (SEED ^ 0x7a11c) >>> 0;
    this._rng = mulberry32(this._seed);
    this._time = 0;

    this._group = null;
    this._wingmanMesh = null;

    if (this.scene) {
      this._group = new THREE.Group();
      this._group.name = 'air-traffic';
      this.scene.add(this._group);
    }

    for (let i = 0; i < AIRLINER_COUNT; i++) {
      this.airliners.push(this._createAirliner(i));
    }
    this._buildWingman();

    // Seed around the origin so update() is valid even before reset(flight).
    this.reset(null);
  }

  // ---------------------------------------------------------------- public

  /** Seed airliner tracks around the player and reset the wingman formation. */
  reset(flight) {
    const p = flight && flight.position ? flight.position : _zero;
    this._rng = mulberry32(this._seed);
    this._time = 0;

    for (const a of this.airliners) {
      this._place(a, p, true);
    }

    this.wingmanActive = false;
    if (flight && flight.quaternion) {
      this.wingmanQuaternion.copy(flight.quaternion);
    } else {
      this.wingmanQuaternion.identity();
    }
    this._formationTarget(flight, this.wingmanPos);
    this._syncWingman();

    return this;
  }

  /** Toggle the wingman; returns the new enabled state. */
  toggleWingman() {
    this.wingmanEnabled = !this.wingmanEnabled;
    if (!this.wingmanEnabled) {
      this.wingmanActive = false;
      if (this._wingmanMesh) this._wingmanMesh.visible = false;
    }
    return this.wingmanEnabled;
  }

  /** Update airliners, contrails, and the wingman. */
  update(dt, flight, weather) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
    this._time += dt;

    const p = flight && flight.position ? flight.position : _zero;

    for (const a of this.airliners) {
      a.position.addScaledVector(a.velocity, dt);

      if (a.position.distanceToSquared(p) > RANGE * RANGE) {
        this._place(a, p, false);
      }
      this._syncAirliner(a);
    }

    this._updateWingman(dt, flight);

    return {
      airlinerCount: this.airliners.length,
      wingmanActive: this.wingmanActive,
      wingmanPos: this.wingmanPos,
    };
  }

  // -------------------------------------------------------------- airliners

  _createAirliner(i) {
    return {
      index: i,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      heading: 0,
      altitude: 8000,
      speed: 240,
      mesh: null,
      trails: [],
    };
  }

  /**
   * Position an airliner. `initial` seeds the whole track around the player;
   * otherwise it re-enters ~38 km behind the player along its own heading so
   * it flies across the sky and out the other side.
   */
  _place(a, p, initial) {
    const rng = this._rng;

    if (initial) {
      a.heading = rng() * Math.PI * 2;
      a.altitude = MIN_ALT + rng() * (MAX_ALT - MIN_ALT);
      a.speed = 215 + rng() * 55;

      const bearing = rng() * Math.PI * 2;
      const dist = 12000 + rng() * 24000;
      a.position.set(
        p.x + Math.sin(bearing) * dist,
        a.altitude,
        p.z - Math.cos(bearing) * dist,
      );
    } else {
      const back = 0.84 * RANGE;
      const lat = (rng() * 2 - 1) * 5000;
      const fx = Math.sin(a.heading);
      const fz = -Math.cos(a.heading);
      const rx = Math.cos(a.heading);
      const rz = Math.sin(a.heading);
      a.position.set(
        p.x - fx * back + rx * lat,
        a.altitude,
        p.z - fz * back + rz * lat,
      );
    }

    a.velocity.set(
      Math.sin(a.heading) * a.speed,
      0,
      -Math.cos(a.heading) * a.speed,
    );
    a.quaternion.setFromAxisAngle(_yAxis, -a.heading);

    if (this.scene) this._ensureAirlinerMesh(a);
    this._resetTrails(a);
    this._syncAirliner(a);
  }

  _ensureAirlinerMesh(a) {
    if (a.mesh || !this._group) return;

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xe8ecef, roughness: 0.55, metalness: 0.25,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x6c7680, roughness: 0.6, metalness: 0.35,
    });

    const g = new THREE.Group();

    const fuselageGeo = new THREE.CylinderGeometry(1.8, 1.8, 34, 12);
    fuselageGeo.rotateX(Math.PI / 2);
    g.add(new THREE.Mesh(fuselageGeo, bodyMat));

    const noseGeo = new THREE.ConeGeometry(1.8, 6, 12);
    noseGeo.rotateX(-Math.PI / 2);
    const nose = new THREE.Mesh(noseGeo, bodyMat);
    nose.position.z = -20;
    g.add(nose);

    const tailGeo = new THREE.ConeGeometry(1.8, 7, 12);
    tailGeo.rotateX(Math.PI / 2);
    const tail = new THREE.Mesh(tailGeo, bodyMat);
    tail.position.z = 20.5;
    g.add(tail);

    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(14.5, 0.45, 4.4), bodyMat);
      wing.position.set(s * 7.8, -0.35, 2.4);
      wing.rotation.y = -s * 0.36;
      g.add(wing);

      const engineGeo = new THREE.CylinderGeometry(1.35, 1.15, 6, 10);
      engineGeo.rotateX(Math.PI / 2);
      const engine = new THREE.Mesh(engineGeo, darkMat);
      engine.position.set(s * 6.2, -1.6, 0.8);
      g.add(engine);
    }

    const stabiliser = new THREE.Mesh(new THREE.BoxGeometry(12, 0.4, 3), bodyMat);
    stabiliser.position.set(0, 0.2, 15.5);
    g.add(stabiliser);

    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5, 4.2), bodyMat);
    fin.position.set(0, 2.6, 15.5);
    g.add(fin);

    a.mesh = g;
    this._group.add(g);

    // Twin contrail ribbons trailing from the engines.
    for (const s of [-1, 1]) {
      const positions = new Float32Array(TRAIL_POINTS * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setDrawRange(0, 0);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.26, depthWrite: false,
        }),
      );
      line.frustumCulled = false;
      line.name = 'contrail';
      this._group.add(line);
      a.trails.push({ line, positions, count: 0, side: s });
    }
  }

  _resetTrails(a) {
    for (const t of a.trails) {
      t.count = 0;
      t.line.geometry.setDrawRange(0, 0);
    }
  }

  _syncAirliner(a) {
    if (!a.mesh) return;

    a.mesh.position.copy(a.position);
    a.mesh.quaternion.copy(a.quaternion);

    for (const t of a.trails) {
      // Exhaust point in aircraft space, then to world.
      _tip.set(t.side * 6.2, -1.6, 4.6).applyQuaternion(a.quaternion).add(a.position);
      this._pushTrail(t, _tip);
    }
  }

  _pushTrail(t, point) {
    const p = t.positions;
    const limit = Math.max(0, t.count - 1);
    if (limit > 0) p.copyWithin(3, 0, limit * 3);
    p[0] = point.x;
    p[1] = point.y;
    p[2] = point.z;
    if (t.count < TRAIL_POINTS) t.count++;

    t.line.geometry.setDrawRange(0, t.count);
    t.line.geometry.attributes.position.needsUpdate = true;
  }

  // ---------------------------------------------------------------- wingman

  _shouldFlyWingman(flight) {
    return !!(
      this.wingmanEnabled
      && flight
      && flight.onGround === false
      && (flight.speed || 0) > WINGMAN_MIN_SPEED
    );
  }

  _formationTarget(flight, out) {
    out.copy(FORMATION);
    if (flight) {
      if (flight.quaternion) out.applyQuaternion(flight.quaternion);
      if (flight.position) out.add(flight.position);
    }
    return out;
  }

  _updateWingman(dt, flight) {
    this.wingmanActive = this._shouldFlyWingman(flight);

    if (this._wingmanMesh) this._wingmanMesh.visible = this.wingmanActive;

    if (!flight || !flight.position) return;

    if (this.wingmanActive) {
      const target = this._formationTarget(flight, _v);

      // Smooth exponential convergence — no snapping, no overshoot.
      const k = 1 - Math.exp(-1.9 * dt);
      this.wingmanPos.lerp(target, k);

      if (flight.quaternion) {
        this.wingmanQuaternion.slerp(flight.quaternion, 1 - Math.exp(-2.6 * dt));
      }

      // Defensive separation so the wingman never merges into the player.
      const minDist = 12;
      const d = this.wingmanPos.distanceTo(flight.position);
      if (d < minDist) {
        if (d > 1e-4) {
          _v.copy(this.wingmanPos).sub(flight.position).multiplyScalar(minDist / d);
          this.wingmanPos.copy(flight.position).add(_v);
        } else {
          this._formationTarget(flight, this.wingmanPos);
        }
      }
    }

    this._syncWingman();
  }

  _syncWingman() {
    if (!this._wingmanMesh) return;
    this._wingmanMesh.position.copy(this.wingmanPos);
    this._wingmanMesh.quaternion.copy(this.wingmanQuaternion);
  }

  _buildWingman() {
    if (!this._group) return;

    const mat = new THREE.MeshStandardMaterial({
      color: 0x7d8a99, roughness: 0.5, metalness: 0.4,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x3a4148, roughness: 0.6, metalness: 0.3,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x9fd8ff, roughness: 0.15, metalness: 0.2,
      transparent: true, opacity: 0.55,
    });

    const g = new THREE.Group();
    g.name = 'viper-1-2';

    const bodyGeo = new THREE.CylinderGeometry(0.62, 0.5, 11, 10);
    bodyGeo.rotateX(Math.PI / 2);
    g.add(new THREE.Mesh(bodyGeo, mat));

    const noseGeo = new THREE.ConeGeometry(0.62, 3.6, 10);
    noseGeo.rotateX(-Math.PI / 2);
    const nose = new THREE.Mesh(noseGeo, mat);
    nose.position.z = -7.3;
    g.add(nose);

    const canopyGeo = new THREE.SphereGeometry(0.5, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
    canopyGeo.scale(1, 0.9, 2.2);
    const canopy = new THREE.Mesh(canopyGeo, glass);
    canopy.position.set(0, 0.4, -2.8);
    g.add(canopy);

    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.16, 2.7), mat);
      wing.position.set(s * 2.4, -0.05, 1.15);
      wing.rotation.y = -s * 0.5;
      g.add(wing);

      const stab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 1.3), mat);
      stab.position.set(s * 1.2, -0.02, 5.1);
      stab.rotation.y = -s * 0.35;
      g.add(stab);
    }

    const nozzleGeo = new THREE.CylinderGeometry(0.5, 0.42, 1.2, 10);
    nozzleGeo.rotateX(Math.PI / 2);
    const nozzle = new THREE.Mesh(nozzleGeo, dark);
    nozzle.position.set(0, 0, 6.2);
    g.add(nozzle);

    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.1, 2.0), mat);
    fin.position.set(0, 1.1, 5.2);
    fin.rotation.x = 0.18;
    g.add(fin);

    g.visible = false;
    this._wingmanMesh = g;
    this._group.add(g);
  }
}