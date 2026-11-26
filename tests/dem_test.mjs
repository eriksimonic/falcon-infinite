// Headless acceptance test for the baked-DEM theater (Feature 27).
// Run: node tests/dem_test.mjs
//
// Verifies 16-bit RG decoding, bilinear sampling, the 88 km -> 100 km edge
// blend, and the terrain.js DEM hook including exact procedural restoration.

import {
  HeightmapDEM,
  loadVipavaDEM,
  loadVipavaOSM,
  _resetVipavaDEMCache,
  _resetVipavaOSMCache,
} from '../src/world/dem.js';
import {
  baseHeight,
  setActiveDEM,
  getActiveDEM,
  terrainHeight,
  setCustomAirports,
  getCustomAirports,
  airportsNear,
  airportNear,
  smoothstep,
} from '../src/world/terrain.js';

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
function near(actual, want, eps, msg) {
  check(Number.isFinite(actual) && Math.abs(actual - want) <= eps,
    `${msg} (got ${actual}, want ${want})`);
}

const SIZE = 100000;
const OFFSET = -200;
const SCALE = 16;

// Encode one elevation exactly as the baked PNG does: val = (R << 8) | G.
function encodeRG(elev, offset = OFFSET, scale = SCALE) {
  const val = Math.round((elev - offset) * scale);
  if (val < 0 || val > 65535) throw new Error(`elevation ${elev} out of range`);
  return [val >> 8, val & 255];
}

function makeRGBA(width, height, heights, offset = OFFSET, scale = SCALE) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const [r, g] = encodeRG(heights[i], offset, scale);
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = 0;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// 1. 16-bit RG decode accuracy: sea, valley, Nanos, Julian Alps
// ---------------------------------------------------------------------------
const NAMED = [
  ['Adriatic sea', -135],
  ['Vipava valley', 112.4],
  ['Nanos plateau', 1313],
  ['Julian Alps', 2236],
];
const namedHeights = NAMED.map(([, h]) => h);
const namedDEM = new HeightmapDEM({
  width: 2,
  height: 2,
  sizeM: SIZE,
  offset: OFFSET,
  scale: SCALE,
  pixels: makeRGBA(2, 2, namedHeights),
});

check(namedDEM.data instanceof Float32Array, 'decoded data is not a Float32Array');
check(namedDEM.data.length === 4, 'decoded data length wrong');
check(namedDEM.sizeM === SIZE && namedDEM.offset === OFFSET && namedDEM.scale === SCALE,
  'DEM options were not retained');

// Corner positions map exactly to grid cells.
near(namedDEM.sample(-SIZE / 2, -SIZE / 2), NAMED[0][1], 0.1, 'sea decode');
near(namedDEM.sample(SIZE / 2, -SIZE / 2), NAMED[1][1], 0.1, 'valley decode');
near(namedDEM.sample(-SIZE / 2, SIZE / 2), NAMED[2][1], 0.1, 'Nanos decode');
near(namedDEM.sample(SIZE / 2, SIZE / 2), NAMED[3][1], 0.1, 'Alps decode');

// ---------------------------------------------------------------------------
// 2. Bilinear interpolation: exact at cells, smooth and exact between them
// ---------------------------------------------------------------------------
const bilinear = new HeightmapDEM({
  width: 2,
  height: 2,
  sizeM: SIZE,
  offset: 0,
  scale: 1,
  pixels: makeRGBA(2, 2, [0, 100, 200, 300], 0, 1),
});
near(bilinear.sample(-SIZE / 2, -SIZE / 2), 0, 1e-4, 'bilinear corner 0');
near(bilinear.sample(SIZE / 2, -SIZE / 2), 100, 1e-4, 'bilinear corner 100');
near(bilinear.sample(-SIZE / 2, SIZE / 2), 200, 1e-4, 'bilinear corner 200');
near(bilinear.sample(SIZE / 2, SIZE / 2), 300, 1e-4, 'bilinear corner 300');
near(bilinear.sample(0, 0), 150, 1e-4, 'bilinear centre');
near(bilinear.sample(-SIZE / 4, 0), 125, 1e-4, 'bilinear x quarter');
near(bilinear.sample(0, -SIZE / 4), 100, 1e-4, 'bilinear z quarter');
near(bilinear.sample(SIZE / 4, SIZE / 4), 225, 1e-4, 'bilinear three-quarter');
near(bilinear.sample(25000.5, -12500.25), 150.001, 5e-3, 'bilinear off-grid');

// Float32Array elevations are accepted directly.
const floatDEM = new HeightmapDEM({
  width: 2,
  height: 2,
  sizeM: SIZE,
  pixels: new Float32Array([0, 100, 200, 300]),
});
near(floatDEM.sample(0, 0), 150, 1e-5, 'Float32Array centre');

// Monotone, smooth progression along x.
let prev = -Infinity;
let monotone = true;
let maxStep = 0;
for (let x = -SIZE / 2; x <= SIZE / 2; x += 1000) {
  const h = bilinear.sample(x, 0);
  if (!Number.isFinite(h)) { monotone = false; break; }
  if (h < prev - 1e-6) monotone = false;
  if (prev !== -Infinity) maxStep = Math.max(maxStep, h - prev);
  prev = h;
}
check(monotone, 'bilinear samples are not monotone along x');
check(maxStep <= 6.01, `bilinear step too large (${maxStep})`);

// Outside the footprint -> null.
check(bilinear.sample(SIZE / 2 + 1, 0) === null, 'sample outside +x did not return null');
check(bilinear.sample(0, -SIZE / 2 - 1) === null, 'sample outside -z did not return null');
check(bilinear.sample(60000, 0) === null, 'sample far outside did not return null');

// ---------------------------------------------------------------------------
// 3. Edge blend weight: 1 inside 88 km, smooth ramp, 0 at 100 km
// ---------------------------------------------------------------------------
check(namedDEM.blendWeight(0, 0) === 1, 'blendWeight(0,0) !== 1');
check(namedDEM.blendWeight(-44000, 44000) === 1, 'blendWeight at inner corner !== 1');
check(namedDEM.blendWeight(43000, -20000) === 1, 'blendWeight inside inner box !== 1');

const midW = namedDEM.blendWeight(47000, 0);
check(midW > 0 && midW < 1, `blendWeight(47000,0) not strictly between 0 and 1 (${midW})`);
near(midW, 0.5, 1e-9, 'blendWeight(47000,0) smoothstep midpoint');
near(namedDEM.blendWeight(0, -47000), 0.5, 1e-9, 'blendWeight(0,-47000) smoothstep midpoint');

check(namedDEM.blendWeight(51000, 0) === 0, 'blendWeight(51000,0) !== 0');
check(namedDEM.blendWeight(-50000, 1000) === 0, 'blendWeight at ±50 km edge !== 0');
check(namedDEM.blendWeight(50000, 50000) === 0, 'blendWeight at outer corner !== 0');
check(namedDEM.blendWeight(NaN, 0) === 0, 'blendWeight(NaN) !== 0');

let blendPrev = 1;
let blendMonotone = true;
for (let d = 44000; d <= 51000; d += 500) {
  const w = namedDEM.blendWeight(d, 0);
  if (!(w >= 0 && w <= 1) || w > blendPrev + 1e-12) blendMonotone = false;
  blendPrev = w;
}
check(blendMonotone, 'blendWeight is not monotonically decreasing to 0');
check(blendPrev === 0, 'blendWeight past 50 km is not 0');

// ---------------------------------------------------------------------------
// 4. terrain.js hook: DEM at origin, smooth 47 km blend, exact restoration
// ---------------------------------------------------------------------------
check(getActiveDEM() === null, 'terrain started with an active DEM');

const proceduralOrigin = baseHeight(0, 0);
const procedural47 = baseHeight(47000, 0);
const proceduralFar = baseHeight(-12345, 6789);
const proceduralOutside = baseHeight(60000, 60000);

const VALLEY = 777.5;
const uniformDEM = new HeightmapDEM({
  width: 2,
  height: 2,
  sizeM: SIZE,
  offset: OFFSET,
  scale: SCALE,
  pixels: makeRGBA(2, 2, [VALLEY, VALLEY, VALLEY, VALLEY]),
});

setActiveDEM(uniformDEM);
check(getActiveDEM() === uniformDEM, 'getActiveDEM did not return the active DEM');
near(baseHeight(0, 0), VALLEY, 1e-3, 'baseHeight at origin is not the DEM elevation');
near(baseHeight(-30000, 20000), VALLEY, 1e-3, 'baseHeight inside DEM is not the DEM elevation');
near(baseHeight(44000, -44000), VALLEY, 1e-3, 'baseHeight at inner blend corner');

const blended47 = baseHeight(47000, 0);
const expected47 = VALLEY * 0.5 + procedural47 * 0.5;
near(blended47, expected47, 1e-6, '47 km blend does not mix DEM and procedural 50/50');
check(blended47 > Math.min(VALLEY, procedural47) && blended47 < Math.max(VALLEY, procedural47),
  '47 km blend is not strictly between DEM and procedural height');

// Fully outside the DEM footprint the procedural world is untouched.
check(baseHeight(60000, 60000) === proceduralOutside,
  'baseHeight outside DEM footprint is not exactly procedural');

setActiveDEM(null);
check(getActiveDEM() === null, 'setActiveDEM(null) did not clear the DEM');
check(baseHeight(0, 0) === proceduralOrigin, 'procedural baseHeight at origin not restored exactly');
check(baseHeight(47000, 0) === procedural47, 'procedural baseHeight at 47 km not restored exactly');
check(baseHeight(-12345, 6789) === proceduralFar,
  'procedural baseHeight in fresh area not restored exactly');

// ---------------------------------------------------------------------------
// 5. Module surface / validation
// ---------------------------------------------------------------------------
check(typeof loadVipavaDEM === 'function', 'loadVipavaDEM is not exported as a function');
check(typeof _resetVipavaDEMCache === 'function', '_resetVipavaDEMCache is not exported');
check(typeof loadVipavaOSM === 'function', 'loadVipavaOSM is not exported as a function');
check(typeof _resetVipavaOSMCache === 'function', '_resetVipavaOSMCache is not exported');

// The baked OSM extract is loaded lazily and must never throw: a missing file
// (or a failed fetch) resolves to null so the theater can fall back safely.
_resetVipavaOSMCache();
const missingOsm = await loadVipavaOSM('./media/definitely-not-here.json');
check(missingOsm === null, 'loadVipavaOSM did not return null for a missing file');
_resetVipavaOSMCache();

function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(threw, msg);
}
throws(() => new HeightmapDEM({ width: 1, height: 2, pixels: new Uint8Array(8) }),
  'width < 2 did not throw');
throws(() => new HeightmapDEM({ width: 2, height: 2, pixels: new Uint8Array(8) }),
  'short RGBA buffer did not throw');
throws(() => new HeightmapDEM({ width: 2, height: 2, pixels: new Float32Array(3) }),
  'short Float32Array did not throw');

// ---------------------------------------------------------------------------
// 6. Baked airports: LJAJ (RWY 09/27) flattens the real strip at the origin,
//    and setCustomAirports(null) restores the procedural world exactly.
// ---------------------------------------------------------------------------
check(getCustomAirports() === null, 'started with custom airports installed');

const proceduralTerrainOrigin = terrainHeight(0, 0);
const proceduralTerrainFar = terrainHeight(-12345, 6789);
const proceduralField = airportNear(0, 0, 40000);
check(!!proceduralField, 'no procedural airport near the origin to restore');

const LJAJ_RAW = {
  id: 'LJAJ',
  code: 'LJAJ',
  name: 'Ajdovscina Airfield',
  heading: 90,
  length: 1800,
  width: 36,
  x: 0,
  z: 0,
  elevation: 112.4,
};

const installed = setCustomAirports([LJAJ_RAW]);
check(getCustomAirports() === installed, 'getCustomAirports did not return the installed list');
check(Array.isArray(installed) && installed.length === 1, 'setCustomAirports did not return one airport');
const ljaj = installed[0];
check(ljaj.id === 'LJAJ' && ljaj.code === 'LJAJ', 'LJAJ id/code lost while normalising');
check(ljaj.name === 'Ajdovscina Airfield', 'LJAJ name lost while normalising');
check(ljaj.heading === 90, `LJAJ heading is not 90 (${ljaj.heading})`);
check(ljaj.x === 0 && ljaj.z === 0, 'LJAJ is not at the DEM origin');
near(ljaj.padRadius, 1800 * 0.5 + 140, 1e-9, 'padRadius formula');
near(ljaj.blend, 1800 * 0.5 + 320, 1e-9, 'blend formula');
check(ljaj.kind === 'regional', `1800 m field should be regional (${ljaj.kind})`);

// The pad is dead flat on the pavement, both along and across RWY 09/27.
near(terrainHeight(0, 0), 112.4, 1e-3, 'LJAJ pad did not flatten the origin');
near(terrainHeight(300, 0), 112.4, 1e-3, 'LJAJ pad not flat along the runway');
near(terrainHeight(-820, 0), 112.4, 1e-3, 'LJAJ RWY 09 threshold not flat');
near(terrainHeight(0, 40), 112.4, 1e-3, 'LJAJ pad not flat across the runway');

// Outside the pad the smoothstep blend mixes back to the DEM/base height.
const dMid = (ljaj.padRadius + ljaj.blend) / 2;
const tMid = 1 - smoothstep(ljaj.padRadius, ljaj.blend, dMid);
const expectedMid = baseHeight(dMid, 0) + (112.4 - baseHeight(dMid, 0)) * tMid;
near(terrainHeight(dMid, 0), expectedMid, 1e-9, 'LJAJ blend ring does not mix smoothly');
check(baseHeight(dMid, 0) !== 112.4, 'blend-ring sample is a degenerate reference');
check(terrainHeight(ljaj.blend + 500, 0) === baseHeight(ljaj.blend + 500, 0),
  'terrain past the custom blend radius is not untouched');

// Custom airports are what the world reports while they are installed.
const customNear = airportsNear(0, 0, 1);
check(customNear.length === 1 && customNear[0].id === 'LJAJ', 'airportsNear did not report custom LJAJ');
check(airportNear(0, 0, 5000)?.id === 'LJAJ', 'airportNear did not return custom LJAJ');
check(airportNear(5000, 0, 1000) === null, 'airportNear ignored maxDist for custom airports');

// A second, far field exercises the (cellRadius + 1) * AIRPORT_GRID reach.
const installed2 = setCustomAirports([
  LJAJ_RAW,
  { ...LJAJ_RAW, id: 'LIPQ', code: 'LIPQ', name: 'Trieste Friuli Intl', x: 40000, z: 0, length: 3000, elevation: 7.4 },
]);
check(installed2[1].kind === 'intl', `3000 m field should be intl (${installed2[1].kind})`);
near(installed2[1].elevation, 7.4, 1e-9, 'custom elevation changed');
near(terrainHeight(40000, 0), 7.4, 1e-3, 'LIPQ pad did not flatten');
check(!airportsNear(0, 0, 1).some((a) => a.id === 'LIPQ'), 'airportsNear reach is too wide');
check(airportsNear(0, 0, 3).some((a) => a.id === 'LIPQ'), 'airportsNear reach is too narrow');

// Sea-level fields are lifted to the 3 m pad floor.
const seaLevel = setCustomAirports([{ ...LJAJ_RAW, id: 'LJPZ', elevation: -1.3 }])[0];
check(seaLevel.elevation === 3, `sea-level pad floor wrong (${seaLevel.elevation})`);

// Back to procedural: byte-identical terrain and the invented fields return.
setCustomAirports(null);
check(getCustomAirports() === null, 'setCustomAirports(null) did not clear the custom list');
check(terrainHeight(0, 0) === proceduralTerrainOrigin,
  'procedural terrainHeight at the origin not restored exactly');
check(terrainHeight(-12345, 6789) === proceduralTerrainFar,
  'procedural terrainHeight in a fresh area not restored exactly');
check(airportNear(0, 0, 40000)?.id === proceduralField.id,
  'procedural airports not restored by setCustomAirports(null)');
check(airportsNear(0, 0, 1).every((a) => a.id !== 'LJAJ' && a.id !== 'LIPQ'),
  'custom airports survived setCustomAirports(null)');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Vipava Valley DEM — acceptance test');
console.log('====================================');
console.log(`named elevations : sea ${NAMED[0][1]} m, valley ${NAMED[1][1]} m, ` +
  `Nanos ${NAMED[2][1]} m, Alps ${NAMED[3][1]} m`);
console.log(`blend weights    : 0 km=${namedDEM.blendWeight(0, 0).toFixed(3)}  ` +
  `47 km=${midW.toFixed(3)}  51 km=${namedDEM.blendWeight(51000, 0).toFixed(3)}`);
console.log(`procedural hook  : origin ${proceduralOrigin.toFixed(2)} m -> ` +
  `${VALLEY.toFixed(1)} m (DEM) -> ${proceduralOrigin.toFixed(2)} m (restored)`);
console.log(`checks: ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  process.exitCode = 1;
} else {
  console.log('\nALL DEM CHECKS PASSED');
}