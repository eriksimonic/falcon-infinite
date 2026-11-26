// Headless acceptance test for Feature 28 — real OSM inland water.
// Run: node tests/water_test.mjs
//
// Verifies the pure `buildInlandWaterGeometry` builder (resampled river
// ribbons, sea-level skipping, flat concave-lake triangulation with +Y
// winding) and the `InlandWaterSystem` lifecycle with `scene === null`, i.e.
// no DOM or WebGL.

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildInlandWaterGeometry, InlandWaterSystem } from '../src/world/water.js';

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
function near(actual, want, eps, msg) {
  check(Number.isFinite(actual) && Math.abs(actual - want) <= eps,
    `${msg} (got ${actual}, want ${want} ±${eps})`);
}
function finiteArray(arr, msg) {
  check(arr instanceof Float32Array || arr instanceof Uint32Array, `${msg}: typed array`);
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      check(false, `${msg}: non-finite at ${i}`);
      return;
    }
  }
  check(true, msg);
}
/** +Y component of the triangle normal (x, z) plane cross product. */
function normalY(pos, a, b, c) {
  const ax = pos[a * 3], az = pos[a * 3 + 2];
  const bx = pos[b * 3], bz = pos[b * 3 + 2];
  const cx = pos[c * 3], cz = pos[c * 3 + 2];
  return (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
}
/** Shoelace area of an [x, z] polygon. */
function polygonArea(pts) {
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    area += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return Math.abs(area) * 0.5;
}

// Lake level contract under test: median shoreline height and basin centre,
// whichever is higher, plus 0.85 m (floored at 2.0 m). The old
// `minPerimeterH + 0.45` buried dammed reservoirs.
const LAKE_MIN_Y = 2.0;
const LAKE_LIFT_M = 0.85;
const LAKE_STEP_M = 30;
function lakeCentroid(pts) {
  let area2 = 0, cx = 0, cz = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const cross = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    area2 += cross;
    cx += (pts[j][0] + pts[i][0]) * cross;
    cz += (pts[j][1] + pts[i][1]) * cross;
  }
  if (Math.abs(area2) > 1e-9) return [cx / (3 * area2), cz / (3 * area2)];
  let sx = 0, sz = 0;
  for (const [x, z] of pts) { sx += x; sz += z; }
  return [sx / pts.length, sz / pts.length];
}
/** Perimeter heights sampled exactly like the builder does. */
function perimeterHeights(pts, heightAt) {
  const hs = [];
  let prev = pts[0];
  for (let i = 1; i <= pts.length; i++) {
    const cur = pts[i % pts.length];
    const segLen = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const steps = Math.max(1, Math.ceil(segLen / LAKE_STEP_M));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      hs.push(heightAt(prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t));
    }
    prev = cur;
  }
  return hs;
}
function expectedLakeLevel(pts, heightAt) {
  const hs = perimeterHeights(pts, heightAt).filter(Number.isFinite);
  if (hs.length === 0) return NaN;
  hs.sort((a, b) => a - b);
  const medianPerimeterH = hs[Math.floor(hs.length * 0.5)];
  const [cx, cz] = lakeCentroid(pts);
  const centerH = heightAt(cx, cz);
  return Math.max(LAKE_MIN_Y, Math.max(medianPerimeterH, centerH) + LAKE_LIFT_M);
}

// ---------------------------------------------------------------------------
// 1. Rivers on sloped terrain
// ---------------------------------------------------------------------------
const sloped = (x, z) => 120 + x * 0.012 + z * 0.006;
const riverPts = [];
for (let i = 0; i <= 100; i++) {
  const t = i / 100;
  riverPts.push([-1500 + 3000 * t, Math.sin(t * Math.PI * 2) * 260]);
}

const riverData = {
  rivers: [{ w: 15, pts: riverPts }],
  lakes: [],
};
const riverGeo = buildInlandWaterGeometry(riverData, sloped);
finiteArray(riverGeo.positions, 'river positions finite');
finiteArray(riverGeo.normals, 'river normals finite');
finiteArray(riverGeo.indices, 'river indices finite');

const rVerts = riverGeo.positions.length / 3;
check(rVerts > 200, `river resampled to a ribbon (${rVerts} vertices)`);
check(riverGeo.indices.length % 3 === 0, 'river indices are whole triangles');
check(riverGeo.riverSegments === rVerts / 2 - 1,
  `riverSegments matches vertex pairs (${riverGeo.riverSegments})`);
check(riverGeo.lakeCount === 0, 'no lakes counted for river-only data');

for (let i = 0; i < rVerts; i++) {
  const x = riverGeo.positions[i * 3];
  const y = riverGeo.positions[i * 3 + 1];
  const z = riverGeo.positions[i * 3 + 2];
  const dy = Math.abs(y - (sloped(x, z) + 0.35));
  if (dy > 0.05) {
    check(false, `river vertex ${i} lift off by ${dy.toFixed(3)} m`);
    break;
  }
  if (i === rVerts - 1) check(true, 'river vertices sit heightAt + 0.35 ±0.05 m');
}

for (let i = 0; i < rVerts; i++) {
  if (riverGeo.normals[i * 3] !== 0 || riverGeo.normals[i * 3 + 1] !== 1
    || riverGeo.normals[i * 3 + 2] !== 0) {
    check(false, `river normal ${i} is not (0, 1, 0)`);
    break;
  }
  if (i === rVerts - 1) check(true, 'river normals point straight up');
}

let riverMaxIndex = 0;
let riverUpFaces = 0;
let riverDownFaces = 0;
for (let i = 0; i < riverGeo.indices.length; i += 3) {
  const a = riverGeo.indices[i];
  const b = riverGeo.indices[i + 1];
  const c = riverGeo.indices[i + 2];
  riverMaxIndex = Math.max(riverMaxIndex, a, b, c);
  if (normalY(riverGeo.positions, a, b, c) > 0) riverUpFaces++;
  else riverDownFaces++;
}
check(riverMaxIndex < rVerts, 'river indices stay within the vertex range');
check(riverDownFaces === 0, `all ${riverUpFaces} river triangles face +Y`);

// Resampling interval: vertices come in pairs every ~25 m of centreline.
{
  const p = riverGeo.positions;
  const stride = Math.hypot(p[3] - p[0], p[5] - p[2]); // bank width, not spacing
  check(stride > 10 && stride < 20, `river bank ribbon follows width 15 m (${stride.toFixed(1)})`);
  const c0x = (p[0] + p[3]) / 2, c0z = (p[2] + p[5]) / 2;
  const c1x = (p[6] + p[9]) / 2, c1z = (p[8] + p[11]) / 2;
  near(Math.hypot(c1x - c0x, c1z - c0z), 25, 1.5, 'river sample spacing');
}

// ---------------------------------------------------------------------------
// 2. Sea-level segments are skipped cleanly
// ---------------------------------------------------------------------------
const coastal = (x, z) => (x < 0 ? -12 + z * 0.0 : 55 + x * 0.01);
const coastPts = [];
for (let i = 0; i <= 80; i++) coastPts.push([-1000 + i * 25, 0]);

const coastGeo = buildInlandWaterGeometry({
  rivers: [{ w: 15, pts: coastPts }],
  lakes: [],
}, coastal);

finiteArray(coastGeo.positions, 'coastal positions finite');
check(coastGeo.positions.length > 0, 'landward half of the river survives');
check(coastGeo.riverSegments > 0, 'landward river segments emitted');
let minY = Infinity;
let minX = Infinity;
for (let i = 0; i < coastGeo.positions.length / 3; i++) {
  minY = Math.min(minY, coastGeo.positions[i * 3 + 1]);
  minX = Math.min(minX, coastGeo.positions[i * 3]);
}
check(minY > 0.4 + 0.35 - 1e-6, `no sea-level vertices (min y ${minY.toFixed(2)})`);
check(minX >= -15, `no vertices out over the sea (min x ${minX.toFixed(1)})`);
{
  // Sample count must be lower than a fully-land river of the same length.
  const landGeo = buildInlandWaterGeometry({
    rivers: [{ w: 15, pts: coastPts }],
    lakes: [],
  }, () => 40);
  check(coastGeo.positions.length < landGeo.positions.length,
    'sea-level samples are dropped, not rendered');
  check(landGeo.riverSegments > coastGeo.riverSegments,
    'sea-level strip is shorter than the full strip');
}

// ---------------------------------------------------------------------------
// 3. Concave lakes triangulate cleanly at one flat level
// ---------------------------------------------------------------------------
// Concave "L" with a bay cut out: earcut must not fill the notch.
const concave = [
  [0, 0], [900, 0], [900, 700], [600, 700], [600, 320],
  [360, 320], [360, 700], [0, 700],
];
const lakeGeo = buildInlandWaterGeometry({ rivers: [], lakes: [concave] }, sloped);
finiteArray(lakeGeo.positions, 'lake positions finite');
finiteArray(lakeGeo.normals, 'lake normals finite');
finiteArray(lakeGeo.indices, 'lake indices finite');
check(lakeGeo.lakeCount === 1, 'one concave lake emitted');
check(lakeGeo.indices.length >= 3 * (concave.length - 2),
  'lake triangulation covers the polygon');

const lakeVerts = lakeGeo.positions.length / 3;
check(lakeVerts === concave.length, `lake keeps ${concave.length} contour vertices`);

const wantLevel = expectedLakeLevel(concave, sloped);
for (let i = 0; i < lakeVerts; i++) {
  if (Math.abs(lakeGeo.positions[i * 3 + 1] - wantLevel) > 1e-3) {
    check(false, `lake vertex ${i} not at flat level ${wantLevel.toFixed(2)}`);
    break;
  }
  if (i === lakeVerts - 1) check(true, 'lake is a single flat water level');
}
check(wantLevel >= 2.0, 'lake level respects the 2.0 m floor');
// The level must clear both the median shoreline and the basin centre, so the
// sheet can never be buried by a single low sample.
{
  const hs = perimeterHeights(concave, sloped).sort((a, b) => a - b);
  const median = hs[Math.floor(hs.length * 0.5)];
  const [cx, cz] = lakeCentroid(concave);
  const centerH = sloped(cx, cz);
  check(wantLevel >= median + 0.85 - 1e-6,
    `lake level clears the median shoreline (${wantLevel.toFixed(2)} vs ${median.toFixed(2)})`);
  check(wantLevel >= centerH + 0.85 - 1e-6,
    `lake level clears the basin centre (${wantLevel.toFixed(2)} vs ${centerH.toFixed(2)})`);
}

// Dammed reservoir (Vogrscek): one shoreline edge — the dam foot — sits 10 m
// below the basin. The old `minPerimeterH + 0.45` rule put the whole sheet
// underground; the surface must sit above the basin centre instead.
{
  const basinH = 100;
  const damFootH = basinH - 10;
  const reservoir = [[0, 0], [600, 0], [600, 400], [0, 400]];
  const dammed = (x) => (x < 60 ? damFootH : basinH);

  const geo = buildInlandWaterGeometry({ rivers: [], lakes: [reservoir] }, dammed);
  check(geo.lakeCount === 1, 'dammed reservoir triangulated');

  const level = geo.positions[1];
  const [cx, cz] = lakeCentroid(reservoir);
  const centerH = dammed(cx, cz);
  near(centerH, basinH, 1e-9, 'dammed fixture: basin centre height');
  check(level > centerH, `dammed reservoir sits above its basin centre (${level.toFixed(2)} > ${centerH.toFixed(2)})`);
  near(level, basinH + 0.85, 1e-3, 'dammed reservoir level = basin centre + 0.85 m');

  // Fixture sanity: the old min-perimeter rule would have buried it.
  const hs = perimeterHeights(reservoir, dammed);
  const oldLevel = Math.max(2.0, Math.min(...hs) + 0.45);
  check(oldLevel < basinH,
    `old minPerimeterH + 0.45 formula would bury the reservoir (${oldLevel.toFixed(2)} < ${basinH})`);

  for (let i = 0; i < geo.positions.length / 3; i++) {
    if (Math.abs(geo.positions[i * 3 + 1] - level) > 1e-6) {
      check(false, `dammed reservoir vertex ${i} is not on the flat level`);
      break;
    }
    if (i === geo.positions.length / 3 - 1) check(true, 'dammed reservoir surface is flat');
  }
}

let lakeDownFaces = 0;
let lakeArea = 0;
for (let i = 0; i < lakeGeo.indices.length; i += 3) {
  const a = lakeGeo.indices[i];
  const b = lakeGeo.indices[i + 1];
  const c = lakeGeo.indices[i + 2];
  const ny = normalY(lakeGeo.positions, a, b, c);
  if (ny <= 0) lakeDownFaces++;
  lakeArea += Math.abs(ny) * 0.5;
}
check(lakeDownFaces === 0, 'all lake triangles wound +Y');
near(lakeArea, polygonArea(concave), polygonArea(concave) * 0.01,
  'lake triangle area matches the concave polygon');

// A second lake at a different altitude must get its own level.
const highLake = [[2000, 2000], [2400, 2000], [2400, 2300], [2200, 2150], [2000, 2300]];
const twoLakes = buildInlandWaterGeometry({
  rivers: [],
  lakes: [concave, highLake],
}, sloped);
check(twoLakes.lakeCount === 2, 'two lakes emitted');
const lowLevel = lakeGeo.positions[1];
let highLevel = null;
for (let i = 0; i < twoLakes.positions.length / 3; i++) {
  const y = twoLakes.positions[i * 3 + 1];
  if (y > lowLevel + 1) { highLevel = y; break; }
}
check(highLevel !== null && highLevel > lowLevel + 1,
  'each lake gets its own terrain-derived level');

// Empty / malformed payloads must not throw.
{
  const empty = buildInlandWaterGeometry(null, sloped);
  check(empty.positions.length === 0 && empty.indices.length === 0
    && empty.riverSegments === 0 && empty.lakeCount === 0,
  'null payload yields empty geometry');
  const junk = buildInlandWaterGeometry({
    rivers: [{ w: 15, pts: [[0, 0]] }, { pts: [[NaN, 1], [2, 3]] }],
    lakes: [[[0, 0], [1, 1]], [[0, 0], [1, 0], [0, 'x']]],
  }, sloped);
  check(junk.indices.length === 0, 'degenerate rivers/lakes are ignored');
}

// ---------------------------------------------------------------------------
// 4. Real baked dataset builds end to end
// ---------------------------------------------------------------------------
{
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(
    join(here, '..', 'public', 'media', 'vipava_water.json'), 'utf8'));
  check(Array.isArray(raw.rivers) && raw.rivers.length > 1000,
    `real rivers loaded (${raw.rivers.length})`);
  check(Array.isArray(raw.lakes) && raw.lakes.length > 100,
    `real lakes loaded (${raw.lakes.length})`);

  // Synthetic rolling valley: every sample stays comfortably above sea level.
  const valley = (x, z) => 60 + 35 * Math.sin(x / 9000) * Math.cos(z / 7000)
    + 12 * Math.sin((x + z) / 4300);
  const real = buildInlandWaterGeometry(raw, valley);
  finiteArray(real.positions, 'real dataset positions finite');
  finiteArray(real.normals, 'real dataset normals finite');
  finiteArray(real.indices, 'real dataset indices finite');
  check(real.riverSegments > 1000, `real river segments (${real.riverSegments})`);
  check(real.lakeCount > 300, `real lakes triangulated (${real.lakeCount}/${raw.lakes.length})`);
  check(real.positions.length / 3 > 50000, 'real mesh is substantial');
}

// ---------------------------------------------------------------------------
// 5. InlandWaterSystem is headless-safe and clears cleanly
// ---------------------------------------------------------------------------
{
  const sys = new InlandWaterSystem(null);
  check(sys.mesh === null, 'system starts without a mesh');

  const mat = sys.material;
  check(mat.polygonOffset === true, 'material enables polygonOffset');
  check(mat.polygonOffsetFactor === -1, 'polygonOffsetFactor -1');
  check(mat.polygonOffsetUnits === -1, 'polygonOffsetUnits -1');
  check(mat.fog === true, 'material participates in fog');

  sys.setWaterData(riverData, sloped);
  check(sys.mesh !== null, 'setWaterData attaches a mesh');
  check(sys.mesh.renderOrder === 0, 'water renderOrder 0 so highways (1) layer on top');
  check(sys.geometry !== null, 'setWaterData keeps the geometry handle');
  const attrCount = sys.geometry.getAttribute('position')?.count ?? 0;
  check(attrCount === riverGeo.positions.length / 3, 'attached geometry matches the builder');

  const t0 = mat.uniforms.uTime.value;
  sys.update(0.25, {
    sunDir: new THREE.Vector3(0.3, 0.9, 0.1),
    sunColor: new THREE.Color(0xffddaa),
    skyColor: new THREE.Color(0x7799bb),
  });
  near(mat.uniforms.uTime.value, t0 + 0.25, 1e-9, 'update advances uTime');
  near(mat.uniforms.uSunDir.value.y, 0.9, 1e-6, 'update copies the sun direction');

  sys.setWaterData(null);
  check(sys.mesh === null, 'setWaterData(null) clears the mesh');
  check(sys.geometry === null, 'setWaterData(null) releases the geometry');

  sys.setWaterData(riverData, sloped);
  check(sys.mesh !== null, 'system can be rebuilt after clearing');
  sys.dispose();
  check(sys.mesh === null, 'dispose clears the mesh');
  check(sys.geometry === null, 'dispose clears the geometry');

  const emptySys = new InlandWaterSystem(null);
  emptySys.setWaterData({ rivers: [], lakes: [] }, sloped);
  check(emptySys.mesh === null, 'empty water data attaches nothing');
  emptySys.update(0.016, null);
  emptySys.dispose();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Vipava inland water — acceptance test');
console.log('====================================');
console.log(`rivers : ${riverGeo.riverSegments} segments, ${riverGeo.positions.length / 3} vertices`);
console.log(`lakes  : ${lakeGeo.lakeCount} concave lake @ ${wantLevel.toFixed(2)} m, area ${lakeArea.toFixed(0)} m²`);
console.log(`checks : ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  process.exit(1);
}
console.log('\nALL WATER CHECKS PASSED');
process.exit(0);