// Inland water: real OpenStreetMap rivers & lakes draped over the terrain.
//
// The baked Vipava theater ships `media/vipava_water.json` with river
// polylines (`{ w, pts }`) and closed lake polygons (`[[x, z], ...]`). This
// module turns that payload into one merged, headless-safe BufferGeometry and
// renders it with a reflective emerald-blue shader tuned to the Soča/Vipava
// palette.
//
// Nothing here touches `document` / WebGL at import time, and every entry
// point tolerates `scene === null`, so Node unit tests can exercise the whole
// builder and system without a browser.

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

const RIVER_STEP_M = 25; // resample distance along a river centreline
const RIVER_LIFT_M = 0.35; // metres above the terrain surface
// The drawn strip is a touch wider than the OSM waterway width so the shader
// has room to feather an organic, noise-warped bank contour into the terrain
// instead of ending on a hard geometric edge.
const RIVER_WIDTH_SCALE = 1.38;
// The Adriatic plane sits 0.45 m below y=0 and the coastal deltas around
// Monfalcone / Grado are only 0..2 m high. Inland ribbons must stay clear of
// that band entirely, otherwise the sea plane and the river sheet Z-fight.
const SEA_CUTOFF_M = 1.8; // below this the Adriatic Sea plane takes over
// A lake sheet sits this far above the higher of its median shoreline height
// and its basin centre. Using the minimum shoreline height would bury every
// dammed reservoir: the dam foot is far lower than the basin, so
// `min + 0.45` lands the surface underground (Vogrscek).
const LAKE_LIFT_M = 0.85;
// Same reasoning for lakes: a lagoon surface pinned near y=0 collides with the
// sea plane across the whole Grado marsh. 2.0 m keeps every lake sheet above
// the sea plane's offset band.
const LAKE_MIN_Y = 2.0;
const LAKE_PERIMETER_STEP_M = 30;

// ---------------------------------------------------------------------------
// Pure geometry builder
// ---------------------------------------------------------------------------

/** Evenly resample a polyline every `step` metres (keeps both endpoints). */
function resamplePolyline(pts, step) {
  const out = [];
  if (!pts || pts.length === 0) return out;
  const first = pts[0];
  if (!Array.isArray(first) || !Number.isFinite(first[0]) || !Number.isFinite(first[1])) {
    return out;
  }
  out.push([first[0], first[1]]);
  if (pts.length === 1) return out;

  let prev = out[0];
  let sinceEmit = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const ax = prev[0];
    const az = prev[1];
    const bx = p[0];
    const bz = p[1];
    const segLen = Math.hypot(bx - ax, bz - az);
    if (!(segLen > 1e-6)) continue;

    let d = step - sinceEmit; // distance into this segment to the next sample
    while (d <= segLen) {
      const t = d / segLen;
      out.push([ax + (bx - ax) * t, az + (bz - az) * t]);
      d += step;
    }
    // Distance still travelled since the last emitted sample.
    sinceEmit = segLen - (d - step);
    prev = [bx, bz];
  }

  const tail = prev;
  const last = out[out.length - 1];
  if (Math.hypot(tail[0] - last[0], tail[1] - last[1]) > 1.0) {
    out.push([tail[0], tail[1]]);
  }
  return out;
}

/** Push a triangle, flipping the winding so its face normal points +Y. */
function pushTriUp(indices, positions, a, b, c) {
  const ax = positions[a * 3];
  const az = positions[a * 3 + 2];
  const bx = positions[b * 3];
  const bz = positions[b * 3 + 2];
  const cx = positions[c * 3];
  const cz = positions[c * 3 + 2];
  // cross.y of (B-A) x (C-A) for a horizontal triangle.
  const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  if (crossY >= 0) indices.push(a, b, c);
  else indices.push(a, c, b);
}

/**
 * Area-weighted centroid of a closed [x, z] polygon (vertex mean when the
 * polygon is degenerate).
 */
function polygonCentroid(pts) {
  let area2 = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const cross = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    area2 += cross;
    cx += (pts[j][0] + pts[i][0]) * cross;
    cz += (pts[j][1] + pts[i][1]) * cross;
  }
  if (Math.abs(area2) > 1e-9) return [cx / (3 * area2), cz / (3 * area2)];
  let sx = 0;
  let sz = 0;
  for (const [x, z] of pts) { sx += x; sz += z; }
  return [sx / pts.length, sz / pts.length];
}

/**
 * Sample terrain heights evenly around a lake shoreline (every
 * `LAKE_PERIMETER_STEP_M`), skipping non-finite samples.
 */
function samplePerimeterHeights(pts, heightAt) {
  const hs = [];
  let prev = pts[0];
  for (let i = 1; i <= pts.length; i++) {
    const cur = pts[i % pts.length];
    const segLen = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const steps = Math.max(1, Math.ceil(segLen / LAKE_PERIMETER_STEP_M));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const x = prev[0] + (cur[0] - prev[0]) * t;
      const z = prev[1] + (cur[1] - prev[1]) * t;
      const h = heightAt(x, z);
      if (Number.isFinite(h)) hs.push(h);
    }
    prev = cur;
  }
  return hs;
}

/**
 * Sample the terrain around a lake perimeter and pick a single flat level.
 *
 * The level must clear both the typical shoreline and the basin centre: a
 * dammed reservoir's dam foot can sit >10 m below the basin, so taking the
 * minimum perimeter height (the old `minPerimeterH + 0.45`) puts the whole
 * sheet underground. The median shoreline plus the centre height is robust to
 * a handful of low dam samples.
 *
 * `sortedHs` may be passed when the caller has already sampled (and sorted)
 * the perimeter in order to run the sloping-riverbank filter.
 *
 * Returns NaN when the polygon yields no usable samples.
 */
function lakeWaterLevel(pts, heightAt, sortedHs) {
  const hs = sortedHs || samplePerimeterHeights(pts, heightAt).sort((a, b) => a - b);
  if (hs.length === 0) return NaN;

  const medianPerimeterH = hs[Math.floor(hs.length * 0.5)];
  const [cx, cz] = polygonCentroid(pts);
  const centerH = heightAt(cx, cz);
  const baseH = Math.max(medianPerimeterH, Number.isFinite(centerH) ? centerH : medianPerimeterH);
  return Math.max(LAKE_MIN_Y, baseH + LAKE_LIFT_M);
}

/** Drop a duplicated closing vertex, if present. */
function openPolygon(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return null;
  const out = [];
  for (const p of pts) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    out.push([p[0], p[1]]);
  }
  const a = out[0];
  const b = out[out.length - 1];
  if (out.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) out.pop();
  return out.length >= 3 ? out : null;
}

/**
 * Standard even-odd ray-casting point-in-polygon test for an open [x, z]
 * contour. Points exactly on an edge are not guaranteed either way, which is
 * fine: river samples are resampled every 25 m and never land on a shoreline.
 */
function pointInPolygon2D(x, z, contour) {
  let inside = false;
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const xi = contour[i][0];
    const zi = contour[i][1];
    const xj = contour[j][0];
    const zj = contour[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * True when (x, z) lies inside any prepared lake/water polygon. AABB
 * rejection keeps this cheap: OSM ships 351 water polygons and 1,124 rivers,
 * so a naive all-polygon raycast per river sample would be ~8 M edge tests.
 */
function pointInLakePolygons(x, z, preparedLakes) {
  for (let i = 0; i < preparedLakes.length; i++) {
    const lake = preparedLakes[i];
    if (x < lake.minX || x > lake.maxX || z < lake.minZ || z > lake.maxZ) continue;
    if (pointInPolygon2D(x, z, lake.contour)) return true;
  }
  return false;
}

/** Signed area of a polygon in the (x, z) plane (positive = CCW). */
function signedArea2D(pts) {
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    area += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return area * 0.5;
}

/**
 * Build one merged BufferGeometry payload for the OSM inland water extract.
 *
 * @param {{rivers?: Array<{w:number, pts:Array<[number,number]>}>,
 *          lakes?: Array<Array<[number,number]>>}|null} data
 * @param {(x:number, z:number) => number} heightAt
 * @returns {{positions: Float32Array, normals: Float32Array,
 *            uvs: Float32Array, indices: Uint32Array,
 *            riverSegments: number, lakeCount: number,
 *            filteredSlopedBanks: number}}
 */
export function buildInlandWaterGeometry(data, heightAt) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let riverSegments = 0;
  let lakeCount = 0;

  const rivers = Array.isArray(data?.rivers) ? data.rivers : [];
  const lakes = Array.isArray(data?.lakes) ? data.lakes : [];

  // -- Pre-collect water polygons & AABBs ------------------------------------
  // OSM maps wide rivers (Soča, Vipava, Isonzo) and reservoirs as BOTH
  // `natural=water` polygons and `waterway=river` centrelines, so 22% of the
  // resampled river vertices land inside a water polygon. Collecting every
  // valid polygon up front lets the river pass clip those samples instead of
  // stacking a ribbon 0.35 m above the 0.85 m lake sheet.
  const preparedLakes = [];
  let filteredSlopedBanks = 0;
  for (const raw of lakes) {
    const contour = openPolygon(raw);
    if (!contour) continue;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of contour) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const hs = samplePerimeterHeights(contour, heightAt);
    if (hs.length === 0) continue;

    // OSM `natural=water` also maps long, narrow riverbank polygons (Tolmin
    // Soča Lake, Solkan, Kanal). They drop tens of metres along their length,
    // so a single flat level would bury the upstream half and float the
    // downstream half. Detect them and let the continuous river ribbon draw
    // the reach instead; real lakes, ponds and dammed reservoirs are compact
    // (or flat) and stay in `preparedLakes`.
    const area = Math.abs(signedArea2D(contour));
    let perimeter = 0;
    for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
      perimeter += Math.hypot(
        contour[i][0] - contour[j][0],
        contour[i][1] - contour[j][1],
      );
    }
    const avgWidth = perimeter > 0 ? (2 * area) / perimeter : Infinity;
    const span = Math.hypot(maxX - minX, maxZ - minZ);
    hs.sort((a, b) => a - b);
    const p10 = hs[Math.floor(hs.length * 0.1)];
    const p90 = hs[Math.floor(hs.length * 0.9)];
    const spread = p90 - p10;
    if (span > 350 && avgWidth < 110
        && (span / Math.max(avgWidth, 1)) > 4.5 && spread > 3.5) {
      filteredSlopedBanks++;
      continue;
    }

    const level = lakeWaterLevel(contour, heightAt, hs);
    if (!Number.isFinite(level)) continue;

    preparedLakes.push({ minX, maxX, minZ, maxZ, contour, level });
  }

  // -- Rivers: ribbon strip, resampled evenly along the centreline ----------
  for (const river of rivers) {
    if (!river || !Array.isArray(river.pts)) continue;
    const samples = resamplePolyline(river.pts, RIVER_STEP_M);
    if (samples.length < 2) continue;
    const halfWidth = Math.max(1.5, (Number.isFinite(river.w) ? river.w : 15) * 0.5);

    // Sample every centreline height first: the flow direction depends on the
    // whole reach, not on the first run that happens to survive lake clipping.
    const hs = samples.map(([x, z]) => heightAt(x, z));
    const finiteHs = hs.filter(Number.isFinite);
    if (finiteHs.length >= 2) {
      const edge = Math.min(4, finiteHs.length);
      let startSum = 0;
      let endSum = 0;
      for (let k = 0; k < edge; k++) {
        startSum += finiteHs[k];
        endSum += finiteHs[finiteHs.length - 1 - k];
      }
      // OSM ways run either direction; make index 0 the upstream end.
      if (startSum < endSum) {
        samples.reverse();
        hs.reverse();
      }
    }

    // Emit one ribbon per contiguous kept run, with a strictly non-increasing
    // downstream elevation. Both banks share the centreline's level, so a
    // river in a steep canyon (Sabotin) is never tilted sideways up the cliff.
    //
    // UVs carry (across, downstream metres): `vUv.x` is the bank parameter
    // (0 left, 1 right) and `vUv.y` is the cumulative distance `s` travelled
    // along the run. The shader uses `s` both to advect flow streaks and to
    // modulate the local width, so a reach swells into pools on the flats and
    // pinches into rocky drops instead of staying a conveyor belt of constant
    // width. The phase seed is derived from the first sample, so every river
    // gets its own deterministic pool/rifle rhythm.
    const seed = samples[0][0] * 0.013 + samples[0][1] * 0.017;

    const emitRun = (run) => {
      let prevPair = null;
      let monoY = NaN;
      let s = 0;
      let prevX = NaN;
      let prevZ = NaN;
      for (let k = 0; k < run.length; k++) {
        const sampleIndex = run[k];
        const [x, z] = samples[sampleIndex];
        const hCentre = hs[sampleIndex];
        monoY = Number.isFinite(monoY) ? Math.min(monoY, hCentre) : hCentre;
        const waterY = monoY + RIVER_LIFT_M;

        // Cumulative downstream distance (metres) along this run.
        if (Number.isFinite(prevX)) s += Math.hypot(x - prevX, z - prevZ);
        prevX = x;
        prevZ = z;

        // Organic width: wide pools, gravel bends and narrow rocky reaches.
        const wVar = 0.85
          + 0.16 * Math.sin(s * 0.011 + seed)
          + 0.10 * Math.cos(s * 0.027 - seed * 1.7);
        const localHalfWidth = halfWidth * RIVER_WIDTH_SCALE * wVar;

        // Tangent from the neighbours (one-sided at the ends).
        const a = samples[Math.max(0, sampleIndex - 1)];
        const b = samples[Math.min(samples.length - 1, sampleIndex + 1)];
        let dx = b[0] - a[0];
        let dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (!(len > 1e-6)) {
          prevPair = null;
          continue;
        }
        dx /= len;
        dz /= len;
        const nx = -dz * localHalfWidth;
        const nz = dx * localHalfWidth;

        const leftIdx = positions.length / 3;
        positions.push(x - nx, waterY, z - nz);
        normals.push(0, 1, 0);
        uvs.push(0, s);
        const rightIdx = positions.length / 3;
        positions.push(x + nx, waterY, z + nz);
        normals.push(0, 1, 0);
        uvs.push(1, s);

        if (prevPair) {
          const [pl, pr] = prevPair;
          pushTriUp(indices, positions, pl, pr, leftIdx);
          pushTriUp(indices, positions, pr, rightIdx, leftIdx);
          riverSegments++;
        }
        prevPair = [leftIdx, rightIdx];
      }
    };

    let run = [];
    for (let i = 0; i < samples.length; i++) {
      const [x, z] = samples[i];
      const hCentre = hs[i];
      // The water polygon owns everything inside its shoreline, and the sea
      // plane owns everything at/below sea level: break the strip so no
      // triangle spans the gap.
      const drop = !Number.isFinite(hCentre) || hCentre <= SEA_CUTOFF_M
        || pointInLakePolygons(x, z, preparedLakes);
      if (drop) {
        if (run.length) emitRun(run);
        run = [];
        continue;
      }
      run.push(i);
    }
    if (run.length) emitRun(run);
  }

  // -- Lakes: one flat level per polygon, earcut triangulation -------------
  for (const lake of preparedLakes) {
    const { contour, level } = lake;

    // +Y faces need clockwise winding in the (x, z) plane; flip if CCW.
    const winding = contour.slice();
    if (signedArea2D(winding) > 0) winding.reverse();

    const shapePts = winding.map(([x, z]) => new THREE.Vector2(x, z));
    let faces;
    try {
      faces = THREE.ShapeUtils.triangulateShape(shapePts, []);
    } catch {
      continue;
    }
    if (!Array.isArray(faces) || faces.length === 0) continue;

    const base = positions.length / 3;
    for (const [x, z] of winding) {
      positions.push(x, level, z);
      normals.push(0, 1, 0);
      // Lakes are flagged with a negative across coordinate so the shader can
      // skip the river ribbon path (banks, flow advection, riffles) entirely.
      uvs.push(-1, 0);
    }
    for (const face of faces) {
      if (!face || face.length !== 3) continue;
      pushTriUp(indices, positions, base + face[0], base + face[1], base + face[2]);
    }
    lakeCount++;
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    riverSegments,
    lakeCount,
    filteredSlopedBanks,
  };
}

// ---------------------------------------------------------------------------
// Scene system
// ---------------------------------------------------------------------------

export class InlandWaterSystem {
  /**
   * @param {THREE.Scene|null} scene — null keeps everything headless-safe.
   */
  constructor(scene = null) {
    this.scene = scene;
    this.mesh = null;
    this.geometry = null;
    this.material = this._createMaterial();
  }

  _createMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.2) },
        uSunColor: { value: new THREE.Color(0xfff2d0) },
        uSkyColor: { value: new THREE.Color(0x8fb4c8) },
        // Soča-style alpine palette (linear space, like WaterSurface): sampled
        // from real satellite photography of the river, which reads as a muted
        // glacial emerald-teal — a dark slate-emerald channel shading up to a
        // soft desaturated turquoise-green on the gravel shelves.
        uDeep: { value: new THREE.Color(0x1c555f).convertSRGBToLinear() },
        uShallow: { value: new THREE.Color(0x326d6a).convertSRGBToLinear() },
        fogColor: { value: new THREE.Color(0x9fb9c9) },
        fogDensity: { value: 0.00002 },
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        // Ribbon UVs: x = bank parameter (0 left .. 1 right, negative for
        // lakes), y = cumulative downstream distance in metres.
        varying vec2 vUv;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vUv = uv;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uSunDir, uSunColor, uSkyColor, uDeep, uShallow;
        varying vec3 vWorld;
        varying vec2 vUv;
        #include <common>
        #include <fog_pars_fragment>

        // --- 2D quintic value noise with analytic derivatives ----------------
        float rHash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        // Returns (value, d/dx, d/dy). Quintic smoothstep gives C2 continuity,
        // so drifting ripples never show the facet seams of linear noise.
        vec3 rNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
          vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

          float a = rHash(i + vec2(0.0, 0.0));
          float b = rHash(i + vec2(1.0, 0.0));
          float c = rHash(i + vec2(0.0, 1.0));
          float d = rHash(i + vec2(1.0, 1.0));

          float k1 = b - a;
          float k2 = c - a;
          float k3 = a - b - c + d;

          float v = a + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
          vec2 dv = du * vec2(k1 + k3 * u.y, k2 + k3 * u.x);
          return vec3(v, dv);
        }

        // One rotated, drifting ripple octave at world wavelength L (metres).
        // Returns (height, dH/dx, dH/dz) where the gradient already includes
        // the 1/L world-space scaling.
        vec3 rLayer(vec2 p, float L, float angle, vec2 drift, float t) {
          float ca = cos(angle);
          float sa = sin(angle);
          mat2 rot = mat2(ca, -sa, sa, ca);
          vec3 n = rNoise(rot * (p + drift * t) / L);
          vec2 grad = (n.yz * rot) / L;
          return vec3(n.x, grad.x, grad.y);
        }

        // Screen-space Nyquist filter: fade an octave out once a pixel footprint
        // approaches its wavelength, so narrow rivers never shimmer.
        float rNyquist(float L, float px) {
          return 1.0 - smoothstep(L * 0.10, L * 0.45, px);
        }

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);
          vec2 p = vWorld.xz;
          float t = uTime;
          float pixSize = max(length(fwidth(p)), 0.05);

          // Three counter-drifting, rotated ripple octaves (4 / 12 / 36 m) plus
          // a slow 2D macro patch (180 m) that keeps kilometre-long reaches
          // from looking uniformly tiled.
          float w4 = 0.030 * rNyquist(4.0, pixSize);
          float w12 = 0.140 * rNyquist(12.0, pixSize);
          float w36 = 0.500 * rNyquist(36.0, pixSize);
          float w180 = 0.560 * rNyquist(180.0, pixSize);

          vec3 o4 = rLayer(p, 4.0, 0.35, vec2(0.90, 0.35), t);
          vec3 o12 = rLayer(p, 12.0, -0.60, vec2(-0.45, 0.60), t * 0.80);
          vec3 o36 = rLayer(p, 36.0, 1.10, vec2(0.22, -0.16), t * 0.55);
          vec3 m180 = rLayer(p, 180.0, 0.20, vec2(0.035, 0.02), t * 0.30);

          // -- River cross-section frame -------------------------------------
          // Rivers carry (across, downstream metres) in the uv. The bank
          // contour is warped by the three world-space noise octaves already
          // in hand plus a bend asymmetry from the 180 m patch, so gravel bars
          // crowd the outside of a bend and the rim never shows a straight
          // polygon edge. Lakes (vUv.x = -1) skip this entirely.
          float across = clamp(vUv.x, 0.0, 1.0);
          float centerDist = 1.0 - abs(across * 2.0 - 1.0);
          bool isRiver = vUv.x > -0.25;
          float edgeAlpha = 1.0;
          float riverMask = 1.0;
          if (isRiver) {
            float bankWarp = (o36.x - 0.5) * 0.36
              + (o12.x - 0.5) * 0.24
              + (o4.x - 0.5) * 0.12
              + (m180.x - 0.5) * 0.18 * (across * 2.0 - 1.0);
            riverMask = centerDist + bankWarp;
            // Feather the outermost rim into the terrain; the fragment is
            // discarded well before it can read as a cut-out polygon.
            edgeAlpha = smoothstep(0.06, 0.24, riverMask);
            if (edgeAlpha < 0.01) discard;
          }

          // Animated current: noise advected downstream in ribbon space, so
          // streaks crawl with the water instead of drifting in world space.
          float flowN = 0.5;
          float flowAmp = 0.0;
          float flowStreak = 0.0;
          float riffle = 0.0;
          vec2 flowTilt = vec2(0.0);
          if (isRiver) {
            vec2 flowCoord = vec2(
              across * 6.5 + (o12.x - 0.5) * 1.2,
              vUv.y * 0.045 - t * 0.55);
            vec3 flowSample = rNoise(flowCoord);
            flowN = flowSample.x;
            flowAmp = smoothstep(0.06, 0.30, riverMask);
            flowStreak = smoothstep(0.44, 0.80, flowN) * flowAmp;
            // Whitewater riffles: current lines breaking over shallow gravel
            // ledges only, and faded by the Nyquist filter as they recede.
            riffle = smoothstep(0.68, 0.88, flowN * 0.65 + o4.x * 0.55)
              * smoothstep(0.16, 0.34, riverMask)
              * (1.0 - smoothstep(0.48, 0.78, riverMask))
              * rNyquist(4.0, pixSize);
            // Analytic gradient of the flow field: stretched along the
            // current, giving the thin specular streaks of moving water.
            flowTilt = vec2(flowSample.y, flowSample.z * 0.45) * 0.020 * flowAmp;
          }

          float rippleH = o4.x * w4 + o12.x * w12 + o36.x * w36
            + (m180.x - 0.5) * w180
            + (flowN - 0.5) * 0.26 * flowAmp;
          vec2 rippleG = o4.yz * w4 + o12.yz * w12 + o36.yz * w36 + m180.yz * w180;

          // Gentle normal tilt: cap the horizontal slope at 0.075 so distant
          // water stays a smooth sheet rather than a crumpled mirror.
          vec2 tilt = rippleG + flowTilt;
          float tiltLen = length(tilt);
          if (tiltLen > 0.075) tilt *= 0.075 / tiltLen;
          vec3 n = normalize(vec3(tilt.x, 1.0, tilt.y));

          // Water darkens toward dusk and reads as near-black at night.
          float dayLum = mix(0.14, 1.0, smoothstep(-0.08, 0.35, uSunDir.y));

          float macroVal = m180.x;
          float depthMix = clamp(0.42 + rippleH * 0.8 + (macroVal - 0.5) * 0.35, 0.12, 0.88);
          if (isRiver) {
            // Cross-channel depth: the ribbon's own rim-to-centre distance
            // drives the colour far more than world-space noise, so every
            // reach reads as a shallow gravel shelf shading into a deep
            // emerald thalweg that follows the meander.
            depthMix = mix(depthMix, 1.0 - smoothstep(0.18, 0.68, riverMask), 0.72);
          }
          vec3 body = mix(uDeep, uShallow, depthMix);

          // Limestone gravel-bar shoals: a very gentle pale green-sand brightening
          // of the sheet, modulated by the 180 m macro patch and the 36 m octave.
          // Kept deliberately weak (0.05..0.14) so the water stays true Soča
          // emerald-teal — natural brightness variation, zero brown muddiness.
          vec3 shoalCol = vec3(0.18, 0.22, 0.16);
          float shoalAmt = 0.05
            + 0.05 * macroVal
            + 0.04 * o36.x;
          shoalAmt = clamp(shoalAmt, 0.05, 0.14);
          body = mix(body, shoalCol, shoalAmt);

          body *= dayLum;

          // Fraction of this pixel covered by the dry/damp gravel bar; drives
          // the specular attenuation after the river block below.
          float gravelBank = 0.0;

          if (isRiver) {
            // Alpine karst shingle banks and the wet-to-submerged transition.
            // Dark river-worn cobbles mottled with pale Soča limestone
            // pebbles, then a luminous shallow turquoise shelf, then the deep
            // teal channel — all feathered by the noise-warped rim.
            vec3 wetCobble = vec3(0.26, 0.27, 0.24);
            vec3 palePebble = vec3(0.42, 0.42, 0.37);
            float pebbleMix = clamp(o4.x * 0.62 + o12.x * 0.38, 0.0, 1.0);
            vec3 gravel = mix(wetCobble, palePebble, pebbleMix) * dayLum;

            float wGravel = 1.0 - smoothstep(0.14, 0.34, riverMask);
            float wDeep = smoothstep(0.44, 0.62, riverMask);
            float wShallow = max(1.0 - wGravel - wDeep, 0.0);

            gravelBank = wGravel;

            vec3 riverWater = mix(uDeep, uShallow, depthMix);
            riverWater = mix(riverWater, uShallow * 1.18, wShallow);
            riverWater *= (0.94 + 0.12 * rippleH) * dayLum;

            body = mix(riverWater, gravel, wGravel);
          }

          // Limestone shingle banks are matte-to-damp stones, not water: kill
          // most of the sky Fresnel and sun glitter where gravel dominates.
          float waterSpecMask = 1.0 - gravelBank * 0.82;

          // Schlick Fresnel toward the sky (F0 = 0.02), soft horizon gradient.
          float F0 = 0.02;
          float fres = F0 + (1.0 - F0) * pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);

          // Inland water sits in a valley and mostly mirrors surrounding terrain and a
          // hazy horizon, not the cobalt zenith. Desaturate the sky toward its own
          // luminance and tint it a neutral-cool mist so grazing-angle reaches
          // never wash the channel electric blue.
          float skyLuma = dot(uSkyColor, vec3(0.2126, 0.7152, 0.0722));
          vec3 mutedSky = mix(vec3(skyLuma), uSkyColor, 0.22) * vec3(0.92, 0.99, 0.96);
          vec3 horizon = mix(mutedSky * 0.82, mutedSky,
            clamp(viewDir.y * 2.0, 0.0, 1.0));
          vec3 col = mix(body, horizon * dayLum, clamp(fres * 0.45, 0.0, 0.30) * waterSpecMask);

          // Soft sun glitter, suppressed when the sun is below the horizon.
          float sunVis = smoothstep(-0.02, 0.12, uSunDir.y);
          vec3 r = reflect(-uSunDir, n);
          float rv = max(dot(r, viewDir), 0.0);
          float spec = pow(rv, 220.0);
          float glitter = pow(rv, 40.0) * 0.06;
          // Shared camera -> surface distance: drives both the far glitter
          // falloff and the aerial perspective pass below.
          float waterDist = length(cameraPosition - vWorld);
          // Distant water must not sparkle through kilometres of valley haze.
          float farGlit = mix(1.0, 0.35, smoothstep(4000.0, 18000.0, waterDist));
          col += uSunColor * (spec * 1.3 + glitter) * sunVis * dayLum * farGlit * waterSpecMask;

          // Thin current streaks: muted sky sheen dragged along the flow
          // direction, strongest when the sun grazes the water.
          if (isRiver) {
            col += vec3(0.42, 0.55, 0.52)
              * flowStreak * (0.05 + 0.09 * sunVis) * dayLum * farGlit;
          }

          // Gentle filmic grade: match the natural satellite-photo saturation — richer
          // than grey, never neon — while sun glitter (added above) and the night
          // darkening baked into dayLum survive.
          float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(luma), col, 0.80);

          // Whitewater riffles: pale foam breaking over the shallow gravel
          // ledges. Crisp but restrained — texture, never cartoon noise.
          if (riffle > 0.001) {
            col = mix(col, vec3(0.68, 0.74, 0.72) * dayLum, riffle * 0.26);
          }

          // VI PER-ATMOS parity: rivers & lakes dissolve into the same
          // height-aware Rayleigh + Mie air as the terrain heightfield, so a
          // distant reach hazes into the valley instead of cutting a dark,
          // high-contrast ribbon across it. viewDir above points from the
          // water surface TO the camera, so the camera -> surface ray is its
          // negation — exactly like terrViewDir = -terrV in terrainview.js.
          vec3 wViewDir = -viewDir;
          float dayVis = smoothstep(-0.05, 0.25, uSunDir.y);
          float lowAir = 1.0 - smoothstep(100.0, 2600.0, 0.5 * (cameraPosition.y + vWorld.y));
          float aerialT = 1.0 - exp(-waterDist * (0.000024 + lowAir * 0.000020));
          aerialT = clamp(aerialT * smoothstep(2500.0, 9000.0, waterDist), 0.0, 0.72);
          vec3 rayleighBlue = mix(vec3(0.42, 0.58, 0.80), vec3(0.54, 0.68, 0.86),
            smoothstep(0.0, 0.5, uSunDir.y));
          rayleighBlue = mix(rayleighBlue, uSkyColor, 0.16 * dayVis);
          float sunAlign = max(dot(wViewDir, uSunDir), 0.0);
          float miePhase = pow(sunAlign, 4.0) * 0.65 + pow(sunAlign, 18.0) * 0.35;
          vec3 dustGlow = mix(vec3(0.92, 0.76, 0.56), uSunColor, 0.55);
          vec3 atmosCol = mix(rayleighBlue, dustGlow,
            clamp(miePhase * (0.45 + lowAir * 0.40), 0.0, 0.72));
          // Distant water loses a little chroma before it is pushed to haze.
          float distDesat = aerialT * 0.35 * dayVis;
          float wLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(col, vec3(wLum), distDesat);
          col = mix(col, atmosCol, aerialT * 0.62 * dayVis);
          col += dustGlow * miePhase * aerialT * 0.14 * dayVis * (0.5 + 0.5 * lowAir);

          gl_FragColor = vec4(col, edgeAlpha);
          #include <fog_fragment>
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      fog: true,
      // The noise-warped bank rim feathers into the terrain through the alpha
      // channel, so the sheet must blend. depthTest stays on so bridge decks
      // and road viaducts that already wrote depth still win the crossing,
      // and depthWrite stays off so overlapping translucent bank rims never
      // leave a dark depth-prepass fringe on the water behind them.
      transparent: true,
      depthTest: true,
      depthWrite: false,
      // Negative polygon offset lifts the water sheet in front of the terrain
      // it lies on, so rivers and lakes never Z-fight with the DEM.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  }

  /**
   * Build & attach the merged water mesh, or clear it when `data == null`.
   * @param {{rivers?: Array, lakes?: Array}|null} data
   * @param {(x:number, z:number) => number} heightAt
   */
  setWaterData(data, heightAt = terrainHeight) {
    this._clearMesh();
    if (!data) return this;

    const built = buildInlandWaterGeometry(data, heightAt);
    if (built.indices.length === 0) return this;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(built.normals, 3));
    if (built.uvs && built.uvs.length === built.positions.length / 3 * 2) {
      geometry.setAttribute('uv', new THREE.BufferAttribute(built.uvs, 2));
    }
    geometry.setIndex(new THREE.BufferAttribute(built.indices, 1));
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'inland-water';
    // Water draws before the road deck (RoadNetwork.renderOrder = 1) so a
    // highway crossing a river/lake never loses the depth tie.
    mesh.renderOrder = 0;
    mesh.userData.riverSegments = built.riverSegments;
    mesh.userData.lakeCount = built.lakeCount;
    mesh.userData.filteredSlopedBanks = built.filteredSlopedBanks;

    this.geometry = geometry;
    this.mesh = mesh;
    if (this.scene) this.scene.add(mesh);
    return this;
  }

  update(dt, sky = null) {
    const u = this.material.uniforms;
    if (Number.isFinite(dt) && dt !== 0) u.uTime.value += dt;
    if (sky) {
      if (sky.sunDir) u.uSunDir.value.copy(sky.sunDir);
      if (sky.sunColor) u.uSunColor.value.copy(sky.sunColor);
      if (sky.skyColor) u.uSkyColor.value.copy(sky.skyColor);
    }
    if (this.scene?.fog) {
      u.fogColor.value.copy(this.scene.fog.color);
      u.fogDensity.value = this.scene.fog.density;
    }
  }

  dispose() {
    this._clearMesh();
    this.material.dispose();
  }

  _clearMesh() {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh = null;
    }
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
  }
}