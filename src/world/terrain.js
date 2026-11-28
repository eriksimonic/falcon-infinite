// Analytic world terrain. The same functions drive rendering, physics,
// city placement and airport flattening, so everything agrees exactly.
import {
  fbm, fbm01, ridged01, noise2, smoothstep, clamp, hash2, hashU32, mulberry32,
} from './noise.js';
import {
  sampleActiveHeightDelta, setActiveTerrainEdits, getActiveTerrainEdits,
} from './terrain_edits.js';

// Painted terrain edits are opt-in; with nothing installed the delta is 0 and
// every height below is bit-identical to the unedited world.
export { setActiveTerrainEdits, getActiveTerrainEdits };

export const SEA_LEVEL = 0;
export const AIRPORT_GRID = 16384; // one candidate airport per 16.4 km cell
export const MAX_TERRAIN_HEIGHT = 2400;

// ---------------------------------------------------------------------------
// Base landform (no airports)
// ---------------------------------------------------------------------------
function proceduralBaseHeight(x, z) {
  // Large-scale domain warp makes coastlines and ranges feel organic.
  const wx = x + 4200 * noise2(x * 0.000010, z * 0.000010, 911);
  const wz = z + 4200 * noise2(x * 0.000010 + 7.3, z * 0.000010 - 2.1, 917);

  // Continents: ~90 km features, biased so roughly 2/3 of the world is land.
  const c = fbm01(wx * 0.0000105, wz * 0.0000105, 5, 101);
  let h = (c - 0.38) * 1900;

  // Coastal shelf shaping: deep ocean, gentle beaches.
  if (h < 0) {
    h = -Math.pow(-h, 1.22) * 1.35;
    h = Math.max(h, -900);
  } else {
    h = Math.pow(h, 1.05);
  }

  // Mountain belts: masked ridged noise.
  const belt = smoothstep(0.18, 0.62, fbm01(wx * 0.000022, wz * 0.000022, 4, 211));
  const ridge = ridged01(wx * 0.000058, wz * 0.000058, 5, 307);
  h += ridge * ridge * 1750 * belt;

  // Foothills, hills, fine detail.
  h += fbm(wx * 0.00013, wz * 0.00013, 4, 401) * 120;
  h += fbm(x * 0.00062, z * 0.00062, 4, 503) * 26;
  h += fbm(x * 0.0028, z * 0.0028, 3, 607) * 4.2;
  h += fbm(x * 0.011, z * 0.011, 2, 709) * 0.65;

  // Smooth valley floors a touch so lowlands are habitable.
  if (h > 0 && h < 140) h *= 0.94;
  return h;
}

// ---------------------------------------------------------------------------
// Optional baked DEM (real-world theater, e.g. Vipava Valley).
//
// When no DEM is active `baseHeight` is a direct call to the procedural
// landform, so existing theaters stay bit-identical. When a DEM is active the
// real elevation is blended in, fading smoothly to the procedural world at the
// data edge (the DEM owns blendWeight).
// ---------------------------------------------------------------------------
let _activeDEM = null;

/** Activate a HeightmapDEM, or pass null to restore procedural terrain. */
export function setActiveDEM(dem) {
  _activeDEM = dem || null;
}

/** Currently active HeightmapDEM (or null). */
export function getActiveDEM() {
  return _activeDEM;
}

export function baseHeight(x, z) {
  const dem = _activeDEM;
  if (dem === null) return proceduralBaseHeight(x, z);

  // Three-tier DEM stack (HD inset -> regional bake -> 500 km macro bake ->
  // live z=9 Terrarium tiles). The DEM resolves the whole chain and reports
  // how much of the result is real data, so procedural terrain only fills the
  // gaps: open ocean far from every bake, or an offline run past the ring.
  if (typeof dem.sampleWithFallback === 'function') {
    const res = dem.sampleWithFallback(x, z);
    if (res) {
      const h = res.height;
      const w = res.weight;
      if (h !== null && h !== undefined) {
        if (w >= 0.9999) return h;
        if (w > 0) return h * w + proceduralBaseHeight(x, z) * (1 - w);
      }
    }
    return proceduralBaseHeight(x, z);
  }

  // Legacy path for custom/mock DEMs without the resolver.
  const w = dem.blendWeight(x, z);
  if (w > 0) {
    const demH = dem.sample(x, z);
    if (demH !== null && demH !== undefined) {
      if (w >= 0.9999) return demH;
      return demH * w + proceduralBaseHeight(x, z) * (1 - w);
    }
  }
  return proceduralBaseHeight(x, z);
}

export function terrainNormal(x, z, out) {
  const e = 12;
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  if (out) return out.set(-hx, 2 * e, -hz).normalize();
  return { x: -hx, y: 2 * e, z: -hz };
}

export function slopeAt(x, z) {
  const e = 25;
  const hx = baseHeight(x + e, z) - baseHeight(x - e, z);
  const hz = baseHeight(x, z + e) - baseHeight(x, z - e);
  return Math.hypot(hx, hz) / (2 * e);
}

export function isWater(x, z) {
  return terrainHeight(x, z) < SEA_LEVEL - 1;
}

// ---------------------------------------------------------------------------
// Airports: deterministic candidate in each 16 km cell, terrain flattened
// under the airport pad so runways are level.
// ---------------------------------------------------------------------------
const airportCache = new Map();
const NAME_A = ['Kal', 'Nor', 'Ash', 'Val', 'Bran', 'Cor', 'Dra', 'El', 'Fen', 'Gal',
  'Har', 'Il', 'Jor', 'Kes', 'Lom', 'Mar', 'Nev', 'Or', 'Pel', 'Quen', 'Rav',
  'Sel', 'Tor', 'Ul', 'Vor', 'Wes', 'Yar', 'Zel', 'Ald', 'Bel', 'Cas', 'Dun',
  'Esk', 'Fal', 'Glen', 'Hav', 'Isl', 'Jar', 'Kel', 'Lin', 'Mor', 'Nyx', 'Ost'];
const NAME_B = ['ton', 'vale', 'ford', 'mere', 'burg', 'field', 'haven', 'ridge',
  'crest', 'dale', 'moor', 'port', 'stead', 'wick', 'gate', 'holm', 'bury',
  'marsh', 'reach', 'watch', 'spire', 'fall', 'glen', 'brook'];

function makeName(rng) {
  const a = NAME_A[Math.floor(rng() * NAME_A.length)];
  const b = NAME_B[Math.floor(rng() * NAME_B.length)];
  return a + b;
}

function airportSiteScore(x, z) {
  const h = baseHeight(x, z);
  if (h < 4) return -1e9;
  const s = slopeAt(x, z);
  // Prefer flat, low, temperate ground; reward larger contiguous flats.
  let score = -s * 9000 - Math.abs(h - 110) * 1.6;
  if (h > 650) score -= (h - 650) * 8;
  if (s > 0.22) score -= (s - 0.22) * 30000;
  return score;
}

/**
 * Airport in a 16 km cell, or null. Cached and fully deterministic.
 */
export function airportAtCell(cx, cz) {
  const key = cx + ',' + cz;
  if (airportCache.has(key)) return airportCache.get(key);
  const result = buildAirport(cx, cz);
  if (airportCache.size > 4096) airportCache.clear();
  airportCache.set(key, result);
  return result;
}

function buildAirport(cx, cz) {
  const hb = hashU32(cx, cz, 7331);
  const forced = cx === 0 && cz === 0;
  const chance = ((hb >>> 8) & 1023) / 1023;
  if (!forced && chance > 0.52) return null;

  const rng = mulberry32(hb ^ 0x9e3779b9);
  // Scan 7x7 candidate points in the inner 62% of the cell.
  let best = null;
  let bestScore = -Infinity;
  for (let ix = -3; ix <= 3; ix++) {
    for (let iz = -3; iz <= 3; iz++) {
      const x = cx * AIRPORT_GRID + ix * 1300 + (rng() - 0.5) * 900;
      const z = cz * AIRPORT_GRID + iz * 1300 + (rng() - 0.5) * 900;
      const s = airportSiteScore(x, z) + rng() * 120;
      if (s > bestScore) {
        bestScore = s;
        best = { x, z };
      }
    }
  }
  if (!best || bestScore < -1e8) return null;

  const elevation = baseHeight(best.x, best.z);
  if (elevation < 4) return null;

  const kindRoll = rng();
  const kind = kindRoll > 0.86 ? 'international' : kindRoll > 0.45 ? 'regional' : 'airfield';
  const length = kind === 'international' ? 3000 + Math.floor(rng() * 500)
    : kind === 'regional' ? 2100 + Math.floor(rng() * 500)
      : 1250 + Math.floor(rng() * 450);
  const width = kind === 'airfield' ? 30 : 45;
  const padRadius = Math.max(1150, length * 0.62 + 420);
  const name = makeName(rng);
  const suffix = kind === 'international' ? 'International' : kind === 'regional' ? 'Regional' : 'Airfield';
  const code = (name.slice(0, 2) + makeName(rng).slice(0, 2)).toUpperCase();

  return {
    id: cx + ':' + cz,
    name: name + ' ' + suffix,
    code,
    kind,
    cx, cz,
    x: best.x,
    z: best.z,
    elevation,
    heading: Math.floor(rng() * 180), // 0..179 degrees
    length,
    width,
    padRadius,
    blend: padRadius * 1.7,
  };
}

// ---------------------------------------------------------------------------
// Real-world airports (baked theater metadata).
//
// A baked theater hands us the actual fields instead of the procedural grid.
// While a custom set is active every query (airportsNear / airportNear /
// terrainHeight) answers from it alone, so no invented runway lands in the
// real valley. setCustomAirports(null) restores the procedural world exactly.
// ---------------------------------------------------------------------------
let _customAirports = null;

/**
 * Install a baked airport list (or null to restore procedural airports).
 *
 * Each entry is normalised to the same shape `buildAirport` produces for the
 * procedural grid, with its own pad/blend radii derived from runway length.
 *
 * @param {Array<object>|null} list
 * @returns {Array<object>|null} the normalised list, or null
 */
export function setCustomAirports(list) {
  if (!Array.isArray(list) || list.length === 0) {
    _customAirports = null;
    return null;
  }
  _customAirports = list.map((ap) => {
    const length = Number(ap.length) || 0;
    return {
      id: ap.id ?? ap.code,
      code: ap.code ?? ap.id,
      name: ap.name || '',
      x: Number(ap.x) || 0,
      z: Number(ap.z) || 0,
      // Sea-level fields still need a solid pad above the water plane.
      elevation: Math.max(3, Number(ap.elevation) || 0),
      heading: Number(ap.heading) || 0,
      length,
      width: Number(ap.width) || 45,
      padRadius: length * 0.5 + 140,
      blend: length * 0.5 + 320,
      kind: length >= 2400 ? 'intl' : 'regional',
    };
  });
  return _customAirports;
}

/** Currently installed baked airports, or null for the procedural grid. */
export function getCustomAirports() {
  return _customAirports;
}

export function airportsNear(x, z, cellRadius = 1) {
  if (_customAirports !== null) {
    // One extra cell of slack so a field just past the camera's cell edge
    // still shows up (the demo box is only 100 km across).
    const reach = (cellRadius + 1) * AIRPORT_GRID;
    const out = [];
    for (const ap of _customAirports) {
      const dx = ap.x - x;
      const dz = ap.z - z;
      if (dx * dx + dz * dz <= reach * reach) out.push(ap);
    }
    return out;
  }
  const cx = Math.floor(x / AIRPORT_GRID);
  const cz = Math.floor(z / AIRPORT_GRID);
  const out = [];
  for (let dx = -cellRadius; dx <= cellRadius; dx++) {
    for (let dz = -cellRadius; dz <= cellRadius; dz++) {
      const ap = airportAtCell(cx + dx, cz + dz);
      if (ap) out.push(ap);
    }
  }
  return out;
}

/** Nearest airport within `maxDist` metres, or null. */
export function airportNear(x, z, maxDist = 30000) {
  if (_customAirports !== null) {
    let best = null;
    let bestD = maxDist * maxDist;
    for (const ap of _customAirports) {
      const dx = ap.x - x;
      const dz = ap.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = ap;
      }
    }
    return best;
  }
  const cellRadius = Math.max(1, Math.ceil(maxDist / AIRPORT_GRID));
  let best = null;
  let bestD = maxDist * maxDist;
  for (const ap of airportsNear(x, z, cellRadius)) {
    const dx = ap.x - x;
    const dz = ap.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = ap;
    }
  }
  return best;
}

/** Terrain height including painted edits and flattened airport pads. */
export function terrainHeight(x, z) {
  let h = baseHeight(x, z) + sampleActiveHeightDelta(x, z);
  if (_customAirports !== null) {
    for (const ap of _customAirports) {
      const d = Math.hypot(x - ap.x, z - ap.z);
      if (d >= ap.blend) continue;
      const t = 1 - smoothstep(ap.padRadius, ap.blend, d);
      h = h + (ap.elevation - h) * t;
    }
    return h;
  }
  const cx = Math.floor(x / AIRPORT_GRID);
  const cz = Math.floor(z / AIRPORT_GRID);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const ap = airportAtCell(cx + dx, cz + dz);
      if (!ap) continue;
      const d = Math.hypot(x - ap.x, z - ap.z);
      if (d >= ap.blend) continue;
      const t = 1 - smoothstep(ap.padRadius, ap.blend, d);
      h = h + (ap.elevation - h) * t;
    }
  }
  return h;
}

/** Deterministic start point on the runway of the origin airport. */
export function spawnPoint() {
  const ap = airportAtCell(0, 0) || airportNear(0, 0, 40000);
  if (!ap) {
    return { x: 0, z: 0, y: baseHeight(0, 0) + 2, heading: 0, airport: null };
  }
  const rad = ap.heading * Math.PI / 180;
  const dirX = Math.sin(rad);
  const dirZ = -Math.cos(rad);
  const back = ap.length * 0.5 - 90;
  const x = ap.x - dirX * back;
  const z = ap.z - dirZ * back;
  return {
    x, z,
    y: ap.elevation + 1.55,
    heading: ap.heading,
    airport: ap,
  };
}

/** Approximate land mask used by vegetation/settlement placement. */
export function landInfo(x, z) {
  const h = terrainHeight(x, z);
  const s = slopeAt(x, z);
  const forest = smoothstep(0.42, 0.72, fbm01(x * 0.00055, z * 0.00055, 3, 1301));
  return { height: h, slope: s, forest, water: h < 0.5 };
}

export function cellSeed(cx, cz, salt = 0) {
  return hashU32(cx, cz, 4242 + salt);
}

// Exposed for tests / tooling.
export function _clearAirportCache() {
  airportCache.clear();
}

export { smoothstep, clamp, hash2, mulberry32 };