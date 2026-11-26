// Node-only acceptance test for src/world/carrier.js (Feature 15).
// Run: node tests/carrier_test.mjs
//
// Headless, zero-asset: verifies deterministic placement, deck queries,
// FLOLS guidance, arresting-wire recovery and the steam catapult. Also builds
// the 3D group against an in-memory THREE.Group to prove the model path is
// headless-safe (no canvas / DOM access).

import * as THREE from 'three';
import {
  CarrierGroup,
  DECK_HEIGHT,
  DECK_LENGTH,
  DECK_WIDTH,
  GLIDESLOPE_DEG,
  CATAPULT_SPEED_MS,
  CATAPULT_DURATION,
} from '../src/world/carrier.js';
import { baseHeight } from '../src/world/terrain.js';

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : String(n));

// Wheel contact height above the deck; the flight position is the CG.
const GEAR_REST = 1.55;

function makeFlight({ x = 0, z = 0, y = DECK_HEIGHT, vx = 0, vy = 0, vz = 0, speed = 0,
  throttle = 0, gearPos = 1, onGround = false, gearHeight = GEAR_REST } = {}) {
  return {
    position: new THREE.Vector3(x, y, z),
    velocity: new THREE.Vector3(vx, vy, vz),
    speed,
    throttle,
    gearPos,
    onGround,
    gearHeight,
  };
}

// ---------------------------------------------------------------------------
// 1. Construction, constants, deterministic placement
// ---------------------------------------------------------------------------
{
  const cg = new CarrierGroup(null);
  check(cg.group === null, 'group must be null when scene is null');
  check(cg.x === 0 && cg.z === 0, 'default position must be origin');
  check(cg.heading === 0, 'default heading must be 0');
  check(cg.deckHeight === 18.5, `deckHeight ${cg.deckHeight} != 18.5`);
  check(cg.name === 'USS THEODORE ROOSEVELT', `bad name ${cg.name}`);
  check(cg.code === 'CVN71', `bad code ${cg.code}`);
  check(cg.wireCaught === 0 && cg.wireTimer === 0, 'wire state must start clear');
  check(cg.catapultActive === false && cg.catapultTimer === 0, 'catapult must start idle');
  check(cg.DECK_HEIGHT === 18.5 && cg.DECK_LENGTH === 330 && cg.DECK_WIDTH === 76,
    'instance constants wrong');
  check(cg.GLIDESLOPE_DEG === 3.5 && cg.CATAPULT_SPEED_MS === 82 && cg.CATAPULT_DURATION === 2.2,
    'instance guidance constants wrong');
  check(DECK_HEIGHT === 18.5 && DECK_LENGTH === 330 && DECK_WIDTH === 76 &&
    GLIDESLOPE_DEG === 3.5 && CATAPULT_SPEED_MS === 82 && CATAPULT_DURATION === 2.2,
    'module constants wrong');

  // No ocean within 36 km of the origin: the contract's fixed fallback applies.
  const a = cg.placeNear(0, 0);
  check(a.x === 18000 && a.z === -18000, `fallback placement wrong: ${a.x},${a.z}`);
  check(cg.x === a.x && cg.z === a.z, 'placeNear did not update state');
  check(a.heading === cg.heading && a.deckHeight === cg.deckHeight, 'placeNear return mismatch');
  check(Number.isFinite(cg.heading) && cg.heading >= 0 && cg.heading < 360, 'heading not finite');

  const other = new CarrierGroup(null);
  const b = other.placeNear(0, 0);
  check(a.x === b.x && a.z === b.z && a.heading === b.heading, 'placement is not deterministic');

  // Deep-water search: pick an origin where the rings do find ocean.
  const sea = new CarrierGroup(null);
  const p = sea.placeNear(-95000, 0);
  const d = Math.hypot(p.x + 95000, p.z);
  check(baseHeight(p.x, p.z) < -6, `deep-water search returned shallow ${baseHeight(p.x, p.z).toFixed(1)} m`);
  check(d >= 5500 && d <= 36500, `deep-water search distance ${Math.round(d)} out of ring range`);
  check(sea.x === p.x && sea.z === p.z, 'deep-water placement did not stick');
}

// ---------------------------------------------------------------------------
// 2. Deck bounds and deck elevation
// ---------------------------------------------------------------------------
{
  const cg = new CarrierGroup(null, { x: 0, z: 0, heading: 0 });
  const deckPoint = cg.getDeckPoint();
  check(deckPoint.id === 'CVN71' && deckPoint.code === 'CVN71' &&
    deckPoint.name === 'USS THEODORE ROOSEVELT', 'deck point identity wrong');
  check(deckPoint.x === 0 && deckPoint.z === 0 && deckPoint.elevation === 18.5,
    'deck point placement wrong');
  check(deckPoint.heading === 0 && deckPoint.length === 330 && deckPoint.width === 76 &&
    deckPoint.kind === 'carrier', 'deck point airfield fields wrong');

  for (const [along, right] of [[0, 0], [164, 0], [-164, 0], [0, 37], [0, -37], [120, 20]]) {
    const w = cg.deckToWorld(along, right);
    check(cg.isOverDeck(w.x, w.z), `deck point along=${along} right=${right} not over deck`);
    check(cg.getDeckElevation(w.x, w.z) === 18.5,
      `deck elevation ${cg.getDeckElevation(w.x, w.z)} != 18.5 at ${along},${right}`);
  }
  for (const [along, right] of [[166, 0], [-166, 0], [0, 39], [0, -39], [200, 0]]) {
    const w = cg.deckToWorld(along, right);
    check(!cg.isOverDeck(w.x, w.z), `point along=${along} right=${right} wrongly over deck`);
    check(cg.getDeckElevation(w.x, w.z) === null,
      `elevation must be null outside deck at ${along},${right}`);
  }

  // Heading rotation: at 090 the bow points east (+X), starboard faces +Z.
  const east = new CarrierGroup(null, { x: 0, z: 0, heading: 90 });
  const l1 = east.worldToDeck(100, 0);
  check(near(l1.along, 100, 1e-9) && near(l1.right, 0, 1e-9), 'heading 090 along transform wrong');
  const l2 = east.worldToDeck(0, 100);
  check(near(l2.along, 0, 1e-9) && near(l2.right, 100, 1e-9), 'heading 090 right transform wrong');

  // worldToDeck / deckToWorld must be inverses.
  for (const [along, right] of [[-120, 30], [40, -18], [165, 37], [-165, -37]]) {
    const w = east.deckToWorld(along, right);
    const l = east.worldToDeck(w.x, w.z);
    check(near(l.along, along, 1e-6) && near(l.right, right, 1e-6),
      `deck<->world roundtrip failed at ${along},${right}`);
  }
}

// ---------------------------------------------------------------------------
// 3. FLOLS meatball
// ---------------------------------------------------------------------------
{
  const cg = new CarrierGroup(null, { x: 0, z: 0, heading: 0 });
  const dist = 1200;
  const glideY = DECK_HEIGHT + Math.tan(GLIDESLOPE_DEG * Math.PI / 180) * dist;

  const onPath = cg.deckToWorld(-dist, 0);
  const m0 = cg.getMeatball(makeFlight({ x: onPath.x, z: onPath.z, y: glideY }));
  check(m0.active === true, 'meatball inactive on a 3.5 deg approach');
  check(m0.ballOffset >= -0.02 && m0.ballOffset <= 0.02,
    `ballOffset ${fmt(m0.ballOffset)} not centered on glideslope`);
  check(Math.abs(m0.glideslopeErrorDeg) <= 0.02,
    `glideslope error ${fmt(m0.glideslopeErrorDeg)} deg not ~0`);
  check(near(m0.distNm, dist / 1852, 0.005), `distNm ${fmt(m0.distNm)} wrong`);
  check(near(m0.bearing, 180, 0.2), `bearing ${fmt(m0.bearing)} not astern`);
  check(m0.deckHeading === 0, 'deckHeading not reported');
  check(near(m0.lineupErrorM, 0, 0.01), `lineup ${fmt(m0.lineupErrorM)} not centered`);

  const high = cg.getMeatball(makeFlight({ x: onPath.x, z: onPath.z, y: glideY + 80 }));
  check(high.active === true && high.ballOffset > 0.3,
    `high approach ballOffset ${fmt(high.ballOffset)} not positive`);
  check(high.glideslopeErrorDeg > 0, 'high approach error must be positive');

  const low = cg.getMeatball(makeFlight({ x: onPath.x, z: onPath.z, y: glideY - 80 }));
  check(low.active === true && low.ballOffset < -0.3,
    `low approach ballOffset ${fmt(low.ballOffset)} not negative`);
  check(low.glideslopeErrorDeg < 0, 'low approach error must be negative');

  // Lineup: 25 m right of centreline.
  const offset = cg.deckToWorld(-dist, 25);
  const lineup = cg.getMeatball(makeFlight({ x: offset.x, z: offset.z, y: glideY }));
  check(lineup.active === true && near(lineup.lineupErrorM, 25, 0.5),
    `lineupErrorM ${fmt(lineup.lineupErrorM)} != 25`);

  // Outside the 8 km gate, ahead of the ship, and outside the 30 deg cone.
  const far = cg.deckToWorld(-9000, 0);
  check(cg.getMeatball(makeFlight({ x: far.x, z: far.z, y: glideY })).active === false,
    'meatball active beyond 8 km');
  const ahead = cg.deckToWorld(300, 0);
  check(cg.getMeatball(makeFlight({ x: ahead.x, z: ahead.z, y: glideY })).active === false,
    'meatball active ahead of the bow');
  const wide = cg.deckToWorld(-1000, 2000);
  check(cg.getMeatball(makeFlight({ x: wide.x, z: wide.z, y: glideY })).active === false,
    'meatball active outside the 30 deg approach cone');
  check(cg.getMeatball(null).active === false, 'meatball must be inert without a flight');
}

// ---------------------------------------------------------------------------
// 4. Arresting wires
// ---------------------------------------------------------------------------
{
  const cg = new CarrierGroup(null, { x: 0, z: 0, heading: 0 });
  const p = cg.deckToWorld(-100, 0);
  const flight = makeFlight({ x: p.x, z: p.z, y: DECK_HEIGHT + 2.0, vz: -72, speed: 72, gearPos: 1 });

  const first = cg.update(1 / 60, flight);
  check(first.onDeck === true, 'landing jet not reported on deck');
  check(first.newlyCaughtWire >= 1 && first.newlyCaughtWire <= 4,
    `newlyCaughtWire ${first.newlyCaughtWire} not 1..4`);
  check(cg.wireCaught >= 1 && cg.wireCaught <= 4, `wireCaught ${cg.wireCaught} not 1..4`);
  check(first.meatball.deckHeading === 0, 'update meatball missing deckHeading');

  let t = 0;
  let stoppedAt = Infinity;
  let leftDeckHeight = false;
  let reversed = false;
  const restingY = DECK_HEIGHT + GEAR_REST;
  while (t < 2.5) {
    const r = cg.update(1 / 60, flight);
    t += 1 / 60;
    if (!near(flight.position.y, restingY, 0.01)) leftDeckHeight = true;
    if (flight.velocity.z > 1e-6) reversed = true;
    if (flight.speed < 2) stoppedAt = Math.min(stoppedAt, t);
    if (r.wireCaught === 0) break;
  }
  check(stoppedAt < Infinity, `jet never slowed below 2 m/s (speed ${fmt(flight.speed)})`);
  check(t <= 2.5, `wire stop took ${fmt(t)} s > 2.5 s`);
  check(flight.speed < 2, `final speed ${fmt(flight.speed)} >= 2`);
  check(!leftDeckHeight, 'jet left wheel-rest height during wire recovery');
  check(near(flight.position.y, restingY, 0.01),
    `wheels not resting on deck after recovery (y ${fmt(flight.position.y)} vs ${fmt(restingY)})`);
  check(!reversed, 'jet moved backwards during wire recovery');
  check(cg.wireCaught === 0, `wire not released after stop (${cg.wireCaught})`);

  // No catch with gear up, too slow, or outside the wire zone.
  const gearUp = makeFlight({ x: p.x, z: p.z, y: DECK_HEIGHT + 2, vz: -72, speed: 72, gearPos: 0.2 });
  check(cg.update(1 / 60, gearUp).newlyCaughtWire === 0, 'caught with gear up');

  const slow = makeFlight({ x: p.x, z: p.z, y: DECK_HEIGHT + 2, vz: -20, speed: 20 });
  check(cg.update(1 / 60, slow).newlyCaughtWire === 0, 'caught while too slow');

  const outZone = cg.deckToWorld(-20, 0);
  const miss = makeFlight({ x: outZone.x, z: outZone.z, y: DECK_HEIGHT + 2, vz: -72, speed: 72 });
  check(cg.update(1 / 60, miss).newlyCaughtWire === 0, 'caught outside the wire zone');
}

// ---------------------------------------------------------------------------
// 5. Steam catapult
// ---------------------------------------------------------------------------
{
  const cg = new CarrierGroup(null, { x: 0, z: 0, heading: 0 });
  const p = cg.deckToWorld(90, 0);
  const flight = makeFlight({ x: p.x, z: p.z, y: DECK_HEIGHT + 0.1, speed: 0, throttle: 0.95, onGround: true });

  const start = cg.update(1 / 60, flight);
  check(cg.catapultActive === true, 'catapult did not auto-trigger at the bow');
  check(start.catapultActive === true, 'update did not report the catapult as active');

  let t = 0;
  let maxSpeed = 0;
  let launchedFlag = false;
  let badDirection = false;
  while (t < 2.3) {
    const r = cg.update(1 / 60, flight);
    t += 1 / 60;
    maxSpeed = Math.max(maxSpeed, flight.speed);
    if (r.catapultLaunched) launchedFlag = true;
    if (flight.velocity.z > 1e-6 || Math.abs(flight.velocity.x) > 1e-6) badDirection = true;
  }
  check(maxSpeed >= 78, `catapult max speed ${fmt(maxSpeed)} < 78 m/s`);
  check(!cg.catapultActive, 'catapult still active after 2.3 s');
  check(cg.catapultTimer >= CATAPULT_DURATION, `catapult timer ${fmt(cg.catapultTimer)}`);
  check(!badDirection, 'catapult velocity not aligned with the bow (-Z)');
  check(launchedFlag, 'catapultLaunched never reported');

  // Explicit arming: on deck and slow -> true; too fast or off deck -> false.
  const cg2 = new CarrierGroup(null, { x: 0, z: 0, heading: 0 });
  const onDeck = cg2.deckToWorld(60, 0);
  const armed = makeFlight({ x: onDeck.x, z: onDeck.z, y: DECK_HEIGHT + 1, speed: 10 });
  check(cg2.triggerCatapult(armed) === true, 'triggerCatapult refused a valid jet');
  check(cg2.catapultActive === true && cg2.catapultTimer === 0, 'triggerCatapult did not arm');

  const fast = makeFlight({ x: onDeck.x, z: onDeck.z, y: DECK_HEIGHT + 1, speed: 30 });
  check(cg2.triggerCatapult(fast) === false, 'triggerCatapult armed a fast jet');

  const off = cg2.deckToWorld(500, 0);
  const away = makeFlight({ x: off.x, z: off.z, y: DECK_HEIGHT + 1, speed: 5 });
  check(cg2.triggerCatapult(away) === false, 'triggerCatapult armed an off-deck jet');
}

// ---------------------------------------------------------------------------
// 6. 3D model exists, follows placement, and moves the FLOLS ball
// ---------------------------------------------------------------------------
{
  const scene = new THREE.Group();
  const cg = new CarrierGroup(scene, { heading: 0 });
  check(cg.group instanceof THREE.Group, 'group missing when scene is provided');
  check(scene.children.length === 1 && scene.children[0] === cg.group, 'group not added to scene');

  let meshes = 0;
  cg.group.traverse((o) => { if (o.isMesh) meshes++; });
  check(meshes >= 40, `carrier model has only ${meshes} meshes`);

  const placed = cg.placeNear(0, 0);
  check(cg.group.position.x === placed.x && cg.group.position.z === placed.z,
    'group did not follow placeNear');
  check(near(cg.group.rotation.y, 0, 1e-9), 'group rotation wrong for heading 0');

  const cgEast = new CarrierGroup(new THREE.Group(), { x: 0, z: 0, heading: 90 });
  cgEast.placeNear(-95000, 0);
  check(near(cgEast.group.rotation.y, -Math.PI / 2, 1e-6), 'group rotation wrong for heading 90');

  // FLOLS ball moves up for a high approach and back to datum when inactive.
  const cg3 = new CarrierGroup(new THREE.Group(), { x: 0, z: 0, heading: 0 });
  const baseY = cg3._flolsBall.position.y;
  const approach = cg3.deckToWorld(-1200, 0);
  const highY = DECK_HEIGHT + Math.tan(GLIDESLOPE_DEG * Math.PI / 180) * 1200 + 90;
  const r = cg3.update(1 / 60, makeFlight({ x: approach.x, z: approach.z, y: highY }));
  check(r.meatball.active === true && r.meatball.ballOffset > 0.3,
    '3D meatball setup did not read as high');
  check(cg3._flolsBall.position.y > baseY + 0.4, 'FLOLS ball did not move up');
  cg3.update(1 / 60, null);
  check(near(cg3._flolsBall.position.y, baseY, 1e-9), 'FLOLS ball did not recenter when inactive');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n${failures.length} of ${checks} carrier checks FAILED:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`${checks} checks passed`);
  console.log('ALL CARRIER CHECKS PASSED');
  process.exitCode = 0;
}