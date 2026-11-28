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
  // Sharper anisotropic filtering (Three.js clamps to maxAnisotropy on GPU) so
  // the dashed centre line and shoulder lines stay smooth on distant highway
  // ribbons at shallow grazing angles instead of flickering.
  t.anisotropy = 8;
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
  const piers = [];
  let vbase = 0;
  let segmentCount = 0;
  let bridgeCount = 0;

  const lines = Array.isArray(polylines) ? polylines : [];
  for (const line of lines) {
    if (!line) continue;
    const width = Number.isFinite(line.width) ? Math.max(0.5, line.width) : 9;
    const halfW = width * 0.5;
    const isBridge = line.bridge === true;
    const src = sanitizePoints(line.points);
    if (src.length < 2) continue;
    const pts = resamplePolyline(src, SAMPLE_STEP);
    const n = pts.length;
    if (n < 2) continue;

    const dist = new Float64Array(n);
    const localH = new Float64Array(n);
    const deckY = new Float64Array(n);
    const rightX = new Float64Array(n);
    const rightZ = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (i > 0) dist[i] = dist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      localH[i] = safeHeight(hFn, pts[i].x, pts[i].z);
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

    if (isBridge) {
      const hStart = localH[0];
      const hEnd = localH[n - 1];
      const totalD = dist[n - 1] || 1;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const rx = rightX[i];
        const rz = rightZ[i];
        const hL = safeHeight(hFn, p.x - rx * halfW, p.z - rz * halfW);
        const hR = safeHeight(hFn, p.x + rx * halfW, p.z + rz * halfW);
        // Clear centerline AND both left/right deck edges so a bridge deck on
        // a steep cross-slope never dips under the uphill bank.
        const maxEdgeH = Math.max(localH[i], hL, hR);
        const t = dist[i] / totalD;
        const interp = hStart * (1 - t) + hEnd * t + DECK_LIFT;
        const minDeck = maxEdgeH < WATER_LEVEL
          ? Math.max(BRIDGE_DECK, maxEdgeH + 1.2)
          : (i === 0 || i === n - 1 ? maxEdgeH + DECK_LIFT : maxEdgeH + 1.2);
        deckY[i] = Math.max(interp, minDeck);
      }
      bridgeCount++;
    } else {
      for (let i = 0; i < n; i++) {
        deckY[i] = deckHeightFor(localH[i]);
      }
    }

    // Contiguous water-crossing bridge spans + grounded piers for viaducts & coastal bridges.
    if (isBridge) {
      let lastPierDist = -1e9;
      let emittedForBridge = false;
      let deepestIdx = -1;
      let deepestClear = 0;
      for (let i = 1; i < n - 1; i++) {
        const clear = deckY[i] - localH[i];
        if (clear > deepestClear) {
          deepestClear = clear;
          deepestIdx = i;
        }
        if (clear > 1.8 && dist[i] - lastPierDist >= 45) {
          const tx = rightZ[i];
          const tz = -rightX[i];
          piers.push({
            x: pts[i].x,
            z: pts[i].z,
            topY: deckY[i] - 0.4,
            bottomY: localH[i] < WATER_LEVEL ? Math.min(localH[i] - 5.0, -3.5) : localH[i] - 5.0,
            width: Math.max(2.2, width * 0.72),
            rot: Math.atan2(tx, tz),
          });
          lastPierDist = dist[i];
          emittedForBridge = true;
        }
      }
      if (!emittedForBridge && deepestIdx >= 0 && deepestClear > 1.8) {
        const i = deepestIdx;
        const tx = rightZ[i];
        const tz = -rightX[i];
        piers.push({
          x: pts[i].x,
          z: pts[i].z,
          topY: deckY[i] - 0.4,
          bottomY: localH[i] < WATER_LEVEL ? Math.min(localH[i] - 5.0, -3.5) : localH[i] - 5.0,
          width: Math.max(2.2, width * 0.72),
          rot: Math.atan2(tx, tz),
        });
      }
    } else {
      let inBridge = false;
      let lastWetPierDist = -1e9;
      for (let i = 0; i < n; i++) {
        const wet = localH[i] < WATER_LEVEL;
        if (wet) {
          if (!inBridge) { bridgeCount++; inBridge = true; }
          if (dist[i] - lastWetPierDist >= 40) {
            const tx = rightZ[i];
            const tz = -rightX[i];
            piers.push({
              x: pts[i].x,
              z: pts[i].z,
              topY: deckY[i] - 0.4,
              bottomY: Math.min(localH[i], -3.5),
              width: Math.max(2.2, width * 0.72),
              rot: Math.atan2(tx, tz),
            });
            lastWetPierDist = dist[i];
          }
        } else {
          inBridge = false;
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const rx = rightX[i];
      const rz = rightZ[i];
      const xl = p.x - rx * halfW;
      const zl = p.z - rz * halfW;
      const xr = p.x + rx * halfW;
      const zr = p.z + rz * halfW;
      // Bridged spans stay level across the carriageway; ground-hugging roads
      // sample each edge directly beneath it so cross-slopes never lift/bury.
      const yl = isBridge ? deckY[i] : deckHeightFor(safeHeight(hFn, xl, zl));
      const yr = isBridge ? deckY[i] : deckHeightFor(safeHeight(hFn, xr, zr));
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
    piers,
  };
}

/** Merge bridge pier descriptors into a single BufferGeometry of concrete columns. */
function buildPierGeometry(piers) {
  const geo = new THREE.BufferGeometry();
  if (!Array.isArray(piers) || piers.length === 0) return geo;

  const count = piers.length;
  // 24 vertices (4 per face * 6 faces) and 36 indices per box.
  const pos = new Float32Array(count * 24 * 3);
  const norm = new Float32Array(count * 24 * 3);
  const idx = new Uint32Array(count * 36);
  let vp = 0;
  let ip = 0;

  const faces = [
    // +X
    { n: [1, 0, 0], c: [[0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [0.5, 0, 0.5]] },
    // -X
    { n: [-1, 0, 0], c: [[-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5], [-0.5, 0, -0.5]] },
    // +Z
    { n: [0, 0, 1], c: [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]] },
    // -Z
    { n: [0, 0, -1], c: [[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]] },
    // +Y
    { n: [0, 1, 0], c: [[-0.5, 1, -0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5]] },
    // -Y
    { n: [0, -1, 0], c: [[-0.5, 0, 0.5], [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5]] },
  ];

  for (let i = 0; i < count; i++) {
    const pr = piers[i];
    const h = Math.max(1.0, pr.topY - pr.bottomY);
    const w = Math.max(1.5, pr.width || 6.0);
    const t = Math.min(2.6, Math.max(1.4, w * 0.28)); // thickness along road
    const c = Math.cos(pr.rot || 0);
    const s = Math.sin(pr.rot || 0);

    for (let f = 0; f < 6; f++) {
      const face = faces[f];
      const base = vp;
      const fnx = face.n[0] * c + face.n[2] * s;
      const fny = face.n[1];
      const fnz = -face.n[0] * s + face.n[2] * c;
      for (let k = 0; k < 4; k++) {
        const corner = face.c[k];
        const lx = corner[0] * w;
        const ly = pr.bottomY + corner[1] * h;
        const lz = corner[2] * t;
        pos[vp * 3] = pr.x + lx * c + lz * s;
        pos[vp * 3 + 1] = ly;
        pos[vp * 3 + 2] = pr.z - lx * s + lz * c;
        norm[vp * 3] = fnx;
        norm[vp * 3 + 1] = fny;
        norm[vp * 3 + 2] = fnz;
        vp++;
      }
      idx[ip++] = base;
      idx[ip++] = base + 1;
      idx[ip++] = base + 2;
      idx[ip++] = base;
      idx[ip++] = base + 2;
      idx[ip++] = base + 3;
    }
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
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
      // Stronger than the inland-water offset (-1/-1): a viaduct deck crossing
      // a river sheet must always win the depth test.
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });

    // VI PER-ATMOS parity for asphalt: a far ribbon must dissolve into the same
    // height-aware Rayleigh + Mie air as the terrain heightfield instead of
    // staying a crisp dark line across a hazy valley. The formula is injected
    // into the stock Lambert program so the map, lighting and fog chain stay
    // untouched; `uRoad*` uniforms are shared with `update(camera, sky)`.
    this._atmosUniforms = {
      uRoadSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.2) },
      uRoadSunColor: { value: new THREE.Color(0xfff2d0) },
      uRoadSkyColor: { value: new THREE.Color(0x8fb4c8) },
    };
    this.material.customProgramCacheKey = () => 'road-aerial-v1';
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uRoadSunDir = this._atmosUniforms.uRoadSunDir;
      shader.uniforms.uRoadSunColor = this._atmosUniforms.uRoadSunColor;
      shader.uniforms.uRoadSkyColor = this._atmosUniforms.uRoadSkyColor;

      shader.vertexShader = 'varying vec3 vRoadWorld;\n' + shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        /* glsl */`#include <worldpos_vertex>
        vRoadWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );

      shader.fragmentShader = 'uniform vec3 uRoadSunDir, uRoadSunColor, uRoadSkyColor;\n'
        + 'varying vec3 vRoadWorld;\n' + shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          /* glsl */`
        // Identical Rayleigh + Mie aerial perspective to terrainview.js
        // (VI PER-ATMOS), driven by the same uSunDir/uSunColor/uSkyColor. It is
        // applied to the linear outgoingLight BEFORE tonemapping and color-space
        // encoding — exactly where terrainview.js runs it — so asphalt hazes on
        // the same physical curve as the heightfield instead of on an encoded one.
        {
          float roadDist = length( cameraPosition - vRoadWorld );
          vec3 roadViewDir = normalize( vRoadWorld - cameraPosition );
          float dayVis = smoothstep( -0.05, 0.25, uRoadSunDir.y );
          float lowAir = 1.0 - smoothstep( 100.0, 2600.0, 0.5 * ( cameraPosition.y + vRoadWorld.y ) );
          float aerialT = 1.0 - exp( -roadDist * ( 0.000024 + lowAir * 0.000020 ) );
          aerialT = clamp( aerialT * smoothstep( 2500.0, 9000.0, roadDist ), 0.0, 0.72 );
          vec3 rayleighBlue = mix( vec3( 0.42, 0.58, 0.80 ), vec3( 0.54, 0.68, 0.86 ),
            smoothstep( 0.0, 0.5, uRoadSunDir.y ) );
          rayleighBlue = mix( rayleighBlue, uRoadSkyColor, 0.16 * dayVis );
          float sunAlign = max( dot( roadViewDir, uRoadSunDir ), 0.0 );
          float miePhase = pow( sunAlign, 4.0 ) * 0.65 + pow( sunAlign, 18.0 ) * 0.35;
          vec3 dustGlow = mix( vec3( 0.92, 0.76, 0.56 ), uRoadSunColor, 0.55 );
          vec3 atmosCol = mix( rayleighBlue, dustGlow,
            clamp( miePhase * ( 0.45 + lowAir * 0.40 ), 0.0, 0.72 ) );
          float distDesat = aerialT * 0.35 * dayVis;
          float roadLum = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
          outgoingLight = mix( outgoingLight, vec3( roadLum ), distDesat );
          outgoingLight = mix( outgoingLight, atmosCol, aerialT * 0.62 * dayVis );
          outgoingLight += dustGlow * miePhase * aerialT * 0.14 * dayVis * ( 0.5 + 0.5 * lowAir );
        }
        #include <opaque_fragment>`,
        );
    };

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'highways';
    // Drawn after inland water (renderOrder 0) so highways/viaducts layer on
    // top of rivers and lakes instead of z-fighting with them.
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;

    // Concrete piers supporting elevated OSM viaducts and coastal bridges,
    // attached as a child of `this.mesh` so `scene.add` stays a single call.
    this.pierMaterial = new THREE.MeshLambertMaterial({ color: 0x8f8e88 });
    this.pierMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.pierMaterial);
    this.pierMesh.name = 'highway-piers';
    this.pierMesh.frustumCulled = false;
    this.pierMesh.visible = false;
    this.mesh.add(this.pierMesh);

    if (scene && typeof scene.add === 'function') scene.add(this.mesh);
    this._lastX = Infinity;
    this._lastZ = Infinity;
    this._built = false;
    // Baked real-world roads ({ width, points, bridge }) or null for procedural links.
    this.customRoads = null;
    this.stats = { roads: 0, segments: 0, bridges: 0, piers: 0 };
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
      const bridge = r.b === 1 || r.bridge === true;
      roads.push({ width, points, bridge });
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

    const oldPiers = this.pierMesh.geometry;
    const pierGeo = buildPierGeometry(data.piers);
    this.pierMesh.geometry = pierGeo;
    this.pierMesh.visible = Array.isArray(data.piers) && data.piers.length > 0;
    if (oldPiers && oldPiers !== pierGeo) oldPiers.dispose();
  }

  _clear() {
    this._applyGeometry({
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: new Uint32Array(0),
      segmentCount: 0,
      bridgeCount: 0,
      piers: [],
    });
    this.mesh.visible = false;
    this._built = false;
    this._lastX = Infinity;
    this._lastZ = Infinity;
    this.stats.roads = 0;
    this.stats.segments = 0;
    this.stats.bridges = 0;
    this.stats.piers = 0;
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
    this.stats.piers = data.piers.length;
  }

  update(camera, sky = null) {
    if (!camera || !camera.position) return;
    // Keep the road haze in the same atmosphere as the sky dome. `sky` is
    // optional so a one-argument caller (and headless tests) behaves as before.
    if (sky) {
      const a = this._atmosUniforms;
      if (sky.sunDir) a.uRoadSunDir.value.copy(sky.sunDir);
      if (sky.sunColor) a.uRoadSunColor.value.copy(sky.sunColor);
      if (sky.skyColor) a.uRoadSkyColor.value.copy(sky.skyColor);
    }
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
        polylines.push({ width, points: run, bridge: Boolean(road.bridge) });
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
    this.stats.piers = data.piers.length;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
    this.pierMesh?.geometry.dispose();
    this.pierMaterial?.dispose();
    this.mesh.removeFromParent();
    if (this.scene && typeof this.scene.remove === 'function') this.scene.remove(this.mesh);
  }
}