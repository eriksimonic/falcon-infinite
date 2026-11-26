// Headless acceptance tests for src/sim/fuel.js.
// Run: node tests/fuel_test.mjs
//
// Covers the FuelSystem burn model (idle / dry / afterburner + altitude
// derate), bingo/empty edges, gravity refuelling on a stopped runway, the
// TankerSystem null-scene orbit contract, the KC-135 mesh, boom contact
// detection, and fuel transfer through FuelSystem.update(..., true).
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FuelSystem, TankerSystem } from '../src/sim/fuel.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const SRC = fileURLToPath(new URL('../src/sim/fuel.js', import.meta.url));
const source = readFileSync(SRC, 'utf8');

const DEG = Math.PI / 180;

function makeFlight(over = {}) {
  return {
    position: new THREE.Vector3(0, 3000, 0),
    velocity: new THREE.Vector3(0, 0, -250),
    speed: 250,
    throttle: 0,
    onGround: false,
    ...over,
  };
}

/** Step fuel for `seconds` and report the observed transitions. */
function burn(fs, flight, seconds, dt = 0.1, contact = false) {
  const steps = Math.max(1, Math.round(seconds / dt));
  let triggers = 0;
  let triggerFuel = null;
  let sawBingo = false;
  let sawEmpty = false;
  let last = null;
  for (let i = 0; i < steps; i++) {
    last = fs.update(dt, flight, contact);
    if (last.bingoTriggered) {
      triggers++;
      triggerFuel = last.fuelLb;
    }
    if (last.bingo) sawBingo = true;
    if (last.empty) sawEmpty = true;
  }
  return { triggers, triggerFuel, sawBingo, sawEmpty, last };
}

// ------------------------------------------------------- 0. source hygiene
{
  ok(!/Math\.random\s*\(/.test(source), 'fuel.js uses no Math.random');
  ok(!/\bdocument\./.test(source) && !/\bwindow\./.test(source),
    'fuel.js has no DOM dependencies (headless-safe)');
  ok(/export class FuelSystem/.test(source) && /export class TankerSystem/.test(source),
    'fuel.js exports FuelSystem and TankerSystem');
}

// ------------------------------------- 1. fuel tank + idle/nullsafety checks
{
  ok(FuelSystem.MAX_FUEL_LB === 7000, 'static MAX_FUEL_LB is 7000');
  ok(FuelSystem.BINGO_LB === 1500, 'static BINGO_LB is 1500');

  const fs = new FuelSystem();
  ok(fs.fuelLb === 7000, 'constructor starts at 7000 lb', String(fs.fuelLb));
  ok(fs.fraction === 1 && fs.bingo === false && fs.empty === false && fs.refueling === false,
    'constructor starts full and unlatched');

  // Contract state defaults survive reset().
  fs.reset();
  ok(fs.fuelLb === 7000 && fs.fraction === 1, 'reset() defaults to full internal fuel');
  fs.reset(0);
  ok(fs.empty === true && fs.bingo === true && fs.fraction === 0, 'reset(0) reports empty + bingo');
  fs.reset(9000);
  ok(fs.fuelLb === 7000, 'reset() clamps above MAX_FUEL_LB');

  // Null / partial flight objects must never throw.
  let threw = null;
  try {
    const f = new FuelSystem();
    f.update(1 / 60, null);
    f.update(0, undefined);
    f.update(NaN, {});
    f.reset();
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'update tolerates null/partial flight objects', threw && threw.message);

  // Idle flow ~0.6 lb/s at sea level, lightly derated aloft.
  const idle = new FuelSystem();
  const r = idle.update(1, makeFlight({ throttle: 0, speed: 0, onGround: false, position: new THREE.Vector3(0, 0, 0) }));
  ok(Math.abs(r.burnRateLbSec - 0.6) < 0.02, 'idle flow is ~0.6 lb/s at sea level',
    r.burnRateLbSec.toFixed(3));
  ok(Math.abs(r.fuelLb - (7000 - 0.6)) < 0.02, 'idle burns ~0.6 lb in one second');
  ok(r.maxFuelLb === 7000 && r.fraction > 0.99, 'update returns maxFuelLb and fraction');
  ok(typeof r.bingoTriggered === 'boolean' && typeof r.refueling === 'boolean',
    'update returns boolean edge flags');
}

// ------------------------------- 2. afterburner > 3x dry, bingo, then empty
{
  const sea = new THREE.Vector3(0, 0, 0);

  const dry = new FuelSystem();
  const dryF = makeFlight({ throttle: 0.89, speed: 300, position: sea });
  const dryR = dry.update(1, dryF);
  ok(Math.abs(dryR.burnRateLbSec - 6.8) < 0.1, 'dry military flow is ~6.8 lb/s',
    dryR.burnRateLbSec.toFixed(2));

  const ab = new FuelSystem();
  const abF = makeFlight({ throttle: 1.0, speed: 300, position: sea });
  const abR = ab.update(1, abF);
  ok(Math.abs(abR.burnRateLbSec - 28.0) < 0.4, 'full afterburner flow is ~28.0 lb/s',
    abR.burnRateLbSec.toFixed(2));
  ok(abR.burnRateLbSec > dryR.burnRateLbSec * 3,
    'afterburner burns > 3x dry military power',
    (abR.burnRateLbSec / dryR.burnRateLbSec).toFixed(2) + 'x');

  // Altitude density derate: same throttle should burn slightly less at 10 km.
  const high = new FuelSystem();
  const highR = high.update(1, makeFlight({ throttle: 0.89, speed: 300, position: new THREE.Vector3(0, 10000, 0) }));
  ok(highR.burnRateLbSec < dryR.burnRateLbSec, 'density derate reduces flow with altitude',
    highR.burnRateLbSec.toFixed(2) + ' < ' + dryR.burnRateLbSec.toFixed(2));
  ok(highR.burnRateLbSec > dryR.burnRateLbSec * 0.7, 'altitude derate stays slight',
    highR.burnRateLbSec.toFixed(2));

  // Full load: ~3.5 min of continuous AB, ~12 min dry.
  const abLife = new FuelSystem();
  const abLifeR = abLife.update(1, makeFlight({ throttle: 1, position: sea }));
  const abSeconds = 7000 / abLifeR.burnRateLbSec;
  const dryLife = new FuelSystem();
  const dryLifeR = dryLife.update(1, makeFlight({ throttle: 0.89, position: sea }));
  const drySeconds = 7000 / dryLifeR.burnRateLbSec;
  ok(abSeconds > 180 && abSeconds < 300, 'full AB endurance is ~3.5 min',
    (abSeconds / 60).toFixed(1) + ' min');
  ok(drySeconds > 600 && drySeconds < 1200, 'dry endurance is ~10-20 min (17 min at full dry)',
    (drySeconds / 60).toFixed(1) + ' min');

  // Bingo fires once when crossing 1500 lb, empty at 0.
  const bingo = new FuelSystem();
  bingo.reset(1700);
  const tall = burn(bingo, makeFlight({ throttle: 1, position: sea }), 300, 0.1);
  ok(tall.triggers === 1, 'bingoTriggered fires exactly once crossing 1500 lb',
    String(tall.triggers));
  ok(tall.triggerFuel !== null && tall.triggerFuel <= 1500 && tall.triggerFuel > 1490,
    'bingo fires on the frame that crosses 1500 lb',
    tall.triggerFuel === null ? 'never' : tall.triggerFuel.toFixed(1) + ' lb');
  ok(tall.sawBingo, 'bingo state latches below 1500 lb');
  ok(tall.sawEmpty, 'empty state latches at 0 lb');
  ok(tall.last.fuelLb === 0 && tall.last.empty === true && tall.last.fraction === 0,
    'fuel bottom is exactly 0 lb, fraction 0',
    tall.last.fuelLb + ' lb');
  ok(tall.last.bingo === true && tall.last.burnRateLbSec === 0, 'empty tank burns nothing');

  // Staying above bingo must not trigger it.
  const full = new FuelSystem();
  full.reset(6000);
  const short = burn(full, makeFlight({ throttle: 1, position: sea }), 10, 0.1);
  ok(short.triggers === 0, 'no bingo trigger while above 1500 lb', String(short.triggers));
  ok(short.last.fuelLb > 5500, '10 s of AB from 6000 lb stays well above bingo',
    short.last.fuelLb.toFixed(0) + ' lb');

  // Re-arms after refuelling back above bingo.
  const rearm = new FuelSystem();
  rearm.reset(1400);
  const parked = makeFlight({ throttle: 0, speed: 0, onGround: true, position: new THREE.Vector3(0, 2, 0) });
  burn(rearm, parked, 5, 0.1);
  ok(rearm.fuelLb > 1500 && rearm.bingo === false, 'ground refuel lifts the jet out of bingo');
  const again = burn(rearm, makeFlight({ throttle: 1, position: sea }), 120, 0.1);
  ok(again.triggers === 1, 'bingo re-arms and fires again on the next crossing',
    String(again.triggers));
}

// ------------------------------------------- 3. ground refuelling on runway
{
  const fs = new FuelSystem();
  fs.reset(900);
  const parked = makeFlight({
    throttle: 0,
    speed: 0,
    onGround: true,
    velocity: new THREE.Vector3(),
    position: new THREE.Vector3(0, 2, 0),
  });

  // 20 s at +420 lb/s covers the ~6100 lb gap.
  const r = burn(fs, parked, 20, 0.1);
  ok(fs.fuelLb === 7000, 'stopped runway refuel restores fuel to exactly 7000 lb',
    fs.fuelLb + ' lb');
  ok(fs.fraction === 1, 'ground refuel restores fraction to 1');
  ok(fs.empty === false && fs.bingo === false, 'ground refuel clears empty/bingo');
  ok(r.last.refueling === false, 'ground refuel is not reported as aerial refuelling');

  // Holding on the chocks must not overflow.
  burn(fs, parked, 5, 0.1);
  ok(fs.fuelLb === 7000, 'parked refuel never exceeds MAX_FUEL_LB', fs.fuelLb + ' lb');

  // Rolling or powered up on the ground does not refuel.
  const rolling = new FuelSystem();
  rolling.reset(4000);
  burn(rolling, makeFlight({ throttle: 0, speed: 12, onGround: true, position: new THREE.Vector3(0, 2, 0) }), 5, 0.1);
  ok(rolling.fuelLb < 4000, 'rolling on the ground does not refuel', rolling.fuelLb.toFixed(0));

  const powered = new FuelSystem();
  powered.reset(4000);
  burn(powered, makeFlight({ throttle: 0.2, speed: 0, onGround: true, position: new THREE.Vector3(0, 2, 0) }), 5, 0.1);
  ok(powered.fuelLb < 4000, 'throttle up on the ground does not refuel', powered.fuelLb.toFixed(0));

  // Airborne idle still burns.
  const airborne = new FuelSystem();
  airborne.reset(5000);
  burn(airborne, makeFlight({ throttle: 0, speed: 200, onGround: false, position: new THREE.Vector3(0, 3000, 0) }), 6, 0.1);
  ok(airborne.fuelLb < 5000, 'airborne idle burns fuel', airborne.fuelLb.toFixed(1) + ' lb');
}

// ------------------------------------------------- 4. tanker null-scene orbit
{
  let threw = null;
  let tanker = null;
  try {
    tanker = new TankerSystem(null);
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'TankerSystem(null) constructs without a scene', threw && threw.message);
  ok(tanker && tanker.group === null && tanker.mesh === null,
    'null scene creates no mesh');

  const spawn = { x: 0, y: 2, z: 0, heading: 90 };
  tanker.reset(spawn);
  ok(Math.abs(tanker.position.y - 3000) < 1e-6, 'tanker orbits at 3000 m',
    tanker.position.y.toFixed(1) + ' m');
  ok(Math.abs(tanker.velocity.length() - 165) < 0.01, 'tanker flies at 165 m/s',
    tanker.velocity.length().toFixed(2) + ' m/s');
  const anchorDist = Math.hypot(tanker.position.x - tanker.anchor.x, tanker.position.z - tanker.anchor.z);
  ok(Math.abs(anchorDist - 7500) < 1, 'orbit radius is ~7500 m', anchorDist.toFixed(0) + ' m');
  ok(tanker.anchor.y === 3000, 'patrol anchor sits at 3000 m');
  const spawnDist = Math.hypot(tanker.position.x - spawn.x, tanker.position.z - spawn.z);
  ok(spawnDist > 2000 && spawnDist < 3000, 'reset parks the tanker ~2.5 km from spawn',
    spawnDist.toFixed(0) + ' m');

  // Ten seconds of orbit: steady altitude/speed, small per-frame steps.
  let prev = tanker.position.clone();
  let maxStep = 0;
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  let minSpeed = Infinity;
  let maxSpeed = -Infinity;
  let minRadius = Infinity;
  let maxRadius = -Infinity;
  for (let i = 0; i < 600; i++) {
    const r = tanker.update(1 / 60, null);
    maxStep = Math.max(maxStep, tanker.position.distanceTo(prev));
    prev.copy(tanker.position);
    minAlt = Math.min(minAlt, tanker.position.y);
    maxAlt = Math.max(maxAlt, tanker.position.y);
    minSpeed = Math.min(minSpeed, tanker.velocity.length());
    maxSpeed = Math.max(maxSpeed, tanker.velocity.length());
    const rad = Math.hypot(tanker.position.x - tanker.anchor.x, tanker.position.z - tanker.anchor.z);
    minRadius = Math.min(minRadius, rad);
    maxRadius = Math.max(maxRadius, rad);
    ok(Number.isFinite(r.heading) && r.heading >= 0 && r.heading < 360,
      'tanker heading stays a valid compass angle');
  }
  ok(maxStep < (165 / 60) * 1.05, 'orbit advances smoothly (no position jumps)',
    maxStep.toFixed(3) + ' m/frame');
  ok(minAlt > 2999.99 && maxAlt < 3000.01, 'altitude stays pegged at 3000 m',
    minAlt.toFixed(2) + '..' + maxAlt.toFixed(2));
  ok(minSpeed > 164.9 && maxSpeed < 165.1, 'ground speed holds 165 m/s',
    minSpeed.toFixed(2) + '..' + maxSpeed.toFixed(2));
  ok(minRadius > 7499 && maxRadius < 7501, 'radius of turn holds 7500 m',
    minRadius.toFixed(1) + '..' + maxRadius.toFixed(1));

  // Deterministic: same spawn, same elapsed time, same state.
  const a = new TankerSystem(null);
  const b = new TankerSystem(null);
  a.reset(spawn);
  b.reset(spawn);
  for (let i = 0; i < 90; i++) {
    a.update(1 / 60, null);
    b.update(1 / 60, null);
  }
  ok(a.position.distanceTo(b.position) < 1e-9 && a.heading === b.heading,
    'tanker orbit is deterministic across instances');

  // Update with no flight is safe.
  const safe = tanker.update(1 / 60, null);
  ok(safe.active === true && safe.contact === false && Number.isFinite(safe.distanceM),
    'update with a null flight returns a safe inactive contact');
}

// -------------------------------------------- 5. boom contact box detection
{
  const tanker = new TankerSystem(null);
  tanker.reset({ x: 0, y: 2, z: 0, heading: 0 });

  // Player glued at an offset from the tanker, matching its velocity.
  function playerAt(aft, below, lateral, speedDelta) {
    const h = tanker.heading * DEG;
    const fwd = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const position = tanker.position.clone()
      .addScaledVector(fwd, -aft)
      .addScaledVector(right, lateral);
    position.y -= below;
    const velocity = tanker.velocity.clone().addScaledVector(fwd, speedDelta);
    return {
      position,
      velocity,
      speed: velocity.length(),
      throttle: 0.8,
      onGround: false,
    };
  }

  // Directly behind and below the boom, perfectly matched.
  const glued = playerAt(20, 6, 0, 0);
  const hit = tanker.update(0, glued);
  ok(hit.active === true, 'tanker update reports active');
  ok(hit.contact === true, 'contact detected behind/below the boom at matched speed');
  ok(hit.preContact === true, 'contact implies preContact');
  ok(hit.distanceM > 20 && hit.distanceM < 22, 'distanceM reports ~20.9 m slant range',
    hit.distanceM.toFixed(2) + ' m');
  ok(Math.abs(hit.heading - tanker.heading) < 1e-9 && hit.speed === 165,
    'update returns the tanker heading and speed');
  let dBearing = Math.abs(hit.bearingDeg - tanker.heading);
  if (dBearing > 180) dBearing = 360 - dBearing;
  ok(dBearing < 1, 'bearingDeg points from player to tanker (~tanker heading)',
    hit.bearingDeg.toFixed(1) + '°');
  ok(hit.position === tanker.position, 'update returns the live tanker position');

  // Envelope edges.
  const cases = [
    [12, 2, 0, 0, true, 'minimum aft / minimum drop corner'],
    [34, 12, 9.9, 0, true, 'maximum aft / maximum drop corner'],
    [21, 7, -9.9, 21.9, true, 'max lateral and just under 22 m/s closure'],
    [11, 6, 0, 0, false, 'too close to the tanker body'],
    [35, 6, 0, 0, false, 'too far aft of the boom'],
    [20, 1, 0, 0, false, 'too high above the boom'],
    [20, 13, 0, 0, false, 'too far below the boom'],
    [20, 6, 11, 0, false, 'too far off to the side'],
    [20, 6, 0, 30, false, 'closure rate above 22 m/s'],
    [20, 6, 0, -30, false, 'opening rate above 22 m/s'],
  ];
  for (const [aft, below, lateral, delta, expected, label] of cases) {
    const r = tanker.update(0, playerAt(aft, below, lateral, delta));
    ok(r.contact === expected, 'contact ' + label + ' -> ' + expected,
      'got ' + r.contact);
  }

  // preContact guides the join-up from further out, but not across the map.
  const approach = tanker.update(0, playerAt(42, 8, 0, 0));
  ok(approach.contact === false && approach.preContact === true,
    'preContact true on a 42 m approach');
  const far = makeFlight({
    position: tanker.position.clone().add(new THREE.Vector3(0, 500, 1000)),
    velocity: tanker.velocity.clone(),
    speed: 165,
  });
  const farR = tanker.update(0, far);
  ok(farR.contact === false && farR.preContact === false,
    'no contact or preContact a kilometre away');
  ok(farR.distanceM > 1000 && Number.isFinite(farR.bearingDeg),
    'distance/bearing stay finite at range', farR.distanceM.toFixed(0) + ' m');

  // Scalar-speed fallback when no velocity vector is supplied.
  const scalar = tanker.update(0, {
    position: playerAt(20, 6, 0, 0).position,
    speed: 165,
  });
  ok(scalar.contact === true, 'contact works with only a scalar airspeed');
}

// -------------------------------------- 6. fuel transfer through the boom
{
  const tanker = new TankerSystem(null);
  tanker.reset({ x: 0, y: 2, z: 0, heading: 0 });

  function glued(dt = 0) {
    const h = tanker.heading * DEG;
    const fwd = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
    const position = tanker.position.clone().addScaledVector(fwd, -20);
    position.y -= 6;
    return {
      position,
      velocity: tanker.velocity.clone(),
      speed: 165,
      throttle: 0.82,
      onGround: false,
    };
  }

  const fs = new FuelSystem();
  fs.reset(3000);

  // One frame of contact: +360 lb/s against ~0.6 lb/s idle burn.
  const first = fs.update(0.1, glued(), true);
  ok(first.refueling === true, 'FuelSystem reports refueling while on the boom');
  ok(first.fuelLb > 3000, 'aerial transfer adds fuel', first.fuelLb.toFixed(1) + ' lb');
  const gain = first.fuelLb - 3000;
  ok(gain > 35 && gain < 36.5, 'transfer adds ~36 lb in 0.1 s (360 lb/s)',
    gain.toFixed(2) + ' lb');

  // Ten seconds holding the boom through the live contact calculation.
  // Advance the tanker first, then measure contact at dt = 0 so the player
  // can be glued to the post-update orbit point (no one-frame lag).
  let frames = 0;
  let contacts = 0;
  for (let i = 0; i < 100; i++) {
    tanker.update(0.1, null);
    const f = glued();
    const tr = tanker.update(0, f);
    const fr = fs.update(0.1, f, tr.contact);
    frames++;
    if (tr.contact) contacts++;
    if (!fr.refueling) {
      ok(false, 'refuelling flag dropped while on the boom', 'frame ' + i);
      break;
    }
  }
  ok(contacts === frames, 'contact held for every frame of the join-up', contacts + '/' + frames);
  ok(fs.fuelLb > 6000, '10 s of boom transfer moves 3000 lb to >6000 lb',
    fs.fuelLb.toFixed(0) + ' lb');
  ok(fs.fuelLb <= 7000, 'aerial transfer respects MAX_FUEL_LB', fs.fuelLb.toFixed(0) + ' lb');
  ok(fs.fraction > 0.85 && fs.empty === false && fs.bingo === false,
    'refuelled jet is out of bingo and not empty');

  // Off the boom the flag clears.
  const off = fs.update(0.1, glued(), false);
  ok(off.refueling === false, 'refueling clears when contact is lost');

  // The tanker keeps moving while the player holds position — no giant jumps.
  const beforeHeading = tanker.heading;
  tanker.update(1 / 30, null);
  ok(tanker.heading !== beforeHeading, 'tanker continues its orbit between contacts');
}

// --------------------------------------------- 7. scene-backed KC-135 mesh
{
  const scene = new THREE.Scene();
  const tanker = new TankerSystem(scene);
  ok(tanker.mesh !== null && tanker.group === tanker.mesh,
    'scene-backed tanker builds a mesh');
  ok(tanker.mesh.parent === scene, 'tanker mesh is added to the scene');
  ok(tanker.mesh.children.length >= 15, 'KC-135 has a detailed part count',
    String(tanker.mesh.children.length));

  const engines = tanker.mesh.userData.engines || [];
  ok(engines.length === 4, 'four underwing turbofan pods', String(engines.length));
  ok(tanker.mesh.userData.boom != null, 'refuelling boom is modelled');
  const lights = tanker.mesh.userData.directorLights || [];
  ok(lights.length >= 2, 'belly director lights are modelled', String(lights.length));
  ok(lights.every((l) => l.material.emissiveIntensity > 0),
    'director lights are emissive');
  ok(tanker.mesh.userData.boomTip && tanker.mesh.userData.boomTip.z > 25,
    'boom extends aft of the tail');

  // Mesh follows the orbit and points along the velocity vector.
  tanker.reset({ x: 0, y: 2, z: 0, heading: 0 });
  for (let i = 0; i < 30; i++) tanker.update(1 / 60, null);
  ok(tanker.mesh.position.distanceTo(tanker.position) < 1e-9,
    'mesh position tracks the orbit');
  const meshForward = new THREE.Vector3(0, 0, -1).applyQuaternion(tanker.mesh.quaternion);
  const flightDir = tanker.velocity.clone().normalize();
  ok(meshForward.dot(flightDir) > 0.98, 'mesh nose points along the velocity vector',
    meshForward.dot(flightDir).toFixed(3));
  ok(tanker.mesh.rotation.z < 0, 'tanker is banked into the right-hand orbit',
    tanker.mesh.rotation.z.toFixed(2));

  tanker.dispose();
  ok(tanker.mesh === null && scene.children.length === 0,
    'dispose detaches the tanker mesh');
}

console.log(`fuel checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL FUEL CHECKS PASSED');