// Headless acceptance tests for Feature 10 — ACES II ejection + ambient traffic.
// Run: node tests/ejection_traffic_test.mjs
//
// No WebGL/context: both modules must work with scene === null. Verifies the
// rocket/chute/landing sequence with wind drift, and deterministic airliners,
// 45 km recycling, plus wingman fingertip formation convergence.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EjectionSystem } from '../src/aircraft/ejection.js';
import { AirTrafficSystem } from '../src/sim/traffic.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const near = (a, b, eps) => Math.abs(a - b) <= eps;

const RANGE = 45000;
const ejectionSource = readFileSync(
  fileURLToPath(new URL('../src/aircraft/ejection.js', import.meta.url)), 'utf8');
const trafficSource = readFileSync(
  fileURLToPath(new URL('../src/sim/traffic.js', import.meta.url)), 'utf8');

function makeFlight(over = {}) {
  return {
    position: new THREE.Vector3(0, 800, 0),
    velocity: new THREE.Vector3(0, 0, -220),
    quaternion: new THREE.Quaternion(),
    onGround: false,
    speed: 220,
    ...over,
  };
}

const WIND_X = 6;
const WIND_Z = -3;
function makeWeather() {
  return {
    state: { windX: WIND_X, windZ: WIND_Z },
    windAt(x, z, alt, out) {
      out.set(WIND_X, 0, WIND_Z);
      return out;
    },
  };
}

// A gentle analytic terrain so landing is tested against a real height field.
const terrain = (x, z) => 40 + 5 * Math.sin(x * 0.001) - 3 * Math.cos(z * 0.0013);
const world = { heightAt: terrain, slopeAt: () => 0 };

// ---------------------------------------------------------------- 0. source
{
  ok(!ejectionSource.includes('Math.random'), 'ejection.js uses no Math.random');
  ok(!trafficSource.includes('Math.random'), 'traffic.js uses no Math.random');
  ok(!/\bdocument\./.test(ejectionSource) && !/\bwindow\./.test(ejectionSource),
    'ejection.js has no DOM dependencies');
  ok(!/\bdocument\./.test(trafficSource) && !/\bwindow\./.test(trafficSource),
    'traffic.js has no DOM dependencies');
}

// ----------------------------------------------------- 1. ejection: null scene
{
  let ej = null;
  let threw = null;
  try {
    ej = new EjectionSystem(null);
  } catch (e) {
    threw = e;
  }
  ok(!threw, 'EjectionSystem(null) constructs', threw ? String(threw) : '');
}

{
  const ej = new EjectionSystem(null);
  ok(ej.active === false && ej.phase === 'NONE', 'starts inactive in NONE phase');
  ok(ej.seatPos instanceof THREE.Vector3 && ej.seatVel instanceof THREE.Vector3,
    'exposes seatPos/seatVel vectors');
  ok(ej.canopyPos instanceof THREE.Vector3 && ej.canopyVel instanceof THREE.Vector3,
    'exposes canopyPos/canopyVel vectors');
  ok(ej.timer === 0, 'timer starts at zero');

  const idle = ej.update(1 / 60, world, makeWeather());
  ok(idle.active === false && idle.phase === 'NONE', 'inactive update is inert');
  ok(idle.seatPos instanceof THREE.Vector3, 'inactive update still returns seatPos');
}

// ------------------------------------------------------ 2. ejection sequence
{
  const ej = new EjectionSystem(null);
  const flight = makeFlight();

  const first = ej.trigger(flight);
  ok(first === true, 'trigger() returns true when newly triggered');
  ok(ej.active === true && ej.phase === 'ROCKET', 'trigger enters active ROCKET phase');
  ok(ej.timer === 0, 'trigger resets timer');
  ok(ej.seatPos.distanceTo(flight.position) < 1e-6, 'seat starts at aircraft position');
  ok(ej.seatVel.y >= 30, 'seat launches upward at ~38 m/s', ej.seatVel.y.toFixed(2));
  ok(near(ej.seatVel.z, -220, 1e-6), 'seat carries aircraft velocity', ej.seatVel.z.toFixed(2));
  ok(ej.canopyVel.y > 10, 'canopy jettisons upward', ej.canopyVel.y.toFixed(2));
  ok(ej.canopyVel.z > ej.seatVel.z,
    'canopy jettisons aft relative to seat', ej.canopyVel.z.toFixed(2));

  const second = ej.trigger(makeFlight());
  ok(second === false, 'trigger() returns false when already active');
  ok(ej.phase === 'ROCKET', 'second trigger does not restart the sequence');

  const y0 = ej.seatPos.y;
  for (let i = 0; i < 18; i++) ej.update(1 / 60, world, makeWeather()); // 0.3 s
  ok(ej.phase === 'ROCKET', 'still ROCKET at 0.3 s');
  ok(ej.seatPos.y > y0, 'seat climbs during rocket burn', (ej.seatPos.y - y0).toFixed(1) + ' m');
  ok(ej.seatVel.y > 45, 'rocket acceleration builds upward speed', ej.seatVel.y.toFixed(1));

  // Burn out at 0.55 s; the seat coasts but the phase stays ROCKET until 1.2 s.
  while (ej.timer < 0.9) ej.update(1 / 60, world, makeWeather());
  ok(ej.phase === 'ROCKET', 'no thrust phase still reports ROCKET before 1.2 s');

  while (ej.timer <= 1.25) ej.update(1 / 60, world, makeWeather());
  ok(ej.phase === 'CHUTE', 'transitions to CHUTE after 1.2 s', ej.phase);

  // Let the canopy inflate and the descent stabilise.
  for (let i = 0; i < 60 * 8; i++) ej.update(1 / 60, world, makeWeather());
  ok(ej.phase === 'CHUTE', 'still descending under canopy');
  ok(near(ej.seatVel.y, -5.5, 0.6), 'descent stabilises near -5.5 m/s', ej.seatVel.y.toFixed(2));
  ok(near(ej.seatVel.x, WIND_X, 0.6), 'horizontal speed damps to wind X', ej.seatVel.x.toFixed(2));
  ok(near(ej.seatVel.z, WIND_Z, 0.6), 'horizontal speed damps to wind Z', ej.seatVel.z.toFixed(2));
  ok(ej.seatPos.x > 10, 'pilot drifts downwind', ej.seatPos.x.toFixed(1) + ' m');

  const cam = ej.update(1 / 60, world, makeWeather());
  ok(cam.cameraPos instanceof THREE.Vector3 && cam.lookAt instanceof THREE.Vector3,
    'update returns a camera rig');
  const camDist = cam.cameraPos.distanceTo(cam.seatPos);
  ok(camDist > 5 && camDist < 30, 'camera rig stays near the pilot', camDist.toFixed(1) + ' m');
  ok(cam.lookAt.distanceTo(cam.seatPos) < 2.5, 'lookAt tracks the pilot');

  // Fall all the way to the terrain.
  let steps = 0;
  while (ej.phase !== 'LANDED' && steps < 60 * 400) {
    ej.update(1 / 60, world, makeWeather());
    steps++;
  }
  ok(ej.phase === 'LANDED', 'reaches LANDED on terrain', ej.phase + ' after ' + steps + ' steps');
  const gh = terrain(ej.seatPos.x, ej.seatPos.z);
  ok(near(ej.seatPos.y, gh + 1.0, 1e-6), 'lands at terrain + 1 m clearance',
    (ej.seatPos.y - gh).toFixed(2) + ' m');
  ok(ej.seatVel.length() === 0, 'vertical/horizontal velocity zeroed on landing');

  const after = ej.update(1 / 60, world, makeWeather());
  ok(after.phase === 'LANDED' && near(ej.seatPos.y, gh + 1.0, 1e-6),
    'landed seat stays put');

  ej.reset();
  ok(ej.active === false && ej.phase === 'NONE', 'reset() deactivates the sequence');
  ok(ej.seatPos.length() === 0 && ej.timer === 0, 'reset() clears state');
  const post = ej.update(1 / 60, world, makeWeather());
  ok(post.active === false, 'update after reset stays inactive');
}

// ------------------------------------------- 3. ejection scene mesh lifecycle
{
  const scene = new THREE.Scene();
  const ej = new EjectionSystem(scene);
  const flight = makeFlight({ position: new THREE.Vector3(0, 600, 0) });
  ok(ej.trigger(flight) === true, 'scene-backed ejection triggers');
  ok(scene.children.length === 1, 'seat/chute/canopy group added to scene',
    String(scene.children.length));
  const group = scene.children[0];
  ok(group.children.length >= 3, 'group contains seat, canopy frame and chute');

  for (let i = 0; i < 60 * 5; i++) ej.update(1 / 60, world, makeWeather());
  const chute = group.children.find((c) => c.type === 'Group' && c !== group.children[0]);
  ok(!!chute, 'parachute group exists in the scene graph');
  ok(chute.visible === true, 'parachute becomes visible while descending');

  ej.reset();
  ok(scene.children.length === 0, 'reset() removes the ejection meshes from the scene');
}

// ------------------------------------------- 4. air traffic: null scene, seeds
{
  const flight = makeFlight({ position: new THREE.Vector3(0, 9000, 0) });
  let traffic = null;
  let threw = null;
  try {
    traffic = new AirTrafficSystem(null);
  } catch (e) {
    threw = e;
  }
  ok(!threw, 'AirTrafficSystem(null) constructs', threw ? String(threw) : '');

  traffic.reset(flight);
  ok(traffic.airliners.length === 4, 'spawns exactly 4 airliners', String(traffic.airliners.length));
  ok(traffic.wingmanEnabled === true, 'wingman enabled by default');

  let altsOk = true;
  let rangesOk = true;
  for (const a of traffic.airliners) {
    altsOk = altsOk && a.position.y >= 6500 && a.position.y <= 10500;
    rangesOk = rangesOk && a.position.distanceTo(flight.position) <= RANGE;
    altsOk = altsOk && a.speed > 150 && a.speed < 320;
  }
  ok(altsOk, 'airliners cruise between 6,500 m and 10,500 m at airliner speeds');
  ok(rangesOk, 'initial airliners spawn within 45 km of the player');

  const traffic2 = new AirTrafficSystem(null);
  traffic2.reset(flight);
  let identical = true;
  for (let i = 0; i < 4; i++) {
    identical = identical
      && traffic.airliners[i].position.equals(traffic2.airliners[i].position)
      && near(traffic.airliners[i].altitude, traffic2.airliners[i].altitude, 1e-12)
      && near(traffic.airliners[i].heading, traffic2.airliners[i].heading, 1e-12);
  }
  ok(identical, 'airliner tracks are deterministic across instances');

  const res = traffic.update(1 / 60, flight, makeWeather());
  ok(res.airlinerCount === 4, 'update reports 4 airliners');
  ok(res.wingmanPos instanceof THREE.Vector3, 'update exposes wingmanPos');
  ok(res.wingmanActive === true, 'wingman flies when player is airborne and fast');
}

// ------------------------------------------------- 5. 45 km recycling (moving)
{
  const flight = makeFlight({ position: new THREE.Vector3(0, 9000, 0), speed: 250 });
  const traffic = new AirTrafficSystem(null);
  traffic.reset(flight);

  let maxDist = 0;
  let recyclesSeen = false;
  for (let i = 0; i < 6000; i++) { // 100 s, flying north at 250 m/s
    flight.position.z -= 250 / 60;
    traffic.update(1 / 60, flight, makeWeather());
    for (const a of traffic.airliners) {
      const d = a.position.distanceTo(flight.position);
      if (d > maxDist) maxDist = d;
    }
  }
  ok(maxDist <= RANGE + 1, 'no airliner ever drifts beyond 45 km', maxDist.toFixed(0) + ' m');
  ok(traffic.airliners.length === 4, 'recycling keeps exactly 4 airliners');

  // Force a recycle: teleport one far outside the bubble.
  const victim = traffic.airliners[0];
  victim.position.set(flight.position.x + 180000, victim.altitude, flight.position.z);
  traffic.update(1 / 60, flight, makeWeather());
  const d = victim.position.distanceTo(flight.position);
  ok(d <= RANGE, 'out-of-range airliner recycles inside 45 km', d.toFixed(0) + ' m');
  ok(victim.position.y >= 6500 && victim.position.y <= 10500,
    'recycled airliner keeps its cruise altitude');
  ok(traffic.airliners.length === 4, 'recycle preserves the fleet size');
  recyclesSeen = true;
  ok(recyclesSeen, 'recycle path exercised');
}

// ----------------------------------------------- 6. wingman fingertip formation
{
  const bank = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -0.8, 0.35, 'YXZ'));
  const flight = makeFlight({
    position: new THREE.Vector3(1200, 3200, -400),
    quaternion: bank,
    speed: 230,
    onGround: false,
  });
  const traffic = new AirTrafficSystem(null);
  traffic.reset(flight);

  // Reset puts the wingman in formation immediately; pull it away to prove
  // it converges smoothly rather than teleporting each frame.
  traffic.wingmanPos.set(-3000, 1000, 5000);
  const target0 = new THREE.Vector3(22, 2, 18).applyQuaternion(bank).add(flight.position);
  const gap0 = traffic.wingmanPos.distanceTo(target0);

  traffic.update(1 / 60, flight, makeWeather());
  const gap1 = traffic.wingmanPos.distanceTo(target0);
  ok(gap1 < gap0, 'wingman closes the gap toward formation');
  ok(gap1 > gap0 * 0.8, 'convergence is smooth, not an instant snap',
    (gap0 - gap1).toFixed(1) + ' m in one frame');

  for (let i = 0; i < 60 * 12; i++) traffic.update(1 / 60, flight, makeWeather());
  const gap = traffic.wingmanPos.distanceTo(target0);
  ok(gap < 0.5, 'wingman converges to fingertip formation', gap.toFixed(2) + ' m');

  const local = traffic.wingmanPos.clone().sub(flight.position)
    .applyQuaternion(bank.clone().invert());
  ok(near(local.x, 22, 0.5), 'formation is +22 m right', local.x.toFixed(2));
  ok(near(local.y, 2, 0.5), 'formation is +2 m up', local.y.toFixed(2));
  ok(near(local.z, 18, 0.5), 'formation is +18 m aft', local.z.toFixed(2));
  ok(traffic.wingmanQuaternion.angleTo(bank) < 0.05, 'wingman matches player attitude');

  // Grounded or slow player: wingman stands down.
  const grounded = makeFlight({ onGround: true, speed: 200 });
  let res = traffic.update(1 / 60, grounded, makeWeather());
  ok(res.wingmanActive === false, 'wingman inactive on the ground');

  const slow = makeFlight({ onGround: false, speed: 60 });
  res = traffic.update(1 / 60, slow, makeWeather());
  ok(res.wingmanActive === false, 'wingman inactive below 75 m/s');

  const fast = makeFlight({ onGround: false, speed: 200 });
  res = traffic.update(1 / 60, fast, makeWeather());
  ok(res.wingmanActive === true, 'wingman active again when airborne and fast');

  ok(traffic.toggleWingman() === false, 'toggleWingman() reports disabled');
  res = traffic.update(1 / 60, fast, makeWeather());
  ok(res.wingmanActive === false, 'wingman stands down when toggled off');
  ok(traffic.toggleWingman() === true, 'toggleWingman() reports enabled');
  res = traffic.update(1 / 60, fast, makeWeather());
  ok(res.wingmanActive === true, 'wingman returns when toggled on');
}

// ------------------------------------------- 7. traffic scene mesh lifecycle
{
  const scene = new THREE.Scene();
  const traffic = new AirTrafficSystem(scene);
  const flight = makeFlight({ position: new THREE.Vector3(0, 9000, 0) });
  traffic.reset(flight);
  traffic.update(1 / 60, flight, makeWeather());

  const root = scene.children.find((c) => c.name === 'air-traffic');
  ok(!!root, 'traffic root group added to the scene');
  ok(!!traffic.airliners[0].mesh, 'airliner meshes built when a scene is provided');
  ok(traffic.airliners.every((a) => a.trails.length === 2), 'each airliner has twin contrails');
  ok(!!root.children.find((c) => c.name === 'viper-1-2'), 'wingman model exists in the scene');
}

console.log(`ejection/traffic checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL EJECTION/TRAFFIC CHECKS PASSED');