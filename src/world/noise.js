// Deterministic, seeded noise used by every procedural system.
// 2D value noise with integer hashing: fast enough for CPU terrain tiles,
// identical results every run and every machine (no Math.random).

export const SEED = 20261125;

/** 32-bit integer hash of two coordinates. Returns uint32. */
export function hashU32(x, y, seed = 0) {
  let h = (x | 0) * 374761393;
  h = (h + (y | 0) * 668265263) | 0;
  h = (h + (seed | 0) * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash to [0,1). */
export function hash2(x, y, seed = 0) {
  return hashU32(x, y, seed) / 4294967296;
}

/** Hash three integers to [0,1). */
export function hash3(x, y, z, seed = 0) {
  let h = hashU32(x, y, seed);
  h = (h + (z | 0) * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** Value noise in [0,1). */
export function valueNoise(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Signed value noise in [-1,1]. */
export function noise2(x, y, seed = 0) {
  return valueNoise(x, y, seed) * 2 - 1;
}

/** Fractal value noise, normalised to roughly [-1,1]. */
export function fbm(x, y, octaves = 5, seed = 0, lacunarity = 2.0, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Fractal value noise in [0,1], useful for masks. */
export function fbm01(x, y, octaves = 5, seed = 0, lacunarity = 2.0, gain = 0.5) {
  return fbm(x, y, octaves, seed, lacunarity, gain) * 0.5 + 0.5;
}

/** Ridged multifractal in [0,1], sharp mountain crests. */
export function ridged01(x, y, octaves = 4, seed = 0) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * freq, y * freq, seed + i * 7919));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.05;
  }
  return sum / norm;
}

/** Small, fast seeded PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic PRNG for a world cell (2D integer key). */
export function cellRandom(cx, cz, seed = SEED) {
  return mulberry32(hashU32(cx, cz, seed));
}