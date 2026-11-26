// Node-only acceptance test for Feature 30 — Vipava Valley hero scenarios,
// authentic burja wind and the Soča & Vipava canyon run.
// Run: node tests/vipava_scenarios_test.mjs
//
// Covers:
//   * WIND.burja fixed NE heading (045 deg -> blows toward SW, windX<0,
//     windZ>0), locked windAngle and crisp gust pulses, weather backwards
//     compatibility.
//   * MISSIONS.soca_run / nanos_sead / adriatic_cap metadata and the
//     MissionDirector target packages anchored to real baked landmarks.
//   * CanyonRunSystem headless lifecycle: gates, timer, progression, splits,
//     finish detection and GOLD/SILVER/BRONZE medals, plus the Three.js
//     visual path against a stub scene.

import { WIND, WEATHER } from '../src/config.js';
import { WeatherSystem } from '../src/sim/weather.js';
import { MISSIONS, VIPAVA_MISSIONS, MissionDirector } from '../src/combat/missions.js';
import {
  CANYON_GATES,
  CanyonRunSystem,
  MEDAL_GOLD_S,
  MEDAL_SILVER_S,
} from '../src/combat/canyon_run.js';
import { terrainHeight, spawnPoint } from '../src/world/terrain.js';

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);
function near(a, b, tol, msg) {
  check(Number.isFinite(a) && Math.abs(a - b) <= tol, `${msg} (got ${fmt(a)}, want ${fmt(b)} +/-${tol})`);
}
const DEG = Math.PI / 180;
const KTS = 1.943844;

const world = { heightAt: terrainHeight };
const spawn = spawnPoint();

// ---------------------------------------------------------------------------
// 1. Authentic Vipava burja
// ---------------------------------------------------------------------------
{
  const burja = WIND.burja;
  check(!!burja, 'WIND.burja is missing');
  check(burja && burja.label === 'BURJA · 42 KT NE', 'WIND.burja label changed');
  near(burja ? burja.speed : NaN, 21.6, 0.001, 'burja speed');
  near(burja ? burja.gustiness : NaN, 1.0, 0.001, 'burja gustiness');
  near(burja ? burja.turbulence : NaN, 1.55, 0.001, 'burja turbulence');
  near(burja ? burja.dirRad : NaN, Math.PI * 0.75, 1e-9, 'burja dirRad must be 045 deg (0.75 pi)');
  check(Object.keys(WIND).includes('burja'), 'burja must be enumerable so the U key cycles it');

  const w = new WeatherSystem('few', 'burja');
  check(w.windPresetName === 'burja', 'WeatherSystem did not adopt the burja preset');
  near(w.state.windSpeed, 21.6, 0.01, 'burja wind speed target not applied on construction');
  near(w.state.turbulence, 1.55, 0.01, 'burja turbulence target not applied');
  near(w.windAngle, Math.PI * 0.75, 0.001, 'burja must start locked at 045 deg');

  const out = { x: 0, y: 0, z: 0 };
  w.windAt(0, 0, 600, out);
  check(out.x < 0, `burja windX must be negative (toward west), got ${fmt(out.x)}`);
  check(out.z > 0, `burja windZ must be positive (toward south), got ${fmt(out.z)}`);
  check(Math.hypot(out.x, out.z) > 18, `burja must be strong (>18 m/s), got ${fmt(Math.hypot(out.x, out.z))}`);
  near(Math.atan2(out.z, out.x) / DEG, 135, 6, 'burja must blow toward 225 deg (world atan2 135 deg)');

  // Direction and strength hold across the valley.
  let dirOk = true;
  let strengthOk = true;
  let maxMag = 0;
  for (let x = -30000; x <= 30000; x += 6000) {
    for (let z = -30000; z <= 30000; z += 6000) {
      w.windAt(x, z, 600, out);
      const mag = Math.hypot(out.x, out.z);
      if (!(out.x < 0 && out.z > 0)) dirOk = false;
      if (mag <= 18) strengthOk = false;
      if (mag > maxMag) maxMag = mag;
    }
  }
  check(dirOk, 'burja flow direction flipped somewhere in the valley');
  check(strengthOk, 'burja is weaker than 18 m/s somewhere in the valley');
  check(maxMag > 21.6 * 1.1, `burja must produce crisp gust pulses above base speed (max ${fmt(maxMag)})`);

  // Locked heading: no continuous veer, only subtle gusting veer (+/-0.12 rad).
  for (let i = 0; i < 600; i++) w.update(0.1);
  near(w.windAngle, Math.PI * 0.75, 0.12, 'burja windAngle drifted away from the locked 045 deg');
  w.windAt(5000, -5000, 800, out);
  check(out.x < 0 && out.z > 0, 'burja direction flipped after long simulation');

  // Backwards compatibility: unpinned presets still veer and stay finite.
  const legacy = new WeatherSystem('few', 'gale');
  check(legacy._lockedDir === null, 'gale must not lock the wind direction');
  const angle0 = legacy.windAngle;
  legacy.update(10);
  check(legacy.windAngle > angle0, 'unpinned wind must keep slowly veering with time');
  legacy.windAt(0, 0, 1500, out);
  check(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z),
    'windAt must stay finite for legacy presets');
  const auto = new WeatherSystem('few', 'auto');
  near(auto.state.windSpeed, WEATHER.few.windSpeed, 0.01, 'auto wind preset must fall back to weather speed');
}

// ---------------------------------------------------------------------------
// 2. Vipava scenario metadata
// ---------------------------------------------------------------------------
{
  // Core missions must survive untouched (tests/missions_test.mjs contract).
  check(Object.keys(MISSIONS).length === 4, `MISSIONS must still enumerate four core missions, got ${Object.keys(MISSIONS).length}`);
  for (const id of ['free', 'sead', 'strike', 'cap']) check(!!MISSIONS[id], `legacy mission ${id} missing`);
  check(MISSIONS.sead.label === 'WILD WEASEL', 'legacy SEAD label changed');

  const EXPECT = {
    soca_run: { label: 'SOČA CANYON RUN', short: 'CANYON' },
    nanos_sead: { label: 'NANOS SEAD', short: 'NANOS' },
    adriatic_cap: { label: 'ADRIATIC INTERCEPT', short: 'ADRIATIC' },
  };
  for (const [id, exp] of Object.entries(EXPECT)) {
    const m = MISSIONS[id];
    check(!!m, `MISSIONS.${id} missing`);
    check(!!VIPAVA_MISSIONS[id] && VIPAVA_MISSIONS[id] === m, `VIPAVA_MISSIONS.${id} must be the MISSIONS entry`);
    check(m && m.id === id, `MISSIONS.${id}.id mismatch`);
    check(m && m.label === exp.label, `MISSIONS.${id}.label should be \"${exp.label}\"`);
    check(m && m.short === exp.short, `MISSIONS.${id}.short should be \"${exp.short}\"`);
    check(m && m.theater === 'vipava', `MISSIONS.${id}.theater should be vipava`);
    check(m && typeof m.briefing === 'string' && m.briefing.length > 40, `MISSIONS.${id}.briefing missing`);
  }
  check(/Ajdovščina/.test(MISSIONS.soca_run.briefing), 'soca_run briefing must name Ajdovščina');
  check(/Nanos ridge/.test(MISSIONS.nanos_sead.briefing), 'nanos_sead briefing must name the Nanos ridge');
  check(/Gulf of Trieste/.test(MISSIONS.adriatic_cap.briefing), 'adriatic_cap briefing must name the Gulf of Trieste');
}

// ---------------------------------------------------------------------------
// 3. NANOS SEAD target package
// ---------------------------------------------------------------------------
{
  const NANOS = [
    { kind: 'RADAR', x: 12750, z: 12800 },
    { kind: 'SAM', x: 13080, z: 12650 },
    { kind: 'SAM', x: 4720, z: 4320 },
    { kind: 'DEPOT', x: 5200, z: 4850 },
  ];

  const a = new MissionDirector();
  const b = new MissionDirector();
  const specs = a.startMission('nanos_sead', spawn, world);
  const specsB = b.startMission('nanos_sead', spawn, world);

  check(Array.isArray(specs) && specs.length === 4, `nanos_sead must spawn 4 targets, got ${specs && specs.length}`);
  check(JSON.stringify(specs) === JSON.stringify(specsB), 'nanos_sead package is not deterministic');
  check(a.status === 'ACTIVE', `nanos_sead should start ACTIVE, got ${a.status}`);
  check(a.totalObjectives === 4, 'nanos_sead totalObjectives mismatch');

  specs.forEach((s, i) => {
    const want = NANOS[i];
    check(s.kind === want.kind, `nanos_sead target ${i} kind ${s.kind}, want ${want.kind}`);
    near(s.x, want.x, 0.001, `nanos_sead target ${i} x (${s.label})`);
    near(s.z, want.z, 0.001, `nanos_sead target ${i} z (${s.label})`);
    near(s.y, terrainHeight(want.x, want.z), 0.001, `nanos_sead target ${i} y must use world.heightAt`);
    check(typeof s.id === 'string' && s.id.startsWith('nanos_sead-'), `nanos_sead target ${i} bad id ${s.id}`);
    check(typeof s.label === 'string' && s.label.length > 3, `nanos_sead target ${i} missing label`);
    const obj = a.objectives[i];
    check(obj && obj.id === s.id && obj.alive === true, `nanos_sead objective ${i} missing`);
    near(obj ? obj.y : NaN, terrainHeight(want.x, want.z), 0.001, `nanos_sead objective ${i} y`);
  });

  check(a.radio.length >= 1 && a.radio[0].sender === 'OVERLORD', 'nanos_sead opening call must come from OVERLORD');
  check(/OVERLORD: POP-UP SA-6 ON NANOS RIDGE — CLEARED TO ENGAGE\./.test(a.radio[0].text),
    `nanos_sead opening call text wrong: ${a.radio[0].text}`);

  for (const s of specs) a.notifyDestroyed([{ id: s.id, kind: s.kind, label: s.label, position: { x: s.x, y: 0, z: s.z } }]);
  check(a.status === 'RTB', `nanos_sead expected RTB after all kills, got ${a.status}`);
  check(a.score === 250 + 350 + 350 + 250, `nanos_sead score ${a.score}, expected 1200`);
  check(a.radio.some((m) => /SHACK! TARGET DESTROYED/.test(m.text)), 'nanos_sead missing SHACK callout');
}

// ---------------------------------------------------------------------------
// 4. ADRIATIC INTERCEPT target package
// ---------------------------------------------------------------------------
{
  const GULF = [
    { x: -11000, z: 22000 },
    { x: -13500, z: 19500 },
    { x: -9000, z: 24000 },
  ];
  const NG = { x: -18000, z: -7000 };

  const a = new MissionDirector();
  const specs = a.startMission('adriatic_cap', spawn, world);

  check(specs.length === 3, `adriatic_cap must spawn 3 bandits, got ${specs.length}`);
  check(a.status === 'ACTIVE', `adriatic_cap should start ACTIVE, got ${a.status}`);
  check(a.totalObjectives === 3, 'adriatic_cap totalObjectives mismatch');

  specs.forEach((s, i) => {
    const want = GULF[i];
    check(s.kind === 'BANDIT', `adriatic_cap target ${i} should be BANDIT, got ${s.kind}`);
    check(s.label === 'MIG-29', `adriatic_cap target ${i} label should be MIG-29`);
    near(s.x, want.x, 0.001, `adriatic_cap bandit ${i} x`);
    near(s.z, want.z, 0.001, `adriatic_cap bandit ${i} z`);
    check(s.alt >= 1800 && s.alt <= 2400, `adriatic_cap bandit ${i} alt ${fmt(s.alt)} outside 1800-2400 m`);
    check(s.orbitRadius > 0 && s.speed > 0, `adriatic_cap bandit ${i} missing orbit/speed`);

    const wantHdg = Math.atan2(NG.x - want.x, -(NG.z - want.z)) / DEG;
    near(s.heading, (wantHdg + 360) % 360, 1, `adriatic_cap bandit ${i} must head for Nova Gorica`);
    check(s.heading > 315 || s.heading < 45, `adriatic_cap bandit ${i} heading ${fmt(s.heading)} is not northerly`);
    check(s.destination && s.destination.x === NG.x && s.destination.z === NG.z,
      `adriatic_cap bandit ${i} destination should be Nova Gorica`);

    const obj = a.objectives[i];
    near(obj ? obj.y : NaN, s.alt, 0.001, `adriatic_cap objective ${i} y should be the bandit alt`);
  });

  check(a.radio[0].sender === 'OVERLORD', 'adriatic_cap opening call must come from OVERLORD');
  check(/OVERLORD: FAST MOVERS FEET DRY OVER TRIESTE — INTERCEPT!/.test(a.radio[0].text),
    `adriatic_cap opening call text wrong: ${a.radio[0].text}`);

  for (const s of specs) a.notifyDestroyed([{ id: s.id, kind: s.kind, label: s.label, position: { x: s.x, y: s.alt, z: s.z } }]);
  check(a.score === 1500, `adriatic_cap score ${a.score}, expected 1500`);
  check(a.status === 'RTB', `adriatic_cap expected RTB after all bandits die, got ${a.status}`);
  check(a.radio.some((m) => /SPLASH ONE BANDIT/.test(m.text)), 'adriatic_cap missing SPLASH callout');
}

// ---------------------------------------------------------------------------
// 5. SOČA CANYON RUN mission: no hostiles, steerpoint on Gate 1
// ---------------------------------------------------------------------------
{
  const d = new MissionDirector();
  const specs = d.startMission('soca_run', spawn, world);

  check(Array.isArray(specs) && specs.length === 0, `soca_run must spawn 0 hostiles, got ${specs && specs.length}`);
  check(d.totalObjectives === 0, 'soca_run should have no objectives');
  check(d.status === 'ACTIVE', `soca_run should stay ACTIVE, got ${d.status}`);
  check(d.radio.length === 1 && d.radio[0].sender === 'RANGE CONTROL',
    'soca_run opening call must come from RANGE CONTROL');
  check(d.radio[0].text === 'RANGE CONTROL: VIPER 1-1 CLEARED HOT FOR SOČA CANYON RUN — STAY LOW!',
    `soca_run opening call text wrong: ${d.radio[0].text}`);

  const g0 = CANYON_GATES[0];
  const pos = { x: spawn.x, y: spawn.y + 800, z: spawn.z };
  const snap = d.update(0.016, { position: pos, heading: spawn.heading, speed: 200, onGround: false });

  const sp = snap.steerpoint;
  check(!!sp, 'soca_run must expose a steerpoint');
  check(sp && /GATE 1/.test(sp.label) && sp.label.includes(g0.name),
    `soca_run steerpoint label should name Gate 1 (${sp && sp.label})`);
  near(sp ? sp.x : NaN, g0.x, 0.001, 'soca_run steerpoint x should be Gate 1');
  near(sp ? sp.z : NaN, g0.z, 0.001, 'soca_run steerpoint z should be Gate 1');
  near(sp ? sp.y : NaN, terrainHeight(g0.x, g0.z) + g0.agl, 0.001, 'soca_run steerpoint y should be Gate 1 gate height');

  // No hostiles means nothing to destroy and no RTB kick-out.
  d.notifyDestroyed([{ id: 'nothing', kind: 'SAM', label: 'X', position: { x: 0, y: 0, z: 0 } }]);
  check(d.status === 'ACTIVE' && d.score === 0, 'soca_run must ignore destruction reports');
  const s2 = d.update(0.016, { position: pos, heading: spawn.heading, speed: 200 });
  check(s2.steerpoint && /GATE 1/.test(s2.steerpoint.label), 'soca_run steerpoint must persist');
}

// ---------------------------------------------------------------------------
// 6. CanyonRunSystem — course definition
// ---------------------------------------------------------------------------
{
  const WANT = [
    ['LJAJ DEPARTURE', -2200, -150, 110, 130, 270],
    ['VIPAVA VALLEY', -7500, -850, 110, 130, 275],
    ['VOGRŠČEK DAM', -13005, -1534, 95, 125, 290],
    ['ŠEMPETER APPROACH', -16800, -4200, 100, 125, 315],
    ['GORIZIA CASTLE', -19500, -6350, 115, 125, 10],
    ['SOČA GORGE ENTRY', -18600, -8600, 90, 115, 15],
    ['SOLKAN ARCH BRIDGE', -18201, -10035, 85, 110, 20],
    ['SVETA GORA FINISH', -17720, -11947, 130, 145, 15],
  ];
  check(CANYON_GATES.length === 8, `CANYON_GATES must define 8 gates, got ${CANYON_GATES.length}`);
  CANYON_GATES.forEach((g, i) => {
    const want = WANT[i];
    check(g.name === want[0], `gate ${i + 1} name ${g.name}, want ${want[0]}`);
    near(g.x, want[1], 0.001, `gate ${i + 1} x`);
    near(g.z, want[2], 0.001, `gate ${i + 1} z`);
    near(g.agl, want[3], 0.001, `gate ${i + 1} agl`);
    near(g.radius, want[4], 0.001, `gate ${i + 1} radius`);
    near(g.headingDeg, want[5], 0.001, `gate ${i + 1} headingDeg`);
    check(typeof g.id === 'string' && g.id.length > 0, `gate ${i + 1} missing id`);
  });
  near(MEDAL_GOLD_S, 95, 1e-9, 'GOLD cut-off must be 95 s');
  near(MEDAL_SILVER_S, 125, 1e-9, 'SILVER cut-off must be 125 s');
}

// ---------------------------------------------------------------------------
// 7. CanyonRunSystem — headless lifecycle
// ---------------------------------------------------------------------------
{
  const run = new CanyonRunSystem();
  check(run.getState().totalGates === 8, 'headless run should still know all 8 gates');
  check(run.active === false, 'system must not start active');
  check(run.group === null, 'headless system must not build a Three.js group');

  run.start(world);
  check(run.active === true, 'start() must set active');
  check(run.gateIndex === 0 && run.elapsed === 0 && run.finished === false && run.medal === null,
    'start() must reset gateIndex/elapsed/finished/medal');
  check(Array.isArray(run.splits) && run.splits.length === 0, 'start() must clear splits');
  check(run.bestSpeedKts === 0, 'start() must clear bestSpeedKts');
  run.gates.forEach((g, i) => {
    near(g.y, terrainHeight(g.x, g.z) + CANYON_GATES[i].agl, 0.001, `gate ${i + 1} must be grounded at heightAt+agl`);
  });

  // Timer runs from the start even before Gate 1.
  let res = run.update(2.5, { x: 0, y: 300, z: 0 }, 200);
  near(run.elapsed, 2.5, 1e-9, 'timer must accumulate immediately');
  check(res.gatePassed === null && res.finished === false, 'no gate should pass while far away');

  // Off-axis and vertical misses must not count.
  const g0 = run.gates[0];
  res = run.update(1, { x: g0.x + 5000, y: g0.y, z: g0.z }, 200);
  check(res.gatePassed === null && run.gateIndex === 0, 'gate must not pass 5 km off-axis');
  res = run.update(1, { x: g0.x, y: g0.y + g0.radius * 2, z: g0.z }, 200);
  check(res.gatePassed === null && run.gateIndex === 0, 'gate must not pass when flown far above the ring');

  // Centre of Gate 1 registers a gate + split.
  res = run.update(1, { x: g0.x, y: g0.y, z: g0.z }, 250);
  check(res.gatePassed && res.gatePassed.id === g0.id, `Gate 1 did not register (${res.gatePassed && res.gatePassed.id})`);
  check(run.gateIndex === 1, `gateIndex should be 1 after Gate 1, got ${run.gateIndex}`);
  check(run.splits.length === 1 && run.splits[0].name === g0.name, 'split for Gate 1 missing');
  near(run.splits[0].t, run.elapsed, 1e-9, 'split time must equal elapsed');
  near(run.bestSpeedKts, 250 * KTS, 0.01, 'bestSpeedKts must track the fastest pass');

  // getState() navigation helpers.
  const st = run.getState();
  check(st.gateIndex === 1 && st.nextGate && st.nextGate.id === run.gates[1].id, 'nextGate should be Gate 2');
  near(st.distToNextM, Math.hypot(run.gates[1].x - g0.x, run.gates[1].z - g0.z), 0.5, 'distToNextM');
  const wantBrg = (Math.atan2(run.gates[1].x - g0.x, -(run.gates[1].z - g0.z)) / DEG + 360) % 360;
  near(st.bearingToNextDeg, wantBrg, 0.01, 'bearingToNextDeg');

  // Finish the course in order.
  let finishedOn = -1;
  for (let i = 1; i < run.gates.length; i++) {
    const g = run.gates[i];
    res = run.update(10, { x: g.x, y: g.y, z: g.z }, 260);
    check(res.gatePassed && res.gatePassed.id === g.id, `gate ${i + 1} did not register in order`);
    if (res.finished) finishedOn = i;
    if (i < run.gates.length - 1) check(res.finished === false, `finished early on gate ${i + 1}`);
  }
  check(finishedOn === 7, 'finish must trigger on the eighth gate only');
  check(run.finished === true && res.finished === true, 'finish flag not set');
  check(res.medal === 'GOLD' && run.medal === 'GOLD', `classic run should be GOLD, got ${run.medal}`);
  check(run.splits.length === 8, `expected 8 splits, got ${run.splits.length}`);
  check(run.finishTimeS === run.elapsed, 'finishTimeS must freeze the finish time');

  const end = run.getState();
  check(end.finished === true && end.medal === 'GOLD', 'getState() must report the finish and medal');
  check(end.nextGate === null, 'no next gate after the finish');
  check(end.distToNextM === 0, 'distToNextM must be 0 after the finish');
  check(end.totalGates === 8 && end.gateIndex === 8, 'gate counters after the finish');

  // The clock stops at the finish line.
  const frozen = run.elapsed;
  run.update(30, { x: 0, y: 0, z: 0 }, 200);
  near(run.elapsed, frozen, 1e-9, 'timer must stop once finished');
}

// ---------------------------------------------------------------------------
// 8. Medal thresholds (95 / 125 s boundaries)
// ---------------------------------------------------------------------------
{
  function flyCourse(dtPerGate) {
    const run = new CanyonRunSystem();
    run.start(world);
    for (const g of run.gates) run.update(dtPerGate, { x: g.x, y: g.y, z: g.z }, 240);
    return run;
  }

  const gold = flyCourse(95 / 8);       // exactly 95 s
  check(gold.medal === 'GOLD', `exactly 95 s must be GOLD, got ${gold.medal} (elapsed ${fmt(gold.elapsed)})`);

  const silverEdge = flyCourse(95.5 / 8);
  check(silverEdge.medal === 'SILVER', `95.5 s must be SILVER, got ${silverEdge.medal}`);

  const silver = flyCourse(125 / 8);    // exactly 125 s
  check(silver.medal === 'SILVER', `exactly 125 s must be SILVER, got ${silver.medal} (elapsed ${fmt(silver.elapsed)})`);

  const bronze = flyCourse(125.5 / 8);
  check(bronze.medal === 'BRONZE', `125.5 s must be BRONZE, got ${bronze.medal}`);
}

// ---------------------------------------------------------------------------
// 9. stop() / dispose() and the Three.js visual path
// ---------------------------------------------------------------------------
{
  const run = new CanyonRunSystem();
  run.start(world);
  run.update(1, { x: run.gates[0].x, y: run.gates[0].y, z: run.gates[0].z }, 200);
  const at = run.elapsed;
  run.stop();
  check(run.active === false, 'stop() must clear active');
  run.update(5, { x: 0, y: 0, z: 0 }, 200);
  near(run.elapsed, at, 1e-9, 'stopped run must not keep timing');
  const afterStop = run.getState();
  check(afterStop.active === false && afterStop.gateIndex === 1, 'stop() must preserve progress but flag inactive');
  run.dispose();
  check(run.gates.length === 0, 'dispose() must forget the course');
  check(run.scene === null, 'dispose() must drop the scene reference');
}

// Visual path against a stub scene: exercises ring/pillar construction
// without needing WebGL (THREE geometry maths is headless-safe).
{
  const fakeScene = {
    added: [],
    removed: [],
    add(obj) { this.added.push(obj); obj.parent = this; },
    remove(obj) { this.removed.push(obj); obj.parent = null; },
  };
  const run = new CanyonRunSystem(fakeScene);
  run.start(world);

  check(fakeScene.added.length === 1, 'start() must add one gate group to the scene');
  check(run.gates.every((g) => g.ring && g.mat), 'every gate must build a ring mesh/material');
  check(run.gates[0].mat.color.getHex() === 0x38ffe0,
    `active gate should pulse cyan-gold, got #${run.gates[0].mat.color.getHex().toString(16)}`);

  const g1 = run.gates[1];
  near(g1.ring.rotation.y, Math.PI - (CANYON_GATES[1].headingDeg * DEG), 1e-9,
    'ring must be oriented perpendicular to the gate heading');
  near(g1.ring.position.x, g1.x, 1e-9, 'ring x');
  near(g1.ring.position.y, g1.y, 1e-9, 'ring y must sit at heightAt + agl');
  near(g1.ring.position.z, g1.z, 1e-9, 'ring z');

  const g0 = run.gates[0];
  run.update(0.5, { x: g0.x, y: g0.y, z: g0.z }, 300);
  check(run.gates[0].mat.color.getHex() === 0x44ff88, 'passed gate must turn emerald');
  check(run.gates[0].mat.opacity < 0.5, 'passed gate must begin fading');
  check(run.gates[1].mat.color.getHex() === 0x38ffe0, 'next gate must become the active pulse');
  check(run._pillar && run._pillar.visible === true, 'active gate must raise a beacon pillar');
  near(run._pillar.position.x, run.gates[1].x, 1e-9, 'beacon pillar must follow the active gate');
  check(run._pillar.position.y > run.gates[1].y, 'beacon pillar must rise above the gate');

  run.stop();
  check(fakeScene.removed.length === 1, 'stop() must remove the gate group from the scene');
  check(run._pillar === null && run._ringGeo === null, 'stop() must release visual resources');
  run.stop();
  run.dispose();
  check(fakeScene.removed.length === 1, 'stop()/dispose() must be idempotent');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Feature 30 — Vipava scenarios, burja & canyon run');
console.log('=================================================');
console.log(`  WIND.burja        ${WIND.burja.label} @ ${WIND.burja.speed} m/s, dir ${(WIND.burja.dirRad / DEG).toFixed(0)} deg`);
console.log(`  Vipava missions   ${Object.keys(VIPAVA_MISSIONS).join(', ')}`);
console.log(`  Canyon gates      ${CANYON_GATES.length} (${CANYON_GATES[0].name} -> ${CANYON_GATES[7].name})`);
console.log(`  Medals            GOLD <= ${MEDAL_GOLD_S}s, SILVER <= ${MEDAL_SILVER_S}s, BRONZE > ${MEDAL_SILVER_S}s`);
console.log(`checks: ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  process.exitCode = 1;
} else {
  console.log('\nALL CHECKS PASSED');
}