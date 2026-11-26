// Animated OSM highway traffic for the Vipava Valley.
//
// Virtual cars cruise the real baked OpenStreetMap polylines (H4 expressway,
// the Vipava valley arteries and the coastal roads) and are drawn as two
// instanced pools of glowing streaks: warm-white headlights for traffic coming
// towards the camera and crimson taillights for traffic pulling away. The
// streaky look is what sells night traffic from altitude; there is no car body
// geometry at all, so the whole system is two draw calls.
//
// The class is headless-safe: `new RoadTrafficSystem(null)` still normalizes
// the roads, spawns vehicles and advances them along their polylines, so
// `tests/living_vipava_test.mjs` can verify motion and wrapping without WebGL.
import * as THREE from 'three';
import { terrainHeight } from './terrain.js';
import { hash2, clamp } from './noise.js';

// Roads shorter than this read as driveways at 10 km altitude; skip them.
const MIN_ROAD_LENGTH = 350; // metres of polyline
const MAX_ROADS = 180; // longest/major polylines kept per theater
const LANE_OFFSET = 1.8; // right-of-centre offset so two-way traffic separates
const LIGHT_LIFT = 1.15; // lamps this far above the sampled terrain
const CULL_RANGE = 22000; // streaks are sub-pixel beyond this
const SPEED_MIN = 18; // m/s (~65 km/h)
const SPEED_MAX = 34; // m/s (~122 km/h, H4 expressway)
const OPACITY_DAY = 0.18; // subtle daytime glint
const OPACITY_NIGHT = 0.95; // full glowing streaks after dusk

// Vehicle budget per quality preset. The instanced pools are sized once.
const VEHICLES_BY_QUALITY = { low: 120, medium: 220, high: 320 };

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

/**
 * One vehicle's logical state and world position.
 * `x/y/z` is the car centre (for tests, stats and culling); the visual
 * streaks are placed 2.7 m fore and aft of it.
 */
function makeVehicle(roadIndex, s, dir, speed) {
  return { road: roadIndex, s, dir, speed, x: 0, y: 0, z: 0 };
}

export class RoadTrafficSystem {
  /**
   * @param {THREE.Scene|{add:Function,remove:Function}|null} scene
   *        null keeps the whole system headless (no meshes are built).
   * @param {object|null} preset QUALITY preset; only `name` is read.
   */
  constructor(scene = null, preset = null) {
    this.scene = scene || null;
    this.preset = preset || {};
    const quality = String(this.preset.name || 'medium').toLowerCase();
    this.maxVehicles = VEHICLES_BY_QUALITY[quality] || VEHICLES_BY_QUALITY.medium;

    this.roads = [];
    this.vehicles = [];
    this.stats = { roads: 0, vehicles: 0, visible: 0 };

    this.headMesh = null;
    this.tailMesh = null;
    this.headMaterial = null;
    this.tailMaterial = null;
    this._opacity = -1;

    if (!this.scene) return;

    // Headlights: a long warm-white streak; taillights: a shorter, redder one.
    this.headMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff2d2,
      toneMapped: false,
      transparent: true,
      opacity: OPACITY_DAY,
      depthWrite: false,
    });
    this.tailMaterial = new THREE.MeshBasicMaterial({
      color: 0xff2a1e,
      toneMapped: false,
      transparent: true,
      opacity: OPACITY_DAY,
      depthWrite: false,
    });

    const headGeo = new THREE.BoxGeometry(0.7, 0.42, 5.6);
    const tailGeo = new THREE.BoxGeometry(0.6, 0.36, 4.2);
    this.headMesh = new THREE.InstancedMesh(headGeo, this.headMaterial, this.maxVehicles);
    this.tailMesh = new THREE.InstancedMesh(tailGeo, this.tailMaterial, this.maxVehicles);
    for (const mesh of [this.headMesh, this.tailMesh]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.renderOrder = 2;
    }
    this.headMesh.name = 'traffic-headlights';
    this.tailMesh.name = 'traffic-taillights';
    this.scene.add(this.headMesh);
    this.scene.add(this.tailMesh);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  /**
   * Replace the traffic network with the baked OSM road array.
   *
   * Accepts both the raw bake shape `{ w, pts: [[x, z], ...] }` and the
   * normalized shape `{ width, points: [{ x, z }, ...], kind }`. Only polylines
   * at least 350 m long are used, highways/arterials are preferred, and the
   * result is capped at the 180 longest/most major roads.
   *
   * @param {Array<object>} roads
   * @param {(x:number, z:number) => number} heightAt terrain sampler
   * @returns {number} number of roads carrying traffic
   */
  setCustomRoads(roads, heightAt = terrainHeight) {
    this.clear();
    if (!Array.isArray(roads) || roads.length === 0) return 0;

    const sample = typeof heightAt === 'function' ? heightAt : terrainHeight;
    const prepared = [];

    for (const raw of roads) {
      if (!raw || typeof raw !== 'object') continue;
      const src = Array.isArray(raw.points) ? raw.points
        : Array.isArray(raw.pts) ? raw.pts
          : null;
      if (!src || src.length < 2) continue;

      const points = [];
      for (const p of src) {
        const x = Array.isArray(p) ? Number(p[0]) : Number(p && p.x);
        const z = Array.isArray(p) ? Number(p[1]) : Number(p && p.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const tail = points.length ? points[points.length - 1] : null;
        if (tail && Math.hypot(x - tail.x, z - tail.z) < 0.5) continue;
        points.push({ x, z });
      }
      if (points.length < 2) continue;

      const cum = new Float64Array(points.length);
      let total = 0;
      for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
        cum[i] = total;
      }
      if (total < MIN_ROAD_LENGTH) continue;

      const rawWidth = Number.isFinite(raw.w) ? raw.w : Number(raw.width);
      const width = Number.isFinite(rawWidth) ? Math.max(2, rawWidth) : 9;
      const kind = typeof raw.kind === 'string' ? raw.kind : '';
      // Prefer real highways/arterials; the bake has no kind tags, so a wide
      // carriageway is the reliable proxy for the H4 expressway.
      const major = /motorway|trunk|primary|highway|express|arterial/i.test(kind)
        ? 2
        : width >= 13 ? 2 : width >= 9 ? 1 : 0;

      prepared.push({ points, cum, total, width, kind, major });
    }

    prepared.sort((a, b) => (b.major - a.major) || (b.total - a.total));
    if (prepared.length > MAX_ROADS) prepared.length = MAX_ROADS;

    const sampleHeight = (x, z) => {
      const h = sample(x, z);
      return Number.isFinite(h) ? h : 0;
    };

    this.roads = prepared.map((r) => {
      const ys = new Float32Array(r.points.length);
      for (let i = 0; i < r.points.length; i++) {
        ys[i] = sampleHeight(r.points[i].x, r.points[i].z) + LIGHT_LIFT;
      }
      return { ...r, ys };
    });

    this._spawnVehicles();
    this.stats.roads = this.roads.length;
    this.stats.vehicles = this.vehicles.length;
    this.stats.visible = this.vehicles.length;
    return this.roads.length;
  }

  /**
   * Advance every car along its polyline, wrapping seamlessly, and rewrite the
   * instanced streak matrices. `night` fades the glow in from a daytime glint
   * (0.18) to full brightness (0.95) and culls anything beyond 22 km.
   */
  update(dt, cameraPos = null, night = 0) {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const n = clamp(Number.isFinite(night) ? night : 0, 0, 1);
    const camX = cameraPos ? Number(cameraPos.x) : NaN;
    const camZ = cameraPos ? Number(cameraPos.z) : NaN;
    const hasCam = Number.isFinite(camX) && Number.isFinite(camZ);
    const range2 = CULL_RANGE * CULL_RANGE;

    const opacity = OPACITY_DAY + (OPACITY_NIGHT - OPACITY_DAY) * n;
    if (this.headMaterial && opacity !== this._opacity) {
      this.headMaterial.opacity = opacity;
      this.tailMaterial.opacity = opacity;
      this._opacity = opacity;
    }

    const head = this.headMesh;
    const tail = this.tailMesh;
    const headScaleZ = 1 + 0.55 * n;
    let out = 0;

    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const road = this.roads[v.road];
      if (!road) continue;

      v.s += v.speed * step * v.dir;
      const total = road.total;
      v.s = ((v.s % total) + total) % total;

      const sample = this._sampleAt(road, v.s);
      const fx = sample.tx * v.dir;
      const fz = sample.tz * v.dir;
      // Right-hand perpendicular of the travel direction: two-way traffic
      // separates cleanly into opposite lanes instead of overlapping.
      const lane = LANE_OFFSET * v.dir;
      const cx = sample.x - sample.tz * lane;
      const cz = sample.z + sample.tx * lane;
      v.x = cx;
      v.y = sample.y;
      v.z = cz;

      if (hasCam) {
        const dx = cx - camX;
        const dz = cz - camZ;
        if (dx * dx + dz * dz > range2) continue;
      }

      if (head && out < this.maxVehicles) {
        const yaw = Math.atan2(fx, fz);
        _e.set(0, yaw, 0);
        _q.setFromEuler(_e);

        _p.set(cx + fx * 2.7, sample.y, cz + fz * 2.7);
        _s.set(1, 1, headScaleZ);
        _m.compose(_p, _q, _s);
        head.setMatrixAt(out, _m);

        _p.set(cx - fx * 2.5, sample.y - 0.08, cz - fz * 2.5);
        _s.set(1, 1, 1);
        _m.compose(_p, _q, _s);
        tail.setMatrixAt(out, _m);
      }

      out++;
    }

    if (head) {
      head.count = out;
      tail.count = out;
      head.instanceMatrix.needsUpdate = true;
      tail.instanceMatrix.needsUpdate = true;
    }
    this.stats.visible = out;
    this.stats.vehicles = this.vehicles.length;
    return out;
  }

  /** Drop every custom road and vehicle (meshes are kept for reuse). */
  clear() {
    this.roads = [];
    this.vehicles = [];
    this._opacity = -1;
    if (this.headMesh) this.headMesh.count = 0;
    if (this.tailMesh) this.tailMesh.count = 0;
    this.stats.roads = 0;
    this.stats.vehicles = 0;
    this.stats.visible = 0;
  }

  /** Detach from the scene and free the two instanced pools. */
  dispose() {
    this.clear();
    if (this.headMesh) {
      this.headMesh.removeFromParent();
      this.headMesh.geometry.dispose();
    }
    if (this.tailMesh) {
      this.tailMesh.removeFromParent();
      this.tailMesh.geometry.dispose();
    }
    this.headMaterial?.dispose();
    this.tailMaterial?.dispose();
    this.headMesh = null;
    this.tailMesh = null;
    this.headMaterial = null;
    this.tailMaterial = null;
    this._opacity = -1;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------
  /** Spawn up to `maxVehicles` cars, proportional to road length, both ways. */
  _spawnVehicles() {
    this.vehicles = [];
    if (this.roads.length === 0) return;

    let totalLength = 0;
    for (const road of this.roads) totalLength += road.total;
    if (!(totalLength > 0)) return;

    const budget = this.maxVehicles;
    let spawned = 0;

    for (let ri = 0; ri < this.roads.length; ri++) {
      const road = this.roads[ri];
      const remaining = budget - spawned;
      if (remaining <= 0) break;
      // Cars every ~900 m, at least one per road, capped by the remaining pool.
      const share = budget * (road.total / totalLength);
      const want = Math.min(remaining, Math.max(1, Math.round(share)));
      for (let k = 0; k < want; k++) {
        const hDir = hash2(ri * 131 + k, 17, 0x51ed270b);
        const hSpeed = hash2(k * 67 + ri, 29, 0x9e3779b1);
        const dir = hDir < 0.5 ? 1 : -1;
        const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * hSpeed;
        const v = makeVehicle(ri, ((k + 0.5) / want) * road.total, dir, speed);
        const sample = this._sampleAt(road, v.s);
        const lane = LANE_OFFSET * dir;
        v.x = sample.x - sample.tz * lane;
        v.y = sample.y;
        v.z = sample.z + sample.tx * lane;
        this.vehicles.push(v);
      }
      spawned += want;
    }
  }

  /**
   * Interpolate position, elevation and unit tangent at arc length `s`.
   * `cum` is a sorted cumulative-length table, so this is a binary search.
   */
  _sampleAt(road, s) {
    const cum = road.cum;
    const last = cum.length - 1;
    const dist = clamp(s, 0, road.total);
    let lo = 0;
    let hi = last;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= dist) lo = mid;
      else hi = mid;
    }
    const segLen = cum[lo + 1] - cum[lo];
    const t = segLen > 1e-6 ? (dist - cum[lo]) / segLen : 0;
    const p0 = road.points[lo];
    const p1 = road.points[lo + 1];
    const x = p0.x + (p1.x - p0.x) * t;
    const z = p0.z + (p1.z - p0.z) * t;
    const y = road.ys[lo] + (road.ys[lo + 1] - road.ys[lo]) * t;
    let tx = p1.x - p0.x;
    let tz = p1.z - p0.z;
    const len = Math.hypot(tx, tz);
    if (len > 1e-6) {
      tx /= len;
      tz /= len;
    } else {
      tx = 0;
      tz = 1;
    }
    return { x, y, z, tx, tz };
  }
}