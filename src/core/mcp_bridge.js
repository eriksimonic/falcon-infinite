// FALCON / INFINITE — browser-side MCP bridge client (Feature 11).
//
// The local MCP server (mcp/server.mjs) listens on 127.0.0.1:5179. This module
// long-polls it for tool commands, executes them against window.__falcon, and
// posts telemetry snapshots plus tool results back over plain HTTP.
//
// Ownership: this file never touches the render loop or the DOM tree. It reads
// and mutates the live app objects that main.js already owns, and it injects
// virtual key state through the existing Input layer so flight commands travel
// the same path as real pilot input.
//
// Load it from the game entry point with:
//   import { attachMcpBridge } from './core/mcp_bridge.js';
//   attachMcpBridge(app);
// or import it anywhere with the page opened as.../?mcp=1 (or in Vite dev
// mode) and it self-installs once window.__falcon exists.

import { CONFIG, WEATHER, WIND, THEATERS } from '../config.js';

export const BRIDGE_URL = 'http://127.0.0.1:5179';
export const BRIDGE_VERSION = '1.0.0';

const AP_MODES = ['OFF', 'ALT_HDG', 'ATT'];
const CAMERA_MODES = ['cockpit', 'chase', 'wing', 'orbit'];
const WEAPON_TYPES = ['GUN', 'AIM9', 'MK82'];
const RADIO_PRIORITIES = ['info', 'warn', 'urgent'];
const MISSION_IDS = ['free', 'sead', 'strike', 'cap'];

const FUEL_CAPACITY_LB = 7160; // F-16C internal fuel, pounds
const RADIO_TTL = 7.5;
const RADIO_MAX = 3;
const METERS_TO_FEET = 3.280839895;
const MPS_TO_KTS = 1.943844492;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const TOOL_NAMES = [
  'get_telemetry',
  'set_flight_state',
  'set_controls',
  'combat_action',
  'set_environment',
  'start_mission',
  'send_radio',
  'capture_screenshot',
];

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small helpers — deliberately free of THREE so the bridge loads in Node tests
// ---------------------------------------------------------------------------

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function finite(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function round(v, dp = 1) {
  const m = 10 ** dp;
  return Math.round(v * m) / m;
}

function norm360(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

function norm180(deg) {
  let d = norm360(deg);
  if (d > 180) d -= 360;
  return d;
}

function attempt(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function attemptAsync(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function readVec(v) {
  if (!v) return null;
  const x = finite(v.x, null);
  const y = finite(v.y, null);
  const z = finite(v.z, null);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function writeVec(v, x, y, z) {
  if (!v) return false;
  if (typeof v.set === 'function') {
    v.set(x, y, z);
    return true;
  }
  v.x = x;
  v.y = y;
  v.z = z;
  return true;
}

function setHeadingQuaternion(q, headingDeg) {
  if (!q) return false;
  const angle = -norm360(headingDeg) * DEG;
  if (typeof q.setFromAxisAngle === 'function') {
    q.setFromAxisAngle({ x: 0, y: 1, z: 0 }, angle);
    return true;
  }
  const half = angle / 2;
  q.x = 0;
  q.y = Math.sin(half);
  q.z = 0;
  q.w = Math.cos(half);
  return true;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

function externalFuelLb(app) {
  const fuel = app && app.fuel;
  if (!fuel) return null;
  for (const key of ['lb', 'lbs', 'fuelLb', 'quantity']) {
    const v = finite(fuel[key], null);
    if (v !== null) return v;
  }
  return null;
}

function normalizeRadio(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m.text === 'string')
    .slice(-RADIO_MAX)
    .map((m) => ({
      sender: String(m.sender || ''),
      text: String(m.text),
      priority: RADIO_PRIORITIES.includes(m.priority) ? m.priority : 'info',
    }));
}

function missionSummary(app, state) {
  const director = app && app.missions ? app.missions : null;
  const alt = app && app.mission && typeof app.mission === 'object' ? app.mission : null;
  const source = director || alt;

  if (!source) {
    const radio = normalizeRadio(state.radio);
    if (!radio.length) return null;
    return { id: null, label: null, status: 'ACTIVE', score: 0, objectives: null, steerpoint: null, radio };
  }

  const meta = source.meta && typeof source.meta === 'object' ? source.meta : {};
  const id = source.missionId || source.id || meta.id || null;
  const steer = source.steerpoint && typeof source.steerpoint === 'object'
    ? {
        label: steer_label(source.steerpoint),
        distanceNm: round(finite(source.steerpoint.distanceNm, 0), 2),
        relBearingDeg: round(finite(source.steerpoint.relBearingDeg, 0), 0),
        etaSec: round(finite(source.steerpoint.etaSec, 0), 1),
      }
    : null;

  return {
    id,
    label: source.label || meta.label || id,
    status: source.status || 'ACTIVE',
    score: finite(source.score, 0),
    objectives: {
      total: finite(source.totalObjectives, 0),
      destroyed: finite(source.destroyedCount, 0),
    },
    steerpoint: steer,
    radio: normalizeRadio(director ? director.radio : state.radio),
  };
}

function steer_label(steer) {
  if (!steer) return null;
  if (steer.label) return String(steer.label);
  if (steer.name) return String(steer.name);
  return null;
}

function headingOf(flight) {
  if (!flight) return 0;
  const direct = finite(flight.heading, null);
  if (direct !== null) return norm360(direct);
  const fwd = flight.forward;
  const v = readVec(fwd);
  if (v) return norm360(Math.atan2(v.x, -v.z) * RAD);
  const q = flight.quaternion;
  if (q && typeof q.x === 'number') {
    // Forward is local -Z.
    const fx = -2 * (q.x * q.z + q.w * q.y);
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    return norm360(Math.atan2(fx, -fz) * RAD);
  }
  return 0;
}

function positionOf(flight) {
  return readVec(flight && flight.position) || { x: 0, y: 0, z: 0 };
}

function bearingRangeTo(from, position) {
  const to = readVec(position);
  if (!to) return { bearingDeg: 0, distanceM: 0 };
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return {
    bearingDeg: norm360(Math.atan2(dx, -dz) * RAD),
    distanceM: Math.hypot(dx, dz),
  };
}

function targetSummaries(app, heading, position) {
  const list = app && app.targets && Array.isArray(app.targets.targets) ? app.targets.targets : null;
  if (!list) return [];
  const out = [];
  for (const t of list.slice(0, 20)) {
    if (!t) continue;
    const range = bearingRangeTo(position, t.position);
    out.push({
      id: t.id != null ? t.id : null,
      kind: t.kind || 'UNKNOWN',
      label: t.label || t.kind || 'TARGET',
      alive: t.alive !== false,
      airborne: !!t.airborne,
      distanceM: Math.round(range.distanceM),
      bearingDeg: Math.round(range.bearingDeg),
      relBearingDeg: Math.round(norm180(range.bearingDeg - heading)),
      altFt: Math.round(finite(t.position && t.position.y, 0) * METERS_TO_FEET),
    });
  }
  return out;
}

function rwrSummaries(app, heading, position) {
  const direct = app && app.rwrContacts;
  if (Array.isArray(direct)) {
    return direct.slice(0, 16).map((c) => ({
      id: c && c.id != null ? c.id : null,
      kind: (c && c.kind) || 'SAM',
      state: (c && c.state) || 'SEARCH',
      isMissile: !!(c && c.isMissile),
      bearingRad: round(finite(c && c.bearingRad, 0), 3),
      distanceM: Math.round(finite(c && c.distance, 0)),
    }));
  }

  const targetSystem = app && app.targets;
  if (!targetSystem || !Array.isArray(targetSystem.targets)) return [];
  const contacts = [];
  const push = (id, kind, pos, state, isMissile) => {
    const range = bearingRangeTo(position, pos);
    contacts.push({
      id: id != null ? id : null,
      kind: kind || 'SAM',
      state,
      isMissile,
      bearingRad: round(norm180(range.bearingDeg - heading) * DEG, 3),
      distanceM: Math.round(range.distanceM),
    });
  };
  for (const t of targetSystem.targets) {
    if (!t || t.alive === false || !t.radarActive) continue;
    const state = t.lockState === 'LAUNCH' ? 'LAUNCH' : t.lockState === 'LOCK' ? 'LOCK' : 'SEARCH';
    push(t.id, t.kind, t.position, state, false);
  }
  if (Array.isArray(targetSystem.enemyMissiles)) {
    for (const m of targetSystem.enemyMissiles) {
      if (!m) continue;
      const source = targetSystem.targets.find((t) => t && t.id === m.sourceId);
      push(m.id, source ? source.kind : 'SAM', m.position, 'LAUNCH', true);
    }
  }
  return contacts.slice(0, 16);
}

function ammoSummary(app) {
  const weapons = app && (app.weapons || (app.combat && app.combat.weapons));
  if (!weapons) return null;
  const ammo = weapons.ammo;
  if (!ammo || typeof ammo !== 'object') {
    return { selected: weapons.selected || null, rounds: null };
  }
  const rounds = {};
  for (const key of Object.keys(ammo)) {
    const v = finite(ammo[key], null);
    if (v !== null) rounds[key] = v;
  }
  return { selected: weapons.selected || null, rounds };
}

/**
 * Build the JSON telemetry snapshot exchanged with the MCP server.
 * Every value is finite and JSON-safe; THREE objects never leak through.
 */
export function buildTelemetry(app, state = {}, extra = {}) {
  const aircraft = app && app.aircraft ? app.aircraft : null;
  const flight = aircraft && aircraft.flight ? aircraft.flight : null;
  const pos = positionOf(flight);
  const raw = (aircraft && typeof aircraft.telemetry === 'function')
    ? (attempt(() => aircraft.telemetry(app.weather, app.time, app.sky), null) || {})
    : {};
  const heading = norm360(finite(raw.heading, headingOf(flight)));
  const speedMs = finite(raw.speedMs, finite(flight && flight.speed, 0));
  const aoaRad = finite(flight && flight.aoa, 0);
  const mission = missionSummary(app, state);

  return {
    ts: Date.now(),
    source: 'falcon-infinite/' + BRIDGE_VERSION,
    kts: round(finite(raw.kts, speedMs * MPS_TO_KTS), 1),
    mach: round(finite(raw.mach, speedMs / 340.3), 3),
    altFt: Math.round(finite(raw.altFt, pos.y * METERS_TO_FEET)),
    aglFt: Math.round(finite(raw.aglFt, finite(flight && flight.agl, pos.y) * METERS_TO_FEET)),
    heading: round(heading, 1),
    pitch: round(finite(raw.pitch, finite(flight && flight.pitchDeg, 0)), 1),
    roll: round(finite(raw.roll, finite(flight && flight.rollDeg, 0)), 1),
    throttle: round(finite(raw.throttle, finite(flight && flight.throttle, 0)), 3),
    afterburner: !!finite(raw.afterburner, flight && flight.afterburner),
    g: round(finite(raw.g, finite(flight && flight.gForce, 1)), 2),
    aoa: round(aoaRad * RAD, 1),
    aoaRad: round(aoaRad, 4),
    fuelLb: Math.round(finite(externalFuelLb(app), finite(state.fuelLb, FUEL_CAPACITY_LB))),
    windDir: Math.round(finite(raw.windDir, finite(flight && flight.windDir, 0))),
    windKts: round(finite(raw.windKts, finite(flight && flight.windSpeed, 0) * MPS_TO_KTS), 1),
    mode: (app && app.mode) || 'unknown',
    camera: (aircraft && aircraft.mode) || 'cockpit',
    mission,
    targets: targetSummaries(app, heading, pos),
    rwrContacts: rwrSummaries(app, heading, pos),
    ammo: ammoSummary(app),
    fps: Math.round(finite(app && app.fps, 0)),
    gear: !!finite(raw.gear, flight && flight.gearDown),
    flaps: Math.round(finite(raw.flaps, finite(flight && flight.flapsIndex, 0))),
    brake: !!finite(raw.brake, flight && flight.brake),
    stall: !!finite(raw.stall, flight && flight.stall),
    onGround: !!finite(raw.onGround, flight && flight.onGround),
    crashed: !!finite(raw.crashed, flight && flight.crashed),
    autopilot: state.ap ? { ...state.ap } : { mode: 'OFF' },
    nvg: !!(state.nvg),
    clock: (app && app.time && app.time.clock) || null,
    timeScale: finite(app && app.time && app.time.scale, 1),
    weather: (app && app.weather && app.weather.presetName) || null,
    night: round(numberOr(raw.night, numberOr(app && app.sky && app.sky.night, 0)), 2),
    position: { x: round(pos.x, 1), y: round(pos.y, 1), z: round(pos.z, 1) },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export class McpBridge {
  constructor(app, options = {}) {
    if (!app) throw new Error('McpBridge requires the live game app (window.__falcon)');
    this.app = app;
    this.url = String(options.url || BRIDGE_URL).replace(/\/+$/, '');
    this.options = {
      telemetryMs: finite(options.telemetryMs, 500),
      pollWaitMs: clamp(finite(options.pollWaitMs, 20000), 1000, 30000),
      autoTick: options.autoTick !== false,
      autoConnect: options.autoConnect !== false,
      requestTimeoutMs: finite(options.requestTimeoutMs, 60000),
    };
    this.clientId = String(options.clientId || ('falcon-' + Math.random().toString(36).slice(2, 10)));
    this.state = {
      fuelLb: FUEL_CAPACITY_LB,
      ap: { mode: 'OFF', altitudeFt: null, headingDeg: null },
      radio: [],
      nvg: false,
      burst: null,
      virtual: new Map(),
      pulses: new Set(),
    };
    this.connected = false;
    this.executed = 0;
    this.lastError = null;
    this._running = false;
    this._pollPromise = null;
    this._controller = null;
    this._telemetryTimer = null;
    this._tickTimer = null;
    this._rafId = 0;
    this._lastTick = 0;
    this._telemetryInFlight = false;
    this._apKeys = new Set();
    this._controllers = new Set();
    this._fuelWarned = false;
    this._onVisibility = null;
    this._fetch = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch?.bind(globalThis);
  }

  // ------------------------------------------------------------- lifecycle
  start() {
    if (this._running) return this;
    this._running = true;
    this._controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this._lastTick = Date.now();
    this._pollPromise = this._pollLoop();

    if (this.options.telemetryMs > 0) {
      this._telemetryTimer = setInterval(() => this._postTelemetry(), this.options.telemetryMs);
      if (this._telemetryTimer.unref) this._telemetryTimer.unref();
    }
    if (this.options.autoTick) this._startTicking();

    if (typeof document !== 'undefined' && document.addEventListener) {
      this._onVisibility = () => {
        if (document.hidden) this._releaseApKeys();
      };
      document.addEventListener('visibilitychange', this._onVisibility);
    }

    this._postTelemetry();
    return this;
  }

  stop() {
    if (!this._running) return this;
    this._running = false;
    if (this._controller) this._controller.abort();
    this._controller = null;
    for (const controller of this._controllers) controller.abort();
    this._controllers.clear();
    if (this._telemetryTimer) clearInterval(this._telemetryTimer);
    this._telemetryTimer = null;
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = null;
    if (this._rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    for (const timer of this.state.pulses) clearTimeout(timer);
    this.state.pulses.clear();
    this._releaseApKeys();
    for (const code of Array.from(this.state.virtual.keys())) this._virtualRelease(code);
    if (this._onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
    this._onVisibility = null;
    this.connected = false;
    return this;
  }

  _startTicking() {
    this._lastTick = Date.now();
    if (typeof requestAnimationFrame === 'function') {
      const frame = (now) => {
        if (!this._running) return;
        this._tick(typeof now === 'number' ? now : Date.now());
        this._rafId = requestAnimationFrame(frame);
      };
      this._rafId = requestAnimationFrame(frame);
    } else {
      this._tickTimer = setInterval(() => this._tick(Date.now()), 100);
      if (this._tickTimer.unref) this._tickTimer.unref();
    }
  }

  // ------------------------------------------------------------- transport
  async _request(path, init = {}) {
    if (!this._fetch) throw new BridgeError('NO_FETCH', 'fetch() is unavailable in this browser');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (controller) this._controllers.add(controller);
    const timer = setTimeout(() => controller && controller.abort(), this.options.requestTimeoutMs);
    if (timer.unref) timer.unref();
    try {
      return await this._fetch(this.url + path, {
        cache: 'no-store',
        ...init,
        signal: controller ? controller.signal : init.signal,
      });
    } finally {
      clearTimeout(timer);
      if (controller) this._controllers.delete(controller);
    }
  }

  async _post(path, body) {
    const res = await this._request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('bridge HTTP ' + res.status);
    return res.json().catch(() => null);
  }

  async _pollLoop() {
    let backoff = 300;
    while (this._running) {
      try {
        const res = await this._request(
          '/commands?wait=' + this.options.pollWaitMs + '&client=' + encodeURIComponent(this.clientId),
          { headers: { Accept: 'application/json' } },
        );
        if (!res.ok) throw new Error('bridge HTTP ' + res.status);
        const data = await res.json();
        this.connected = true;
        this.lastError = null;
        backoff = 300;
        const commands = Array.isArray(data && data.commands) ? data.commands : [];
        for (const command of commands) await this._runCommand(command);
      } catch (err) {
        this.connected = false;
        this.lastError = err;
        if (!this._running) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(Math.round(backoff * 1.7), 5000);
      }
    }
  }

  async _runCommand(command) {
    if (!command || typeof command !== 'object' || typeof command.tool !== 'string' || !command.id) return;
    const tool = command.tool;
    const args = command.args && typeof command.args === 'object' ? command.args : {};
    let payload = null;
    let ok = true;
    let error = null;
    try {
      payload = await this.execute(tool, args);
      this.executed++;
    } catch (err) {
      ok = false;
      error = {
        code: err && err.code ? err.code : 'BRIDGE_ERROR',
        message: err && err.message ? String(err.message) : String(err),
      };
    }
    await attemptAsync(() => this._post('/result', { id: command.id, ok, result: payload, error }));
    this._postTelemetry();
  }

  async _postTelemetry() {
    if (!this._running || this._telemetryInFlight) return;
    this._telemetryInFlight = true;
    try {
      await this._post('/telemetry', this.telemetry());
    } catch {
      /* offline: the poll loop owns reconnect/backoff */
    } finally {
      this._telemetryInFlight = false;
    }
  }

  // ------------------------------------------------------------- execution
  telemetry() {
    return buildTelemetry(this.app, this.state);
  }

  async execute(tool, args = {}) {
    if (!TOOL_NAMES.includes(tool)) throw new BridgeError('UNKNOWN_TOOL', 'Unknown tool: ' + tool);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new BridgeError('INVALID_ARGUMENT', 'Tool arguments must be an object');
    }
    switch (tool) {
      case 'get_telemetry':
        return this.telemetry();
      case 'set_flight_state':
        return this.setFlightState(args);
      case 'set_controls':
        return this.setControls(args);
      case 'combat_action':
        return this.combatAction(args);
      case 'set_environment':
        return this.setEnvironment(args);
      case 'start_mission':
        return this.startMission(args);
      case 'send_radio':
        return this.sendRadio(args);
      case 'capture_screenshot':
        return this.captureScreenshot(args);
      default:
        throw new BridgeError('UNKNOWN_TOOL', 'Unknown tool: ' + tool);
    }
  }

  flight() {
    return this.app && this.app.aircraft && this.app.aircraft.flight ? this.app.aircraft.flight : null;
  }

  _ensureFlying() {
    const app = this.app;
    if (!app) return false;
    if (app.mode === 'menu' && app.ready !== false && typeof app.startFlight === 'function') {
      return !!attempt(() => {
        app.startFlight();
        return true;
      }, false);
    }
    return app.mode === 'fly';
  }

  _syncModel(flight) {
    const aircraft = this.app && this.app.aircraft;
    if (!aircraft || !aircraft.model || !flight) return;
    attempt(() => aircraft.model.position.copy(flight.position));
    attempt(() => aircraft.model.quaternion.copy(flight.quaternion));
    aircraft._camInit = false;
  }

  _lockTarget(weaponType) {
    const targetSystem = this.app && this.app.targets;
    const flight = this.flight();
    if (targetSystem && typeof targetSystem.findLockTarget === 'function') {
      return attempt(() => targetSystem.findLockTarget(flight, weaponType), null);
    }
    return (this.app && this.app.lockedTarget) || null;
  }

  _ammo() {
    return ammoSummary(this.app);
  }

  // ------------------------------------------------ set_flight_state
  setFlightState(args = {}) {
    const flight = this.flight();
    if (!flight) throw new BridgeError('UNAVAILABLE', 'No flight model on window.__falcon');
    const applied = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(args, key) && args[key] !== null && args[key] !== undefined;

    this._ensureFlying();

    if (has('throttle')) {
      const v = clamp(numberOr(args.throttle, finite(flight.throttle, 0)), 0, 1);
      flight.targetThrottle = v;
      flight.throttle = v;
      applied.throttle = round(v, 3);
    }

    if (has('autopilot')) {
      const mode = String(args.autopilot).toUpperCase();
      if (!AP_MODES.includes(mode)) {
        throw new BridgeError('INVALID_ARGUMENT', 'autopilot must be one of ' + AP_MODES.join(', '));
      }
      this.state.ap.mode = mode;
      if (mode === 'OFF') this._releaseApKeys();
      applied.autopilot = mode;
    }

    if (has('altitudeFt')) {
      const v = numberOr(args.altitudeFt, null);
      if (v === null) throw new BridgeError('INVALID_ARGUMENT', 'altitudeFt must be a number');
      this.state.ap.altitudeFt = v;
      applied.altitudeFt = Math.round(v);
    }

    if (has('heading')) {
      const v = numberOr(args.heading, null);
      if (v === null) throw new BridgeError('INVALID_ARGUMENT', 'heading must be a number');
      this.state.ap.headingDeg = norm360(v);
      applied.heading = round(this.state.ap.headingDeg, 0);
    }

    if (has('gear')) {
      let down;
      if (typeof args.gear === 'string' && args.gear.toLowerCase() === 'toggle') {
        down = !(flight.gearDown === true || finite(flight.gearTarget, 0) > 0.5);
      } else if (typeof args.gear === 'boolean') {
        down = args.gear;
      } else {
        throw new BridgeError('INVALID_ARGUMENT', 'gear must be true, false or "toggle"');
      }
      flight.gearTarget = down ? 1 : 0;
      flight.gearDown = down;
      applied.gear = down;
    }

    if (has('flaps')) {
      const v = clamp(Math.round(numberOr(args.flaps, finite(flight.flapsIndex, 0))), 0, 2);
      flight.flapsIndex = v;
      applied.flaps = v;
    }

    if (has('brakes')) {
      flight.brake = !!args.brakes;
      applied.brakes = flight.brake;
    }

    if (args.teleport && typeof args.teleport === 'object') {
      applied.teleport = this._teleport(args.teleport, flight);
      this.state.fuelLb = FUEL_CAPACITY_LB;
      this._fuelWarned = false;
    }

    if (!Object.keys(applied).length) {
      throw new BridgeError(
        'INVALID_ARGUMENT',
        'Provide at least one of throttle, autopilot, altitudeFt, heading, gear, flaps, brakes, teleport',
      );
    }

    this._syncModel(flight);
    return {
      ok: true,
      applied,
      autopilot: { ...this.state.ap },
      fuelLb: Math.round(this.telemetry().fuelLb),
    };
  }

  _teleport(tp, flight) {
    const start = positionOf(flight);
    const x = numberOr(tp.x, start.x);
    const z = numberOr(tp.z, start.z);
    let y = numberOr(tp.y, null);
    if (y === null) {
      const ground = attempt(() => this.app.world.heightAt(x, z), null);
      const base = finite(ground, 0);
      y = base + 300;
    }
    const heading = norm360(numberOr(tp.heading, headingOf(flight)));
    const speedMs = clamp(numberOr(tp.speedMs, finite(flight.speed, 0)), 0, 900);

    writeVec(flight.position, x, y, z);
    if (flight.velocity) {
      writeVec(flight.velocity, Math.sin(heading * DEG) * speedMs, 0, -Math.cos(heading * DEG) * speedMs);
    }
    if (flight.rates) writeVec(flight.rates, 0, 0, 0);
    if (flight.controls) {
      flight.controls.pitch = 0;
      flight.controls.roll = 0;
      flight.controls.yaw = 0;
    }
    flight.speed = speedMs;
    flight.onGround = false;
    flight.crashed = false;
    flight.crashReason = '';
    if (typeof flight.gearPos === 'number') {
      flight.gearPos = flight.gearDown === false ? 0 : 1;
      flight.gearTarget = flight.gearPos;
    }
    setHeadingQuaternion(flight.quaternion, heading);
    this._releaseApKeys();
    this._syncModel(flight);
    return { x: round(x, 1), y: round(y, 1), z: round(z, 1), heading: round(heading, 0), speedMs: round(speedMs, 1) };
  }

  // ------------------------------------------------ set_controls
  setControls(args = {}) {
    const durationMs = clamp(Math.round(numberOr(args.durationMs, 1000)), 50, 20000);
    const pitch = clamp(numberOr(args.pitch, 0), -1, 1);
    const roll = clamp(numberOr(args.roll, 0), -1, 1);
    const yaw = clamp(numberOr(args.yaw, 0), -1, 1);
    const throttleDelta = clamp(numberOr(args.throttleDelta, 0), -1, 1);

    const keys = [];
    if (pitch > 0.05) keys.push('KeyS');
    else if (pitch < -0.05) keys.push('KeyW');
    if (roll > 0.05) keys.push('KeyA');
    else if (roll < -0.05) keys.push('KeyD');
    if (yaw > 0.05) keys.push('KeyQ');
    else if (yaw < -0.05) keys.push('KeyE');
    if (throttleDelta > 0.05) keys.push('ShiftLeft');
    else if (throttleDelta < -0.05) keys.push('ControlLeft');

    const applied = { pitch, roll, yaw, throttleDelta };
    if (!keys.length) {
      return { ok: true, applied, keys: [], durationMs, endsAt: null };
    }
    const input = this.app && this.app.input;
    if (!input || !input.down || typeof input.down.add !== 'function') {
      throw new BridgeError('UNAVAILABLE', 'Keyboard input layer is not available');
    }

    this._ensureFlying();
    for (const code of keys) this._virtualPress(code);
    const endsAt = Date.now() + durationMs;
    const timer = setTimeout(() => {
      for (const code of keys) this._virtualRelease(code);
      this.state.pulses.delete(timer);
    }, durationMs);
    if (timer.unref) timer.unref();
    this.state.pulses.add(timer);

    return { ok: true, applied, keys, durationMs, endsAt };
  }

  _virtualPress(code) {
    let rec = this.state.virtual.get(code);
    const input = this.app && this.app.input;
    if (!rec) {
      rec = { count: 0, userHeld: false };
      this.state.virtual.set(code, rec);
    }
    if (rec.count === 0) {
      rec.userHeld = !!(input && input.down && typeof input.down.has === 'function' && input.down.has(code));
    }
    rec.count++;
    if (input && input.down && typeof input.down.add === 'function') input.down.add(code);
  }

  _virtualRelease(code) {
    const rec = this.state.virtual.get(code);
    if (!rec) return;
    rec.count--;
    if (rec.count > 0) return;
    this.state.virtual.delete(code);
    const input = this.app && this.app.input;
    if (rec.userHeld) return;
    if (input && input.down && typeof input.down.delete === 'function') input.down.delete(code);
  }

  _releaseApKeys() {
    for (const code of Array.from(this._apKeys)) {
      this._virtualRelease(code);
      this._apKeys.delete(code);
    }
  }

  // ------------------------------------------------ combat_action
  combatAction(args = {}) {
    const action = String(args.action || '').toLowerCase();
    const weapons = (this.app && this.app.weapons) || (this.app && this.app.combat && this.app.combat.weapons) || null;
    const flight = this.flight();

    if (action === 'toggle_nvg' || action === 'nvg') {
      const tactical = this.app && this.app.tactical;
      let nvg;
      if (tactical && typeof tactical.toggleNVG === 'function') {
        nvg = !!attempt(() => tactical.toggleNVG(), this.state.nvg);
      } else if (tactical && typeof tactical.nvg === 'boolean') {
        tactical.nvg = !tactical.nvg;
        nvg = tactical.nvg;
      } else {
        this.state.nvg = !this.state.nvg;
        nvg = this.state.nvg;
      }
      this.state.nvg = nvg;
      attempt(() => this.app.ui.toast(nvg ? 'NVG ON' : 'NVG OFF'));
      return { ok: true, action: 'toggle_nvg', nvg };
    }

    if (action === 'eject') {
      if (!flight) throw new BridgeError('UNAVAILABLE', 'No flight model on window.__falcon');
      if (typeof this.app.eject === 'function') {
        attempt(() => this.app.eject());
      } else {
        flight.crashed = true;
        flight.crashReason = 'EJECTION';
        attempt(() => this.app.onCrash());
      }
      return { ok: true, action: 'eject', ejected: true, mode: this.app.mode };
    }

    if (action === 'select_weapon' || action === 'select') {
      if (!weapons || typeof weapons.selectWeapon !== 'function') {
        throw new BridgeError('UNAVAILABLE', 'Weapon system is not integrated (window.__falcon.weapons)');
      }
      const type = String(args.weapon || '').toUpperCase();
      if (!WEAPON_TYPES.includes(type)) {
        throw new BridgeError('INVALID_ARGUMENT', 'weapon must be one of ' + WEAPON_TYPES.join(', '));
      }
      const selected = weapons.selectWeapon(type);
      return { ok: true, action: 'select_weapon', weapon: selected, ammo: this._ammo() };
    }

    if (action === 'fire' || action === 'fire_burst') {
      if (!weapons || typeof weapons.fire !== 'function') {
        throw new BridgeError('UNAVAILABLE', 'Weapon system is not integrated (window.__falcon.weapons)');
      }
      if (!flight) throw new BridgeError('UNAVAILABLE', 'No flight model on window.__falcon');
      if (args.weapon && typeof weapons.selectWeapon === 'function') {
        const type = String(args.weapon).toUpperCase();
        if (!WEAPON_TYPES.includes(type)) {
          throw new BridgeError('INVALID_ARGUMENT', 'weapon must be one of ' + WEAPON_TYPES.join(', '));
        }
        weapons.selectWeapon(type);
      }
      this._ensureFlying();
      const weapon = String(weapons.selected || 'GUN');
      const shot = attempt(() => weapons.fire(flight, this._lockTarget(weapon)), { fired: false, reason: 'error' }) || {};
      const burstMs = clamp(Math.round(numberOr(args.burstMs, action === 'fire_burst' ? 1200 : 0)), 0, 5000);
      if (burstMs > 0 && shot.fired) {
        this.state.burst = { weapon, until: Date.now() + burstMs, nextAt: Date.now() + 120 };
      }
      return {
        ok: true,
        action: 'fire',
        weapon,
        fired: !!shot.fired,
        reason: shot.reason || null,
        targetId: shot.targetId != null ? shot.targetId : null,
        burstMs,
        ammo: this._ammo(),
      };
    }

    if (action === 'deploy_flares' || action === 'flares') {
      if (!weapons || typeof weapons.deployFlare !== 'function') {
        throw new BridgeError('UNAVAILABLE', 'Weapon system is not integrated (window.__falcon.weapons)');
      }
      if (!flight) throw new BridgeError('UNAVAILABLE', 'No flight model on window.__falcon');
      const result = attempt(() => weapons.deployFlare(flight), { deployed: false }) || {};
      return { ok: true, action: 'deploy_flares', deployed: !!result.deployed, ammo: this._ammo() };
    }

    throw new BridgeError(
      'INVALID_ARGUMENT',
      'action must be one of select_weapon, fire, deploy_flares, toggle_nvg, eject',
    );
  }

  // ------------------------------------------------ set_environment
  setEnvironment(args = {}) {
    const applied = {};
    const unsupported = [];
    const has = (key) => Object.prototype.hasOwnProperty.call(args, key) && args[key] !== null && args[key] !== undefined;

    if (has('weather')) {
      const key = String(args.weather).toLowerCase();
      if (!WEATHER[key]) throw new BridgeError('INVALID_ARGUMENT', 'Unknown weather: ' + args.weather);
      const weather = this.app && this.app.weather;
      if (!weather || typeof weather.setPreset !== 'function') {
        unsupported.push('weather');
      } else {
        weather.setPreset(key, true);
        applied.weather = key;
        attempt(() => this.app.ui.toast('WEATHER · ' + WEATHER[key].label));
      }
    }

    if (has('wind')) {
      const key = String(args.wind).toLowerCase();
      if (!WIND[key]) throw new BridgeError('INVALID_ARGUMENT', 'Unknown wind preset: ' + args.wind);
      const weather = this.app && this.app.weather;
      if (!weather || typeof weather.setWindPreset !== 'function') {
        unsupported.push('wind');
      } else {
        weather.setWindPreset(key, true);
        applied.wind = key;
        attempt(() => this.app.ui.toast('WIND · ' + WIND[key].label));
      }
    }

    if (has('theater')) {
      const key = String(args.theater).toLowerCase();
      if (!THEATERS[key]) throw new BridgeError('INVALID_ARGUMENT', 'Unknown theater: ' + args.theater);
      let ok = false;
      if (this.app && this.app.sky && typeof this.app.sky.setTheater === 'function') {
        this.app.sky.setTheater(key);
        ok = true;
      }
      const terrain = this.app && this.app.world && this.app.world.terrain;
      if (terrain && typeof terrain.setTheater === 'function') {
        terrain.setTheater(key);
        ok = true;
      }
      if (ok) {
        applied.theater = key;
        attempt(() => this.app.ui.toast('THEATER · ' + THEATERS[key].label));
      } else {
        unsupported.push('theater');
      }
    }

    if (has('hour')) {
      const hour = numberOr(args.hour, null);
      if (hour === null) throw new BridgeError('INVALID_ARGUMENT', 'hour must be a number');
      const time = this.app && this.app.time;
      if (!time || typeof time.setHour !== 'function') {
        unsupported.push('hour');
      } else {
        time.setHour(hour);
        applied.hour = round(finite(time.hour, norm360(hour)), 2);
        attempt(() => this.app.ui.toast('TIME ' + time.clock));
      }
    }

    if (has('timeScale')) {
      const requested = numberOr(args.timeScale, null);
      if (requested === null) throw new BridgeError('INVALID_ARGUMENT', 'timeScale must be a number');
      const time = this.app && this.app.time;
      if (!time || typeof time.setScaleIndex !== 'function') {
        unsupported.push('timeScale');
      } else {
        const scales = CONFIG.time.scales;
        let best = 0;
        let bestDelta = Infinity;
        for (let i = 0; i < scales.length; i++) {
          const delta = Math.abs(scales[i] - requested);
          if (delta < bestDelta) {
            bestDelta = delta;
            best = i;
          }
        }
        time.setScaleIndex(best);
        applied.timeScale = scales[best];
        if (scales[best] !== requested) applied.requestedTimeScale = requested;
      }
    }

    if (has('camera')) {
      const mode = String(args.camera).toLowerCase();
      if (!CAMERA_MODES.includes(mode)) {
        throw new BridgeError('INVALID_ARGUMENT', 'camera must be one of ' + CAMERA_MODES.join(', '));
      }
      const aircraft = this.app && this.app.aircraft;
      if (!aircraft || typeof aircraft.setMode !== 'function') {
        unsupported.push('camera');
      } else {
        aircraft.setMode(mode);
        applied.camera = mode;
      }
    }

    if (!Object.keys(applied).length && !unsupported.length) {
      throw new BridgeError(
        'INVALID_ARGUMENT',
        'Provide at least one of weather, wind, theater, hour, timeScale, camera',
      );
    }

    return { ok: unsupported.length === 0, applied, unsupported };
  }

  // ------------------------------------------------ start_mission
  startMission(args = {}) {
    const missionId = String(args.mission || 'free').toLowerCase();
    if (!MISSION_IDS.includes(missionId)) {
      throw new BridgeError('INVALID_ARGUMENT', 'mission must be one of ' + MISSION_IDS.join(', '));
    }
    const director = this.app && this.app.missions;
    const canRespawn = typeof this.app.respawn === 'function';

    if (args.respawn === true && canRespawn) {
      attempt(() => this.app.respawn());
      this._releaseApKeys();
      this.state.ap.mode = 'OFF';
      this.state.fuelLb = FUEL_CAPACITY_LB;
      this._fuelWarned = false;
    }

    if (!director || typeof director.startMission !== 'function') {
      if (canRespawn) {
        if (args.respawn !== true) attempt(() => this.app.respawn());
        return {
          ok: true,
          mission: { id: missionId, label: null, status: 'RESPAWN' },
          respawned: true,
          targets: this._targetCounts(),
          note: 'Mission director is not integrated; respawned at the runway instead.',
        };
      }
      throw new BridgeError('UNAVAILABLE', 'Mission director is not integrated (window.__falcon.missions)');
    }

    const flight = this.flight();
    const pos = positionOf(flight);
    const spawn = {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      heading: headingOf(flight),
      airport: (this.app.spawn && this.app.spawn.airport) || null,
    };
    const specs = attempt(() => director.startMission(missionId, spawn, this.app.world || null), null);
    if (specs === null) throw new BridgeError('BRIDGE_ERROR', 'Mission generation failed');

    let targets = null;
    const targetSystem = this.app && this.app.targets;
    if (targetSystem && typeof targetSystem.spawnScenario === 'function') {
      const world = this.app.world || { heightAt: () => 0 };
      attempt(() => targetSystem.spawnScenario(Array.isArray(specs) ? specs : [], world));
      targets = this._targetCounts();
    }

    this.state.fuelLb = FUEL_CAPACITY_LB;
    this._fuelWarned = false;
    this.state.ap.mode = 'OFF';
    this._releaseApKeys();

    const meta = director.meta || {};
    return {
      ok: true,
      mission: {
        id: director.missionId || meta.id || missionId,
        label: meta.label || null,
        status: director.status || 'ACTIVE',
        objectives: {
          total: finite(director.totalObjectives, 0),
          destroyed: finite(director.destroyedCount, 0),
        },
      },
      respawned: false,
      targets,
      radio: normalizeRadio(director.radio),
    };
  }

  _targetCounts() {
    const list = this.app && this.app.targets && this.app.targets.targets;
    if (!Array.isArray(list)) return null;
    let alive = 0;
    for (const t of list) if (t && t.alive !== false) alive++;
    return { total: list.length, alive };
  }

  // ------------------------------------------------ send_radio
  sendRadio(args = {}) {
    let text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) throw new BridgeError('INVALID_ARGUMENT', 'text is required');
    if (text.length > 300) text = text.slice(0, 300);
    const sender = String(args.sender || 'MAGIC').trim().slice(0, 24) || 'MAGIC';
    const priority = RADIO_PRIORITIES.includes(args.priority) ? args.priority : 'info';

    const message = { sender, text, priority, age: 0, ttl: RADIO_TTL };
    const director = this.app && this.app.missions;
    let radio = null;
    if (director && Array.isArray(director.radio)) {
      director.radio.push(message);
      while (director.radio.length > RADIO_MAX) director.radio.shift();
      radio = director.radio;
    } else {
      this.state.radio.push(message);
      while (this.state.radio.length > RADIO_MAX) this.state.radio.shift();
      radio = this.state.radio;
    }

    attempt(() => this.app.ui.toast(sender + ': ' + text, priority === 'urgent' ? 5000 : 2600));
    attempt(() => this.app.audio && this.app.audio.radioBeep && this.app.audio.radioBeep());

    return {
      ok: true,
      queued: true,
      sender,
      text,
      priority,
      radio: normalizeRadio(radio),
    };
  }

  // ------------------------------------------------ capture_screenshot
  captureScreenshot(args = {}) {
    if (typeof document === 'undefined') {
      throw new BridgeError('UNAVAILABLE', 'Screenshot capture requires a browser DOM');
    }
    const app = this.app;
    const source = (app && app.canvas) ||
      attempt(() => app.renderer.domElement, null) ||
      document.getElementById('scene');
    if (!source || !source.width || !source.height) {
      throw new BridgeError('UNAVAILABLE', 'No WebGL canvas is available to capture');
    }

    // Render synchronously so the framebuffer is valid even without
    // preserveDrawingBuffer.
    attempt(() => app.renderer.render(app.scene, app.camera));

    const requested = Math.round(numberOr(args.maxWidth, source.width || 1600));
    const maxWidth = clamp(requested, 320, 3840);
    const scale = Math.min(1, maxWidth / Math.max(1, source.width));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    if (!ctx) throw new BridgeError('UNAVAILABLE', 'Could not create a 2D capture context');

    attempt(() => ctx.drawImage(source, 0, 0, width, height));
    const hud = document.getElementById('hud') || (app && app.hud && app.hud.canvas);
    if (hud && hud.width && hud.height) {
      attempt(() => ctx.drawImage(hud, 0, 0, width, height));
    }
    const tactical = document.getElementById('tactical');
    if (tactical && tactical.width && tactical.height) {
      attempt(() => ctx.drawImage(tactical, 0, 0, width, height));
    }

    const url = out.toDataURL('image/png');
    const png = url.replace(/^data:image\/png;base64,/, '');
    return { ok: true, png, width, height, bytes: png.length };
  }

  // ------------------------------------------------ per-frame tick
  _tick(now) {
    const dt = clamp((now - this._lastTick) / 1000, 0, 0.25);
    this._lastTick = now;
    this._fuelTick(dt);
    this._autopilotTick();
    this._burstTick(now);
  }

  _fuelTick(dt) {
    if (!(dt > 0)) return;
    if (externalFuelLb(this.app) !== null) return;
    const flight = this.flight();
    if (!flight || flight.crashed) return;
    const throttle = clamp(finite(flight.throttle, 0), 0, 1);
    const burnPerSec = 0.32 + Math.pow(throttle, 1.6) * 0.95 + (flight.afterburner ? 1.9 : 0);
    this.state.fuelLb = Math.max(0, this.state.fuelLb - burnPerSec * dt);
    if (this.state.fuelLb <= 0 && !this._fuelWarned) {
      this._fuelWarned = true;
      flight.targetThrottle = 0;
      flight.throttle = 0;
      attempt(() => this.app.ui.toast('FUEL EXHAUSTED — ENGINE FLAMEOUT', 5000));
    }
  }

  _autopilotTick() {
    const ap = this.state.ap;
    const flight = this.flight();
    const active = ap.mode !== 'OFF' && this.app.mode === 'fly' && flight && !flight.crashed;
    if (!active) {
      this._releaseApKeys();
      return;
    }

    const want = new Set();
    const pitch = finite(flight.pitchDeg, 0);
    const roll = finite(flight.rollDeg, 0);

    if (ap.mode === 'ATT') {
      if (pitch > 2.5) want.add('KeyW');
      else if (pitch < -2.5) want.add('KeyS');
      if (roll > 2.5) want.add('KeyA');
      else if (roll < -2.5) want.add('KeyD');
    } else {
      const pos = positionOf(flight);
      const targetAltM = ap.altitudeFt !== null ? ap.altitudeFt / METERS_TO_FEET : null;
      if (targetAltM !== null) {
        const targetPitch = clamp((targetAltM - pos.y) * 0.12, -10, 10);
        if (pitch < targetPitch - 1.5) want.add('KeyS');
        else if (pitch > targetPitch + 1.5) want.add('KeyW');
      }
      if (ap.headingDeg !== null) {
        const error = norm180(ap.headingDeg - headingOf(flight)); // + = turn right
        const targetBank = clamp(error * 0.6, -25, 25); // + = right bank
        if (roll < targetBank - 3) want.add('KeyD');
        else if (roll > targetBank + 3) want.add('KeyA');
      }
    }

    for (const code of Array.from(this._apKeys)) {
      if (!want.has(code)) {
        this._virtualRelease(code);
        this._apKeys.delete(code);
      }
    }
    for (const code of want) {
      if (!this._apKeys.has(code)) {
        this._virtualPress(code);
        this._apKeys.add(code);
      }
    }
  }

  _burstTick(now) {
    const burst = this.state.burst;
    if (!burst) return;
    const weapons = (this.app && this.app.weapons) || (this.app && this.app.combat && this.app.combat.weapons) || null;
    const flight = this.flight();
    if (!weapons || !flight || now >= burst.until) {
      this.state.burst = null;
      return;
    }
    if (now < burst.nextAt) return;
    if (typeof weapons.selectWeapon === 'function') weapons.selectWeapon(burst.weapon);
    const shot = attempt(() => weapons.fire(flight, this._lockTarget(burst.weapon)), null);
    burst.nextAt = now + (shot && shot.fired ? 90 : 220);
    if (this._ammo() && this._ammo().rounds && this._ammo().rounds[burst.weapon] === 0) {
      this.state.burst = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Public attach / enablement helpers
// ---------------------------------------------------------------------------

export function isMcpEnabled(location, env) {
  if (env && env.DEV) return true;
  const search = (location && location.search) || '';
  try {
    const params = new URLSearchParams(search);
    const flag = params.get('mcp');
    return flag === '1' || flag === 'true';
  } catch {
    return /[?&]mcp=(1|true)\b/.test(search);
  }
}

export function attachMcpBridge(app, options = {}) {
  if (!app) throw new Error('attachMcpBridge requires window.__falcon');
  if (app.__mcpBridge instanceof McpBridge) return app.__mcpBridge;
  const bridge = new McpBridge(app, options);
  app.__mcpBridge = bridge;
  if (typeof window !== 'undefined') window.__falconMcp = bridge;
  if (options.autoConnect !== false) bridge.start();
  return bridge;
}

// Self-install only in a real browser page that opted in (Vite dev or ?mcp=1).
// In Node (tests) this block is inert.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try {
    if (isMcpEnabled(window.location, import.meta.env) && !window.__falconMcp) {
      let attempts = 0;
      const boot = () => {
        if (window.__falconMcp) return;
        if (window.__falcon) {
          attachMcpBridge(window.__falcon);
          return;
        }
        if (attempts++ < 240) setTimeout(boot, 500);
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        boot();
      }
    }
  } catch {
    /* bridge is optional; never break boot because of it */
  }
}