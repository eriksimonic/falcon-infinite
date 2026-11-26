// Headless acceptance tests for Feature 05:
//   src/ui/tactical.js     (TacticalOverlay)
//   src/core/combat_audio.js (CombatAudio)
//
// Runs under plain `node tests/tactical_test.mjs` — no DOM, no browser, no
// WebAudio implementation. Three.js is used only for math (Vector3/camera).

import { PerspectiveCamera, Vector3 } from 'three';
import { TacticalOverlay } from '../src/ui/tactical.js';
import { CombatAudio } from '../src/core/combat_audio.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' - ' + detail : ''));
}
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ===========================================================================
// 1. TacticalOverlay — G-LOC / redout / NVG state
// ===========================================================================
{
  const ov = new TacticalOverlay();
  ok(ov.nvg === false, 'NVG starts off');
  ok(ov.toggleNVG() === true, 'toggleNVG returns true on enable');
  ok(ov.nvg === true, 'NVG state enabled');
  ok(ov.toggleNVG() === false, 'toggleNVG returns false on disable');
  ok(ov.nvg === false, 'NVG state disabled');

  // Sustained 8.5G -> blackout builds.
  const flight8 = { gForce: 8.5 };
  let r = null;
  for (let i = 0; i < 240; i++) r = ov.update(1 / 60, flight8);
  ok(r && finite(r.gloc), '8.5G result gloc finite');
  ok(r.gloc > 0.45, '8.5G builds blackout', 'gloc=' + r.gloc.toFixed(3));
  ok(r.blackout > 0.45, 'blackout reported positive');
  ok(r.redout === 0, 'no redout under positive G');
  ok(r.gStrain > 0.5, 'G strain reported under 8.5G', 'strain=' + r.gStrain.toFixed(2));
  ok(finite(r.blackout) && finite(r.redout) && finite(r.gStrain), 'G-LOC result fields finite');

  // Recovery at 1G clears smoothly.
  const flight1 = { gForce: 1 };
  for (let i = 0; i < 360; i++) r = ov.update(1 / 60, flight1);
  ok(r.gloc < 0.08, 'recovers below blackout at 1G', 'gloc=' + r.gloc.toFixed(4));
  ok(r.blackout < 0.08 && r.redout === 0, 'blackout cleared, no redout');
  ok(r.gStrain < 0.2, 'strain drops at 1G', 'strain=' + r.gStrain.toFixed(3));

  // Negative G -> redout.
  const ov2 = new TacticalOverlay();
  const flightNeg = { gForce: -3 };
  for (let i = 0; i < 180; i++) r = ov2.update(1 / 60, flightNeg);
  ok(r.gloc < -0.25, '-3G builds redout', 'gloc=' + r.gloc.toFixed(3));
  ok(r.redout > 0.25, 'redout reported positive');
  ok(r.blackout === 0, 'no blackout under negative G');

  // G tolerance band holds steady; no NaN leaks.
  const ov3 = new TacticalOverlay();
  for (let i = 0; i < 120; i++) ov3.update(1 / 60, { gForce: 5.1 });
  ok(finite(ov3.gloc) && Math.abs(ov3.gloc) < 0.05, '5.1G tolerance band holds gloc near zero');
  const nanResult = ov3.update(1 / 60, { gForce: NaN });
  ok(finite(nanResult.gloc) && finite(nanResult.gStrain), 'NaN gForce is sanitised');
  const missingResult = ov3.update(NaN, undefined);
  ok(finite(missingResult.gloc) && finite(missingResult.gStrain), 'missing flight/dt is sanitised');
}

// ===========================================================================
// 2. Minimal 2D canvas mock (no gradients, no arcTo, no setLineDash)
// ===========================================================================
function makeCanvas(ctxLog) {
  const state = {
    texts: [],
    calls: 0,
    alpha: 1,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
  };
  const bump = (name) => { state.calls++; if (ctxLog) ctxLog.push(name); };
  const ctx = {
    canvas: null,
    save() { bump('save'); },
    restore() { bump('restore'); },
    beginPath() { bump('beginPath'); },
    closePath() { bump('closePath'); },
    moveTo() { bump('moveTo'); },
    lineTo() { bump('lineTo'); },
    arc() { bump('arc'); },
    rect() { bump('rect'); },
    fill() { bump('fill'); },
    stroke() { bump('stroke'); },
    fillRect() { bump('fillRect'); },
    strokeRect() { bump('strokeRect'); },
    clearRect() { bump('clearRect'); },
    translate() { bump('translate'); },
    rotate() { bump('rotate'); },
    clip() { bump('clip'); },
    fillText(text) {
      bump('fillText');
      state.texts.push(String(text));
    },
    strokeText() { bump('strokeText'); },
    measureText(text) {
      bump('measureText');
      return { width: String(text).length * 6 };
    },
  };
  // mutable style properties
  for (const key of ['alpha', 'font', 'fillStyle', 'strokeStyle', 'lineWidth', 'textAlign', 'textBaseline']) {
    Object.defineProperty(ctx, key, {
      get() { return state[key]; },
      set(v) { state[key] = v; },
    });
  }
  ctx.__state = state;
  return ctx;
}

// ===========================================================================
// 3. TacticalOverlay.draw across cockpit / external, NVG, targets, RWR, radio
// ===========================================================================
{
  const canvas = makeCanvas();
  const ov = new TacticalOverlay();
  ov.nvg = true;

  const camera = new PerspectiveCamera(52, 16 / 9, 0.1, 60000);
  camera.position.set(0, 500, 0);
  camera.lookAt(0, 0, -4000);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const radio = [
    { sender: 'MAGIC', text: 'VIPER 1-1 CLEARED HOT', priority: 'info', age: 0.5, ttl: 7.5 },
    { sender: 'MAGIC', text: 'SPIKE! SAM LAUNCH BEARING 240', priority: 'urgent', age: 1.2, ttl: 7.5 },
    { sender: 'VIPER 1-1', text: 'SHACK! TARGET DESTROYED', priority: 'warn', age: 2.0, ttl: 7.5 },
  ];

  const baseState = {
    mode: 'cockpit',
    telemetry: { heading: 0, gForce: 1.4, position: new Vector3(0, 500, 0) },
    weapons: {
      selected: 'MK82',
      ammo: { GUN: 510, AIM9: 4, MK82: 6, FLARE: 30 },
      ccip: { valid: true, x: 180, y: 0, z: -2200, timeToImpact: 4.2 },
    },
    lockedTarget: {
      id: 'sam-1',
      label: 'SA-6 RADAR',
      kind: 'RADAR',
      airborne: false,
      alive: true,
      position: new Vector3(120, 40, -2600),
      velocity: new Vector3(0, 0, 0),
    },
    targets: [
      { id: 'depot-1', kind: 'DEPOT', label: 'FUEL DEPOT', airborne: false, alive: true, position: new Vector3(-900, 30, -3100) },
      { id: 'mig-1', kind: 'BANDIT', label: 'MIG-29', airborne: true, alive: true, position: new Vector3(600, 900, -4200) },
    ],
    rwrContacts: [
      { id: 'sam-1', kind: 'SAM', bearingRad: 0.35, distance: 2600, state: 'LOCK', isMissile: false },
      { id: 'missile-1', kind: 'MISSILE', bearingRad: -0.9, distance: 9000, state: 'LAUNCH', isMissile: true },
    ],
    mission: {
      id: 'sead',
      steerpoint: {
        label: 'SA-6 BATTERY',
        x: 300,
        y: 0,
        z: -8000,
        bearingDeg: 2,
        relBearingDeg: 2,
        distanceM: 8000,
        distanceNm: 4.3,
      },
      radio,
    },
  };

  let threw = null;
  try {
    ov.draw(canvas, 1600, 900, baseState);
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'draw executes in cockpit mode with NVG', threw && threw.message);
  ok(canvas.__state.calls > 100, 'draw issues a substantial number of canvas calls', 'calls=' + canvas.__state.calls);
  const texts = canvas.__state.texts;
  ok(texts.includes('NVG ON'), 'NVG indicator rendered');
  ok(texts.some((t) => t.includes('LOCK') && t.includes('SA-6 RADAR')), 'locked target label rendered');
  ok(texts.some((t) => t.startsWith('STPT 1')), 'steerpoint label rendered', texts.filter((t) => t.startsWith('STPT')).join('|'));
  ok(texts.includes('RWR'), 'RWR scope label rendered');
  ok(texts.includes('MISSILE LAUNCH'), 'RWR launch warning rendered');
  ok(texts.some((t) => t.includes('GUN 510')), 'weapon strip GUN count rendered');
  ok(texts.some((t) => t.includes('AIM-9 4')), 'weapon strip AIM-9 count rendered');
  ok(texts.some((t) => t.includes('MK-82')), 'CCIP / MK-82 symbology rendered');
  ok(texts.some((t) => t.includes('MAGIC')), 'AWACS radio feed rendered');

  // External mode + gun reticle + moving airborne lock target.
  canvas.__state.texts.length = 0;
  const externalState = {
    ...baseState,
    mode: 'chase',
    weapons: {
      ...baseState.weapons,
      selected: 'GUN',
      ccip: { valid: false, x: 0, y: 0, z: 0, timeToImpact: 0 },
    },
    lockedTarget: {
      id: 'mig-1',
      label: 'MIG-29',
      kind: 'BANDIT',
      airborne: true,
      alive: true,
      position: new Vector3(500, 900, -3000),
      velocity: new Vector3(-40, 0, -120),
    },
    rwrContacts: [{ id: 'sam-1', kind: 'SAM', bearingRad: 2.4, distance: 6200, state: 'SEARCH', isMissile: false }],
  };
  threw = null;
  try {
    ov.draw(canvas, 1280, 720, externalState);
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'draw executes in external mode with GUN reticle', threw && threw.message);
  ok(canvas.__state.texts.includes('GUN'), 'EEGS gun label rendered');
  ok(canvas.__state.texts.some((t) => t.includes('LOCK MIG-29')), 'airborne lock label rendered');

  // Off-screen / behind-camera locked target must not throw (edge arrow path).
  const behindState = {
    ...baseState,
    mode: 'chase',
    lockedTarget: {
      ...baseState.lockedTarget,
      position: new Vector3(0, 520, 3200),
    },
    mission: {
      steerpoint: { ...baseState.mission.steerpoint, x: 0, y: 0, z: 25000, relBearingDeg: 180 },
      radio,
    },
  };
  threw = null;
  try {
    ov.draw(canvas, 1024, 768, behindState);
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'off-screen target/steerpoint edge arrows are safe', threw && threw.message);

  // No camera at all (headless / early frame).
  threw = null;
  try {
    ov.draw(canvas, 800, 600, {
      telemetry: { heading: 90, gForce: 1 },
      weapons: { selected: 'MK82', ammo: { GUN: 0, AIM9: 0, MK82: 0, FLARE: 0 }, ccip: { valid: false } },
      lockedTarget: { label: 'SA-2 BATTERY', position: { x: 1, y: 2, z: 3 } },
      targets: [{ label: 'DEPOT', position: { x: 2, y: 0, z: -100 } }],
      rwrContacts: [{ kind: 'SAM', bearingRad: 0, distance: 4000, state: 'LOCK' }],
      mission: { steerpoint: { label: 'OBJ', x: 1, y: 2, z: 3, relBearingDeg: 40, distanceNm: 5 }, radio: [] },
    });
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'draw without camera or full state is safe', threw && threw.message);

  // Empty / degenerate calls.
  threw = null;
  try {
    ov.draw(canvas, 1600, 900, {});
    ov.draw(canvas, 0, 0, baseState);
    ov.draw(canvas, 1600, 900, null);
    ov.draw(null, 1600, 900, baseState);
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'draw tolerates empty state and invalid dimensions', threw && threw.message);

  // G-LOC blackout and redout vignette paths.
  ov.nvg = false;
  const ovB = new TacticalOverlay();
  for (let i = 0; i < 240; i++) ovB.update(1 / 60, { gForce: 9.2 });
  const ovR = new TacticalOverlay();
  for (let i = 0; i < 180; i++) ovR.update(1 / 60, { gForce: -3.2 });
  threw = null;
  try {
    ovB.draw(canvas, 1600, 900, baseState);
    ovR.draw(canvas, 1600, 900, baseState);
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'blackout and redout vignettes draw cleanly', threw && threw.message);
  ok(ovB.gloc > 0.15 && ovR.gloc < -0.15, 'vignette states actually triggered');
}

// ===========================================================================
// 4. CombatAudio — mocked AudioContext
// ===========================================================================
function makeAudioHarness() {
  const rec = {
    params: [],
    bad: [],
    oscillators: [],
    bufferSources: [],
    gains: [],
    filters: [],
  };
  const checkVal = (v, tag) => {
    if (!finite(v)) rec.bad.push(tag + '=' + String(v));
    else rec.params.push(v);
  };
  const checkTime = (t, tag) => {
    if (!finite(t) || t < 0) rec.bad.push(tag + ' time=' + String(t));
  };

  class Param {
    constructor(v = 0) {
      this._v = v;
      this.peak = finite(v) ? v : -Infinity;
      this.writtenPeak = -Infinity;
      checkVal(v, 'param init');
    }
    get value() { return this._v; }
    set value(v) { checkVal(v, 'param value'); this._v = v; if (v > this.peak) this.peak = v; if (v > this.writtenPeak) this.writtenPeak = v; }
    setValueAtTime(v, t) {
      checkVal(v, 'setValueAtTime');
      checkTime(t, 'setValueAtTime');
      this._v = v;
      if (v > this.peak) this.peak = v;
      if (v > this.writtenPeak) this.writtenPeak = v;
      return this;
    }
    linearRampToValueAtTime(v, t) {
      checkVal(v, 'linearRamp');
      checkTime(t, 'linearRamp');
      this._v = v;
      if (v > this.peak) this.peak = v;
      if (v > this.writtenPeak) this.writtenPeak = v;
      return this;
    }
    exponentialRampToValueAtTime(v, t) {
      if (finite(v) && v <= 0) rec.bad.push('exponentialRamp to non-positive: ' + v);
      checkVal(v, 'expRamp');
      checkTime(t, 'expRamp');
      this._v = v;
      if (v > this.peak) this.peak = v;
      if (v > this.writtenPeak) this.writtenPeak = v;
      return this;
    }
    setTargetAtTime(v, t, tc) {
      checkVal(v, 'setTargetAtTime');
      checkTime(t, 'setTargetAtTime');
      if (!finite(tc) || tc <= 0) rec.bad.push('bad timeConstant=' + String(tc));
      else rec.params.push(tc);
      this._v = v;
      if (v > this.peak) this.peak = v;
      if (v > this.writtenPeak) this.writtenPeak = v;
      return this;
    }
    cancelScheduledValues() { return this; }
  }

  class BaseNode {
    constructor(kind) {
      this.kind = kind;
      this.outputs = [];
    }
    connect(target) {
      if (!target) rec.bad.push(kind + '.connect(null)');
      this.outputs.push(target);
      return target;
    }
    disconnect() {}
  }

  class GainNode extends BaseNode {
    constructor() {
      super('gain');
      this.gain = new Param(1);
      rec.gains.push(this);
    }
  }

  class OscillatorNode extends BaseNode {
    constructor() {
      super('osc');
      this.type = 'sine';
      this.frequency = new Param(440);
      this.detune = new Param(0);
      this.started = [];
      this.stopped = [];
      rec.oscillators.push(this);
    }
    start(t) { this.started.push(t == null ? 0 : t); }
    stop(t) { this.stopped.push(t == null ? 0 : t); }
  }

  class BiquadNode extends BaseNode {
    constructor() {
      super('filter');
      this.type = 'lowpass';
      this.frequency = new Param(350);
      this.Q = new Param(1);
      this.gain = new Param(0);
      rec.filters.push(this);
    }
  }

  class BufferSourceNode extends BaseNode {
    constructor() {
      super('bufferSource');
      this.buffer = null;
      this.loop = false;
      this.playbackRate = new Param(1);
      this.started = [];
      this.stopped = [];
      rec.bufferSources.push(this);
    }
    start(t, off, dur) { this.started.push({ t: t == null ? 0 : t, off, dur }); }
    stop(t) { this.stopped.push(t == null ? 0 : t); }
  }

  function makeBuffer(channels, len, sr) {
    const length = Math.max(1, Math.floor(finite(len) ? len : 1));
    const data = new Float32Array(length);
    return {
      numberOfChannels: Math.max(1, channels | 0),
      length,
      sampleRate: sr,
      duration: length / sr,
      getChannelData: () => data,
    };
  }

  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createGain: () => new GainNode(),
    createOscillator: () => new OscillatorNode(),
    createBiquadFilter: () => new BiquadNode(),
    createBufferSource: () => new BufferSourceNode(),
    createBuffer: (ch, len, sr) => makeBuffer(ch, len, sr),
  };
  ctx.destination = new GainNode();

  return { ctx, rec };
}

{
  // Safe no-op before attach.
  const dead = new CombatAudio();
  let threw = null;
  try {
    dead.attach(null, null);
    dead.update(1 / 60, { weapon: 'AIM9', hasLock: true, rwrHighest: 'LAUNCH', gStrain: 1 });
    dead.cannonShot();
    dead.missileLaunch();
    dead.bombRelease();
    dead.flarePop();
    dead.explosion(250);
    dead.sonicBoom();
    dead.radioBeep();
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'CombatAudio is a safe no-op without an AudioContext', threw && threw.message);

  const { ctx, rec } = makeAudioHarness();
  const audio = new CombatAudio();
  audio.attach(ctx, ctx.destination);
  ok(audio.ready === true, 'CombatAudio attaches to mocked AudioContext');
  ok(rec.bad.length === 0, 'attach schedules finite params', rec.bad.join(', '));

  // -------------------------------------------------- AIM-9 growl / lock tone
  let updateThrew = null;
  try {
    for (let i = 0; i < 60; i++) {
      audio.update(1 / 60, { weapon: 'AIM9', hasLock: false, rwrHighest: 'NONE', gStrain: 0 });
    }
  } catch (err) {
    updateThrew = err;
  }
  ok(!updateThrew, 'AIM9 growl update loop runs', updateThrew && updateThrew.message);
  const growlHz = audio._seekerOsc.frequency.value;
  ok(growlHz > 200 && growlHz < 240, 'growl sits near 220 Hz', growlHz.toFixed(2));
  ok(audio._seekerGain.gain.value > 0.05, 'growl gain audible');
  ok(audio._lockGain.gain.value === 0, 'lock tone silent without lock');

  audio.update(1 / 60, { weapon: 'AIM9', hasLock: true, rwrHighest: 'NONE', gStrain: 0 });
  ok(Math.abs(audio._lockOsc.frequency.value - 880) < 1, 'lock tone jumps to ~880 Hz', audio._lockOsc.frequency.value.toFixed(2));
  ok(audio._lockGain.gain.value > 0.04, 'lock tone gain audible');
  ok(audio._lockGain.gain.value > audio._seekerGain.gain.value, 'lock tone dominates seeker growl');

  audio.update(1 / 60, { weapon: 'GUN', hasLock: true, rwrHighest: 'NONE', gStrain: 0 });
  ok(audio._seekerGain.gain.value === 0 && audio._lockGain.gain.value === 0, 'non-AIM9 weapon silences seeker');

  // -------------------------------------------------- RWR states
  const oscBeforeNone = rec.oscillators.length;
  for (let i = 0; i < 30; i++) audio.update(1 / 60, { weapon: 'AIM9', hasLock: false, rwrHighest: 'NONE', gStrain: 0 });
  ok(rec.oscillators.length === oscBeforeNone, 'RWR NONE creates no pings');

  const oscBeforeSearch = rec.oscillators.length;
  audio.update(1 / 60, { weapon: 'AIM9', hasLock: false, rwrHighest: 'SEARCH', gStrain: 0 });
  const searchCreated = rec.oscillators.length - oscBeforeSearch;
  ok(searchCreated >= 1, 'RWR SEARCH emits a ping', 'osc=' + searchCreated);
  const oscAfterFirstSearch = rec.oscillators.length;
  audio.update(1 / 60, { weapon: 'AIM9', hasLock: false, rwrHighest: 'SEARCH', gStrain: 0 });
  ok(rec.oscillators.length === oscAfterFirstSearch, 'RWR SEARCH ping is rate limited');

  const oscBeforeLock = rec.oscillators.length;
  audio.update(1 / 60, { weapon: 'AIM9', hasLock: false, rwrHighest: 'LOCK', gStrain: 0 });
  const lockCreated = rec.oscillators.length - oscBeforeLock;
  ok(lockCreated >= 3, 'RWR LOCK emits a triple chirp', 'osc=' + lockCreated);
  ok(lockCreated > searchCreated, 'LOCK chirp is more urgent than SEARCH ping');

  const warble = [];
  for (let i = 0; i < 20; i++) {
    audio.update(0.1, { weapon: 'AIM9', hasLock: false, rwrHighest: 'LAUNCH', gStrain: 0.9 });
    warble.push(audio._rwrOsc.frequency.value);
  }
  ok(warble.some((f) => f > 1200), 'RWR LAUNCH warble hits high tone', warble.join(','));
  ok(warble.some((f) => f < 800), 'RWR LAUNCH warble hits low tone', warble.join(','));
  ok(audio._rwrGain.gain.value > 0.02, 'RWR LAUNCH warble audible');
  ok(audio._breathGain.gain.value > 0, 'G-strain breathing audible above 0.35', audio._breathGain.gain.value.toFixed(4));

  // -------------------------------------------------- paused
  const oscBeforePause = rec.oscillators.length;
  audio.update(0.2, { weapon: 'AIM9', hasLock: true, rwrHighest: 'LAUNCH', gStrain: 1, paused: true });
  ok(rec.oscillators.length === oscBeforePause, 'paused update schedules no new pings');
  ok(audio._seekerGain.gain.value === 0 && audio._lockGain.gain.value === 0, 'paused mutes seeker/lock');
  ok(audio._rwrGain.gain.value === 0 && audio._breathGain.gain.value === 0, 'paused mutes RWR/breathing');

  // -------------------------------------------------- one-shot SFX
  const shots = [
    ['cannonShot', () => audio.cannonShot()],
    ['missileLaunch', () => audio.missileLaunch()],
    ['bombRelease', () => audio.bombRelease()],
    ['flarePop', () => audio.flarePop()],
    ['explosion', () => audio.explosion(180)],
    ['sonicBoom', () => audio.sonicBoom()],
    ['radioBeep', () => audio.radioBeep()],
  ];
  for (const [name, fire] of shots) {
    const beforeOsc = rec.oscillators.length;
    const beforeBuf = rec.bufferSources.length;
    let err = null;
    try {
      fire();
    } catch (e) {
      err = e;
    }
    ok(!err, name + ' fires without throwing', err && err.message);
    ok(rec.oscillators.length + rec.bufferSources.length > beforeOsc + beforeBuf,
      name + ' creates audio sources');
  }

  // Distance attenuation on explosions.
  const gainsBeforeNear = rec.gains.length;
  audio.explosion(0);
  const nearGains = rec.gains.slice(gainsBeforeNear);
  const gainsBeforeFar = rec.gains.length;
  audio.explosion(8000);
  const farGains = rec.gains.slice(gainsBeforeFar);
  const peak = (list) => list.reduce((m, g) => Math.max(m, finite(g.gain.writtenPeak) ? g.gain.writtenPeak : 0), 0);
  const nearPeak = peak(nearGains);
  const farPeak = peak(farGains);
  ok(nearPeak > 0.2, 'near explosion has audible peak', nearPeak.toFixed(3));
  ok(farPeak < nearPeak * 0.35, 'far explosion is attenuated', 'near=' + nearPeak.toFixed(3) + ' far=' + farPeak.toFixed(3));

  // 13B: a Mk-82 hitting 3.5 km behind the jet must still be clearly audible,
  // while remaining quieter than a point-blank detonation.
  const gainsBeforeMid = rec.gains.length;
  audio.explosion(3500);
  const midPeak = peak(rec.gains.slice(gainsBeforeMid));
  const gainsBeforeClose = rec.gains.length;
  audio.explosion(50);
  const closePeak = peak(rec.gains.slice(gainsBeforeClose));
  ok(midPeak > 0.15, '13B: 3.5 km explosion is clearly audible', midPeak.toFixed(3));
  ok(midPeak < closePeak, '13B: 3.5 km explosion stays quieter than a close hit',
    'mid=' + midPeak.toFixed(3) + ' close=' + closePeak.toFixed(3));

  // Sanitising hostile inputs.
  let hostileThrew = null;
  try {
    for (let i = 0; i < 20; i++) {
      audio.update(Infinity, {
        weapon: 'AIM9',
        hasLock: i % 2 === 0,
        rwrHighest: i % 3 === 0 ? 'LAUNCH' : (i % 3 === 1 ? 'LOCK' : 'SEARCH'),
        gStrain: NaN,
      });
    }
    audio.explosion(NaN);
    audio.explosion(-Infinity);
    audio.update(-5, null);
  } catch (err) {
    hostileThrew = err;
  }
  ok(!hostileThrew, 'hostile inputs do not throw', hostileThrew && hostileThrew.message);

  // Every AudioParam value and scheduled time written must be finite/safe.
  ok(rec.bad.length === 0, 'all AudioParams finite and safe', rec.bad.slice(0, 6).join(' | '));
  const allParamsFinite = rec.params.every((v) => finite(v));
  ok(allParamsFinite, 'recorded param values are all finite');
  const oscFreqsOk = rec.oscillators.every((o) => finite(o.frequency.value) && o.frequency.value > 0);
  ok(oscFreqsOk, 'all oscillator frequencies positive and finite');
  const startsOk = rec.oscillators.every((o) => o.started.every((t) => finite(t) && t >= 0));
  ok(startsOk, 'oscillator start times are non-negative and finite');

  // Re-attach is idempotent and continues to run.
  let reattachThrew = null;
  try {
    audio.attach(ctx, ctx.destination);
    audio.update(1 / 60, { weapon: 'AIM9', hasLock: false, rwrHighest: 'SEARCH', gStrain: 0.5 });
  } catch (err) {
    reattachThrew = err;
  }
  ok(!reattachThrew, 're-attach to the same context is safe', reattachThrew && reattachThrew.message);
}

// ===========================================================================
// 5. Feature 12B: True 3D projection for GUN, CCIP BFL, AIM-9 & matrix sync
// ===========================================================================
{
  const W = 1280;
  const H = 720;
  const cam = new PerspectiveCamera(50, W / H, 0.1, 60000);
  cam.position.set(0, 120, 90);
  cam.lookAt(0, -30, -1200);
  cam.updateProjectionMatrix();
  let matrixUpdated = 0;
  const origUpdate = cam.updateMatrixWorld.bind(cam);
  cam.updateMatrixWorld = (...args) => { matrixUpdated++; return origUpdate(...args); };

  const makeGeoCtx = () => {
    const arcs = [];
    const lines = [];
    let cur = null;
    const base = makeCanvas();
    base.arc = (x, y, r) => { arcs.push({ x, y, r }); };
    base.moveTo = (x, y) => { cur = { x, y }; };
    base.lineTo = (x, y) => {
      if (cur) lines.push({ x0: cur.x, y0: cur.y, x1: x, y1: y });
      cur = { x, y };
    };
    return { ctx: base, arcs, lines };
  };

  const proj = (pt) => {
    origUpdate(true);
    const v = new Vector3(pt.x, pt.y, pt.z).project(cam);
    return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
  };

  // Follow-camera GUN pipper projects to 3D aimPoint (NOT hardcoded W*0.5, H*0.46)
  const overlay = new TacticalOverlay();
  const aimPt = { x: -47, y: -40, z: -260 };
  const expectedGun = proj(aimPt);
  const g1 = makeGeoCtx();
  overlay.draw(g1.ctx, W, H, {
    telemetry: { mode: 'chase', heading: 0, pitch: -4, roll: 0, position: new Vector3(0, 100, 0) },
    camera: cam,
    weapons: {
      selected: 'GUN',
      ammo: { GUN: 510, AIM9: 4, MK82: 6, FLARE: 30 },
      boresightPoint: { valid: true, x: -30, y: -10, z: -600 },
      gunSolution: { valid: true, aimPoint: aimPt, impactValid: true, impactPoint: aimPt, leadValid: false },
    },
  });
  ok(matrixUpdated > 0, '12B: TacticalOverlay.draw calls camera.updateMatrixWorld()');
  const gunArcHit = g1.arcs.some((a) => Math.hypot(a.x - expectedGun.x, a.y - expectedGun.y) < 2.0);
  ok(gunArcHit, '12B: follow-cam GUN pipper projects to exact 3D aimPoint',
    `expected (${expectedGun.x.toFixed(1)}, ${expectedGun.y.toFixed(1)})`);

  // MK-82 CCIP Bomb Fall Line starts at projected ccipOrigin and ends at projected ccip
  const ccipOrigin = { x: 0, y: 120, z: -200 };
  const ccipImpact = { x: 45, y: 0, z: -520 };
  const pOrig = proj(ccipOrigin);
  const pImp = proj(ccipImpact);
  const g2 = makeGeoCtx();
  overlay.draw(g2.ctx, W, H, {
    telemetry: { mode: 'chase', heading: 0, pitch: -10, roll: 0, position: new Vector3(0, 120, 0) },
    camera: cam,
    weapons: {
      selected: 'MK82',
      ammo: { GUN: 510, AIM9: 4, MK82: 6, FLARE: 30 },
      ccipOrigin: { valid: true, ...ccipOrigin },
      ccip: { valid: true, ...ccipImpact, timeToImpact: 2.8 },
    },
  });
  const bflMatch = g2.lines.some((l) =>
    Math.hypot(l.x0 - pOrig.x, l.y0 - pOrig.y) < 2.0 && Math.hypot(l.x1 - pImp.x, l.y1 - pImp.y) < 2.0);
  ok(bflMatch, '12B: CCIP BFL starts at projected ccipOrigin and ends at projected ccip');

  // AIM-9 seeker ring projects onto boresightPoint
  const borePt = { x: -60, y: -20, z: -550 };
  const pBore = proj(borePt);
  const g3 = makeGeoCtx();
  overlay.draw(g3.ctx, W, H, {
    telemetry: { mode: 'chase', heading: 0, pitch: 0, roll: 0, position: new Vector3(0, 100, 0) },
    camera: cam,
    weapons: {
      selected: 'AIM9',
      ammo: { GUN: 510, AIM9: 4, MK82: 6, FLARE: 30 },
      boresightPoint: { valid: true, ...borePt },
    },
  });
  const aim9Hit = g3.arcs.some((a) => Math.hypot(a.x - pBore.x, a.y - pBore.y) < 2.0);
  ok(aim9Hit, '12B: AIM-9 seeker ring renders at projected 3D boresightPoint');

  // 13B: when the CCIP impact point projects below the bottom of the screen
  // (level flight), the overlay must clamp a Delayed-CCIP bar onto the bottom
  // edge instead of dropping the pipper entirely.
  {
    const camLow = new PerspectiveCamera(50, W / H, 0.1, 60000);
    camLow.position.set(0, 400, 0);
    camLow.lookAt(0, 400, -3000);
    camLow.updateProjectionMatrix();
    camLow.updateMatrixWorld(true);

    const ccipBelow = { x: 0, y: 0, z: -400 }; // ~45 deg depression -> below HUD
    camLow.updateMatrixWorld(true);
    const vBelow = new Vector3(ccipBelow.x, ccipBelow.y, ccipBelow.z).project(camLow);
    const projBelow = { x: (vBelow.x * 0.5 + 0.5) * W, y: (-vBelow.y * 0.5 + 0.5) * H };
    ok(projBelow.y > H, '13B: test ccip actually projects below the screen', 'y=' + projBelow.y.toFixed(1));

    const g4 = makeGeoCtx();
    let lowThrew = null;
    try {
      overlay.draw(g4.ctx, W, H, {
        telemetry: { mode: 'cockpit', heading: 0, pitch: 0, roll: 0, position: new Vector3(0, 400, 0) },
        camera: camLow,
        weapons: {
          selected: 'MK82',
          ammo: { GUN: 0, AIM9: 0, MK82: 4, FLARE: 0 },
          ccipOrigin: { valid: true, x: 0, y: 380, z: -600 },
          ccip: { valid: true, ...ccipBelow, timeToImpact: 1.8 },
        },
      });
    } catch (err) {
      lowThrew = err;
    }
    ok(!lowThrew, '13B: delayed-CCIP draw is safe', lowThrew && lowThrew.message);

    const sLow = Math.min(W / 1600, H / 900);
    const barY = H - 18 * sLow;
    const barDrawn = g4.lines.some((l) =>
      Math.abs(l.y0 - barY) < 1.5 && Math.abs(l.y1 - barY) < 1.5 && Math.abs(l.x1 - l.x0) > 20 * sLow);
    ok(barDrawn, '13B: horizontal delayed-CCIP bar clamped to the HUD bottom edge');

    const lowTexts = g4.ctx.__state.texts;
    ok(lowTexts.some((t) => t.includes('MK-82') && t.includes('1.8s')),
      '13B: delayed-CCIP time-to-impact label rendered', lowTexts.join('|'));
    const fallLineToCue = g4.lines.some((l) => Math.abs(l.y1 - barY) < 1.5 && Math.abs(l.x1 - 640) < 2.0);
    ok(fallLineToCue, '13B: fall line still runs from the origin down to the clamped cue');
  }
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`tactical checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) {
  process.exitCode = 1;
} else {
  console.log('ALL TACTICAL CHECKS PASSED');
}