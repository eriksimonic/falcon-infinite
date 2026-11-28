// Headless-safe 16-bit RG-encoded digital elevation model.
//
// The baked Vipava Valley dataset is a lossless PNG where every pixel stores a
// 16-bit elevation split across the red (high byte) and green (low byte)
// channels: val = (R << 8) | G, elevation = val / scale + offset.
//
// Feature 37 adds:
//   * arbitrary rectangular world bounds (xMin/xMax/zMin/zMax + blendM),
//   * Catmull-Rom bicubic sampling for grids >= 4x4 (bilinear below),
//   * a nested high-resolution inset DEM blended into the outer mesh,
//   * a compact binary (FBLD v1) building loader.
//
// This module never touches `document` / `Image` at import time, so Node unit
// tests can construct HeightmapDEM from raw pixels. `loadVipavaDEM` is the only
// browser-facing entry point and is safe to call lazily.

const DEFAULT_SIZE_M = 100000;
const DEFAULT_OFFSET = -200;
const DEFAULT_SCALE = 16;
const DEFAULT_BLEND_M = 6000;

export class HeightmapDEM {
  /**
   * @param {object} opts
   * @param {number} opts.width   grid columns
   * @param {number} opts.height  grid rows
   * @param {number} [opts.sizeM] world extent (metres); defaults to the larger
   *        of the rectangular spans, and is only used for `half`.
   * @param {number} [opts.offset] metres added after decoding
   * @param {number} [opts.scale] quantisation scale (metres per step)
   * @param {Uint8Array|Uint8ClampedArray|Float32Array} opts.pixels
   *        RGBA bytes (length width*height*4) or float elevations
   *        (length width*height, metres).
   * @param {number} [opts.xMin] western edge in world metres
   * @param {number} [opts.xMax] eastern edge in world metres
   * @param {number} [opts.zMin] northern edge in world metres
   * @param {number} [opts.zMax] southern edge in world metres
   * @param {number} [opts.blendM] width of the edge fade ramp, metres
   */
  constructor({
    width,
    height,
    sizeM,
    offset = DEFAULT_OFFSET,
    scale = DEFAULT_SCALE,
    pixels,
    xMin,
    xMax,
    zMin,
    zMax,
    blendM = DEFAULT_BLEND_M,
  } = {}) {
    if (!Number.isInteger(width) || width < 2) {
      throw new TypeError('HeightmapDEM: width must be an integer >= 2');
    }
    if (!Number.isInteger(height) || height < 2) {
      throw new TypeError('HeightmapDEM: height must be an integer >= 2');
    }
    if (!Number.isFinite(offset)) {
      throw new TypeError('HeightmapDEM: offset must be a finite number');
    }
    if (!Number.isFinite(scale) || scale === 0) {
      throw new TypeError('HeightmapDEM: scale must be a non-zero number');
    }
    if (!pixels) throw new TypeError('HeightmapDEM: pixels are required');

    const hasBounds = xMin !== undefined || xMax !== undefined
      || zMin !== undefined || zMax !== undefined;
    if (sizeM === undefined && hasBounds) {
      const sx = Number.isFinite(xMax) && Number.isFinite(xMin) ? xMax - xMin : 0;
      const sz = Number.isFinite(zMax) && Number.isFinite(zMin) ? zMax - zMin : 0;
      sizeM = Math.max(sx, sz);
    }
    if (!Number.isFinite(sizeM) || sizeM <= 0) {
      throw new TypeError('HeightmapDEM: sizeM must be a positive number');
    }

    this.width = width;
    this.height = height;
    this.sizeM = sizeM;
    this.offset = offset;
    this.scale = scale;
    this.half = sizeM * 0.5;
    this._w1 = width - 1;
    this._h1 = height - 1;

    // Rectangular world footprint. Omitting the bounds keeps the historical
    // centred-square behaviour, so every existing caller/test is unchanged.
    const h = this.half;
    this.xMin = Number.isFinite(xMin) ? xMin : -h;
    this.xMax = Number.isFinite(xMax) ? xMax : h;
    this.zMin = Number.isFinite(zMin) ? zMin : -h;
    this.zMax = Number.isFinite(zMax) ? zMax : h;
    if (!(this.xMin < this.xMax) || !(this.zMin < this.zMax)) {
      throw new TypeError('HeightmapDEM: bounds must be finite with min < max');
    }
    this.spanX = this.xMax - this.xMin;
    this.spanZ = this.zMax - this.zMin;

    // Edge fade: 1.0 inside the box inset by blendM, smoothstep to 0 at the
    // footprint edge along both axes. Never allowed to eat more than half a
    // span, so a narrow inset still has a flat core.
    const maxBlend = Math.min(this.spanX, this.spanZ) * 0.5;
    this.blendM = Number.isFinite(blendM) && blendM > 0
      ? Math.min(blendM, maxBlend)
      : 0;
    this._innerXMin = this.xMin + this.blendM;
    this._innerXMax = this.xMax - this.blendM;
    this._innerZMin = this.zMin + this.blendM;
    this._innerZMax = this.zMax - this.blendM;

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
    /** Optional nested high-resolution inset (see setDetailDEM). */
    this.detailDEM = null;
    /** Optional coarser parent DEM covering well beyond this footprint. */
    this.outerDEM = null;
    /** Optional live AWS Terrarium streamer for reads past every baked tier. */
    this.streamingDEM = null;
    /** Throttle stamp for background tile requests (see sampleWithFallback). */
    this._streamRequestMs = -Infinity;
  }

  /**
   * Bilinear-bounded bicubic elevation at world (x, z), or null outside the
   * DEM footprint.
   * @returns {number|null} metres
   */
  sample(x, z) {
    if (!(x >= this.xMin && x <= this.xMax && z >= this.zMin && z <= this.zMax)) {
      return null;
    }
    const detail = this.detailDEM;
    if (detail) {
      const hdH = detail.sample(x, z);
      if (hdH !== null) {
        const w = detail.blendWeight(x, z);
        if (w >= 0.9999) return hdH;
        if (w > 0) return hdH * w + this._sampleSelf(x, z) * (1 - w);
      }
    }
    return this._sampleSelf(x, z);
  }

  /**
   * Sample this DEM's own grid (no nesting), Catmull-Rom bicubic when the grid
   * is at least 4x4 and bilinear otherwise. Allocation-free.
   * @returns {number} metres
   */
  _sampleSelf(x, z) {
    const w1 = this._w1;
    const h1 = this._h1;
    let u = ((x - this.xMin) / this.spanX) * w1;
    let v = ((z - this.zMin) / this.spanZ) * h1;
    // Guard against tiny floating-point overshoot at the exact border.
    if (u < 0) u = 0;
    else if (u > w1) u = w1;
    if (v < 0) v = 0;
    else if (v > h1) v = h1;

    const x0 = Math.floor(u);
    const z0 = Math.floor(v);
    const fx = u - x0;
    const fz = v - z0;

    const w = this.width;
    const d = this.data;
    const row0 = z0 * w;
    const row1 = (z0 < h1 ? z0 + 1 : h1) * w;
    const x1 = x0 < w1 ? x0 + 1 : w1;

    if (w < 4 || this.height < 4) {
      // Bilinear fallback: bit-identical to the pre-Feature-37 sampler.
      const h00 = d[row0 + x0];
      const h10 = d[row0 + x1];
      const h01 = d[row1 + x0];
      const h11 = d[row1 + x1];
      const top = h00 + (h10 - h00) * fx;
      const bottom = h01 + (h11 - h01) * fx;
      return top + (bottom - top) * fz;
    }

    // Catmull-Rom bicubic. Neighbours that fall outside the grid are linearly
    // extrapolated from the edge pair (not clamped), so linear ramps stay
    // exact all the way to the footprint border and terrain never flattens
    // against the data edge.
    const xm1 = x0 > 0 ? x0 - 1 : 0;
    const x2 = x0 + 2 < w1 ? x0 + 2 : w1;
    const zm1 = z0 > 0 ? z0 - 1 : 0;
    const zNext = z0 < h1 ? z0 + 1 : h1;
    const z2 = z0 + 2 < h1 ? z0 + 2 : h1;

    const r1 = this._rowCubic(row0, xm1, x0, x1, x2, fx);
    const r2 = this._rowCubic(zNext * w, xm1, x0, x1, x2, fx);
    const r0 = zm1 === z0 ? 2 * r1 - r2
      : this._rowCubic(zm1 * w, xm1, x0, x1, x2, fx);
    const r3 = z2 === zNext ? 2 * r2 - r1
      : this._rowCubic(z2 * w, xm1, x0, x1, x2, fx);

    let val = cubicWeights(fz, r0, r1, r2, r3);

    // Mild clamp to the 2x2 cell so a steep ridge never overshoots into a
    // spike above the surrounding terrain (or a hole below flat sea/runways).
    const h00 = d[row0 + x0];
    const h10 = d[row0 + x1];
    const h01 = d[zNext * w + x0];
    const h11 = d[zNext * w + x1];
    const lo = Math.min(h00, h10, h01, h11);
    const hi = Math.max(h00, h10, h01, h11);
    if (val < lo) val = lo;
    else if (val > hi) val = hi;
    return val;
  }

  /** Cubic interpolation of one grid row across four horizontal neighbours. */
  _rowCubic(base, xm1, x0, x1, x2, fx) {
    const d = this.data;
    const p1 = d[base + x0];
    const p2 = d[base + x1];
    const p0 = xm1 === x0 ? 2 * p1 - p2 : d[base + xm1];
    const p3 = x2 === x1 ? 2 * p2 - p1 : d[base + x2];
    return cubicWeights(fx, p0, p1, p2, p3);
  }

  /**
   * Blend weight for this DEM against its parent/procedural world: 1.0 inside
   * the footprint inset by `blendM`, cubic-smoothstep ramp to 0.0 at the data
   * edge along both axes, so there is never a cliff seam.
   * @returns {number} 0..1
   */
  blendWeight(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    if (x < this.xMin || x > this.xMax || z < this.zMin || z > this.zMax) return 0;

    let dx = 0;
    if (x < this._innerXMin) dx = this._innerXMin - x;
    else if (x > this._innerXMax) dx = x - this._innerXMax;
    let dz = 0;
    if (z < this._innerZMin) dz = this._innerZMin - z;
    else if (z > this._innerZMax) dz = z - this._innerZMax;

    const d = dx > dz ? dx : dz;
    if (d <= 0) return 1;
    const t = this.blendM > 0 ? d / this.blendM : 1;
    if (t >= 1) return 0;
    return 1 - t * t * (3 - 2 * t);
  }

  /**
   * Attach a nested high-resolution inset DEM. Its own footprint must fall
   * inside this DEM; reads inside it are blended by `hdDem.blendWeight`.
   * @param {HeightmapDEM|null} hdDem
   */
  setDetailDEM(hdDem) {
    if (hdDem !== null && !(hdDem instanceof HeightmapDEM)) {
      throw new TypeError('HeightmapDEM: detail DEM must be a HeightmapDEM or null');
    }
    this.detailDEM = hdDem;
    return this;
  }

  /**
   * Attach a coarser parent DEM whose footprint contains this one (the baked
   * 500 x 500 km macro ring). Reads past `blendWeight` 1 use it instead of
   * procedural terrain.
   * @param {HeightmapDEM|null} macroDem
   */
  setOuterDEM(macroDem) {
    if (macroDem !== null && !isSampleableDEM(macroDem)) {
      throw new TypeError('HeightmapDEM: outer DEM must sampleable or null');
    }
    this.outerDEM = macroDem;
    return this;
  }

  /**
   * Attach a live terrarium tile streamer covering the whole planet. Only
   * consulted where no baked tier has data (beyond the macro ring, or inside
   * the macro ring's own edge ramp once a z=9 tile happens to be cached).
   * @param {StreamingTerrariumDEM|null} streamDem
   */
  setStreamingDEM(streamDem) {
    this.streamingDEM = streamDem;
    return this;
  }

  /**
   * Full real-world elevation stack: HD inset -> regional bake -> macro bake
   * -> live streaming tiles, fading into procedural terrain only where no
   * real data exists.
   *
   * @returns {{height: number|null, weight: number}} `weight` is how much of
   *   `height` is real DEM data (0..1); terrain.js mixes in the procedural
   *   landform with `1 - weight`.
   */
  sampleWithFallback(x, z) {
    const w = this.blendWeight(x, z);

    // Fast path: every read inside this DEM's flat core is pure HD/regional.
    if (w >= 0.9999) {
      const h = this.sample(x, z);
      return { height: h, weight: h === null ? 0 : 1 };
    }

    const outer = this.outerDEM;
    const stream = this.streamingDEM;
    let outerH = null;
    let outerW = 0;

    if (outer) {
      const wOuter = outer.blendWeight(x, z);
      if (wOuter >= 0.9999) {
        const oh = outer.sample(x, z);
        if (oh !== null && oh !== undefined) {
          outerH = oh;
          outerW = 1;
        }
      } else if (wOuter > 0) {
        const oh = outer.sample(x, z);
        const sh = stream ? stream.sample(x, z) : null;
        if (oh !== null && oh !== undefined && sh !== null && sh !== undefined) {
          // Both real datasets available: keep the macro data and sharpen its
          // edge ramp with live tiles where they are already cached.
          outerH = oh * wOuter + sh * (1 - wOuter);
          outerW = 1;
        } else if (oh !== null && oh !== undefined) {
          // Offline: hand back the macro height and let its own ramp fade to
          // procedural terrain instead of hard-cutting at the ring border.
          outerH = oh;
          outerW = wOuter;
        }
      }
    }

    if (outerH === null && stream) {
      const sh = stream.sample(x, z);
      if (sh !== null && sh !== undefined && Number.isFinite(sh)) {
        outerH = sh;
        outerW = 1;
      }
    }

    if (outerH === null && stream && typeof stream.requestAround === 'function') {
      this._requestStreamTiles(x, z);
    }

    const selfH = w > 0 ? this.sample(x, z) : null;
    let height = null;
    if (selfH !== null && selfH !== undefined) {
      height = outerH === null ? selfH : selfH * w + outerH * (1 - w);
    } else if (outerH !== null) {
      height = outerH;
    }

    if (height === null) return { height: null, weight: 0 };
    const weight = w + (1 - w) * outerW;
    return { height, weight };
  }

  /**
   * Kick off background z=9 tile fetches near (x, z). Throttled hard: terrain
   * meshing calls this for every vertex, so only a few reads per second may
   * schedule network work. `requestAround` itself dedupes cached/in-flight/
   * failed tiles and caps concurrency.
   */
  _requestStreamTiles(x, z) {
    if (typeof performance === 'undefined' || typeof performance.now !== 'function') return;
    const now = performance.now();
    if (now - this._streamRequestMs < 250) return;
    this._streamRequestMs = now;
    this.streamingDEM.requestAround(x, z, 1);
  }
}

/** Catmull-Rom weights evaluated at t across p0..p3. */
function cubicWeights(t, p0, p1, p2, p3) {
  const t2 = t * t;
  const t3 = t2 * t;
  const w0 = -0.5 * t + t2 - 0.5 * t3;
  const w1 = 1 - 2.5 * t2 + 1.5 * t3;
  const w2 = 0.5 * t + 2 * t2 - 1.5 * t3;
  const w3 = -0.5 * t2 + 0.5 * t3;
  return p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3;
}

/** Structural check for a DEM-like reader (HeightmapDEM or a test mock). */
function isSampleableDEM(dem) {
  return !!dem
    && typeof dem.sample === 'function'
    && typeof dem.blendWeight === 'function';
}

// ---------------------------------------------------------------------------
// Live AWS Terrarium streaming (the tier beyond every baked footprint)
//
// Beyond the baked 500 x 500 km macro ring the world keeps real elevation by
// pulling individual z=9 Terrarium tiles on demand and caching the decoded
// elevations in an LRU. Everything here is headless-safe: nothing touches
// `document` / `Image` / `fetch` at import time, and requestAround() simply
// does nothing in Node.
// ---------------------------------------------------------------------------

const TILE_SIZE = 256;
const TERRAIN_M_PER_DEG_LAT = 111132.92;
const TERRAIN_M_PER_DEG_LON_AT = (lat0) => 111412.84 * Math.cos((lat0 * Math.PI) / 180);
const TERRARIUM_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const TERRARIUM_MAX_CONCURRENT = 4;

/**
 * World metres -> WGS84. Same projection as scripts/bake_vipava.py: +X = east,
 * +Z = south.
 * @returns {{lat: number, lon: number}}
 */
export function worldToLatLon(x, z, lat0 = 45.8878, lon0 = 13.8869) {
  return {
    lat: lat0 - z / TERRAIN_M_PER_DEG_LAT,
    lon: lon0 + x / TERRAIN_M_PER_DEG_LON_AT(lat0),
  };
}

/**
 * WGS84 -> fractional Web Mercator tile coordinates at `zoom`
 * (integer part = tile index, fraction = position inside the tile).
 * @returns {{fx: number, fy: number}}
 */
export function latLonToTileXY(lat, lon, zoom) {
  const n = 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  return {
    fx: ((lon + 180) / 360) * n,
    fy: ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n,
  };
}

/**
 * Fractional Web Mercator tile coordinates -> WGS84. Inverse of
 * `latLonToTileXY`; used for the world bounds of a freshly streamed tile.
 * @returns {{lat: number, lon: number}}
 */
export function tileXYToLatLon(fx, fy, zoom) {
  const n = 2 ** zoom;
  return {
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / n))) * 180) / Math.PI,
    lon: (fx / n) * 360 - 180,
  };
}

/** Terrarium RGB -> metres: (r * 256 + g + b / 256) - 32768. */
export function decodeTerrariumRGB(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/** Bilinear read inside one cached 256x256 tile (local pixel coords). */
function sampleTile(tile, px, py) {
  const { data, width, height } = tile;
  const w1 = width - 1;
  const h1 = height - 1;
  let u = px;
  let v = py;
  if (!(u >= 0)) u = 0;
  else if (u > w1) u = w1;
  if (!(v >= 0)) v = 0;
  else if (v > h1) v = h1;

  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = x0 < w1 ? x0 + 1 : w1;
  const y1 = y0 < h1 ? y0 + 1 : h1;
  const fx = u - x0;
  const fy = v - y0;

  const row0 = y0 * width;
  const row1 = y1 * width;
  const h00 = data[row0 + x0];
  const h10 = data[row0 + x1];
  const h01 = data[row1 + x0];
  const h11 = data[row1 + x1];
  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  return top + (bottom - top) * fy;
}

/**
 * On-demand AWS Terrarium DEM streamer. Samples are synchronous and return
 * `null` until the tile holding that position has been fetched (or injected),
 * so callers can always fall back to coarser baked data offline.
 */
export class StreamingTerrariumDEM {
  /**
   * @param {object} [opts]
   * @param {number} [opts.lat0] projection origin latitude
   * @param {number} [opts.lon0] projection origin longitude
   * @param {number} [opts.zoom] tile zoom (9 -> ~213 m/px at 45.9 deg N)
   * @param {number} [opts.maxTiles] LRU capacity
   * @param {string} [opts.urlTemplate] `{z}/{x}/{y}` placeholders
   * @param {Function|null} [opts.onTileLoaded] tile-ready hook
   */
  constructor({
    lat0 = 45.8878,
    lon0 = 13.8869,
    zoom = 9,
    maxTiles = 64,
    urlTemplate = TERRARIUM_URL,
    onTileLoaded = null,
  } = {}) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.zoom = zoom;
    this.maxTiles = Math.max(1, Math.floor(maxTiles));
    this.urlTemplate = urlTemplate;
    this.onTileLoaded = onTileLoaded;
    this.mPerDegLon = TERRAIN_M_PER_DEG_LON_AT(lat0);

    /** `${zoom}/${tx}/${ty}` -> { data, width, height } ; Map order is the LRU. */
    this.cache = new Map();
    this.inFlight = new Set();
    this.failed = new Set();
    this.active = 0;
    this.maxConcurrent = TERRARIUM_MAX_CONCURRENT;
    this.stats = { requested: 0, loaded: 0, evicted: 0, failed: 0 };
  }

  tileKey(tx, ty, zoom = this.zoom) {
    return `${zoom}/${tx}/${ty}`;
  }

  /** Fractional tile coords of a world position: { lat, lon, fx, fy }. */
  tileAt(x, z) {
    const { lat, lon } = worldToLatLon(x, z, this.lat0, this.lon0);
    const { fx, fy } = latLonToTileXY(lat, lon, this.zoom);
    return { lat, lon, fx, fy };
  }

  /**
   * Elevation (metres) at world (x, z), or null when the covering tile is not
   * cached yet.
   * @returns {number|null}
   */
  sample(x, z) {
    const { fx, fy } = this.tileAt(x, z);
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    const key = this.tileKey(tx, ty);
    const tile = this.cache.get(key);
    if (!tile) return null;
    // LRU touch: re-insert so the oldest untouched tile is evicted first.
    this.cache.delete(key);
    this.cache.set(key, tile);
    return sampleTile(tile, (fx - tx) * tile.width, (fy - ty) * tile.height);
  }

  /**
   * Store a decoded tile (tests and tooling use this to inject synthetic
   * data; the fetch path calls it too). Evicts the oldest tile over capacity.
   * @param {number} tx
   * @param {number} ty
   * @param {Float32Array|number[]} elevations 256*256 metres
   * @param {number} [zoom]
   */
  injectTile(tx, ty, elevations, zoom = this.zoom) {
    const size = TILE_SIZE * TILE_SIZE;
    let data;
    if (elevations instanceof Float32Array) {
      if (elevations.length !== size) {
        throw new TypeError(`StreamingTerrariumDEM: expected ${size} elevations, got ${elevations.length}`);
      }
      data = elevations;
    } else if (Array.isArray(elevations)) {
      if (elevations.length !== size) {
        throw new TypeError(`StreamingTerrariumDEM: expected ${size} elevations, got ${elevations.length}`);
      }
      data = Float32Array.from(elevations);
    } else {
      throw new TypeError('StreamingTerrariumDEM: elevations must be Float32Array or number[]');
    }
    this._store(tx, ty, zoom, data, TILE_SIZE, TILE_SIZE);
    return this;
  }

  _store(tx, ty, zoom, data, width, height) {
    const key = this.tileKey(tx, ty, zoom);
    // Delete first: Map.set on an existing key keeps its old insertion order,
    // which would let a just-refreshed tile be evicted as the "oldest".
    this.cache.delete(key);
    this.cache.set(key, { data, width, height });
    while (this.cache.size > this.maxTiles) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
      this.stats.evicted++;
    }
    return key;
  }

  /** World-metre bounds of one tile (used by the onTileLoaded hook). */
  tileBounds(tx, ty, zoom = this.zoom) {
    const nw = tileXYToLatLon(tx, ty, zoom);
    const se = tileXYToLatLon(tx + 1, ty + 1, zoom);
    return {
      xMin: (nw.lon - this.lon0) * this.mPerDegLon,
      xMax: (se.lon - this.lon0) * this.mPerDegLon,
      zMin: -(nw.lat - this.lat0) * TERRAIN_M_PER_DEG_LAT,
      zMax: -(se.lat - this.lat0) * TERRAIN_M_PER_DEG_LAT,
    };
  }

  /**
   * Fetch the tiles around world (x, z). Never throws — offline, headless and
   * CORS-blocked runs simply record nothing. Cached, in-flight and previously
   * failed tiles are skipped, and at most `maxConcurrent` requests run at once.
   *
   * @returns {string[]} keys of the tiles scheduled by this call
   */
  requestAround(x, z, radiusTiles = 1) {
    const started = [];
    if (typeof fetch !== 'function' || typeof document === 'undefined') return started;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return started;

    const { fx, fy } = this.tileAt(x, z);
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    const r = Math.max(0, Math.min(TERRARIUM_MAX_CONCURRENT, Math.floor(radiusTiles) || 0));
    const n = 2 ** this.zoom;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (this.active >= this.maxConcurrent) return started;
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
        const key = this.tileKey(tx, ty);
        if (this.cache.has(key) || this.inFlight.has(key) || this.failed.has(key)) continue;
        if (this._startFetch(tx, ty, key)) started.push(key);
      }
    }
    return started;
  }

  _startFetch(tx, ty, key) {
    try {
      const url = this.urlTemplate
        .replace('{z}', String(this.zoom))
        .replace('{x}', String(tx))
        .replace('{y}', String(ty));
      this.inFlight.add(key);
      this.active++;
      this.stats.requested++;
      fetch(url, { mode: 'cors' })
        .then((resp) => {
          if (!resp || !resp.ok) {
            throw new Error(`terrarium HTTP ${resp ? resp.status : 'no response'}`);
          }
          return resp.blob();
        })
        .then((blob) => decodeImagePixels(blob))
        .then((img) => {
          const { width, height, pixels } = img;
          const data = new Float32Array(width * height);
          for (let i = 0, p = 0; i < data.length; i++, p += 4) {
            data[i] = decodeTerrariumRGB(pixels[p], pixels[p + 1], pixels[p + 2]);
          }
          this._store(tx, ty, this.zoom, data, width, height);
          this.stats.loaded++;
          this._emitTileLoaded(tx, ty);
        })
        .catch(() => {
          this.failed.add(key);
          this.stats.failed++;
        })
        .finally(() => {
          this.inFlight.delete(key);
          this.active = Math.max(0, this.active - 1);
        });
      return true;
    } catch {
      this.inFlight.delete(key);
      this.active = Math.max(0, this.active - 1);
      this.failed.add(key);
      return false;
    }
  }

  _emitTileLoaded(tx, ty) {
    if (typeof this.onTileLoaded !== 'function') return;
    try {
      this.onTileLoaded({ tx, ty, zoom: this.zoom, ...this.tileBounds(tx, ty) });
    } catch {
      // A bad listener must never break streaming.
    }
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

async function fetchImagePixels(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`DEM: image HTTP ${resp.status} (${url})`);
  const blob = await resp.blob();
  return decodeImagePixels(blob);
}

/**
 * Load the baked Vipava Valley DEM (16-bit RG PNG + metadata JSON), including
 * the nested HD inset when `meta.hd` is present. The promise is cached, so
 * switching back to the theater is instant. A failed/absent HD inset simply
 * falls back to the outer DEM.
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

    // Outer DEM, HD inset and the 500 km macro ring stream in parallel; the
    // HD inset and the macro ring are optional (a missing bake degrades to the
    // tier below instead of breaking boot).
    const hdMeta = meta && meta.hd;
    const hdUrl = hdMeta && typeof hdMeta.url === 'string' ? hdMeta.url : null;
    const macroMeta = meta && meta.macro;
    const macroUrl = macroMeta && typeof macroMeta.url === 'string' ? macroMeta.url : null;
    const [basePixels, hdPixels, macroPixels] = await Promise.all([
      fetchImagePixels(pngUrl),
      hdUrl
        ? fetchImagePixels(hdUrl).catch(() => null)
        : Promise.resolve(null),
      macroUrl
        ? fetchImagePixels(macroUrl).catch(() => null)
        : Promise.resolve(null),
    ]);

    const dem = new HeightmapDEM({
      width: basePixels.width,
      height: basePixels.height,
      sizeM: meta.sizeM ?? DEFAULT_SIZE_M,
      offset: meta.offset ?? DEFAULT_OFFSET,
      scale: meta.scale ?? DEFAULT_SCALE,
      xMin: meta.xMin,
      xMax: meta.xMax,
      zMin: meta.zMin,
      zMax: meta.zMax,
      pixels: basePixels.pixels,
    });
    dem.meta = meta;

    if (hdPixels) {
      try {
        const hdDem = new HeightmapDEM({
          width: hdPixels.width,
          height: hdPixels.height,
          offset: hdMeta.offset ?? dem.offset,
          scale: hdMeta.scale ?? dem.scale,
          xMin: hdMeta.xMin,
          xMax: hdMeta.xMax,
          zMin: hdMeta.zMin,
          zMax: hdMeta.zMax,
          blendM: hdMeta.blendM ?? 1500,
          pixels: hdPixels.pixels,
        });
        hdDem.meta = hdMeta;
        dem.setDetailDEM(hdDem);
      } catch {
        // A malformed inset must never take down the theater; the outer DEM
        // already covers the whole footprint.
        dem.setDetailDEM(null);
      }
    }

    if (macroPixels) {
      try {
        const macroDem = new HeightmapDEM({
          width: macroPixels.width,
          height: macroPixels.height,
          offset: macroMeta.offset ?? dem.offset,
          scale: macroMeta.scale ?? dem.scale,
          xMin: macroMeta.xMin,
          xMax: macroMeta.xMax,
          zMin: macroMeta.zMin,
          zMax: macroMeta.zMax,
          blendM: macroMeta.blendM ?? 20000,
          pixels: macroPixels.pixels,
        });
        macroDem.meta = macroMeta;
        dem.setOuterDEM(macroDem);
      } catch {
        // Missing/corrupt macro bake: fall straight through to streaming.
        dem.setOuterDEM(null);
      }
    }

    // Live AWS Terrarium tiles fill in everything past the macro ring (and
    // sharpen its edge ramp) without blocking boot.
    try {
      dem.setStreamingDEM(new StreamingTerrariumDEM({
        lat0: meta.lat0 ?? 45.8878,
        lon0: meta.lon0 ?? 13.8869,
        zoom: 9,
      }));
    } catch {
      dem.setStreamingDEM(null);
    }

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
 *    landmarks: [{ id, name, kind, x, z, rot, scale?, length?, height? }, ...],
 *    urbanZones: [{ x, z, r, kind? }, ...] }`.
 *
 * The payload is fetched once and cached in memory; any failure (missing file,
 * offline, malformed JSON) resolves to `null` so a theater switch can fall back
 * to the procedural world instead of breaking boot. Failed loads are not
 * cached, so a later switch retries.
 *
 * @param {string} url
 * @returns {Promise<{roads: Array, buildings: Array, landmarks: Array, urbanZones: Array}|null>}
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
        urbanZones: Array.isArray(json.urbanZones) ? json.urbanZones : [],
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

// ---------------------------------------------------------------------------
// Compact binary buildings (FBLD v1)
// ---------------------------------------------------------------------------

const FBLD_MAGIC = 0x46424c44; // 'FBLD'
const FBLD_VERSION = 1;
const FBLD_HEADER_BYTES = 16;
const FBLD_STRIDE = 20;

let _buildingsPromise = null;
let _buildingsData = null;

function asDataView(buffer) {
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  if (ArrayBuffer.isView(buffer)) {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return null;
}

/**
 * Parse the compact `FBLD` v1 building buffer (little-endian).
 *
 * Header (16 bytes): magic 'FBLD', uint32 version, uint32 count, uint32 stride.
 * Record (20 bytes): float32 x, float32 z, uint16 w10, uint16 d10, uint16 h10,
 * int16 rotQ, uint8 kindCode, uint8 roofCode, uint8 tier, uint8 colorSeed.
 *
 * @param {ArrayBuffer|ArrayBufferView} buffer
 * @returns {{count: number, records: Array<number[]>}|null} null when invalid
 */
export function parseBuildingsBinary(buffer) {
  const view = asDataView(buffer);
  if (!view || view.byteLength < FBLD_HEADER_BYTES) return null;
  if (view.getUint32(0, false) !== FBLD_MAGIC) return null;
  if (view.getUint32(4, true) !== FBLD_VERSION) return null;
  const count = view.getUint32(8, true);
  const stride = view.getUint32(12, true);
  if (stride !== FBLD_STRIDE) return null;
  if (view.byteLength < FBLD_HEADER_BYTES + count * stride) return null;

  const records = new Array(count);
  let o = FBLD_HEADER_BYTES;
  for (let i = 0; i < count; i++, o += stride) {
    records[i] = [
      view.getFloat32(o, true),
      view.getFloat32(o + 4, true),
      view.getUint16(o + 8, true) * 0.1,
      view.getUint16(o + 10, true) * 0.1,
      view.getUint16(o + 12, true) * 0.1,
      view.getInt16(o + 14, true) * 0.0001,
      view.getUint8(o + 16),
      view.getUint8(o + 17),
      view.getUint8(o + 18),
      view.getUint8(o + 19),
    ];
  }
  return { count, records };
}

/**
 * Load the compact binary building set for the Vipava theater. The payload is
 * fetched once and cached; any failure (missing file, offline, bad magic)
 * resolves to `null` and is not cached, so a later switch retries.
 *
 * @param {string} url
 * @returns {Promise<{count: number, records: Array<number[]>}|null>}
 */
export async function loadVipavaBuildings(url = './media/vipava_buildings.bin') {
  if (_buildingsData) return _buildingsData;
  if (_buildingsPromise) return _buildingsPromise;

  _buildingsPromise = (async () => {
    try {
      if (typeof fetch !== 'function') throw new Error('fetch is unavailable');
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`buildings HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      const parsed = parseBuildingsBinary(buf);
      if (!parsed) throw new Error('buildings payload is not valid FBLD v1');
      _buildingsData = parsed;
      return parsed;
    } catch {
      return null;
    } finally {
      _buildingsPromise = null;
    }
  })();

  return _buildingsPromise;
}

/** Test / tooling hook: forget the cached building payload. */
export function _resetVipavaBuildingsCache() {
  _buildingsPromise = null;
  _buildingsData = null;
}