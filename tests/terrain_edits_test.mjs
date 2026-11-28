// Headless acceptance test for painted terrain & colour edits.
// Run: node tests/terrain_edits_test.mjs
//
// Covers: neutral startup bit-identity, every height brush, bilinear sampling,
// every colour brush, the colour DataTexture built without WebGL, undo/redo
// stroke batching, sparse JSON round-trips, and the terrain.js singleton hook.

import * as THREE from 'three';

import {
  TerrainEdits,
  DEFAULT_EDIT_BOUNDS,
  HEIGHT_SCALE,
  NEUTRAL,
  setActiveTerrainEdits,
  getActiveTerrainEdits,
  sampleActiveHeightDelta,
} from '../src/world/terrain_edits.js';
import {
  terrainHeight,
  baseHeight,
  airportNear,
  setActiveDEM,
  setCustomAirports,
} from '../src/world/terrain.js';

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
function near(actual, want, eps, msg) {
  check(Number.isFinite(actual) && Math.abs(actual - want) <= eps,
    `${msg} (got ${actual}, want ${want} +/- ${eps})`);
}
function equalArrays(a, b, msg) {
  check(a.length === b.length && a.every((v, i) => v === b[i]),
    `${msg} (got [${a}], want [${b}])`);
}
function nearArrays(a, b, eps, msg) {
  check(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps),
    `${msg} (got [${a}], want [${b}] +/- ${eps})`);
}

const BOUNDS = { xMin: -1000, xMax: 1000, zMin: -1000, zMax: 1000 };
const ODD_H = 65; // odd grids put a cell exactly on the centre
const ODD_C = 9;

// ---------------------------------------------------------------------------
// 1. Neutral startup: no edits, no delta, bit-identical terrain
// ---------------------------------------------------------------------------
check(HEIGHT_SCALE === 20, `HEIGHT_SCALE is not 20 (${HEIGHT_SCALE})`);
check(NEUTRAL === 128, `NEUTRAL is not 128 (${NEUTRAL})`);
check(DEFAULT_EDIT_BOUNDS.xMin === -50000 && DEFAULT_EDIT_BOUNDS.xMax === 50000
  && DEFAULT_EDIT_BOUNDS.zMin === -50000 && DEFAULT_EDIT_BOUNDS.zMax === 50000,
  'DEFAULT_EDIT_BOUNDS does not cover the 100 km Vipava map');

const defaults = new TerrainEdits();
check(defaults.heightGrid === 2048 && defaults.colorGrid === 1024,
  `default grid sizes wrong (${defaults.heightGrid}/${defaults.colorGrid})`);
check(defaults.heightData instanceof Int16Array
  && defaults.heightData.length === 2048 * 2048, 'height grid is not Int16Array(2048^2)');
check(defaults.colorData instanceof Uint8Array
  && defaults.colorData.length === 1024 * 1024 * 4, 'colour grid is not Uint8Array(1024^2*4)');
check(defaults.hasHeightEdits === false && defaults.heightCount === 0,
  'default instance has height edits at startup');
check(defaults.hasColorEdits === false, 'default instance has colour edits at startup');
let neutralColor = true;
for (let i = 0; i < defaults.colorData.length; i++) {
  if (defaults.colorData[i] !== NEUTRAL) { neutralColor = false; break; }
}
check(neutralColor, 'colour grid did not start at neutral 128');
check(defaults.exportJSON().h.length === 0 && defaults.exportJSON().c.length === 0,
  'an empty world exported non-empty sparse arrays');

const empty = new TerrainEdits({ bounds: BOUNDS, heightGrid: ODD_H, colorGrid: ODD_C });
for (const [x, z] of [[0, 0], [999, -999], [-12345, 6789], [50001, 0], [0, -50000]]) {
  check(empty.sampleHeightDelta(x, z) === 0, `neutral delta nonzero at ${x},${z}`);
}
check(getActiveTerrainEdits() === null, 'an edits object was active before installation');

const PROBES = [[0, 0], [150.5, -220.25], [12000, 8000], [-33333, 44444], [49999, -49999]];
const baseTerrain = PROBES.map(([x, z]) => terrainHeight(x, z));
setActiveTerrainEdits(empty);
PROBES.forEach(([x, z], i) => {
  check(terrainHeight(x, z) === baseTerrain[i],
    `empty TerrainEdits changed terrainHeight at ${x},${z}`);
});
setActiveTerrainEdits(null);

// ---------------------------------------------------------------------------
// 2. Height brushes
// ---------------------------------------------------------------------------
const hc = 100000 / (513 - 1); // 195.3125 m on the default bounds

// raise: +0.6 m per 0.05 s at strength 1, exact on the centre cell
const raised = new TerrainEdits({ heightGrid: 513, colorGrid: 513 });
const raiseRes = raised.applyHeightBrush({
  mode: 'raise', x: 0, z: 0, radius: 1000, strength: 1, dt: 0.05,
});
check(raiseRes.changed === true, 'raise brush reported no change');
check(raised.hasHeightEdits === true && raised.heightCount > 0,
  'raise brush did not flag height edits');
near(raised.sampleHeightDelta(0, 0), 0.6, 1e-9, 'raise centre is not +0.6 m');
near(raised.getHeightCell(256, 256), 0.6, 1e-9, 'raise centre cell is not 6 quanta');
check(raised.sampleHeightDelta(1000, 0) === 0, 'raise leaked onto the brush edge');
check(raised.sampleHeightDelta(1200, 0) === 0, 'raise leaked outside the radius');
check(raised.sampleHeightDelta(0, -1400) === 0, 'raise leaked outside the radius (z)');
// Falloff is strictly decreasing with distance.
let prevDelta = Infinity;
let monotone = true;
for (let d = 0; d <= 990; d += 10) {
  const v = raised.sampleHeightDelta(d, 0);
  if (v > prevDelta + 1e-12) monotone = false;
  prevDelta = v;
}
check(monotone, 'raise falloff is not monotone outward from the centre');
check(prevDelta < 1e-3, `raise falloff did not reach zero near the radius (${prevDelta})`);
// Bounds are padded two cells beyond the outermost touched cell.
check(raiseRes.bounds.xMin < -1000 - hc * 0.5 && raiseRes.bounds.xMax > 1000 + hc * 0.5,
  `raise bounds are not padded (${JSON.stringify(raiseRes.bounds)})`);
check(raiseRes.bounds.xMin >= -1000 - hc * 3.5 && raiseRes.bounds.xMax <= 1000 + hc * 3.5,
  `raise bounds are padded by more than 2 cells (${JSON.stringify(raiseRes.bounds)})`);
check(raiseRes.bounds.zMin < -1000 && raiseRes.bounds.zMax > 1000,
  'raise bounds ignore z padding');

// lower
const lowered = new TerrainEdits({ heightGrid: 513, colorGrid: 513 });
lowered.applyHeightBrush({ mode: 'lower', x: 0, z: 0, radius: 1000, strength: 1, dt: 0.05 });
near(lowered.sampleHeightDelta(0, 0), -0.6, 1e-9, 'lower centre is not -0.6 m');
check(lowered.sampleHeightDelta(900, 900) === 0, 'lower leaked outside the radius');

// flatten: one step is exact, many steps converge on targetY
const flattened = new TerrainEdits({ heightGrid: 513, colorGrid: 513 });
const BASE_Y = 100;
const flatStep = flattened.applyHeightBrush({
  mode: 'flatten', x: 0, z: 0, radius: 1000, strength: 1, dt: 0.05,
  targetY: 2, baseHeightAt: () => BASE_Y,
});
check(flatStep.changed === true, 'flatten brush reported no change');
near(flattened.sampleHeightDelta(0, 0), -29.4, 1e-6,
  'flatten step is not (target - total) * 0.3');
for (let i = 0; i < 40; i++) {
  flattened.applyHeightBrush({
    mode: 'flatten', x: 0, z: 0, radius: 1000, strength: 1, dt: 0.05,
    targetY: 2, baseHeightAt: () => BASE_Y,
  });
}
near(BASE_Y + flattened.sampleHeightDelta(0, 0), 2, 0.05,
  'flatten did not converge on targetY');
check(flattened.sampleHeightDelta(1400, 0) === 0, 'flatten leaked outside the radius');

// smooth: a lone spike relaxes toward its 4-neighbour average by 25% / step
const smoothed = new TerrainEdits({ heightGrid: 513, colorGrid: 513 });
smoothed.setHeightCell(256, 256, 10);
near(smoothed.sampleHeightDelta(0, 0), 10, 1e-9, 'spike was not planted');
const smoothStep = smoothed.applyHeightBrush({
  mode: 'smooth', x: 0, z: 0, radius: 500, strength: 1, dt: 0.05,
});
check(smoothStep.changed === true, 'smooth brush reported no change');
near(smoothed.getHeightCell(256, 256), 7.5, 1e-9, 'smooth step is not 25% toward the mean');
check(smoothed.getHeightCell(256, 256) > 0, 'smooth erased the spike outright');
check(smoothed.sampleHeightDelta(1500, 1500) === 0, 'smooth leaked outside the radius');

// erase_height: back to flat, and the counters clear themselves
const erased = new TerrainEdits({ heightGrid: 513, colorGrid: 513 });
erased.applyHeightBrush({ mode: 'raise', x: 0, z: 0, radius: 1000, strength: 1, dt: 0.05 });
near(erased.sampleHeightDelta(0, 0), 0.6, 1e-9, 'erase fixture did not raise');
for (let i = 0; i < 40; i++) {
  erased.applyHeightBrush({ mode: 'erase_height', x: 0, z: 0, radius: 1000, strength: 1, dt: 0.05 });
}
check(erased.sampleHeightDelta(0, 0) === 0, 'erase_height did not flatten the delta');
check(erased.hasHeightEdits === false && erased.heightCount === 0,
  'erase_height left stale edit flags');

// Invalid input and out-of-bounds brushes are no-ops.
const noop = erased.applyHeightBrush({ mode: 'raise', x: 60000, z: 0, radius: 500 });
check(noop.changed === false && noop.bounds === null, 'out-of-bounds brush reported a change');
check(erased.applyHeightBrush({ mode: 'bogus', x: 0, z: 0, radius: 500 }).changed === false,
  'unknown brush mode reported a change');
check(erased.applyHeightBrush({ mode: 'raise', x: 0, z: 0, radius: 0 }).changed === false,
  'zero-radius brush reported a change');
check(erased.applyHeightBrush({ mode: 'raise', x: NaN, z: 0, radius: 500 }).changed === false,
  'NaN position brush reported a change');

// ---------------------------------------------------------------------------
// 3. Bilinear interpolation between grid cells
// ---------------------------------------------------------------------------
const small = new TerrainEdits({
  bounds: { xMin: -100, xMax: 100, zMin: -100, zMax: 100 },
  heightGrid: 3,
  colorGrid: 5,
});
small.setHeightCell(1, 1, 10); // the exact centre cell
near(small.sampleHeightDelta(0, 0), 10, 1e-9, 'bilinear node sample');
near(small.sampleHeightDelta(-50, 0), 5, 1e-9, 'bilinear halfway on x');
near(small.sampleHeightDelta(0, -50), 5, 1e-9, 'bilinear halfway on z');
near(small.sampleHeightDelta(-50, -50), 2.5, 1e-9, 'bilinear 1/4 corner');
near(small.sampleHeightDelta(50, 50), 2.5, 1e-9, 'bilinear opposite 1/4 corner');
near(small.sampleHeightDelta(25, -25), 5.625, 1e-9, 'bilinear off-node sample');
near(small.sampleHeightDelta(-100, 100), 0, 1e-9, 'bilinear far corner stays flat');
check(small.sampleHeightDelta(-100.5, 0) === 0, 'bilinear extrapolated outside the bounds');
// Continuity: no step larger than the full cell delta / 20 across the grid.
let bilPrev = small.sampleHeightDelta(-100, 0);
let bilMaxStep = 0;
for (let x = -100; x <= 100; x += 0.5) {
  const v = small.sampleHeightDelta(x, 0);
  bilMaxStep = Math.max(bilMaxStep, Math.abs(v - bilPrev));
  bilPrev = v;
}
check(bilMaxStep <= 0.6, `bilinear sampling is discontinuous (${bilMaxStep} m per 0.5 m)`);

// ---------------------------------------------------------------------------
// 4. Colour brushes + headless DataTexture
// ---------------------------------------------------------------------------
function freshPaint() {
  return new TerrainEdits({ bounds: { xMin: -300, xMax: 300, zMin: -300, zMax: 300 }, heightGrid: 65, colorGrid: 7 });
}

// custom tint is exact in a single step (rate 0.7 at the centre, w = 1)
const custom = freshPaint();
const customRes = custom.applyColorBrush({
  mode: 'custom', x: 0, z: 0, radius: 300, strength: 1, dt: 0.2,
  tintRgb: [200, 20, 20, 255],
});
check(customRes.changed === true, 'custom colour brush reported no change');
equalArrays(custom.getColorPixel(3, 3), [178, 52, 52, 217], 'custom tint step is wrong');
check(custom.hasColorEdits === true, 'custom tint did not flag colour edits');
check(custom.sampleColor(0, 0)[0] === 178, 'sampleColor does not read the painted pixel');
check(customRes.bounds.xMin < -300 * 0.999 && customRes.bounds.xMax > 300 * 0.999,
  'colour brush bounds do not span the painted area');
check(custom.applyColorBrush({ mode: 'custom', x: 0, z: 0, radius: 200 }).changed === false,
  'custom mode without tintRgb reported a change');

const MODES = [
  ['desaturate', [126, 118, 114], 58],
  ['darken', [76, 78, 74], 128],
  ['lighten', [178, 176, 170], 128],
  ['deep_forest', [92, 104, 86], 106],
  ['warm_olive', [146, 132, 102], 96],
  ['karst_stone', [154, 150, 140], 72],
];
for (const [mode, rgb, alpha] of MODES) {
  const e = freshPaint();
  for (let i = 0; i < 40; i++) {
    e.applyColorBrush({ mode, x: 0, z: 0, radius: 300, strength: 1, dt: 0.1 });
  }
  const px = e.getColorPixel(3, 3);
  for (let ch = 0; ch < 3; ch++) {
    near(px[ch], rgb[ch], 1, `${mode} channel ${ch} did not settle on its target`);
  }
  near(px[3], alpha, 1, `${mode} alpha did not settle on its target`);
  check(e.hasColorEdits === true, `${mode} did not flag colour edits`);
  // Far corner pixels stay neutral: the brush is radial.
  equalArrays(e.getColorPixel(0, 0), [128, 128, 128, 128], `${mode} leaked to the far corner`);
}
// desaturate also cools bright neon green instead of just dimming it.
const neon = freshPaint();
for (let i = 0; i < 40; i++) {
  neon.applyColorBrush({ mode: 'desaturate', x: 0, z: 0, radius: 300, strength: 1, dt: 0.1 });
}
const neonPx = neon.getColorPixel(3, 3);
check(neonPx[1] < 128 && neonPx[3] < 90,
  `desaturate did not tame saturation/RGB (${neonPx})`);
check(neonPx[0] >= neonPx[1] && neonPx[1] >= neonPx[2],
  `desaturate did not warm the tint to olive order (${neonPx})`);

// erase_color restores neutral and clears the flag.
const erasedColor = freshPaint();
const erasedColorTex = erasedColor.createColorTexture();
for (let i = 0; i < 10; i++) {
  erasedColor.applyColorBrush({ mode: 'deep_forest', x: 0, z: 0, radius: 300, strength: 1, dt: 0.1 });
}
check(erasedColor.getColorPixel(3, 3)[0] !== 128, 'erase_color fixture did not paint');
for (let i = 0; i < 60; i++) {
  erasedColor.applyColorBrush({ mode: 'erase_color', x: 0, z: 0, radius: 300, strength: 1, dt: 0.1 });
}
equalArrays(erasedColor.getColorPixel(3, 3), [128, 128, 128, 128], 'erase_color did not restore neutral');
check(erasedColor.hasColorEdits === false, 'erase_color left a stale colour flag');
const settledVer = erasedColorTex.version;
erasedColor.applyColorBrush({ mode: 'erase_color', x: 0, z: 0, radius: 300, strength: 1, dt: 0.1 });
check(erasedColorTex.version === settledVer,
  'a no-op erase_color step still dirtied the texture');

// Headless DataTexture: valid three.js texture, no WebGL context required.
const texOwner = freshPaint();
texOwner.applyColorBrush({ mode: 'karst_stone', x: 0, z: 0, radius: 300, strength: 1, dt: 0.1 });
const tex = texOwner.createColorTexture();
check(tex.isDataTexture === true && tex instanceof THREE.DataTexture,
  'createColorTexture did not return a THREE.DataTexture');
check(tex.image.data === texOwner.colorData, 'texture does not wrap the live colour buffer');
check(tex.image.width === 7 && tex.image.height === 7, 'texture dimensions do not match colorGrid');
check(tex.flipY === false && tex.wrapS === THREE.ClampToEdgeWrapping
  && tex.wrapT === THREE.ClampToEdgeWrapping, 'texture wrapping/flip settings are wrong');
check(tex.minFilter === THREE.LinearFilter && tex.magFilter === THREE.LinearFilter,
  'texture filters are wrong');
check(tex.generateMipmaps === false, 'texture mipmaps were left enabled');
check(tex.colorSpace === THREE.NoColorSpace, 'texture is not in NoColorSpace');
check(texOwner.createColorTexture() === tex, 'createColorTexture did not cache its texture');
const versionBefore = tex.version;
texOwner.markColorDirty();
check(tex.version > versionBefore, 'markColorDirty did not bump the texture version');
texOwner.applyColorBrush({ mode: 'darken', x: 0, z: 0, radius: 300, strength: 1, dt: 0.1 });
check(tex.version > versionBefore + 1, 'colour painting did not mark the texture dirty');

// ---------------------------------------------------------------------------
// 5. Undo / stroke batching
// ---------------------------------------------------------------------------
const undoing = new TerrainEdits({ bounds: BOUNDS, heightGrid: ODD_H, colorGrid: ODD_C });
check(undoing.canUndo() === false && undoing.undoCount === 0, 'undo stack started non-empty');
check(undoing.undo() === null, 'undo() on an empty stack did not return null');
new TerrainEdits({ bounds: BOUNDS, heightGrid: ODD_H, colorGrid: ODD_C })
  .applyHeightBrush({ mode: 'raise', x: 0, z: 0, radius: 150, strength: 1, dt: 0.05 });
check(undoing.undoCount === 0, 'painting without beginStroke recorded undo');

undoing.beginStroke('height');
undoing.applyHeightBrush({ mode: 'raise', x: 0, z: 0, radius: 150, strength: 1, dt: 0.05 });
undoing.applyHeightBrush({ mode: 'raise', x: 0, z: 0, radius: 150, strength: 1, dt: 0.05 });
undoing.endStroke();
const centreAfterStroke1 = undoing.sampleHeightDelta(0, 0);
near(centreAfterStroke1, 1.2, 1e-9, 'two raise steps in one stroke are not 1.2 m');

undoing.beginStroke('height');
const bRes = undoing.applyHeightBrush({ mode: 'raise', x: 600, z: 600, radius: 150, strength: 1, dt: 0.05 });
undoing.endStroke();
check(undoing.undoCount === 2, `undoCount should be 2 (${undoing.undoCount})`);
check(bRes.bounds.xMin <= 450 && bRes.bounds.xMax >= 750
  && bRes.bounds.zMin <= 450 && bRes.bounds.zMax >= 750,
  'the second stroke bounds do not cover its brush');
near(undoing.sampleHeightDelta(600, 600), 0.6, 0.05, 'second stroke did not paint');

const undo1 = undoing.undo();
check(!!undo1 && undo1.kind === 'height', 'undo() did not report a height stroke');
check(undo1.bounds.xMin <= 450 && undo1.bounds.xMax >= 750,
  'undo() bounds do not cover the undone stroke');
check(undoing.sampleHeightDelta(600, 600) === 0, 'undo did not restore the second stroke cells');
near(undoing.sampleHeightDelta(0, 0), centreAfterStroke1, 1e-9,
  'undo disturbed the earlier stroke');

const undo2 = undoing.undo();
check(!!undo2 && undo2.kind === 'height', 'second undo() did not report a height stroke');
check(undoing.sampleHeightDelta(0, 0) === 0, 'undo did not restore the first stroke cells');
check(undoing.hasHeightEdits === false && undoing.heightCount === 0,
  'undo left stale height flags');
check(undoing.undoCount === 0 && undoing.canUndo() === false, 'undo stack did not empty');

// Colour strokes restore exact RGBA and dirty the texture.
const undoColor = new TerrainEdits({ bounds: BOUNDS, heightGrid: ODD_H, colorGrid: ODD_C });
const undoColorTex = undoColor.createColorTexture();
undoColor.beginStroke('color');
undoColor.applyColorBrush({ mode: 'warm_olive', x: 0, z: 0, radius: 300, strength: 1, dt: 0.1 });
undoColor.endStroke();
const painted = undoColor.getColorPixel(4, 4);
check(painted.some((v) => v !== 128), 'colour stroke did not paint the centre pixel');
const texVer = undoColorTex.version;
const undoColorRes = undoColor.undo();
check(!!undoColorRes && undoColorRes.kind === 'color', 'colour undo did not report its kind');
equalArrays(undoColor.getColorPixel(4, 4), [128, 128, 128, 128], 'colour undo did not restore RGBA');
check(undoColor.hasColorEdits === false, 'colour undo left a stale flag');
check(undoColorTex.version > texVer, 'colour undo did not mark the texture dirty');
check(undoColor.undo() === null, 'colour undo stack should be empty');

// The undo stack is capped at 40 strokes.
const capped = new TerrainEdits({ bounds: BOUNDS, heightGrid: ODD_H, colorGrid: ODD_C });
for (let i = 0; i < 45; i++) {
  capped.beginStroke('height');
  capped.applyHeightBrush({ mode: 'raise', x: 0, z: 0, radius: 60, strength: 1, dt: 0.05 });
  capped.endStroke();
}
check(capped.undoCount === 40, `undo stack is not capped at 40 (${capped.undoCount})`);
check(capped.endStroke() === null, 'endStroke without beginStroke did not return null');

// ---------------------------------------------------------------------------
// 6. Sparse JSON round-trip
// ---------------------------------------------------------------------------
const exportable = new TerrainEdits({ bounds: BOUNDS, heightGrid: ODD_H, colorGrid: ODD_C });
exportable.applyHeightBrush({ mode: 'raise', x: 0, z: 0, radius: 300, strength: 1, dt: 0.05 });
exportable.applyHeightBrush({ mode: 'lower', x: -600, z: 400, radius: 200, strength: 1, dt: 0.05 });
exportable.applyColorBrush({ mode: 'deep_forest', x: 0, z: 0, radius: 300, strength: 1, dt: 0.1 });
const exportCentreDelta = exportable.sampleHeightDelta(0, 0);
const snap = exportable.exportJSON();

check(snap.version === 1, 'export version is not 1');
check(snap.heightScale === HEIGHT_SCALE, 'export heightScale is wrong');
check(snap.heightGrid === ODD_H && snap.colorGrid === ODD_C, 'export grid sizes are wrong');
check(snap.bounds.xMin === BOUNDS.xMin && snap.bounds.zMax === BOUNDS.zMax,
  'export bounds were not copied');
check(snap.h.length > 0 && snap.h.length % 2 === 0, 'export h is not a flat [idx, q] array');
check(snap.c.length > 0 && snap.c.length % 5 === 0, 'export c is not a flat [idx, r, g, b, a] array');
let skipNeutralH = true;
for (let i = 0; i < snap.h.length; i += 2) if (snap.h[i + 1] === 0) skipNeutralH = false;
check(skipNeutralH, 'export h contains zero-valued (neutral) cells');
let skipNeutralC = true;
for (let i = 0; i < snap.c.length; i += 5) {
  const px = [snap.c[i + 1], snap.c[i + 2], snap.c[i + 3], snap.c[i + 4]];
  if (px.every((v) => Math.abs(v - NEUTRAL) < 2)) skipNeutralC = false;
}
check(skipNeutralC, 'export c contains neutral pixels');
check(snap.h.length / 2 === exportable.heightCount, 'export h count disagrees with heightCount');
check(snap.c.length / 5 <= exportable.colorCount, 'export c has more pixels than colorCount');

const imported = new TerrainEdits({ bounds: BOUNDS, heightGrid: ODD_H, colorGrid: ODD_C });
const loaded = imported.importJSON(snap);
check(loaded.heightCells === exportable.heightCount, 'import height cell count is wrong');
check(loaded.colorPixels === snap.c.length / 5, 'import colour pixel count is wrong');
check(imported.hasHeightEdits && imported.hasColorEdits, 'import did not flag its edits');
for (const [x, z] of [[0, 0], [300, 200], [-600, 400], [-450, 100], [900, 900]]) {
  near(imported.sampleHeightDelta(x, z), exportable.sampleHeightDelta(x, z), 1e-9,
    `height round-trip differs at ${x},${z}`);
}
for (const [ix, iz] of [[4, 4], [4, 5], [3, 4], [1, 1], [8, 8]]) {
  nearArrays(imported.getColorPixel(ix, iz), exportable.getColorPixel(ix, iz), 1,
    `colour round-trip differs at ${ix},${iz}`);
}

// A differing target grid resamples instead of throwing.
const resized = new TerrainEdits({ bounds: BOUNDS, heightGrid: 129, colorGrid: 17 });
const resizedRes = resized.importJSON(snap);
check(resizedRes.heightCells > 0 && resizedRes.colorPixels > 0, 'resampled import loaded nothing');
near(resized.sampleHeightDelta(0, 0), exportable.sampleHeightDelta(0, 0), 1e-9,
  'resampled import lost the centre height cell');
nearArrays(resized.getColorPixel(8, 8), exportable.getColorPixel(4, 4), 1,
  'resampled import lost the centre colour pixel');

// Importing an empty snapshot clears everything (no stale edits survive).
const clearing = new TerrainEdits({ bounds: BOUNDS, heightGrid: ODD_H, colorGrid: ODD_C });
clearing.importJSON(snap);
check(clearing.hasHeightEdits, 'clear fixture did not load edits');
const cleared = clearing.importJSON(new TerrainEdits({ bounds: BOUNDS }).exportJSON());
check(cleared.heightCells === 0 && cleared.colorPixels === 0, 'empty import did not clear counts');
check(clearing.hasHeightEdits === false && clearing.hasColorEdits === false,
  'empty import left stale flags');
check(clearing.sampleHeightDelta(0, 0) === 0, 'empty import left height data behind');
equalArrays(clearing.getColorPixel(4, 4), [128, 128, 128, 128], 'empty import left colour data behind');

const malformed = new TerrainEdits({ bounds: BOUNDS, heightGrid: ODD_H, colorGrid: ODD_C });
check(malformed.importJSON(null).heightCells === 0, 'importJSON(null) did not return an empty result');
check(malformed.importJSON({ h: [1], c: [0, 1] }).heightCells === 0,
  'importJSON accepted truncated sparse arrays');
check(malformed.hasHeightEdits === false, 'malformed import left height edits behind');

// Storage / fetch stay headless-safe and never throw.
check(typeof exportable.saveToLocalStorage() === 'boolean', 'saveToLocalStorage did not return a boolean');
check(typeof exportable.loadFromLocalStorage() === 'boolean', 'loadFromLocalStorage did not return a boolean');
if (typeof localStorage === 'undefined') {
  check(exportable.saveToLocalStorage('falcon.test.edits') === false,
    'saveToLocalStorage claimed success without localStorage');
  check(exportable.loadFromLocalStorage('falcon.test.edits') === false,
    'loadFromLocalStorage claimed success without localStorage');
}
const fetched = await TerrainEdits.fetchProjectEdits('./media/definitely-not-here.json');
check(fetched === null, 'fetchProjectEdits did not return null for a missing file');

// clearAll resets everything, including the texture flag.
const clearable = new TerrainEdits({ bounds: BOUNDS, heightGrid: ODD_H, colorGrid: ODD_C });
const clearTex = clearable.createColorTexture();
clearable.applyHeightBrush({ mode: 'raise', x: 0, z: 0, radius: 300, strength: 1, dt: 0.05 });
clearable.beginStroke('height');
clearable.applyHeightBrush({ mode: 'raise', x: 0, z: 0, radius: 300, strength: 1, dt: 0.05 });
clearable.endStroke();
clearable.applyColorBrush({ mode: 'karst_stone', x: 0, z: 0, radius: 300, strength: 1, dt: 0.1 });
const clearVer = clearTex.version;
clearable.clearAll();
check(clearable.hasHeightEdits === false && clearable.heightCount === 0
  && clearable.hasColorEdits === false && clearable.colorCount === 0,
  'clearAll left edit flags behind');
check(clearable.undoCount === 0 && clearable.canUndo() === false, 'clearAll left the undo stack');
check(clearable.sampleHeightDelta(0, 0) === 0, 'clearAll left height data behind');
equalArrays(clearable.getColorPixel(4, 4), [128, 128, 128, 128], 'clearAll left colour data behind');
check(clearTex.version > clearVer, 'clearAll did not mark the colour texture dirty');

// ---------------------------------------------------------------------------
// 7. terrain.js singleton hook
// ---------------------------------------------------------------------------
check(typeof sampleActiveHeightDelta === 'function', 'sampleActiveHeightDelta is not exported');
check(sampleActiveHeightDelta(0, 0) === 0, 'active delta is nonzero with no edits installed');

// Find a point no airport pad can reach, so terrainHeight is purely base + delta.
let site = null;
for (let x = -40000; x <= 40000 && !site; x += 5000) {
  for (let z = -40000; z <= 40000; z += 5000) {
    if (airportNear(x, z, 9000) === null) { site = { x, z }; break; }
  }
}
check(!!site, 'could not find an airport-free probe site');

setActiveDEM(null);
setCustomAirports(null);
const hBase = terrainHeight(site.x, site.z);

const live = new TerrainEdits({ heightGrid: 513, colorGrid: 513 });
const liveRes = live.applyHeightBrush({
  mode: 'raise', x: site.x, z: site.z, radius: 2000, strength: 1, dt: 0.05,
});
check(liveRes.changed === true, 'installed brush reported no change');
const deltaAtSite = live.sampleHeightDelta(site.x, site.z);
check(deltaAtSite > 0.4, `installed brush painted too little (${deltaAtSite})`);

check(setActiveTerrainEdits(live) === live, 'setActiveTerrainEdits did not return the edits');
check(getActiveTerrainEdits() === live, 'getActiveTerrainEdits did not return the installed edits');
near(terrainHeight(site.x, site.z), hBase + deltaAtSite, 1e-6,
  'terrainHeight did not apply the painted height delta');
near(terrainHeight(site.x, site.z) - hBase, deltaAtSite, 1e-6,
  'terrainHeight delta does not match sampleHeightDelta');
check(terrainHeight(site.x + 40000, site.z - 40000) !== undefined, 'terrainHeight broke far away');
const farX = site.x + 30000;
const hFarBase = (() => {
  setActiveTerrainEdits(null);
  const h = terrainHeight(farX, site.z);
  setActiveTerrainEdits(live);
  return h;
})();
check(terrainHeight(farX, site.z) === hFarBase,
  'terrainHeight changed far outside the painted area');

// Removing the edits restores the exact base height.
check(setActiveTerrainEdits(null) === null, 'setActiveTerrainEdits(null) did not clear');
check(getActiveTerrainEdits() === null, 'getActiveTerrainEdits still returns edits after clearing');
check(terrainHeight(site.x, site.z) === hBase,
  'terrainHeight did not restore the exact base height');
check(terrainHeight(site.x, site.z) === baseHeight(site.x, site.z),
  'restored terrainHeight is not the raw base height at the probe site');

// Painted deltas also survive an airport pad: the pad still wins locally.
const padAirports = setCustomAirports([{
  id: 'TEST', code: 'TEST', name: 'Probe Strip', heading: 90,
  length: 1800, width: 36, x: site.x, z: site.z, elevation: 50,
}]);
check(!!padAirports, 'could not install a probe airport');
setActiveTerrainEdits(live);
near(terrainHeight(site.x, site.z), 50, 1e-6,
  'airport flattening no longer overrides painted height');
setActiveTerrainEdits(null);
setCustomAirports(null);
check(terrainHeight(site.x, site.z) === hBase,
  'clearing edits + airports did not restore the base height');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Terrain & colour paint edits — acceptance test');
console.log('=============================================');
console.log(`raise centre     : ${exportCentreDelta.toFixed(2)} m, ` +
  `${exportable.heightCount} cells, ${exportable.colorCount} colour pixels`);
console.log(`desaturate       : [${neonPx}] from neutral 128`);
console.log(`checks: ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.log('  - ' + f);
  if (failures.length > 30) console.log(`  ... and ${failures.length - 30} more`);
  process.exitCode = 1;
} else {
  console.log('\nALL TERRAIN EDIT CHECKS PASSED');
}