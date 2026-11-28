// Node-only acceptance test for Feature 20 (terrain-hugging street ribbons +
// destructible buildings) and Feature 22 (3D side-wall impacts + animated
// burn & collapse).
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
import { terrainHeight, setActiveDEM } from '../src/world/terrain.js';
import { HeightmapDEM } from '../src/world/dem.js';
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
check(sys.destroyed.size + sys.collapsing.size === first.destroyedCount,
  'destroyed + collapsing set size is inconsistent');
check(blastMs < 500, `applyBlast too slow (${fmt(blastMs)} ms)`);

const posKeys = new Set(first.positions.map((p) => `${p.x},${p.z}`));
for (const b of expected) {
  check(posKeys.has(`${b.x},${b.z}`), `building at ${b.x},${b.z} was not reported destroyed`);
  const key = `${site.id}:${Math.round(b.x)}:${Math.round(b.z)}`;
  check(sys.destroyed.has(key) || sys.collapsing.has(key),
    `expected building ${b.x},${b.z} missing from destroyed/collapsing state`);
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
check(sys.destroyed.size + sys.collapsing.size < site.buildings.length,
  'destroyed/collapsing covers the whole settlement for a small blast');

// ---------------------------------------------------------------------------
// 3. Re-blasting the same spot must not double-count
// ---------------------------------------------------------------------------
const sizeBefore = sys.destroyed.size + sys.collapsing.size;
const cratersBefore = sys.craters.length;
const second = sys.applyBlast({ x: target.x, y: target.y, z: target.z }, SPLASH, 180);
check(second.destroyedCount === 0, `repeat blast double-counted (${second.destroyedCount})`);
check(second.positions.length === 0, 'repeat blast returned positions');
check(sys.destroyed.size + sys.collapsing.size === sizeBefore,
  'repeat blast grew the destroyed/collapsing state');
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
check(sys.collapsing.size === 0, 'resetDamage left collapsing buildings');
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
// 8. Feature 22 — 3D side-wall impacts + animated burn/collapse
// ---------------------------------------------------------------------------
const sideSys = new BuildingSystem(null, HEADLESS_PRESET);
check(sideSys.collapsing instanceof Map, 'collapsing is not a Map');
check(sideSys.collapsing.size === 0, 'collapsing not empty on a fresh system');
check(sideSys.getCollapsingFirePoints().length === 0, 'fire points on a fresh system');
check(typeof sideSys.hitBuilding === 'function' &&
  typeof sideSys.getCollapsingFirePoints === 'function',
  'hitBuilding/getCollapsingFirePoints missing');

// Tallest real building in the settlement: a genuine tower facade to shoot at.
let tall = null;
for (const b of site.buildings) {
  if (!tall || b.h > tall.h) tall = b;
}
check(!!tall && tall.h > 20, 'no tall building in the test settlement');

const tallKey = `${site.id}:${Math.round(tall.x)}:${Math.round(tall.z)}`;
const tallGround = sideSys._ground(tall);
const tallMidY = tall.y + tall.h * 0.5;
const tcos = Math.cos(tall.rot);
const tsin = Math.sin(tall.rot);
const uxX = tcos; // world direction of the building's local +x axis
const uxZ = -tsin;
const halfW = tall.w * 0.5;
const halfD = tall.d * 0.5;

// Segment fired straight at the side wall at half the building's height.
const wallOffset = halfW + 4;
const wallFrom = { x: tall.x - uxX * wallOffset, y: tallMidY, z: tall.z - uxZ * wallOffset };
const wallTo = { x: tall.x, y: tallMidY, z: tall.z };
const wallHit = sideSys.hitBuilding(wallFrom, wallTo);
check(!!wallHit, 'hitBuilding missed a mid-air side wall');
if (wallHit) {
  check(wallHit.key === tallKey, `hitBuilding hit the wrong building (${wallHit.key})`);
  check(wallHit.t > 0 && wallHit.t < 1, `bad hit parameter t=${wallHit.t}`);
  check(wallHit.y > tall.y + 2, `side-wall impact is not mid-air (y=${fmt(wallHit.y)})`);
  check(wallHit.y <= tallGround.top + 1, 'impact point is above the roof');
  check(Number.isFinite(wallHit.x) && Number.isFinite(wallHit.z), 'impact point is not finite');
  check(wallHit.building === tall, 'hitBuilding returned the wrong building ref');
  // The entry point must lie on a vertical facade of the footprint.
  const hdx = wallHit.x - tall.x;
  const hdz = wallHit.z - tall.z;
  const lx = hdx * tcos - hdz * tsin;
  const lz = hdx * tsin + hdz * tcos;
  check(Math.abs(Math.abs(lx) - halfW) < 0.5 && Math.abs(lz) <= halfD + 0.5,
    `impact point is not on the facade (lx=${fmt(lx)}, lz=${fmt(lz)})`);
  check(wallHit.y > terrainHeight(wallHit.x, wallHit.z) + 2,
    'impact point is not above the local ground');
}

// Clean miss straight above the roof: inside the own footprint, high overhead.
const overFrom = { x: tall.x - uxX * 3, y: tallGround.top + 25, z: tall.z - uxZ * 3 };
const overTo = { x: tall.x + uxX * 3, y: tallGround.top + 25, z: tall.z + uxZ * 3 };
check(sideSys.hitBuilding(overFrom, overTo) === null,
  'hitBuilding hit a building from a ray above its roof');

// Clean miss beside the wall: parallel to the facade, offset outwards.
const besideOffset = halfW + 8;
const besideFrom = {
  x: tall.x + uxX * besideOffset + uxZ * (-halfD * 0.5),
  y: tallMidY,
  z: tall.z + uxZ * besideOffset - uxX * (-halfD * 0.5),
};
const besideTo = {
  x: tall.x + uxX * besideOffset + uxZ * (halfD * 0.5),
  y: tallMidY,
  z: tall.z + uxZ * besideOffset - uxX * (halfD * 0.5),
};
check(sideSys.hitBuilding(besideFrom, besideTo) === null,
  'hitBuilding hit a building from a ray passing beside it');

// Blast on the tall building must start an animated collapse, not instant rubble.
const collapseBlast = sideSys.applyBlast({ x: tall.x, y: tall.y, z: tall.z }, 20, 180);
check(collapseBlast.destroyedCount >= 1, 'blast near the tall building destroyed nothing');
check(sideSys.collapsing.size >= 1, 'blast did not start a collapse');
check(sideSys.collapsing.has(tallKey), 'the tall building is not collapsing');
check(sideSys.destroyed.size === 0, 'buildings snapped to rubble without collapsing');
check(sideSys.stats.destroyed === sideSys.collapsing.size, 'stats.destroyed out of sync with collapsing');
let durationOk = true;
for (const c of sideSys.collapsing.values()) {
  if (!(c.duration >= 2.4 && c.duration <= 3.8)) durationOk = false;
  if (!(Math.abs(c.tiltX) >= 0.14 && Math.abs(c.tiltX) <= 0.32)) durationOk = false;
  if (!(Math.abs(c.tiltZ) >= 0.14 && Math.abs(c.tiltZ) <= 0.32)) durationOk = false;
}
check(durationOk, 'collapse duration or lean is outside the 2.4..3.8 s / 0.14..0.32 rad range');

const fire0 = sideSys.getCollapsingFirePoints();
check(fire0.length === sideSys.collapsing.size, 'fire point count does not match collapsing size');
let fireOk = true;
for (const p of fire0) {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) fireOk = false;
  if (!(p.y > 0.5)) fireOk = false;
  if (p.progress !== 0) fireOk = false;
}
check(fireOk, 'burning positions are invalid');

// Repeat blast during the burn must not double-count the same buildings.
check(sideSys.applyBlast({ x: tall.x, y: tall.y, z: tall.z }, 20, 180).destroyedCount === 0,
  'a second blast re-counted a collapsing building');

sideSys.update(0.5);
const fireMid = sideSys.getCollapsingFirePoints();
check(fireMid.length === fire0.length, 'advancing the collapse lost burning buildings');
check(fireMid.every((p) => p.progress > 0 && p.progress < 1), 'collapse progress did not advance');
check(sideSys.destroyed.size === 0, 'collapse finished in half a second');

sideSys.update(4.5);
check(sideSys.collapsing.size === 0, 'buildings are still collapsing after 5 s');
check(sideSys.destroyed.size >= 1, 'no building finished collapsing into rubble');
check(sideSys.destroyed.has(tallKey), 'the tall building never became rubble');
check(sideSys.getCollapsingFirePoints().length === 0, 'fire points remain after the collapse');
check(sideSys.hitBuilding(wallFrom, wallTo) === null,
  'hitBuilding still hits a building that is flat rubble');
check(sideSys.stats.destroyed === sideSys.destroyed.size, 'stats.destroyed stale after collapse');

sideSys.resetDamage();
check(sideSys.collapsing.size === 0 && sideSys.destroyed.size === 0,
  'resetDamage left collapse state behind');

// ---------------------------------------------------------------------------
// 9. Feature 26/27 — 20 mm chipping, BFFG wasteland, ruin decay, baked OSM city
// ---------------------------------------------------------------------------
// Light ordnance (GUN: 6 m splash, 18 dmg) must accumulate `buildingHp` instead
// of levelling the block, while still leaving its 4..6 m scorch crater.
const gunSys = new BuildingSystem(null, HEADLESS_PRESET);

let gunTarget = null;
for (const b of site.buildings) {
  if (b.h >= 10 && (!gunTarget || b.h < gunTarget.h)) gunTarget = b;
}
check(!!gunTarget, 'test settlement has no low-rise building for the gun test');

const gunKey = `${site.id}:${Math.round(gunTarget.x)}:${Math.round(gunTarget.z)}`;
const gunPos = { x: gunTarget.x, y: terrainHeight(gunTarget.x, gunTarget.z), z: gunTarget.z };
const gunHpMax = gunSys._hpFor(gunTarget);
check(gunHpMax >= 40, `unexpected structural HP ${gunHpMax}`);

const gunFirst = gunSys.applyBlast(gunPos, 6, 18);
check(gunFirst.destroyedCount === 0, 'one 20 mm round levelled a building');
check(gunFirst.damagedCount >= 1, 'one 20 mm round chipped no building');
check(gunFirst.positions.length === 0, 'a chipping round reported destruction positions');
check(gunSys.buildingHp.has(gunKey), 'gun damage was not stored as cumulative HP');
check(gunSys.collapsing.size === 0 && gunSys.destroyed.size === 0,
  'gun damage skipped straight to collapse');
const gunHp1 = gunSys.buildingHp.get(gunKey);
check(Math.abs(gunHp1 - (gunHpMax - 18)) < 1e-6,
  `single hit removed ${fmt(gunHpMax - gunHp1)} HP instead of 18`);
check(gunSys.craters.length === 1, `gun hit added ${gunSys.craters.length} craters`);
check(gunSys.craters[0].r >= 4 && gunSys.craters[0].r <= 6,
  `gun scorch radius ${fmt(gunSys.craters[0].r)} m is outside 4..6 m`);
check(Math.abs(gunSys.craters[0].x - gunTarget.x) < 1e-6 &&
  Math.abs(gunSys.craters[0].z - gunTarget.z) < 1e-6,
  'gun scorch was not placed at the impact point');

let gunHits = 1;
let gunCollapsed = false;
for (let i = 0; i < 24 && !gunCollapsed; i++) {
  const r = gunSys.applyBlast(gunPos, 6, 18);
  gunHits++;
  if (r.destroyedCount > 0) gunCollapsed = true;
}
check(gunCollapsed, 'repeated 20 mm hits never collapsed the building');
check(gunHits >= 2, 'a building collapsed after a single 20 mm round');
check(gunHits <= Math.ceil(gunHpMax / 18) + 1,
  `took ${gunHits} gun hits to collapse a ${fmt(gunHpMax)} HP block`);
check(gunSys.collapsing.has(gunKey) || gunSys.destroyed.has(gunKey),
  'the gun-damaged building is not collapsing');
check(gunSys.buildingHp.has(gunKey) === false,
  'a collapsed building kept partial-damage HP');
check(gunSys.craters.length === gunHits, `expected ${gunHits} scorch marks, got ${gunSys.craters.length}`);
let gunCraterOk = true;
for (const c of gunSys.craters) {
  if (!(c.r >= 4 && c.r <= 6)) gunCraterOk = false;
}
check(gunCraterOk, 'a gun scorch crater fell outside the 4..6 m band');

// BFFG: 420 m splash at 5000 damage must leave a 160 m wasteland.
const bffgSys = new BuildingSystem(null, HEADLESS_PRESET);
const bffg = bffgSys.applyBlast({ x: site.x, y: terrainHeight(site.x, site.z), z: site.z }, 420, 5000);
check(bffg.destroyedCount > 0, 'BFFG blast destroyed nothing');
check(bffg.destroyedCount === bffg.positions.length, 'BFFG destroyed count/positions mismatch');
check(bffg.destroyedCount >= 20, `BFFG blast only reached ${bffg.destroyedCount} buildings`);
// A 420 m splash can legitimately swallow a whole small town; what must hold is
// that the reach boundary is exact: everything inside falls, nothing beyond it.
let bffgInside = 0;
let bffgMissed = 0;
let bffgBeyond = 0;
let bffgBeyondHit = 0;
for (const b of site.buildings) {
  const dist = Math.hypot(b.x - site.x, b.z - site.z);
  const reach = 420 + Math.max(b.w, b.d) * 0.4;
  const key = `${site.id}:${Math.round(b.x)}:${Math.round(b.z)}`;
  const hit = bffgSys.collapsing.has(key) || bffgSys.destroyed.has(key);
  if (dist <= reach) {
    bffgInside++;
    if (!hit) bffgMissed++;
  } else if (dist > reach + 1) {
    bffgBeyond++;
    if (hit) bffgBeyondHit++;
  }
}
check(bffgInside >= 20, `only ${bffgInside} buildings sat inside the BFFG splash`);
check(bffgMissed === 0, `${bffgMissed} buildings inside the BFFG splash survived`);
check(bffgBeyondHit === 0, `${bffgBeyondHit} buildings beyond the BFFG splash were destroyed`);
check(bffgSys.craters.length === 1, `BFFG blast left ${bffgSys.craters.length} craters`);
const bffgCrater = bffgSys.craters[0];
check(bffgCrater && bffgCrater.r === 160, `BFFG crater is ${fmt(bffgCrater ? bffgCrater.r : 0)} m, expected 160 m`);
check(bffgCrater && Math.abs(bffgCrater.x - site.x) < 1e-6 && Math.abs(bffgCrater.z - site.z) < 1e-6,
  'BFFG crater was not placed at ground zero');
check(bffgSys.collapsing.size >= 20, 'BFFG blast did not start collapses');
check(bffgSys.destroyed.size === 0, 'BFFG snapped buildings to rubble without collapsing');

// ---------------------------------------------------------------------------
// 10. Completed collapses register ruin fires and decay after 80 s
// ---------------------------------------------------------------------------
const ruinSys = new BuildingSystem(null, HEADLESS_PRESET);
check(ruinSys.getRuinFirePoints().length === 0, 'ruin fires exist before any collapse');
const ruinBlast = ruinSys.applyBlast({ x: target.x, y: target.y, z: target.z }, 75, 180);
check(ruinBlast.destroyedCount >= 1, 'ruin-fire test blast destroyed nothing');
check(ruinSys.getRuinFirePoints().length === 0, 'ruin fires appeared before the collapse finished');

ruinSys.update(5);
check(ruinSys.collapsing.size === 0, 'collapses did not finish within 5 s');
check(ruinSys.destroyed.size === ruinBlast.destroyedCount, 'collapsed buildings did not become rubble');
const ruin0 = ruinSys.getRuinFirePoints();
check(ruin0.length === ruinSys.destroyed.size, 'completed collapses did not register a ruin fire each');
let ruinOk = true;
for (const p of ruin0) {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) ruinOk = false;
  if (!(p.y > 0.5)) ruinOk = false;
  if (p.progress !== 0) ruinOk = false;
  if (!(p.life >= 70 && p.life <= 80)) ruinOk = false;
  if (p.intensity !== 1) ruinOk = false;
}
check(ruinOk, 'ruin fire emitters are invalid at birth');
check(ruinSys.stats.ruinFires === ruin0.length, 'stats.ruinFires out of sync');

const ruinAt = (list) => list.find(
  (p) => Math.abs(p.x - ruinBlast.positions[0].x) < 1e-6 && Math.abs(p.z - ruinBlast.positions[0].z) < 1e-6,
);
check(!!ruinAt(ruin0), 'ruin fire is not at a collapsed building');

ruinSys.update(30);
const ruinMid = ruinSys.getRuinFirePoints();
check(ruinMid.length === ruin0.length, 'ruin fires vanished early');
const midFire = ruinAt(ruinMid);
check(!!midFire && midFire.progress > 0.25 && midFire.progress < 0.6,
  `ruin fire progress after 35 s is ${fmt(midFire ? midFire.progress : -1)}`);
check(!!midFire && midFire.intensity > 0 && midFire.intensity < 1, 'ruin fire intensity did not fade');

ruinSys.update(45); // 80 s total, past the 75 s burn life
check(ruinSys.getRuinFirePoints().length === 0, 'ruin fires did not decay after 80 s');
check(ruinSys.stats.ruinFires === 0, 'stats.ruinFires stale after the embers died');
check(ruinSys.destroyed.size === ruinBlast.destroyedCount,
  'ruin decay removed the permanent rubble too');

// ---------------------------------------------------------------------------
// 11. Baked OSM city: virtual settlement registered, hittable, then reverted
// ---------------------------------------------------------------------------
const customSys = new BuildingSystem(null, HEADLESS_PRESET);
// Off the LJAJ runway strip (|x| < 960, |z| < 95): OSM buildings there are dropped.
const custom = customSys.setCustomBuildings([[3200, 1500, 20, 16, 35, 0.2, 3]]);
check(!!custom, 'setCustomBuildings returned nothing');
check(customSys.customSettlement === custom, 'customSettlement was not stored');
check(custom.id === 'vipava-osm', `custom settlement id is ${custom.id}`);
check(custom.type === 'metro', `custom settlement type is ${custom.type}`);
check(Math.abs(custom.radius - 52000) < 1e-6, `custom settlement radius is ${custom.radius}`);
check(custom.buildings.length === 1, `custom settlement holds ${custom.buildings.length} buildings`);
check(customSys.stats.destroyed === 0, 'custom settlement started with damage');

const cb = custom.buildings[0];
check(cb.kind === 'tower', `kindCode 3 decoded as ${cb.kind}`);
check(cb.x === 3200 && cb.z === 1500 && cb.w === 20 && cb.d === 16 && cb.h === 35,
  'custom building dimensions were mangled');
check(Math.abs(cb.rot - 0.2) < 1e-9, 'custom building rotation was mangled');
check(typeof cb.color === 'number', 'custom building has no palette colour');

const cg = customSys._ground(cb);
const cMidY = (cg.base + cg.top) * 0.5;
const cux = Math.cos(cb.rot);
const cuz = -Math.sin(cb.rot);
const cOffset = cb.w * 0.5 + 6;
const cFrom = { x: cb.x - cux * cOffset, y: cMidY, z: cb.z - cuz * cOffset };
const cTo = { x: cb.x, y: cMidY, z: cb.z };
const cHit = customSys.hitBuilding(cFrom, cTo);
check(!!cHit, 'hitBuilding missed the baked OSM tower');
if (cHit) {
  check(cHit.key === 'vipava-osm:3200:1500', `hitBuilding key is ${cHit.key}`);
  check(cHit.building === cb, 'hitBuilding returned the wrong baked building');
  check(cHit.settlement === custom, 'hitBuilding returned the wrong settlement');
  check(cHit.y > cg.base + 1 && cHit.y <= cg.top + 1,
    `baked facade hit at y=${fmt(cHit.y)} is outside the building`);
  check(cHit.t > 0 && cHit.t < 1, `baked facade hit t=${cHit.t}`);
}

const chip = customSys.applyBlast({ x: cb.x, y: cMidY, z: cb.z }, 6, 18);
check(chip.damagedCount >= 1, 'GUN did not chip the baked building');
check(chip.destroyedCount === 0, 'GUN levelled the baked building in one round');
check(customSys.buildingHp.has('vipava-osm:3200:1500'), 'baked building HP not accumulated');

const level = customSys.applyBlast({ x: cb.x, y: cMidY, z: cb.z }, 30, 180);
check(level.destroyedCount >= 1, 'heavy blast did not level the baked building');
check(customSys.collapsing.has('vipava-osm:3200:1500'), 'baked building did not start collapsing');
customSys.update(5);
check(customSys.destroyed.has('vipava-osm:3200:1500'), 'baked building never became rubble');
check(customSys.getRuinFirePoints().length === 1, 'baked ruin did not smoulder');

const insideCustom = customSys._settlementsNear(0, 0, 6000);
check(insideCustom.length === 1 && insideCustom[0].id === 'vipava-osm',
  'procedural cities were not hidden while the baked OSM city is active');

// The real-world theater streams live Terrarium terrain far past the old
// +-50 km box; the Adriatic past Piran was procedural dry land before the DEM
// loaded, so no invented city may survive there while the baked city is active.
const adriatic = customSys._settlementsNear(-51614, 55952, 16000);
check(adriatic.length === 0,
  `${adriatic.length} procedural settlements floated on the Adriatic Sea near Piran`);

const reverted = customSys.setCustomBuildings(null);
check(reverted === null, 'setCustomBuildings(null) did not return null');
check(customSys.customSettlement === null, 'customSettlement was not cleared');
check(customSys._needsRebuild === true, 'revert did not request a rebuild');
const afterRevert = customSys._settlementsNear(0, 0, 6000);
check(!afterRevert.some((s) => s.id === 'vipava-osm'), 'baked city is still listed after the revert');
check(afterRevert.length >= 1, 'procedural cities did not come back after the revert');
const afterHit = customSys.hitBuilding(cFrom, cTo);
check(!afterHit || afterHit.settlement.id !== 'vipava-osm',
  'hitBuilding still reports the removed baked city');

const reapplied = customSys.setCustomBuildings([[3320, 1560, 10, 9, 8, 0, 0]]);
check(!!reapplied && reapplied.buildings.length === 1, 'setCustomBuildings could not be re-applied');
check(reapplied && reapplied.buildings[0].kind === 'house', 'kindCode 0 decoded as a non-house');

// The LJAJ runway strip (RWY 09/27) rejects OSM buildings; neighbours survive.
const strip = customSys.setCustomBuildings([
  [0, 0, 20, 16, 10, 0, 0],
  [-320, 20, 20, 16, 10, 0, 0],
  [959, -94, 20, 16, 10, 0, 0],
  [3200, 1500, 20, 16, 10, 0, 0],
]);
check(!!strip && strip.buildings.length === 1,
  `runway-strip filter kept ${strip ? strip.buildings.length : -1} buildings on LJAJ`);
customSys.setCustomBuildings(null);

// ---------------------------------------------------------------------------
// 12. Feature 39 — +rot grounding, hillside plinths, 4-tier LOD & 20k grid
// ---------------------------------------------------------------------------
{
  // Tilted planar DEM: h(x, z) = 200 + 0.12 * x + 0.25 * z (steep hillside!).
  // Use a 4x4 linear grid so Catmull-Rom bicubic reproduces the plane exactly.
  const W = 4, H = 4, SIZE = 40000;
  const planePx = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    const z = -SIZE * 0.5 + (r / (H - 1)) * SIZE;
    for (let c = 0; c < W; c++) {
      const x = -SIZE * 0.5 + (c / (W - 1)) * SIZE;
      planePx[r * W + c] = 200 + 0.12 * x + 0.25 * z;
    }
  }
  const slopeDem = new HeightmapDEM({ width: W, height: H, sizeM: SIZE, pixels: planePx });
  try {
    setActiveDEM(slopeDem);
    const slopeSys = new BuildingSystem(null, QUALITY.medium);
    // Elongated rotated building (rot = 0.7 rad) far from origin airport pad.
    const rot = 0.7;
    const b = { x: 5200, z: 4800, w: 40, d: 10, h: 8, rot, kind: 'house' };
    const g = slopeSys._ground(b);

    // Compute exact Three.js Euler(0, rot, 0) rotated footprint corners.
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const hw = b.w * 0.5;
    const hd = b.d * 0.5;
    let exactLo = Infinity;
    let exactHi = -Infinity;
    for (const [su, sv] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) {
      const wx = b.x + su * c + sv * s;
      const wz = b.z - su * s + sv * c;
      const h = terrainHeight(wx, wz);
      if (h < exactLo) exactLo = h;
      if (h > exactHi) exactHi = h;
    }
    const relief = exactHi - exactLo;
    check(relief > 4, `tilted plane relief too small (${fmt(relief)} m)`);
    check(Math.abs(g.ground - exactLo) < 0.05,
      `_ground(b) corner sign mismatch (got lo=${fmt(g.ground)}, exact +rot lo=${fmt(exactLo)})`);
    check(Math.abs(g.hi - exactHi) < 0.05,
      `_ground(b) uphill corner mismatch (got hi=${fmt(g.hi)}, exact +rot hi=${fmt(exactHi)})`);
    check(g.base < exactLo - 3.0,
      `hillside plinth base (${fmt(g.base)}) does not extend > 3 m below lo (${fmt(exactLo)})`);
    check(g.floorY >= exactLo - 1e-6,
      `terrace floorY (${fmt(g.floorY)}) fell below lo (${fmt(exactLo)})`);
    check(g.top >= exactHi + b.h * 0.5,
      `hillside roof top (${fmt(g.top)}) buried near uphill corner (${fmt(exactHi)})`);

    // Steep hillside test: 12 m relief across a larger footprint.
    const steepB = { x: 5400, z: 5000, w: 50, d: 35, h: 9, rot: 0.4, kind: 'house' };
    const sg = slopeSys._ground(steepB);
    check(sg.relief >= 10, `steep building relief expected >= 10 m, got ${fmt(sg.relief)} m`);
    check(sg.base < sg.ground - 3.0, `steep plinth base too shallow (${fmt(sg.ground - sg.base)} m)`);
    check(sg.top >= sg.hi + steepB.h * 0.5, `steep roof buried (top=${fmt(sg.top)}, hi=${fmt(sg.hi)})`);
    check(sg.floorY >= sg.ground - 1e-6, 'steep floorY below lowest corner');

    // Verify hitBuilding agrees with the exact +rot corners on the rotated building.
    const rotSet = slopeSys.setCustomBuildings([[b.x, b.z, b.w, b.d, b.h, b.rot, 0, 0, 1, 42]]);
    const rb = rotSet.buildings[0];
    const rg = slopeSys._ground(rb);
    const midY = (rg.floorY + rg.top) * 0.5;
    const hitFrom = { x: rb.x - c * (hw + 6), y: midY, z: rb.z + s * (hw + 6) };
    const hitTo = { x: rb.x, y: midY, z: rb.z };
    const hit = slopeSys.hitBuilding(hitFrom, hitTo);
    check(!!hit, 'hitBuilding missed rotated +rot building on slope');
  } finally {
    setActiveDEM(null);
  }

  // 4-tier procedural LOD test (close, mid, far) + 3D roofs + plinths + churches.
  const lodScene = { add() {}, remove() {} };
  const lodSys = new BuildingSystem(lodScene, QUALITY.medium);
  check(!!lodSys.plinthMesh && !!lodSys.gableRoofMesh && !!lodSys.hipRoofMesh,
    'BuildingSystem did not create plinth/roof InstancedMesh pools');

  // Place 3 clusters:
  //   - Close (1200 m): 1 shed (tier 0), 1 house (tier 1), 1 church (tier 2)
  //   - Mid (6500 m):   1 shed (tier 0 -> hidden!), 1 house (tier 1 -> shown), 1 church (tier 2 -> shown)
  //   - Far (15000 m):  1 shed (tier 0 -> hidden!), 1 house (tier 1 -> hidden!), 1 tower (tier 2 -> shown)
  const lodRecords = [
    [1200, 1200, 6, 5, 4, 0, 5, 0, 0, 10],   // close shed (tier 0)
    [1240, 1200, 12, 9, 7, 0.2, 0, 0, 1, 20], // close house (tier 1)
    [1280, 1200, 16, 24, 15, 0.3, 4, 4, 2, 30], // close church (tier 2)
    [6500, 1200, 6, 5, 4, 0, 5, 0, 0, 40],   // mid shed (tier 0 -> hidden)
    [6540, 1200, 12, 9, 7, 0.2, 0, 1, 1, 50], // mid house (tier 1 -> shown)
    [6580, 1200, 16, 24, 15, 0.3, 4, 4, 2, 60], // mid church (tier 2 -> shown)
    [15000, 1200, 6, 5, 4, 0, 5, 0, 0, 70],   // far shed (tier 0 -> hidden)
    [15040, 1200, 12, 9, 7, 0.2, 0, 0, 1, 80], // far house (tier 1 -> hidden)
    [15080, 1200, 20, 20, 32, 0, 3, 2, 2, 90], // far tower (tier 2 -> shown)
  ];
  lodSys.setCustomBuildings(lodRecords, [[1240, 1200, 260, 2.0]]);
  lodSys.rebuild({ position: { x: 0, y: 120, z: 1200 } });

  check(lodSys.stats.lod.close === 3, `expected 3 close buildings, got ${lodSys.stats.lod.close}`);
  check(lodSys.stats.lod.mid === 2, `expected 2 mid buildings (shed hidden), got ${lodSys.stats.lod.mid}`);
  check(lodSys.stats.lod.far === 1, `expected 1 far building (shed & house hidden), got ${lodSys.stats.lod.far}`);
  check(lodSys.stats.lod.roofs >= 5, `expected >= 5 3D roofs/spires, got ${lodSys.stats.lod.roofs}`);
  check(lodSys.stats.lod.plinths >= 6, `expected >= 6 stone plinths, got ${lodSys.stats.lod.plinths}`);
  check(lodSys.grounds.size === 1, `expected 1 urban ground patch, got ${lodSys.grounds.size}`);
  lodSys.dispose();

  // Spatial grid performance: 20,000 synthetic custom buildings must rebuild < 25 ms.
  const perfScene = { add() {}, remove() {} };
  const perfSys = new BuildingSystem(perfScene, QUALITY.medium);
  const synth = [];
  for (let i = 0; i < 20000; i++) {
    const gx = ((i * 73) % 40000) - 20000;
    const gz = ((Math.floor(i / 200) * 197 + (i % 19) * 31) % 40000) - 20000;
    const tier = (i % 10 === 0) ? 2 : (i % 4 === 0 ? 0 : 1);
    const kind = tier === 2 ? (i % 20 === 0 ? 4 : 1) : (tier === 0 ? 5 : 0);
    synth.push([gx, gz, 12, 9, 8, (i % 6) * 0.5, kind, kind === 4 ? 4 : 0, tier, i & 255]);
  }
  perfSys.setCustomBuildings(synth);
  // Warm up JIT + ground cache once, then measure spatial-grid rebuild time.
  perfSys.rebuild({ position: { x: 4000, y: 300, z: 4000 } });
  const tRebuild0 = performance.now();
  perfSys.rebuild({ position: { x: 4300, y: 300, z: 4200 } });
  const rebuildMs = performance.now() - tRebuild0;
  check(rebuildMs < 25, `20k spatial-grid rebuild too slow (${fmt(rebuildMs)} ms, want < 25 ms)`);
  check(perfSys.stats.buildings > 0, '20k spatial-grid rebuild produced 0 buildings');
  perfSys.dispose();
}

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