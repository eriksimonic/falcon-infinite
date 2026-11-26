// Inter-settlement road network: deterministic highway links from villages to
// towns and towns to metros, built as continuous terrain-conforming ribbon
// meshes.
//
// Every polyline is sampled every ~20 m, the asphalt deck is lifted 0.38 m off
// `heightAt(x, z)`, a 1.6 m embankment skirt seals cross-slopes, and anything
// that would run below 0.8 m elevation becomes a bridge deck at 2.6 m or
// higher. UVs run across the road (u) and along its length in metres / 24 (v)
// so the dashed centre line flows around curves.
//
// The module is headless-safe: `document` is guarded so importing this file in
// Node (tests/roadnet_test.mjs) never throws.

import * as THREE from 'three';
import { settlementsNear } from './settlements.js';
import { terrainHeight, airportsNear } from './terrain.js';
import { hash2 } from './noise.js';

const RANK = { metro: 4, town: 3, village: 2, hamlet: 1 };

// Ribbon constants (metres).
const SAMPLE_STEP = 20;   // longitudinal spacing between ribbon samples
const DECK_LIFT = 0.38;   // asphalt surface above terrain
const SKIRT_DEPTH = 1.6;  // embankment skirt below each road edge
const WATER_LEVEL = 0.8;  // below this the road becomes a bridge
const BRIDGE_DECK = 2.6;  // minimum bridge deck elevation above the sea
const UV_METRES = 24;     // one texture repeat per 24 m of road

// Real-world OSM roads: only ribbons this close to the camera are built.
const CUSTOM_ROAD_RANGE = 26000;

function makeRoadTexture() {
  if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
    return null;
  }
  const W = 64, H = 256;
  const c = document.createElement('canvas');
  if (!c) return null;
  c.width = W; c.height = H;
  const ctx = c.getContext && c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#333633';
  ctx.fillRect(0, 0, W, H);
  const rng = (() => { let a = 1234567; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
  for (let i = 0; i < 900; i++) {
    const v = 40 + Math.floor(rng() * 35);
    ctx.fillStyle = `rgba(${v},${v},${v},${0.15 + rng() * 0.3})`;
    ctx.fillRect(rng() * W, rng() * H, 1 + rng() * 4, 1 + rng() * 2);
  }
  // dashed centre line
  ctx.fillStyle = 'rgba(224,214,160,0.75)';
  for (let y = 4; y < H; y += 34) ctx.fillRect(W / 2 - 1.5, y, 3, 16);
  // edge lines
  ctx.fillStyle = 'rgba(220,220,210,0.35)';
  ctx.fillRect(3, 0, 1.5, H);
  ctx.fillRect(W - 4.5, 0, 1.5, H);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function safeHeight(heightAt, x, z) {
  const h = heightAt(x, z);
  return Number.isFinite(h) ? h : 0;
}

/** Road deck elevation for a terrain height: 0.38 m above ground, bridged over water. */
function deckHeightFor(h) {
  const ground = h + DECK_LIFT;
  return h < WATER_LEVEL ? Math.max(BRIDGE_DECK, ground) : ground;
}

function sanitizePoints(points) {
  const out = [];
  if (!Array.isArray(points)) return out;
  for (const p of points) {
    if (!p) continue;
    const x = Number(p.x);
    const z = Number(p.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const tail = out.length ? out[out.length - 1] : null;
    if (tail && Math.hypot(x - tail.x, z - tail.z) < 0.5) continue;
    out.push({ x, z });
  }
  if (out.length === 1) out.push({ x: out[0].x + 0.5, z: out[0].z });
  return out;
}

/** Resample a polyline so consecutive samples are at most ~`step` metres apart. */
function resamplePolyline(points, step) {
  if (points.length < 2) return points.slice();
  const out = [{ x: points[0].x, z: points[0].z }];
  let anchorX = points[0].x;
  let anchorZ = points[0].z;
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    let bx = points[i].x;
    let bz = points[i].z;
    let d = Math.hypot(bx - anchorX, bz - anchorZ);
    while (acc + d >= step && d > 1e-9) {
      const t = (step - acc) / d;
      anchorX += (bx - anchorX) * t;
      anchorZ += (bz - anchorZ) * t;
      out.push({ x: anchorX, z: anchorZ });
      d = Math.hypot(bx - anchorX, bz - anchorZ);
      acc = 0;
    }
    acc += d;
    anchorX = bx;
    anchorZ = bz;
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > step * 0.2) {
    out.push({ x: last.x, z: last.z });
  } else {
    tail.x = last.x;
    tail.z = last.z;
  }
  return out;
}

/**
 * Build a merged terrain-conforming ribbon geometry from polylines.
 *
 * @param {Array<{width:number, points:Array<{x:number,z:number}>}>} polylines
 * @param {(x:number,z:number)=>number} heightAt
 * @returns {{positions:Float32Array, normals:Float32Array, uvs:Float32Array,
 *            indices:Uint32Array, segmentCount:number, bridgeCount:number}}
 *
 * Vertex order per sample: left deck, right deck, left skirt, right skirt.
 * Pure and DOM-free so it can run in Node.
 */
export function buildRoadRibbonData(polylines, heightAt) {
  const hFn = typeof heightAt === 'function' ? heightAt : () => 0;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let vbase = 0;
  let segmentCount = 0;
  let bridgeCount = 0;

  const lines = Array.isArray(polylines) ? polylines : [];
  for (const line of lines) {
    if (!line) continue;
    const width = Number.isFinite(line.width) ? Math.max(0.5, line.width) : 9;
    const halfW = width * 0.5;
    const src = sanitizePoints(line.points);
    if (src.length < 2) continue;
    const pts = resamplePolyline(src, SAMPLE_STEP);
    const n = pts.length;
    if (n < 2) continue;

    const dist = new Float64Array(n);
    const deckY = new Float64Array(n);
    const rightX = new Float64Array(n);
    const rightZ = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (i > 0) dist[i] = dist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      deckY[i] = deckHeightFor(safeHeight(hFn, pts[i].x, pts[i].z));
    }

    // Horizontal tangents (central difference) -> right vector = (-tz, tx).
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const tl = Math.hypot(tx, tz);
      if (tl < 1e-6) { tx = 1; tz = 0; } else { tx /= tl; tz /= tl; }
      rightX[i] = -tz;
      rightZ[i] = tx;
    }

    // Contiguous bridge spans (runs of samples below WATER_LEVEL).
    let inBridge = false;
    for (let i = 0; i < n; i++) {
      const wet = safeHeight(hFn, pts[i].x, pts[i].z) < WATER_LEVEL;
      if (wet && !inBridge) { bridgeCount++; inBridge = true; }
      else if (!wet) inBridge = false;
    }

    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const rx = rightX[i];
      const rz = rightZ[i];
      const xl = p.x - rx * halfW;
      const zl = p.z - rz * halfW;
      const xr = p.x + rx * halfW;
      const zr = p.z + rz * halfW;
      // Each deck edge is sampled against the terrain directly beneath it, so
      // cross-slopes never lift or bury the road edge.
      const yl = deckHeightFor(safeHeight(hFn, xl, zl));
      const yr = deckHeightFor(safeHeight(hFn, xr, zr));
      const v = dist[i] / UV_METRES;

      // Surface normal from (edge across) x (longitudinal tangent), upforced.
      const ia = Math.max(0, i - 1);
      const ib = Math.min(n - 1, i + 1);
      const ax = xr - xl;
      const ay = yr - yl;
      const az = zr - zl;
      const bx = pts[ib].x - pts[ia].x;
      const by = deckY[ib] - deckY[ia];
      const bz = pts[ib].z - pts[ia].z;
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      let nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-6) { nx = 0; ny = 1; nz = 0; nl = 1; }
      nx /= nl; ny /= nl; nz /= nl;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

      positions.push(xl, yl, zl, xr, yr, zr, xl, yl - SKIRT_DEPTH, zl, xr, yr - SKIRT_DEPTH, zr);
      normals.push(nx, ny, nz, nx, ny, nz, -rx, 0, -rz, rx, 0, rz);
      uvs.push(0, v, 1, v, 0, v, 1, v);
    }

    for (let i = 0; i < n - 1; i++) {
      const b0 = vbase + i * 4;
      // deck quad
      indices.push(b0, b0 + 1, b0 + 5, b0, b0 + 5, b0 + 4);
      // left embankment skirt (faces -right)
      indices.push(b0, b0 + 6, b0 + 2, b0, b0 + 4, b0 + 6);
      // right embankment skirt (faces +right)
      indices.push(b0 + 1, b0 + 7, b0 + 5, b0 + 1, b0 + 3, b0 + 7);
    }

    segmentCount += n - 1;
    vbase += n * 4;
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    segmentCount,
    bridgeCount,
  };
}

function splitAroundAirports(points, airports, margin) {
  const runs = [];
  let run = [];
  for (const p of points) {
    let blocked = false;
    for (const ap of airports) {
      if (Math.hypot(ap.x - p.x, ap.z - p.z) < ap.padRadius + margin) { blocked = true; break; }
    }
    if (blocked) {
      if (run.length >= 2) runs.push(run);
      run = [];
      continue;
    }
    run.push(p);
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

export class RoadNetwork {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset || {};
    const rankName = this.preset.name;
    this.capacity = rankName === 'low' ? 3500 : rankName === 'high' ? 15000 : 7000;
    const map = makeRoadTexture();
    this.material = new THREE.MeshLambertMaterial({
      map,
      color: map ? 0xffffff : 0x2f3230,
      polygonOffset: true,
      polygonOffsetFactor: -1.5,
      polygonOffsetUnits: -1.5,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'highways';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    if (scene && typeof scene.add === 'function') scene.add(this.mesh);
    this._lastX = Infinity;
    this._lastZ = Infinity;
    this._built = false;
    // Baked real-world roads ({ width, points }) or null for procedural links.
    this.customRoads = null;
    this.stats = { roads: 0, segments: 0, bridges: 0 };
  }

  /**
   * Replace the procedural highway network with baked real-world polylines.
   *
   * Each item is `{ w, pts: [[x, z], ...] }` (OpenStreetMap metres). While
   * active, `_rebuild` builds the terrain-conforming ribbon mesh from the real
   * roads within 26 km of the camera. Pass `null` (or an empty list) to revert
   * cleanly to the procedural network on the next update.
   *
   * @returns {Array<{width:number, points:Array<{x:number,z:number}>}>|null}
   */
  setCustomRoads(rawRoads) {
    if (!Array.isArray(rawRoads) || rawRoads.length === 0) {
      this.customRoads = null;
      this._lastX = Infinity;
      this._lastZ = Infinity;
      this._built = false;
      return null;
    }

    const roads = [];
    for (const r of rawRoads) {
      if (!r) continue;
      const src = Array.isArray(r.pts) ? r.pts : Array.isArray(r.points) ? r.points : null;
      if (!src || src.length < 2) continue;
      const rawW = Number.isFinite(r.w) ? r.w : r.width;
      const width = Number.isFinite(rawW) ? Math.max(2, rawW) : 9;
      const points = [];
      for (const p of src) {
        if (!p) continue;
        const x = Array.isArray(p) ? Number(p[0]) : Number(p.x);
        const z = Array.isArray(p) ? Number(p[1]) : Number(p.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const tail = points.length ? points[points.length - 1] : null;
        if (tail && Math.hypot(x - tail.x, z - tail.z) < 0.5) continue;
        points.push({ x, z });
      }
      if (points.length < 2) continue;
      roads.push({ width, points });
    }

    this.customRoads = roads.length > 0 ? roads : null;
    this._lastX = Infinity;
    this._lastZ = Infinity;
    this._built = false;
    return this.customRoads;
  }

  _linkTarget(s, all) {
    const rank = RANK[s.type] || 0;
    if (s.type === 'metro') return null;
    let best = null;
    let bestD = Infinity;
    for (const t of all) {
      if (t === s || (RANK[t.type] || 0) <= rank) continue;
      const d = Math.hypot(t.x - s.x, t.z - s.z);
      if (d < 80) continue;
      const maxD = s.type === 'town' ? 42000 : 26000;
      if (d > maxD) continue;
      const penalty = s.type === 'village' && t.type === 'metro' ? 12000 : 0;
      if (d + penalty < bestD) { bestD = d + penalty; best = t; }
    }
    if (best) return best;
    // Isolated town: link to the nearest town so the network does not dead-end.
    if (s.type !== 'town') return null;
    for (const t of all) {
      if (t === s || t.type !== 'town') continue;
      const d = Math.hypot(t.x - s.x, t.z - s.z);
      if (d < 120 || d > 18000) continue;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  _links(near, all) {
    const out = [];
    const seen = new Set();
    const add = (a, b) => {
      if (!a || !b || a === b) return;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push([a, b]);
    };
    const metros = all.filter((s) => s.type === 'metro');
    for (const s of near) {
      if (s.type === 'metro') {
        let best = null;
        let bestD = 42000;
        for (const t of metros) {
          if (t === s) continue;
          const d = Math.hypot(t.x - s.x, t.z - s.z);
          if (d < bestD) { bestD = d; best = t; }
        }
        add(s, best);
        continue;
      }
      add(s, this._linkTarget(s, all));
    }
    return out;
  }

  _roadWidth(a, b) {
    if (a.type === 'metro' && b.type === 'metro') return 20;
    if (a.type === 'metro' || b.type === 'metro') return 15;
    if (a.type === 'town' && b.type === 'town') return 12;
    if (a.type === 'town' || b.type === 'town') return 10;
    return 9;
  }

  /** Smooth quadratic road centreline between the two settlement perimeters. */
  _curvePoints(a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) return [];
    const ux = dx / len;
    const uz = dz / len;
    const trimA = Math.min(a.radius * 0.92, len * 0.32);
    const trimB = Math.min(b.radius * 0.92, len * 0.32);
    const ax = a.x + ux * trimA;
    const az = a.z + uz * trimA;
    const bx = b.x - ux * trimB;
    const bz = b.z - uz * trimB;
    const span = Math.hypot(bx - ax, bz - az);
    if (span < 90) return [];
    const px = -uz;
    const pz = ux;
    const bend = (hash2(Math.round((a.x + b.x) / 100), Math.round((a.z + b.z) / 100), 611) - 0.5) * span * 0.18;
    const mx = (ax + bx) * 0.5 + px * bend;
    const mz = (az + bz) * 0.5 + pz * bend;
    const steps = Math.max(2, Math.min(400, Math.ceil(span / 20)));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const it = 1 - t;
      pts.push({
        x: it * it * ax + 2 * it * t * mx + t * t * bx,
        z: it * it * az + 2 * it * t * mz + t * t * bz,
      });
    }
    return pts;
  }

  _applyGeometry(data) {
    const old = this.mesh.geometry;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    if (data.positions.length > 0) geo.computeBoundingSphere();
    this.mesh.geometry = geo;
    if (old && old !== geo) old.dispose();
  }

  _clear() {
    this._applyGeometry({
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: new Uint32Array(0),
      segmentCount: 0,
      bridgeCount: 0,
    });
    this.mesh.visible = false;
    this._built = false;
    this._lastX = Infinity;
    this._lastZ = Infinity;
    this.stats.roads = 0;
    this.stats.segments = 0;
    this.stats.bridges = 0;
  }

  _rebuild(camera) {
    const cx = camera.position.x;
    const cz = camera.position.z;
    if (this.customRoads) {
      this._rebuildCustom(cx, cz);
      return;
    }
    const all = settlementsNear(cx, cz, 34000);
    const near = all.filter((s) => {
      if (s.type === 'hamlet') return false;
      return Math.hypot(s.x - cx, s.z - cz) < 24000;
    });
    const aps = airportsNear(cx, cz, 2);

    const links = this._links(near, all);
    const polylines = [];
    let segmentBudget = this.capacity;
    for (const [a, b] of links) {
      const width = this._roadWidth(a, b);
      const spine = this._curvePoints(a, b);
      if (spine.length < 2) continue;
      for (const run of splitAroundAirports(spine, aps, 60)) {
        const est = run.length - 1;
        if (est > segmentBudget) continue;
        segmentBudget -= est;
        polylines.push({ width, points: run });
      }
      if (segmentBudget <= 0) break;
    }

    const data = buildRoadRibbonData(polylines, terrainHeight);
    this._applyGeometry(data);
    this.mesh.visible = data.indices.length > 0;
    this._built = true;
    this._lastX = cx;
    this._lastZ = cz;
    this.stats.roads = links.length;
    this.stats.segments = data.segmentCount;
    this.stats.bridges = data.bridgeCount;
  }

  update(camera) {
    if (!camera || !camera.position) return;
    if (!this.preset || (!this.preset.roadDetail && !this.customRoads)) {
      if (this._built) this._clear();
      return;
    }
    const dx = camera.position.x - this._lastX;
    const dz = camera.position.z - this._lastZ;
    if (this._lastX === Infinity || dx * dx + dz * dz > 2000 * 2000) {
      this._rebuild(camera);
    }
  }

  /**
   * Ribbon mesh for the baked OSM roads nearest the camera. Roads outside
   * 26 km are dropped (sub-pixel), and the closest ones win the segment budget
   * so a busy valley never stalls the frame on distant asphalt.
   */
  _rebuildCustom(cx, cz) {
    const range2 = CUSTOM_ROAD_RANGE * CUSTOM_ROAD_RANGE;
    const near = [];
    for (const road of this.customRoads) {
      const pts = road.points;
      let best = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const dx = pts[i].x - cx;
        const dz = pts[i].z - cz;
        const d = dx * dx + dz * dz;
        if (d < best) best = d;
      }
      if (best <= range2) near.push({ road, d2: best });
    }
    near.sort((a, b) => a.d2 - b.d2);

    const aps = airportsNear(cx, cz, 2);
    const polylines = [];
    let segmentBudget = this.capacity;
    for (const { road } of near) {
      const pts = road.points;
      // OSM tags both carriageways of a dual motorway (H4/A1) with the full
      // carriageway width, so the two ribbons overlap and Z-fight. Cap each
      // carriageway to one lane-and-a-half so they sit side by side.
      const width = Math.min(road.width, 10.5);
      // Real asphalt must never cross an airport pad: clip every polyline
      // where it enters the runway clearing (plus margin).
      for (const run of splitAroundAirports(pts, aps, 40)) {
        let length = 0;
        for (let i = 1; i < run.length; i++) {
          length += Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z);
        }
        const est = Math.max(1, Math.ceil(length / SAMPLE_STEP));
        if (est > segmentBudget) continue;
        segmentBudget -= est;
        polylines.push({ width, points: run });
      }
      if (segmentBudget <= 0) break;
    }

    const data = buildRoadRibbonData(polylines, terrainHeight);
    this._applyGeometry(data);
    this.mesh.visible = data.indices.length > 0;
    this._built = true;
    this._lastX = cx;
    this._lastZ = cz;
    this.stats.roads = polylines.length;
    this.stats.segments = data.segmentCount;
    this.stats.bridges = data.bridgeCount;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
    if (this.scene && typeof this.scene.remove === 'function') this.scene.remove(this.mesh);
  }
}