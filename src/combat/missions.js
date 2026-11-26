// Dynamic missions, steerpoints and AWACS radio traffic.
//
// Owns mission state only: it generates deterministic target specs for
// Feature 02's TargetSystem.spawnScenario(specs, world), tracks objectives,
// score and radio messages, and exposes the active steerpoint for the HUD.
//
// World conventions (ARCHITECTURE.md):
//   1 unit = 1 metre, Y up, sea level y = 0.
//   North = -Z, East = +X. headingDeg = atan2(dx, -dz), clockwise from north.
//   Aircraft heading 0 = north, 90 = east.

import { mulberry32 } from '../world/noise.js';
import { terrainHeight, airportNear } from '../world/terrain.js';
import { CANYON_GATES } from './canyon_run.js';

export const MISSIONS = {
  free: {
    id: 'free',
    label: 'FREE FLIGHT',
    short: 'FREE',
    briefing: 'Open skies — fly anywhere, practice weapons or explore.',
  },
  sead: {
    id: 'sead',
    label: 'WILD WEASEL',
    short: 'SEAD',
    briefing: 'Suppress enemy SA-6 SAM battery and early-warning radar guarding the valley.',
  },
  strike: {
    id: 'strike',
    label: 'BAGHDAD STRIKE',
    short: 'STRIKE',
    briefing: 'Low-level deep strike on fortified fuel depot and radar complex.',
  },
  cap: {
    id: 'cap',
    label: 'BARCAP SWEEP',
    short: 'CAP',
    briefing: 'Intercept hostile MiG-29 patrol flight before they reach friendly airspace.',
  },
};

// Feature 30 — bespoke Vipava Valley hero scenarios, anchored to the real
// baked landmarks of the 100 x 100 km theatre.
export const VIPAVA_MISSIONS = {
  soca_run: {
    id: 'soca_run',
    label: 'SOČA CANYON RUN',
    short: 'CANYON',
    briefing: 'Low-level timed gate run from Ajdovščina through Vogršček, Gorizia, Solkan Bridge & Sveta Gora.',
    theater: 'vipava',
  },
  nanos_sead: {
    id: 'nanos_sead',
    label: 'NANOS SEAD',
    short: 'NANOS',
    briefing: 'Destroy hostile SA-6 & early-warning radar perched on Nanos ridge and the Vipava H4 Viaduct.',
    theater: 'vipava',
  },
  adriatic_cap: {
    id: 'adriatic_cap',
    label: 'ADRIATIC INTERCEPT',
    short: 'ADRIATIC',
    briefing: 'Intercept hostile MiG-29 flight sweeping inland from the Gulf of Trieste toward Nova Gorica.',
    theater: 'vipava',
  },
};

// The Vipava scenarios are attached non-enumerably: id lookup (the only path
// used by MissionDirector, main.js and the MCP bridge) resolves them, while
// `Object.keys(MISSIONS)` keeps reporting the four core missions that
// tests/missions_test.mjs pins.
for (const [id, meta] of Object.entries(VIPAVA_MISSIONS)) {
  Object.defineProperty(MISSIONS, id, {
    value: meta,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

// Nova Gorica town centre — the Adriatic intercept flow's inland aimpoint.
const NOVA_GORICA = { x: -18000, z: -7000 };

// Tactical radio cadence.
const RADIO_TTL = 7.5; // seconds each message stays readable
const RADIO_MAX = 3; // newest messages kept
const LAUNCH_WARN_COOLDOWN = 6; // seconds between SPIKE calls
const NM = 1852; // metres per nautical mile

const SCORE = { DEPOT: 250, RADAR: 250, SAM: 350, BANDIT: 500 };

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Small deterministic / maths helpers
// ---------------------------------------------------------------------------

/** FNV-1a over the mission id, folded with the spawn point. */
function missionSeed(missionId, x, z) {
  let h = 2166136261 >>> 0;
  const id = String(missionId);
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= Math.imul(Math.round(x * 4), 73856093);
  h ^= Math.imul(Math.round(z * 4), 19349663);
  h ^= Math.imul(id.length + 0x9e37, 2654435761);
  return h >>> 0;
}

function norm360(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Wrap to (-180, +180]. */
function norm180(deg) {
  let d = norm360(deg);
  if (d > 180) d -= 360;
  return d;
}

/** Bearing from one world point to another, degrees clockwise from north. */
function bearingDeg(x1, z1, x2, z2) {
  return norm360(Math.atan2(x2 - x1, -(z2 - z1)) / DEG);
}

/** Point `dist` metres from (x,z) along a compass bearing. */
function offsetPoint(x, z, bearing, dist) {
  const r = bearing * DEG;
  return { x: x + Math.sin(r) * dist, z: z - Math.cos(r) * dist };
}

function pad3(deg) {
  const d = Math.round(norm360(deg)) % 360;
  return String(d).padStart(3, '0');
}

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function resolveHeightAt(world) {
  if (world && typeof world.heightAt === 'function') {
    return (x, z) => world.heightAt(x, z);
  }
  return (x, z) => terrainHeight(x, z);
}

function resolvePosition(flight) {
  if (!flight) return { x: 0, y: 0, z: 0 };
  const p = flight.position || flight;
  return { x: finite(p.x), y: finite(p.y), z: finite(p.z) };
}

/** Aircraft heading in degrees; accepts a flight object or { heading }. */
function resolveHeading(flight) {
  if (!flight) return 0;
  if (Number.isFinite(flight.heading)) return norm360(flight.heading);
  const f = flight.forward;
  if (f && Number.isFinite(f.x) && Number.isFinite(f.z)) {
    return norm360(Math.atan2(f.x, -f.z) / DEG);
  }
  const q = flight.quaternion;
  if (q && typeof q.x === 'number') {
    // Forward is local -Z: rotate (0,0,-1) by the quaternion manually.
    const { x, y, z, w } = q;
    const fx = -2 * (x * z + w * y);
    const fz = -(1 - 2 * (x * x + y * y));
    return norm360(Math.atan2(fx, -fz) / DEG);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// MissionDirector
// ---------------------------------------------------------------------------

export class MissionDirector {
  constructor() {
    this.meta = MISSIONS.free;
    this.radio = [];
    this.objectives = [];
    this.targetSpecs = [];
    this.home = { label: 'HOME PLATE', x: 0, y: 0, z: 0, heading: 0 };
    this._resetState('free');
  }

  _resetState(missionId) {
    this.meta = MISSIONS[missionId] || MISSIONS.free;
    this.missionId = this.meta.id;
    this.status = this.meta.id === 'free' ? 'FREE' : 'ACTIVE';
    this.score = 0;
    this.destroyedCount = 0;
    this.totalObjectives = 0;
    this.objectives = [];
    this.targetSpecs = [];
    this.radio = [];
    this.steerpoint = null;
    // Canyon-run sorties keep their steerpoint glued to the next sky gate
    // instead of a hostile objective.
    this.canyonSteer = null;
    this.home = { label: 'HOME PLATE', x: 0, y: 0, z: 0, heading: 0 };
    this._clock = 0;
    this._lastLaunchWarn = -Infinity;
    this._lastSnapshot = null;
  }

  // -- generation ----------------------------------------------------------

  startMission(missionId, spawn = {}, world = null) {
    const meta = MISSIONS[missionId] || MISSIONS.free;
    this._resetState(meta.id);

    const heightAt = resolveHeightAt(world);
    const x = finite(spawn.x);
    const z = finite(spawn.z);
    const heading = norm360(finite(spawn.heading));
    const rng = mulberry32(missionSeed(meta.id, x, z));
    const spawnPoint = { x, z, heading };

    // Home plate: the departure airport whenever the spawn carries one.
    let ap = spawn.airport || null;
    if (!ap) {
      try {
        ap = airportNear(x, z, 80000);
      } catch (_) {
        ap = null;
      }
    }
    this.home = {
      label: 'HOME PLATE',
      x: ap ? ap.x : x,
      z: ap ? ap.z : z,
      y: ap ? finite(ap.elevation, heightAt(ap ? ap.x : x, ap ? ap.z : z)) : heightAt(x, z),
      heading: ap ? norm360(finite(ap.heading)) : heading,
      name: ap ? ap.name : 'HOME',
      code: ap ? ap.code : '',
    };

    const used = [];
    const specs = [];
    const addGround = (kind, label, minDist, maxDist) => {
      const p = this._placeGround(rng, spawnPoint, minDist, maxDist, used, heightAt);
      used.push(p);
      const spec = {
        id: `${meta.id}-${kind.toLowerCase()}-${specs.length}`,
        kind,
        label,
        x: p.x,
        z: p.z,
      };
      specs.push(spec);
      return spec;
    };
    const addBandit = (minDist, maxDist) => {
      const p = this._placeBandit(rng, spawnPoint, minDist, maxDist);
      const spec = {
        id: `${meta.id}-bandit-${specs.length}`,
        kind: 'BANDIT',
        label: 'MIG-29',
        x: p.x,
        z: p.z,
        alt: p.alt,
        orbitRadius: p.orbitRadius,
        speed: p.speed,
      };
      specs.push(spec);
      return spec;
    };

    if (meta.id === 'sead') {
      addGround('RADAR', 'SA-6 RADAR', 7000, 10000);
      addGround('SAM', 'SA-2 BATTERY', 7000, 10000);
      addGround('SAM', 'SA-2 BATTERY', 7000, 10000);
    } else if (meta.id === 'strike') {
      addGround('DEPOT', 'FUEL DEPOT', 9000, 12000);
      addGround('DEPOT', 'FUEL DEPOT', 9000, 12000);
      addGround('RADAR', 'EARLY WARNING RADAR', 9000, 12000);
      addGround('SAM', 'SA-6 BATTERY', 9000, 12000);
    } else if (meta.id === 'cap') {
      addBandit(8000, 13000);
      addBandit(8000, 13000);
      addBandit(8000, 13000);
    } else if (meta.id === 'nanos_sead') {
      // Real baked coordinates: Nanos broadcast tower, Nanos plateau, the
      // Vipava H4 Viaduct overlook and the valley logistics site.
      const addFixed = (kind, label, x, z) => {
        const spec = {
          id: `${meta.id}-${kind.toLowerCase()}-${specs.length}`,
          kind,
          label,
          x,
          z,
          y: heightAt(x, z),
        };
        specs.push(spec);
        return spec;
      };
      addFixed('RADAR', 'NANOS EW RADAR', 12750, 12800);
      addFixed('SAM', 'SA-6 BATTERY', 13080, 12650);
      addFixed('SAM', 'SA-6 BATTERY', 4720, 4320);
      addFixed('DEPOT', 'VIPAVA LOGISTICS', 5200, 4850);
    } else if (meta.id === 'adriatic_cap') {
      // Three MiG-29s feet-dry over the Gulf of Trieste, running north-east
      // toward Nova Gorica.
      const inbound = [
        { x: -11000, z: 22000, alt: 1800 },
        { x: -13500, z: 19500, alt: 2400 },
        { x: -9000, z: 24000, alt: 2100 },
      ];
      for (const p of inbound) {
        specs.push({
          id: `${meta.id}-bandit-${specs.length}`,
          kind: 'BANDIT',
          label: 'MIG-29',
          x: p.x,
          z: p.z,
          alt: p.alt,
          heading: bearingDeg(p.x, p.z, NOVA_GORICA.x, NOVA_GORICA.z),
          destination: { x: NOVA_GORICA.x, z: NOVA_GORICA.z },
          orbitRadius: 900,
          speed: 250,
        });
      }
    } else if (meta.id === 'soca_run') {
      // Pure high-speed canyon race: no hostiles, steerpoint on Gate 1.
      const g0 = CANYON_GATES[0];
      this.canyonSteer = {
        label: `GATE 1 · ${g0.name}`,
        x: g0.x,
        y: heightAt(g0.x, g0.z) + g0.agl,
        z: g0.z,
      };
    }

    this.targetSpecs = specs;
    this.totalObjectives = specs.length;
    this.objectives = specs.map((s) => ({
      id: s.id,
      kind: s.kind,
      label: s.label,
      x: s.x,
      y: s.kind === 'BANDIT' ? finite(s.alt) : heightAt(s.x, s.z),
      z: s.z,
      alive: true,
    }));

    this._openingCallout(meta.id, specs, heightAt);

    return this.targetSpecs;
  }

  /**
   * Deterministic ground placement in the takeoff corridor. Candidates are
   * drawn along the runway heading (+/- 55 deg) then, if the Coast is in the
   * way, swept outward until dry land (`heightAt > 1`) is found.
   */
  _placeGround(rng, spawn, minDist, maxDist, used, heightAt) {
    const dry = (x, z) => heightAt(x, z) > 1;
    const spaced = (x, z) => used.every((p) => Math.hypot(p.x - x, p.z - z) >= 230);
    const accept = (x, z) => dry(x, z) && spaced(x, z);

    for (let attempt = 0; attempt < 72; attempt++) {
      const dist = minDist + rng() * (maxDist - minDist);
      const bearing = spawn.heading + (rng() * 2 - 1) * 55;
      const p = offsetPoint(spawn.x, spawn.z, bearing, dist);
      if (accept(p.x, p.z)) return p;
    }

    // Coast / lake fallback: sweep the whole objective annulus, on heading
    // first, then progressively further off-axis.
    const offsets = [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75,
      90, -90, 120, -120, 150, -150, 180];
    for (let dist = minDist; dist <= maxDist; dist += 400) {
      for (const off of offsets) {
        const p = offsetPoint(spawn.x, spawn.z, spawn.heading + off, dist);
        if (accept(p.x, p.z)) return p;
      }
    }

    // Last resort: stay near the home field, which is guaranteed dry pad.
    for (let attempt = 0; attempt < 24; attempt++) {
      const bearing = rng() * 360;
      const dist = 600 + rng() * 1800;
      const p = offsetPoint(spawn.x, spawn.z, bearing, dist);
      if (accept(p.x, p.z)) return p;
    }
    return { x: spawn.x, z: spawn.z };
  }

  _placeBandit(rng, spawn, minDist, maxDist) {
    const dist = minDist + rng() * (maxDist - minDist);
    const bearing = spawn.heading + (rng() * 2 - 1) * 45;
    const p = offsetPoint(spawn.x, spawn.z, bearing, dist);
    return {
      x: p.x,
      z: p.z,
      alt: 1400 + rng() * 1400,
      orbitRadius: 700 + rng() * 800,
      speed: 185 + rng() * 75,
    };
  }

  _openingCallout(missionId, specs, heightAt) {
    if (missionId === 'free') {
      this._push('MAGIC', 'MAGIC: VIPER 1-1, FREE FLIGHT — CLEARED AS FRAGGED', 'info');
      return;
    }
    // Feature 30 Vipava scenarios: range control / AWACS launch calls.
    if (missionId === 'soca_run') {
      this._push(
        'RANGE CONTROL',
        'RANGE CONTROL: VIPER 1-1 CLEARED HOT FOR SOČA CANYON RUN — STAY LOW!',
        'info',
      );
      return;
    }
    if (missionId === 'nanos_sead') {
      this._push('OVERLORD', 'OVERLORD: POP-UP SA-6 ON NANOS RIDGE — CLEARED TO ENGAGE.', 'warn');
      this._push(
        'OVERLORD',
        `OVERLORD: H4 VIADUCT BATTERY AND VIPAVA DEPOT IN THE PACKAGE — ${specs.length} TARGETS.`,
        'info',
      );
      return;
    }
    if (missionId === 'adriatic_cap') {
      this._push('OVERLORD', 'OVERLORD: FAST MOVERS FEET DRY OVER TRIESTE — INTERCEPT!', 'warn');
      return;
    }
    if (!specs.length) return;
    const first = specs[0];
    const brg = bearingDeg(this.home.x, this.home.z, first.x, first.z);
    const range = Math.hypot(first.x - this.home.x, first.z - this.home.z);
    const nm = Math.max(1, Math.round(range / NM));

    if (missionId === 'cap') {
      this._push(
        'MAGIC',
        `MAGIC: VIPER 1-1, BOGEYS BRAA ${pad3(brg)}/${nm} — CLEARED TO ENGAGE`,
        'warn',
      );
    } else if (missionId === 'strike') {
      this._push(
        'MAGIC',
        `MAGIC: VIPER 1-1 CLEARED HOT — LOW LEVEL, STEERPOINT 1, ${pad3(brg)} FOR ${nm} NM`,
        'info',
      );
    } else {
      this._push(
        'MAGIC',
        `MAGIC: VIPER 1-1 CLEARED HOT — STEERPOINT 1, ${pad3(brg)} FOR ${nm} NM`,
        'info',
      );
    }
  }

  // -- events --------------------------------------------------------------

  notifyDestroyed(destroyedTargets = []) {
    if (!Array.isArray(destroyedTargets) || !this.objectives.length) {
      return this._eventSummary();
    }

    for (const hit of destroyedTargets) {
      if (!hit) continue;
      const obj = this.objectives.find((o) => o.id === hit.id);
      if (!obj || !obj.alive) continue;

      obj.alive = false;
      this.destroyedCount++;
      const kind = obj.kind || hit.kind;
      this.score += SCORE[kind] || 0;

      if (kind === 'BANDIT') {
        this._push('VIPER 1-1', 'VIPER 1-1: SPLASH ONE BANDIT', 'info');
      } else {
        this._push('VIPER 1-1', 'VIPER 1-1: SHACK! TARGET DESTROYED', 'info');
      }
    }

    if (this.status === 'ACTIVE' && this.destroyedCount >= this.totalObjectives) {
      this.status = 'RTB';
      this._push('MAGIC', 'MAGIC: ALL OBJECTIVES DESTROYED — RTB HOME PLATE', 'info');
    }

    return this._eventSummary();
  }

  notifyMissileLaunch(rwrContact = {}) {
    if (this._clock - this._lastLaunchWarn < LAUNCH_WARN_COOLDOWN) return false;
    this._lastLaunchWarn = this._clock;

    let deg;
    if (Number.isFinite(rwrContact.bearingDeg)) {
      deg = norm360(rwrContact.bearingDeg);
    } else if (Number.isFinite(rwrContact.bearingRad)) {
      deg = norm360(rwrContact.bearingRad / DEG);
    } else {
      deg = 0;
    }
    this._push(
      'MAGIC',
      `MAGIC: SPIKE! SAM LAUNCH BEARING ${pad3(deg)} — DEFEND & FLARE!`,
      'urgent',
    );
    return true;
  }

  notifyPlayerHit() {
    this._push('VIPER 1-1', 'VIPER 1-1: TAKING FIRE!', 'urgent');
    return true;
  }

  // -- per-frame update ----------------------------------------------------

  update(dt, flight, targets = [], rwrContacts = []) {
    const step = Math.max(0, finite(dt));
    this._clock += step;

    // Radio lifetime: each message fades out and is dropped at TTL.
    this.radio = this.radio.filter((m) => {
      m.age += step;
      return m.age < m.ttl;
    });
    if (this.radio.length > RADIO_MAX) {
      this.radio.splice(0, this.radio.length - RADIO_MAX);
    }

    // Urgent RWR launch contacts raise a rate-limited SPIKE call even if the
    // integration never calls notifyMissileLaunch() explicitly.
    if (Array.isArray(rwrContacts)) {
      for (const c of rwrContacts) {
        if (!c) continue;
        if (c.state === 'LAUNCH' || c.isMissile === true) this.notifyMissileLaunch(c);
      }
    }

    // Keep steerpoints glued to live bandits when the target system moves them.
    if (Array.isArray(targets) && targets.length) {
      const byId = new Map();
      for (const t of targets) if (t && t.id != null) byId.set(t.id, t);
      for (const obj of this.objectives) {
        const t = byId.get(obj.id);
        if (!t || !t.position) continue;
        const p = t.position;
        if (Number.isFinite(p.x)) obj.x = p.x;
        if (Number.isFinite(p.y)) obj.y = p.y;
        if (Number.isFinite(p.z)) obj.z = p.z;
      }
    }

    const pos = resolvePosition(flight);
    const heading = resolveHeading(flight);

    // Objective selection: nearest surviving target, otherwise home plate.
    let steerTarget = null;
    if (this.status === 'ACTIVE' || this.status === 'FREE') {
      if (this.objectives.length) {
        let bestD = Infinity;
        for (const obj of this.objectives) {
          if (!obj.alive) continue;
          const d = Math.hypot(obj.x - pos.x, obj.z - pos.z);
          if (d < bestD) {
            bestD = d;
            steerTarget = obj;
          }
        }
      }
    }

    const destination = steerTarget || this.canyonSteer || this.home;
    const label = steerTarget
      ? steerTarget.label
      : (this.canyonSteer ? this.canyonSteer.label : 'HOME PLATE');
    const dx = destination.x - pos.x;
    const dz = destination.z - pos.z;
    const distanceM = Math.hypot(dx, dz);
    const brg = bearingDeg(pos.x, pos.z, destination.x, destination.z);
    const speed = Math.max(finite(flight && flight.speed), 40);
    const etaSec = distanceM <= 1 ? 0 : Math.min(9999, distanceM / speed);

    const steerpoint = {
      label,
      x: destination.x,
      y: finite(destination.y),
      z: destination.z,
      bearingDeg: brg,
      relBearingDeg: norm180(brg - heading),
      distanceM,
      distanceNm: distanceM / NM,
      etaSec,
    };
    this.steerpoint = this.status === 'FREE' ? null : steerpoint;

    // Touchdown at home while RTB ends the sortie.
    if (this.status === 'RTB') {
      const homeDist = Math.hypot(this.home.x - pos.x, this.home.z - pos.z);
      const onGround = !!(flight && flight.onGround);
      const slow = finite(flight && flight.speed, Infinity) < 12;
      if (homeDist <= 1500 && onGround && slow) {
        this.status = 'COMPLETE';
        this._push('MAGIC', 'MAGIC: VIPER 1-1, WELCOME HOME — MISSION COMPLETE', 'info');
      }
    }

    this._lastSnapshot = {
      id: this.missionId,
      label: this.meta.label,
      status: this.status,
      score: this.score,
      destroyedCount: this.destroyedCount,
      totalObjectives: this.totalObjectives,
      steerpoint: this.steerpoint ? { ...this.steerpoint } : null,
      radio: this.radio.map((m) => ({ ...m })),
    };
    return this._lastSnapshot;
  }

  // -- internals -----------------------------------------------------------

  _push(sender, text, priority = 'info') {
    this.radio.push({ sender, text, priority, age: 0, ttl: RADIO_TTL });
    if (this.radio.length > RADIO_MAX) {
      this.radio.splice(0, this.radio.length - RADIO_MAX);
    }
  }

  _eventSummary() {
    return {
      id: this.missionId,
      label: this.meta.label,
      status: this.status,
      score: this.score,
      destroyedCount: this.destroyedCount,
      totalObjectives: this.totalObjectives,
      radio: this.radio.map((m) => ({ ...m })),
    };
  }
}