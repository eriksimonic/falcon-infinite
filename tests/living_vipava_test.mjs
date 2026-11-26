// Headless acceptance test for Feature 31 — Living Vipava Valley.
// Run: node tests/living_vipava_test.mjs
//
// No DOM and no WebGL anywhere:
//   1. RoadTrafficSystem(null) normalizes the baked OSM road shape, spawns
//      vehicles, advances them along their polylines, wraps seamlessly and
//      clears back to zero stats.
//   2. RoadTrafficSystem on a stub scene sizes both instanced light pools,
//      fades them with `night` and disposes cleanly.
//   3. LandmarkSystem.update(dt, night) runs headlessly across night 0 and 1
//      and the uplights / obstruction beacons / lighthouse beam light up on a
//      stub scene.
//   4. AirportSystem is headless-safe with the Feature 31 call shape.
//   5. The buildings shader carries the warm / amber / cool office window
//      palette and the 1.45x night boost.

import { RoadTrafficSystem } from '../src/world/traffic_roads.js';
import { LandmarkSystem } from '../src/world/landmarks.js';
import { AirportSystem } from '../src/world/airports.js';
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

// Flat valley sampler: every road deck must land on 400 m + 1.15 m light lift.
const GROUND = 400;
const flatHeight = () => GROUND;

function makeStubScene() {
  return {
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
}

// ---------------------------------------------------------------------------
// 1. RoadTrafficSystem — headless road filtering, spawn, motion, wrapping
// ---------------------------------------------------------------------------
{
  const sys = new RoadTrafficSystem(null, QUALITY.medium);
  check(sys.scene === null, 'headless traffic system kept a scene');
  check(sys.headMesh === null && sys.tailMesh === null, 'headless traffic built meshes');
  check(sys.stats.roads === 0 && sys.stats.vehicles === 0 && sys.stats.visible === 0,
    'fresh traffic stats are not zero');
  check(sys.maxVehicles === 220, `medium preset budget is ${sys.maxVehicles}, want 220`);

  // Baked shape ({ w, pts }) is the real payload; the normalized
  // ({ width, points, kind }) shape must be accepted too.
  const roads = [
    // 2000 m expressway running +Z: the main two-way artery.
    { w: 16, pts: [[-4000, 0], [-4000, 1000], [-4000, 2000]] },
    // Too short (100 m) and must be dropped.
    { width: 9, points: [{ x: 100, z: 0 }, { x: 200, z: 0 }] },
    // 1500 m motorway running +X.
    { kind: 'motorway', width: 12, points: [{ x: 0, z: 0 }, { x: 750, z: 0 }, { x: 1500, z: 0 }] },
    { w: 8, pts: [[5, 5]] }, // junk: single point
    null,
    { w: 8, pts: [[0, 0], [NaN, 10]] }, // junk: non-finite
  ];

  const n = sys.setCustomRoads(roads, flatHeight);
  check(n === 2, `setCustomRoads kept ${n}/2 usable roads`);
  check(sys.roads.length === 2, 'this.roads disagrees with the return value');
  check(sys.roads.every((r) => r.total >= 350), 'a road shorter than 350 m survived the filter');
  check(sys.roads[0].total === 2000, `longest road total is ${sys.roads[0].total}, want 2000`);
  check(sys.roads[0].ys instanceof Float32Array && sys.roads[0].ys.length === 3,
    'per-vertex terrain elevations were not precomputed');
  near(sys.roads[0].ys[0], GROUND + 1.15, 1e-4, 'road lamp elevation is not terrain + 1.15 m');
  check(sys.stats.roads === 2, `stats.roads is ${sys.stats.roads}, want 2`);
  check(sys.stats.vehicles > 0 && sys.stats.vehicles <= sys.maxVehicles,
    `spawned ${sys.stats.vehicles} vehicles outside 1..${sys.maxVehicles}`);
  check(sys.vehicles.length === sys.stats.vehicles, 'stats.vehicles disagrees with the vehicle array');
  check(sys.vehicles.some((v) => v.dir === 1) && sys.vehicles.some((v) => v.dir === -1),
    'traffic is not bidirectional');
  check(sys.vehicles.every((v) => v.speed >= 18 && v.speed <= 34),
    'a vehicle speed is outside 18..34 m/s');

  // Any returns from {{setCustomRoads}} must reset, never append.
  const restated = sys.setCustomRoads(roads, flatHeight);
  check(restated === 2, 'a second setCustomRoads did not rebuild from scratch');
  check(sys.vehicles.length <= sys.maxVehicles, 'a second setCustomRoads exceeded the vehicle budget');

  // Vehicles sit 1.8 m right of the centreline in their travel direction, so
  // the northbound (-Z expressway) car sits at x = -4000 - 1.8 and the
  // southbound one at x = -4000 + 1.8.
  const expresswayCars = sys.vehicles.filter((v) => v.road === 0);
  check(expresswayCars.length > 0, 'the expressway carries no vehicles');
  for (const v of expresswayCars) {
    const offset = Math.abs(v.x - (-4000));
    near(offset, 1.8, 0.5, 'lane offset is not ~1.8 m off the centreline');
  }

  // Straight-line motion: dt * speed along the travel direction.
  const car = expresswayCars.find((v) => v.dir === 1 && v.s > 50 && v.s < 1500);
  check(!!car, 'no clearly mid-road northbound car to measure');
  if (car) {
    const s0 = car.s;
    const z0 = car.z;
    sys.update(1, null, 0);
    near(car.s - s0, car.speed, 1e-6, 'vehicle arc length did not advance by speed * dt');
    near(car.z - z0, car.speed, 1e-3, 'vehicle world Z did not advance along the road');
    near(car.x, -4000 - 1.8, 1e-3, 'vehicle drifted off its lane');
    near(car.y, GROUND + 1.15, 1e-4, 'vehicle is not grounded at terrain + 1.15 m');
  }

  // Seamless wrap: park next to the end and step across it.
  if (car) {
    const road = sys.roads[car.road];
    car.s = road.total - 1;
    car.speed = 30;
    sys.update(0.5, null, 0);
    check(car.s >= 0 && car.s <= road.total,
      `wrap left s = ${car.s} outside 0..${road.total}`);
    near(car.s, 14, 1e-3, 'wrap did not continue smoothly past the end');
  }

  // Long run: every car stays on its polyline and inside its road.
  for (let i = 0; i < 400; i++) sys.update(0.37, { x: 0, y: 0, z: 0 }, 1);
  let wrapped = true;
  for (const v of sys.vehicles) {
    const road = sys.roads[v.road];
    if (!(v.s >= 0 && v.s <= road.total) || !Number.isFinite(v.x) || !Number.isFinite(v.z)) {
      wrapped = false;
      break;
    }
  }
  check(wrapped, 'a vehicle left its road range or became non-finite over 148 s');

  // 22 km cull: camera far away sees nothing, camera at the roads sees traffic.
  sys.update(0.016, { x: 60000, y: 8000, z: 60000 }, 1);
  check(sys.stats.visible === 0, `distant camera still saw ${sys.stats.visible} vehicles`);
  sys.update(0.016, { x: -4000, y: 500, z: 1000 }, 1);
  check(sys.stats.visible > 0, 'near camera saw no traffic');
  check(sys.stats.visible <= sys.stats.vehicles, 'visible count exceeds the vehicle total');

  // clear() resets everything.
  sys.clear();
  check(sys.stats.roads === 0 && sys.stats.vehicles === 0 && sys.stats.visible === 0,
    'clear() did not reset the stats');
  check(sys.roads.length === 0 && sys.vehicles.length === 0, 'clear() left roads/vehicles behind');
  check(sys.setCustomRoads([], flatHeight) === 0, 'empty road list did not return 0');
  check(sys.setCustomRoads(null, flatHeight) === 0, 'null road list did not return 0');
  sys.dispose();
  check(sys.headMesh === null && sys.tailMesh === null, 'dispose() left instanced pools');
}

// ---------------------------------------------------------------------------
// 2. RoadTrafficSystem — stub scene, instanced glow pools, night opacity
// ---------------------------------------------------------------------------
{
  const scene = makeStubScene();
  const sys = new RoadTrafficSystem(scene, QUALITY.low);
  check(sys.maxVehicles === 120, `low preset budget is ${sys.maxVehicles}, want 120`);
  check(!!sys.headMesh && !!sys.tailMesh, 'stub-scene traffic built no instanced meshes');
  check(sys.headMesh.name === 'traffic-headlights' && sys.tailMesh.name === 'traffic-taillights',
    'traffic pools are misnamed');
  check(sys.headMaterial.toneMapped === false && sys.tailMaterial.toneMapped === false,
    'traffic materials are tone mapped');
  check(sys.headMesh.instanceMatrix.count === 120,
    `headlight pool has ${sys.headMesh.instanceMatrix.count} slots, want 120`);

  const roads = [
    { w: 16, pts: [[0, 0], [0, 4000]] },
    { w: 12, pts: [[1000, 0], [1000, 3000]] },
  ];
  check(sys.setCustomRoads(roads, flatHeight) === 2, 'stub-scene road build failed');

  sys.update(0.1, { x: 0, y: 0, z: 0 }, 0);
  const dayOpacity = sys.headMaterial.opacity;
  near(dayOpacity, 0.18, 1e-6, 'daytime traffic opacity is not the subtle 0.18 glint');
  check(sys.headMesh.count === sys.stats.visible && sys.tailMesh.count === sys.stats.visible,
    'instanced counts disagree with stats.visible');
  check(sys.stats.visible > 0, 'no traffic visible around the camera');

  sys.update(0.1, { x: 0, y: 0, z: 0 }, 1);
  near(sys.headMaterial.opacity, 0.95, 1e-6, 'night traffic opacity is not 0.95');
  check(sys.tailMaterial.opacity === sys.headMaterial.opacity,
    'headlight and taillight opacity diverged');

  sys.dispose();
  check(scene.children.length === 0, 'dispose() left traffic meshes in the scene');
}

// ---------------------------------------------------------------------------
// 3. Landmarks — headless update(dt, night), uplights and beacons on a scene
// ---------------------------------------------------------------------------
const ALL_KINDS = [
  { id: 'sveta-gora', name: 'Sveta Gora Basilica', kind: 'church', x: 1200, z: -800, rot: 0.4, scale: 1.35 },
  { id: 'solkan-bridge', name: 'Solkan Stone Arch Bridge', kind: 'bridge', x: -2600, z: 4100, rot: 1.48, length: 220, height: 36 },
  { id: 'nanos-tower', name: 'Nanos Broadcast Tower (Pleša)', kind: 'tower', x: -4100, z: -1900, rot: 0, height: 95 },
  { id: 'predjama-castle', name: 'Predjama Castle', kind: 'castle', x: 2600, z: 6300, rot: 1.1, scale: 1.15 },
  { id: 'faro-vittoria', name: 'Faro della Vittoria (Trieste)', kind: 'lighthouse', x: -12000, z: 21500, rot: 0, height: 68 },
];

const heightAt = (x, z) => 420 + x * 0.012 + z * 0.006;
{
  // Headless: night must be accepted and tracked without any mesh at all.
  const sys = new LandmarkSystem(null);
  check(sys.setLandmarks(ALL_KINDS, heightAt) === 5, 'headless landmark build failed');
  check(sys._uplights.length === 0, 'headless system created night meshes');

  sys.update(0.016, 0);
  near(sys._time, 0.016, 1e-9, 'update(dt, 0) did not advance _time');
  near(sys.stats.night, 0, 1e-9, 'night 0 was not stored');

  sys.update(0.016, 1);
  near(sys._time, 0.032, 1e-9, 'update(dt, 1) did not advance _time');
  near(sys.stats.night, 1, 1e-9, 'night 1 was not stored');

  // Optional night arg: a bare update keeps the last value; setNight works.
  sys.setNight(0.35);
  near(sys.stats.night, 0.35, 1e-9, 'setNight(0.35) was not stored');
  sys.update(0.016);
  near(sys.stats.night, 0.35, 1e-9, 'bare update() lost the setNight value');
  sys.update(0.016, 2);
  near(sys.stats.night, 1, 1e-9, 'update(dt, 2) was not clamped to 1');
  sys.update(0.016, NaN);
  near(sys.stats.night, 0, 1e-9, 'NaN night was not treated as day');
  check(Number.isFinite(sys._time), 'NaN dt/night corrupted _time');
  sys.dispose();
}

{
  const scene = makeStubScene();
  const sys = new LandmarkSystem(scene);
  check(sys.setLandmarks(ALL_KINDS, heightAt) === 5, 'stub-scene landmark build failed');
  check(sys._uplights.length >= 8,
    `only ${sys._uplights.length} night parts built for 5 landmarks`);
  check(sys.stats.uplights === sys._uplights.length, 'stats.uplights disagrees with the parts');

  const washes = sys._uplights.filter((u) => u.kind === 'wash');
  const beams = sys._uplights.filter((u) => u.kind === 'beam');
  const obstructions = sys._uplights.filter((u) => u.kind === 'obstruction');
  check(washes.length === 5, `expected 5 facade washes, got ${washes.length}`);
  check(beams.length === 1, `expected 1 lighthouse beam, got ${beams.length}`);
  check(obstructions.length === 2, `expected 2 mast obstruction beacons, got ${obstructions.length}`);
  check(sys._uplights.every((u) => u.mesh.visible === false),
    'night parts are visible during the day');

  // Daytime: update with night 0 keeps every night part dark.
  sys.update(0.1, 0);
  check(sys._uplights.every((u) => u.material.opacity === 0 && u.mesh.visible === false),
    'night parts lit up during the day');

  // Dusk 0.35 and full night 1.0 light the washes at night * 0.45 * strength.
  sys.update(0.1, 0.35);
  check(washes.every((u) => u.material.opacity > 0 && u.mesh.visible),
    'facade washes stayed dark at dusk');
  check(washes.every((u) => u.material.opacity <= 0.35 * 0.45 + 1e-6),
    'a facade wash is brighter than night * 0.45');

  const beam = beams[0];
  const beamRot0 = beam.mesh.rotation.y;
  sys.update(0.1, 1);
  check(beam.material.opacity > 0 && beam.mesh.visible, 'lighthouse beam did not light up');
  check(Math.abs(beam.mesh.rotation.y - beamRot0) > 1e-6, 'lighthouse beam does not rotate');
  check(washes.every((u) => u.material.opacity > 0.2), 'full night does not brighten the washes');

  // Obstruction beacons must flash on at least once over a couple of seconds.
  let sawObstruction = false;
  for (let i = 0; i < 120 && !sawObstruction; i++) {
    sys.update(0.05, 1);
    sawObstruction = obstructions.some((u) => u.mesh.visible && u.material.opacity > 0);
  }
  check(sawObstruction, 'mast obstruction beacons never flashed at night');

  sys.setNight(0);
  check(sys._uplights.every((u) => u.material.opacity === 0),
    'setNight(0) did not switch the night parts off');

  sys.clear();
  check(sys._uplights.length === 0, 'clear() left night parts behind');
  check(sys.setLandmarks(ALL_KINDS, heightAt) === 5, 'cannot rebuild landmarks after clear()');
  check(sys._uplights.length >= 8, 'night parts were not rebuilt after clear()');
  sys.dispose();
  check(sys.group === null, 'landmark dispose() left the group attached');
  check(scene.children.length === 0, 'landmark dispose() left the group in the scene');
}

// ---------------------------------------------------------------------------
// 4. Airports — headless-safe with the Feature 31 update(dt, pos, night) form
// ---------------------------------------------------------------------------
{
  const sys = new AirportSystem(null, QUALITY.medium);
  check(sys.group === null, 'headless AirportSystem built a group');
  sys.update(0.016, { x: 0, y: 0, z: 0 }, 1);
  near(sys.night, 1, 1e-9, 'AirportSystem did not accept the night argument');
  sys.update(0.016, { x: 0, y: 0, z: 0 }, null, { night: 0.4 });
  near(sys.night, 0.4, 1e-9, 'AirportSystem ignored the sky night value');
  sys.update(0.016, { x: 0, y: 0, z: 0 });
  near(sys.night, 0, 1e-9, 'AirportSystem did not default to day');
  check(sys.built.size === 0, 'headless AirportSystem built an airport');
  sys.dispose();
  check(sys.group === null, 'AirportSystem.dispose() left a group');

  // Stub scene but no DOM: update must not throw and must build nothing.
  const scene = makeStubScene();
  const stub = new AirportSystem(scene, QUALITY.medium);
  check(stub.group !== null, 'stub-scene AirportSystem has no group');
  stub.update(0.016, { x: 0, y: 0, z: 0 }, 0.8);
  near(stub.night, 0.8, 1e-9, 'stub-scene AirportSystem lost the night value');
  check(stub.built.size === 0, 'AirportSystem built meshes without a DOM');
  check(scene.children.length === 1, 'stub-scene AirportSystem group was not added');
  stub.dispose();
  check(scene.children.length === 0, 'AirportSystem.dispose() left the group in the scene');
}

// ---------------------------------------------------------------------------
// 5. Buildings — night window palette in the shader
// ---------------------------------------------------------------------------
{
  const scene = makeStubScene();
  const sys = new BuildingSystem(scene, QUALITY.medium);
  const frag = sys.material.fragmentShader;
  check(frag.includes('vec3(1.0, 0.78, 0.42)'), 'warm tungsten window colour missing');
  check(frag.includes('vec3(1.0, 0.62, 0.25)'), 'cozy amber window colour missing');
  check(frag.includes('vec3(0.78, 0.90, 1.0)'), 'cool office window colour missing');
  check(frag.includes('0.45 + 0.20 * buildingSeed'),
    'per-building lit-window occupancy variation missing');
  check(frag.includes('* 1.45 *'), 'warm 1.45x night emissive boost missing');
  check(frag.includes('uNight'), 'night uniform is no longer used');
  sys.dispose();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Living Vipava Valley (night cities, traffic, runway strobes)');
console.log('=============================================================');
console.log(`checks  : ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.log('  - ' + f);
  if (failures.length > 30) console.log(`  ... and ${failures.length - 30} more`);
  process.exit(1);
}
console.log('\nALL LIVING VIPAVA CHECKS PASSED');
process.exit(0);