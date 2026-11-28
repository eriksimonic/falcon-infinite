// Terrain & colour paint edits for the Vipava theater.
//
// Height edits are a sparse-ish quantised delta grid layered on top of the
// analytic / baked terrain, and colour edits are an RGBA tint grid that a
// terrain material can sample as a DataTexture. Everything here is headless
// Node-safe: no window / document / WebGL is touched, and localStorage /
// fetch are feature-detected before use.
//
// Grid convention: cell (0, 0) sits at the NW corner of `bounds` and cell
// (grid - 1, grid - 1) at the SE corner, so world <-> grid mapping is exact
// at both edges and bilinear sampling never needs to extrapolate.

import * as THREE from 'three';

/** Height quantisation: 1 unit = 0.05 m, so Int16 covers ~ +-1638 m. */
export const HEIGHT_SCALE = 20;

/** Neutral paint value: 1.0x RGB tint and 1.0x saturation. */
export const NEUTRAL = 128;

/** Default edit footprint: the 100 x 100 km Vipava regional map. */
export const DEFAULT_EDIT_BOUNDS = { xMin: -50000, xMax: 50000, zMin: -50000, zMax: 50000 };

const MAX_UNDO = 40;
const Q_MIN = -32768;
const Q_MAX = 32767;

// Colour brush targets, in 0..255 bytes where 128 == 1.0x.
// `rgbMul` softens the RGB pull for modes that should mostly cool things down.
const COLOR_MODES = {
  desaturate: { rgb: [126, 118, 114], a: 58, rgbMul: 0.55 },
  darken: { rgb: [76, 78, 74], a: null },
  lighten: { rgb: [178, 176, 170], a: null },
  deep_forest: { rgb: [92, 104, 86], a: 106 },
  warm_olive: { rgb: [146, 132, 102], a: 96 },
  karst_stone: { rgb: [154, 150, 140], a: 72 },
  erase_color: { rgb: [NEUTRAL, NEUTRAL, NEUTRAL], a: NEUTRAL },
};

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function quantize(metres) {
  const q = Math.round(metres * HEIGHT_SCALE);
  return q < Q_MIN ? Q_MIN : q > Q_MAX ? Q_MAX : q;
}

function lerpByte(from, to, k) {
  if (from === to) return to;
  const v = from + (to - from) * k;
  let r = Math.round(v);
  // A sub-unit pull would otherwise stall one byte short of the target
  // forever, so force at least one byte of progress while the rate is real.
  if (r === from && k >= 0.05) r = from + (to > from ? 1 : -1);
  return clampNum(r, 0, 255);
}

/** Smooth radial falloff: 1 at the brush centre, 0 at (and past) the radius. */
function falloff(d, radius) {
  const t = d / radius;
  if (!(t < 1)) return 0;
  return (1 - t) * (1 - t) * (1 + 2 * t);
}

export class TerrainEdits {
  /**
   * @param {{bounds?: object, heightGrid?: number, colorGrid?: number}} [options]
   */
  constructor(options = {}) {
    const o = options || {};
    const b = o.bounds || DEFAULT_EDIT_BOUNDS;
    this.bounds = {
      xMin: Number(b.xMin),
      xMax: Number(b.xMax),
      zMin: Number(b.zMin),
      zMax: Number(b.zMax),
    };
    if (!(this.bounds.xMax > this.bounds.xMin) || !(this.bounds.zMax > this.bounds.zMin)) {
      this.bounds = { ...DEFAULT_EDIT_BOUNDS };
    }

    this.heightGrid = Math.max(2, Math.floor(Number(o.heightGrid) || 2048));
    this.colorGrid = Math.max(2, Math.floor(Number(o.colorGrid) || 1024));

    this.heightData = new Int16Array(this.heightGrid * this.heightGrid);
    this.colorData = new Uint8Array(this.colorGrid * this.colorGrid * 4).fill(NEUTRAL);

    this.hasHeightEdits = false;
    this.hasColorEdits = false;
    this.heightCount = 0; // non-zero height cells
    this.colorCount = 0; // non-neutral colour pixels

    this.cellSizeX = (this.bounds.xMax - this.bounds.xMin) / (this.heightGrid - 1);
    this.cellSizeZ = (this.bounds.zMax - this.bounds.zMin) / (this.heightGrid - 1);
    this.colorCellSizeX = (this.bounds.xMax - this.bounds.xMin) / (this.colorGrid - 1);
    this.colorCellSizeZ = (this.bounds.zMax - this.bounds.zMin) / (this.colorGrid - 1);

    this.undoStack = [];
    this._stroke = null;
    this._colorTexture = null;
  }

  // -------------------------------------------------------------------------
  // Grid helpers
  // -------------------------------------------------------------------------

  _inBounds(x, z) {
    const b = this.bounds;
    return x >= b.xMin && x <= b.xMax && z >= b.zMin && z <= b.zMax;
  }

  /** Origin of the edit grid in world space. */
  get originX() { return this.bounds.xMin; }
  get originZ() { return this.bounds.zMin; }

  /** Quantised height cell value (Int16 units). */
  _getQ(ix, iz) {
    if (ix < 0 || iz < 0 || ix >= this.heightGrid || iz >= this.heightGrid) return 0;
    return this.heightData[iz * this.heightGrid + ix];
  }

  /** Write a quantised height cell, keeping counts / flags / undo in sync. */
  _setQ(ix, iz, q) {
    if (ix < 0 || iz < 0 || ix >= this.heightGrid || iz >= this.heightGrid) return 0;
    const idx = iz * this.heightGrid + ix;
    const prev = this.heightData[idx];
    if (prev === q) return 0;
    this._recordHeight(idx, prev);
    this.heightData[idx] = q;
    if (prev === 0 && q !== 0) this.heightCount++;
    else if (prev !== 0 && q === 0) this.heightCount--;
    this.hasHeightEdits = this.heightCount > 0;
    return q - prev;
  }

  /** Height delta of one grid cell, in metres. */
  getHeightCell(ix, iz) {
    return this._getQ(ix, iz) / HEIGHT_SCALE;
  }

  /** Set one grid cell's height delta (metres). Returns true if it moved. */
  setHeightCell(ix, iz, metres) {
    if (!Number.isFinite(metres)) return false;
    return this._setQ(ix, iz, quantize(metres)) !== 0;
  }

  _getColorPixelIndex(ix, iz) {
    if (ix < 0 || iz < 0 || ix >= this.colorGrid || iz >= this.colorGrid) return -1;
    return iz * this.colorGrid + ix;
  }

  /** Nearest colour pixel (RGBA, 0..255) as a new array. */
  getColorPixel(ix, iz) {
    const p = this._getColorPixelIndex(ix, iz);
    if (p < 0) return [NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL];
    const o = p * 4;
    return [this.colorData[o], this.colorData[o + 1], this.colorData[o + 2], this.colorData[o + 3]];
  }

  _setColorPixel(ix, iz, r, g, b, a) {
    const p = this._getColorPixelIndex(ix, iz);
    if (p < 0) return false;
    const o = p * 4;
    const d = this.colorData;
    if (d[o] === r && d[o + 1] === g && d[o + 2] === b && d[o + 3] === a) return false;
    const wasNeutral = d[o] === NEUTRAL && d[o + 1] === NEUTRAL && d[o + 2] === NEUTRAL && d[o + 3] === NEUTRAL;
    const isNeutral = r === NEUTRAL && g === NEUTRAL && b === NEUTRAL && a === NEUTRAL;
    this._recordColor(p, d[o], d[o + 1], d[o + 2], d[o + 3]);
    d[o] = r;
    d[o + 1] = g;
    d[o + 2] = b;
    d[o + 3] = a;
    if (wasNeutral && !isNeutral) this.colorCount++;
    else if (!wasNeutral && isNeutral) this.colorCount--;
    this.hasColorEdits = this.colorCount > 0;
    return true;
  }

  /** Nearest colour pixel lookup by world position (neutral outside bounds). */
  sampleColor(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !this._inBounds(x, z)) {
      return [NEUTRAL, NEUTRAL, NEUTRAL, NEUTRAL];
    }
    const c = this.colorGrid;
    const fx = (x - this.bounds.xMin) / this.colorCellSizeX;
    const fz = (z - this.bounds.zMin) / this.colorCellSizeZ;
    const ix = clampNum(Math.round(fx), 0, c - 1);
    const iz = clampNum(Math.round(fz), 0, c - 1);
    return this.getColorPixel(ix, iz);
  }

  // -------------------------------------------------------------------------
  // Height sampling
  // -------------------------------------------------------------------------

  /**
   * Bilinearly interpolated height delta (metres) at a world position.
   * Returns 0 immediately when there is nothing to apply, so unedited worlds
   * stay bit-identical and the hot path costs a boolean check.
   */
  sampleHeightDelta(x, z) {
    if (!this.hasHeightEdits) return 0;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    if (!this._inBounds(x, z)) return 0;

    const n = this.heightGrid;
    const fx = (x - this.bounds.xMin) / this.cellSizeX;
    const fz = (z - this.bounds.zMin) / this.cellSizeZ;
    let gx = Math.floor(fx);
    let gz = Math.floor(fz);
    gx = clampNum(gx, 0, n - 1);
    gz = clampNum(gz, 0, n - 1);
    const tx = clampNum(fx - gx, 0, 1);
    const tz = clampNum(fz - gz, 0, 1);
    const gx1 = Math.min(gx + 1, n - 1);
    const gz1 = Math.min(gz + 1, n - 1);

    const d = this.heightData;
    const q00 = d[gz * n + gx];
    const q10 = d[gz * n + gx1];
    const q01 = d[gz1 * n + gx];
    const q11 = d[gz1 * n + gx1];

    const q0 = q00 + (q10 - q00) * tx;
    const q1 = q01 + (q11 - q01) * tx;
    return (q0 + (q1 - q0) * tz) / HEIGHT_SCALE;
  }

  // -------------------------------------------------------------------------
  // Undo / stroke batching
  // -------------------------------------------------------------------------

  _recordHeight(idx, prev) {
    const s = this._stroke;
    if (!s || s.kind !== 'height' || s.cells.has(idx)) return;
    s.cells.set(idx, prev);
  }

  _recordColor(pixelIndex, r, g, b, a) {
    const s = this._stroke;
    if (!s || s.kind !== 'color' || s.cells.has(pixelIndex)) return;
    // Pack RGBA into one number so a stroke stays compact.
    s.cells.set(pixelIndex, (((r << 24) | (g << 16) | (b << 8) | a) >>> 0));
  }

  /** Start recording sparse before-values for a stroke. */
  beginStroke(kind) {
    if (kind !== 'height' && kind !== 'color') return null;
    this._stroke = { kind, cells: new Map() };
    return this._stroke;
  }

  /** Close the open stroke. Empty strokes are discarded. */
  endStroke() {
    const s = this._stroke;
    this._stroke = null;
    if (!s || s.cells.size === 0) return null;
    if (s.kind === 'height') {
      let minIx = Infinity, maxIx = -Infinity, minIz = Infinity, maxIz = -Infinity;
      const n = this.heightGrid;
      for (const idx of s.cells.keys()) {
        const ix = idx % n;
        const iz = Math.floor(idx / n);
        if (ix < minIx) minIx = ix;
        if (ix > maxIx) maxIx = ix;
        if (iz < minIz) minIz = iz;
        if (iz > maxIz) maxIz = iz;
      }
      s.bounds = this._paddedHeightBounds(minIx, maxIx, minIz, maxIz, 2);
    } else {
      let minIx = Infinity, maxIx = -Infinity, minIz = Infinity, maxIz = -Infinity;
      const n = this.colorGrid;
      for (const idx of s.cells.keys()) {
        const ix = idx % n;
        const iz = Math.floor(idx / n);
        if (ix < minIx) minIx = ix;
        if (ix > maxIx) maxIx = ix;
        if (iz < minIz) minIz = iz;
        if (iz > maxIz) maxIz = iz;
      }
      s.bounds = this._paddedColorBounds(minIx, maxIx, minIz, maxIz, 1);
    }
    this.undoStack.push(s);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    return s;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  get undoCount() {
    return this.undoStack.length;
  }

  /** Restore the last stroke exactly. Returns { kind, bounds } or null. */
  undo() {
    const s = this.undoStack.pop();
    if (!s) return null;
    if (s.kind === 'height') {
      const n = this.heightGrid;
      for (const [idx, prev] of s.cells) {
        const ix = idx % n;
        const iz = Math.floor(idx / n);
        this._setQOutsideStroke(ix, iz, prev);
      }
    } else {
      const d = this.colorData;
      for (const [idx, packed] of s.cells) {
        const o = idx * 4;
        const r = (packed >>> 24) & 255;
        const g = (packed >>> 16) & 255;
        const b = (packed >>> 8) & 255;
        const a = packed & 255;
        const wasNeutral = d[o] === NEUTRAL && d[o + 1] === NEUTRAL
          && d[o + 2] === NEUTRAL && d[o + 3] === NEUTRAL;
        const isNeutral = r === NEUTRAL && g === NEUTRAL && b === NEUTRAL && a === NEUTRAL;
        if (wasNeutral && !isNeutral) this.colorCount++;
        else if (!wasNeutral && isNeutral) this.colorCount--;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = a;
      }
      this.hasColorEdits = this.colorCount > 0;
      if (this._colorTexture) this._colorTexture.needsUpdate = true;
    }
    return { kind: s.kind, bounds: s.bounds ? { ...s.bounds } : null };
  }

  /** Undo writes must never re-enter the (already closed) stroke. */
  _setQOutsideStroke(ix, iz, q) {
    const idx = iz * this.heightGrid + ix;
    const prev = this.heightData[idx];
    if (prev === q) return;
    this.heightData[idx] = q;
    if (prev === 0 && q !== 0) this.heightCount++;
    else if (prev !== 0 && q === 0) this.heightCount--;
    this.hasHeightEdits = this.heightCount > 0;
  }

  // -------------------------------------------------------------------------
  // Bounds bookkeeping
  // -------------------------------------------------------------------------

  _paddedHeightBounds(minIx, maxIx, minIz, maxIz, pad) {
    const b = this.bounds;
    const p = Math.max(0, pad | 0);
    return {
      xMin: Math.max(b.xMin, b.xMin + (minIx - p) * this.cellSizeX),
      xMax: Math.min(b.xMax, b.xMin + (maxIx + p) * this.cellSizeX),
      zMin: Math.max(b.zMin, b.zMin + (minIz - p) * this.cellSizeZ),
      zMax: Math.min(b.zMax, b.zMin + (maxIz + p) * this.cellSizeZ),
    };
  }

  _paddedColorBounds(minIx, maxIx, minIz, maxIz, pad) {
    const b = this.bounds;
    const p = Math.max(0, pad | 0);
    return {
      xMin: Math.max(b.xMin, b.xMin + (minIx - p) * this.colorCellSizeX),
      xMax: Math.min(b.xMax, b.xMin + (maxIx + p) * this.colorCellSizeX),
      zMin: Math.max(b.zMin, b.zMin + (minIz - p) * this.colorCellSizeZ),
      zMax: Math.min(b.zMax, b.zMin + (maxIz + p) * this.colorCellSizeZ),
    };
  }

  // -------------------------------------------------------------------------
  // Height brush
  // -------------------------------------------------------------------------

  /**
   * Sculpt the height delta grid around (x, z).
   *
   * @param {object} opts
   * @param {'raise'|'lower'|'flatten'|'smooth'|'erase_height'} opts.mode
   * @returns {{changed: boolean, bounds: object|null}}
   */
  applyHeightBrush(opts = {}) {
    const {
      mode, x, z, radius,
      strength = 1,
      dt = 0.05,
      targetY = null,
      baseHeightAt = null,
    } = opts || {};

    const none = { changed: false, bounds: null };
    if (!Number.isFinite(x) || !Number.isFinite(z)) return none;
    if (!Number.isFinite(radius) || radius <= 0) return none;
    if (!Number.isFinite(strength) || !Number.isFinite(dt) || dt <= 0) return none;
    if (mode !== 'raise' && mode !== 'lower' && mode !== 'flatten'
      && mode !== 'smooth' && mode !== 'erase_height') return none;
    if (!this._inBounds(x, z)) return none;

    const n = this.heightGrid;
    const cx = this.cellSizeX;
    const cz = this.cellSizeZ;
    const spanX = radius / cx;
    const spanZ = radius / cz;
    const fx = (x - this.bounds.xMin) / cx;
    const fz = (z - this.bounds.zMin) / cz;
    const ix0 = Math.max(0, Math.floor(fx - spanX) - 1);
    const ix1 = Math.min(n - 1, Math.ceil(fx + spanX) + 1);
    const iz0 = Math.max(0, Math.floor(fz - spanZ) - 1);
    const iz1 = Math.min(n - 1, Math.ceil(fz + spanZ) + 1);

    const updates = [];
    let minIx = Infinity, maxIx = -Infinity, minIz = Infinity, maxIz = -Infinity;

    for (let iz = iz0; iz <= iz1; iz++) {
      const wz = this.bounds.zMin + iz * cz;
      const dz = wz - z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = this.bounds.xMin + ix * cx;
        const dx = wx - x;
        const d = Math.hypot(dx, dz);
        const w = falloff(d, radius);
        if (w <= 0) continue;

        const curQ = this._getQ(ix, iz);
        const cur = curQ / HEIGHT_SCALE;
        let next = cur;
        let goal = null; // where this cell is heading (for sub-quantum snapping)
        if (mode === 'raise') {
          next = cur + strength * 12 * dt * w;
        } else if (mode === 'lower') {
          next = cur - strength * 12 * dt * w;
        } else if (mode === 'flatten') {
          const k = clampNum(strength * 6 * dt * w, 0, 1);
          const base = typeof baseHeightAt === 'function'
            ? (Number(baseHeightAt(wx, wz)) || 0) : 0;
          const total = base + cur;
          const goalY = Number.isFinite(targetY) ? targetY : total;
          next = (total + (goalY - total) * k) - base;
          goal = goalY - base;
        } else if (mode === 'smooth') {
          const k = clampNum(strength * 5 * dt * w, 0, 0.85);
          const nz0 = Math.max(0, iz - 1);
          const nz1 = Math.min(n - 1, iz + 1);
          const avg = (
            this._getQ(ix === 0 ? ix : ix - 1, iz) +
            this._getQ(ix === n - 1 ? ix : ix + 1, iz) +
            this._getQ(ix, nz0) +
            this._getQ(ix, nz1)
          ) / (4 * HEIGHT_SCALE);
          next = cur + (avg - cur) * k;
          goal = avg;
        } else { // erase_height
          const k = clampNum(strength * 6 * dt * w, 0, 1);
          next = cur + (0 - cur) * k;
          goal = 0;
        }

        let q = quantize(next);
        // Relaxation modes stall a quantum short of their target when the
        // remaining move is smaller than the 5 cm step; nudge them home.
        if (q === curQ && goal !== null) {
          const goalQ = quantize(goal);
          if (goalQ !== curQ) q = curQ + (goalQ > curQ ? 1 : -1);
        }
        if (q === curQ) continue;
        updates.push(ix, iz, q);
        if (ix < minIx) minIx = ix;
        if (ix > maxIx) maxIx = ix;
        if (iz < minIz) minIz = iz;
        if (iz > maxIz) maxIz = iz;
      }
    }

    if (updates.length === 0) return none;
    for (let i = 0; i < updates.length; i += 3) {
      this._setQ(updates[i], updates[i + 1], updates[i + 2]);
    }

    return {
      changed: true,
      bounds: this._paddedHeightBounds(minIx, maxIx, minIz, maxIz, 2),
    };
  }

  // -------------------------------------------------------------------------
  // Colour / vegetation brush
  // -------------------------------------------------------------------------

  /**
   * Paint the colour tint grid around (x, z).
   *
   * @param {object} opts
   * @param {string} opts.mode desaturate | darken | lighten | deep_forest |
   *   warm_olive | karst_stone | custom | erase_color
   * @returns {{changed: boolean, bounds: object|null}}
   */
  applyColorBrush(opts = {}) {
    const { mode, x, z, radius, strength = 1, dt = 0.05, tintRgb = null } = opts || {};

    const none = { changed: false, bounds: null };
    if (!Number.isFinite(x) || !Number.isFinite(z)) return none;
    if (!Number.isFinite(radius) || radius <= 0) return none;
    if (!Number.isFinite(strength) || !Number.isFinite(dt) || dt <= 0) return none;
    if (!this._inBounds(x, z)) return none;

    let def;
    if (mode === 'custom') {
      if (!Array.isArray(tintRgb) || tintRgb.length < 3) return none;
      def = {
        rgb: [clampNum(Math.round(tintRgb[0]), 0, 255),
          clampNum(Math.round(tintRgb[1]), 0, 255),
          clampNum(Math.round(tintRgb[2]), 0, 255)],
        a: tintRgb.length > 3 && Number.isFinite(tintRgb[3])
          ? clampNum(Math.round(tintRgb[3]), 0, 255) : null,
      };
    } else {
      def = COLOR_MODES[mode];
    }
    if (!def) return none;

    const n = this.colorGrid;
    const cx = this.colorCellSizeX;
    const cz = this.colorCellSizeZ;
    const spanX = radius / cx;
    const spanZ = radius / cz;
    const fx = (x - this.bounds.xMin) / cx;
    const fz = (z - this.bounds.zMin) / cz;
    const ix0 = Math.max(0, Math.floor(fx - spanX) - 1);
    const ix1 = Math.min(n - 1, Math.ceil(fx + spanX) + 1);
    const iz0 = Math.max(0, Math.floor(fz - spanZ) - 1);
    const iz1 = Math.min(n - 1, Math.ceil(fz + spanZ) + 1);

    const rgbMul = def.rgbMul ?? 1;
    const updates = [];
    let minIx = Infinity, maxIx = -Infinity, minIz = Infinity, maxIz = -Infinity;

    for (let iz = iz0; iz <= iz1; iz++) {
      const wz = this.bounds.zMin + iz * cz;
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = this.bounds.xMin + ix * cx;
        const d = Math.hypot(wx - x, wz - z);
        const w = falloff(d, radius);
        if (w <= 0) continue;
        const rate = Math.min(1, strength * 3.5 * dt * w);
        if (rate <= 0) continue;

        const p = this._getColorPixelIndex(ix, iz);
        const o = p * 4;
        const cur = this.colorData;
        const kr = rate * rgbMul;
        const nr = lerpByte(cur[o], def.rgb[0], kr);
        const ng = lerpByte(cur[o + 1], def.rgb[1], kr);
        const nb = lerpByte(cur[o + 2], def.rgb[2], kr);
        const na = def.a === null ? cur[o + 3] : lerpByte(cur[o + 3], def.a, rate);
        if (nr === cur[o] && ng === cur[o + 1] && nb === cur[o + 2] && na === cur[o + 3]) continue;

        updates.push(ix, iz, nr, ng, nb, na);
        if (ix < minIx) minIx = ix;
        if (ix > maxIx) maxIx = ix;
        if (iz < minIz) minIz = iz;
        if (iz > maxIz) maxIz = iz;
      }
    }

    if (updates.length === 0) return none;
    for (let i = 0; i < updates.length; i += 6) {
      this._setColorPixel(updates[i], updates[i + 1], updates[i + 2],
        updates[i + 3], updates[i + 4], updates[i + 5]);
    }

    if (this.colorCount > 0) this.hasColorEdits = true;
    this.markColorDirty();
    return {
      changed: true,
      bounds: this._paddedColorBounds(minIx, maxIx, minIz, maxIz, 1),
    };
  }

  // -------------------------------------------------------------------------
  // Colour texture
  // -------------------------------------------------------------------------

  /** Lazily build the RGBA tint texture (created once, reused afterwards). */
  createColorTexture() {
    if (this._colorTexture) return this._colorTexture;
    const tex = new THREE.DataTexture(
      this.colorData,
      this.colorGrid,
      this.colorGrid,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    tex.flipY = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this._colorTexture = tex;
    return tex;
  }

  markColorDirty() {
    if (this._colorTexture) this._colorTexture.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Reset & serialisation
  // -------------------------------------------------------------------------

  clearAll() {
    this.heightData.fill(0);
    this.colorData.fill(NEUTRAL);
    this.heightCount = 0;
    this.colorCount = 0;
    this.hasHeightEdits = false;
    this.hasColorEdits = false;
    this.undoStack.length = 0;
    this._stroke = null;
    this.markColorDirty();
  }

  _recount() {
    let hc = 0;
    const h = this.heightData;
    for (let i = 0; i < h.length; i++) if (h[i] !== 0) hc++;
    this.heightCount = hc;
    this.hasHeightEdits = hc > 0;

    let cc = 0;
    const c = this.colorData;
    for (let i = 0; i < c.length; i += 4) {
      if (c[i] !== NEUTRAL || c[i + 1] !== NEUTRAL || c[i + 2] !== NEUTRAL || c[i + 3] !== NEUTRAL) cc++;
    }
    this.colorCount = cc;
    this.hasColorEdits = cc > 0;
  }

  /** Compact sparse snapshot: [idx, q, idx, q, ...] and [idx, r, g, b, a, ...]. */
  exportJSON() {
    const h = [];
    const hd = this.heightData;
    for (let i = 0; i < hd.length; i++) {
      const q = hd[i];
      if (q !== 0) h.push(i, q);
    }

    const c = [];
    const cd = this.colorData;
    for (let p = 0, o = 0; p < this.colorGrid * this.colorGrid; p++, o += 4) {
      const r = cd[o];
      const g = cd[o + 1];
      const b = cd[o + 2];
      const a = cd[o + 3];
      if (Math.abs(r - NEUTRAL) < 2 && Math.abs(g - NEUTRAL) < 2
        && Math.abs(b - NEUTRAL) < 2 && Math.abs(a - NEUTRAL) < 2) continue;
      c.push(p, r, g, b, a);
    }

    return {
      version: 1,
      bounds: { ...this.bounds },
      heightGrid: this.heightGrid,
      heightScale: HEIGHT_SCALE,
      colorGrid: this.colorGrid,
      h,
      c,
    };
  }

  /**
   * Load a sparse snapshot (from exportJSON, a project file, or storage).
   * Clears previous edits first. Grid sizes may differ; cells are resampled.
   */
  importJSON(obj) {
    const result = { heightCells: 0, colorPixels: 0 };
    if (!obj || typeof obj !== 'object') return result;

    const srcH = Array.isArray(obj.h) ? obj.h : [];
    const srcC = Array.isArray(obj.c) ? obj.c : [];
    const srcGrid = Math.max(2, Math.floor(Number(obj.heightGrid) || this.heightGrid));
    const srcColorGrid = Math.max(2, Math.floor(Number(obj.colorGrid) || this.colorGrid));
    const srcScale = Number(obj.heightScale) > 0 ? Number(obj.heightScale) : HEIGHT_SCALE;

    const sb = obj.bounds;
    const srcBounds = sb && Number(sb.xMax) > Number(sb.xMin) && Number(sb.zMax) > Number(sb.zMin)
      ? {
        xMin: Number(sb.xMin), xMax: Number(sb.xMax),
        zMin: Number(sb.zMin), zMax: Number(sb.zMax),
      }
      : { ...this.bounds };
    const b = this.bounds;
    const sameBounds = srcBounds.xMin === b.xMin && srcBounds.xMax === b.xMax
      && srcBounds.zMin === b.zMin && srcBounds.zMax === b.zMax;

    this.heightData.fill(0);
    this.colorData.fill(NEUTRAL);
    this.undoStack.length = 0;
    this._stroke = null;

    const n = this.heightGrid;
    const hd = this.heightData;
    const sameH = srcGrid === n && sameBounds;
    const srcCellX = (srcBounds.xMax - srcBounds.xMin) / (srcGrid - 1);
    const srcCellZ = (srcBounds.zMax - srcBounds.zMin) / (srcGrid - 1);

    for (let i = 0; i + 1 < srcH.length; i += 2) {
      const srcIdx = srcH[i] | 0;
      const q = Number(srcH[i + 1]) | 0;
      if (!q) continue;
      let ix;
      let iz;
      if (sameH) {
        if (srcIdx < 0 || srcIdx >= n * n) continue;
        ix = srcIdx % n;
        iz = Math.floor(srcIdx / n);
      } else {
        if (srcIdx < 0 || srcIdx >= srcGrid * srcGrid) continue;
        const sx = srcIdx % srcGrid;
        const sz = Math.floor(srcIdx / srcGrid);
        const wx = srcBounds.xMin + sx * srcCellX;
        const wz = srcBounds.zMin + sz * srcCellZ;
        ix = clampNum(Math.round((wx - b.xMin) / this.cellSizeX), 0, n - 1);
        iz = clampNum(Math.round((wz - b.zMin) / this.cellSizeZ), 0, n - 1);
      }
      hd[iz * n + ix] = quantize(q / srcScale);
    }

    const cn = this.colorGrid;
    const cd = this.colorData;
    const sameC = srcColorGrid === cn && sameBounds;
    const srcColorX = (srcBounds.xMax - srcBounds.xMin) / (srcColorGrid - 1);
    const srcColorZ = (srcBounds.zMax - srcBounds.zMin) / (srcColorGrid - 1);

    for (let i = 0; i + 4 < srcC.length; i += 5) {
      const srcIdx = srcC[i] | 0;
      const r = clampNum(Math.round(Number(srcC[i + 1]) || 0), 0, 255);
      const g = clampNum(Math.round(Number(srcC[i + 2]) || 0), 0, 255);
      const bl = clampNum(Math.round(Number(srcC[i + 3]) || 0), 0, 255);
      const a = clampNum(Math.round(Number(srcC[i + 4]) || 0), 0, 255);
      let ix;
      let iz;
      if (sameC) {
        if (srcIdx < 0 || srcIdx >= cn * cn) continue;
        ix = srcIdx % cn;
        iz = Math.floor(srcIdx / cn);
      } else {
        if (srcIdx < 0 || srcIdx >= srcColorGrid * srcColorGrid) continue;
        const sx = srcIdx % srcColorGrid;
        const sz = Math.floor(srcIdx / srcColorGrid);
        const wx = srcBounds.xMin + sx * srcColorX;
        const wz = srcBounds.zMin + sz * srcColorZ;
        ix = clampNum(Math.round((wx - b.xMin) / this.colorCellSizeX), 0, cn - 1);
        iz = clampNum(Math.round((wz - b.zMin) / this.colorCellSizeZ), 0, cn - 1);
      }
      const o = (iz * cn + ix) * 4;
      cd[o] = r;
      cd[o + 1] = g;
      cd[o + 2] = bl;
      cd[o + 3] = a;
    }

    this._recount();
    this.markColorDirty();
    result.heightCells = this.heightCount;
    result.colorPixels = this.colorCount;
    return result;
  }

  saveToLocalStorage(key = 'falcon.vipava.edits.v1') {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return false;
      localStorage.setItem(key, JSON.stringify(this.exportJSON()));
      return true;
    } catch {
      return false;
    }
  }

  loadFromLocalStorage(key = 'falcon.vipava.edits.v1') {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return false;
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return false;
      this.importJSON(obj);
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch a project edit file. Resolves to null on 404 / offline / Node. */
  static async fetchProjectEdits(url = './media/vipava_edits.json') {
    try {
      if (typeof fetch !== 'function') return null;
      const res = await fetch(url);
      if (!res || !res.ok) return null;
      const json = await res.json();
      return json && typeof json === 'object' ? json : null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Active binding used by terrain.js
// ---------------------------------------------------------------------------

let _activeTerrainEdits = null;

/** Install the edits object whose height deltas terrainHeight() should apply. */
export function setActiveTerrainEdits(edits) {
  _activeTerrainEdits = edits || null;
  return _activeTerrainEdits;
}

/** Currently active edits object, or null. */
export function getActiveTerrainEdits() {
  return _activeTerrainEdits;
}

/** Height delta (metres) from the active edits, or 0 — cheap when inactive. */
export function sampleActiveHeightDelta(x, z) {
  const e = _activeTerrainEdits;
  if (e === null) return 0;
  return e.sampleHeightDelta(x, z);
}