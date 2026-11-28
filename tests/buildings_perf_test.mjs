// Node-only acceptance test for PKT-03 (PERF-03 + PERF-06, buildings part) and
// PKT-09 (PERF-11 layer-1 shadow proxies + PERF-13 daytime night-branch skip).
//
// Run: node tests/buildings_perf_test.mjs
//
// Invariants guarded here:
//   1. A live building collapse no longer re-streams the whole city every
//      frame. The burning block is drawn from a dedicated `collapseMesh` pool,
//      so `rebuild()` runs twice per collapse (start + end) instead of once per
//      frame for 2.4-3.8 s.
//   2. Instance uploads touch only the live prefix (`count * itemSize`) and an
//      empty pool that was already empty is not re-uploaded at all.
//   3. The four building pools cast their shadows through layer-1 proxy meshes
//      that share the main `instanceMatrix` buffers and only cover buildings
//      within SHADOW_NEAR_R of the camera.
//   4. The facade fragment shader skips the whole night-window block by day,
//      while every substring the Vipava visual contract asserts survives.
//
// Headless: a stub scene (`{ add, remove }`) is enough, exactly like
// tests/cities_destruction_test.mjs.

import { BuildingSystem, SHADOW_NEAR_R } from '../src/world/buildings.js';
import { settlementsNear } from '../src/world/settlements.js';
import { QUALITY } from '../src/config.js';

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);

const makeStubScene = () => ({ add() {}, remove() {} });
const COLLAPSE_CAP = 512;
const MATRIX_ITEM = 16;
const COLOR_ITEM = 3;

// PKT-09: [proxy, main, proxy name] for the four layer-1 shadow pools.
const PROXY_SPECS = [
  ['shadowMesh', 'mesh', 'buildings-shadow'],
  ['plinthShadowMesh', 'plinthMesh', 'building-plinths-shadow'],
  ['gableRoofShadowMesh', 'gableRoofMesh', 'building-gable-roofs-shadow'],
  ['hipRoofShadowMesh', 'hipRoofMesh', 'building-hip-roofs-shadow'],
];

// Instance translation lives at matrix elements 12 and 14 (column-major).
const instanceDist2 = (mesh, i, cx, cz) => {
  const arr = mesh.instanceMatrix.array;
  const dx = arr[i * MATRIX_ITEM + 12] - cx;
  const dz = arr[i * MATRIX_ITEM + 14] - cz;
  return dx * dx + dz * dz;
};

const countWithin = (mesh, cx, cz, r) => {
  let count = 0;
  for (let i = 0; i < mesh.count; i++) {
    if (instanceDist2(mesh, i, cx, cz) <= r * r) count++;
  }
  return count;
};

// ---------------------------------------------------------------------------
// 1. Construction: dedicated collapse pool next to the main city meshes
// ---------------------------------------------------------------------------
const sys = new BuildingSystem(makeStubScene(), QUALITY.medium);
const cm = sys.collapseMesh;
check(!!cm, 'collapseMesh was not created with a scene present');
if (cm) {
  check(cm.name === 'building-collapse', `collapseMesh name is '${cm.name}'`);
  check(cm.count === 0, `collapseMesh starts with count ${cm.count}, want 0`);
  check(cm.instanceMatrix.count === COLLAPSE_CAP,
    `collapseMesh capacity is ${cm.instanceMatrix.count}, want ${COLLAPSE_CAP}`);
  check(cm.geometry === sys.mesh.geometry, 'collapseMesh does not share the wall geometry');
  check(cm.material === sys.material, 'collapseMesh does not share the building material');
  check(cm.castShadow === true, 'collapseMesh must cast shadows');
  check(cm.receiveShadow === false, 'collapseMesh must not receive shadows');
  check(cm.frustumCulled === false, 'collapseMesh must not be frustum culled');
  check(!!cm.instanceColor, 'collapseMesh has no instanceColor buffer');
  check(!!cm.instanceColor && cm.instanceColor.count === COLLAPSE_CAP,
    'collapseMesh instanceColor is not sized to the pool');
}

// PKT-09 / PERF-11: construction of the layer-1 shadow proxies.
check(SHADOW_NEAR_R === 2400, `SHADOW_NEAR_R is ${SHADOW_NEAR_R}, want 2400`);
for (const [proxyKey, mainKey, name] of PROXY_SPECS) {
  const proxy = sys[proxyKey];
  const main = sys[mainKey];
  check(!!proxy, `${proxyKey} was not created with a scene present`);
  check(!!main, `${mainKey} is missing`);
  if (!proxy || !main) continue;
  check(proxy.name === name, `${proxyKey} name is '${proxy.name}', want '${name}'`);
  check(proxy.layers.isEnabled(1) === true, `${proxyKey} is not on layer 1`);
  check(proxy.layers.isEnabled(0) === false, `${proxyKey} is still drawn on layer 0`);
  check(proxy.castShadow === true, `${proxyKey} must cast shadows`);
  check(proxy.receiveShadow === false, `${proxyKey} must not receive shadows`);
  check(proxy.frustumCulled === false, `${proxyKey} must not be frustum culled`);
  check(proxy.instanceMatrix === main.instanceMatrix,
    `${proxyKey} does not share ${mainKey}.instanceMatrix`);
  check(proxy.geometry === main.geometry, `${proxyKey} does not share ${mainKey}'s geometry`);
  check(proxy.material === main.material, `${proxyKey} does not share ${mainKey}'s material`);
  check(proxy.instanceMatrix.count === main.instanceMatrix.count,
    `${proxyKey} capacity ${proxy.instanceMatrix.count} != ${mainKey} ${main.instanceMatrix.count}`);
  check(proxy.count === 0, `${proxyKey} starts with count ${proxy.count}, want 0`);
  check(main.castShadow === false, `${mainKey} must not cast shadows (its proxy does)`);
}
check(sys.ruinMesh.castShadow === true, 'ruinMesh must keep casting shadows');
check(sys.collapseMesh && sys.collapseMesh.castShadow === true, 'collapseMesh must keep casting shadows');

// Headless construction must stay safe (no WebGL objects at all).
const headless = new BuildingSystem(null, QUALITY.medium);
let headlessThrew = null;
try {
  headless._updateCollapseMesh();
  headless.update(1 / 60, null, null);
} catch (err) {
  headlessThrew = err;
}
check(headless.collapseMesh === null, 'headless system created a collapseMesh');
check(headless.shadowMesh === null, 'headless system created a shadowMesh');
check(headlessThrew === null, `headless collapse path threw: ${headlessThrew && headlessThrew.message}`);

// ---------------------------------------------------------------------------
// 2. Pick a real settlement + an isolated tall building to collapse
// ---------------------------------------------------------------------------
const near = settlementsNear(0, 0, 20000);
let site = null;
for (const s of near) {
  if (!site || s.buildings.length > site.buildings.length) site = s;
}
check(!!site && site.buildings.length >= 50, 'no sizeable settlement near the origin');

// The blast must level exactly one building, otherwise each distinct collapse
// end legitimately asks for its own rebuild and the rebuild count is no longer
// a clean measure of the PERF-03 fix. So pick the tall building with the widest
// clearance to its neighbours and use a zero splash radius.
let tall = null;
let tallClearance = 0;
for (const b of site.buildings) {
  if (!(b.h > 20)) continue;
  let clearance = Infinity;
  for (const o of site.buildings) {
    if (o === b) continue;
    const d = Math.hypot(o.x - b.x, o.z - b.z);
    if (d < clearance) clearance = d;
  }
  if (clearance > tallClearance) {
    tall = b;
    tallClearance = clearance;
  }
}
check(!!tall && tall.h > 20, 'no tall building to collapse');
check(tallClearance > Math.max(tall.w, tall.d) * 0.4 + 2,
  `no isolated tall building (clearance ${fmt(tallClearance)} m)`);

const camera = { position: { x: site.x, y: 120, z: site.z } };
sys.rebuild(camera);
check(sys.mesh.count > 0, 'rebuild placed no building instances');
check(sys.collapseMesh.count === 0, 'collapseMesh drew instances before any collapse');

// PERF-06: the first upload must cover only the live prefix.
{
  const ur = sys.mesh.instanceMatrix.updateRanges;
  check(ur.length === 1 && ur[0].start === 0 && ur[0].count === sys.mesh.count * MATRIX_ITEM,
    `mesh upload range is ${JSON.stringify(ur)}, want one range of ${sys.mesh.count * MATRIX_ITEM} floats`);
  check(ur[0].count < sys.mesh.instanceMatrix.count * MATRIX_ITEM,
    'mesh upload range still covers the whole pool');
  const urc = sys.mesh.instanceColor ? sys.mesh.instanceColor.updateRanges : [];
  check(urc.length === 1 && urc[0].count === sys.mesh.count * COLOR_ITEM,
    `mesh colour upload range is ${JSON.stringify(urc)}, want ${sys.mesh.count * COLOR_ITEM} floats`);
}

// ---------------------------------------------------------------------------
// 3. Headless collapse still animates and ends as permanent rubble
// ---------------------------------------------------------------------------
{
  const ghost = new BuildingSystem(null, QUALITY.medium);
  const res = ghost.applyBlast({ x: tall.x, y: tall.y, z: tall.z }, 20, 200);
  const key = `${site.id}:${Math.round(tall.x)}:${Math.round(tall.z)}`;
  check(res.destroyedCount >= 1, 'headless blast destroyed nothing');
  let threw = null;
  try {
    for (let f = 0; f < 400 && ghost.collapsing.size > 0; f++) {
      ghost.update(1 / 60, null, null);
    }
  } catch (err) {
    threw = err;
  }
  check(threw === null, `headless collapse update threw: ${threw && threw.message}`);
  check(ghost.destroyed.has(key), 'headless collapse never moved the building into destroyed');
}

// ---------------------------------------------------------------------------
// 4. Live collapse: animated in collapseMesh, 2 rebuilds instead of ~200
// ---------------------------------------------------------------------------
const tallKey = `${site.id}:${Math.round(tall.x)}:${Math.round(tall.z)}`;
const blast = sys.applyBlast({ x: tall.x, y: tall.y, z: tall.z }, 0, 200);
check(blast.destroyedCount >= 1, 'blast on the tall building destroyed nothing');
check(sys.collapsing.size === 1, `blast started ${sys.collapsing.size} collapses, want exactly 1`);
check(sys.collapsing.has(tallKey), 'the tall building is not collapsing');
check(sys._needsRebuild === true, 'applyBlast did not request a rebuild');

// Count rebuilds from here on: the collapse animation must not trigger them.
const rawRebuild = sys.rebuild.bind(sys);
let rebuilds = 0;
sys.rebuild = (cam) => {
  rebuilds++;
  return rawRebuild(cam);
};

// Predicted live emitters for the current frame, using the exact rule
// `_addCollapse` applies: a block stops drawing once its remaining height drops
// below 0.6 m. `collapsing` legitimately keeps the entry a little longer.
function liveEmitters() {
  let count = 0;
  for (const c of sys.collapsing.values()) {
    const g = sys._ground(c.b);
    const p = c.duration > 0 ? Math.min(1, c.t / c.duration) : 1;
    const eased = p * p * (3 - 2 * p);
    if ((g.top - g.base) * (1 - eased) >= 0.6) count++;
  }
  return count;
}

const FRAMES = 240;
let activeFrames = 0;
let emptyWhileActive = 0;
let staleWhileActive = 0;
let matrixChanged = false;
let rangeBad = 0;
let colorRangeBad = 0;
let capOverflow = 0;
let finishedFrame = -1;
let countAtFinish = -1;
let prevSnapshot = null;

for (let f = 0; f < FRAMES; f++) {
  sys.update(1 / 60, camera, null);

  if (sys.collapsing.size > 0) {
    activeFrames++;
    const emitters = liveEmitters();
    if (emitters > 0 && !(sys.collapseMesh.count > 0)) emptyWhileActive++;
    if (emitters === 0 && sys.collapseMesh.count !== 0) staleWhileActive++;
    if (sys.collapseMesh.count > COLLAPSE_CAP) capOverflow++;

    // The burn/fall animation must actually advance between frames.
    const matrix = sys.collapseMesh.instanceMatrix;
    const snapshot = Array.from(matrix.array.subarray(0, 32));
    if (prevSnapshot && snapshot.some((v, i) => v !== prevSnapshot[i])) matrixChanged = true;
    prevSnapshot = snapshot;

    // Only the live prefix is marked for upload.
    const ur = matrix.updateRanges;
    if (!(ur.length >= 1 && ur[ur.length - 1].start === 0 &&
      ur[ur.length - 1].count === sys.collapseMesh.count * MATRIX_ITEM)) rangeBad++;
    if (sys.collapseMesh.count > 0) {
      const urc = sys.collapseMesh.instanceColor.updateRanges;
      if (!(urc.length >= 1 && urc[urc.length - 1].count === sys.collapseMesh.count * COLOR_ITEM)) colorRangeBad++;
    }
  } else if (finishedFrame < 0 && sys.destroyed.has(tallKey)) {
    finishedFrame = f;
    countAtFinish = sys.collapseMesh.count;
  }
}

check(activeFrames > 0, 'the collapse never animated a single frame');
check(activeFrames >= 120, `collapse only animated ${activeFrames} frames, want >= 120`);
check(emptyWhileActive === 0, `${emptyWhileActive} frames with a live emitter drew 0 collapse instances`);
check(staleWhileActive === 0, `${staleWhileActive} frames drew collapse instances after every block fell below 0.6 m`);
check(capOverflow === 0, 'collapseMesh.count overflowed the 512-instance pool');
check(matrixChanged, 'collapseMesh matrices did not change between two frames');
check(rangeBad === 0, `${rangeBad} frames uploaded a collapse range other than count * 16`);
check(colorRangeBad === 0, `${colorRangeBad} frames uploaded a collapse colour range other than count * 3`);

// PERF-03: two rebuilds (collapse start + collapse end), not 144-228.
check(rebuilds <= 3, `rebuild ran ${rebuilds} times across ${FRAMES} frames (want <= 3)`);
check(rebuilds >= 2, `expected a rebuild at collapse start and end, saw ${rebuilds}`);

// End state: permanent rubble, empty animation pool.
check(finishedFrame >= 0, 'the collapse never finished within the 240 frames');
check(sys.collapsing.size === 0, `collapsing still holds ${sys.collapsing.size} entries after the loop`);
check(sys.destroyed.has(tallKey), 'the collapsed building never became permanent rubble');
check(countAtFinish === 0, `collapseMesh.count was ${countAtFinish} on the frame the collapse ended`);
check(sys.collapseMesh.count === 0, `collapseMesh.count is ${sys.collapseMesh.count} after the collapse`);
check(sys.ruinMesh.count > 0, 'no ruin instances after the final rebuild');
{
  const ur = sys.ruinMesh.instanceMatrix.updateRanges;
  check(ur.length === 1 && ur[0].count === sys.ruinMesh.count * MATRIX_ITEM,
    `ruin upload range is ${JSON.stringify(ur)}, want ${sys.ruinMesh.count * MATRIX_ITEM}`);
}
{
  const ur = sys.mesh.instanceMatrix.updateRanges;
  check(ur.length === 1 && ur[0].start === 0 && ur[0].count === sys.mesh.count * MATRIX_ITEM,
    `post-collapse mesh upload range is ${JSON.stringify(ur)}, want ${sys.mesh.count * MATRIX_ITEM}`);
}
const builtInstances = sys.mesh.count;
const builtRuins = sys.ruinMesh.count;

// ---------------------------------------------------------------------------
// 5. An empty pool that was already empty is not re-uploaded (PERF-06)
// ---------------------------------------------------------------------------
{
  const quiet = new BuildingSystem(makeStubScene(), QUALITY.low); // roadDetail: false
  quiet.rebuild(camera);
  check(quiet.lightMesh.count === 0, `expected no street lamps, got ${quiet.lightMesh.count}`);
  const versionBefore = quiet.lightMesh.instanceMatrix.version;
  const rangesBefore = quiet.lightMesh.instanceMatrix.updateRanges.length;
  quiet.rebuild(camera);
  check(quiet.lightMesh.instanceMatrix.version === versionBefore,
    `empty light pool re-uploaded (version ${versionBefore} -> ${quiet.lightMesh.instanceMatrix.version})`);
  check(quiet.lightMesh.instanceMatrix.updateRanges.length === rangesBefore,
    'empty light pool update ranges changed on an empty rebuild');
  quiet.dispose();
}

// ---------------------------------------------------------------------------
// 6. PKT-09 / PERF-11: layer-1 shadow proxies only cover the near ring
// ---------------------------------------------------------------------------
// A synthetic OSM-style city: 36 buildings within ~1,060 m of the camera (four
// of them churches, which give gable nave roofs AND hip campanile spires, so
// every pool has near instances) and 36 identical buildings 6.4-8.5 km out.
{
  const pk = new BuildingSystem(makeStubScene(), QUALITY.medium);
  const camX = 8000;
  const camZ = 8000;
  const records = [];
  const pushBuilding = (x, z, church, seed) => {
    records.push([
      x, z,
      church ? 9 : 8, church ? 14 : 9, church ? 11 : 8, 0,
      church ? 4 : 0,   // kindCode: 4 = church
      church ? 4 : 0,   // roofCode: 4 = church (gable nave + hip spire)
      2,                // tier: survives the mid/far LOD filter
      seed & 255,
    ]);
  };
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      pushBuilding(camX - 750 + i * 300, camZ - 750 + j * 300, i < 2 && j < 2, i * 6 + j);
    }
  }
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      pushBuilding(camX + 4500 + i * 300, camZ + 4500 + j * 300, i === 0 && j === 0, 100 + i * 6 + j);
    }
  }
  const custom = pk.setCustomBuildings(records, null);
  check(!!custom && custom.buildings.length === records.length,
    `synthetic custom settlement loaded ${custom?.buildings.length || 0}/${records.length} buildings`);

  const camera = { position: { x: camX, y: 120, z: camZ } };
  pk.rebuild(camera);

  check(pk.mesh.count > 0, 'PKT-09 rebuild placed no wall instances');
  check(pk.shadowMesh.count > 0, 'shadowMesh drew no near instances');
  // The 36 far buildings are all streamed (tier 2, well inside rMid) and all
  // lie outside the shadow ring, so they must never enter any proxy.
  check(pk.mesh.count >= pk.shadowMesh.count + 36,
    `only ${pk.mesh.count} walls for ${pk.shadowMesh.count} near + 36 far candidates`);

  for (const [proxyKey, mainKey, name] of PROXY_SPECS) {
    const proxy = pk[proxyKey];
    const main = pk[mainKey];
    if (!proxy || !main) continue;
    const expectedNear = countWithin(main, camX, camZ, SHADOW_NEAR_R);
    check(proxy.count === expectedNear,
      `${name}.count is ${proxy.count}, want ${expectedNear} (near instances of ${mainKey})`);
    check(proxy.count >= 0 && proxy.count <= main.count,
      `${name}.count ${proxy.count} exceeds ${mainKey}.count ${main.count}`);

    let worstD2 = 0;
    let worstIdx = -1;
    for (let i = 0; i < proxy.count; i++) {
      const d2 = instanceDist2(proxy, i, camX, camZ);
      if (d2 > worstD2) { worstD2 = d2; worstIdx = i; }
    }
    check(proxy.count === 0 || worstD2 <= SHADOW_NEAR_R * SHADOW_NEAR_R,
      `${name} instance ${worstIdx} sits ${fmt(Math.sqrt(worstD2))} m from the camera ` +
      `(limit ${SHADOW_NEAR_R} m)`);
    // The proxy must not be limited by the pool prefix it shares: everything it
    // draws is a building the rebuild wrote first.
    check(proxy.count <= proxy.instanceMatrix.count,
      `${name}.count ${proxy.count} overflows its shared buffer ${proxy.instanceMatrix.count}`);
  }

  // Near instances exist in all four pools for this city; the hip spires prove
  // the proxy path works for the roof pools too.
  check(pk.shadowMesh.count > 0 && pk.plinthShadowMesh.count > 0 &&
    pk.gableRoofShadowMesh.count > 0 && pk.hipRoofShadowMesh.count > 0,
    `near ring empty in some pool: walls ${pk.shadowMesh.count}, plinths ${pk.plinthShadowMesh.count}, ` +
    `gables ${pk.gableRoofShadowMesh.count}, hips ${pk.hipRoofShadowMesh.count}`);
  check(pk.hipRoofMesh.count > pk.hipRoofShadowMesh.count,
    `far hip roofs leaked into the shadow proxy (${pk.hipRoofShadowMesh.count}/${pk.hipRoofMesh.count})`);

  // PERF-13: the night-window block is now a uniform daytime branch, while the
  // declared palette / occupancy / switching strings stay in the shader.
  const frag = pk.material.fragmentShader;
  const nightAt = frag.indexOf('if (uNight > 0.001)');
  check(nightAt >= 0, 'fragment shader has no "if (uNight > 0.001)" branch');
  check(nightAt >= 0 && nightAt === frag.lastIndexOf('if (uNight > 0.001)'),
    'the night branch appears more than once');
  const instAt = frag.indexOf('vec2 instCell = floor(vInstXZ * 0.25)');
  const seedAt = frag.indexOf('float buildingSeed = h21(instCell');
  check(instAt >= 0, 'vec2 instCell = floor(vInstXZ * 0.25) is missing');
  check(seedAt >= 0, 'float buildingSeed = h21(instCell ...) is missing');
  check(instAt >= 0 && instAt < nightAt, 'instCell is declared inside the night branch');
  check(seedAt >= 0 && seedAt < nightAt, 'buildingSeed is declared inside the night branch');

  const openBraces = (frag.match(/\{/g) || []).length;
  const closeBraces = (frag.match(/\}/g) || []).length;
  check(openBraces === closeBraces && openBraces > 0,
    `fragment shader braces are unbalanced (${openBraces} "{" vs ${closeBraces} "}")`);
  check(frag.includes('#include <fog_fragment>') &&
    frag.includes('#include <tonemapping_fragment>') &&
    frag.includes('#include <colorspace_fragment>'),
    'fog / tone mapping / colour space includes were dropped');
  check(frag.includes('float occupancy = mix(resOcc, bigOcc, isBig);') &&
    frag.includes('* 1.15 * brightness') && !frag.includes('* 1.45 *'),
    'night occupancy / 1.15x emissive contract changed');
  check(frag.indexOf('float occupancy = mix(resOcc, bigOcc, isBig);') > nightAt,
    'the occupancy roll is not inside the night branch');
  check(frag.indexOf('col += winColor * lit * uNight * 1.15 * brightness;') > nightAt,
    'the lit-window emission is not inside the night branch');
  check(frag.indexOf('float roofPick = h21(vec2(buildingSeed') > nightAt,
    'the roof shading (which needs buildingSeed) did not survive the branch');
  check(frag.includes('uniform float uNight, uCullDist, uTime;'),
    'uNight/uCullDist/uTime uniform declaration changed');

  console.log(`shadow proxies   : ${pk.shadowMesh.count}/${pk.mesh.count} walls, ` +
    `${pk.plinthShadowMesh.count}/${pk.plinthMesh.count} plinths, ` +
    `${pk.gableRoofShadowMesh.count}/${pk.gableRoofMesh.count} gables, ` +
    `${pk.hipRoofShadowMesh.count}/${pk.hipRoofMesh.count} hips within ${SHADOW_NEAR_R} m`);

  pk.dispose();
  check(pk.shadowMesh === null && pk.plinthShadowMesh === null &&
    pk.gableRoofShadowMesh === null && pk.hipRoofShadowMesh === null,
    'dispose() did not release the shadow proxies');
}

sys.dispose();
check(sys.collapseMesh === null, 'dispose() did not release the collapseMesh');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Buildings perf — acceptance test (PKT-03 / PERF-03 + PERF-06)');
console.log('==============================================================');
console.log(`settlement       : ${site.type} ${site.name} (${site.buildings.length} buildings)`);
console.log(`collapse target  : ${fmt(tall.w)}x${fmt(tall.d)} m, ${fmt(tall.h)} m tall`);
console.log(`rebuilds / ${FRAMES} frames: ${rebuilds} (was one per frame before PKT-03)`);
console.log(`collapse frames  : ${activeFrames}, collapsed at frame ${finishedFrame}`);
console.log(`instances        : ${builtInstances} walls, ${builtRuins} ruin pieces after the collapse`);
console.log(`checks: ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  process.exitCode = 1;
} else {
  console.log('OK');
}