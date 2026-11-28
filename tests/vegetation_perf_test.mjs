// Node-only acceptance test for PKT-01 (PERF-01, PERF-02, PERF-05, PERF-06) and
// PKT-11 (PERF-10).
// Run: node tests/vegetation_perf_test.mjs
//
// Verifies, headlessly (no DOM, no WebGL):
//   1. The near broadleaf canopy is welded: <= 168 vertices, 320 tris.
//   2. The far broadleaf canopy is the low-poly 4-lobe crown: 80 tris.
//   3. VegetationSystem(null, QUALITY.high) + rebuild() runs without a DOM.
//   4. Total + species counts match the radial nearest-first walk
//      (18,000 trees at (0, 500, 0), broadleaf + conifer split, and the exact
//      same forest on every repeated rebuild).
//   5. Every near instance is within VEG_NEAR_R of the camera, every far
//      instance is beyond it.
//   6. Trunks exist only under near crowns.
//   7. Near crowns cast shadows, far crowns and trunks do not.
//   8. instanceMatrix upload ranges cover count * 16 floats, not the pool.
//   9. The per-cell cache replays bit-identical instance matrices at the same
//      camera with zero terrainHeight calls, samples < 25% of a cold rebuild
//      after a 400 m move, and never exceeds MAX_CELL_CACHE.
//  10. Line-of-sight stability: flying forward never despawns a tree ahead of
//      the camera, and rotating in place never triggers a rebuild.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VegetationSystem, VEG_NEAR_R, MAX_CELL_CACHE } from '../src/world/vegetation.js';
import { QUALITY } from '../src/config.js';

const failures = [];
let checks = 0;

function check(cond, msg) {
  checks++;
  try {
    assert.ok(cond, msg);
  } catch (err) {
    failures.push(msg);
  }
}

function checkEqual(actual, expected, msg) {
  checks++;
  try {
    assert.equal(actual, expected, `${msg} (expected ${expected}, got ${actual})`);
  } catch (err) {
    failures.push(`${msg} (expected ${expected}, got ${actual})`);
  }
}

// ------------------------------------------------------- snapshot helpers
const MESHES = ['trunks', 'leavesNear', 'leavesFar', 'conifersNear', 'conifersFar'];
const CROWN_POOLS = ['leavesNear', 'leavesFar', 'conifersNear', 'conifersFar'];

/** Deep copy of the live instance data of all five pools. */
function snapshotInstances(s) {
  const out = {};
  for (const name of MESHES) {
    const mesh = s[name];
    out[name] = {
      count: mesh.count,
      matrix: mesh.instanceMatrix.array.slice(0, mesh.count * 16),
      color: mesh.instanceColor ? mesh.instanceColor.array.slice(0, mesh.count * 3) : null,
    };
  }
  return out;
}

/** First differing element between two snapshots, or '' when bit-identical. */
function firstDifference(a, b) {
  for (const name of MESHES) {
    if (a[name].count !== b[name].count) return `${name} count ${a[name].count} != ${b[name].count}`;
    const ma = a[name].matrix;
    for (let i = 0; i < ma.length; i++) {
      if (ma[i] !== b[name].matrix[i]) return `${name} instanceMatrix[${i}] ${ma[i]} != ${b[name].matrix[i]}`;
    }
    const ca = a[name].color;
    const cb = b[name].color;
    if (!ca !== !cb) return `${name} instanceColor presence`;
    if (ca && cb) {
      for (let i = 0; i < ca.length; i++) {
        if (ca[i] !== cb[i]) return `${name} instanceColor[${i}] ${ca[i]} != ${cb[i]}`;
      }
    }
  }
  return '';
}

const _snapM = new THREE.Matrix4();
const _snapV = new THREE.Vector3();

/** Set of every emitted crown position, keyed by rounded (x, z). */
function emittedPositions(s) {
  const keys = new Set();
  for (const name of CROWN_POOLS) {
    const mesh = s[name];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, _snapM);
      _snapV.setFromMatrixPosition(_snapM);
      keys.add(`${Math.round(_snapV.x)},${Math.round(_snapV.z)}`);
    }
  }
  return keys;
}

/** Stub camera that also answers getWorldDirection (looking straight ahead on -Z). */
function lookCamera(x, y, z, fx = 0, fz = -1) {
  return {
    position: new THREE.Vector3(x, y, z),
    getWorldDirection(target) {
      target.set(fx, 0, fz);
      return target;
    },
  };
}

// ------------------------------------------------------------ 1. no DOM
check(typeof globalThis.document === 'undefined', 'test must run without a DOM');
check(typeof globalThis.window === 'undefined', 'test must run without a window');

// --------------------------------------------------- 2. system + geometry
const sys = new VegetationSystem(null, QUALITY.high);

const nearGeo = sys.leavesNear.geometry;
const farGeo = sys.leavesFar.geometry;

const nearVerts = nearGeo.getAttribute('position').count;
const nearIndices = nearGeo.index ? nearGeo.index.count : 0;
check(nearVerts <= 168, `near canopy must have <= 168 vertices (got ${nearVerts})`);
checkEqual(nearIndices, 960, 'near canopy index count (320 triangles)');
checkEqual(nearIndices / 3, 320, 'near canopy triangle count');

const farVerts = farGeo.getAttribute('position').count;
const farIndices = farGeo.index ? farGeo.index.count : 0;
checkEqual(farIndices, 240, 'far canopy index count (80 triangles)');
checkEqual(farIndices / 3, 80, 'far canopy triangle count');
check(farVerts <= 48, `far canopy must be welded to <= 48 vertices (got ${farVerts})`);
check(nearVerts > farVerts, 'near canopy must be more detailed than the far canopy');

// Conifer geometry is shared by both conifer pools.
check(sys.conifersNear.geometry === sys.conifersFar.geometry, 'conifer pools share one geometry');
check(sys.leavesNear.geometry !== sys.leavesFar.geometry, 'broadleaf pools use different LODs');

// Pool sizes: each pool is sized to the species cap so a live quality switch
// can never overflow.
checkEqual(sys.leavesNear.instanceMatrix.count, sys.broadCap, 'leavesNear pool cap');
checkEqual(sys.leavesFar.instanceMatrix.count, sys.broadCap, 'leavesFar pool cap');
checkEqual(sys.conifersNear.instanceMatrix.count, sys.coniferCap, 'conifersNear pool cap');
checkEqual(sys.conifersFar.instanceMatrix.count, sys.coniferCap, 'conifersFar pool cap');

// Backwards-compatible aliases.
check(sys.leaves === sys.leavesNear, 'this.leaves must alias leavesNear');
check(sys.conifers === sys.conifersNear, 'this.conifers must alias conifersNear');

// Names and parenting: World.setTheater hides vegetation.group, so every pool
// must be a child of it.
checkEqual(sys.leavesNear.name, 'vegetation-leaves-near', 'leavesNear name');
checkEqual(sys.leavesFar.name, 'vegetation-leaves-far', 'leavesFar name');
checkEqual(sys.conifersNear.name, 'vegetation-conifers-near', 'conifersNear name');
checkEqual(sys.conifersFar.name, 'vegetation-conifers-far', 'conifersFar name');
for (const mesh of [sys.trunks, sys.leavesNear, sys.leavesFar, sys.conifersNear, sys.conifersFar]) {
  check(mesh.parent === sys.group, `${mesh.name || 'mesh'} must be a child of this.group`);
  check(mesh.frustumCulled === false, `${mesh.name || 'mesh'} must keep frustumCulled = false`);
}

// Shadow flags.
checkEqual(sys.leavesNear.castShadow, true, 'leavesNear.castShadow');
checkEqual(sys.leavesNear.receiveShadow, true, 'leavesNear.receiveShadow');
checkEqual(sys.conifersNear.castShadow, true, 'conifersNear.castShadow');
checkEqual(sys.conifersNear.receiveShadow, true, 'conifersNear.receiveShadow');
checkEqual(sys.leavesFar.castShadow, false, 'leavesFar.castShadow');
checkEqual(sys.leavesFar.receiveShadow, false, 'leavesFar.receiveShadow');
checkEqual(sys.conifersFar.castShadow, false, 'conifersFar.castShadow');
checkEqual(sys.conifersFar.receiveShadow, false, 'conifersFar.receiveShadow');
checkEqual(sys.trunks.castShadow, false, 'trunks.castShadow');
checkEqual(sys.trunks.receiveShadow, false, 'trunks.receiveShadow');

// ------------------------------------------------ 3. rebuild at (0,500,0)
const camPos = new THREE.Vector3(0, 500, 0);
const camera = { position: camPos };
sys.rebuild(camera);

const nearBroad = sys.leavesNear.count;
const farBroad = sys.leavesFar.count;
const nearConifer = sys.conifersNear.count;
const farConifer = sys.conifersFar.count;
const totalTrees = nearBroad + farBroad + nearConifer + farConifer;

checkEqual(totalTrees, 18000, 'total emitted trees at (0, 500, 0)');
checkEqual(nearBroad + farBroad + nearConifer + farConifer, totalTrees, 'pool counts must sum to the total');
check(nearBroad + farBroad > 0, 'the walk must emit broadleaf trees');
check(nearConifer + farConifer > 0, 'the walk must emit conifer trees');
checkEqual(nearBroad + farBroad + nearConifer + farConifer, 18000, 'broadleaf + conifer counts must sum to 18,000');

// The radial walk is a pure function of the camera position: a repeated rebuild
// must produce the exact same forest, instance for instance.
{
  const first = snapshotInstances(sys);
  sys.rebuild(camera);
  const repeatDiff = firstDifference(first, snapshotInstances(sys));
  check(repeatDiff === '', `repeated rebuilds at the same camera must be bit-identical (${repeatDiff})`);
}

// Near/far split is actually exercised: both rings are populated.
check(nearBroad > 0 && farBroad > 0, 'broadleaf must be split into near and far pools');
check(nearConifer > 0 && farConifer > 0, 'conifer must be split into near and far pools');
check(farBroad > nearBroad, 'most broadleaf trees are far from the camera');

// ------------------------------------------------- 4. distance invariants
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const R2 = VEG_NEAR_R * VEG_NEAR_R;

function instanceDistanceSq(mesh, i) {
  mesh.getMatrixAt(i, _m);
  _v.setFromMatrixPosition(_m);
  const dx = _v.x - camPos.x;
  const dz = _v.z - camPos.z;
  return dx * dx + dz * dz;
}

for (const mesh of [sys.leavesNear, sys.conifersNear]) {
  let worst = 0;
  for (let i = 0; i < mesh.count; i++) worst = Math.max(worst, instanceDistanceSq(mesh, i));
  check(worst <= R2, `${mesh.name}: every instance must be within ${VEG_NEAR_R} m (worst ${Math.sqrt(worst).toFixed(2)} m)`);
}

for (const mesh of [sys.leavesFar, sys.conifersFar]) {
  let closest = Infinity;
  for (let i = 0; i < mesh.count; i++) closest = Math.min(closest, instanceDistanceSq(mesh, i));
  check(closest > R2, `${mesh.name}: every instance must be beyond ${VEG_NEAR_R} m (closest ${Math.sqrt(closest).toFixed(2)} m)`);
}

// ------------------------------------------------------- 5. trunk coverage
checkEqual(sys.trunks.count, sys.leavesNear.count + sys.conifersNear.count, 'trunks exist only under near crowns');
check(sys.trunks.count < totalTrees, 'far trees must not emit trunks');

// ------------------------------------------- 6. partial instance uploads
for (const mesh of [sys.trunks, sys.leavesNear, sys.leavesFar, sys.conifersNear, sys.conifersFar]) {
  const attr = mesh.instanceMatrix;
  const expected = mesh.count * 16;
  const ranges = attr.updateRanges || [];
  check(ranges.length === 1, `${mesh.name}: instanceMatrix must upload exactly one range (got ${ranges.length})`);
  if (ranges.length === 1) {
    checkEqual(ranges[0].start, 0, `${mesh.name}: upload range must start at 0`);
    checkEqual(
      ranges[0].count,
      expected,
      `${mesh.name}: upload range must cover count * 16 floats, not the pool`,
    );
  }
  check(expected < attr.count * 16, `${mesh.name}: upload must be smaller than the full pool`);
  if (mesh.instanceColor) {
    const cr = mesh.instanceColor.updateRanges || [];
    check(cr.length === 1, `${mesh.name}: instanceColor must upload exactly one range`);
    if (cr.length === 1) {
      checkEqual(cr[0].count, mesh.count * 3, `${mesh.name}: colour upload must cover count * 3 floats`);
    }
  }
}

// --------------------------------- 7. update() rebuilds on a 360 m move
{
  const lastX = sys._lastX;
  const lastZ = sys._lastZ;
  // < 360 m: no rebuild.
  const nearCamera = { position: new THREE.Vector3(lastX + 350, 500, lastZ) };
  sys.update(1 / 60, nearCamera, null);
  checkEqual(sys._lastX, lastX, 'update() must not rebuild within 360 m (x)');
  checkEqual(sys._lastZ, lastZ, 'update() must not rebuild within 360 m (z)');

  // > 360 m: rebuild.
  const farCamera = { position: new THREE.Vector3(lastX, 500, lastZ + 5000) };
  sys.update(1 / 60, farCamera, null);
  checkEqual(sys._lastZ, lastZ + 5000, 'update() must rebuild beyond 360 m');
  checkEqual(
    sys.leavesNear.count + sys.leavesFar.count + sys.conifersNear.count + sys.conifersFar.count,
    18000,
    'rebuild after a move keeps the tree count',
  );
}

// ------------------------------------------------------- 8. dispose cleanly
{
  const scene = { added: [], add(o) { this.added.push(o); }, remove(o) { this.added = this.added.filter((x) => x !== o); } };
  const s2 = new VegetationSystem(scene, QUALITY.low);
  checkEqual(scene.added.length, 1, 'constructor adds the group to the scene once');
  s2.rebuild({ position: new THREE.Vector3(125000, 300, -42000) });
  const lowTotal = s2.leavesNear.count + s2.leavesFar.count + s2.conifersNear.count + s2.conifersFar.count;
  check(lowTotal > 0 && lowTotal <= QUALITY.low.treeLimit, `low preset emits within its treeLimit (${lowTotal})`);
  s2.dispose();
  checkEqual(scene.added.length, 0, 'dispose() removes the group from the scene');
  checkEqual(s2.group.children.length, 0, 'dispose() clears the group');
}

// ---------------------------------------- 9. PKT-11 deterministic cell cache
const cacheCam = () => ({ position: new THREE.Vector3(0, 500, 0) });
const movedCam = () => ({ position: new THREE.Vector3(400, 500, 0) });

{
  check(MAX_CELL_CACHE > 0 && MAX_CELL_CACHE <= 40000, `cache bound must be <= 40,000 cells (got ${MAX_CELL_CACHE})`);

  const veg = new VegetationSystem(null, QUALITY.high);

  // Cold rebuild: every accepted stem costs one terrainHeight sample.
  veg.rebuild(cacheCam());
  const coldSamples = veg._heightSamples;
  const coldSnap = snapshotInstances(veg);
  checkEqual(
    veg.leavesNear.count + veg.leavesFar.count + veg.conifersNear.count + veg.conifersFar.count,
    18000,
    'cold rebuild keeps the exact 18,000 tree baseline',
  );
  check(coldSamples >= 18000, `a cold rebuild must sample terrain per tree (got ${coldSamples})`);
  check(veg._cellCache.size > 0, 'the cell cache is populated by a rebuild');
  check(veg._cellCache.size <= MAX_CELL_CACHE, `cache size ${veg._cellCache.size} must respect MAX_CELL_CACHE`);
  let emptyCells = 0;
  for (const entry of veg._cellCache.values()) if (entry === null) emptyCells++;
  check(emptyCells > 0, 'non-wooded cells must be cached as null and skipped for free');

  // Second rebuild, same camera: pure replay, bit-identical, zero samples.
  veg.rebuild(cacheCam());
  checkEqual(veg._heightSamples, 0, 'rebuilding at the same camera must make zero terrainHeight calls');
  const replayDiff = firstDifference(coldSnap, snapshotInstances(veg));
  check(replayDiff === '', `cached replay must be bit-identical to the cold rebuild (${replayDiff})`);

  // Third rebuild, 400 m east: only the new edge cells may be sampled.
  veg.rebuild(movedCam());
  const movedSamples = veg._heightSamples;
  check(
    movedSamples * 4 < coldSamples,
    `a 400 m move must sample < 25% of a cold rebuild (${movedSamples} vs ${coldSamples})`,
  );
  checkEqual(
    veg.leavesNear.count + veg.leavesFar.count + veg.conifersNear.count + veg.conifersFar.count,
    18000,
    'a 400 m move keeps the exact tree baseline',
  );
  const movedSnap = snapshotInstances(veg);
  check(veg._cellCache.size <= MAX_CELL_CACHE, `cache size ${veg._cellCache.size} must respect MAX_CELL_CACHE after a move`);

  // The cache is a memo, not a different code path: a cold rebuild at the moved
  // camera must agree with the warm one instance for instance.
  const fresh = new VegetationSystem(null, QUALITY.high);
  fresh.rebuild(movedCam());
  const freshDiff = firstDifference(movedSnap, snapshotInstances(fresh));
  check(freshDiff === '', `warm cache must match a cold rebuild at (400, 500, 0) (${freshDiff})`);

  // Presets only change treeRadius / treeLimit, never per-cell sampling, so a
  // cached region stays free across a quality switch.
  veg.preset = QUALITY.low;
  veg.rebuild(movedCam());
  checkEqual(veg._heightSamples, 0, 'switching preset must reuse the cached cells');
  check(
    veg.leavesNear.count + veg.leavesFar.count + veg.conifersNear.count + veg.conifersFar.count <= QUALITY.low.treeLimit,
    'switching preset still respects the new treeLimit',
  );
  veg.preset = QUALITY.high;
  veg.rebuild(movedCam());
  checkEqual(veg._heightSamples, 0, 'switching back to high must also reuse the cached cells');

  // Explicit invalidation re-samples and must reproduce the same forest.
  const beforeClear = snapshotInstances(veg);
  veg.clearCellCache();
  checkEqual(veg._cellCache.size, 0, 'clearCellCache() empties the cache');
  veg.rebuild(movedCam());
  check(veg._heightSamples > 0, 'a rebuild after clearCellCache() re-samples terrain');
  const clearedDiff = firstDifference(beforeClear, snapshotInstances(veg));
  check(clearedDiff === '', `a re-sampled rebuild must match the cached one (${clearedDiff})`);

  // A long teleport must not grow the cache without bound.
  veg.rebuild({ position: new THREE.Vector3(120000, 500, -90000) });
  check(veg._cellCache.size <= MAX_CELL_CACHE, `cache size ${veg._cellCache.size} must respect MAX_CELL_CACHE after a teleport`);

  // Species-cap saturation (broadleaf-heavy low ground) must stay deterministic
  // too: the cap picks the crown geometry, never the cached cell record.
  const capped = new VegetationSystem(null, QUALITY.high);
  const cappedCam = () => ({ position: new THREE.Vector3(30000, 300, 0) });
  capped.rebuild(cappedCam());
  const cappedBroad = capped.leavesNear.count + capped.leavesFar.count;
  const cappedConifer = capped.conifersNear.count + capped.conifersFar.count;
  check(cappedBroad <= capped.broadCap, 'broadleaf pool never exceeds its cap');
  check(cappedConifer <= capped.coniferCap, 'conifer pool never exceeds its cap');
  checkEqual(cappedBroad + cappedConifer, 18000, 'a saturated camera still spends the whole tree budget');
  const cappedSnap = snapshotInstances(capped);
  capped.rebuild(cappedCam());
  checkEqual(capped._heightSamples, 0, 'a saturated camera replays from the cache');
  const cappedDiff = firstDifference(cappedSnap, snapshotInstances(capped));
  check(cappedDiff === '', `capped replay must be bit-identical (${cappedDiff})`);
  capped.dispose();

  // dispose() drops the cache together with the geometry.
  veg.dispose();
  checkEqual(veg._cellCache.size, 0, 'dispose() drops the cell cache');
  fresh.dispose();
}

sys.dispose();

// ------------------------------- 10. line-of-sight stability (zero popping)
//
// The aircraft flies forward along -Z. Every tree the pilot can see ahead
// inside the near 360° protection zone (VEG_NEAR_R = 2,400 m) must survive each
// 400 m rebuild untouched: no despawn, no respawn, same (x, z). This is the
// regression guard against the old grid-relative coprime shuffle, which
// re-scrambled the cell order (and therefore the `treeLimit` cut-off) on every
// rebuild, popping trees right in front of the camera.
{
  const los = new VegetationSystem(null, QUALITY.high);
  los.rebuild(lookCamera(0, 500, 0));

  const losTotal = los.leavesNear.count + los.leavesFar.count + los.conifersNear.count + los.conifersFar.count;
  checkEqual(losTotal, 18000, 'the forward-looking camera keeps the 18,000 tree baseline');

  const before = emittedPositions(los);

  // Trees recorded in the 2,500 m cone straight ahead (z < 0, looking -Z).
  let ahead = 0;
  for (const key of before) {
    const [x, z] = key.split(',').map(Number);
    if (z < 0 && Math.hypot(x, z) <= 2500) ahead++;
  }
  check(ahead > 1000, `the camera must be looking at a forested 2,500 m cone ahead (${ahead} trees)`);

  // The subset at [400 .. 2,400] m is the hard case: after a 400 m forward move
  // it sits at [0 .. 2,000] m, i.e. inside the near protection zone.
  const lineOfSight = [];
  for (const key of before) {
    const [x, z] = key.split(',').map(Number);
    const d = Math.hypot(x, z);
    if (z < 0 && d >= 400 && d <= VEG_NEAR_R) lineOfSight.push(key);
  }
  check(lineOfSight.length > 500, `the [400 .. 2,400] m line-of-sight band must be populated (${lineOfSight.length} trees)`);

  // Count of line-of-sight trees missing from `set`, plus a few examples for
  // the failure message.
  function vanished(set) {
    let count = 0;
    const examples = [];
    for (const key of lineOfSight) {
      if (set.has(key)) continue;
      count++;
      if (examples.length < 5) examples.push(key);
    }
    return { count, examples };
  }

  // 400 m forward.
  los.rebuild(lookCamera(0, 500, -400));
  checkEqual(
    los.leavesNear.count + los.leavesFar.count + los.conifersNear.count + los.conifersFar.count,
    18000,
    'the forward-looking camera keeps the tree budget after a 400 m move',
  );
  const at400 = vanished(emittedPositions(los));
  checkEqual(at400.count, 0, `no line-of-sight tree may despawn after a 400 m forward move (lost: ${at400.examples.join(' ')})`);

  // Another 400 m forward: the same original trees are now up to 800 m behind.
  los.rebuild(lookCamera(0, 500, -800));
  checkEqual(
    los.leavesNear.count + los.leavesFar.count + los.conifersNear.count + los.conifersFar.count,
    18000,
    'the forward-looking camera keeps the tree budget after an 800 m move',
  );
  const at800 = vanished(emittedPositions(los));
  checkEqual(at800.count, 0, `no line-of-sight tree may despawn after an 800 m forward move (lost: ${at800.examples.join(' ')})`);

  // Rotating in place must never rebuild: that is the other half of the flicker.
  let rebuilds = 0;
  const realRebuild = los.rebuild.bind(los);
  los.rebuild = (cam) => {
    rebuilds++;
    return realRebuild(cam);
  };
  los.update(1 / 60, lookCamera(0, 500, -800), null); // same spot, same heading
  los.update(1 / 60, lookCamera(0, 500, -800, 1, 0), null); // same spot, 90° yaw
  checkEqual(rebuilds, 0, 'rotating the camera in place must never trigger a rebuild');
  checkEqual(los._lastZ, -800, 'a rotation must not move the last rebuild position');

  // ... but a > 360 m translation still rebuilds.
  los.update(1 / 60, lookCamera(0, 500, -400, 1, 0), null);
  checkEqual(rebuilds, 1, 'a > 360 m translation must rebuild exactly once');

  // The walk is direction-aware but still camera-position deterministic.
  const yawSnap = snapshotInstances(los);
  los.rebuild(lookCamera(0, 500, -400, 1, 0));
  checkEqual(los._heightSamples, 0, 'a repeat rebuild from the cache samples no terrain');
  const yawDiff = firstDifference(yawSnap, snapshotInstances(los));
  check(yawDiff === '', `a repeat rebuild with the same heading must be bit-identical (${yawDiff})`);

  // A different heading may re-prioritise the far field, but it must never punch
  // a hole in the near zone: everything within VEG_NEAR_R survives a 90° yaw.
  const nearBefore = [];
  for (const key of emittedPositions(los)) {
    const [x, z] = key.split(',').map(Number);
    if (Math.hypot(x - 0, z + 400) <= VEG_NEAR_R) nearBefore.push(key);
  }
  los.rebuild(lookCamera(0, 500, -400, 0, 1)); // look backwards
  const nearAfter = emittedPositions(los);
  let nearLost = 0;
  for (const key of nearBefore) if (!nearAfter.has(key)) nearLost++;
  checkEqual(nearLost, 0, 'every tree within the near protection zone must survive a 180° turn');

  los.dispose();
}

// ------------------------------------------------------------------ result
if (failures.length) {
  console.error(`\n${failures.length} of ${checks} vegetation perf checks FAILED:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`all ${checks} vegetation perf checks passed`);