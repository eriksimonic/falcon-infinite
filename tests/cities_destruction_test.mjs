// Node-only acceptance test for Feature 20:
// terrain-hugging street ribbons + destructible buildings.
//
// Run: node tests/cities_destruction_test.mjs
//
// The whole point is that BuildingSystem is headless-safe: with `scene = null`
// it must never touch the DOM or WebGL, so blast damage, craters and reset can
// be verified directly. A stub scene ({ add, remove }) is used afterwards to
// exercise the mesh-building path without a renderer.

import { performance } from 'node:perf_hooks';
import { BuildingSystem, buildStreetRibbonData } from '../src/world/buildings.js';
import { settlementsNear } from '../src/world/settlements.js';
import { terrainHeight } from '../src/world/terrain.js';
import { QUALITY } from '../src/config.js';

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);

const HEADLESS_PRESET = QUALITY.medium;

// ---------------------------------------------------------------------------
// 1. Construction without a scene (no document, no canvas, no WebGL)
// ---------------------------------------------------------------------------
let sys = null;
try {
  sys = new BuildingSystem(null, HEADLESS_PRESET);
} catch (err) {
  failures.push(`BuildingSystem(null) threw: ${err && err.message}`);
}
check(!!sys, 'BuildingSystem(null, preset) did not construct');
if (!sys) {
  console.log('cannot continue without a BuildingSystem');
  process.exit(1);
}
check(sys.destroyed instanceof Set, 'destroyed is not a Set');
check(Array.isArray(sys.craters), 'craters is not an array');
check(sys.scene === null, 'scene should stay null');
check(sys.mesh === null && sys.roadMesh === null && sys.craterMesh === null,
  'headless system created render meshes');
check(sys.destroyed.size === 0, 'destroyed not empty on a fresh system');
check(sys.craters.length === 0, 'craters not empty on a fresh system');
check(typeof sys.applyBlast === 'function' && typeof sys.resetDamage === 'function',
  'applyBlast/resetDamage missing');

// ---------------------------------------------------------------------------
// 2. Real settlement: blast destroys buildings, returns positions + a crater
// ---------------------------------------------------------------------------
const near = settlementsNear(0, 0, 20000);
let site = null;
for (const s of near) {
  if (!site || s.buildings.length > site.buildings.length) site = s;
}
check(!!site && site.buildings.length >= 50, 'no sizeable settlement near the origin');

let target = null;
let bestD = Infinity;
for (const b of site.buildings) {
  const d = Math.hypot(b.x - site.x, b.z - site.z);
  if (d < bestD) {
    bestD = d;
    target = b;
  }
}
check(!!target, 'settlement has no buildings');

const SPLASH = 75; // Mk-82 class blast
const reachOf = (b) => SPLASH + Math.max(b.w, b.d) * 0.4;
const expected = site.buildings.filter(
  (b) => Math.hypot(b.x - target.x, b.z - target.z) <= reachOf(b),
);
check(expected.length >= 1, 'blast point has no buildings within splash radius');

const t0 = performance.now();
const first = sys.applyBlast({ x: target.x, y: target.y, z: target.z }, SPLASH, 180);
const blastMs = performance.now() - t0;

check(first && typeof first === 'object', 'applyBlast returned nothing');
check(first.destroyedCount >= 1, `applyBlast destroyed nothing (${first.destroyedCount})`);
check(first.destroyedCount === first.positions.length,
  'destroyedCount does not match positions length');
check(first.destroyedCount >= expected.length,
  `applyBlast missed buildings within the splash (${first.destroyedCount}/${expected.length})`);
check(sys.destroyed.size === first.destroyedCount, 'destroyed Set size is inconsistent');
check(blastMs < 500, `applyBlast too slow (${fmt(blastMs)} ms)`);

const posKeys = new Set(first.positions.map((p) => `${p.x},${p.z}`));
for (const b of expected) {
  check(posKeys.has(`${b.x},${b.z}`), `building at ${b.x},${b.z} was not reported destroyed`);
  check(sys.destroyed.has(`${site.id}:${Math.round(b.x)}:${Math.round(b.z)}`),
    `expected building ${b.x},${b.z} missing from destroyed set`);
}
for (const p of first.positions) {
  check(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
    'destroyed position has a non-finite coordinate');
  check(p.y > 0.5, `destroyed position not on land (y=${p.y})`);
}

check(sys.craters.length === 1, `expected 1 crater, got ${sys.craters.length}`);
check(sys.craters.length > 0 && sys.craters[0].r > 0 && Number.isFinite(sys.craters[0].r),
  'crater radius is invalid');
check(sys.craters.length > 0 && Math.abs(sys.craters[0].x - target.x) < 1e-6,
  'crater was not placed at the blast position');
check(sys.stats.destroyed === first.destroyedCount, 'stats.destroyed out of sync');
check(sys._needsRebuild === true, 'applyBlast did not request a rebuild');

// Buildings outside every reach must survive.
let survivors = 0;
for (const b of site.buildings) {
  if (Math.hypot(b.x - target.x, b.z - target.z) > reachOf(b) + 1) survivors++;
}
check(survivors > 0, 'every building in the settlement was destroyed');
check(sys.destroyed.size < site.buildings.length,
  'destroyed set covers the whole settlement for a small blast');

// ---------------------------------------------------------------------------
// 3. Re-blasting the same spot must not double-count
// ---------------------------------------------------------------------------
const sizeBefore = sys.destroyed.size;
const cratersBefore = sys.craters.length;
const second = sys.applyBlast({ x: target.x, y: target.y, z: target.z }, SPLASH, 180);
check(second.destroyedCount === 0, `repeat blast double-counted (${second.destroyedCount})`);
check(second.positions.length === 0, 'repeat blast returned positions');
check(sys.destroyed.size === sizeBefore, 'repeat blast grew the destroyed set');
check(sys.craters.length === cratersBefore + 1, 'repeat blast did not add a crater');

// Low-damage blasts leave no crater (but may still knock a building down).
const cratersBeforeWeak = sys.craters.length;
const weak = sys.applyBlast({ x: target.x + 4000, y: terrainHeight(target.x + 4000, target.z), z: target.z }, 12, 10);
check(weak.destroyedCount === 0, 'weak blast in empty ground destroyed something');
check(sys.craters.length === cratersBeforeWeak, 'low-damage blast created a crater');

// ---------------------------------------------------------------------------
// 4. resetDamage clears everything
// ---------------------------------------------------------------------------
sys.resetDamage();
check(sys.destroyed.size === 0, 'resetDamage left destroyed buildings');
check(sys.craters.length === 0, 'resetDamage left craters');
check(sys.stats.destroyed === 0 && sys.stats.craters === 0, 'resetDamage left stale stats');
check(sys._needsRebuild === true && sys._cratersDirty === true,
  'resetDamage did not request a rebuild');

const afterReset = sys.applyBlast({ x: target.x, y: target.y, z: target.z }, SPLASH, 180);
check(afterReset.destroyedCount >= 1, 'blast after reset destroyed nothing');
check(sys.craters.length === 1, 'blast after reset did not create a crater');
sys.resetDamage();

// ---------------------------------------------------------------------------
// 5. Crater ring buffer is capped at 64
// ---------------------------------------------------------------------------
for (let i = 0; i < 80; i++) {
  sys.applyBlast({ x: 900000 + i * 60, y: 0, z: 900000 }, 8, 100);
}
check(sys.craters.length === 64, `crater cap failed (${sys.craters.length})`);
const capCraters = sys.craters.map((c) => c.x);
check(new Set(capCraters).size === capCraters.length, 'crater list kept duplicates');
check(sys.craters[sys.craters.length - 1].x === 900000 + 79 * 60, 'newest crater was dropped');
sys.resetDamage();

// ---------------------------------------------------------------------------
// 6. Street ribbons hug the terrain (pure builder, no DOM)
// ---------------------------------------------------------------------------
const hill = (x, z) => 10 + 0.25 * x + 0.1 * z;
const hillRoad = [{ x1: 0, z1: 0, x2: 200, z2: 0, width: 8 }];
const ribbon = buildStreetRibbonData(hillRoad, hill);
check(ribbon.segmentCount === 10, `expected 10 road segments, got ${ribbon.segmentCount}`);
check(ribbon.roadCount === 1, 'roadCount should be 1');
check(ribbon.positions.length === ribbon.vertexCount * 3, 'position array size mismatch');
check(ribbon.uvs.length === ribbon.vertexCount * 2, 'uv array size mismatch');
check(ribbon.indices.length % 3 === 0, 'index count is not a multiple of 3');

let minEdgeErr = Infinity;
let maxEdgeErr = 0;
let maxSkirtErr = 0;
let maxDepth = 0;
let finite = true;
const px = ribbon.positions;
for (let i = 0; i < ribbon.vertexCount; i++) {
  const x = px[i * 3 + 0];
  const y = px[i * 3 + 1];
  const z = px[i * 3 + 2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) finite = false;
  const want = hill(x, z) + 0.32;
  if (i % 4 < 2) {
    const err = Math.abs(y - want);
    if (err < minEdgeErr) minEdgeErr = err;
    if (err > maxEdgeErr) maxEdgeErr = err;
  } else {
    // skirt vertex: exactly 1.2 m below the road edge above it
    const edgeY = y + 1.2;
    const err = Math.abs(edgeY - want);
    if (err > maxSkirtErr) maxSkirtErr = err;
    if (y > want) maxDepth = Math.max(maxDepth, y - want);
  }
}
check(finite, 'street ribbon contains NaN/Infinity');
check(maxEdgeErr < 0.01, `road surface is not glued to the terrain (max err ${fmt(maxEdgeErr)} m)`);
check(maxSkirtErr < 0.01, `curb skirt is not 1.2 m below the edge (max err ${fmt(maxSkirtErr)} m)`);
check(minEdgeErr < 0.01, 'no road vertex matched the terrain at all');
check(maxDepth <= 0, 'skirt vertices sit above the road edge');

let idxOk = true;
for (let i = 0; i < ribbon.indices.length; i++) {
  if (ribbon.indices[i] >= ribbon.vertexCount) idxOk = false;
}
check(idxOk, 'street ribbon index out of bounds');
check(ribbon.normals.length === ribbon.positions.length, 'normal array size mismatch');
let normFinite = true;
for (let i = 0; i < ribbon.normals.length; i++) {
  if (!Number.isFinite(ribbon.normals[i])) normFinite = false;
}
check(normFinite, 'street ribbon normals are not finite');
let topUp = 0;
let topCount = 0;
for (let i = 0; i < ribbon.vertexCount; i++) {
  if (i % 4 >= 2) continue;
  topCount++;
  if (ribbon.normals[i * 3 + 1] > 0.5) topUp++;
}
check(topCount > 0 && topUp / topCount > 0.9, 'road surface normals do not point up');

const flat = buildStreetRibbonData([{ x1: 0, z1: 0, x2: 0, z2: 0, width: 6 }], () => 4);
check(flat.segmentCount === 0 && flat.indices.length === 0, 'degenerate road produced geometry');

// A real settlement road must conform to the real terrain sampler too.
const realRoad = site.roads[0];
const realRibbon = buildStreetRibbonData([realRoad], terrainHeight);
check(realRibbon.segmentCount >= 1, 'real settlement road produced no ribbon');
let realErr = 0;
for (let i = 0; i < realRibbon.vertexCount; i += 4) {
  const x = realRibbon.positions[i * 3 + 0];
  const y = realRibbon.positions[i * 3 + 1];
  const z = realRibbon.positions[i * 3 + 2];
  realErr = Math.max(realErr, Math.abs(y - (terrainHeight(x, z) + 0.32)));
}
check(realErr < 0.05, `real street ribbon floats/clips (max err ${fmt(realErr)} m)`);

// ---------------------------------------------------------------------------
// 7. Mesh path with a stub scene: rubble collapse and craters render headlessly
// ---------------------------------------------------------------------------
const stubScene = { add() {}, remove() {} };
const drawn = new BuildingSystem(stubScene, HEADLESS_PRESET);
const camera = { position: { x: target.x, y: 120, z: target.z } };
drawn.rebuild(camera);
check(drawn.stats.buildings > 0, 'stub-scene rebuild placed no building instances');
check(drawn.stats.settlements > 0, 'stub-scene rebuild found no settlements');
check(drawn.stats.lights > 0, 'stub-scene rebuild placed no street lamps');
check(drawn.roadMesh.geometry.attributes.position !== undefined,
  'street ribbon mesh has no position attribute');
check(drawn.roadMesh.geometry.attributes.position.count > 0, 'street ribbon mesh is empty');
check(drawn.roadMesh.geometry.index !== null, 'street ribbon mesh has no index buffer');
check(drawn.craterMesh.visible === false, 'crater mesh visible before any blast');

const builtBefore = drawn.stats.buildings;
const drawnBlast = drawn.applyBlast({ x: target.x, y: target.y, z: target.z }, SPLASH, 180);
check(drawnBlast.destroyedCount >= 1, 'stub-scene blast destroyed nothing');
drawn.rebuild(camera);
check(drawn.craterMesh.visible === true, 'crater mesh not visible after a blast');
check(drawn.craterMesh.geometry.attributes.position.count > 0, 'crater mesh has no geometry');
check(drawn.stats.destroyed === drawnBlast.destroyedCount, 'stub-scene destroyed count wrong');
check(drawn.stats.buildings > 0 && drawn.stats.buildings <= builtBefore,
  'rubble rebuild changed the instance count unexpectedly');

drawn.resetDamage();
drawn.rebuild(camera);
check(drawn.craterMesh.visible === false, 'craters still visible after resetDamage');
check(drawn.stats.destroyed === 0, 'stub-scene destroyed count not reset');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Cities & destruction — acceptance test');
console.log('======================================');
console.log(`settlement under test : ${site.type} ${site.name} (${site.buildings.length} buildings, r=${fmt(site.radius)} m)`);
console.log(`blast                 : splash ${SPLASH} m, destroyed ${first.destroyedCount} buildings, ${sys.craters.length || 1} crater`);
console.log(`street ribbons        : ${ribbon.segmentCount} segments on a 200 m hill road, ` +
  `max surface error ${fmt(maxEdgeErr)} m, max skirt error ${fmt(maxSkirtErr)} m`);
console.log(`stub-scene rebuild    : ${builtBefore} instances, ${drawn.stats.roads} street lines, ${drawn.stats.lights} lamps`);
console.log(`checks: ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  process.exitCode = 1;
} else {
  console.log('\nALL CITIES & DESTRUCTION CHECKS PASSED');
}