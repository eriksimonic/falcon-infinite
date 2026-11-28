// Headless acceptance test for Feature 29 — Vipava cities streaming + iconic
// 3D landmarks.
// Run: node tests/landmarks_test.mjs
//
// Three sections, no DOM and no WebGL anywhere:
//   1. `LandmarkSystem(null)` normalizes every kind, grounds it on the supplied
//      height sampler and clears cleanly.
//   2. A stub scene ({ add, remove }) builds real THREE meshes + animated
//      beacons for all six kinds, and update(dt) pulses them without a renderer.
//   3. `loadVipavaOSM()` surfaces the baked `landmarks` array (and still
//      returns [] when a payload predates it).

import * as THREE from 'three';
import { LandmarkSystem, LANDMARK_KINDS } from '../src/world/landmarks.js';
import { loadVipavaOSM, _resetVipavaOSMCache } from '../src/world/dem.js';
import { BuildingSystem } from '../src/world/buildings.js';
import { QUALITY } from '../src/config.js';

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

// Same sampler shape as terrainHeight: world metres in, elevation out.
const heightAt = (x, z) => 420 + x * 0.012 + z * 0.006 + Math.sin(x / 2500) * 30;

const ALL_KINDS = [
  { id: 'sveta-gora', name: 'Sveta Gora Basilica', kind: 'church', x: 1200, z: -800, rot: 0.4, scale: 1.35 },
  { id: 'solkan-bridge', name: 'Solkan Stone Arch Bridge', kind: 'bridge', x: -2600, z: 4100, rot: 1.48, length: 220, height: 36 },
  { id: 'vogrscek-dam', name: 'Vogršček Dam', kind: 'dam', x: 7300, z: 2100, rot: 0.65, length: 280, height: 32 },
  { id: 'nanos-tower', name: 'Nanos Broadcast Tower (Pleša)', kind: 'tower', x: -4100, z: -1900, rot: 0, height: 95 },
  { id: 'predjama-castle', name: 'Predjama Castle', kind: 'castle', x: 2600, z: 6300, rot: 1.1, scale: 1.15 },
  { id: 'faro-vittoria', name: 'Faro della Vittoria (Trieste)', kind: 'lighthouse', x: -12000, z: 21500, rot: 0, height: 68 },
];

// ---------------------------------------------------------------------------
// 1. Headless (scene === null): normalization, grounding, clear()
// ---------------------------------------------------------------------------
{
  const sys = new LandmarkSystem(null);
  check(sys.group === null, 'scene-less system created a THREE.Group');
  check(Array.isArray(sys.landmarks) && sys.landmarks.length === 0, 'landmarks does not start empty');
  check(Array.isArray(sys._beacons) && sys._beacons.length === 0, '_beacons does not start empty');
  near(sys._time, 0, 1e-9, '_time does not start at 0');

  const n = sys.setLandmarks(ALL_KINDS, heightAt);
  check(n === ALL_KINDS.length, `setLandmarks placed ${n} of ${ALL_KINDS.length}`);
  check(sys.landmarks.length === n, 'this.landmarks length disagrees with the return value');
  check(sys.group === null, 'scene-less setLandmarks tried to build meshes');

  const seen = new Set();
  for (const lm of sys.landmarks) {
    seen.add(lm.kind);
    check(typeof lm.id === 'string' && lm.id.length > 0, `landmark ${lm.name} lost its id`);
    check(typeof lm.name === 'string' && lm.name.length > 0, `landmark ${lm.id} lost its name`);
    near(lm.y, heightAt(lm.x, lm.z), 1e-9, `${lm.id} not grounded on heightAt`);
    check(!('object' in lm), `${lm.id} built a mesh without a scene`);
  }
  check(seen.size === 6, `only ${seen.size}/6 landmark kinds normalized`);
  for (const kind of LANDMARK_KINDS) {
    check(seen.has(kind), `kind ${kind} missing from normalized landmarks`);
  }

  // update() is safe with no meshes at all.
  sys.update(0.016);
  near(sys._time, 0.016, 1e-9, 'update(dt) does not advance _time headlessly');

  // Empty / junk payloads return 0 and stay empty.
  check(sys.setLandmarks([], heightAt) === 0, 'empty list did not return 0');
  check(sys.landmarks.length === 0, 'empty list left landmarks behind');
  check(sys.setLandmarks(null, heightAt) === 0, 'null list did not return 0');
  check(sys.setLandmarks(undefined, heightAt) === 0, 'undefined list did not return 0');
  check(sys.setLandmarks('nope', heightAt) === 0, 'string payload did not return 0');

  const filtered = sys.setLandmarks([
    { kind: 'church', x: NaN, z: 0 },
    null,
    { kind: 'church' },
    { kind: 'church', x: 5, z: 6 },
  ], heightAt);
  check(filtered === 1, `junk landmark records not filtered (${filtered} kept)`);

  sys.clear();
  check(sys.landmarks.length === 0, 'clear() left landmarks behind');
  check(sys._beacons.length === 0, 'clear() left beacons behind');

  // A second build after clear must work (materials were released, not cached).
  check(sys.setLandmarks(ALL_KINDS, heightAt) === 6, 'system unusable after clear()');
  sys.dispose();
  check(sys.landmarks.length === 0, 'dispose() left landmarks behind');

  // Invalid height sampler falls back to terrainHeight instead of throwing.
  const fallback = new LandmarkSystem(null);
  check(fallback.setLandmarks([{ kind: 'tower', x: 0, z: 0 }], 'not a function') === 1,
    'invalid heightAt was not tolerated');
  fallback.dispose();
}

// ---------------------------------------------------------------------------
// 2. Stub scene: real meshes + animated beacons for all six kinds
// ---------------------------------------------------------------------------
{
  const stubScene = {
    children: [],
    add(obj) {
      this.children.push(obj);
      obj.parent = this;
    },
    remove(obj) {
      const i = this.children.indexOf(obj);
      if (i >= 0) this.children.splice(i, 1);
      obj.parent = null;
    },
  };

  const sys = new LandmarkSystem(stubScene);
  check(sys.group instanceof THREE.Group, 'stub-scene system has no THREE.Group');
  check(sys.group.parent === stubScene, 'landmark group was not added to the scene');
  check(sys.group.name === 'landmarks', 'landmark group is unnamed');

  const n = sys.setLandmarks(ALL_KINDS, heightAt);
  check(n === 6, `stub-scene setLandmarks placed ${n}/6`);
  check(sys.group.children.length === 6, `group holds ${sys.group.children.length} landmark objects`);

  const byKind = new Map();
  for (const lm of sys.landmarks) {
    byKind.set(lm.kind, lm);
    const obj = lm.object;
    check(obj instanceof THREE.Group, `${lm.id} did not build an object`);
    check(sys.group.children.includes(obj), `${lm.id} object was not attached to the group`);
    near(obj.position.y, lm.y, 1e-9, `${lm.id} mesh is not at its grounded height`);
    near(obj.position.x, lm.x, 1e-9, `${lm.id} mesh is not at its x`);
    near(obj.position.z, lm.z, 1e-9, `${lm.id} mesh is not at its z`);
    check(obj.rotation.y === lm.rot, `${lm.id} mesh ignores its rotation`);
  }

  for (const kind of LANDMARK_KINDS) {
    const lm = byKind.get(kind);
    if (!lm) {
      check(false, `kind ${kind} was not built`);
      continue;
    }
    // Multi-part: a landmark must be several meshes, not one box.
    check(lm.object.children.length >= 4, `${kind} is not a multi-part mesh (${lm.object.children.length} parts)`);
    let triangles = 0;
    lm.object.traverse((o) => {
      if (o.isMesh && o.geometry) {
        const pos = o.geometry.getAttribute('position');
        if (pos) triangles += Math.max(0, pos.count / 3);
      }
    });
    check(triangles >= 20, `${kind} geometry is too thin (${triangles} tris)`);

    // The 4 m foundation skirt: bottom of the bounding box sits ~4 m below the
    // ground sample, so hilltop landmarks never float.
    const box = new THREE.Box3().setFromObject(lm.object);
    const skirt = lm.y - box.min.y;
    check(skirt >= 3.5 && Number.isFinite(box.min.y),
      `${kind} lacks a deep foundation skirt (skirt ${skirt.toFixed(2)} m)`);

    // Tall structures reach well above the ground.
    const top = box.max.y - lm.y;
    check(top > 5, `${kind} is flat (top ${top.toFixed(1)} m)`);
  }

  // Bridge / dam / tower / lighthouse declared sizes are honoured.
  {
    const bridge = byKind.get('bridge');
    const box = new THREE.Box3().setFromObject(bridge.object);
    const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    check(span >= 180, `bridge does not span its ${bridge.length} m (got ${span.toFixed(1)})`);
    const tower = byKind.get('tower');
    const tbox = new THREE.Box3().setFromObject(tower.object);
    check(tbox.max.y - tower.y > 90, `Nanos mast does not reach ${tower.height} m`);
  }

  // Beacons: red aviation strobe on the mast, white pulse on the lighthouse.
  check(sys._beacons.length === 2, `expected 2 beacons, got ${sys._beacons.length}`);
  const aviation = sys._beacons.find((b) => b.kind === 'aviation');
  const lighthouse = sys._beacons.find((b) => b.kind === 'lighthouse');
  check(!!aviation, 'broadcast tower has no aviation beacon');
  check(!!lighthouse, 'lighthouse has no lighthouse beacon');
  check(aviation.mesh.visible === true, 'aviation beacon starts hidden');
  check(aviation.material.emissiveIntensity > 0, 'aviation beacon has no emissive glow');
  check(!!lighthouse.material && lighthouse.material.transparent === true, 'lighthouse beacon is not a light source');

  // update() must blink / pulse them.
  const t0 = sys._time;
  const lum0 = lighthouse.material.opacity;
  const scale0 = lighthouse.mesh.scale.x;
  let aviationFlips = 0;
  let lastVisible = aviation.mesh.visible;
  let maxAvi = aviation.material.emissiveIntensity;
  let minAvi = aviation.material.emissiveIntensity;
  for (let i = 0; i < 90; i++) {
    sys.update(0.05);
    if (aviation.mesh.visible !== lastVisible) {
      aviationFlips++;
      lastVisible = aviation.mesh.visible;
    }
    maxAvi = Math.max(maxAvi, aviation.material.emissiveIntensity);
    minAvi = Math.min(minAvi, aviation.material.emissiveIntensity);
  }
  near(sys._time, t0 + 4.5, 1e-6, 'update(dt) does not accumulate _time');
  check(aviationFlips >= 2, `aviation strobe never blinked (${aviationFlips} flips)`);
  check(maxAvi - minAvi > 1, 'aviation beacon emissive intensity never changed');
  check(Math.abs(lighthouse.material.opacity - lum0) > 0.05,
    'lighthouse beacon never pulsed');
  check(Math.abs(lighthouse.mesh.scale.x - scale0) > 0.02,
    'lighthouse beacon never changed scale');
  check(Number.isFinite(sys._time), '_time became non-finite');
  sys.update(NaN);
  check(Number.isFinite(sys._time), 'NaN dt corrupted _time');

  // Clear / rebuild / dispose on a live scene.
  sys.clear();
  check(sys.group.children.length === 0, 'clear() left landmark meshes in the group');
  check(sys._beacons.length === 0, 'clear() left animated beacons');
  check(sys.setLandmarks(ALL_KINDS, heightAt) === 6, 'cannot rebuild after clear()');
  check(sys._beacons.length === 2, 'beacons not rebuilt after clear()');
  sys.setLandmarks(null, heightAt);
  check(sys.group.children.length === 0, 'setLandmarks(null) left meshes behind');
  sys.setLandmarks(ALL_KINDS, heightAt);
  sys.dispose();
  check(sys.group === null, 'dispose() left the group attached');
  check(stubScene.children.length === 0, 'dispose() left the group in the stub scene');
}

// ---------------------------------------------------------------------------
// 3. dem.js — loadVipavaOSM() surfaces the baked landmarks array
// ---------------------------------------------------------------------------
{
  const realFetch = globalThis.fetch;
  try {
    _resetVipavaOSMCache();
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          roads: [{ w: 8, pts: [[0, 0], [10, 0]] }],
          buildings: [[1, 2, 3, 4, 5, 0, 0]],
          landmarks: [{ id: 'x', kind: 'church', x: 10, z: 20 }],
        };
      },
    });
    const osm = await loadVipavaOSM('stub://vipava');
    check(!!osm, 'loadVipavaOSM(stub) failed');
    check(Array.isArray(osm?.landmarks) && osm.landmarks.length === 1,
      'loadVipavaOSM did not surface the baked landmarks array');

    // A payload from before the landmark bake must still load with [].
    _resetVipavaOSMCache();
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { roads: [], buildings: [] };
      },
    });
    const legacy = await loadVipavaOSM('stub://legacy');
    check(!!legacy, 'legacy OSM payload failed to load');
    check(Array.isArray(legacy?.landmarks) && legacy.landmarks.length === 0,
      'legacy OSM payload did not default landmarks to []');
  } finally {
    globalThis.fetch = realFetch;
    _resetVipavaOSMCache();
  }
}

// ---------------------------------------------------------------------------
// 4. buildings.js — the baked city streams per building out to 24 km
// ---------------------------------------------------------------------------
{
  const stubScene = { add() {}, remove() {} };
  const sys = new BuildingSystem(stubScene, QUALITY.medium);

  // Buildings 2 km apart on a line: at 8 km camera radius only the near ones
  // must be streamed, and with a 3-instance budget the nearest three win.
  const list = [];
  for (let i = 0; i < 40; i++) list.push([i * 2000, 500, 20, 16, 12, 0, 0]);
  sys.setCustomBuildings(list);
  check(sys.customSettlement !== null, 'setCustomBuildings produced no settlement');
  near(sys.customSettlement.radius, 52000, 1e-6, 'custom settlement radius not 52 km');

  const camera = { position: { x: 0, y: 0, z: 0 } };
  check(sys._streamBuildings(sys.customSettlement, 0, 500, 8000, 16000).length === 5,
    'per-building stream radius did not cut at 8 km');
  check(sys._streamBuildings(sys.customSettlement, 0, 500, 24000, 16000).length === 13,
    'per-building stream did not reach 24 km');

  const nearest = sys._streamBuildings(sys.customSettlement, 0, 500, 24000, 3);
  check(nearest.length === 3, 'instance budget did not cap the stream');
  check(nearest[0].x === 0 && nearest[1].x === 2000 && nearest[2].x === 4000,
    'instance budget did not keep the nearest buildings');

  sys.rebuild(camera);
  check(sys.stats.buildings > 0 && sys.stats.buildings <= 16000,
    'rebuild with the baked city placed no instances');
  sys.setCustomBuildings(null);
  sys.dispose();
}

// ---------------------------------------------------------------------------
// 5. Feature 40 — per-pier canyon bridge & corner-grounded hilltop church
// ---------------------------------------------------------------------------
{
  const stubScene = {
    children: [],
    add(obj) { this.children.push(obj); obj.parent = this; },
    remove(obj) { const i = this.children.indexOf(obj); if (i >= 0) this.children.splice(i, 1); obj.parent = null; },
  };
  const sys = new LandmarkSystem(stubScene);

  // Deep asymmetric canyon: banks at x = ±110 m differ by 60 m (100 m & 160 m)
  // while the gorge floor dips to 40 m at x = 0!
  const canyonHeight = (x) => {
    const u = Math.max(-1, Math.min(1, x / 110));
    const bankSlope = 130 + 30 * u; // 100 m at -110, 160 m at +110
    const gorge = -90 * (1 - u * u); // -90 m deep at x = 0 -> 40 m floor
    return bankSlope + gorge;
  };
  const bridgeRec = {
    id: 'canyon-viaduct',
    name: 'Steep Canyon Bridge',
    kind: 'bridge',
    x: 0,
    z: 0,
    rot: 0,
    length: 220,
    height: 36,
    scale: 1,
  };
  sys.setLandmarks([bridgeRec], canyonHeight);
  const lm = sys.landmarks[0];
  check(!!lm && !!lm._groundMeta, 'canyon bridge missing _groundMeta');
  if (lm && lm._groundMeta) {
    const { deckA, deckB, pierGrounds } = lm._groundMeta;
    check(pierGrounds.length >= 4, `expected >= 4 grounded bridge piers, got ${pierGrounds.length}`);
    for (const pg of pierGrounds) {
      check(pg.pierBot <= pg.gPier - 4.0,
        `pier at px=${pg.px} did not reach <= gPier - 4 m (bot=${pg.pierBot}, g=${pg.gPier})`);
      check(pg.deckY > pg.gPier + 0.5,
        `bridge deck buried at px=${pg.px} (deckY=${pg.deckY}, g=${pg.gPier})`);
    }
    const grade = Math.abs(deckB - deckA) / 220;
    check(grade <= 0.085, `bridge grade exceeded 8% (${(grade * 100).toFixed(1)}%)`);
  }

  // Hilltop church on a steep 12 m slope along Z: BOTH nave and campanile
  // foundations must extend below their own local corners.
  const hillChurchHeight = (x, z) => 600 + 0.25 * z + 0.1 * x;
  const churchRec = {
    id: 'hilltop-basilica',
    name: 'Hilltop Basilica',
    kind: 'church',
    x: 0,
    z: 0,
    rot: 0,
    scale: 1.3,
  };
  sys.setLandmarks([churchRec], hillChurchHeight);
  const ch = sys.landmarks[0];
  check(!!ch && !!ch._groundMeta, 'hilltop church missing _groundMeta');
  if (ch && ch._groundMeta) {
    const { naveRange, towerRange, baseY } = ch._groundMeta;
    check(naveRange.maxY - naveRange.minY >= 8, 'hilltop church nave slope test too flat');
    check(baseY >= naveRange.maxY - 1.6, 'hilltop church portal buried on uphill side');
    // Audit actual world bounding box of nave & campanile foundation meshes.
    ch.object.updateMatrixWorld(true);
    const overall = new THREE.Box3().setFromObject(ch.object);
    const lowestCornerWorld = ch.y + Math.min(naveRange.minY, towerRange.minY);
    check(overall.min.y <= lowestCornerWorld - 4.0,
      `hilltop church foundation floats (minY=${overall.min.y.toFixed(1)}, lowestCorner=${lowestCornerWorld.toFixed(1)})`);
    // Verify campanile foundation mesh specifically sits at tz (not hardcoded 0)
    // and extends below towerRange.minY - 4 m!
    const tz = -28 * 1.3 * 0.5 - 7 * 1.3 * 0.5 - 1;
    let campMinY = Infinity;
    for (const child of ch.object.children) {
      if (Math.abs(child.position.z - tz) < 1.0) {
        const b = new THREE.Box3().setFromObject(child);
        if (b.min.y < campMinY) campMinY = b.min.y;
      }
    }
    check(campMinY <= ch.y + towerRange.minY - 4.0,
      `campanile foundation did not ground at tz=${tz.toFixed(1)} (minY=${campMinY.toFixed(1)}, want <= ${(ch.y + towerRange.minY - 4).toFixed(1)})`);
  }

  sys.dispose();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Vipava cities & iconic landmarks — acceptance test');
console.log('=================================================');
console.log(`kinds   : ${LANDMARK_KINDS.join(', ')}`);
console.log(`checks  : ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.log('  - ' + f);
  if (failures.length > 30) console.log(`  ... and ${failures.length - 30} more`);
  process.exit(1);
}
console.log('\nALL LANDMARK CHECKS PASSED');
process.exit(0);