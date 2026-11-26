// Node-only acceptance test for src/world/settlements.js.
// Run: node tests/settlements_test.mjs
//
// Checks determinism, the four settlement layers near the origin, building /
// road / name / population contracts, airport-pad exclusion and performance.

import { performance } from 'node:perf_hooks';
import {
  SETTLEMENT_LAYERS,
  settlementAtCell,
  settlementsNear,
  nearestSettlement,
} from '../src/world/settlements.js';
import { airportsNear, terrainHeight } from '../src/world/terrain.js';

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}

const RANGES = {
  metro: { buildings: [260, 520], radius: [900, 1500], population: [60000, 400000] },
  town: { buildings: [70, 180], radius: [280, 520], population: [2000, 20000] },
  village: { buildings: [18, 55], radius: [120, 230], population: [120, 1200] },
  hamlet: { buildings: [3, 9], radius: [45, 110], population: [5, 60] },
};
const NAME_RE = /^[A-Z][a-z]+(?: [A-Z][a-z]+)?$/;
const KINDS = new Set(['house', 'shop', 'apartment', 'tower', 'industrial', 'shed']);
const SETTLEMENT_KEYS = ['buildings', 'id', 'name', 'population', 'radius', 'roads', 'seed', 'type', 'x', 'z'];
const BUILDING_KEYS = ['color', 'd', 'h', 'kind', 'rot', 'w', 'x', 'y', 'z'];
const ROAD_KEYS = ['width', 'x1', 'x2', 'z1', 'z2'];
const D = (s, x, z) => Math.hypot(s.x - x, s.z - z);
const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);

function walkNumbers(v, path, out) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push(path);
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) walkNumbers(v[i], `${path}[${i}]`, out);
    return;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) walkNumbers(v[k], `${path}.${k}`, out);
  }
}

function validateSettlement(s, x, z) {
  const r = RANGES[s.type];
  check(!!r, `unknown type ${s.type}`);
  if (!r) return;
  check(JSON.stringify(Object.keys(s).sort()) === JSON.stringify(SETTLEMENT_KEYS),
    `settlement keys differ for ${s.id}: ${Object.keys(s).sort().join(',')}`);
  check(typeof s.id === 'string' && s.id.startsWith(s.type + ':'), `bad id ${s.id}`);
  check(Number.isFinite(s.x) && Number.isFinite(s.z), `bad position ${s.id}`);
  check(typeof s.name === 'string' && NAME_RE.test(s.name) && s.name.length <= 24,
    `bad name "${s.name}" (${s.id})`);
  check(typeof s.seed === 'number' && Number.isInteger(s.seed), `bad seed ${s.id}`);
  check(Array.isArray(s.buildings), `buildings not array ${s.id}`);
  check(Array.isArray(s.roads), `roads not array ${s.id}`);

  check(s.buildings.length >= r.buildings[0] && s.buildings.length <= r.buildings[1],
    `building count ${s.buildings.length} out of range for ${s.id}`);
  check(s.radius >= r.radius[0] - 1 && s.radius <= r.radius[1] + 1,
    `radius ${fmt(s.radius)} out of range for ${s.id}`);
  check(s.population >= r.population[0] && s.population <= r.population[1],
    `population ${s.population} out of range for ${s.id}`);
  check(Number.isInteger(s.population), `population not integer ${s.id}`);

  // Disc must intersect the query circle.
  check(D(s, x, z) <= 40000 + s.radius + 1, `${s.id} returned outside query radius`);

  const pads = airportsNear(s.x, s.z, 1);
  for (const b of s.buildings) {
    check(JSON.stringify(Object.keys(b).sort()) === JSON.stringify(BUILDING_KEYS),
      `building keys differ in ${s.id}`);
    check(KINDS.has(b.kind), `bad kind ${b.kind} in ${s.id}`);
    check(b.w > 0 && b.d > 0 && b.h > 0, `bad size in ${s.id}`);
    check(typeof b.color === 'number' && b.color >= 0 && b.color <= 0xffffff,
      `bad colour in ${s.id}`);
    check(Number.isFinite(b.rot), `bad rotation in ${s.id}`);
    // Every building must sit outside every airport pad.
    for (const ap of pads) {
      const d = Math.hypot(b.x - ap.x, b.z - ap.z);
      check(d >= ap.padRadius, `building inside airport pad ${ap.id} (${s.id}, d=${d.toFixed(0)})`);
    }
    // y is terrainHeight at generation time, i.e. on land.
    check(Number.isFinite(b.y) && b.y > 0.5, `building not on land in ${s.id} (y=${b.y})`);
    check(Math.abs(b.y - terrainHeight(b.x, b.z)) < 0.05, `building y mismatch in ${s.id}`);
  }

  for (const rd of s.roads) {
    check(JSON.stringify(Object.keys(rd).sort()) === JSON.stringify(ROAD_KEYS),
      `road keys differ in ${s.id}`);
    check(rd.width >= 2 && rd.width <= 30, `bad road width ${rd.width} in ${s.id}`);
    check(Math.hypot(rd.x1 - s.x, rd.z1 - s.z) <= s.radius + 2,
      `road endpoint outside radius in ${s.id}`);
    check(Math.hypot(rd.x2 - s.x, rd.z2 - s.z) <= s.radius + 2,
      `road endpoint outside radius in ${s.id}`);
  }

  const nan = [];
  walkNumbers(s, s.id, nan);
  check(nan.length === 0, `NaN/Infinity at ${nan.slice(0, 3).join(', ')}`);
}

// ---------------------------------------------------------------------------
// 1. Performance. Two numbers are reported:
//    - the very first 20 km query in the process (includes JIT tier-up and the
//      one-off airport generation that terrainHeight needs),
//    - a cold-cache 20 km query in a fresh area with the airport field already
//      streamed (in the game the world streams airports before settlements, and
//      terrainHeight itself forces airport generation).
// ---------------------------------------------------------------------------
// Small warm-up queries in distant cells so the JIT has seen the code paths.
settlementsNear(0, 0, 512);
settlementsNear(600000, 600000, 512);

let t0 = performance.now();
const near20 = settlementsNear(0, 0, 20000);
const firstMs = performance.now() - t0;

t0 = performance.now();
const near20Again = settlementsNear(0, 0, 20000);
const cachedMs = performance.now() - t0;
check(near20Again === near20, 'cached settlementsNear did not return the cached array');
check(cachedMs < 2, `cached settlementsNear too slow (${fmt(cachedMs)} ms)`);

const timedX = 300000;
const timedZ = 300000;
airportsNear(timedX, timedZ, 2); // stream airports for the measured area
t0 = performance.now();
const freshArea = settlementsNear(timedX, timedZ, 20000);
const coldFreshMs = performance.now() - t0;
const freshBuildings = freshArea.reduce((n, s) => n + s.buildings.length, 0);
check(freshArea.length > 20, 'timed query unexpectedly empty');
check(coldFreshMs < 40, `cold 20 km settlementsNear too slow (${fmt(coldFreshMs)} ms)`);

// ---------------------------------------------------------------------------
// 2. Origin area: a town within 6 km, a village within 3 km, all types < 40 km
// ---------------------------------------------------------------------------
const near6 = near20.filter((s) => D(s, 0, 0) <= 6000);
const townNear = near6.find((s) => s.type === 'town');
const villageNear = near20.find((s) => s.type === 'village' && D(s, 0, 0) <= 3000);
check(!!townNear, 'no town within 6 km of origin');
check(!!villageNear, 'no village within 3 km of origin');
check(!!near20.find((s) => s.type === 'hamlet'), 'no hamlet within 20 km of origin');
check(!!nearestSettlement(0, 0), 'nearestSettlement returned null at origin');

// ---------------------------------------------------------------------------
// 3. Full 40 km scan: all types, every contract
// ---------------------------------------------------------------------------
const all = settlementsNear(0, 0, 40000);
const byType = { metro: [], town: [], village: [], hamlet: [] };
for (const s of all) byType[s.type].push(s);

for (const layer of SETTLEMENT_LAYERS) {
  check(byType[layer.level].length > 0, `no ${layer.level} within 40 km of origin`);
}
check(new Set(all.map((s) => s.id)).size === all.length, 'duplicate settlement ids');
for (let i = 1; i < all.length; i++) {
  check(D(all[i - 1], 0, 0) <= D(all[i], 0, 0) + 1e-6, 'settlementsNear not sorted by distance');
}
for (const s of all) validateSettlement(s, 0, 0);

const totalBuildings = all.reduce((n, s) => n + s.buildings.length, 0);
const totalRoads = all.reduce((n, s) => n + s.roads.length, 0);

// ---------------------------------------------------------------------------
// 4. Determinism: two independent module instances (fresh caches) must agree
// ---------------------------------------------------------------------------
const A = await import('../src/world/settlements.js?instance=a');
const B = await import('../src/world/settlements.js?instance=b');

check(JSON.stringify(A.SETTLEMENT_LAYERS) === JSON.stringify(SETTLEMENT_LAYERS),
  'SETTLEMENT_LAYERS differs between instances');

const cells = [
  ['metro', 0, 0], ['metro', 1, 2], ['metro', -3, 5],
  ['town', 0, 0], ['town', 7, -4], ['town', -11, 9], ['town', 3, 3],
  ['village', 0, 0], ['village', 12, -7], ['village', -5, 21], ['village', 4, 4],
  ['hamlet', 0, 0], ['hamlet', 33, 17], ['hamlet', -19, -23], ['hamlet', 7, 9],
];
for (const [level, cx, cz] of cells) {
  const a = A.settlementAtCell(level, cx, cz);
  const b = B.settlementAtCell(level, cx, cz);
  check(JSON.stringify(a) === JSON.stringify(b), `non-deterministic cell ${level}:${cx},${cz}`);
  const again = settlementAtCell(level, cx, cz);
  check(JSON.stringify(again) === JSON.stringify(a), `unstable repeat call ${level}:${cx},${cz}`);
}

const nearA = A.settlementsNear(641024, -233472, 9000);
const nearB = B.settlementsNear(641024, -233472, 9000);
check(nearA.length > 0, 'determinism sample query found no settlements');
check(JSON.stringify(nearA) === JSON.stringify(nearB), 'settlementsNear is not deterministic');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Settlement generator — acceptance test');
console.log('======================================');
console.log(`origin 20 km : ${near20.length} settlements, ${near20.reduce((n, s) => n + s.buildings.length, 0)} buildings`);
console.log(`40 km scan   : ${all.length} settlements, ${totalBuildings} buildings, ${totalRoads} roads`);
for (const level of ['metro', 'town', 'village', 'hamlet']) {
  const list = byType[level];
  const bs = list.reduce((n, s) => n + s.buildings.length, 0);
  const rms = list.reduce((n, s) => n + s.roads.length, 0);
  const bMin = Math.min(...list.map((s) => s.buildings.length));
  const bMax = Math.max(...list.map((s) => s.buildings.length));
  const pMin = Math.min(...list.map((s) => s.population));
  const pMax = Math.max(...list.map((s) => s.population));
  console.log(
    `  ${level.padEnd(7)} n=${String(list.length).padStart(3)}  buildings=${String(bs).padStart(5)}` +
    `  per=${bMin}..${bMax}  pop=${pMin}..${pMax}  roads=${rms}`,
  );
}
console.log('closest to origin:');
for (const s of near20.slice(0, 6)) {
  console.log(`  ${s.type.padEnd(7)} ${s.name.padEnd(16)} ${fmt(D(s, 0, 0)).padStart(8)} m  ` +
    `r=${fmt(s.radius)}  pop=${s.population}  b=${s.buildings.length}`);
}
console.log('timing (20 km radius):');
console.log(`  first query ever (incl. JIT + airport gen) : ${fmt(firstMs)} ms`);
console.log(`  cold caches, airports streamed             : ${fmt(coldFreshMs)} ms ` +
  `(${freshArea.length} settlements, ${freshBuildings} buildings)`);
console.log(`  cached repeat                              : ${fmt(cachedMs)} ms`);
console.log(`  goal <~30 ms cold: ${coldFreshMs < 30 ? 'met' : 'MISSED'}`);
console.log(`checks: ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  process.exitCode = 1;
} else {
  console.log('\nALL CHECKS PASSED');
}