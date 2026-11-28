// Headless acceptance test for the baked-DEM theater (Feature 27).
// Run: node tests/dem_test.mjs
//
// Verifies 16-bit RG decoding, bilinear sampling, the 88 km -> 100 km edge
// blend, and the terrain.js DEM hook including exact procedural restoration.

import fs from 'node:fs';
import path from 'node:path';

import {
  HeightmapDEM,
  StreamingTerrariumDEM,
  worldToLatLon,
  latLonToTileXY,
  tileXYToLatLon,
  decodeTerrariumRGB,
  loadVipavaDEM,
  loadVipavaOSM,
  parseBuildingsBinary,
  loadVipavaBuildings,
  _resetVipavaDEMCache,
  _resetVipavaOSMCache,
  _resetVipavaBuildingsCache,
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
// 7. Bicubic (Catmull-Rom) sampling on grids >= 4x4
// ---------------------------------------------------------------------------
const G = 6;
const GSIZE = 6000;
const gStep = GSIZE / (G - 1);
const gx = (i) => -GSIZE / 2 + i * gStep;

function makeGrid(fn) {
  const values = new Float32Array(G * G);
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) values[j * G + i] = fn(i, j);
  }
  return new HeightmapDEM({ width: G, height: G, sizeM: GSIZE, pixels: values });
}

// Linear ramps are reproduced exactly by Catmull-Rom (weights sum to 1).
const rampDEM = makeGrid((i, j) => 12 * i + 7.5 * j + 40);
const rampAt = (x, z) => 12 * ((x + GSIZE / 2) / gStep) + 7.5 * ((z + GSIZE / 2) / gStep) + 40;
for (const [x, z] of [
  [gx(0), gx(0)], [gx(5), gx(5)], [gx(2), gx(2)],
  [gx(2) + gStep * 0.5, gx(3)], [gx(1) + gStep * 0.25, gx(4) + gStep * 0.75],
  [-GSIZE / 2 + 1, GSIZE / 2 - 1],
]) {
  near(rampDEM.sample(x, z), rampAt(x, z), 1e-3,
    `bicubic linear ramp not exact at (${x.toFixed(1)}, ${z.toFixed(1)})`);
}

// A cubic is also reproduced exactly (bilinear would give 4.5 instead of 3.375
// halfway between samples 1 and 8), which proves the bicubic path is in use.
const cubicDEM = makeGrid((i) => i * i * i);
near(cubicDEM.sample(gx(1) + gStep * 0.5, gx(2)), 3.375, 1e-3,
  'bicubic did not reproduce a cubic between samples');
near(cubicDEM.sample(gx(1), gx(4)), 1, 1e-3, 'bicubic exact at a grid node');

// No discontinuity along x, even across cell boundaries.
let bicubicPrev = -Infinity;
let bicubicMaxStep = 0;
let bicubicSmooth = true;
for (let x = -GSIZE / 2; x <= GSIZE / 2; x += 1) {
  const h = rampDEM.sample(x, 0);
  if (!Number.isFinite(h)) { bicubicSmooth = false; break; }
  if (h < bicubicPrev - 1e-6) bicubicSmooth = false;
  if (bicubicPrev !== -Infinity) bicubicMaxStep = Math.max(bicubicMaxStep, h - bicubicPrev);
  bicubicPrev = h;
}
check(bicubicSmooth, 'bicubic samples are not monotone along x');
check(bicubicMaxStep <= 0.02, `bicubic step too large (${bicubicMaxStep})`);

// Steep ridges must not spike or punch holes: the 2x2 cell clamp bounds it.
const spikedValues = new Float32Array(G * G);
spikedValues[3 * G + 3] = 1000;
const spikeDEM = new HeightmapDEM({ width: G, height: G, sizeM: GSIZE, pixels: spikedValues });
let spikeMin = Infinity;
let spikeMax = -Infinity;
for (let x = -GSIZE / 2; x <= GSIZE / 2; x += gStep / 16) {
  for (let z = -GSIZE / 2; z <= GSIZE / 2; z += gStep / 16) {
    const h = spikeDEM.sample(x, z);
    if (h < spikeMin) spikeMin = h;
    if (h > spikeMax) spikeMax = h;
  }
}
check(spikeMin >= -1e-6, `bicubic undershot below flat ground (${spikeMin})`);
check(spikeMax <= 1000 + 1e-6, `bicubic overshot the peak (${spikeMax})`);
check(spikeMax > 500, 'bicubic lost the ridge peak entirely');

// ---------------------------------------------------------------------------
// 8. Nested HD inset (detailDEM): exact inside, blended across the border
// ---------------------------------------------------------------------------
const BASE_H = 100;
const HD_H = 500;
const baseDEM = new HeightmapDEM({
  width: 4,
  height: 4,
  sizeM: SIZE,
  pixels: new Float32Array(16).fill(BASE_H),
});
// Bounds-only construction (no sizeM) derives the extent from the spans.
const hdDEM = new HeightmapDEM({
  width: 8,
  height: 8,
  xMin: -10000,
  xMax: 10000,
  zMin: -10000,
  zMax: 10000,
  blendM: 2000,
  pixels: new Float32Array(64).fill(HD_H),
});
check(hdDEM.sizeM === 20000, `bounds-only DEM sizeM wrong (${hdDEM.sizeM})`);
check(hdDEM.xMin === -10000 && hdDEM.xMax === 10000
  && hdDEM.zMin === -10000 && hdDEM.zMax === 10000, 'HD bounds were not retained');
check(hdDEM.blendM === 2000, 'HD blendM was not retained');
near(hdDEM.sample(0, 0), HD_H, 1e-4, 'HD inset sample at its centre');
check(hdDEM.sample(20000, 0) === null, 'HD inset sample outside its bounds is not null');
near(hdDEM.blendWeight(0, 0), 1, 1e-12, 'HD blendWeight at centre');
near(hdDEM.blendWeight(9000, 0), 0.5, 1e-12, 'HD blendWeight smoothstep midpoint');
check(hdDEM.blendWeight(10000, 0) === 0, 'HD blendWeight at its edge is not 0');
check(hdDEM.blendWeight(20000, 0) === 0, 'HD blendWeight outside its bounds is not 0');

check(baseDEM.detailDEM === null, 'DEM started with a detail inset attached');
baseDEM.setDetailDEM(hdDEM);
check(baseDEM.detailDEM === hdDEM, 'setDetailDEM did not attach the inset');

near(baseDEM.sample(0, 0), HD_H, 1e-4, 'detailDEM is not exact inside the inner box');
near(baseDEM.sample(7000, -7000), HD_H, 1e-4, 'detailDEM is not exact at the inner corner');
near(baseDEM.sample(9000, 0), 300, 1e-4, 'detailDEM 50/50 blend at 9 km on x');
near(baseDEM.sample(0, -9000), 300, 1e-4, 'detailDEM 50/50 blend at 9 km on z');
near(baseDEM.sample(20000, 0), BASE_H, 1e-4, 'detailDEM kept control outside the inset');
near(baseDEM.sample(-10000, 0), BASE_H, 1e-4, 'detailDEM kept control at the inset edge');
near(baseDEM.sample(40000, 40000), BASE_H, 1e-4, 'detailDEM kept control far from the inset');
check(baseDEM.sample(60000, 0) === null, 'detailDEM sample outside outer bounds is not null');

// The transition is monotone and continuous across the blendM border.
let hdPrev = Infinity;
let hdMonotone = true;
for (let x = 8000; x <= 10000; x += 50) {
  const h = baseDEM.sample(x, 0);
  if (!(h <= hdPrev + 1e-6)) hdMonotone = false;
  hdPrev = h;
}
check(hdMonotone, 'detailDEM blend is not monotonically fading out');
near(hdPrev, BASE_H, 1e-4, 'detailDEM blend does not reach the outer height');
const hdMid = baseDEM.sample(9500, 0);
check(hdMid > BASE_H && hdMid < HD_H, `detailDEM blend is not strictly between (${hdMid})`);

baseDEM.setDetailDEM(null);
near(baseDEM.sample(0, 0), BASE_H, 1e-4, 'setDetailDEM(null) did not restore the outer DEM');
throws(() => baseDEM.setDetailDEM({ sample: () => 0 }),
  'setDetailDEM did not reject a non-HeightmapDEM');
check(baseDEM.detailDEM === null, 'a rejected detail DEM was still attached');

// ---------------------------------------------------------------------------
// 9. Compact binary buildings (FBLD v1)
// ---------------------------------------------------------------------------
function makeBuildingsBuffer(records, {
  magic = 'FBLD', version = 1, stride = 20, count = null,
} = {}) {
  const buf = new ArrayBuffer(16 + records.length * 20);
  const dv = new DataView(buf);
  for (let k = 0; k < 4; k++) dv.setUint8(k, magic.charCodeAt(k));
  dv.setUint32(4, version, true);
  dv.setUint32(8, count ?? records.length, true);
  dv.setUint32(12, stride, true);
  let o = 16;
  for (const r of records) {
    dv.setFloat32(o, r[0], true);
    dv.setFloat32(o + 4, r[1], true);
    dv.setUint16(o + 8, Math.round(r[2] * 10), true);
    dv.setUint16(o + 10, Math.round(r[3] * 10), true);
    dv.setUint16(o + 12, Math.round(r[4] * 10), true);
    dv.setInt16(o + 14, Math.round(r[5] * 10000), true);
    dv.setUint8(o + 16, r[6]);
    dv.setUint8(o + 17, r[7]);
    dv.setUint8(o + 18, r[8]);
    dv.setUint8(o + 19, r[9]);
    o += 20;
  }
  return buf;
}

const BLD_RECORDS = [
  [1234.5, -678.25, 12.3, 8.7, 6.5, 1.2345, 4, 4, 0, 77],
  [-40000.125, 25000.5, 3.1, 2.2, 1.1, -2.5, 0, 0, 2, 201],
];
const bldBuf = makeBuildingsBuffer(BLD_RECORDS);
const parsedBuildings = parseBuildingsBinary(bldBuf);
check(parsedBuildings !== null, 'parseBuildingsBinary rejected a valid FBLD buffer');
check(parsedBuildings.count === 2, `parseBuildingsBinary count wrong (${parsedBuildings?.count})`);
check(parsedBuildings.records.length === 2, 'parseBuildingsBinary did not return 2 records');
check(parsedBuildings.records[0].length === 10, 'building record is not a 10-tuple');
for (let i = 0; i < 2; i++) {
  const src = BLD_RECORDS[i];
  const rec = parsedBuildings.records[i];
  for (let k = 0; k < 10; k++) {
    const eps = k < 2 ? 1e-3 : 1e-6;
    near(rec[k], src[k], eps, `building ${i} field ${k} round-trip`);
  }
  check(Number.isInteger(rec[6]) && Number.isInteger(rec[7])
    && Number.isInteger(rec[8]) && Number.isInteger(rec[9]),
    `building ${i} codes are not integers`);
}

check(parseBuildingsBinary(new Uint8Array(bldBuf)) !== null,
  'parseBuildingsBinary did not accept a typed-array view');
check(parseBuildingsBinary(makeBuildingsBuffer(BLD_RECORDS, { magic: 'XBLD' })) === null,
  'parseBuildingsBinary accepted a bad magic');
check(parseBuildingsBinary(makeBuildingsBuffer(BLD_RECORDS, { version: 2 })) === null,
  'parseBuildingsBinary accepted an unknown version');
check(parseBuildingsBinary(makeBuildingsBuffer(BLD_RECORDS, { stride: 24 })) === null,
  'parseBuildingsBinary accepted a bad stride');
check(parseBuildingsBinary(makeBuildingsBuffer(BLD_RECORDS, { count: 3 })) === null,
  'parseBuildingsBinary accepted a buffer shorter than its count');
check(parseBuildingsBinary(new ArrayBuffer(8)) === null,
  'parseBuildingsBinary accepted a truncated header');
check(parseBuildingsBinary(makeBuildingsBuffer([])).count === 0,
  'parseBuildingsBinary rejected an empty (but valid) buffer');

check(typeof loadVipavaBuildings === 'function', 'loadVipavaBuildings is not exported');
check(typeof _resetVipavaBuildingsCache === 'function', '_resetVipavaBuildingsCache is not exported');
_resetVipavaBuildingsCache();
const missingBuildings = await loadVipavaBuildings('./media/definitely-not-here.bin');
check(missingBuildings === null, 'loadVipavaBuildings did not return null for a missing file');
_resetVipavaBuildingsCache();

// ---------------------------------------------------------------------------
// 10. Three-tier stack: HD inset -> regional bake -> 500 km macro bake
// ---------------------------------------------------------------------------
const MACRO_H = 1800;
const REGIONAL_H = 900;
const HD_TIER_H = 120;

const macroDEM = new HeightmapDEM({
  width: 4,
  height: 4,
  xMin: -250000,
  xMax: 250000,
  zMin: -250000,
  zMax: 250000,
  blendM: 20000,
  pixels: new Float32Array(16).fill(MACRO_H),
});
const regionalDEM = new HeightmapDEM({
  width: 4,
  height: 4,
  sizeM: SIZE, // 100 km square, default 6 km edge ramp
  pixels: new Float32Array(16).fill(REGIONAL_H),
});
const hdTier = new HeightmapDEM({
  width: 4,
  height: 4,
  xMin: -10000,
  xMax: 10000,
  zMin: -10000,
  zMax: 10000,
  blendM: 1500,
  pixels: new Float32Array(16).fill(HD_TIER_H),
});

check(regionalDEM.outerDEM === null && regionalDEM.streamingDEM === null,
  'DEM started with an outer/streaming tier attached');
regionalDEM.setDetailDEM(hdTier);
regionalDEM.setOuterDEM(macroDEM);
check(regionalDEM.outerDEM === macroDEM, 'setOuterDEM did not attach the macro tier');
check(regionalDEM.streamingDEM === null, 'setOuterDEM touched the streaming tier');
throws(() => regionalDEM.setOuterDEM(42), 'setOuterDEM did not reject a non-DEM');

// Tier 1 dominates the valley floor; the fast path must not even look outward.
const t0 = regionalDEM.sampleWithFallback(0, 0);
near(t0.height, HD_TIER_H, 1e-4, 'HD tier does not own the valley floor');
check(t0.weight === 1, `HD tier weight is not 1 (${t0.weight})`);
const t9 = regionalDEM.sampleWithFallback(9250, 0);
near(t9.height, HD_TIER_H * 0.5 + REGIONAL_H * 0.5, 1e-4,
  'HD -> regional 50/50 blend at 9.25 km');
check(t9.weight === 1, 'HD/regional blend should still be full real data');

// 50 km regional boundary: both real tiers, so the weight stays 1 and the
// height ramps 900 m -> 1800 m instead of dropping into procedural terrain.
const t47 = regionalDEM.sampleWithFallback(47000, 0);
near(t47.height, REGIONAL_H * 0.5 + MACRO_H * 0.5, 1e-4,
  'regional -> macro 50/50 blend at 47 km');
check(t47.weight === 1, `regional/macro blend weight is not 1 (${t47.weight})`);
near(regionalDEM.sampleWithFallback(60000, 0).height, MACRO_H, 1e-4,
  'macro tier does not own the ground past the regional edge');

// Reference procedural world: briefly clear the active DEM so baseHeight is
// the pure analytic landform, then restore it.
const proceduralAt = (x, z) => {
  const prev = getActiveDEM();
  setActiveDEM(null);
  const h = baseHeight(x, z);
  setActiveDEM(prev);
  return h;
};

setActiveDEM(regionalDEM);
const regionalChain = [];
for (let x = 40000; x <= 60000; x += 10) regionalChain.push(baseHeight(x, 0));
let regionalMaxStep = 0;
let regionalMonotone = true;
for (let i = 1; i < regionalChain.length; i++) {
  const step = Math.abs(regionalChain[i] - regionalChain[i - 1]);
  if (step > regionalMaxStep) regionalMaxStep = step;
  if (regionalChain[i] < regionalChain[i - 1] - 1e-6) regionalMonotone = false;
}
check(regionalMonotone, '50 km regional boundary blend is not monotone');
check(regionalMaxStep < 3, `50 km regional boundary has a cliff (${regionalMaxStep} m / 10 m)`);
near(baseHeight(50000, 0), MACRO_H, 1e-4, 'regional edge does not hand over to macro exactly');
near(baseHeight(70000, 0), MACRO_H, 1e-4, 'macro tier elevation wrong at 70 km');

// 250 km macro boundary: smoothly fades into procedural terrain offline.
const macroMid = regionalDEM.sampleWithFallback(240000, 0);
check(macroMid.weight > 0 && macroMid.weight < 1,
  `macro edge ramp weight out of range (${macroMid.weight})`);
near(macroMid.weight, 0.5, 1e-9, 'macro edge ramp is not the smoothstep midpoint at 240 km');
near(macroMid.height, MACRO_H, 1e-4, 'macro edge ramp height should be the bake value');

const macroChain = [];
let macroWeightMaxStep = 0;
let macroBounded = true;
let prevMacroW = regionalDEM.sampleWithFallback(229000, 0).weight;
for (let x = 229000; x <= 251000; x += 25) {
  const res = regionalDEM.sampleWithFallback(x, 0);
  const w = res.weight;
  macroWeightMaxStep = Math.max(macroWeightMaxStep, Math.abs(w - prevMacroW));
  prevMacroW = w;
  // Blending must stay inside the two envelopes: no faked or overshot height.
  const proc = proceduralAt(x, 0);
  if (w < 0.9999) {
    const lo = Math.min(MACRO_H, proc) - 1e-3;
    const hi = Math.max(MACRO_H, proc) + 1e-3;
    const h = res.height ?? proc;
    if (h < lo || h > hi) macroBounded = false;
  }
  macroChain.push(w);
}
check(macroChain.length > 800, 'macro boundary probe chain too short');
check(macroWeightMaxStep < 0.01,
  `250 km macro edge ramp is discontinuous (dw ${macroWeightMaxStep} / 25 m)`);
check(macroBounded, 'macro edge blend overshot the DEM/procedural envelope');
check(regionalDEM.sampleWithFallback(230000, 0).weight === 1,
  'macro tier weight is not 1 at the start of its edge ramp');
check(regionalDEM.sampleWithFallback(250000, 0).weight === 0,
  'macro tier weight is not 0 at the ring border');

const proceduralPastRing = baseHeight(300000, 0);
check(regionalDEM.sampleWithFallback(300000, 0).height === null,
  'past the macro ring (no tiles) should resolve to null');
check(baseHeight(300000, 0) === proceduralPastRing,
  'past the macro ring (no tiles) is not exactly procedural');

setActiveDEM(null);

// ---------------------------------------------------------------------------
// 11. Live AWS Terrarium streaming tier
// ---------------------------------------------------------------------------
// Terrarium decoding (exact 1/256 m steps).
check(decodeTerrariumRGB(128, 0, 0) === 0, 'decodeTerrariumRGB(128,0,0) !== 0');
check(decodeTerrariumRGB(130, 100, 128) === 612.5,
  `decodeTerrariumRGB(130,100,128) !== 612.5 (${decodeTerrariumRGB(130, 100, 128)})`);
near(decodeTerrariumRGB(0, 0, 0), -32768, 1e-9, 'decodeTerrariumRGB floor');

// world <-> lat/lon <-> tile round-trip at the Vipava origin.
const M_PER_LON_45 = 111412.84 * Math.cos((45.8878 * Math.PI) / 180);
const M_PER_LAT = 111132.92;
function xzFromLatLon(lat, lon) {
  return { x: (lon - 13.8869) * M_PER_LON_45, z: -(lat - 45.8878) * M_PER_LAT };
}

const originLL = worldToLatLon(0, 0, 45.8878, 13.8869);
near(originLL.lat, 45.8878, 1e-12, 'worldToLatLon origin lat');
near(originLL.lon, 13.8869, 1e-12, 'worldToLatLon origin lon');
const originTile = latLonToTileXY(originLL.lat, originLL.lon, 9);
check(Math.floor(originTile.fx) === 275 && Math.floor(originTile.fy) === 182,
  `Vipava origin is not in z9 tile 275/182 (${originTile.fx}, ${originTile.fy})`);
for (const [x, z] of [[0, 0], [100000, -50000], [-240000, 230000], [1234.5, -6789.25]]) {
  const ll = worldToLatLon(x, z, 45.8878, 13.8869);
  const t = latLonToTileXY(ll.lat, ll.lon, 9);
  const back = tileXYToLatLon(t.fx, t.fy, 9);
  const p = xzFromLatLon(back.lat, back.lon);
  near(p.x, x, 1e-3, `world->latlon->tile->world x round-trip at ${x}`);
  near(p.z, z, 1e-3, `world->latlon->tile->world z round-trip at ${z}`);
}

// Synthetic tile injection + uniform sampling past the macro ring.
const stream = new StreamingTerrariumDEM({ zoom: 9, maxTiles: 8 });
check(stream.sample(0, 0) === null, 'streaming DEM returned data before any tile was cached');
regionalDEM.setStreamingDEM(stream);

const farTile = stream.tileAt(300000, 0);
const farTx = Math.floor(farTile.fx);
const farTy = Math.floor(farTile.fy);
stream.injectTile(farTx, farTy, new Float32Array(256 * 256).fill(333));
const farRes = regionalDEM.sampleWithFallback(300000, 0);
near(farRes.height, 333, 1e-4, 'streamed tile elevation not used past the macro ring');
check(farRes.weight === 1, `streamed tile read weight is not 1 (${farRes.weight})`);
setActiveDEM(regionalDEM);
near(baseHeight(300000, 0), 333, 1e-4, 'baseHeight did not pick up the streamed tile');
setActiveDEM(null);

// Bilinear sampling inside an injected tile (x gradient, constant rows).
const gradStream = new StreamingTerrariumDEM({ zoom: 9 });
const grad = new Float32Array(256 * 256);
for (let row = 0; row < 256; row++) {
  for (let col = 0; col < 256; col++) grad[row * 256 + col] = col;
}
const gradTile = gradStream.tileAt(0, 0);
const gradTx = Math.floor(gradTile.fx);
const gradTy = Math.floor(gradTile.fy);
gradStream.injectTile(gradTx, gradTy, grad);
const probeLL = tileXYToLatLon(gradTx + 10.5 / 256, gradTy + 100 / 256, 9);
const probe = xzFromLatLon(probeLL.lat, probeLL.lon);
near(gradStream.sample(probe.x, probe.z), 10.5, 1e-3,
  'streaming bilinear interpolation inside a tile is wrong');

// LRU eviction: oldest tile goes first, but a re-sampled tile is refreshed.
const lru = new StreamingTerrariumDEM({ zoom: 9, maxTiles: 3 });
const lruTx = Math.floor(lru.tileAt(0, 0).fx);
const lruTy = Math.floor(lru.tileAt(0, 0).fy);
for (let i = 0; i < 3; i++) {
  lru.injectTile(lruTx + i, lruTy, new Float32Array(256 * 256).fill(100 + i));
}
check(lru.cache.size === 3, `LRU cache size wrong (${lru.cache.size})`);
// Touch tile 0 by sampling a point inside it.
const touchLL = tileXYToLatLon(lruTx + 0.5, lruTy + 0.5, 9);
const touch = xzFromLatLon(touchLL.lat, touchLL.lon);
near(lru.sample(touch.x, touch.z), 100, 1e-4, 'LRU touch sample value wrong');
lru.injectTile(lruTx + 3, lruTy, new Float32Array(256 * 256).fill(103));
check(lru.cache.size === 3, `LRU cache grew past maxTiles (${lru.cache.size})`);
check(lru.cache.has(lru.tileKey(lruTx, lruTy)),
  'LRU evicted a recently sampled tile');
check(!lru.cache.has(lru.tileKey(lruTx + 1, lruTy)),
  'LRU did not evict the oldest untouched tile');
check(lru.stats.evicted === 1, `LRU eviction count wrong (${lru.stats.evicted})`);
throws(() => lru.injectTile(lruTx, lruTy, new Float32Array(10)),
  'injectTile did not reject a wrong-sized buffer');
// Re-injecting an existing key must refresh it in place, not duplicate it.
lru.injectTile(lruTx, lruTy, new Float32Array(256 * 256).fill(999));
check(lru.cache.size === 3, `re-injecting a tile changed cache size (${lru.cache.size})`);
check(lru.stats.evicted === 1, 're-injecting a tile caused an eviction');

// Headless / offline safety: requestAround must never throw or reject in Node.
let requestThrew = false;
let started = null;
try {
  started = stream.requestAround(0, 0, 1);
  stream.requestAround(300000, 300000, 2);
  stream.requestAround(NaN, Infinity, 1);
} catch {
  requestThrew = true;
}
check(!requestThrew, 'requestAround threw in a headless Node run');
check(Array.isArray(started) && started.length === 0,
  'requestAround scheduled network work without fetch/document');

// A DEM with only a streaming tier (no outer bake) still resolves or nulls.
const streamOnly = new HeightmapDEM({
  width: 4, height: 4, sizeM: SIZE, pixels: new Float32Array(16).fill(50),
});
streamOnly.setStreamingDEM(stream);
check(streamOnly.sampleWithFallback(300000, 0).height === 333,
  'streaming tier is not consulted when no outer DEM exists');
check(streamOnly.sampleWithFallback(400000, 400000).height === null,
  'streaming tier invented data for an uncached tile');

// ---------------------------------------------------------------------------
// 12. Baked macro ring assets in public/media
// ---------------------------------------------------------------------------
const MEDIA = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..',
  'public', 'media');
const macroPath = path.join(MEDIA, 'vipava_dem_macro.png');
check(fs.existsSync(macroPath), 'public/media/vipava_dem_macro.png is missing');
const macroBytes = fs.existsSync(macroPath) ? fs.statSync(macroPath).size : 0;
check(macroBytes > 400000 && macroBytes < 4_000_000,
  `vipava_dem_macro.png size out of range (${macroBytes} bytes)`);

if (macroBytes > 0) {
  const head = fs.readFileSync(macroPath).subarray(0, 33);
  check(head.toString('ascii', 1, 4) === 'PNG', 'macro PNG has a bad signature');
  const macroW = head.readUInt32BE(16);
  const macroH = head.readUInt32BE(20);
  check(macroW === 1024 && macroH === 1024,
    `macro PNG is ${macroW}x${macroH}, expected 1024x1024`);
  check(head[24] === 8 && head[25] === 2,
    `macro PNG is not 8-bit RGB (depth=${head[24]}, colorType=${head[25]})`);
}

const metaPath = path.join(MEDIA, 'vipava_meta.json');
const bakedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const macroMeta = bakedMeta.macro;
check(!!macroMeta && typeof macroMeta === 'object', 'vipava_meta.json has no macro block');
if (macroMeta) {
  check(macroMeta.url === './media/vipava_dem_macro.png', 'macro.url is wrong');
  check(macroMeta.grid === 1024, `macro.grid wrong (${macroMeta.grid})`);
  check(macroMeta.xMin === -250000 && macroMeta.xMax === 250000,
    'macro world x bounds wrong');
  check(macroMeta.zMin === -250000 && macroMeta.zMax === 250000,
    'macro world z bounds wrong');
  check(macroMeta.blendM === 20000, `macro.blendM wrong (${macroMeta.blendM})`);
  check(macroMeta.offset === -200 && macroMeta.scale === 16,
    'macro offset/scale wrong');
}
// The macro bake must not have disturbed the tiers that already shipped.
check(bakedMeta.hd && bakedMeta.hd.grid === 2048, 'hd metadata was damaged by the macro bake');
check(Array.isArray(bakedMeta.airports) && bakedMeta.airports.length === 5,
  'airport metadata was damaged by the macro bake');
check(bakedMeta.grid === 2048 && bakedMeta.sizeM === 100000,
  'regional DEM metadata was damaged by the macro bake');

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