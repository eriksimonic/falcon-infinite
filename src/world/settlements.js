// Deterministic procedural settlements for the infinite world.
//
// Everything here is a pure function of the terrain seed, the settlement layer
// and the integer cell coordinates: the same cell always yields the same town,
// the same buildings and the same roads. No Math.random anywhere; the only
// entropy source is mulberry32 seeded from hashU32(cx, cz, layerSalt).
//
// World conventions (see ARCHITECTURE.md): metres, Y up, North = -Z, East = +X.
// Settlements are flat data; the renderer is responsible for meshes and for
// applying `building.y` (terrainHeight at the footprint centre) as the base.
//
// Layout character by layer:
//   metro   - orthogonal street grid with clipped (circular) street ends,
//             avenues every 4-6 blocks, park blocks, tower/apartment core,
//             mid-rise ring, low suburban fringe, industrial edge.
//   town    - one main street with a central plaza, 2 side streets, 1-2 cross
//             streets, low-rise frontage plus a few taller buildings near the
//             plaza and an industrial pair at the edge.
//   village - one main road plus a cross road / parallel lane, houses and
//             sheds packed along the frontage.
//   hamlet  - a single dirt lane with 3-9 farm buildings (barns are 'shed').
//
// Site rules: land (terrainHeight > ~3 m), mean slope below the layer limit,
// and clear of every airport pad by padRadius + 400 m plus 80% of the
// settlement radius, so no building or road can ever sit inside a pad.
//
// Clearance between nested types (larger type wins):
//   town    rejected within 2.2 km of a metro
//   village rejected within 1.2 km of a town or metro
//   hamlet  rejected within 600 m of a village, town or metro
//   metro   metro cells are 32.8 km and sites are kept in the inner half of
//           the cell, so two metros are always > 6 km apart by construction.

import { terrainHeight, baseHeight, airportAtCell, AIRPORT_GRID } from './terrain.js';
import { hashU32, mulberry32, clamp } from './noise.js';

/**
 * Settlement layers. `cell` is the world-cell size in metres; every cell can
 * hold at most one settlement of that layer. `clearance` is the centre-to-centre
 * distance that separates this type from the next larger type (metres).
 */
export const SETTLEMENT_LAYERS = [
  {
    level: 'metro',
    cell: 32768,
    radius: [900, 1500],
    population: [60000, 400000],
    buildings: [260, 520],
    clearance: 6000,
    description: 'Regional city: orthogonal grid, tower core, mid-rise ring, low suburbs.',
  },
  {
    level: 'town',
    cell: 8192,
    radius: [280, 520],
    population: [2000, 20000],
    buildings: [70, 180],
    clearance: 2200,
    description: 'Market town: main street and plaza, low frontage, small industrial edge.',
  },
  {
    level: 'village',
    cell: 4096,
    radius: [120, 230],
    population: [120, 1200],
    buildings: [18, 55],
    clearance: 1200,
    description: 'Village: houses and sheds strung along one or two roads.',
  },
  {
    level: 'hamlet',
    cell: 2048,
    radius: [45, 110],
    population: [5, 60],
    buildings: [3, 9],
    clearance: 600,
    description: 'Hamlet: a dirt lane with a few farmhouses, barns and sheds.',
  },
];

const LEVELS = new Map(SETTLEMENT_LAYERS.map((l) => [l.level, l]));

// Per-layer generation knobs. slopeMax is the mean slope over the site footprint.
const CFG = {
  metro: { elevMax: 900, slopeMax: 0.115, slopePoints: 5, attempts: 8, chance: 0.25 },
  town: { elevMax: 1000, slopeMax: 0.14, slopePoints: 3, attempts: 6, chance: 0.45 },
  village: { elevMax: 1200, slopeMax: 0.19, slopePoints: 1, attempts: 4, chance: 0.45 },
  hamlet: { elevMax: 1500, slopeMax: 0.24, slopePoints: 1, attempts: 3, chance: 0.35 },
};

const SALT = {
  metro: 0x2c1b3c6d,
  town: 0x9e3779b1,
  village: 0x85ebca6b,
  hamlet: 0xc2b2ae35,
};

// Site centres must sit this far above sea level (metres). evalSite and the
// cached-site revalidation in settlementAtCell both use it, so a site cached
// before a real DEM loaded can never be built on top of water.
const MIN_SITE_HEIGHT = 3.5;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
const NAME_A = [
  'Ash', 'Bel', 'Bran', 'Cald', 'Cran', 'Dray', 'Dun', 'Elm', 'Esk', 'Fal',
  'Fen', 'Gars', 'Glen', 'Har', 'Hav', 'Hol', 'Ing', 'Jar', 'Kel', 'Kes',
  'Lark', 'Lom', 'Mar', 'Mill', 'Nev', 'Nor', 'Oak', 'Ork', 'Ost', 'Pel',
  'Pem', 'Quen', 'Rav', 'Roth', 'Rus', 'Sel', 'Stan', 'Til', 'Thorn', 'Tor',
  'Val', 'Ver', 'Wes', 'Wil', 'Wold', 'Yar', 'Yew', 'Zel',
];
const NAME_B = [
  'ford', 'ton', 'vale', 'mere', 'burg', 'field', 'wick', 'moor', 'dale',
  'brook',
];

function makeName(rng, type) {
  const a = NAME_A[(rng() * NAME_A.length) | 0];
  const b = NAME_B[(rng() * NAME_B.length) | 0];
  return type === 'metro' ? a + b + ' City' : a + b;
}

// ---------------------------------------------------------------------------
// Site evaluation
// ---------------------------------------------------------------------------
function meanSlope(x, z, R, points) {
  const e = Math.max(30, R * 0.1);
  const off = R * 0.55;
  let sum = 0;
  let n = 0;
  const sample = (px, pz) => {
    const hx = baseHeight(px + e, pz) - baseHeight(px - e, pz);
    const hz = baseHeight(px, pz + e) - baseHeight(px, pz - e);
    sum += len(hx, hz) / (2 * e);
    n++;
  };
  sample(x, z);
  if (points >= 3) {
    sample(x + off, z);
    sample(x, z + off);
  }
  if (points >= 5) {
    sample(x - off, z);
    sample(x, z - off);
  }
  return sum / n;
}

// Airport candidates are scanned around the *corner* (cx*G, cz*G) of their
// nominal cell (see buildAirport), so an airport can sit up to ~4.4 km on
// either side of that corner, including just outside its own cell. Culling by
// the nominal cell rectangle is therefore wrong; cull by that corner box.
const AIRPORT_BOX = 4400;

/**
 * True when an airport pad (plus 400 m and 80% of the settlement radius) is
 * close enough to matter.
 */
function nearAirport(x, z, R) {
  const margin = 400 + R * 0.8;
  const cx = Math.floor(x / AIRPORT_GRID);
  const cz = Math.floor(z / AIRPORT_GRID);
  const reach = 4000;
  for (let dx = -1; dx <= 1; dx++) {
    const bx = (cx + dx) * AIRPORT_GRID;
    let ddx = Math.abs(x - bx) - AIRPORT_BOX;
    if (ddx < 0) ddx = 0;
    if (ddx > reach) continue;
    for (let dz = -1; dz <= 1; dz++) {
      const bz = (cz + dz) * AIRPORT_GRID;
      let ddz = Math.abs(z - bz) - AIRPORT_BOX;
      if (ddz < 0) ddz = 0;
      if (ddx * ddx + ddz * ddz > reach * reach) continue;
      const ap = airportAtCell(cx + dx, cz + dz);
      if (!ap) continue;
      const ax = x - ap.x;
      const az = z - ap.z;
      const lim = ap.padRadius + margin;
      if (ax * ax + az * az < lim * lim) return true;
    }
  }
  return false;
}

function evalSite(x, z, R, level) {
  const cfg = CFG[level];
  if (nearAirport(x, z, R)) return null;
  // Airport pads are excluded above, so plain baseHeight is the ground height.
  const h = baseHeight(x, z);
  if (h < MIN_SITE_HEIGHT || h > cfg.elevMax) return null;
  const slope = meanSlope(x, z, R, cfg.slopePoints);
  if (slope > cfg.slopeMax) return null;
  // Prefer flat ground, then lower ground; a hilltop town is allowed but rare.
  return { h, slope, score: -slope * 6 - h * 0.001 };
}

function pickSite(level, cx, cz, R, rng) {
  const cfg = CFG[level];
  const size = LEVELS.get(level).cell;
  // Metros keep to the inner half of their cell, which also guarantees the
  // 6 km metro-to-metro spacing.
  const margin = level === 'metro' ? 0.25 : 0.1;
  let best = null;
  for (let i = 0; i < cfg.attempts; i++) {
    const x = (cx + margin + rng() * (1 - 2 * margin)) * size;
    const z = (cz + margin + rng() * (1 - 2 * margin)) * size;
    const site = evalSite(x, z, R, level);
    if (!site) continue;
    const score = site.score + rng() * 0.4;
    if (!best || score > best.score) best = { x, z, h: site.h, slope: site.slope, score };
    // Good enough: stop scanning. Most cells find a comfortable site early.
    if (site.slope <= cfg.slopeMax * 0.85) return best;
  }
  return best;
}

// The origin area is hand-seeded so the player always sees life on takeoff:
// a town inside cell (0,0) within ~5 km of the runway and a village inside the
// same cell within 3 km. A metro is forced into cell (0,0) further out so the
// first flight has a city on the horizon.
function forcedMetroSite(R, rng) {
  const normal = pickSite('metro', 0, 0, R, rng);
  if (normal) return normal;
  // Fallback: broad scan of the cell, keeping well clear of the origin.
  let best = null;
  for (let x = 9000; x <= 30000; x += 1600) {
    for (let z = 9000; z <= 30000; z += 1600) {
      if (len(x, z) < 7000) continue;
      if (nearAirport(x, z, R)) continue;
      const h = terrainHeight(x, z);
      if (h < 4 || h > 900) continue;
      const slope = meanSlope(x, z, R, 5);
      if (slope > 0.2) continue;
      const score = -slope * 8 - h * 0.001;
      if (!best || score > best.score) best = { x, z, h, slope, score };
    }
  }
  return best;
}

function forcedTownSite(R, rng) {
  const a0 = rng() * Math.PI * 2;
  let best = null;
  for (let d = 1000; d <= 2700; d += 90) {
    for (let k = 0; k < 48; k++) {
      const a = a0 + (k / 48) * Math.PI * 2;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (x < 120 || z < 120 || x > 8060 || z > 8060) continue;
      if (nearAirport(x, z, R)) continue;
      if (hasLargerNear(x, z, ['metro'], 2200)) continue;
      const site = evalSite(x, z, R, 'town');
      if (!site) continue;
      const score = site.score - Math.abs(d - 1650) * 0.002;
      if (!best || score > best.score) best = { x, z, h: site.h, slope: site.slope, score };
      if (best.score > -0.5) return best;
    }
  }
  return best;
}

function forcedVillageSite(R, rng) {
  const town = ensureSite('town', 0, 0);
  const a0 = rng() * Math.PI * 2;
  let best = null;
  for (let d = 1500; d <= 2950; d += 70) {
    for (let k = 0; k < 56; k++) {
      const a = a0 + (k / 56) * Math.PI * 2;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (x < 90 || z < 90 || x > 4000 || z > 4000) continue;
      if (town && len(x - town.x, z - town.z) < 1320) continue;
      if (nearAirport(x, z, R)) continue;
      if (hasLargerNear(x, z, ['metro'], 1200)) continue;
      const site = evalSite(x, z, R, 'village');
      if (!site) continue;
      const score = site.score - Math.abs(d - 2300) * 0.002;
      if (!best || score > best.score) best = { x, z, h: site.h, slope: site.slope, score };
      if (best.score > -0.6) return best;
    }
  }
  return best;
}

/**
 * True when a settlement of any of `levels` sits within `dist` metres.
 * Used to enforce the nested-type clearance rules. One-way dependencies only
 * (town -> metro, village -> town/metro, hamlet -> village/town/metro), so
 * there is no recursion cycle.
 */
function hasLargerNear(x, z, levels, dist) {
  for (const level of levels) {
    const cell = LEVELS.get(level).cell;
    const cx0 = Math.floor((x - dist) / cell);
    const cx1 = Math.floor((x + dist) / cell);
    const cz0 = Math.floor((z - dist) / cell);
    const cz1 = Math.floor((z + dist) / cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const s = ensureSite(level, cx, cz);
        if (s && len(s.x - x, s.z - z) < dist) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------
function makeFrame(x, z, rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return {
    rot,
    c,
    s,
    toWorld(u, v) {
      return { x: x + u * c - v * s, z: z + u * s + v * c };
    },
  };
}

const len = (a, b) => Math.sqrt(a * a + b * b);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

function addRoad(roads, frame, u1, v1, u2, v2, width) {
  const a = frame.toWorld(u1, v1);
  const b = frame.toWorld(u2, v2);
  roads.push({ x1: r2(a.x), z1: r2(a.z), x2: r2(b.x), z2: r2(b.z), width: r2(width) });
}

/**
 * Height sampler for building bases. If no airport blending reaches the
 * settlement, terrainHeight is exactly baseHeight, so use the cheaper one;
 * otherwise use the real terrainHeight so buildings sit on flattened pads'
 * blending skirts correctly.
 */
function heightSampler(x, z, R) {
  // blend is at most 1.7 * padRadius (~3.9 km); include R for the outskirts.
  const cx = Math.floor(x / AIRPORT_GRID);
  const cz = Math.floor(z / AIRPORT_GRID);
  const reach = 5500;
  for (let dx = -1; dx <= 1; dx++) {
    const bx = (cx + dx) * AIRPORT_GRID;
    let ddx = Math.abs(x - bx) - AIRPORT_BOX;
    if (ddx < 0) ddx = 0;
    if (ddx > reach) continue;
    for (let dz = -1; dz <= 1; dz++) {
      const bz = (cz + dz) * AIRPORT_GRID;
      let ddz = Math.abs(z - bz) - AIRPORT_BOX;
      if (ddz < 0) ddz = 0;
      if (ddx * ddx + ddz * ddz > reach * reach) continue;
      const ap = airportAtCell(cx + dx, cz + dz);
      if (!ap) continue;
      const ax = x - ap.x;
      const az = z - ap.z;
      const lim = ap.blend + R;
      if (ax * ax + az * az < lim * lim) return terrainHeight;
    }
  }
  return baseHeight;
}

// Buildings are only kept on dry land. No airport test is needed here: sites
// are already cleared by padRadius + 400 + 0.8*R, and every footprint stays
// inside R of the centre.
//
// `reliefMax` rejects a footprint whose four rotated corners span more than
// that many metres of terrain, so wide blocks never bridge a hillside at a
// silly angle. Buildings that are accepted keep y = ground at their centre:
// the renderer grounds each corner itself.
function pushBuilding(list, heightAt, x, z, w, d, h, rot, color, kind, reliefMax = Infinity) {
  const y = heightAt(x, z);
  if (y < 1.5) return false;
  if (reliefMax < Infinity) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const hw = w * 0.5;
    const hd = d * 0.5;
    let lo = y;
    let hi = y;
    for (let i = 0; i < 4; i++) {
      const su = (i & 1) ? hw : -hw;
      const sv = (i & 2) ? hd : -hd;
      const hc = heightAt(x + su * c - sv * s, z + su * s + sv * c);
      if (hc < lo) lo = hc;
      if (hc > hi) hi = hc;
    }
    if (hi - lo > reliefMax) return false;
  }
  list.push({
    x: r2(x),
    z: r2(z),
    w: r2(w),
    d: r2(d),
    h: r2(h),
    rot: r3(rot),
    color,
    kind,
    y: r2(y),
  });
  return true;
}

const PALETTE = {
  house: [0xd9cdb6, 0xcfc0a6, 0xe3d9c8, 0xc4b49a, 0xb9a88c, 0xd6c1a3],
  shop: [0xc2a98f, 0xb89c83, 0xd0bda6, 0xa8907a, 0xbca78f],
  apartment: [0xa9a49a, 0xb8b2a6, 0x9b9a93, 0xc0b6a8, 0x8f9095],
  tower: [0x8fa6ba, 0x7d93a8, 0xa6b8c6, 0x93a3b3, 0x8298a8, 0xb3c2cc],
  industrial: [0x8e918c, 0x9c978b, 0x82857f, 0xa39a86],
  shed: [0x8d7d66, 0x7c6c55, 0x9a8d7c, 0x6f604d],
};

function pickColor(rng, kind) {
  const p = PALETTE[kind] || PALETTE.house;
  return p[(rng() * p.length) | 0];
}

// ---------------------------------------------------------------------------
// Metro: orthogonal street grid with clipped street ends and block infill
// ---------------------------------------------------------------------------
function layoutMetro(x, z, R, rng, heightAt) {
  const rot = rng() * Math.PI;
  const frame = makeFrame(x, z, rot);
  const pitch = 86 + rng() * 46; // street centre spacing, 86..132 m
  const streetW = 9 + rng() * 4;
  const avenueW = 19 + rng() * 7; // boulevards are wide enough for a median
  const avenueEvery = 3 + ((rng() * 3) | 0);
  const lineW = (i) => (i % avenueEvery === 0 ? avenueW : streetW);
  const n = Math.ceil(R / pitch) + 1;

  const roads = [];
  for (let i = -n; i <= n; i++) {
    const u = i * pitch;
    if (Math.abs(u) >= R * 0.99) continue;
    const half = Math.sqrt(R * R - u * u) * 0.995;
    const w = lineW(i);
    addRoad(roads, frame, u, -half, u, half, w);
    addRoad(roads, frame, -half, u, half, u, w);
  }

  // Beltway: a 16-sided perimeter ring outside the mid-rise ring. It ties the
  // outer blocks together and gives the city a definite edge instead of a
  // ragged fade-out of grid streets.
  const ringR = R * (0.74 + rng() * 0.07);
  const ringW = 15 + rng() * 7;
  const ringSides = 16;
  const ring = [];
  for (let k = 0; k < ringSides; k++) {
    const a = (k / ringSides) * Math.PI * 2;
    ring.push({ u: Math.cos(a) * ringR, v: Math.sin(a) * ringR });
  }
  for (let k = 0; k < ringSides; k++) {
    const p0 = ring[k];
    const p1 = ring[(k + 1) % ringSides];
    addRoad(roads, frame, p0.u, p0.v, p1.u, p1.v, ringW);
  }
  const ringClear = ringW * 0.5 + pitch * 0.36;

  const target = 380 + ((rng() * 121) | 0); // 380..500, inside the 260..520 contract
  const indAng = rng() * Math.PI * 2; // bearing of the industrial sector
  const cbdR = R * 0.3; // downtown core
  const midR = R * 0.64; // mid-rise ring
  const cands = [];
  for (let i = -n; i < n; i++) {
    for (let j = -n; j < n; j++) {
      const cu = (i + 0.5) * pitch;
      const cv = (j + 0.5) * pitch;
      const dist = len(cu, cv);
      if (dist > R * 0.93) continue;
      // Nothing is built on the beltway corridor.
      if (Math.abs(dist - ringR) < ringClear) continue;

      // Some blocks stay parks / open ground: the street grid keeps its shape
      // but no buildings fill the block.
      const parkChance = dist < cbdR ? 0.015 : dist < midR ? 0.05 : 0.085;
      if (rng() < parkChance) continue;

      const bw = pitch - (lineW(i) + lineW(i + 1)) * 0.5;
      const bd = pitch - (lineW(j) + lineW(j + 1)) * 0.5;
      const margin = 3.5 + rng() * 3.5;
      const innerW = bw - 2 * margin;
      const innerD = bd - 2 * margin;
      if (innerW < 12 || innerD < 12) continue;

      const core = dist < cbdR;
      const mid = !core && dist < midR;
      let dAng = Math.abs(Math.atan2(cv, cu) - indAng);
      if (dAng > Math.PI) dAng = Math.PI * 2 - dAng;
      // One outer wedge is zoned industrial, the rest of the fringe stays
      // residential: warehouses only ever appear downwind of the houses.
      const industrial = !core && dist > R * 0.52 && dAng < 0.62;

      const cols = core ? 2 + (rng() < 0.6 ? 1 : 0)
        : industrial ? 1
          : mid ? 2
            : 1 + (rng() < 0.5 ? 1 : 0);
      const rows = core ? 2 + (rng() < 0.5 ? 1 : 0)
        : industrial ? 1 + (rng() < 0.55 ? 1 : 0)
          : mid ? 2
            : 1;

      for (let a = 0; a < cols; a++) {
        for (let b = 0; b < rows; b++) {
          const lotW = innerW / cols;
          const lotD = innerD / rows;
          const u = cu - innerW / 2 + (a + 0.5) * lotW + (rng() - 0.5) * 1.6;
          const v = cv - innerD / 2 + (b + 0.5) * lotD + (rng() - 0.5) * 1.6;

          let w = lotW * (0.52 + rng() * 0.3);
          let d = lotD * (0.52 + rng() * 0.3);
          let h;
          let kind;

          if (core) {
            const t = Math.max(0.06, 1 - dist / cbdR);
            h = 26 + 122 * Math.pow(t, 1.15) * (0.55 + rng() * 0.8);
            h = Math.min(165, h);
            kind = h > 56 ? 'tower' : h > 22 ? 'apartment' : 'shop';
            w = Math.min(lotW * 0.9, Math.max(w, 19 + rng() * 15));
            d = Math.min(lotD * 0.9, Math.max(d, 17 + rng() * 13));
          } else if (industrial) {
            w = Math.min(lotW * 0.95, 22 + rng() * 22);
            d = Math.min(lotD * 0.95, 15 + rng() * 18);
            h = 6 + rng() * 8;
            kind = rng() < 0.62 ? 'industrial' : 'shed';
          } else if (mid) {
            h = 9 + rng() * 20;
            kind = h > 21 ? 'apartment' : rng() < 0.6 ? 'shop' : 'house';
          } else {
            h = 4 + rng() * 6.5;
            kind = rng() < 0.78 ? 'house' : rng() < 0.5 ? 'shop' : 'shed';
          }

          // 90 degree variety, with a few degrees of natural slop.
          const rotOff = (rng() < 0.55 ? 0 : Math.PI / 2) + (rng() - 0.5) * 0.07;
          // A quarter-turned footprint swaps its extents; keep it inside the lot
          // so nothing can overhang into the street.
          if (Math.abs(Math.cos(rotOff)) < 0.5) {
            w = Math.min(w, lotD * 0.9);
            d = Math.min(d, lotW * 0.9);
          }
          cands.push({
            u,
            v,
            w,
            d,
            h,
            kind,
            rotOff,
            color: pickColor(rng, kind),
            priority: (dist / R) * 0.65 + rng() * 0.5,
          });
        }
      }
    }
  }

  // Landmarks: three signature towers inside the CBD. They are ordinary lots
  // with a forced height, so the skyline always has a recognisable peak.
  const corePool = [];
  for (let k = 0; k < cands.length; k++) {
    const c = cands[k];
    if (len(c.u, c.v) < R * 0.24 && c.w > 18 && c.d > 16) corePool.push(k);
  }
  const marks = Math.min(3, corePool.length);
  for (let k = 0; k < marks; k++) {
    const c = cands[corePool[Math.floor((k * (corePool.length - 1)) / Math.max(1, marks))]];
    c.h = Math.max(c.h, 108 + rng() * 52);
    c.kind = 'tower';
    c.color = pickColor(rng, 'tower');
    c.priority = -1.5 + rng() * 0.4;
  }

  cands.sort((a, b) => a.priority - b.priority);
  const buildings = [];
  for (const c of cands) {
    if (buildings.length >= target) break;
    if (len(c.u, c.v) > R * 0.93) continue;
    const p = frame.toWorld(c.u, c.v);
    const relief = 1.6 + Math.hypot(c.w, c.d) * 0.11;
    if (pushBuilding(buildings, heightAt, p.x, p.z, c.w, c.d, c.h, -rot + c.rotOff, c.color, c.kind, relief)) {
      c.used = true;
    }
  }
  // Contract floor: if slope rejection cost us too many lots, fill the rest
  // from the slopes we normally refuse so the 260-building minimum holds.
  if (buildings.length < 260) {
    for (const c of cands) {
      if (buildings.length >= 260) break;
      if (c.used) continue;
      const p = frame.toWorld(c.u, c.v);
      if (pushBuilding(buildings, heightAt, p.x, p.z, c.w, c.d, c.h, -rot + c.rotOff, c.color, c.kind, Infinity)) {
        c.used = true;
      }
    }
  }
  return { buildings, roads };
}

// ---------------------------------------------------------------------------
// Town: main street, plaza, side and cross streets, industrial edge
// ---------------------------------------------------------------------------
function layoutTown(x, z, R, rng, heightAt) {
  const rot = rng() * Math.PI;
  const frame = makeFrame(x, z, rot);
  const mainW = 12 + rng() * 6;
  const roads = [];
  const mainHalf = R * 0.92;
  addRoad(roads, frame, -mainHalf, 0, mainHalf, 0, mainW);

  // Side streets parallel to the main street.
  const sideV = [];
  const laneCount = R > 380 ? 2 : 1;
  for (let k = 0; k < laneCount; k++) {
    const v = (k + 1) * (48 + rng() * 26) * (rng() < 0.5 ? 1 : -1);
    if (Math.abs(v) > R * 0.72) continue;
    const half = Math.sqrt(R * R - v * v) * 0.94;
    const w = 9 + rng() * 4;
    addRoad(roads, frame, -half, v, half, v, w);
    sideV.push({ v, w, half });
  }

  // Cross streets.
  const crossU = [];
  const crossCount = 1 + (rng() < 0.5 ? 1 : 0);
  for (let k = 0; k < crossCount; k++) {
    const u = (k === 0 ? 1 : -1) * (62 + rng() * 70);
    if (Math.abs(u) > R * 0.7) continue;
    const half = Math.sqrt(R * R - u * u) * 0.94;
    const w = 9 + rng() * 3;
    addRoad(roads, frame, u, -half, u, half, w);
    crossU.push({ u, w, half });
  }

  const plazaR = 30 + rng() * 16;
  const cands = [];

  const makeTownBuilding = (dist) => {
    let h = 4 + rng() * 10;
    let kind = rng() < 0.72 ? 'house' : rng() < 0.55 ? 'shop' : 'shed';
    if (dist < R * 0.42 && rng() < 0.22) {
      h = 16 + rng() * 10;
      kind = rng() < 0.6 ? 'apartment' : 'shop';
    } else if (dist < R * 0.42 && rng() < 0.3) {
      h = 9 + rng() * 5;
      kind = 'shop';
    }
    return {
      w: 9 + rng() * 13,
      d: 8 + rng() * 10,
      h,
      kind,
      rotOff: (rng() < 0.5 ? 0 : Math.PI / 2) + (rng() - 0.5) * 0.06,
    };
  };

  const addFrontage = (laneV, laneW, lo, hi, alongU) => {
    for (let t = lo + 8; t <= hi - 8; ) {
      const step = 15 + rng() * 12;
      for (const side of [-1, 1]) {
        const dist = len(alongU ? t : laneV, alongU ? laneV : t);
        if (dist < plazaR) continue;
        const b = makeTownBuilding(dist);
        const rotated = Math.abs(Math.cos(b.rotOff)) < 0.5;
        const eu = rotated ? b.d * 0.5 : b.w * 0.5; // half extent along u
        const ev = rotated ? b.w * 0.5 : b.d * 0.5; // half extent along v
        const setback = 3 + rng() * 4;
        let bu;
        let bv;
        if (alongU) {
          // Lane runs along u; keep the mouth of every cross street clear.
          let blocked = false;
          for (const c of crossU) {
            if (Math.abs(t - c.u) < c.w * 0.5 + eu + 2) blocked = true;
          }
          if (blocked) continue;
          bu = t;
          bv = laneV + side * (laneW * 0.5 + setback + ev);
        } else {
          // Lane runs along v; keep the main street and side streets clear.
          if (Math.abs(t) < mainW * 0.5 + ev + 1) continue;
          let blocked = false;
          for (const sv of sideV) {
            if (Math.abs(t - sv.v) < sv.w * 0.5 + ev + 2) blocked = true;
          }
          if (blocked) continue;
          bu = laneV + side * (laneW * 0.5 + setback + eu);
          bv = t;
        }
        if (len(bu, bv) > R * 0.88) continue;
        cands.push({
          u: bu,
          v: bv,
          w: b.w,
          d: b.d,
          h: b.h,
          kind: b.kind,
          rotOff: b.rotOff,
          color: pickColor(rng, b.kind),
          priority: len(bu, bv) / R + rng() * 0.5,
        });
      }
      t += step;
    }
  };

  addFrontage(0, mainW, -mainHalf, mainHalf, true);
  for (const s of sideV) addFrontage(s.v, s.w, -s.half, s.half, true);
  for (const c of crossU) addFrontage(c.u, c.w, -c.half, c.half, false);

  // Industrial edge: a couple of large sheds / works on one side of town.
  const nInd = 2 + ((rng() * 4) | 0);
  const indAng = rng() * Math.PI * 2;
  for (let i = 0; i < nInd; i++) {
    const a = indAng + (i - (nInd - 1) / 2) * 0.2;
    const dist = R * (0.7 + rng() * 0.12);
    const u = Math.cos(a) * dist;
    const v = Math.sin(a) * dist;
    const kind = rng() < 0.6 ? 'industrial' : 'shed';
    const w = 22 + rng() * 18;
    const d = 13 + rng() * 12;
    const rb = Math.hypot(w, d) * 0.5 + 1;
    let onLane = Math.abs(v) < mainW * 0.5 + rb;
    for (const s2 of sideV) if (Math.abs(v - s2.v) < s2.w * 0.5 + rb) onLane = true;
    for (const c of crossU) if (Math.abs(u - c.u) < c.w * 0.5 + rb) onLane = true;
    if (onLane) continue;
    cands.push({
      u,
      v,
      w,
      d,
      h: 6 + rng() * 6,
      kind,
      rotOff: 0,
      color: pickColor(rng, kind),
      priority: -0.5 + rng() * 0.1,
    });
  }

  const target = 70 + ((rng() * 111) | 0); // 70..180
  cands.sort((a, b) => a.priority - b.priority);
  const buildings = [];
  for (const c of cands) {
    if (buildings.length >= target) break;
    const p = frame.toWorld(c.u, c.v);
    const relief = 1.6 + Math.hypot(c.w, c.d) * 0.11;
    if (pushBuilding(buildings, heightAt, p.x, p.z, c.w, c.d, c.h, -rot + c.rotOff, c.color, c.kind, relief)) {
      c.used = true;
    }
  }
  if (buildings.length < 70) {
    for (const c of cands) {
      if (buildings.length >= 70) break;
      if (c.used) continue;
      const p = frame.toWorld(c.u, c.v);
      if (pushBuilding(buildings, heightAt, p.x, p.z, c.w, c.d, c.h, -rot + c.rotOff, c.color, c.kind, Infinity)) {
        c.used = true;
      }
    }
  }
  return { buildings, roads };
}

// ---------------------------------------------------------------------------
// Village: two roads, houses and sheds packed along the frontage
// ---------------------------------------------------------------------------
function layoutVillage(x, z, R, rng, heightAt) {
  const rot = rng() * Math.PI;
  const frame = makeFrame(x, z, rot);
  const mainW = 6 + rng() * 3;
  const roads = [];
  const mainHalf = R * 0.9;
  addRoad(roads, frame, -mainHalf, 0, mainHalf, 0, mainW);

  const lanes = [{ axis: 'u', pos: 0, w: mainW, half: mainHalf }];

  if (rng() < 0.62) {
    const u = (rng() - 0.5) * R * 0.35;
    const half = Math.sqrt(Math.max(1, R * R - u * u)) * 0.9;
    const w = 5 + rng() * 2;
    addRoad(roads, frame, u, -half, u, half, w);
    lanes.push({ axis: 'v', pos: u, w, half });
  }
  if (rng() < 0.55) {
    const v = (rng() < 0.5 ? 1 : -1) * (26 + rng() * 18);
    if (Math.abs(v) < R * 0.75) {
      const half = Math.sqrt(R * R - v * v) * 0.9;
      const w = 4.5 + rng() * 2;
      addRoad(roads, frame, -half, v, half, v, w);
      lanes.push({ axis: 'u', pos: v, w, half });
    }
  }

  const cands = [];
  for (const lane of lanes) {
    for (let t = -lane.half + 7; t <= lane.half - 7; ) {
      const step = 15 + rng() * 11;
      for (const side of [-1, 1]) {
        const setback = 2.5 + rng() * 3;
        const depth = 7 + rng() * 5;
        const barn = rng() < 0.12;
        const kind = barn ? 'shed' : rng() < 0.86 ? 'house' : 'shop';
        const w = barn ? 14 + rng() * 10 : 8 + rng() * 8;
        const d = barn ? 9 + rng() * 6 : depth;
        const h = barn ? 5 + rng() * 3 : 4 + rng() * 5;
        const rotOff = (rng() < 0.5 ? 0 : Math.PI / 2) + (rng() - 0.5) * 0.06;
        const rotated = Math.abs(Math.cos(rotOff)) < 0.5; // quarter turn: extents swap
        const eu = rotated ? d * 0.5 : w * 0.5;
        const ev = rotated ? w * 0.5 : d * 0.5;
        const off = lane.axis === 'u' ? ev : eu;
        const u = lane.axis === 'u' ? t : lane.pos + side * (lane.w * 0.5 + setback + off);
        const v = lane.axis === 'u' ? lane.pos + side * (lane.w * 0.5 + setback + off) : t;
        if (len(u, v) > R * 0.9) continue;
        // Do not build over any road in the village.
        let onRoad = false;
        for (const L of lanes) {
          if (L.axis === 'u') {
            if (Math.abs(v - L.pos) < L.w * 0.5 + ev + 1 && Math.abs(u) <= L.half) onRoad = true;
          } else if (Math.abs(u - L.pos) < L.w * 0.5 + eu + 1 && Math.abs(v) <= L.half) {
            onRoad = true;
          }
        }
        if (onRoad) continue;
        cands.push({
          u,
          v,
          w,
          d,
          h,
          kind,
          rotOff,
          color: pickColor(rng, kind),
          priority: len(u, v) / R + rng() * 0.6,
        });
      }
      t += step;
    }
  }

  const target = 18 + ((rng() * 38) | 0); // 18..55
  cands.sort((a, b) => a.priority - b.priority);
  const buildings = [];
  for (const c of cands) {
    if (buildings.length >= target) break;
    if (len(c.u, c.v) > R * 0.9) continue;
    const p = frame.toWorld(c.u, c.v);
    const relief = 1.2 + Math.hypot(c.w, c.d) * 0.12;
    if (pushBuilding(buildings, heightAt, p.x, p.z, c.w, c.d, c.h, -rot + c.rotOff, c.color, c.kind, relief)) {
      c.used = true;
    }
  }
  if (buildings.length < 18) {
    for (const c of cands) {
      if (buildings.length >= 18) break;
      if (c.used) continue;
      const p = frame.toWorld(c.u, c.v);
      if (pushBuilding(buildings, heightAt, p.x, p.z, c.w, c.d, c.h, -rot + c.rotOff, c.color, c.kind, Infinity)) {
        c.used = true;
      }
    }
  }
  return { buildings, roads };
}

// ---------------------------------------------------------------------------
// Hamlet: one dirt lane, a handful of farm buildings
// ---------------------------------------------------------------------------
function layoutHamlet(x, z, R, rng, heightAt) {
  const rot = rng() * Math.PI;
  const frame = makeFrame(x, z, rot);
  const roads = [];
  const half = R * 0.88;
  const laneW = 3.2 + rng() * 1.4;
  addRoad(roads, frame, -half, 0, half, 0, laneW);
  if (rng() < 0.5) addRoad(roads, frame, 0, 0, 0, half * 0.75, laneW * 0.9);

  const n = 3 + ((rng() * 7) | 0); // 3..9
  const buildings = [];
  const spread = R * 0.8;
  let attempts = 0;
  while (buildings.length < n && attempts < n * 5) {
    const slot = attempts % n;
    attempts++;
    const t = -spread + (slot / Math.max(1, n - 1)) * (2 * spread) + (rng() - 0.5) * 6;
    const side = ((slot + (attempts >= n ? 1 : 0)) % 2 === 0) ? 1 : -1;
    const barn = rng() < 0.34;
    const w = barn ? 16 + rng() * 10 : 10 + rng() * 7;
    const d = barn ? 10 + rng() * 6 : 7 + rng() * 4;
    const h = barn ? 5 + rng() * 4 : 3.5 + rng() * 3;
    const setback = 2.5 + rng() * 3.5;
    const rotOff = (rng() < 0.5 ? 0 : Math.PI / 2) + (rng() - 0.5) * 0.05;
    const ev = Math.abs(Math.cos(rotOff)) < 0.5 ? w * 0.5 : d * 0.5;
    const v = side * (laneW * 0.5 + setback + ev);
    const u = t + (rng() - 0.5) * 5;
    const kind = barn ? 'shed' : 'house';
    // keep the T-junction spur clear
    if (roads.length > 1 && Math.abs(u) < laneW * 0.5 + w * 0.5 + 1 && Math.abs(v) < half * 0.8) continue;
    const p = frame.toWorld(u, v);
    pushBuilding(
      buildings, heightAt, p.x, p.z, w, d, h, -rot + rotOff,
      pickColor(rng, kind), kind,
    );
  }
  // Shoreline sites can reject a few slots; guarantee the 3-building contract
  // by tightening the last few farm buildings around the lane centre.
  let guard = 0;
  while (buildings.length < 3 && guard < 16) {
    const a = (guard * 2.399) % (Math.PI * 2);
    const r = 8 + (guard % 4) * 10;
    const p = frame.toWorld(Math.cos(a) * r, Math.sin(a) * r);
    pushBuilding(
      buildings, heightAt, p.x, p.z, 9, 7, 4.5, -rot + (a % 1.5),
      pickColor(rng, 'house'), 'house',
    );
    guard++;
  }
  return { buildings, roads };
}

// ---------------------------------------------------------------------------
// Settlement assembly + caches
// ---------------------------------------------------------------------------
const settlementCaches = {
  metro: new Map(),
  town: new Map(),
  village: new Map(),
  hamlet: new Map(),
};

const MAX_CELL_CACHE = 24000;

function store(cache, key, value) {
  if (cache.size > MAX_CELL_CACHE) {
    let drop = 4000;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--drop <= 0) break;
    }
  }
  cache.set(key, value);
  return value;
}

// Site selection and layout generation are separate phases. Clearance checks
// (and settlementsNear's distance test) only need positions/radii, so they use
// the cheap site phase; building/road arrays are generated once, lazily, for
// settlements that are actually returned.
const siteCaches = {
  metro: new Map(),
  town: new Map(),
  village: new Map(),
  hamlet: new Map(),
};

const SITE_MIX = 0x27d4eb2f;
const LAYOUT_MIX = 0x165667b1;

function buildSite(level, cx, cz) {
  const cfg = CFG[level];
  const seed = hashU32(cx, cz, SALT[level]);
  const rng = mulberry32((seed ^ SITE_MIX) >>> 0);
  const span = LEVELS.get(level).radius;
  const R = span[0] + rng() * (span[1] - span[0]);

  // The origin cells are hand-seeded so the player always sees life on
  // takeoff; every other cell goes through the sparsity gate.
  const forcedOrigin =
    (level === 'metro' || level === 'town' || level === 'village') && cx === 0 && cz === 0;

  // Cheap gate: most cells carry no settlement of a given layer at all.
  if (!forcedOrigin && rng() > cfg.chance) return null;

  let site;
  if (level === 'metro' && cx === 0 && cz === 0) {
    site = forcedMetroSite(R, rng);
  } else if (level === 'town' && cx === 0 && cz === 0) {
    site = forcedTownSite(R, rng);
  } else if (level === 'village' && cx === 0 && cz === 0) {
    site = forcedVillageSite(R, rng);
  } else {
    site = pickSite(level, cx, cz, R, rng);
  }
  if (!site) return null;

  // Nested-type clearance (one-way: only larger types are consulted).
  if (level === 'town' && hasLargerNear(site.x, site.z, ['metro'], 2200)) return null;
  if (level === 'village' && hasLargerNear(site.x, site.z, ['town', 'metro'], 1200)) return null;
  if (level === 'hamlet' && hasLargerNear(site.x, site.z, ['village', 'town', 'metro'], 600)) return null;

  const t = clamp((R - span[0]) / (span[1] - span[0]), 0, 1);
  const popSpan = LEVELS.get(level).population;
  let population;
  if (level === 'hamlet') {
    population = 5 + Math.round(rng() * 55);
  } else if (level === 'village') {
    population = Math.round((120 + 1080 * t) * (0.6 + rng() * 0.8));
  } else if (level === 'town') {
    population = Math.round((2000 + 18000 * t) * (0.65 + rng() * 0.7));
  } else {
    population = Math.round((60000 + 340000 * t) * (0.7 + rng() * 0.6));
  }
  population = Math.round(clamp(population, popSpan[0], popSpan[1]));

  return {
    id: `${level}:${cx},${cz}`,
    level,
    x: site.x,
    z: site.z,
    radius: R,
    population,
    name: makeName(rng, level),
    seed,
  };
}

function ensureSite(level, cx, cz) {
  const cache = siteCaches[level];
  if (!cache) throw new Error(`unknown settlement level: ${level}`);
  const key = cx + ',' + cz;
  if (cache.has(key)) return cache.get(key);
  return store(cache, key, buildSite(level, cx, cz));
}

/**
 * Settlement in the given layer cell, or null. Deterministic and cached.
 * Levels: 'metro' (32768 m), 'town' (8192 m), 'village' (4096 m), 'hamlet' (2048 m).
 */
export function settlementAtCell(level, cx, cz) {
  const cache = settlementCaches[level];
  if (!cache) throw new Error(`unknown settlement level: ${level}`);
  const key = cx + ',' + cz;
  if (cache.has(key)) return cache.get(key);

  const site = ensureSite(level, cx, cz);
  if (!site) return store(cache, key, null);

  // Sites are cached by cell and may predate a real DEM load, when open sea
  // was still procedural dry land. Re-validate the centre against the current
  // ground before generating a layout, so a stale site can never build a
  // floating city on water.
  if (baseHeight(site.x, site.z) < MIN_SITE_HEIGHT) return store(cache, key, null);

  // Layout randomness is independent of the site-phase draws, so building
  // arrays can be generated later without replaying the site RNG.
  const rng = mulberry32((site.seed ^ LAYOUT_MIX) >>> 0);
  const heightAt = heightSampler(site.x, site.z, site.radius);
  let layout;
  if (level === 'metro') layout = layoutMetro(site.x, site.z, site.radius, rng, heightAt);
  else if (level === 'town') layout = layoutTown(site.x, site.z, site.radius, rng, heightAt);
  else if (level === 'village') layout = layoutVillage(site.x, site.z, site.radius, rng, heightAt);
  else layout = layoutHamlet(site.x, site.z, site.radius, rng, heightAt);

  return store(cache, key, {
    id: site.id,
    type: level,
    x: r2(site.x),
    z: r2(site.z),
    radius: r2(site.radius),
    population: site.population,
    name: site.name,
    seed: site.seed,
    buildings: layout.buildings,
    roads: layout.roads,
  });
}

const NEAR_CACHE = new Map();
const NEAR_CACHE_MAX = 512;

const dist2 = (s, x, z) => {
  const dx = s.x - x;
  const dz = s.z - z;
  return dx * dx + dz * dz;
};

/**
 * All settlements whose disc intersects the query circle, nearest first.
 * Queries are quantised to 512 m buckets, so per-frame calls are a Map hit.
 * The returned array is cached and shared: treat it as read-only.
 */
export function settlementsNear(x, z, radius) {
  const rad = Math.max(1, Math.round(radius));
  const qx = Math.floor(x / 512);
  const qz = Math.floor(z / 512);
  const key = qx + ',' + qz + ',' + rad;
  const hit = NEAR_CACHE.get(key);
  if (hit) return hit;

  const seen = new Set();
  const out = [];
  for (const layer of SETTLEMENT_LAYERS) {
    const cell = layer.cell;
    const reach = rad + layer.radius[1];
    const cx0 = Math.floor((x - rad) / cell);
    const cx1 = Math.floor((x + rad) / cell);
    const cz0 = Math.floor((z - rad) / cell);
    const cz1 = Math.floor((z + rad) / cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      // Distance from the query point to this cell's rectangle: cells whose
      // rectangle is entirely too far can be skipped before generating.
      const nearX = Math.max(cx * cell, Math.min(x, (cx + 1) * cell));
      const ddx = nearX - x;
      for (let cz = cz0; cz <= cz1; cz++) {
        const nearZ = Math.max(cz * cell, Math.min(z, (cz + 1) * cell));
        const ddz = nearZ - z;
        if (ddx * ddx + ddz * ddz > reach * reach) continue;
        const site = ensureSite(layer.level, cx, cz);
        if (!site || seen.has(site.id)) continue;
        const lim = rad + site.radius;
        if (dist2(site, x, z) > lim * lim) continue;
        const s = settlementAtCell(layer.level, cx, cz);
        if (!s) continue;
        seen.add(s.id);
        out.push(s);
      }
    }
  }
  out.sort((a, b) => dist2(a, x, z) - dist2(b, x, z));

  if (NEAR_CACHE.size >= NEAR_CACHE_MAX) {
    const first = NEAR_CACHE.keys().next().value;
    NEAR_CACHE.delete(first);
  }
  NEAR_CACHE.set(key, out);
  return out;
}

const NEAREST_CACHE = new Map();

/** Closest settlement centre to (x,z), or null. Cached per 512 m bucket. */
export function nearestSettlement(x, z) {
  const key = Math.floor(x / 512) + ',' + Math.floor(z / 512);
  const hit = NEAREST_CACHE.get(key);
  if (hit !== undefined) return hit;
  const list = settlementsNear(x, z, 24000);
  let best = null;
  let bestD = Infinity;
  for (const s of list) {
    const d = dist2(s, x, z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (NEAREST_CACHE.size > 256) NEAREST_CACHE.clear();
  NEAREST_CACHE.set(key, best);
  return best;
}

/**
 * Drop every cached procedural site, layout and proximity result.
 *
 * Site selection reads the active terrain, so a cache filled before a real DEM
 * (or live Terrarium tile) loaded can describe land that is now sea. Callers
 * that swap theaters should clear it; generation itself is deterministic, so
 * the next query simply rebuilds the same sites against the new terrain.
 */
export function clearSettlementCaches() {
  for (const level of SETTLEMENT_LAYERS) {
    settlementCaches[level.level].clear();
    siteCaches[level.level].clear();
  }
  NEAR_CACHE.clear();
  NEAREST_CACHE.clear();
}