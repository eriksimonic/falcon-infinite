// Headless acceptance test for Feature 38 — real OpenStreetMap Vipava Valley
// towns, buildings, urban zones and road bridges.
// Run: node tests/osm_bake_audit_test.mjs
//
// Loads public/media/vipava_buildings.bin (FBLD v1) and
// public/media/vipava_osm.json directly from disk and audits:
//   * binary header/record integrity (magic, version, stride, bounds)
//   * real town coverage across the whole theater (no 0-building towns)
//   * urban zones, bridge-flagged roads and all 12 verified landmarks
//   * landmark geometry against real coordinates and the Soča river shape.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBuildingsBinary } from '../src/world/dem.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(ROOT, 'public', 'media', 'vipava_buildings.bin');
const JSON_PATH = path.join(ROOT, 'public', 'media', 'vipava_osm.json');
const WATER_PATH = path.join(ROOT, 'public', 'media', 'vipava_water.json');

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
function near(actual, want, eps, msg) {
  check(Number.isFinite(actual) && Math.abs(actual - want) <= eps,
    `${msg} (got ${actual}, want ${want} +-${eps})`);
}

// World mapping used by the baker (must stay in sync with scripts/bake_vipava_osm.py).
const LAT0 = 45.8878;
const LON0 = 13.8869;
const M_PER_DEG_LAT = 111132.92;
const M_PER_DEG_LON = 111412.84 * Math.cos((LAT0 * Math.PI) / 180);
const llToXZ = (lat, lon) => [
  (lon - LON0) * M_PER_DEG_LON,
  -(lat - LAT0) * M_PER_DEG_LAT,
];

// Towns from the Feature 38 spec (plus the valley villages that were missing).
const TOWNS = {
  Ajdovščina: [45.8869, 13.9093],
  Vipava: [45.8466, 13.9622],
  'Nova Gorica': [45.9551, 13.6493],
  Gorizia: [45.9417, 13.6222],
  Solkan: [45.9778, 13.6511],
  Dornberk: [45.8294, 13.7625],
  Branik: [45.8575, 13.7864],
  Šempas: [45.9308, 13.7433],
  Črniče: [45.9019, 13.7719],
  Renče: [45.8897, 13.6775],
  Štanjel: [45.8236, 13.8453],
  Izola: [45.5361, 13.6603],
  Piran: [45.5285, 13.5685],
  Koper: [45.5481, 13.7302],
  Trieste: [45.6495, 13.7768],
  Postojna: [45.7749, 14.2075],
  Sežana: [45.7078, 13.8703],
};
const MAJOR_TOWNS = ['Ajdovščina', 'Vipava', 'Nova Gorica', 'Gorizia', 'Koper',
  'Trieste', 'Postojna', 'Sežana', 'Izola', 'Piran', 'Štanjel'];

// ---------------------------------------------------------------------------
// Binary
// ---------------------------------------------------------------------------
const buf = fs.readFileSync(BIN_PATH);
check(buf.length >= 16, 'buildings.bin is at least one header');
check(buf.subarray(0, 4).toString('ascii') === 'FBLD', 'magic is FBLD');
const version = buf.readUInt32LE(4);
const count = buf.readUInt32LE(8);
const stride = buf.readUInt32LE(12);
check(version === 1, `version is 1 (got ${version})`);
check(stride === 20, `stride is 20 bytes (got ${stride})`);
check(count >= 25000, `count >= 25000 (got ${count})`);
check(buf.length < 2.5 * 1024 * 1024,
  `file size < 2.5 MB (got ${(buf.length / 1048576).toFixed(2)} MB)`);
check(buf.length === 16 + count * stride,
  `file size equals header + count*stride (got ${buf.length})`);

const parsed = parseBuildingsBinary(buf);
check(parsed !== null, 'parseBuildingsBinary accepts the payload');
check(parsed && parsed.count === count, 'parsed count matches the header');
const records = parsed ? parsed.records : [];

const kindCounts = [0, 0, 0, 0, 0, 0];
const roofCounts = [0, 0, 0, 0, 0];
const tierCounts = [0, 0, 0];
let badRecord = 0;
for (let i = 0; i < records.length; i++) {
  const [x, z, w, d, h, rot, kind, roof, tier, seed] = records[i];
  const ok = Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(w) &&
    Number.isFinite(d) && Number.isFinite(h) && Number.isFinite(rot) &&
    w >= 4 && d >= 4 && h >= 2.5 && Math.abs(rot) <= Math.PI + 1e-6 &&
    Number.isInteger(kind) && kind >= 0 && kind <= 5 &&
    Number.isInteger(roof) && roof >= 0 && roof <= 4 &&
    Number.isInteger(tier) && tier >= 0 && tier <= 2 &&
    Number.isInteger(seed) && seed >= 0 && seed <= 255;
  if (!ok) {
    badRecord++;
    if (badRecord <= 5) {
      failures.push(`record ${i} invalid: [${x}, ${z}, ${w}, ${d}, ${h}, ` +
        `${rot}, ${kind}, ${roof}, ${tier}, ${seed}]`);
    }
    continue;
  }
  kindCounts[kind]++;
  roofCounts[roof]++;
  tierCounts[tier]++;
  if (w > 120.5 || d > 120.5 || h > 120.5) {
    badRecord++;
    if (badRecord <= 5) failures.push(`record ${i} exceeds caps: w=${w} d=${d} h=${h}`);
  }
}
check(badRecord === 0, `every record is finite and in range (${badRecord} bad)`);
for (let k = 0; k < 6; k++) {
  check(kindCounts[k] > 0, `kindCode ${k} is present (${kindCounts[k]})`);
}
for (let r = 0; r <= 4; r++) {
  check(roofCounts[r] > 0, `roofCode ${r} is present (${roofCounts[r]})`);
}
for (let t = 0; t <= 2; t++) {
  check(tierCounts[t] > 0, `tier ${t} is present (${tierCounts[t]})`);
}

// ---------------------------------------------------------------------------
// Town coverage (binary records within 2.5 km)
// ---------------------------------------------------------------------------
const coverage = {};
for (const [name, [lat, lon]] of Object.entries(TOWNS)) {
  const [tx, tz] = llToXZ(lat, lon);
  let n = 0;
  for (const rec of records) {
    const dx = rec[0] - tx;
    const dz = rec[1] - tz;
    if (dx * dx + dz * dz <= 2500 * 2500) n++;
  }
  coverage[name] = n;
  check(n > 30, `${name} has > 30 buildings within 2.5 km (got ${n})`);
}
// The villages that were absent from the old extract must be populated too.
const VILLAGES = {
  Miren: [45.8961, 13.6078],
  Bilje: [45.8878, 13.6275],
  Prvačina: [45.8653, 13.7183],
  Ozeljan: [45.9219, 13.7414],
  Batuje: [45.8858, 13.8425],
  Lokavec: [45.8664, 13.8775],
  Slap: [45.8417, 13.9322],
  Goče: [45.8131, 13.9231],
  Podnanos: [45.8222, 13.9386],
  Col: [45.8813, 14.0020],
};
for (const [name, [lat, lon]] of Object.entries(VILLAGES)) {
  const [tx, tz] = llToXZ(lat, lon);
  let n = 0;
  for (const rec of records) {
    const dx = rec[0] - tx;
    const dz = rec[1] - tz;
    if (dx * dx + dz * dz <= 2000 * 2000) n++;
  }
  check(n > 10, `village ${name} has > 10 buildings within 2 km (got ${n})`);
}

// ---------------------------------------------------------------------------
// JSON payload
// ---------------------------------------------------------------------------
const osm = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
check(Array.isArray(osm.roads), 'roads is an array');
check(Array.isArray(osm.buildings), 'legacy buildings fallback is an array');
check(Array.isArray(osm.landmarks), 'landmarks is an array');
check(Array.isArray(osm.urbanZones), 'urbanZones is an array');

const legacy = osm.buildings;
check(legacy.length >= 500 && legacy.length <= 2000,
  `legacy fallback has 500..2000 buildings (got ${legacy.length})`);
check(legacy.every((b) => Array.isArray(b) && b.length === 7 &&
  b.every((v) => Number.isFinite(v))), 'legacy buildings are 7 finite numbers');

// Urban zones
const zones = osm.urbanZones;
check(zones.length >= 20, `urbanZones is non-empty (got ${zones.length})`);
check(zones.every((z) => Array.isArray(z) && z.length === 4 &&
  z.every((v) => Number.isFinite(v)) && z[2] >= 80 && z[2] <= 900),
  'urbanZones are [x, z, radius 80..900 m, density]');
for (const name of MAJOR_TOWNS) {
  const [tx, tz] = llToXZ(...TOWNS[name]);
  const hit = zones.some((z) => Math.hypot(z[0] - tx, z[1] - tz) <= 2500);
  check(hit, `urbanZones cover ${name}`);
}

// Bridges / viaducts
const bridged = osm.roads.filter((r) => r && r.b === 1);
check(bridged.length >= 15, `roads has >= 15 bridged segments (got ${bridged.length})`);
check(bridged.every((r) => Array.isArray(r.pts) && r.pts.length >= 2 &&
  r.pts.every((p) => Array.isArray(p) && p.length === 2 &&
    Number.isFinite(p[0]) && Number.isFinite(p[1]))),
  'every bridged road has finite polyline points');
check(osm.roads.length > bridged.length, 'non-bridge roads are preserved');

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------
const REQUIRED_IDS = ['sveta-gora', 'solkan-bridge', 'solkan-dam', 'vogrscek-dam',
  'nanos-tower', 'gorizia-castle', 'kostanjevica', 'faro-vittoria',
  'piran-belltower', 'predjama-castle', 'stanjel-castle', 'vipava-bridge'];
const landmarks = new Map(osm.landmarks.map((l) => [l.id, l]));
check(osm.landmarks.length === 12, `landmarks has 12 entries (got ${osm.landmarks.length})`);
for (const id of REQUIRED_IDS) {
  const lm = landmarks.get(id);
  check(!!lm, `landmark ${id} exists`);
  if (!lm) continue;
  check(Number.isFinite(lm.x) && Number.isFinite(lm.z) &&
    Math.abs(lm.x) < 60000 && Math.abs(lm.z) < 60000,
    `landmark ${id} has valid world coordinates (${lm.x}, ${lm.z})`);
  check(Number.isFinite(lm.rot), `landmark ${id} has a rotation`);
  if (lm.kind === 'bridge' || lm.kind === 'dam') {
    check(Number.isFinite(lm.length) && lm.length > 0, `${id} has a positive length`);
    check(Number.isFinite(lm.height) && lm.height > 0, `${id} has a positive height`);
  }
}

// Exact real-world coordinates (spec-mandated corrections).
function checkLandmarkLL(id, lat, lon, eps = 1.0) {
  const lm = landmarks.get(id);
  if (!lm) return;
  const [x, z] = llToXZ(lat, lon);
  near(lm.x, x, eps, `${id}.x matches real lon ${lon}`);
  near(lm.z, z, eps, `${id}.z matches real lat ${lat}`);
}
checkLandmarkLL('sveta-gora', 45.9993, 13.6557);
checkLandmarkLL('solkan-bridge', 45.9781, 13.6506);
checkLandmarkLL('solkan-dam', 45.98436, 13.65479);
checkLandmarkLL('vogrscek-dam', 45.90571, 13.72588);
checkLandmarkLL('vipava-bridge', 45.8448, 13.9507);
checkLandmarkLL('piran-belltower', 45.5292, 13.5689);
checkLandmarkLL('predjama-castle', 45.8156, 14.1267);

const azOfRot = (rot) => {
  const dx = Math.cos(rot);
  const dz = -Math.sin(rot);
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
};

// Solkan bridge: real axis is WNW-ESE (spec: ~110-140 deg azimuth), spanning
// the Soča bank-to-bank rather than running along the gorge wall.
const solkan = landmarks.get('solkan-bridge');
if (solkan) {
  const az = azOfRot(solkan.rot);
  check(az >= 108 && az <= 145, `Solkan bridge azimuth is 108..145 deg (got ${az.toFixed(1)})`);

  // The bridge must actually cross the Soča centerline from vipava_water.json.
  const water = JSON.parse(fs.readFileSync(WATER_PATH, 'utf8'));
  let best = null;
  for (const river of water.rivers) {
    const pts = river.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i];
      const [x2, z2] = pts[i + 1];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const l2 = dx * dx + dz * dz;
      if (!l2) continue;
      const t = Math.max(0, Math.min(1,
        ((solkan.x - x1) * dx + (solkan.z - z1) * dz) / l2));
      const dist = Math.hypot(solkan.x - (x1 + t * dx), solkan.z - (z1 + t * dz));
      if (!best || dist < best.dist) best = { dist, x1, z1, dx, dz };
    }
  }
  check(best && best.dist < 120, `Solkan bridge sits on the Soča (${best ? best.dist.toFixed(0) : '?'} m)`);
  if (best) {
    const half = solkan.length * 0.5;
    const ux = Math.cos(solkan.rot);
    const uz = -Math.sin(solkan.rot);
    const cross = (px, pz) => best.dx * (pz - best.z1) - best.dz * (px - best.x1);
    const a = cross(solkan.x - ux * half, solkan.z - uz * half);
    const b = cross(solkan.x + ux * half, solkan.z + uz * half);
    check(a * b < 0, 'Solkan bridge endpoints straddle the Soča (spans bank-to-bank)');
  }
}

// Solkan dam: local X is perpendicular to the river flow at the dam.
const dam = landmarks.get('solkan-dam');
if (dam) {
  const water = JSON.parse(fs.readFileSync(WATER_PATH, 'utf8'));
  let best = null;
  for (const river of water.rivers) {
    const pts = river.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i];
      const [x2, z2] = pts[i + 1];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const l2 = dx * dx + dz * dz;
      if (!l2) continue;
      const t = Math.max(0, Math.min(1, ((dam.x - x1) * dx + (dam.z - z1) * dz) / l2));
      const dist = Math.hypot(dam.x - (x1 + t * dx), dam.z - (z1 + t * dz));
      if (!best || dist < best.dist) best = { dist, dx, dz };
    }
  }
  check(best && best.dist < 120, `Solkan dam sits on the Soča (${best ? best.dist.toFixed(0) : '?'} m)`);
  if (best) {
    const flowAz = ((Math.atan2(best.dx, -best.dz) * 180) / Math.PI + 360) % 360;
    const damAz = azOfRot(dam.rot);
    const diff = Math.abs(((damAz - flowAz) % 180 + 180) % 180 - 90);
    check(diff <= 20, `Solkan dam is ~perpendicular to the Soča (off by ${diff.toFixed(1)} deg)`);
  }
}

// Vipava H4 viaduct: real road axis is ~340 deg (azimuth mod 180).
const viaduct = landmarks.get('vipava-bridge');
if (viaduct) {
  const az = azOfRot(viaduct.rot);
  const axis = ((az % 180) + 180) % 180;
  const want = 340 % 180;
  const diff = Math.abs(((axis - want + 90) % 180 + 180) % 180 - 90);
  check(diff <= 8, `Vipava H4 viaduct follows the real H4 axis (off by ${diff.toFixed(1)} deg)`);
}

// Vogršček dam crest runs N-S (OSM way 407464561): az ~4 deg.
const vogr = landmarks.get('vogrscek-dam');
if (vogr) {
  const axis = ((azOfRot(vogr.rot) % 180) + 180) % 180;
  const diff = Math.abs(((axis - 4 + 90) % 180 + 180) % 180 - 90);
  check(diff <= 8, `Vogršček dam follows the real crest axis (off by ${diff.toFixed(1)} deg)`);
}

// Sveta Gora basilica sits at the true 681 m summit (45.9993°N, 13.6557°E,
// 668 m in Terrarium DEM — not the old flank coordinates).
if (landmarks.get('sveta-gora')) {
  const [x681, z681] = llToXZ(45.9993, 13.6557);
  const [xOld, zOld] = llToXZ(45.9953, 13.6584);
  const atSummit = Math.hypot(landmarks.get('sveta-gora').x - x681,
    landmarks.get('sveta-gora').z - z681);
  const atOld = Math.hypot(landmarks.get('sveta-gora').x - xOld,
    landmarks.get('sveta-gora').z - zOld);
  check(atSummit < 1.0 && atOld > 100,
    'Sveta Gora is at the 681 m summit, not the old north-flank point');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const totalBuilt = records.length;
console.log('Feature 38 — Vipava OSM bake audit');
console.log('==================================');
console.log(`binary          : ${count} records, stride ${stride}, ` +
  `${(buf.length / 1048576).toFixed(2)} MB`);
console.log(`kinds           : house ${kindCounts[0]}, apartment ${kindCounts[1]}, ` +
  `industrial ${kindCounts[2]}, tower ${kindCounts[3]}, church ${kindCounts[4]}, ` +
  `shed ${kindCounts[5]}`);
console.log(`roofs           : gable ${roofCounts[0]}, hip ${roofCounts[1]}, ` +
  `flat ${roofCounts[2]}, industrial ${roofCounts[3]}, spire ${roofCounts[4]}`);
console.log(`tiers           : close ${tierCounts[0]}, mid ${tierCounts[1]}, ` +
  `far ${tierCounts[2]}`);
console.log('town coverage   : ' + Object.entries(coverage)
  .map(([n, c]) => `${n} ${c}`).join(', '));
console.log(`roads           : ${osm.roads.length} (${bridged.length} bridged)`);
console.log(`urbanZones      : ${zones.length}`);
console.log(`landmarks       : ${osm.landmarks.length}`);
console.log(`fallback        : ${legacy.length} legacy buildings`);
console.log(`checks: ${checks}, failures: ${failures.length}`);
console.log(`total buildings : ${totalBuilt}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.log('  - ' + f);
  if (failures.length > 30) console.log(`  ... and ${failures.length - 30} more`);
  process.exit(1);
}
console.log('\nALL OSM BAKE CHECKS PASSED');
process.exit(0);