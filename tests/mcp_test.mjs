// Feature 11 acceptance test — local MCP server + browser bridge.
//
//   node tests/mcp_test.mjs
//
// Part A exercises src/core/mcp_bridge.js headlessly against a fake app.
// Part B boots mcp/server.mjs over stdio, speaks MCP initialize / tools/list /
// tools/call and drives a simulated browser client over the 127.0.0.1 HTTP
// bridge. No browser, no npm dependencies beyond the repo.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpBridge, attachMcpBridge, buildTelemetry } from '../src/core/mcp_bridge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'mcp', 'server.mjs');

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const REQUIRED_TELEMETRY = [
  'kts', 'mach', 'altFt', 'aglFt', 'heading', 'pitch', 'roll', 'throttle',
  'afterburner', 'g', 'aoa', 'fuelLb', 'windDir', 'windKts', 'mode', 'mission',
  'targets', 'rwrContacts', 'ammo', 'fps',
];

// ===========================================================================
// Part A — browser bridge semantics (headless fake app)
// ===========================================================================

class V3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  clone() {
    return new V3(this.x, this.y, this.z);
  }
  addScaledVector(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }
  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
  length() {
    return Math.hypot(this.x, this.y, this.z);
  }
}

function makeQuaternion() {
  return {
    x: 0,
    y: 0,
    z: 0,
    w: 1,
    setFromAxisAngle(axis, angle) {
      const s = Math.sin(angle / 2);
      this.x = axis.x * s;
      this.y = axis.y * s;
      this.z = axis.z * s;
      this.w = Math.cos(angle / 2);
      return this;
    },
  };
}

function makeFlight() {
  return {
    position: new V3(1200, 850, -4300),
    velocity: new V3(0, 0, -210),
    quaternion: makeQuaternion(),
    rates: new V3(),
    controls: { pitch: 0, roll: 0, yaw: 0 },
    speed: 210,
    throttle: 0.72,
    targetThrottle: 0.72,
    afterburner: false,
    gearDown: true,
    gearPos: 1,
    gearTarget: 1,
    flapsIndex: 1,
    flapPos: 0.5,
    brake: false,
    onGround: false,
    crashed: false,
    crashReason: '',
    agl: 850,
    verticalSpeed: 0,
    gForce: 1.3,
    aoa: 0.052,
    beta: 0.01,
    stall: false,
    turbulence: 0.1,
    windDir: 270,
    windSpeed: 7,
    windGust: 0.2,
    headwind: 3,
    crosswind: 1,
    touchdown: 0,
    reset(spawn = {}) {
      this.position.set(spawn.x || 0, spawn.y || 0, spawn.z || 0);
      this.speed = 0;
      this.crashed = false;
      this.crashReason = '';
      return this;
    },
    get heading() {
      return 42.5;
    },
    get pitchDeg() {
      return 3.2;
    },
    get rollDeg() {
      return -1.4;
    },
    get forward() {
      const h = (this.heading * Math.PI) / 180;
      return { x: Math.sin(h), y: 0.05, z: -Math.cos(h) };
    },
  };
}

function makeApp(overrides = {}) {
  const flight = makeFlight();
  const app = {
    mode: 'fly',
    ready: true,
    fps: 58.6,
    canvas: null,
    renderer: null,
    hud: null,
    spawn: { airport: { code: 'KNYX', name: 'Nyxport Regional' } },
    input: { down: new Set() },
    aircraft: {
      flight,
      mode: 'cockpit',
      model: { position: new V3(), quaternion: makeQuaternion() },
      setMode(m) {
        this.mode = m;
        return m;
      },
      telemetry() {
        return {
          kts: 408.2,
          mach: 0.62,
          altFt: 2789,
          aglFt: 1200,
          heading: 42.5,
          pitch: 3.2,
          roll: -1.4,
          throttle: 0.72,
          afterburner: false,
          g: 1.3,
          aoa: 0.052,
          windDir: 270,
          windKts: 13.6,
          mode: 'cockpit',
          gear: true,
          flaps: 1,
          brake: false,
          stall: false,
          onGround: false,
          crashed: false,
          speedMs: 210,
          altitude: 850,
          night: 0.2,
          weather: 'few',
          clock: '15:30',
        };
      },
    },
    fuel: { lb: 6400 },
    weather: {
      presetName: 'few',
      windPresetName: 'auto',
      state: { turbulence: 0.2 },
      setPreset(name) {
        this.presetName = name;
      },
      setWindPreset(name) {
        this.windPresetName = name;
      },
    },
    time: {
      hour: 15.5,
      scaleIndex: 0,
      get scale() {
        return [1, 5, 20, 60, 300][this.scaleIndex];
      },
      get clock() {
        return '15:30';
      },
      setHour(h) {
        this.hour = ((h % 24) + 24) % 24;
      },
      setScaleIndex(i) {
        this.scaleIndex = (i + 5) % 5;
        return this.scale;
      },
    },
    sky: {
      night: 0.2,
      theater: 'temperate',
      setTheater(name) {
        this.theater = name;
      },
    },
    world: {
      heightAt: () => 720,
      terrain: {
        theater: 'temperate',
        setTheater(name) {
          this.theater = name;
        },
      },
    },
    ui: {
      toasts: [],
      toast(text, ms) {
        this.toasts.push({ text, ms });
      },
      setATC() {},
    },
    weapons: null,
    targets: null,
    missions: null,
    respawns: 0,
    respawn() {
      this.respawns++;
      this.aircraft.flight.reset({ x: 0, y: 80, z: 0, heading: 0 });
      this.mode = 'fly';
    },
    starts: 0,
    startFlight() {
      this.starts++;
      this.mode = 'fly';
    },
    ...overrides,
  };
  return app;
}

{
  // ---------------------------------------------------------------- telemetry
  const app = makeApp({
    targets: {
      targets: [
        {
          id: 'sam-1', kind: 'SAM', label: 'SA-6 BATTERY', alive: true, airborne: false,
          radarActive: true, lockState: 'LOCK', position: new V3(-1500, 120, -2600),
        },
        {
          id: 'mig-1', kind: 'BANDIT', label: 'MIG-29', alive: true, airborne: true,
          radarActive: false, lockState: 'IDLE', position: new V3(0, 3000, -9000),
        },
        {
          id: 'depot-1', kind: 'DEPOT', label: 'FUEL DEPOT', alive: false, airborne: false,
          radarActive: false, lockState: 'IDLE', position: new V3(900, 90, -1200),
        },
      ],
      enemyMissiles: [],
      findLockTarget: () => null,
    },
    missions: {
      missionId: 'sead',
      meta: { id: 'sead', label: 'WILD WEASEL' },
      status: 'ACTIVE',
      score: 350,
      totalObjectives: 3,
      destroyedCount: 1,
      steerpoint: { label: 'SA-6 RADAR', distanceNm: 4.2, relBearingDeg: 12, etaSec: 44 },
      radio: [
        { sender: 'MAGIC', text: 'CLEARED HOT', priority: 'info', age: 0.2, ttl: 7.5 },
        { sender: 'MAGIC', text: 'SPIKE! BEARING 240', priority: 'urgent', age: 0.4, ttl: 7.5 },
      ],
    },
  });
  const bridge = new McpBridge(app, { autoConnect: false, autoTick: false, telemetryMs: 0 });
  const t = await bridge.execute('get_telemetry', {});

  for (const key of REQUIRED_TELEMETRY) ok(key in t, 'telemetry has ' + key);
  ok(finite(t.kts) && finite(t.mach) && finite(t.altFt) && finite(t.aglFt), 'telemetry air data finite');
  ok(t.kts === 408.2, 'telemetry kts passes through aircraft.telemetry', String(t.kts));
  ok(t.mach === 0.62, 'telemetry mach passes through', String(t.mach));
  ok(t.altFt === 2789 && t.aglFt === 1200, 'telemetry altitudes pass through');
  ok(t.heading === 42.5 && t.pitch === 3.2 && t.roll === -1.4, 'telemetry attitude passes through');
  ok(t.aoa === 3, 'telemetry aoa converted to degrees', String(t.aoa));
  ok(t.fuelLb === 6400, 'telemetry uses integrated fuel system when present', String(t.fuelLb));
  ok(t.windDir === 270 && t.windKts === 13.6, 'telemetry wind passes through');
  ok(t.mode === 'fly' && t.camera === 'cockpit', 'telemetry reports app and camera mode');
  ok(t.fps === 59, 'telemetry rounds fps', String(t.fps));

  ok(t.mission && t.mission.id === 'sead', 'telemetry mission id');
  ok(t.mission.label === 'WILD WEASEL' && t.mission.status === 'ACTIVE', 'telemetry mission label/status');
  ok(t.mission.objectives.total === 3 && t.mission.objectives.destroyed === 1, 'telemetry mission objectives');
  ok(t.mission.steerpoint && t.mission.steerpoint.label === 'SA-6 RADAR', 'telemetry steerpoint');
  ok(t.mission.radio.length === 2 && t.mission.radio[1].priority === 'urgent', 'telemetry mission radio');

  ok(Array.isArray(t.targets) && t.targets.length === 3, 'telemetry lists targets');
  const sam = t.targets.find((x) => x.id === 'sam-1');
  ok(sam && sam.alive === true && finite(sam.distanceM) && finite(sam.bearingDeg), 'target summary fields');
  const depot = t.targets.find((x) => x.id === 'depot-1');
  ok(depot && depot.alive === false, 'destroyed target reported dead');

  ok(t.rwrContacts.length === 1, 'RWR derived from radiating targets', String(t.rwrContacts.length));
  ok(t.rwrContacts[0].id === 'sam-1' && t.rwrContacts[0].state === 'LOCK', 'RWR contact state');
  ok(t.ammo === null, 'ammo is null without an integrated weapon system');

  // Direct builder also works without aircraft.telemetry.
  const bare = makeApp();
  bare.aircraft.telemetry = undefined;
  delete bare.fuel;
  const bareT = buildTelemetry(bare, { fuelLb: 5000 });
  ok(bareT.kts > 0 && bareT.altFt > 0, 'telemetry falls back to flight model values');
  ok(bareT.fuelLb === 5000, 'telemetry falls back to bridge fuel model');
}

{
  // ------------------------------------------------------- set_environment
  const app = makeApp();
  const bridge = new McpBridge(app, { autoConnect: false });
  const res = await bridge.execute('set_environment', {
    weather: 'storm', wind: 'gale', theater: 'desert', hour: 21.5, timeScale: 20, camera: 'chase',
  });
  ok(res.ok === true && res.unsupported.length === 0, 'set_environment fully applied', JSON.stringify(res));
  ok(app.weather.presetName === 'storm', 'weather preset applied');
  ok(app.weather.windPresetName === 'gale', 'wind preset applied');
  ok(app.sky.theater === 'desert' && app.world.terrain.theater === 'desert', 'theater applied to sky and terrain');
  ok(Math.abs(app.time.hour - 21.5) < 1e-9, 'hour applied');
  ok(app.time.scaleIndex === 2 && res.applied.timeScale === 20, 'time scale applied');
  ok(app.aircraft.mode === 'chase', 'camera mode applied');
  ok(app.ui.toasts.length >= 2, 'environment changes toast the pilot');

  let err = null;
  try {
    await bridge.execute('set_environment', { weather: 'snow' });
  } catch (e) {
    err = e;
  }
  ok(err && err.code === 'INVALID_ARGUMENT', 'invalid weather rejected');

  err = null;
  try {
    await bridge.execute('set_environment', {});
  } catch (e) {
    err = e;
  }
  ok(err && err.code === 'INVALID_ARGUMENT', 'empty environment change rejected');

  const nearest = await bridge.execute('set_environment', { timeScale: 45 });
  ok(nearest.applied.timeScale === 20 || nearest.applied.timeScale === 60,
    'non-listed time scale snaps to nearest preset', JSON.stringify(nearest.applied));
}

{
  // ------------------------------------------------------- set_flight_state
  const app = makeApp();
  const bridge = new McpBridge(app, { autoConnect: false, telemetryMs: 0 });
  const f = app.aircraft.flight;

  app.mode = 'menu';
  const res = await bridge.execute('set_flight_state', {
    throttle: 0.95, gear: false, flaps: 2, brakes: true,
  });
  ok(app.mode === 'fly' && app.starts === 1, 'set_flight_state leaves the menu and starts flight');
  ok(res.applied.throttle === 0.95 && f.throttle === 0.95 && f.targetThrottle === 0.95, 'throttle applied');
  ok(res.applied.gear === false && f.gearDown === false && f.gearTarget === 0, 'gear up applied');
  ok(f.flapsIndex === 2 && f.brake === true, 'flaps and brakes applied');

  const gearToggle = await bridge.execute('set_flight_state', { gear: 'toggle' });
  ok(gearToggle.applied.gear === true && f.gearDown === true, 'gear toggle flips back down');

  const ap = await bridge.execute('set_flight_state', {
    autopilot: 'ALT_HDG', altitudeFt: 3048, heading: 90,
  });
  ok(ap.autopilot.mode === 'ALT_HDG' && ap.autopilot.altitudeFt === 3048, 'autopilot mode + target altitude');
  ok(ap.autopilot.headingDeg === 90, 'autopilot target heading normalised');

  // Autopilot tick injects virtual keys into the real Input layer.
  bridge._tick(Date.now());
  ok(app.input.down.has('KeyS'), 'ALT_HDG selects nose-up virtual key');
  ok(app.input.down.has('KeyD'), 'ALT_HDG rolls toward target heading');
  await bridge.execute('set_flight_state', { autopilot: 'OFF' });
  bridge._tick(Date.now());
  ok(!app.input.down.has('KeyS') && !app.input.down.has('KeyD'), 'autopilot OFF releases virtual keys');

  const tp = await bridge.execute('set_flight_state', {
    teleport: { x: -2000, y: 1500, z: 3000, heading: 270, speedMs: 250 },
  });
  ok(tp.applied.teleport.x === -2000 && f.position.y === 1500 && f.position.z === 3000, 'teleport moves the jet');
  ok(Math.abs(f.velocity.x + 250) < 1e-6 && Math.abs(f.velocity.z) < 1e-6, 'teleport sets velocity along west heading');
  ok(f.onGround === false && f.crashed === false, 'teleport clears ground/crash state');
  ok(Math.abs(f.quaternion.y + Math.SQRT1_2) < 1e-6, 'teleport sets heading quaternion');

  let err = null;
  try {
    await bridge.execute('set_flight_state', {});
  } catch (e) {
    err = e;
  }
  ok(err && err.code === 'INVALID_ARGUMENT', 'empty flight-state change rejected');
}

{
  // ------------------------------------------------------------ set_controls
  const app = makeApp();
  const bridge = new McpBridge(app, { autoConnect: false });
  const res = await bridge.execute('set_controls', { pitch: 0.6, roll: -0.4, yaw: 0.2, throttleDelta: 1, durationMs: 80 });
  ok(res.ok === true && res.keys.includes('KeyS') && res.keys.includes('KeyD'), 'pulse maps stick to keys');
  ok(res.keys.includes('KeyQ') && res.keys.includes('ShiftLeft'), 'pulse maps rudder and throttle');
  ok(app.input.down.has('KeyS') && app.input.down.has('KeyD'), 'pulse presses keys immediately');
  await delay(150);
  ok(!app.input.down.has('KeyS') && !app.input.down.has('KeyD'), 'pulse releases keys after duration');

  // A key physically held by the pilot must survive a virtual pulse.
  app.input.down.add('KeyW');
  await bridge.execute('set_controls', { pitch: -1, durationMs: 60 });
  await delay(120);
  ok(app.input.down.has('KeyW'), 'virtual pulse does not steal a key the pilot is holding');
  app.input.down.delete('KeyW');

  const dead = await bridge.execute('set_controls', { pitch: 0.01, durationMs: 60 });
  ok(dead.keys.length === 0, 'sub-deadband pulse applies no keys');
}

{
  // ----------------------------------------------------------- send_radio
  const app = makeApp();
  const bridge = new McpBridge(app, { autoConnect: false });
  const r1 = await bridge.execute('send_radio', { sender: 'MAGIC', text: 'VIPER 1-1 CLEARED HOT', priority: 'urgent' });
  ok(r1.queued === true && r1.sender === 'MAGIC' && r1.text === 'VIPER 1-1 CLEARED HOT', 'radio call queued');
  ok(r1.priority === 'urgent' && r1.radio.length === 1, 'radio priority and queue length');
  ok(app.ui.toasts.some((t) => t.text.includes('VIPER 1-1 CLEARED HOT')), 'radio call toasts the pilot');

  for (let i = 0; i < 5; i++) {
    await bridge.execute('send_radio', { text: 'CALL ' + i });
  }
  const t = await bridge.execute('get_telemetry', {});
  ok(t.mission && t.mission.radio.length === 3, 'radio queue trimmed to the newest 3');
  ok(t.mission.radio[2].text === 'CALL 4', 'radio queue keeps the newest callout');

  let err = null;
  try {
    await bridge.execute('send_radio', { text: '   ' });
  } catch (e) {
    err = e;
  }
  ok(err && err.code === 'INVALID_ARGUMENT', 'empty radio text rejected');
}

{
  // --------------------------------------------------------- combat_action
  const app = makeApp();
  const fired = [];
  app.weapons = {
    selected: 'GUN',
    ammo: { GUN: 510, AIM9: 4, MK82: 6, FLARE: 30 },
    selectWeapon(type) {
      this.selected = type;
      return this.selected;
    },
    fire(flight) {
      this.ammo[this.selected]--;
      fired.push(this.selected);
      return { fired: true, type: this.selected, targetId: 'sam-1' };
    },
    deployFlare() {
      this.ammo.FLARE--;
      return { deployed: true };
    },
  };
  const bridge = new McpBridge(app, { autoConnect: false });

  const sel = await bridge.execute('combat_action', { action: 'select_weapon', weapon: 'AIM9' });
  ok(sel.ok === true && app.weapons.selected === 'AIM9', 'weapon selected');
  ok(sel.ammo && sel.ammo.rounds.AIM9 === 4, 'ammo reported after selection');

  const shot = await bridge.execute('combat_action', { action: 'fire' });
  ok(shot.fired === true && shot.weapon === 'AIM9' && shot.targetId === 'sam-1', 'weapon fired');
  ok(fired.length === 1 && app.weapons.ammo.AIM9 === 3, 'fire consumed ammo');

  const flares = await bridge.execute('combat_action', { action: 'deploy_flares' });
  ok(flares.deployed === true && app.weapons.ammo.FLARE === 29, 'flares deployed');

  const nvg = await bridge.execute('combat_action', { action: 'toggle_nvg' });
  ok(nvg.nvg === true && bridge.state.nvg === true, 'NVG toggled on');

  const ejected = await bridge.execute('combat_action', { action: 'eject' });
  ok(ejected.ejected === true && app.aircraft.flight.crashed === true, 'ejection crashes the jet');

  const bare = new McpBridge(makeApp(), { autoConnect: false });
  let err = null;
  try {
    await bare.execute('combat_action', { action: 'fire' });
  } catch (e) {
    err = e;
  }
  ok(err && err.code === 'UNAVAILABLE', 'combat without weapon system reports UNAVAILABLE');

  err = null;
  try {
    await bare.execute('combat_action', { action: 'warp' });
  } catch (e) {
    err = e;
  }
  ok(err && err.code === 'INVALID_ARGUMENT', 'unknown combat action rejected');
}

{
  // --------------------------------------------------------- start_mission
  const app = makeApp();
  const specs = [
    { id: 'sead-radar-0', kind: 'RADAR', label: 'SA-6 RADAR', x: 900, z: -9000 },
    { id: 'sead-sam-1', kind: 'SAM', label: 'SA-2 BATTERY', x: -400, z: -9500 },
  ];
  app.missions = {
    missionId: 'free',
    meta: { id: 'free', label: 'FREE FLIGHT' },
    status: 'FREE',
    radio: [],
    startMission(id, spawn, world) {
      this.missionId = id;
      this.status = 'ACTIVE';
      this.totalObjectives = specs.length;
      this.destroyedCount = 0;
      this.spawn = spawn;
      this.world = world;
      return specs;
    },
  };
  let spawned = null;
  app.targets = {
    targets: [],
    spawnScenario(list, world) {
      spawned = { list, world };
      this.targets = list.map((s) => ({ ...s, alive: true }));
    },
  };
  const bridge = new McpBridge(app, { autoConnect: false });

  const res = await bridge.execute('start_mission', { mission: 'sead' });
  ok(res.ok === true && res.mission.id === 'sead' && res.mission.status === 'ACTIVE', 'mission started');
  ok(app.missions.missionId === 'sead', 'mission director received the sortie id');
  ok(app.missions.spawn.heading === 42.5 && app.missions.spawn.airport.code === 'KNYX', 'spawn carries heading and airport');
  ok(spawned && spawned.list.length === 2 && spawned.world === app.world, 'target scenario spawned');
  ok(res.targets.total === 2 && res.targets.alive === 2, 'target counts reported');

  const resp = await bridge.execute('start_mission', { mission: 'strike', respawn: true });
  ok(resp.respawned === false && app.respawns === 1, 'respawn flag resets to runway before starting the mission');

  let err = null;
  try {
    await bridge.execute('start_mission', { mission: 'nope' });
  } catch (e) {
    err = e;
  }
  ok(err && err.code === 'INVALID_ARGUMENT', 'unknown mission rejected');

  // Without a mission director the command gracefully resets to the runway.
  const bare = makeApp();
  const bareBridge = new McpBridge(bare, { autoConnect: false });
  const fallback = await bareBridge.execute('start_mission', { mission: 'cap' });
  ok(fallback.ok === true && fallback.respawned === true && bare.respawns === 1, 'start_mission falls back to respawn');
  ok(typeof fallback.note === 'string' && fallback.note.length > 0, 'fallback explains the missing director');
}

{
  // ------------------------------------------------------ misc bridge rails
  const app = makeApp();
  const bridge = new McpBridge(app, { autoConnect: false });
  let err = null;
  try {
    await bridge.execute('nope', {});
  } catch (e) {
    err = e;
  }
  ok(err && err.code === 'UNKNOWN_TOOL', 'unknown tool rejected');

  err = null;
  try {
    await bridge.execute('get_telemetry', null);
  } catch (e) {
    err = e;
  }
  ok(err && err.code === 'INVALID_ARGUMENT', 'null arguments rejected');

  err = null;
  try {
    await bridge.execute('capture_screenshot', {});
  } catch (e) {
    err = e;
  }
  ok(err && err.code === 'UNAVAILABLE', 'screenshot without a DOM reports UNAVAILABLE');

  const attached = attachMcpBridge(app, { autoConnect: false });
  ok(attached instanceof McpBridge && attached.app === app, 'attachMcpBridge creates a bridge');
  ok(attachMcpBridge(app, { autoConnect: false }) === attached, 'attachMcpBridge is idempotent');
  attached.stop();
}

// ===========================================================================
// Part B — MCP server over stdio + simulated browser over HTTP
// ===========================================================================

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let child = null;
let mock = null;

try {
  child = spawn(process.execPath, [SERVER, '--port', '0', '--timeout', '1200'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not announce its bridge port')), 10000);
    child.stderr.on('data', () => {
      const m = /browser bridge listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('server exited before listen, code ' + code + '\n' + stderr));
    });
  });

  const BASE = `http://127.0.0.1:${port}`;
  ok(port > 0 && port < 65536, 'server announced a real TCP port', String(port));
  ok(/127\.0\.0\.1/.test(stderr), 'server binds the HTTP bridge to 127.0.0.1 only');

  // ------------------------------------------------------------ MCP plumbing
  let buffer = '';
  const pending = new Map();
  const inbox = [];
  const waiters = [];
  let nextId = 1;
  const protocolGarbage = [];

  function deliver(msg) {
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].predicate(msg)) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
        return;
      }
    }
    inbox.push(msg);
  }

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        protocolGarbage.push(line);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null && msg.id !== undefined) {
        const entry = pending.get(String(msg.id));
        if (entry) {
          pending.delete(String(msg.id));
          clearTimeout(entry.timer);
          entry.resolve(msg);
          continue;
        }
      }
      deliver(msg);
    }
  });

  function waitMessage(predicate, timeoutMs = 8000) {
    const foundIndex = inbox.findIndex(predicate);
    if (foundIndex !== -1) return Promise.resolve(inbox.splice(foundIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error('timed out waiting for MCP message'));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  }

  function rpc(method, params, timeoutMs = 8000) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    child.stdin.write(JSON.stringify(message) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error('timed out: ' + method));
      }, timeoutMs);
      pending.set(String(id), { resolve, timer });
    });
  }

  function notify(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  let health = null;
  {
    const res = await fetch(BASE + '/health');
    health = await res.json();
  }
  ok(health && health.ok === true, 'bridge /health responds');
  ok(health.host === '127.0.0.1' && health.port === port, 'health reports the loopback listener');
  ok(health.clients === 0 && health.pending === 0, 'bridge starts with no clients or pending calls');

  // ------------------------------------------------------------- initialize
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-test', version: '1.0.0' },
  });
  ok(init && init.jsonrpc === '2.0', 'initialize speaks JSON-RPC 2.0');
  ok(init.result && init.result.protocolVersion === '2025-06-18', 'initialize echoes supported protocol version');
  ok(init.result.capabilities && init.result.capabilities.tools, 'initialize advertises tools capability');
  ok(init.result.serverInfo && init.result.serverInfo.name === 'falcon-infinite', 'initialize names the server');
  ok(typeof init.result.instructions === 'string' && init.result.instructions.length > 20, 'initialize supplies instructions');

  notify('notifications/initialized', {});

  const ping = await rpc('ping', {});
  ok(ping.result && deepEqual(ping.result, {}), 'ping returns an empty result');

  // -------------------------------------------------------------- tools/list
  const list = await rpc('tools/list', {});
  const tools = list.result && list.result.tools;
  ok(Array.isArray(tools) && tools.length === 8, 'tools/list returns 8 tools', String(tools && tools.length));
  const expected = [
    'get_telemetry', 'set_flight_state', 'set_controls', 'combat_action',
    'set_environment', 'start_mission', 'send_radio', 'capture_screenshot',
  ];
  ok(deepEqual(tools.map((t) => t.name).sort(), [...expected].sort()), 'tool names match the feature contract');
  for (const tool of tools) {
    ok(typeof tool.description === 'string' && tool.description.length > 20, tool.name + ' has a description');
    ok(tool.inputSchema && tool.inputSchema.type === 'object', tool.name + ' has an object inputSchema');
  }
  const setEnvSchema = tools.find((t) => t.name === 'set_environment').inputSchema;
  ok(deepEqual(setEnvSchema.properties.weather.enum, ['clear', 'few', 'scattered', 'overcast', 'storm']),
    'weather enum documented');
  ok(setEnvSchema.properties.timeScale.enum.includes(20), 'time scale enum documented');

  // ------------------------------------------------- simulated browser client
  const snapshot = {
    ts: 1700000000000,
    kts: 412.5,
    mach: 0.63,
    altFt: 18000,
    aglFt: 17400,
    heading: 87.5,
    pitch: 4.2,
    roll: -12.5,
    throttle: 0.82,
    afterburner: false,
    g: 2.4,
    aoa: 5.1,
    fuelLb: 5120,
    windDir: 300,
    windKts: 18.2,
    mode: 'fly',
    mission: { id: 'sead', label: 'WILD WEASEL', status: 'ACTIVE', score: 350 },
    targets: [{ id: 'sam-1', kind: 'SAM', label: 'SA-6', alive: true, distanceM: 2400, bearingDeg: 84 }],
    rwrContacts: [{ id: 'sam-1', kind: 'SAM', state: 'LOCK', bearingRad: 0.2, distanceM: 2400 }],
    ammo: { GUN: 510, AIM9: 4, MK82: 6, FLARE: 30 },
    fps: 60,
  };

  class MockBrowser {
    constructor(base) {
      this.base = base;
      this.running = false;
      this.seen = [];
      this.snapshot = snapshot;
      this.radios = [];
      this.controller = new AbortController();
    }
    async start() {
      this.running = true;
      this.loopPromise = this.loop();
    }
    stop() {
      this.running = false;
      this.controller.abort();
    }
    async loop() {
      while (this.running) {
        try {
          const res = await fetch(`${this.base}/commands?wait=800&client=mock-browser`, {
            signal: this.controller.signal,
          });
          if (!res.ok) throw new Error('poll HTTP ' + res.status);
          const data = await res.json();
          for (const command of data.commands) await this.handle(command);
        } catch {
          if (!this.running) return;
          await delay(80);
        }
      }
    }
    async handle(command) {
      this.seen.push({ tool: command.tool, args: command.args });
      let result;
      if (command.tool === 'get_telemetry') {
        result = { ...this.snapshot };
      } else if (command.tool === 'set_environment') {
        result = { ok: true, applied: { ...command.args }, unsupported: [] };
        this.snapshot = { ...this.snapshot, weather: command.args.weather || this.snapshot.weather, clock: '21:30' };
      } else if (command.tool === 'send_radio') {
        const message = {
          sender: command.args.sender || 'MAGIC',
          text: command.args.text,
          priority: command.args.priority || 'info',
        };
        this.radios.push(message);
        result = { ok: true, queued: true, ...message, radio: this.radios.slice(-3) };
      } else if (command.tool === 'capture_screenshot') {
        result = { ok: true, png: PNG_BASE64, width: 1, height: 1, bytes: PNG_BASE64.length };
      } else {
        result = { ok: true, tool: command.tool, args: command.args };
      }
      await this.post('/result', { id: command.id, ok: true, result });
      await this.post('/telemetry', this.snapshot);
    }
    async post(pathname, body) {
      const res = await fetch(this.base + pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('POST ' + pathname + ' HTTP ' + res.status);
      return res.json().catch(() => null);
    }
  }

  mock = new MockBrowser(BASE);
  await mock.start();
  await delay(150);

  // Prime the telemetry cache exactly as the real bridge does.
  {
    const res = await fetch(BASE + '/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    ok(res.ok, 'telemetry POST accepted');
  }

  // ---------------------------------------------------- get_telemetry (cache)
  {
    const reply = await rpc('tools/call', { name: 'get_telemetry', arguments: {} });
    ok(reply.result && !reply.result.isError, 'get_telemetry succeeds');
    const textPayload = JSON.parse(reply.result.content[0].text);
    ok(deepEqual(textPayload, snapshot), 'get_telemetry returns the exact cached snapshot');
    ok(deepEqual(reply.result.structuredContent, snapshot), 'get_telemetry fills structuredContent');
    ok(reply.result.content[0].type === 'text', 'get_telemetry content is text');
  }

  // ----------------------------------------------- get_telemetry (fresh trip)
  {
    const reply = await rpc('tools/call', { name: 'get_telemetry', arguments: { fresh: true } });
    const payload = JSON.parse(reply.result.content[0].text);
    ok(payload.kts === 412.5 && payload.fuelLb === 5120, 'fresh telemetry round-trips through the browser');
    ok(mock.seen.some((c) => c.tool === 'get_telemetry'), 'fresh telemetry dispatched a real command');
  }

  // ---------------------------------------------------------- set_environment
  {
    const args = { weather: 'storm', wind: 'gale', hour: 21.5, timeScale: 20, camera: 'chase' };
    const reply = await rpc('tools/call', { name: 'set_environment', arguments: args });
    ok(!reply.result.isError, 'set_environment succeeds');
    const payload = JSON.parse(reply.result.content[0].text);
    ok(deepEqual(payload.applied, args), 'set_environment response echoes applied state');
    ok(deepEqual(reply.result.structuredContent, payload), 'set_environment structuredContent matches text');
    const seen = mock.seen.filter((c) => c.tool === 'set_environment').pop();
    ok(deepEqual(seen.args, args), 'browser received the exact set_environment arguments');
  }

  // -------------------------------------------------------------- send_radio
  {
    const args = { sender: 'MAGIC', text: 'VIPER 1-1 CLEARED HOT', priority: 'urgent' };
    const reply = await rpc('tools/call', { name: 'send_radio', arguments: args });
    const payload = JSON.parse(reply.result.content[0].text);
    ok(payload.ok === true && payload.queued === true, 'send_radio queued');
    ok(payload.sender === 'MAGIC' && payload.text === 'VIPER 1-1 CLEARED HOT', 'radio text round-trips verbatim');
    ok(payload.priority === 'urgent', 'radio priority round-trips');
    const seen = mock.seen.filter((c) => c.tool === 'send_radio').pop();
    ok(deepEqual(seen.args, args), 'browser received the exact radio call');
  }

  // ------------------------------------------------------- capture_screenshot
  {
    const reply = await rpc('tools/call', { name: 'capture_screenshot', arguments: {} });
    const result = reply.result;
    ok(!result.isError, 'capture_screenshot succeeds');
    ok(Array.isArray(result.content) && result.content.length === 2, 'screenshot returns image + text content');
    ok(result.content[0].type === 'image' && result.content[0].mimeType === 'image/png', 'screenshot image content shape');
    ok(result.content[0].data === PNG_BASE64, 'screenshot base64 round-trips exactly');
    const meta = JSON.parse(result.content[1].text);
    ok(meta.width === 1 && meta.height === 1 && meta.format === 'png', 'screenshot metadata accurate');
    ok(result.structuredContent.width === 1, 'screenshot structuredContent carries dimensions');
  }

  // ------------------------------------------------------------ error paths
  {
    const reply = await rpc('tools/call', { name: 'not_a_tool', arguments: {} });
    ok(reply.error && reply.error.code === -32602, 'unknown tool is -32602');
  }
  {
    const reply = await rpc('tools/call', { arguments: {} });
    ok(reply.error && reply.error.code === -32602, 'tools/call without name is -32602');
  }
  {
    const reply = await rpc('does/not/exist', {});
    ok(reply.error && reply.error.code === -32601, 'unknown method is -32601');
  }
  {
    child.stdin.write('{ this is not json }\n');
    const reply = await waitMessage((m) => m.error && m.error.code === -32700, 4000);
    ok(reply.error.code === -32700 && reply.id === null, 'malformed JSON is -32700 with null id');
  }

  // --------------------------------------------------------- HTTP hardening
  {
    const res = await fetch(BASE + '/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify(snapshot),
    });
    ok(res.status === 403, 'non-loopback Origin rejected', String(res.status));
  }
  {
    const res = await fetch(BASE + '/commands?wait=50', {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    ok(res.status === 200 && res.headers.get('access-control-allow-origin') === 'http://127.0.0.1:5173',
      'loopback Origin gets CORS headers');
  }
  {
    const res = await fetch(BASE + '/telemetry', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
    });
    ok(res.status === 204, 'CORS preflight accepted', String(res.status));
    ok(res.headers.get('access-control-allow-methods').includes('POST'), 'preflight advertises POST');
  }
  {
    const res = await fetch(BASE + '/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'unknown-command', ok: true, result: {} }),
    });
    const body = await res.json();
    ok(res.status === 200 && body.settled === false, 'unknown result id is ignored safely');
  }

  // ------------------------------------------------------ offline behaviour
  mock.stop();
  await delay(200);
  {
    const started = Date.now();
    const reply = await rpc('tools/call', { name: 'set_environment', arguments: { weather: 'clear' } }, 6000);
    const elapsed = Date.now() - started;
    ok(reply.result && reply.result.isError === true, 'tool call fails cleanly when the browser is gone');
    const payload = JSON.parse(reply.result.content[0].text);
    ok(payload.ok === false && ['BRIDGE_OFFLINE', 'BRIDGE_TIMEOUT'].includes(payload.error.code),
      'offline error code is stable', JSON.stringify(payload.error));
    ok(elapsed < 5000, 'offline failure is bounded by the result timeout', elapsed + ' ms');
  }

  // ------------------------------------------------------------- shutdown
  child.stdin.end();
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: 'timeout' }), 5000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  ok(exit.code === 0, 'server exits 0 on stdin close', JSON.stringify(exit));
  ok(!/uncaught|unhandled rejection|ERROR/.test(stderr), 'server logged no crash on stderr', stderr.slice(-400));
  ok(protocolGarbage.length === 0, 'server stdout carried only JSON-RPC frames', protocolGarbage.join('|'));
} finally {
  if (mock) mock.stop();
  if (child && child.exitCode === null) child.kill('SIGKILL');
}

// ===========================================================================
// Summary
// ===========================================================================

console.log(`mcp checks: ${checks}, failures: ${failures.length}`);
for (const failure of failures) console.log('  FAIL ' + failure);
if (failures.length) {
  process.exitCode = 1;
} else {
  console.log('ALL MCP CHECKS PASSED');
}