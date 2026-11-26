// Node-only acceptance test for src/combat/missions.js.
// Run: node tests/missions_test.mjs
//
// Covers deterministic target package generation, dry-land placement,
// steerpoint navigation maths (North = -Z, East = +X), ACTIVE -> RTB ->
// COMPLETE transitions, AWACS radio cadence/expiry and SPIKE rate limiting.

import { MISSIONS, MissionDirector } from '../src/combat/missions.js';
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
const D2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const world = { heightAt: terrainHeight };
const spawn = spawnPoint();

// ---------------------------------------------------------------------------
// 1. Mission metadata
// ---------------------------------------------------------------------------
check(Object.keys(MISSIONS).length === 4, 'MISSIONS must define four missions');
for (const id of ['free', 'sead', 'strike', 'cap']) {
  const m = MISSIONS[id];
  check(!!m, `missing MISSIONS.${id}`);
  check(m && m.id === id, `MISSIONS.${id}.id mismatch`);
  check(m && typeof m.label === 'string' && m.label.length > 3, `MISSIONS.${id}.label missing`);
  check(m && typeof m.short === 'string' && m.short.length >= 3, `MISSIONS.${id}.short missing`);
  check(m && typeof m.briefing === 'string' && m.briefing.length > 20, `MISSIONS.${id}.briefing missing`);
}
check(MISSIONS.sead.label === 'WILD WEASEL', 'SEAD label changed');
check(MISSIONS.strike.label === 'BAGHDAD STRIKE', 'STRIKE label changed');
check(MISSIONS.cap.label === 'BARCAP SWEEP', 'CAP label changed');

// ---------------------------------------------------------------------------
// 2. Deterministic packages, counts, placement and ranges
// ---------------------------------------------------------------------------
const EXPECT = {
  free: { kinds: [] },
  sead: { kinds: ['RADAR', 'SAM', 'SAM'], min: 7000, max: 10000 },
  strike: { kinds: ['DEPOT', 'DEPOT', 'RADAR', 'SAM'], min: 9000, max: 12000 },
  cap: { kinds: ['BANDIT', 'BANDIT', 'BANDIT'], min: 8000, max: 13000 },
};

const starts = {};
for (const [id, exp] of Object.entries(EXPECT)) {
  const a = new MissionDirector();
  const b = new MissionDirector();
  const specsA = a.startMission(id, spawn, world);
  const specsB = b.startMission(id, spawn, world);

  check(Array.isArray(specsA), `${id}: startMission must return an array`);
  check(specsA.length === exp.kinds.length, `${id}: expected ${exp.kinds.length} targets, got ${specsA.length}`);
  check(JSON.stringify(specsA) === JSON.stringify(specsB), `${id}: target package is not deterministic`);
  check(a.totalObjectives === specsA.length, `${id}: totalObjectives mismatch`);
  check(a.status === (id === 'free' ? 'FREE' : 'ACTIVE'), `${id}: bad initial status ${a.status}`);

  const ids = new Set(specsA.map((s) => s.id));
  check(ids.size === specsA.length, `${id}: duplicate target ids`);

  specsA.forEach((s, i) => {
    check(s.kind === exp.kinds[i], `${id}: target ${i} kind ${s.kind}, expected ${exp.kinds[i]}`);
    check(typeof s.id === 'string' && s.id.length > 0, `${id}: target ${i} missing id`);
    check(typeof s.label === 'string' && s.label.length > 0, `${id}: target ${i} missing label`);
    check(Number.isFinite(s.x) && Number.isFinite(s.z), `${id}: target ${i} bad position`);
    check(D2(s, spawn) >= exp.min - 1 && D2(s, spawn) <= exp.max + 1,
      `${id}: target ${i} at ${fmt(D2(s, spawn))} m is outside ${exp.min}-${exp.max} m`);

    if (s.kind === 'BANDIT') {
      check(s.alt >= 1400 && s.alt <= 2800, `${id}: bandit altitude ${fmt(s.alt)} outside 1400-2800 m`);
      check(s.orbitRadius > 0 && s.speed > 0, `${id}: bandit missing orbit/speed`);
    } else {
      check(terrainHeight(s.x, s.z) > 1, `${id}: ${s.kind} placed in water (h=${fmt(terrainHeight(s.x, s.z))})`);
    }
  });

  // Ground targets must not overlap each other.
  const ground = specsA.filter((s) => s.kind !== 'BANDIT');
  for (let i = 0; i < ground.length; i++) {
    for (let j = i + 1; j < ground.length; j++) {
      check(D2(ground[i], ground[j]) > 200,
        `${id}: ground targets ${ground[i].id}/${ground[j].id} overlap (${fmt(D2(ground[i], ground[j]))} m)`);
    }
  }

  // Opening AWACS call is queued.
  check(a.radio.length >= 1, `${id}: no opening radio callout`);
  check(a.radio[0] && a.radio[0].sender === 'MAGIC', `${id}: opening call not from MAGIC`);
  if (id === 'sead' || id === 'strike') {
    check(/CLEARED HOT/.test(a.radio[0].text), `${id}: opening call missing CLEARED HOT`);
  } else if (id === 'cap') {
    check(/BOGEYS/.test(a.radio[0].text), 'cap: opening call missing BOGEYS');
  } else {
    check(/FREE FLIGHT/.test(a.radio[0].text), 'free: opening call missing FREE FLIGHT');
  }
  starts[id] = { director: a, specs: specsA };
}

// Free flight is peaceful and has no steerpoint.
{
  const free = starts.free.director;
  const snap = free.update(0.016, {
    position: { x: spawn.x, y: spawn.y, z: spawn.z },
    heading: spawn.heading,
    speed: 0,
    onGround: true,
  });
  check(snap.status === 'FREE', 'free: status should stay FREE');
  check(snap.totalObjectives === 0 && snap.score === 0, 'free: should have no objectives/score');
  check(snap.steerpoint === null, 'free: steerpoint should be null');
}

// Coast search: with land only far to the east, sea placement must be avoided.
{
  const coastWorld = { heightAt: (x) => (x > 6000 ? 140 : -40) };
  const d = new MissionDirector();
  const specs = d.startMission('sead', { x: 0, z: 0, heading: 90, airport: null }, coastWorld);
  check(specs.length === 3, 'coast: expected 3 SEAD targets');
  for (const s of specs) {
    check(coastWorld.heightAt(s.x, s.z) > 1,
      `coast: ${s.id} placed in water at x=${fmt(s.x)}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Steerpoint bearing / distance / relative bearing maths
// ---------------------------------------------------------------------------
{
  const { director: d, specs } = starts.sead;
  const keep = specs[0];
  // Leave exactly one objective alive so the steerpoint is unambiguous.
  for (const s of specs.slice(1)) {
    d.notifyDestroyed([{ id: s.id, kind: s.kind, label: s.label, position: { x: s.x, y: 0, z: s.z } }]);
  }
  check(d.status === 'ACTIVE', 'bearing: mission should still be ACTIVE with one target left');
  check(d.destroyedCount === specs.length - 1, 'bearing: destroyed count mismatch');

  const flight = (x, z, headingDeg) => ({
    position: { x, y: 500, z },
    heading: headingDeg,
    speed: 200,
    onGround: false,
  });

  // South of the target -> target is due north (0 deg).
  let snap = d.update(0.016, flight(keep.x, keep.z + 2000, 0));
  let sp = snap.steerpoint;
  check(sp && sp.label === keep.label, 'bearing: steerpoint is not the surviving objective');
  near(sp.bearingDeg, 0, 0.01, 'bearing: target to the north should read 000');
  near(sp.relBearingDeg, 0, 0.01, 'bearing: heading north at target north should be relative 0');
  near(sp.distanceM, 2000, 0.5, 'bearing: north distance');
  near(sp.distanceNm, 2000 / 1852, 0.001, 'bearing: nautical miles');
  near(sp.etaSec, 10, 0.1, 'bearing: ETA at 200 m/s');

  // West of the target -> target is due east (90 deg).
  snap = d.update(0.016, flight(keep.x - 2000, keep.z, 90));
  sp = snap.steerpoint;
  near(sp.bearingDeg, 90, 0.01, 'bearing: target to the east should read 090');
  near(sp.relBearingDeg, 0, 0.01, 'bearing: heading east at target east should be relative 0');

  // Same target, aircraft still pointing north -> relative +90.
  snap = d.update(0.016, flight(keep.x - 2000, keep.z, 0));
  sp = snap.steerpoint;
  near(sp.bearingDeg, 90, 0.01, 'bearing: east bearing stable');
  near(sp.relBearingDeg, 90, 0.01, 'bearing: relative bearing should be +90');

  // North of the target -> target is due south (180 deg).
  snap = d.update(0.016, flight(keep.x, keep.z - 1000, 180));
  sp = snap.steerpoint;
  near(sp.bearingDeg, 180, 0.01, 'bearing: target to the south should read 180');
  near(sp.relBearingDeg, 0, 0.01, 'bearing: heading south at target south should be relative 0');

  // East of the target -> target is due west (270 deg), relative -90 from north.
  snap = d.update(0.016, flight(keep.x + 1000, keep.z, 0));
  sp = snap.steerpoint;
  near(sp.bearingDeg, 270, 0.01, 'bearing: target to the west should read 270');
  near(sp.relBearingDeg, -90, 0.01, 'bearing: west target from north heading should be -90');

  // Cross-check against the ARCHITECTURE formula for an arbitrary point.
  const px = keep.x + 3210;
  const pz = keep.z - 4567;
  snap = d.update(0.016, flight(px, pz, 0));
  sp = snap.steerpoint;
  const wantBearing = (Math.atan2(keep.x - px, -(keep.z - pz)) * 180 / Math.PI + 360) % 360;
  near(sp.bearingDeg, wantBearing, 0.01, 'bearing: atan2(dx,-dz) convention');
  near(sp.distanceM, Math.hypot(keep.x - px, keep.z - pz), 0.5, 'bearing: Euclidean range');
}

// ---------------------------------------------------------------------------
// 4. Destroying everything: ACTIVE -> RTB, score, callouts, HOME PLATE
// ---------------------------------------------------------------------------
const strikeRun = new MissionDirector();
const strikeSpecs = strikeRun.startMission('strike', spawn, world);
let strikeSnap = strikeRun.update(0.016, {
  position: { x: spawn.x, y: spawn.y, z: spawn.z },
  heading: spawn.heading,
  speed: 120,
  onGround: false,
});
check(strikeSnap.status === 'ACTIVE', 'strike: should start ACTIVE');
check(strikeSnap.totalObjectives === 4, 'strike: four objectives expected');

for (const s of strikeSpecs) {
  strikeRun.notifyDestroyed([{ id: s.id, kind: s.kind, label: s.label, position: { x: s.x, y: 0, z: s.z } }]);
}
check(strikeRun.status === 'RTB', `strike: expected RTB, got ${strikeRun.status}`);
check(strikeRun.destroyedCount === 4, 'strike: destroyed count should be 4');
check(strikeRun.score === 250 + 250 + 250 + 350, `strike: score ${strikeRun.score}, expected 1100`);

const allClear = strikeRun.radio.find((m) => /ALL OBJECTIVES DESTROYED/.test(m.text));
check(!!allClear, 'strike: missing ALL OBJECTIVES DESTROYED callout');
check(/RTB HOME PLATE/.test(allClear ? allClear.text : ''), 'strike: RTB callout missing home plate');
check(strikeRun.radio.some((m) => /SHACK! TARGET DESTROYED/.test(m.text)), 'strike: missing SHACK callout');
check(strikeRun.radio.length <= 3, `strike: radio kept ${strikeRun.radio.length} messages, max 3`);

// Re-reporting the same kills must not double-score.
strikeRun.notifyDestroyed([{ id: strikeSpecs[0].id, kind: 'DEPOT', label: 'FUEL DEPOT', position: { x: 0, y: 0, z: 0 } }]);
check(strikeRun.score === 1100, 'strike: duplicate destruction double-counted');
check(strikeRun.destroyedCount === 4, 'strike: duplicate destruction double-counted count');

// Steerpoint must point back at the spawn airport.
strikeSnap = strikeRun.update(0.016, {
  position: { x: spawn.x + 5000, y: spawn.y, z: spawn.z + 5000 },
  heading: 0,
  speed: 180,
  onGround: false,
});
const home = spawn.airport;
check(strikeSnap.steerpoint && strikeSnap.steerpoint.label === 'HOME PLATE',
  'strike: steerpoint should be HOME PLATE after all objectives die');
if (home) {
  near(strikeSnap.steerpoint.x, home.x, 0.01, 'strike: home steerpoint x');
  near(strikeSnap.steerpoint.z, home.z, 0.01, 'strike: home steerpoint z');
}
check(strikeSnap.steerpoint && strikeSnap.steerpoint.distanceM > 0, 'strike: home range should be positive');

// ---------------------------------------------------------------------------
// 5. Landing at home: RTB -> COMPLETE
// ---------------------------------------------------------------------------
{
  const landPos = { x: home ? home.x : spawn.x, y: home ? home.elevation : spawn.y, z: home ? home.z : spawn.z };
  const snap = strikeRun.update(0.2, {
    position: landPos,
    heading: 90,
    speed: 5,
    onGround: true,
  });
  check(snap.status === 'COMPLETE', `landing: expected COMPLETE, got ${snap.status}`);
  check(strikeRun.radio.some((m) => /MISSION COMPLETE/.test(m.text)), 'landing: missing mission complete callout');
  check(snap.score === 1100, 'landing: score should be preserved');

  // Remaining parked on the ground keeps COMPLETE and does not re-fire.
  const phoneCount = strikeRun.radio.filter((m) => /MISSION COMPLETE/.test(m.text)).length;
  const again = strikeRun.update(0.2, { position: landPos, heading: 90, speed: 2, onGround: true });
  check(again.status === 'COMPLETE', 'landing: status regressed');
  check(strikeRun.radio.filter((m) => /MISSION COMPLETE/.test(m.text)).length === phoneCount,
    'landing: mission complete callout duplicated');
}

// RTB requires being close, on the ground and slow.
{
  const d = new MissionDirector();
  const specs = d.startMission('sead', spawn, world);
  for (const s of specs) {
    d.notifyDestroyed([{ id: s.id, kind: s.kind, label: s.label, position: { x: s.x, y: 0, z: s.z } }]);
  }
  check(d.status === 'RTB', 'rtb: should be RTB after all kills');
  // Airborne overhead: no completion.
  let snap = d.update(0.2, {
    position: { x: home ? home.x : spawn.x, y: 1000, z: home ? home.z : spawn.z },
    heading: 0,
    speed: 5,
    onGround: false,
  });
  check(snap.status === 'RTB', 'rtb: airborne low-speed pass must not complete');
  // Too fast on the ground: no completion.
  snap = d.update(0.2, {
    position: { x: home ? home.x : spawn.x, y: home ? home.elevation : spawn.y, z: home ? home.z : spawn.z },
    heading: 0,
    speed: 40,
    onGround: true,
  });
  check(snap.status === 'RTB', 'rtb: fast ground roll must not complete');
  // Far away and parked: no completion.
  snap = d.update(0.2, {
    position: { x: (home ? home.x : spawn.x) + 5000, y: 0, z: home ? home.z : spawn.z },
    heading: 0,
    speed: 2,
    onGround: true,
  });
  check(snap.status === 'RTB', 'rtb: distant parking must not complete');
}

// ---------------------------------------------------------------------------
// 6. Radio: expiry, cap of 3, SPIKE rate limit, damage call
// ---------------------------------------------------------------------------
{
  const d = new MissionDirector();
  d.startMission('sead', spawn, world);
  const flight = { position: { x: spawn.x, y: spawn.y + 1000, z: spawn.z }, heading: 0, speed: 150, onGround: false };
  check(d.radio.length === 1, 'radio: one opening message expected');

  let snap = d.update(3, flight);
  check(snap.radio.length === 1, 'radio: message vanished early');
  near(snap.radio[0].age, 3, 0.01, 'radio: age should advance with dt');
  check(snap.radio[0].ttl === 7.5, 'radio: ttl should be 7.5 s');

  snap = d.update(4.6, flight);
  check(snap.radio.length === 0, 'radio: message should expire after 7.5 s');
}

{
  const d = new MissionDirector();
  const specs = d.startMission('sead', spawn, world);
  for (const s of specs) d.notifyDestroyed([{ id: s.id, kind: s.kind, label: s.label, position: { x: s.x, y: 0, z: s.z } }]);
  check(d.radio.length === 3, `radio: expected newest 3 kept, got ${d.radio.length}`);
  check(d.radio[d.radio.length - 1].text.includes('ALL OBJECTIVES DESTROYED'),
    'radio: newest message should be the RTB call');
}

{
  const d = new MissionDirector();
  d.startMission('sead', spawn, world);
  const flight = { position: { x: spawn.x, y: 500, z: spawn.z }, heading: 0, speed: 200, onGround: false };

  check(d.notifyMissileLaunch({ bearingRad: (240 * Math.PI) / 180 }) === true, 'spike: first launch should warn');
  const urgent = d.radio[d.radio.length - 1];
  check(urgent.priority === 'urgent', 'spike: warning should be urgent');
  check(/SPIKE! SAM LAUNCH BEARING 240/.test(urgent.text), `spike: bad text "${urgent.text}"`);
  check(/DEFEND & FLARE/.test(urgent.text), 'spike: missing defend & flare');

  check(d.notifyMissileLaunch({ bearingRad: 0 }) === false, 'spike: second launch inside 6 s should be suppressed');
  d.update(5.9, flight);
  check(d.notifyMissileLaunch({ bearingRad: 0 }) === false, 'spike: still inside cooldown at 5.9 s');
  d.update(0.2, flight);
  check(d.notifyMissileLaunch({ bearingRad: (90 * Math.PI) / 180 }) === true, 'spike: cooldown should clear after 6 s');
  check(/BEARING 090/.test(d.radio[d.radio.length - 1].text), 'spike: bearing should be padded to three digits');

  d.notifyPlayerHit();
  check(d.radio.some((m) => /TAKING FIRE/.test(m.text)), 'damage: missing TAKING FIRE callout');
}

// RWR launch contacts fed to update() must raise a rate-limited SPIKE.
{
  const d = new MissionDirector();
  d.startMission('sead', spawn, world);
  const flight = { position: { x: spawn.x, y: 500, z: spawn.z }, heading: 0, speed: 200, onGround: false };
  let snap = d.update(0.016, flight, [], [
    { id: 'sam-1', kind: 'SAM', bearingRad: (30 * Math.PI) / 180, state: 'LAUNCH', isMissile: true },
    { id: 'sam-2', kind: 'SAM', bearingRad: (30 * Math.PI) / 180, state: 'LAUNCH', isMissile: true },
  ]);
  const spikes = snap.radio.filter((m) => /SPIKE! SAM LAUNCH/.test(m.text));
  check(spikes.length === 1, `rwr: expected one rate-limited SPIKE, got ${spikes.length}`);
  check(/BEARING 030/.test(spikes[0].text), 'rwr: SPIKE bearing mismatch');
  check(spikes[0].priority === 'urgent', 'rwr: SPIKE should be urgent');
}

// Moving bandits: the steerpoint must follow the live target position.
{
  const d = new MissionDirector();
  const specs = d.startMission('cap', spawn, world);
  const keep = specs[0];
  for (const s of specs.slice(1)) {
    d.notifyDestroyed([{ id: s.id, kind: s.kind, label: s.label, position: { x: s.x, y: s.alt, z: s.z } }]);
  }
  const flight = { position: { x: spawn.x, y: spawn.y + 2000, z: spawn.z }, heading: 0, speed: 230, onGround: false };
  const moved = { id: keep.id, kind: 'BANDIT', label: keep.label, alive: true, position: { x: spawn.x + 4000, y: 2500, z: spawn.z - 5000 } };
  const snap = d.update(0.016, flight, [moved], []);
  near(snap.steerpoint.x, moved.position.x, 0.01, 'bandit: steerpoint x should track target');
  near(snap.steerpoint.z, moved.position.z, 0.01, 'bandit: steerpoint z should track target');
  near(snap.steerpoint.y, moved.position.y, 0.01, 'bandit: steerpoint y should track target');
}

// ---------------------------------------------------------------------------
// 7. Cap: destroying bandits awards 500 each and ends ACTIVE -> RTB
// ---------------------------------------------------------------------------
{
  const d = new MissionDirector();
  const specs = d.startMission('cap', spawn, world);
  check(specs.every((s) => s.kind === 'BANDIT'), 'cap: expected only bandits');
  for (const s of specs) {
    d.notifyDestroyed([{ id: s.id, kind: s.kind, label: s.label, position: { x: s.x, y: s.alt, z: s.z } }]);
  }
  check(d.score === 1500, `cap: score ${d.score}, expected 1500`);
  check(d.status === 'RTB', 'cap: expected RTB after all bandits die');
  check(d.radio.some((m) => /SPLASH ONE BANDIT/.test(m.text)), 'cap: missing SPLASH ONE BANDIT callout');
}

// ---------------------------------------------------------------------------
// 8. Snapshot contract: finite numbers and required fields
// ---------------------------------------------------------------------------
{
  const d = new MissionDirector();
  d.startMission('strike', spawn, world);
  const snap = d.update(0.016, {
    position: { x: spawn.x, y: spawn.y + 500, z: spawn.z },
    heading: 137,
    speed: 0,
    onGround: false,
  });
  const keys = ['id', 'label', 'status', 'score', 'destroyedCount', 'totalObjectives', 'steerpoint', 'radio'];
  for (const k of keys) check(k in snap, `snapshot: missing ${k}`);
  const sp = snap.steerpoint;
  for (const k of ['label', 'x', 'y', 'z', 'bearingDeg', 'relBearingDeg', 'distanceM', 'distanceNm', 'etaSec']) {
    check(k in sp, `snapshot: steerpoint missing ${k}`);
  }
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'number') check(Number.isFinite(v), `snapshot: steerpoint.${k} is not finite`);
  }
  check(sp.bearingDeg >= 0 && sp.bearingDeg < 360, 'snapshot: bearing out of [0,360)');
  check(sp.relBearingDeg >= -180 && sp.relBearingDeg <= 180, 'snapshot: relative bearing out of range');
  check(sp.distanceNm === sp.distanceM / 1852, 'snapshot: NM conversion');
  check(sp.etaSec > 0 && sp.etaSec <= 9999, 'snapshot: ETA should be finite and clamped when parked');
  check(Array.isArray(snap.radio), 'snapshot: radio must be an array');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Missions & AWACS — acceptance test');
console.log('==================================');
for (const id of ['free', 'sead', 'strike', 'cap']) {
  const { specs } = starts[id];
  const kinds = specs.map((s) => s.kind).join(',') || '(none)';
  console.log(`  ${id.padEnd(6)} ${String(specs.length).padStart(2)} targets  ${kinds}`);
}
console.log(`checks: ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  process.exitCode = 1;
} else {
  console.log('\nALL CHECKS PASSED');
}