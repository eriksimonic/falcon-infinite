// Headless acceptance test for src/combat/targets.js.
// Run: node tests/targets_test.mjs
//
// Covers: deterministic scenario spawning on terrain, mesh construction and
// disposal, splash damage falloff, the SEARCH -> LOCK -> LAUNCH SAM state
// machine with terrain masking, flare decoying of incoming SAMs, seeker cone
// selection for AIM-9 and GUN/MK-82, RWR contacts and bandit patrol behaviour.

import * as THREE from 'three';
import { TargetSystem } from '../src/combat/targets.js';

let checks = 0;
const failures = [];

function check(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const flat = { heightAt: () => 0 };
const hilly = {
  heightAt: (x, z) => 40 + 12 * Math.sin(x * 0.001) + 8 * Math.cos(z * 0.0011),
};

const PUBLIC_KEYS = [
  'id', 'kind', 'label', 'airborne', 'position', 'velocity', 'heading',
  'hp', 'maxHp', 'alive', 'hitRadius', 'radarActive', 'radarRange',
  'lockState', 'mesh',
];

function makeFlight(x, y, z, heading = 0) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
  return {
    position: new THREE.Vector3(x, y, z),
    velocity: new THREE.Vector3(0, 0, -240),
    quaternion: q,
    rates: new THREE.Vector3(),
    controls: { pitch: 0, roll: 0, yaw: 0 },
    onGround: false,
    crashed: false,
  };
}

const scenarioSpecs = [
  { id: 'radar-a', kind: 'RADAR', label: 'SA-6 RADAR', x: 1200, z: -800 },
  { id: 'sam-a', kind: 'SAM', label: 'SA-2 BATTERY', x: 1400, z: -900 },
  { id: 'depot-a', kind: 'DEPOT', label: 'FUEL DEPOT', x: 1600, z: -700 },
  {
    id: 'bandit-a', kind: 'BANDIT', label: 'MIG-29',
    x: 2200, z: -1800, alt: 2400, orbitRadius: 1800, speed: 220,
  },
];

// ---------------------------------------------------------------------------
// 1. Spawning, terrain placement and deterministic patrols
// ---------------------------------------------------------------------------
{
  const ts = new TargetSystem(null);
  const spawned = ts.spawnScenario(scenarioSpecs, hilly);

  check(spawned.length === 4, 'spawnScenario returned wrong count', String(spawned.length));
  check(ts.targets.length === 4, 'targets array length');

  const [radar, sam, depot, bandit] = ts.targets;
  const kinds = ts.targets.map((t) => t.kind);
  check(JSON.stringify(kinds) === JSON.stringify(['RADAR', 'SAM', 'DEPOT', 'BANDIT']),
    'target kinds/order wrong', kinds.join(','));

  for (const t of ts.targets) {
    for (const k of PUBLIC_KEYS) check(k in t, `${t.id} missing field ${k}`);
    check(t.position.isVector3, `${t.id} position not Vector3`);
    check(t.velocity.isVector3, `${t.id} velocity not Vector3`);
    check(t.alive === true, `${t.id} should spawn alive`);
    check(t.hp === t.maxHp && t.hp > 0, `${t.id} hp/maxHp invalid`);
    check(Number.isFinite(t.heading), `${t.id} heading not finite`);
    check(t.mesh === null, `${t.id} mesh should be null without a scene`);
    check(['IDLE', 'SEARCH', 'LOCK', 'LAUNCH'].includes(t.lockState), `${t.id} bad lockState`);
  }

  const expected = {
    RADAR: { hitRadius: 18, radarRange: 14000 },
    SAM: { hitRadius: 14, radarRange: 14000 },
    DEPOT: { hitRadius: 26, radarRange: 0 },
    BANDIT: { hitRadius: 16, radarRange: 11000 },
  };
  for (const t of ts.targets) {
    check(t.hitRadius === expected[t.kind].hitRadius, `${t.kind} hitRadius`, String(t.hitRadius));
    check(t.radarRange === expected[t.kind].radarRange, `${t.kind} radarRange`, String(t.radarRange));
  }

  // Ground units sit exactly on the terrain; bandits are airborne with floor.
  for (const t of [radar, sam, depot]) {
    check(!t.airborne, `${t.id} should not be airborne`);
    const gh = hilly.heightAt(t.position.x, t.position.z);
    check(near(t.position.y, gh, 1e-9), `${t.id} not on terrain`,
      `${t.position.y} vs ${gh}`);
  }
  check(bandit.airborne, 'bandit should be airborne');
  check(bandit.position.y >= hilly.heightAt(bandit.position.x, bandit.position.z) + 350,
    'bandit below safe altitude');
  check(bandit.position.y > 1000, 'bandit altitude too low', bandit.position.y.toFixed(0));

  // Deterministic spawn: same specs and world -> identical state.
  const ts2 = new TargetSystem(null);
  ts2.spawnScenario(scenarioSpecs, hilly);
  for (let i = 0; i < ts.targets.length; i++) {
    const a = ts.targets[i];
    const b = ts2.targets[i];
    check(a.id === b.id && a.kind === b.kind, `deterministic id/kind at ${i}`);
    check(a.position.distanceTo(b.position) < 1e-9, `deterministic position at ${i}`);
    check(near(a.heading, b.heading, 1e-9), `deterministic heading at ${i}`);
  }

  // Patrols are deterministic and stay above terrain + 350 m.
  const start = bandit.position.clone();
  let minClearance = Infinity;
  for (let i = 0; i < 400; i++) {
    ts.update(0.05, null, hilly);
    ts2.update(0.05, null, hilly);
    minClearance = Math.min(
      minClearance,
      bandit.position.y - hilly.heightAt(bandit.position.x, bandit.position.z),
    );
  }
  check(bandit.position.distanceTo(ts2.targets[3].position) < 1e-9,
    'bandit patrol not deterministic');
  check(bandit.position.distanceTo(start) > 200, 'bandit did not patrol',
    bandit.position.distanceTo(start).toFixed(0) + ' m');
  check(minClearance >= 349.9, 'bandit patrol dipped below 350 m clearance',
    minClearance.toFixed(1) + ' m');
  check(bandit.velocity.length() > 200, 'bandit patrol velocity not set');
  check(near(bandit.velocity.length(), 220, 0.01), 'bandit speed changed');
}

// ---------------------------------------------------------------------------
// 2. Procedural meshes with a scene, then clean disposal
// ---------------------------------------------------------------------------
{
  const scene = new THREE.Scene();
  const ts = new TargetSystem(scene);
  ts.spawnScenario(scenarioSpecs, hilly);

  check(ts.group.parent === scene, 'target group not added to scene');
  for (const t of ts.targets) {
    check(!!t.mesh && t.mesh.isObject3D, `${t.id} mesh missing`);
    check(t.mesh.parent === ts.group, `${t.id} mesh not in target group`);
    check(t.mesh.position.distanceTo(t.position) < 1e-9, `${t.id} mesh position mismatch`);
    check(t.mesh.children.length > 1, `${t.id} mesh has too few parts`,
      String(t.mesh.children.length));
  }

  // Ground target meshes must lie at their world location.
  check(ts.targets[0].mesh.position.y === ts.targets[0].position.y, 'radar mesh y');

  for (let i = 0; i < 100; i++) ts.update(0.05, null, hilly);
  check(ts.targets[3].mesh.position.distanceTo(ts.targets[3].position) < 1e-9,
    'bandit mesh not following target');

  const missileSpecs = [{ id: 'sam-mesh', kind: 'SAM', x: 0, z: 0 }];
  ts.spawnScenario(missileSpecs, flat);
  const flight = makeFlight(0, 1200, 6000);
  for (let i = 0; i < 120; i++) ts.update(0.05, flight, flat);
  check(ts.enemyMissiles.length === 1, 'scene SAM did not launch a missile');
  const missile = ts.enemyMissiles[0];
  check(!!missile.mesh && missile.mesh.isObject3D, 'missile mesh missing');
  check(missile.mesh.parent === ts.group, 'missile mesh not in target group');

  ts.clear();
  check(ts.targets.length === 0, 'clear did not empty targets');
  check(ts.enemyMissiles.length === 0, 'clear did not empty missiles');
  check(ts.group.children.length === 0, 'clear left meshes in group');
  check(scene.children.includes(ts.group), 'clear removed the target group itself');

  const afterClear = ts.update(0.016, flight, flat);
  check(afterClear.events.length === 0 && afterClear.rwrContacts.length === 0,
    'update after clear should be empty');
}

// ---------------------------------------------------------------------------
// 3. Splash damage, linear falloff and one-shot destruction events
// ---------------------------------------------------------------------------
{
  const ts = new TargetSystem(null);
  ts.spawnScenario([
    { id: 'depot-1', kind: 'DEPOT', x: 0, z: 0 },
    { id: 'sam-1', kind: 'SAM', x: 120, z: 0 },
    { id: 'radar-1', kind: 'RADAR', x: 400, z: 0 },
  ], flat);

  const depot = ts.targets[0];
  const sam = ts.targets[1];
  const radar = ts.targets[2];

  let destroyed = ts.applyImpact({
    position: { x: 0, y: 0, z: 0 },
    damage: 140,
    splashRadius: 55,
    hitTargetId: 'depot-1',
  });
  check(destroyed.length === 0, 'premature destruction at origin');
  check(near(depot.hp, depot.maxHp - 140), 'direct hit damage', depot.hp.toFixed(2));
  check(near(sam.hp, sam.maxHp), 'SAM outside splash took damage', sam.hp.toFixed(2));
  check(near(radar.hp, radar.maxHp), 'RADAR outside splash took damage');

  // Impact 53.5 m from depot centre: 27.5 m beyond its 26 m hit radius, so
  // exactly half of a 55 m splash ring. SAM is 66.5 m away, 52.5 m beyond
  // its 14 m radius -> 2.5/55 = 0.04545 of the damage.
  destroyed = ts.applyImpact({
    position: new THREE.Vector3(53.5, 0, 0),
    damage: 100,
    splashRadius: 55,
  });
  check(destroyed.length === 0, 'splash destroyed something prematurely');
  check(near(depot.hp, 70, 1e-9), 'depot linear falloff damage', depot.hp.toFixed(3));
  check(near(sam.hp, 120 - 100 * (2.5 / 55), 1e-9), 'SAM linear falloff damage',
    sam.hp.toFixed(3));
  check(near(radar.hp, 150), 'RADAR took impossible splash');

  // Finish the depot and verify the destruction record is emitted once.
  destroyed = ts.applyImpact({
    position: new THREE.Vector3(0, 5, 0),
    damage: 140,
    splashRadius: 55,
    hitTargetId: 'depot-1',
  });
  check(destroyed.length === 1, 'expected exactly one destruction', String(destroyed.length));
  const rec = destroyed[0];
  check(rec.id === 'depot-1' && rec.kind === 'DEPOT' && rec.label === 'FUEL DEPOT',
    'destruction record fields', JSON.stringify(rec));
  check(rec.position && rec.position.isVector3 && rec.position.x === 0,
    'destruction record position');
  check(depot.alive === false && depot.hp === 0, 'depot not marked destroyed');
  check(depot.lockState === 'IDLE' && depot.radarActive === false,
    'destroyed target still emitting');

  destroyed = ts.applyImpact({
    position: new THREE.Vector3(0, 5, 0),
    damage: 140,
    splashRadius: 55,
  });
  check(destroyed.length === 0, 'destroyed target reported twice');

  // A far impact does nothing at all.
  destroyed = ts.applyImpact({ position: { x: 5000, y: 0, z: 0 }, damage: 999, splashRadius: 20 });
  check(destroyed.length === 0 && sam.hp === ts.targets[1].hp, 'far impact changed state');
}

// ---------------------------------------------------------------------------
// 4. SAM state machine: SEARCH -> LOCK -> LAUNCH, then terrain masking
// ---------------------------------------------------------------------------
let siteTs;
let siteSam;
let siteFlight;
let siteResult;
{
  siteTs = new TargetSystem(null);
  siteTs.spawnScenario([{ id: 'sam-site', kind: 'SAM', label: 'SA-2 BATTERY', x: 0, z: 0 }], flat);
  siteSam = siteTs.targets[0];
  siteFlight = makeFlight(0, 1500, 6000);

  check(siteSam.lockState === 'IDLE', 'SAM should start IDLE');
  check(siteSam.radarActive === false, 'SAM should start silent');

  let sawSearch = false;
  let sawLock = false;
  let sawLaunch = false;
  let lockContact = null;
  let launchContact = null;
  let firstMissile = null;

  for (let i = 0; i < 120; i++) {
    siteResult = siteTs.update(0.05, siteFlight, flat, []);
    if (siteSam.lockState === 'SEARCH') sawSearch = true;
    if (siteSam.lockState === 'LOCK') {
      sawLock = true;
      if (!lockContact) {
        lockContact = siteResult.rwrContacts.find((c) => c.id === 'sam-site' && !c.isMissile);
      }
    }
    if (siteSam.lockState === 'LAUNCH') {
      sawLaunch = true;
      if (!launchContact) {
        launchContact = siteResult.rwrContacts.find((c) => c.isMissile);
      }
    }
    if (!firstMissile && siteTs.enemyMissiles.length) firstMissile = siteTs.enemyMissiles[0];
  }

  check(sawSearch, 'SAM never entered SEARCH');
  check(sawLock, 'SAM never entered LOCK after sustained detection');
  check(sawLaunch, 'SAM never entered LAUNCH');
  check(!!firstMissile, 'no enemy SAM was fired');
  check(siteTs.enemyMissiles.length === 1, 'unexpected missile count',
    String(siteTs.enemyMissiles.length));

  if (firstMissile) {
    check(near(firstMissile.velocity.length(), 460, 1e-6), 'SAM speed not 460 m/s',
      firstMissile.velocity.length().toFixed(2));
    check(firstMissile.ttl > 0 && firstMissile.ttl <= 18, 'SAM ttl out of range',
      firstMissile.ttl.toFixed(2));
    check(firstMissile.sourceId === 'sam-site', 'SAM sourceId wrong');
    check(firstMissile.decoyed === false, 'fresh SAM should not be decoyed');
    check(['id', 'position', 'velocity', 'ttl', 'decoyed', 'sourceId', 'mesh'].every(
      (k) => k in firstMissile,
    ), 'enemy missile shape incomplete');
  }

  check(!!lockContact, 'no RWR contact while locking');
  if (lockContact) {
    check(Math.abs(lockContact.bearingRad) < 0.05, 'RWR bearing should be dead ahead',
      lockContact.bearingRad.toFixed(3));
    check(lockContact.distance > 5000, 'RWR distance wrong');
    check(!lockContact.isMissile, 'target contact flagged as missile');
    check(lockContact.state === 'LOCK' || lockContact.state === 'LAUNCH', 'RWR state');
  }
  check(!!launchContact, 'no missile RWR contact after launch');
  if (launchContact) {
    check(launchContact.state === 'LAUNCH' && launchContact.isMissile === true, 'missile RWR flags');
  }

  // Dive below the 45 m masking floor: lock must break immediately.
  siteFlight.position.y = 35;
  siteResult = siteTs.update(0.05, siteFlight, flat, []);
  check(siteSam.lockState !== 'LOCK' && siteSam.lockState !== 'LAUNCH',
    'terrain masking did not break lock', siteSam.lockState);
  check(siteSam.lockState === 'IDLE', 'masked SAM should be IDLE', siteSam.lockState);
  check(siteSam.radarActive === false, 'masked SAM should not be radiating');

  // Coming back up restarts acquisition from zero.
  siteFlight.position.y = 1500;
  siteResult = siteTs.update(0.05, siteFlight, flat, []);
  check(siteSam.lockState === 'SEARCH', 'SAM should re-acquire in SEARCH',
    siteSam.lockState);
  check(siteSam.radarActive === true, 'SAM should radiate after re-acquisition');

  // A stationary radar site locks but never fires.
  const radarTs = new TargetSystem(null);
  radarTs.spawnScenario([{ id: 'ewr', kind: 'RADAR', x: 0, z: 0 }], flat);
  const radar = radarTs.targets[0];
  for (let i = 0; i < 120; i++) radarTs.update(0.05, makeFlight(0, 1200, 6000), flat);
  check(radar.lockState === 'LOCK' || radar.lockState === 'LAUNCH',
    'RADAR never locked', radar.lockState);
  check(radarTs.enemyMissiles.length === 0, 'RADAR site fired a missile');
}

// ---------------------------------------------------------------------------
// 5. Flare decoying: a flare within 140 m seduces an incoming SAM
// ---------------------------------------------------------------------------
{
  const ts = new TargetSystem(null);
  ts.spawnScenario([{ id: 'sam-decoy', kind: 'SAM', x: 0, z: 0 }], flat);
  const flight = makeFlight(0, 1500, 6000);

  let missile = null;
  for (let i = 0; i < 160 && !missile; i++) {
    ts.update(0.05, flight, flat, []);
    if (ts.enemyMissiles.length) missile = ts.enemyMissiles[0];
  }
  check(!!missile, 'could not launch a missile for the decoy test');

  if (missile) {
    // Move the missile to 500 m behind the player, closing head-on.
    missile.position.set(0, 1300, 6500);
    missile.velocity.set(0, 0, -460);
    missile._lastRange = 500;

    const flare = {
      position: new THREE.Vector3(100, 1300, 6500),
      velocity: new THREE.Vector3(0, -4, 0),
      ttl: 4,
    };
    flight.rates.set(0, 0, 1); // banking hard — guarantees the decoy

    const before = missile.position.distanceTo(flight.position);
    flight.position.y += 0.001; // keep the closing geometry unambiguous

    let playerHits = 0;
    for (let i = 0; i < 240; i++) {
      const res = ts.update(1 / 60, flight, flat, [flare]);
      for (const e of res.events) if (e.kind === 'playerHit') playerHits++;
    }

    check(missile.decoyed === true, 'flare within 140 m did not decoy the SAM');
    check(playerHits === 0, 'player was hit despite the decoy', String(playerHits));
    check(ts.enemyMissiles.length === 0, 'decoyed missile was not cleaned up');
    check(missile.position.distanceTo(flight.position) > 24,
      'decoyed missile still passed within the fuse radius');
    check(before < 600, 'decoy setup distance wrong');

    // A flare beyond the influence radius must not decoy.
    const ts2 = new TargetSystem(null);
    ts2.spawnScenario([{ id: 'sam-decoy-2', kind: 'SAM', x: 0, z: 0 }], flat);
    const f2 = makeFlight(0, 1500, 6000);
    let m2 = null;
    for (let i = 0; i < 160 && !m2; i++) {
      ts2.update(0.05, f2, flat, []);
      if (ts2.enemyMissiles.length) m2 = ts2.enemyMissiles[0];
    }
    if (m2) {
      m2.position.set(0, 1300, 6500);
      m2.velocity.set(0, 0, -460);
      m2._lastRange = 500;
      const farFlare = { position: new THREE.Vector3(700, 1300, 6500), ttl: 4 };
      ts2.update(1 / 60, f2, flat, [farFlare]);
      check(m2.decoyed === false, 'flare 700 m away decoyed the missile');
    } else {
      check(false, 'second decoy control missile missing');
    }
  }
}

// ---------------------------------------------------------------------------
// 6. findLockTarget: seeker cones, air preference, rear-hemisphere rejection
// ---------------------------------------------------------------------------
{
  const flight = makeFlight(0, 3000, 0);

  const ts = new TargetSystem(null);
  ts.spawnScenario([
    { id: 'bandit-front', kind: 'BANDIT', x: 0, z: -8000, alt: 3000 },
    { id: 'bandit-rear', kind: 'BANDIT', x: 0, z: 8000, alt: 3000 },
    { id: 'sam-front', kind: 'SAM', x: 0, z: -4000 },
    { id: 'depot-front', kind: 'DEPOT', x: 0, z: -5000 },
  ], flat);
  const [front, rear, sam, depot] = ts.targets;
  // Freeze patrol positions so the geometry under test is exact.
  front.position.set(0, 3000, -8000);
  rear.position.set(0, 3000, 8000);
  sam.position.set(0, 0, -4000);
  depot.position.set(0, 0, -5000);

  let picked = ts.findLockTarget(flight, 'AIM9');
  check(picked === front, 'AIM9 did not pick the airborne target ahead',
    picked ? picked.id : 'null');

  // Only the rear bandit remains airborne: AIM-9 must not look behind.
  front.alive = false;
  picked = ts.findLockTarget(flight, 'AIM9');
  check(picked === null, 'AIM9 locked a target behind the jet',
    picked ? picked.id : 'null');

  // Low-level flight: the SAM ahead is now inside the 15° ground mode.
  const lowFlight = makeFlight(0, 120, 0);
  picked = ts.findLockTarget(lowFlight, 'AIM9');
  check(picked === sam, 'AIM9 ground mode failed to lock the SAM', picked ? picked.id : 'null');

  // GUN: closest target in a 22° cone. Make the depot the nearer one.
  depot.position.set(0, 0, -2500);
  const gunFlight = makeFlight(0, 120, 0);
  picked = ts.findLockTarget(gunFlight, 'GUN');
  check(picked === depot, 'GUN did not pick the closest target', picked ? picked.id : 'null');

  // MK-82 behaves like GUN for designation.
  picked = ts.findLockTarget(gunFlight, 'MK82');
  check(picked === depot, 'MK82 designation differs from GUN');

  // A high-aspect target outside 22° is rejected.
  const highFlight = makeFlight(0, 3000, 0);
  depot.position.set(0, 0, -2000);
  picked = ts.findLockTarget(highFlight, 'GUN');
  check(picked === null, 'GUN locked a target outside its cone', picked ? picked.id : 'null');

  // Dead targets are never locked.
  const tsDead = new TargetSystem(null);
  tsDead.spawnScenario([{ id: 'dead', kind: 'BANDIT', x: 0, z: -3000, alt: 3000 }], flat);
  tsDead.targets[0].position.set(0, 3000, -3000);
  tsDead.applyImpact({ position: tsDead.targets[0].position, damage: 999, splashRadius: 0 });
  const deadFlight = makeFlight(0, 3000, 0);
  check(tsDead.findLockTarget(deadFlight, 'AIM9') === null, 'locked a destroyed target');

  // No flight -> no lock.
  check(ts.findLockTarget(null, 'AIM9') === null, 'null flight produced a lock');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Targets / SAM / bandits — acceptance test');
console.log('=========================================');
console.log('spawning · meshes · splash · SAM AI · flares · seekers · RWR');
console.log(`checks: ${checks}, failures: ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.log('  - ' + f);
  if (failures.length > 30) console.log(`  ... and ${failures.length - 30} more`);
  process.exitCode = 1;
} else {
  console.log('\nALL TARGET CHECKS PASSED');
}