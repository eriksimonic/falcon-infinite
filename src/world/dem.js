// Headless-safe 16-bit RG-encoded digital elevation model.
//
// The baked Vipava Valley dataset is a lossless PNG where every pixel stores a
// 16-bit elevation split across the red (high byte) and green (low byte)
// channels: val = (R << 8) | G, elevation = val / scale + offset.
//
// This module never touches `document` / `Image` at import time, so Node unit
// tests can construct HeightmapDEM from raw pixels. `loadVipavaDEM` is the only
// browser-facing entry point and is safe to call lazily.

const DEFAULT_SIZE_M = 100000;
const DEFAULT_OFFSET = -200;
const DEFAULT_SCALE = 16;

export class HeightmapDEM {
  /**
   * @param {object} opts
   * @param {number} opts.width   grid columns
   * @param {number} opts.height  grid rows
   * @param {number} [opts.sizeM] world extent (metres), centred on (0, 0)
   * @param {number} [opts.offset] metres added after decoding
   * @param {number} [opts.scale] quantisation scale (metres per step)
   * @param {Uint8Array|Uint8ClampedArray|Float32Array} opts.pixels
   *        RGBA bytes (length width*height*4) or float elevations
   *        (length width*height, metres).
   */
  constructor({
    width,
    height,
    sizeM = DEFAULT_SIZE_M,
    offset = DEFAULT_OFFSET,
    scale = DEFAULT_SCALE,
    pixels,
  } = {}) {
    if (!Number.isInteger(width) || width < 2) {
      throw new TypeError('HeightmapDEM: width must be an integer >= 2');
    }
    if (!Number.isInteger(height) || height < 2) {
      throw new TypeError('HeightmapDEM: height must be an integer >= 2');
    }
    if (!Number.isFinite(sizeM) || sizeM <= 0) {
      throw new TypeError('HeightmapDEM: sizeM must be a positive number');
    }
    if (!Number.isFinite(scale) || scale === 0) {
      throw new TypeError('HeightmapDEM: scale must be a non-zero number');
    }
    if (!Number.isFinite(offset)) {
      throw new TypeError('HeightmapDEM: offset must be a finite number');
    }
    if (!pixels) throw new TypeError('HeightmapDEM: pixels are required');

    this.width = width;
    this.height = height;
    this.sizeM = sizeM;
    this.offset = offset;
    this.scale = scale;
    this.half = sizeM * 0.5;
    this._w1 = width - 1;
    this._h1 = height - 1;
    // 1 inner 88 km, smoothly fading to 0 at the 100 km data edge.
    this._blendInner = this.half - 6000;
    this._blendOuter = this.half;

    const count = width * height;
    this.data = new Float32Array(count);

    if (pixels instanceof Float32Array) {
      if (pixels.length !== count) {
        throw new TypeError(
          `HeightmapDEM: Float32Array length ${pixels.length} != ${count}`,
        );
      }
      this.data.set(pixels);
    } else if (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) {
      if (pixels.length !== count * 4) {
        throw new TypeError(
          `HeightmapDEM: RGBA length ${pixels.length} != ${count * 4}`,
        );
      }
      const invScale = 1 / scale;
      for (let i = 0, p = 0; i < count; i++, p += 4) {
        const val = (pixels[p] << 8) | pixels[p + 1];
        this.data[i] = val * invScale + offset;
      }
    } else {
      throw new TypeError(
        'HeightmapDEM: pixels must be Uint8Array, Uint8ClampedArray or Float32Array',
      );
    }

    /** Optional dataset metadata (filled by loadVipavaDEM). */
    this.meta = null;
  }

  /**
   * Bilinear elevation at world (x, z), or null outside the DEM footprint.
   * @returns {number|null} metres
   */
  sample(x, z) {
    const half = this.half;
    if (!(x >= -half && x <= half && z >= -half && z <= half)) return null;

    const w1 = this._w1;
    const h1 = this._h1;
    let u = (x / this.sizeM + 0.5) * w1;
    let v = (z / this.sizeM + 0.5) * h1;
    // Guard against tiny floating-point overshoot at the exact border.
    if (u < 0) u = 0;
    else if (u > w1) u = w1;
    if (v < 0) v = 0;
    else if (v > h1) v = h1;

    const x0 = Math.floor(u);
    const z0 = Math.floor(v);
    const x1 = x0 < w1 ? x0 + 1 : w1;
    const z1 = z0 < h1 ? z0 + 1 : h1;
    const fx = u - x0;
    const fz = v - z0;

    const w = this.width;
    const d = this.data;
    const row0 = z0 * w;
    const row1 = z1 * w;

    const h00 = d[row0 + x0];
    const h10 = d[row0 + x1];
    const h01 = d[row1 + x0];
    const h11 = d[row1 + x1];

    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return top + (bottom - top) * fz;
  }

  /**
   * Blend weight for the real DEM against the infinite procedural world.
   * 1.0 inside the inner 88 km box, cubic-smoothstep ramp to 0.0 at the
   * ±50 km data edge, so there is never a cliff seam.
   * @returns {number} 0..1
   */
  blendWeight(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const d = Math.max(Math.abs(x), Math.abs(z));
    const inner = this._blendInner;
    if (d <= inner) return 1;
    const outer = this._blendOuter;
    if (d >= outer) return 0;
    const t = (d - inner) / (outer - inner);
    return 1 - t * t * (3 - 2 * t);
  }
}

// ---------------------------------------------------------------------------
// Browser loading (lazy — nothing here runs at import time)
// ---------------------------------------------------------------------------

let _vipavaPromise = null;

async function decodeImagePixels(blob) {
  let source = null;
  if (typeof createImageBitmap === 'function') {
    try {
      source = await createImageBitmap(blob);
    } catch {
      source = null;
    }
  }
  if (!source) {
    source = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('DEM: failed to decode PNG'));
      };
      img.src = url;
    });
  }

  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('DEM: 2d canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0);
  if (source.close) source.close();
  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, pixels: image.data };
}

/**
 * Load the baked Vipava Valley DEM (16-bit RG PNG + metadata JSON).
 * The promise is cached, so switching back to the theater is instant.
 *
 * @param {string} pngUrl
 * @param {string} metaUrl
 * @returns {Promise<HeightmapDEM>}
 */
export async function loadVipavaDEM(
  pngUrl = './media/vipava_dem.png',
  metaUrl = './media/vipava_meta.json',
) {
  if (_vipavaPromise) return _vipavaPromise;

  _vipavaPromise = (async () => {
    if (typeof fetch !== 'function') {
      throw new Error('loadVipavaDEM: fetch is unavailable');
    }
    const metaResp = await fetch(metaUrl);
    if (!metaResp.ok) {
      throw new Error(`loadVipavaDEM: metadata HTTP ${metaResp.status}`);
    }
    const meta = await metaResp.json();

    const pngResp = await fetch(pngUrl);
    if (!pngResp.ok) {
      throw new Error(`loadVipavaDEM: image HTTP ${pngResp.status}`);
    }
    const blob = await pngResp.blob();
    const { width, height, pixels } = await decodeImagePixels(blob);

    const dem = new HeightmapDEM({
      width,
      height,
      sizeM: meta.sizeM ?? DEFAULT_SIZE_M,
      offset: meta.offset ?? DEFAULT_OFFSET,
      scale: meta.scale ?? DEFAULT_SCALE,
      pixels,
    });
    dem.meta = meta;
    return dem;
  })();

  // Do not cache a failed load — a later theater switch may retry.
  _vipavaPromise.catch(() => {
    _vipavaPromise = null;
  });

  return _vipavaPromise;
}

/** Test / tooling hook: forget the cached DEM promise. */
export function _resetVipavaDEMCache() {
  _vipavaPromise = null;
}

// ---------------------------------------------------------------------------
// Baked OpenStreetMap extract (real Vipava Valley buildings & roads)
// ---------------------------------------------------------------------------

let _osmPromise = null;
let _osmData = null;

/**
 * Load the baked OSM extract for the Vipava theater:
 * `{ roads: [{ w, pts: [[x, z], ...] }], buildings: [[x, z, w, d, h, rot, kindCode], ...],
 *    landmarks: [{ id, name, kind, x, z, rot, scale?, length?, height? }, ...] }`.
 *
 * The payload is fetched once and cached in memory; any failure (missing file,
 * offline, malformed JSON) resolves to `null` so a theater switch can fall back
 * to the procedural world instead of breaking boot. Failed loads are not
 * cached, so a later switch retries.
 *
 * @param {string} url
 * @returns {Promise<{roads: Array, buildings: Array, landmarks: Array}|null>}
 */
export async function loadVipavaOSM(url = './media/vipava_osm.json') {
  if (_osmData) return _osmData;
  if (_osmPromise) return _osmPromise;

  _osmPromise = (async () => {
    try {
      if (typeof fetch !== 'function') throw new Error('fetch is unavailable');
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`OSM HTTP ${resp.status}`);
      const json = await resp.json();
      if (!json || typeof json !== 'object') throw new Error('OSM payload is not an object');
      _osmData = {
        roads: Array.isArray(json.roads) ? json.roads : [],
        buildings: Array.isArray(json.buildings) ? json.buildings : [],
        landmarks: Array.isArray(json.landmarks) ? json.landmarks : [],
      };
      return _osmData;
    } catch {
      return null;
    } finally {
      // Only successful payloads stay cached (assigned above); clear the
      // in-flight promise either way so a failed load can be retried.
      _osmPromise = null;
    }
  })();

  return _osmPromise;
}

/** Test / tooling hook: forget the cached OSM payload. */
export function _resetVipavaOSMCache() {
  _osmPromise = null;
  _osmData = null;
}

// ---------------------------------------------------------------------------
// Baked OpenStreetMap inland water (rivers & lakes)
// ---------------------------------------------------------------------------

let _waterPromise = null;
let _waterData = null;

/**
 * Load the baked OSM inland water extract for the Vipava theater:
 * `{ rivers: [{ w, pts: [[x, z], ...] }], lakes: [[[x, z], ...], ...] }`.
 *
 * The payload is fetched once and cached in memory; any failure (missing file,
 * offline, malformed JSON) resolves to `null` so a theater switch simply shows
 * no inland water instead of breaking boot. Failed loads are not cached.
 *
 * @param {string} url
 * @returns {Promise<{rivers: Array, lakes: Array}|null>}
 */
export async function loadVipavaWater(url = './media/vipava_water.json') {
  if (_waterData) return _waterData;
  if (_waterPromise) return _waterPromise;

  _waterPromise = (async () => {
    try {
      if (typeof fetch !== 'function') throw new Error('fetch is unavailable');
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`water HTTP ${resp.status}`);
      const json = await resp.json();
      if (!json || typeof json !== 'object') throw new Error('water payload is not an object');
      _waterData = {
        rivers: Array.isArray(json.rivers) ? json.rivers : [],
        lakes: Array.isArray(json.lakes) ? json.lakes : [],
      };
      return _waterData;
    } catch {
      return null;
    } finally {
      // Only successful payloads stay cached; clear the in-flight promise so a
      // failed load can be retried after a later theater switch.
      _waterPromise = null;
    }
  })();

  return _waterPromise;
}

/** Test / tooling hook: forget the cached inland water payload. */
export function _resetVipavaWaterCache() {
  _waterPromise = null;
  _waterData = null;
}