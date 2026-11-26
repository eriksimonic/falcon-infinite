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
 * Sample the terrain around a lake perimeter and pick a single flat level.
 *
 * The level must clear both the typical shoreline and the basin centre: a
 * dammed reservoir's dam foot can sit >10 m below the basin, so taking the
 * minimum perimeter height (the old `minPerimeterH + 0.45`) puts the whole
 * sheet underground. The median shoreline plus the centre height is robust to
 * a handful of low dam samples.
 *
 * Returns NaN when the polygon yields no usable samples.
 */
function lakeWaterLevel(pts, heightAt) {
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
  if (hs.length === 0) return NaN;

  hs.sort((a, b) => a - b);
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
 *            indices: Uint32Array, riverSegments: number, lakeCount: number}}
 */
export function buildInlandWaterGeometry(data, heightAt) {
  const positions = [];
  const normals = [];
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
  for (const raw of lakes) {
    const contour = openPolygon(raw);
    if (!contour) continue;
    const level = lakeWaterLevel(contour, heightAt);
    if (!Number.isFinite(level)) continue;

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
    preparedLakes.push({ minX, maxX, minZ, maxZ, contour, level });
  }

  // -- Rivers: ribbon strip, resampled evenly along the centreline ----------
  for (const river of rivers) {
    if (!river || !Array.isArray(river.pts)) continue;
    const samples = resamplePolyline(river.pts, RIVER_STEP_M);
    if (samples.length < 2) continue;
    const halfWidth = Math.max(1.5, (Number.isFinite(river.w) ? river.w : 15) * 0.5);

    let prevPair = null; // [leftIdx, rightIdx] of the previous kept sample
    for (let i = 0; i < samples.length; i++) {
      const [x, z] = samples[i];

      // The water polygon owns everything inside its shoreline: drop the
      // ribbon sample and break the strip so no triangle spans the gap.
      if (pointInLakePolygons(x, z, preparedLakes)) {
        prevPair = null;
        continue;
      }

      const hCentre = heightAt(x, z);
      // The sea plane owns everything at/below sea level.
      if (!Number.isFinite(hCentre) || hCentre <= SEA_CUTOFF_M) {
        prevPair = null; // break the strip so no triangle spans the shore
        continue;
      }

      // Tangent from the neighbours (one-sided at the ends).
      const a = samples[Math.max(0, i - 1)];
      const b = samples[Math.min(samples.length - 1, i + 1)];
      let dx = b[0] - a[0];
      let dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (!(len > 1e-6)) continue;
      dx /= len;
      dz /= len;
      const nx = -dz * halfWidth;
      const nz = dx * halfWidth;

      const lx = x - nx;
      const lz = z - nz;
      const rx = x + nx;
      const rz = z + nz;
      const hl = heightAt(lx, lz);
      const hr = heightAt(rx, rz);

      const leftIdx = positions.length / 3;
      positions.push(lx, (Number.isFinite(hl) ? hl : hCentre) + RIVER_LIFT_M, lz);
      normals.push(0, 1, 0);
      const rightIdx = positions.length / 3;
      positions.push(rx, (Number.isFinite(hr) ? hr : hCentre) + RIVER_LIFT_M, rz);
      normals.push(0, 1, 0);

      if (prevPair) {
        const [pl, pr] = prevPair;
        pushTriUp(indices, positions, pl, pr, leftIdx);
        pushTriUp(indices, positions, pr, rightIdx, leftIdx);
        riverSegments++;
      }
      prevPair = [leftIdx, rightIdx];
    }
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
    indices: new Uint32Array(indices),
    riverSegments,
    lakeCount,
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
        // Emerald-blue Soča/Vipava palette (linear space, like WaterSurface).
        uDeep: { value: new THREE.Color(0x103c3d).convertSRGBToLinear() },
        uShallow: { value: new THREE.Color(0x2f8f83).convertSRGBToLinear() },
        fogColor: { value: new THREE.Color(0x9fb9c9) },
        fogDensity: { value: 0.00002 },
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uSunDir, uSunColor, uSkyColor, uDeep, uShallow;
        varying vec3 vWorld;
        #include <common>
        #include <fog_pars_fragment>
        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);
          vec2 p = vWorld.xz;
          float t = uTime;
          // Fade ripple normals out with distance: no sub-pixel shimmer where
          // a narrow river is only a couple of pixels wide.
          float distFade = 1.0 - smoothstep(1200.0, 9000.0,
            length(vWorld.xz - cameraPosition.xz));
          float r1 = sin(p.x * 0.16 + p.y * 0.11 + t * 1.6);
          float r2 = sin(p.x * -0.09 + p.y * 0.21 - t * 1.1);
          float r3 = sin((p.x + p.y) * 0.42 + t * 2.3);
          vec3 n = normalize(vec3(
            (r1 * 0.07 + r3 * 0.03) * distFade,
            1.0,
            (r2 * 0.07 + r3 * 0.03) * distFade));
          float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
          vec3 col = mix(uDeep, uShallow, 0.45 + 0.2 * r2);
          col = mix(col, uSkyColor, clamp(fres * 0.55, 0.0, 0.7));
          vec3 r = reflect(-uSunDir, n);
          float spec = pow(max(dot(r, viewDir), 0.0), 90.0);
          float sparkle = pow(max(dot(r, viewDir), 0.0), 14.0) * 0.1;
          col += uSunColor * (spec * 1.2 + sparkle) * distFade;
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }
      `,
      fog: true,
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
    geometry.setIndex(new THREE.BufferAttribute(built.indices, 1));
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'inland-water';
    // Water draws before the road deck (RoadNetwork.renderOrder = 1) so a
    // highway crossing a river/lake never loses the depth tie.
    mesh.renderOrder = 0;
    mesh.userData.riverSegments = built.riverSegments;
    mesh.userData.lakeCount = built.lakeCount;

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