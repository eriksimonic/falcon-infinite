// Headless acceptance test for PKT-05 — terrain streaming cost (PERF-07/23).
// Run: node tests/terrain_stream_perf_test.mjs
//
// Verifies the frame-time budget in TerrainView._buildPending, the shared
// per-`segs` index attribute (and its safe detach on tile dispose), the
// farthest-first pending order, and the non-blinking invalidateBounds swap.

import * as THREE from 'three';
import { TerrainView } from '../src/world/terrainview.js';

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}

const scene = new THREE.Scene();
const PRESET = { segmentsNear: 40, segmentsFar: 20 }; // High

function nodeAt(level, x, z, size) {
  const node = { x, z, size, level };
  node.key = level + ':' + x + ':' + z;
  node.dist = 0;
  return node;
}
function queue(tv, nodes) {
  tv.pending.length = 0;
  tv.pending.push(...nodes);
}

// ---------------------------------------------------------------------------
// 1. Shared index attribute per `segs`
// ---------------------------------------------------------------------------
{
  const tv = new TerrainView(scene, PRESET);

  // level >= 6 -> segmentsNear (40 on High): (41 * 41) + (4 * 41) = 1845 verts.
  const a = tv._buildTile(nodeAt(6, 0, 0, 128));
  const b = tv._buildTile(nodeAt(6, 128, 0, 128));

  const verts = a.geometry.getAttribute('position').count;
  check(verts === 1845, `High near tile vertex count is ${verts}, expected 1845`);
  check(a.geometry.index === b.geometry.index,
    'two tiles with the same segs do not share one index BufferAttribute');
  check(a.geometry.index.array === b.geometry.index.array,
    'shared index attribute does not share its array');
  check(a.geometry.index.array instanceof Uint16Array,
    `High near index array is ${a.geometry.index.array?.constructor?.name}, expected Uint16Array`);

  const idxCount = a.geometry.index.count;
  check(idxCount === 40 * 40 * 6 + 4 * 40 * 6,
    `index count ${idxCount} does not match 2 tris/quad + skirt faces`);

  const arr = a.geometry.index.array;
  let maxIndex = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > maxIndex) maxIndex = arr[i];
  check(maxIndex === verts - 1, `index max ${maxIndex} != last vertex ${verts - 1}`);

  // Low band (segmentsFar) shares its own attribute, not the near one.
  const far1 = tv._buildTile(nodeAt(0, 0, 0, 4096));
  const far2 = tv._buildTile(nodeAt(0, 4096, 0, 4096));
  check(far1.geometry.index === far2.geometry.index,
    'two far tiles with the same segs do not share one index BufferAttribute');
  check(far1.geometry.index !== a.geometry.index,
    'different segs bands share the same index attribute');
  check(tv._indexCache.size === 2,
    `index cache holds ${tv._indexCache.size} bands, expected 2`);
  check(tv._indexCache.get(40) === a.geometry.index && tv._indexCache.get(20) === far1.geometry.index,
    'index cache is not keyed by segs');
  check(far1.matrixAutoUpdate === false, 'tile mesh lost matrixAutoUpdate = false');
}

// ---------------------------------------------------------------------------
// 2. Frame-time budget: at least one tile, then stop on time or on count
// ---------------------------------------------------------------------------
{
  const tv = new TerrainView(scene, PRESET);

  // budgetMs = 0: one tile must still be built, then the budget is spent.
  queue(tv, [0, 1, 2, 3, 4].map((k) => nodeAt(0, k * 4096, 0, 4096)));
  const one = tv._buildPending(100, 0);
  check(one === 1, `_buildPending(100, 0) built ${one} tiles, expected exactly 1`);
  check(tv.pending.length === 4, `_buildPending(100, 0) left ${tv.pending.length} pending, expected 4`);

  // budgetMs = Infinity: the tile count alone decides.
  queue(tv, [10, 11, 12, 13, 14].map((k) => nodeAt(0, k * 4096, 0, 4096)));
  const three = tv._buildPending(3, Infinity);
  check(three === 3, `_buildPending(3, Infinity) built ${three} tiles, expected 3`);
  check(tv.pending.length === 2, `_buildPending(3, Infinity) left ${tv.pending.length} pending, expected 2`);

  // Default budget is a 4 ms wall clock, never a zero-tile budget.
  queue(tv, [20, 21].map((k) => nodeAt(0, k * 4096, 0, 4096)));
  const def = tv._buildPending();
  check(def >= 1 && def <= 4, `default _buildPending() built ${def} tiles, expected 1..4`);
}

// ---------------------------------------------------------------------------
// 3. Farthest-first sort and O(1) pop(): the nearest leaf streams in first
// ---------------------------------------------------------------------------
{
  const tv = new TerrainView(scene, PRESET);
  const cam = new THREE.Vector3(0, 800, 0);
  tv._rebuild(cam);

  check(tv.pending.length > 2, `_rebuild queued only ${tv.pending.length} tiles`);

  let descending = true;
  for (let i = 1; i < tv.pending.length; i++) {
    if (tv.pending[i - 1].dist < tv.pending[i].dist) descending = false;
  }
  check(descending, 'pending is not sorted farthest-first, so pop() would not yield the nearest');

  const nearest = tv.pending[tv.pending.length - 1];
  const built = tv._buildPending(1, Infinity);
  check(built === 1, `_buildPending(1, Infinity) built ${built} tiles`);
  check(tv.tiles.has(nearest.key),
    'pop() did not build the nearest pending tile first');
  check(nearest.dist <= tv.pending.reduce((m, n) => Math.min(m, n.dist), Infinity),
    'a nearer tile than the one just built is still pending');
}

// ---------------------------------------------------------------------------
// 4. Non-blinking invalidateBounds: stale meshes draw until swapped out
// ---------------------------------------------------------------------------
{
  const tv = new TerrainView(scene, PRESET);
  queue(tv, [nodeAt(0, 0, 0, 4096), nodeAt(0, 4096, 0, 4096)]);
  tv._buildPending(2, Infinity);

  const key = '0:0:0';
  const oldMesh = tv.tiles.get(key);
  const oldGeo = oldMesh.geometry;
  const sharedIndex = oldGeo.index;
  check(!!oldMesh && !!sharedIndex, 'fixture tiles were not built');
  check(tv.group.children.includes(oldMesh), 'built tile is not in tv.group');

  // Record the index state at the exact moment dispose() fires.
  let indexAtDispose = 'not-disposed';
  oldGeo.addEventListener('dispose', () => { indexAtDispose = oldGeo.index; });

  const dropped = tv.invalidateBounds(-1, 4097, -1, 4097);
  check(dropped === 2, `invalidateBounds dropped ${dropped} tiles, expected 2`);
  check(!tv.tiles.has(key), 'invalidated tile was not re-queued for a fresh sample');
  check(tv._staleTiles.get(key) === oldMesh, 'invalidated mesh was not moved to _staleTiles');
  check(tv.group.children.includes(oldMesh),
    'invalidated mesh was removed from tv.group before its replacement existed');
  check(oldGeo.index === sharedIndex && indexAtDispose === 'not-disposed',
    'invalidated mesh geometry was disposed immediately instead of kept alive');
  check(oldGeo.index === tv._indexCache.get(20),
    'kept-alive geometry no longer references the cached index attribute');

  // Replacements for the same keys, as update() would queue after _rebuild.
  queue(tv, [nodeAt(0, 0, 0, 4096), nodeAt(0, 4096, 0, 4096)]);
  const rebuilt = tv._buildPending(2, Infinity);
  check(rebuilt === 2, `replacement pass built ${rebuilt} tiles, expected 2`);

  const newMesh = tv.tiles.get(key);
  check(!!newMesh && newMesh !== oldMesh, 'replacement tile did not replace the stale mesh');
  check(!tv.group.children.includes(oldMesh),
    'stale mesh is still drawn after its replacement was swapped in');
  check(tv._staleTiles.size === 0,
    `${tv._staleTiles.size} stale meshes left after the swap`);
  check(indexAtDispose === null,
    `geometry.index was ${indexAtDispose === 'not-disposed' ? 'never detached' : 'still attached'} when dispose() fired`);
  check(oldGeo.index === null, 'disposed tile geometry still points at the shared index');
  check(newMesh.geometry.index === sharedIndex,
    'replacement tile does not reuse the cached index attribute');
  check(tv._indexCache.get(20) === sharedIndex,
    'cached index attribute was dropped by the tile swap');
  check(newMesh.matrixAutoUpdate === false, 'replacement tile lost matrixAutoUpdate = false');

  // A stale mesh whose key leaves the visible quadtree is released by _rebuild.
  tv.invalidateBounds(-1, 4097, -1, 4097);
  const orphan = tv._staleTiles.get(key);
  check(!!orphan, 'second invalidation did not mark a stale mesh');
  tv._rebuild(new THREE.Vector3(200000, 800, 200000));
  check(!tv._staleTiles.has(key) && !tv.group.children.includes(orphan),
    'stale mesh from an out-of-range area is kept forever');

  // dispose() releases everything, including the cached index handles.
  tv.dispose();
  check(tv._indexCache.size === 0, 'dispose() did not clear the index cache');
  check(tv.tiles.size === 0 && tv._staleTiles.size === 0, 'dispose() left meshes behind');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Terrain streaming cost — acceptance test');
console.log('=======================================');
console.log(`near tile index : 1845 verts, Uint16Array, shared per segs band`);
console.log(`checks: ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  process.exit(1);
}
console.log('\nALL TERRAIN STREAM PERF CHECKS PASSED');