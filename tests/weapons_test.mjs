// Weapon system acceptance tests (headless: scene = null, no mesh creation).
import * as THREE from 'three';
import { WeaponSystem, WEAPON_TYPES, WEAPONS, DEFAULT_AMMO } from '../src/combat/weapons.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const flatWorld = { heightAt: () => 0 };

// Aircraft stand-in matching the FlightModel surface WeaponSystem consumes.
function makeFlight({ pos = [0, 3000, 0], vel = [0, 0, -250], heading = 0, pitch = 0 } = {}) {
  const position = new THREE.Vector3(...pos);
  const velocity = new THREE.Vector3(...vel);
  const quaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(pitch, (-heading * Math.PI) / 180, 0, 'YXZ'),
  );
  return { position, velocity, quaternion };
}

function step(ws, flight, world, targets = [], seconds = 1 / 60) {
  return ws.update(seconds, flight, world, targets);
}

// Feature 12A helpers --------------------------------------------------------
function withDispersion(disp, fn) {
  const orig = WEAPONS.GUN.dispersion;
  WEAPONS.GUN.dispersion = disp;
  try {
    return fn();
  } finally {
    WEAPONS.GUN.dispersion = orig;
  }
}

function gunImpact(ws, flight, world, maxSeconds = 4) {
  for (let i = 0; i < Math.ceil(maxSeconds * 60); i++) {
    const events = ws.update(1 / 60, flight, world);
    const impact = events.find((e) => e.kind === 'impact' && e.weapon === 'GUN');
    if (impact) return impact;
  }
  return null;
}

// Fires `shots` GUN rounds from a static aircraft and returns the worst
// miss distance between the real impacts and each shot's solved impact point.
function strafeBurst(world, pos, diveDeg, speed, shots = 10) {
  const ws = new WeaponSystem(null);
  ws.selectWeapon('GUN');
  const pitch = (-diveDeg * Math.PI) / 180;
  const f = new THREE.Vector3(0, Math.sin(pitch), -Math.cos(pitch)).multiplyScalar(speed);
  const flight = makeFlight({ pos, vel: [f.x, f.y, f.z], pitch });

  let worst = 0;
  let solved = 0;
  for (let s = 0; s < shots; s++) {
    const sol = ws.computeGunSolution(flight, world);
    if (sol.valid && sol.impactValid) {
      const aim = { x: sol.impactPoint.x, y: sol.impactPoint.y, z: sol.impactPoint.z };
      solved++;
      ws.fire(flight);
      const impact = gunImpact(ws, flight, world);
      const miss = impact
        ? Math.hypot(impact.position.x - aim.x, impact.position.y - aim.y, impact.position.z - aim.z)
        : Infinity;
      worst = Math.max(worst, miss);
    }
    ws.update(0.1, flight, world);
  }
  return { ws, worst, solved };
}

// ------------------------------------------------------- 1. cycling + ammo
{
  const ws = new WeaponSystem(null);
  ok(WEAPON_TYPES.join(',') === 'GUN,AIM9,MK82,BFFG', 'weapon types exported');
  ok(ws.selected === 'GUN', 'starts on GUN');
  ok(ws.ammo.GUN === 510 && ws.ammo.AIM9 === 4 && ws.ammo.MK82 === 6
    && ws.ammo.BFFG === 2 && ws.ammo.FLARE === 30,
  'initial loadout full');

  ok(ws.cycleWeapon() === 'AIM9', 'GUN -> AIM9');
  ok(ws.cycleWeapon() === 'MK82', 'AIM9 -> MK82');
  ok(ws.cycleWeapon() === 'BFFG', 'MK82 -> BFFG');
  ok(ws.cycleWeapon() === 'GUN', 'BFFG wraps to GUN');
  ok(ws.selectWeapon('MK82') === 'MK82', 'selectWeapon picks valid type');
  ok(ws.selectWeapon('NOPE') === 'MK82', 'selectWeapon ignores invalid type');

  const flight = makeFlight();
  ws.selectWeapon('GUN');
  const g1 = ws.fire(flight);
  ok(g1.fired === true && g1.type === 'GUN', 'GUN fires');
  ok(ws.ammo.GUN === 509, 'GUN ammo decrements', String(ws.ammo.GUN));
  ok(g1.velocity.length() > 1000, 'GUN muzzle velocity ~1030 m/s', g1.velocity.length().toFixed(0));
  ok(g1.position.z - flight.position.z < -2, 'GUN spawns at left strake gun port');
  const g2 = ws.fire(flight);
  ok(g2.fired === false, 'GUN respects fire cooldown');
  ws.update(0.08, flight, flatWorld);
  ok(ws.fire(flight).fired === true, 'GUN fires again after cooldown');
  ok(ws.ammo.GUN === 508, 'second GUN round decrements ammo');

  ws.selectWeapon('AIM9');
  const a1 = ws.fire(flight);
  ok(a1.fired === true && ws.ammo.AIM9 === 3, 'AIM9 fires and decrements');
  ok(Math.abs(a1.position.x - 4.95) < 0.01, 'first AIM9 on right wingtip', a1.position.x.toFixed(2));
  ok(ws.fire(flight).fired === false, 'AIM9 respects cooldown');
  ws.update(0.9, flight, flatWorld);
  const a2 = ws.fire(flight);
  ok(a2.fired === true && ws.ammo.AIM9 === 2, 'AIM9 fires again after cooldown');
  ok(Math.abs(a2.position.x + 4.95) < 0.01, 'second AIM9 alternates to left rail', a2.position.x.toFixed(2));

  ws.selectWeapon('MK82');
  const b1 = ws.fire(flight);
  ok(b1.fired === true && ws.ammo.MK82 === 5, 'MK82 drops and decrements');
  ok(Math.abs(b1.position.x - 2.1) < 0.01, 'first MK82 on right pylon', b1.position.x.toFixed(2));
  ok(Math.abs(b1.velocity.y - (flight.velocity.y - 2.5)) < 1e-6, 'MK82 inherits velocity + ejection');
  ws.update(0.5, flight, flatWorld);
  const b2 = ws.fire(flight);
  ok(b2.fired === true && ws.ammo.MK82 === 4, 'MK82 fires again after cooldown');
  ok(Math.abs(b2.position.x + 2.1) < 0.01, 'second MK82 alternates to left pylon', b2.position.x.toFixed(2));

  const f1 = ws.deployFlare(flight);
  ok(f1.deployed === true && ws.ammo.FLARE === 29, 'flare deployment decrements store');
  ok(ws.deployFlare(flight).deployed === false, 'flare respects 0.25 s cooldown');
  ws.update(0.3, flight, flatWorld);
  ok(ws.deployFlare(flight).deployed === true && ws.ammo.FLARE === 28, 'flare pair deploys after cooldown');
}

// --------------------------------------------- 1b. sustained GUN burst rate
{
  const ws = new WeaponSystem(null);
  const flight = makeFlight();
  let rounds = 0;
  for (let i = 0; i < 60; i++) {
    if (ws.fire(flight).fired) rounds++;
    ws.update(1 / 60, flight, flatWorld);
  }
  // ~850 RPM ≈ 14 rounds/s; allow cadence quantisation at 60 fps.
  ok(rounds >= 13 && rounds <= 16, 'GUN sustains ~850 RPM', rounds + ' rounds/s');
  ok(ws.ammo.GUN === 510 - rounds, 'GUN ammo matches rounds fired');
}

// ------------------------------------------- 2. CCIP vs actual bomb impact
{
  const ws = new WeaponSystem(null);
  ws.selectWeapon('MK82');

  // 30° dive, 250 m/s, 3000 m above flat terrain, heading north.
  const pitch = -(30 * Math.PI) / 180;
  const fwd = new THREE.Vector3(0, Math.sin(pitch), -Math.cos(pitch));
  const vel = fwd.clone().multiplyScalar(250);
  const flight = makeFlight({ pos: [0, 3000, 0], vel: [vel.x, vel.y, vel.z] });

  const ccip = ws.computeCCIP(flight, flatWorld);
  ok(ccip.valid === true, 'CCIP valid over flat terrain');
  ok(Math.abs(ccip.y) < 0.01, 'CCIP impact at sea level', ccip.y.toFixed(3));
  ok(ccip.z < flight.position.z - 1000, 'CCIP pipper well ahead of the aircraft', ccip.z.toFixed(0));
  ok(ccip.timeToImpact > 3 && ccip.timeToImpact < 18, 'CCIP time to impact sane', ccip.timeToImpact.toFixed(2));
  ok(ws.ccip === ccip, 'computeCCIP populates this.ccip');
  ok(ws.ccip.x === ccip.x && ws.ccip.z === ccip.z, 'this.ccip matches returned solution');

  const shot = ws.fire(flight);
  ok(shot.fired === true, 'MK82 releases for CCIP cross-check');

  let impact = null;
  for (let i = 0; i < 60 * 30 && !impact; i++) {
    const events = step(ws, flight, flatWorld);
    impact = events.find((e) => e.kind === 'impact' && e.weapon === 'MK82') || null;
  }
  ok(!!impact, 'dropped MK82 impacts the ground');
  if (impact) {
    const dx = impact.position.x - ccip.x;
    const dz = impact.position.z - ccip.z;
    const miss = Math.hypot(dx, dz);
    ok(miss < 12, 'MK82 lands within 12 m of CCIP pipper', miss.toFixed(2) + ' m');
    ok(impact.damage === 180 && impact.splashRadius === 75, 'MK82 damage/splash values');
    ok(impact.hitTargetId === null, 'no target id for terrain impact');
  }

  // After the drop, four pylons remain; a second pipper must still be valid.
  ok(ws.ccip.valid === true, 'CCIP keeps updating while MK82 selected');
}

// --------------------------------------- 3. AIM9 proportional navigation
{
  const ws = new WeaponSystem(null);
  ws.selectWeapon('AIM9');
  const flight = makeFlight({ pos: [0, 3000, 0], vel: [0, 0, -250] });
  const target = {
    id: 't1',
    alive: true,
    position: new THREE.Vector3(0, 3000, -1600),
    velocity: new THREE.Vector3(200, 0, 0),
    hitRadius: 6,
  };

  const shot = ws.fire(flight, target);
  ok(shot.fired === true && shot.targetId === 't1', 'AIM9 locks target id at launch');

  let hit = null;
  let trails = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 6 && !hit; i++) {
    target.position.addScaledVector(target.velocity, dt);
    const events = ws.update(dt, flight, flatWorld, [target]);
    for (const e of events) {
      if (e.kind === 'trail') trails++;
      if (e.kind === 'impact' && e.hitTargetId === 't1') hit = e;
    }
  }
  ok(!!hit, 'AIM9 intercepts moving target within 6 s');
  if (hit) {
    ok(hit.weapon === 'AIM9', 'hit event weapon is AIM9');
    ok(hit.hitTargetId === 't1', 'hit event carries target id');
    ok(hit.damage === 120 && hit.splashRadius === 32, 'AIM9 damage/splash values');
  }
  ok(trails > 5, 'AIM9 emits throttled smoke trail events', String(trails));

  // Dead / absent target: missile flies ballistic, no lock id.
  const ws2 = new WeaponSystem(null);
  ws2.selectWeapon('AIM9');
  const deadTarget = { id: 'dead', alive: false, position: new THREE.Vector3(0, 3000, -900), hitRadius: 6 };
  const noLock = ws2.fire(flight, deadTarget);
  ok(noLock.fired === true && noLock.targetId === null, 'dead target is not locked');
}

// ------------------------------------------------ 4. flares burn and expire
{
  const ws = new WeaponSystem(null);
  const flight = makeFlight({ pos: [0, 3000, 0], vel: [0, 0, -250] });
  const res = ws.deployFlare(flight);
  ok(res.deployed === true, 'flare pair deploys');
  ok(ws.flares.length === 2, 'deployFlare launches a pair', String(ws.flares.length));
  ok(ws.flares.every((f) => f.ttl > 0), 'flares start with ttl > 0');
  ok(ws.flares.some((f) => f.position.x > 0) && ws.flares.some((f) => f.position.x < 0),
    'flares straddle the airframe (±1.2 m)');
  ok(ws.flares.every((f) => f.position.y < flight.position.y), 'flares eject downward');
  ok(ws.flares.every((f) => f.position.z > flight.position.z), 'flares eject aft (+Z)');

  const dt = 1 / 60;
  let burningAt2s = 0;
  for (let i = 0; i < 60 * 2; i++) {
    ws.update(dt, flight, flatWorld);
    burningAt2s += ws.flares.filter((f) => f.burning).length;
  }
  ok(ws.flares.length === 2, 'flares still burning at 2 s');
  ok(burningAt2s > 0, 'flares remain hot IR sources mid-burn');

  for (let i = 0; i < 60 * 3.2; i++) ws.update(dt, flight, flatWorld);
  ok(ws.flares.length === 0, 'flares expire cleanly after 5 s', String(ws.flares.length));

  // Burnt-out flares keep falling but stop emitting trails.
  const ws3 = new WeaponSystem(null);
  const f2 = makeFlight({ pos: [0, 3000, 0], vel: [0, 0, -250] });
  ws3.deployFlare(f2);
  for (let i = 0; i < 60 * 6; i++) ws3.update(dt, f2, flatWorld);
  ok(ws3.flares.length === 0, 'no lingering flare objects');
}

// -------------------------------------------------------- 5. reset restores
{
  const ws = new WeaponSystem(null);
  const flight = makeFlight();
  ws.selectWeapon('GUN');
  ws.fire(flight);
  ws.update(0.08, flight, flatWorld);
  ws.fire(flight);
  ws.selectWeapon('AIM9');
  ws.fire(flight, { id: 'x', alive: true, position: new THREE.Vector3(0, 3000, -800), hitRadius: 5 });
  ws.selectWeapon('MK82');
  ws.fire(flight);
  ws.update(0.1, flight, flatWorld);
  ws.selectWeapon('BFFG');
  ws.fire(flight);
  ws.deployFlare(flight);
  ws.update(0.3, flight, flatWorld);
  ok(ws.projectiles.length > 0 && ws.flares.length > 0, 'combat state populated before reset');
  ok(ws.ammo.GUN < 510 && ws.ammo.AIM9 < 4 && ws.ammo.MK82 < 6
    && ws.ammo.BFFG < 2 && ws.ammo.FLARE < 30,
  'ammo spent before reset');

  const ret = ws.reset();
  ok(ret === ws, 'reset is chainable');
  ok(ws.projectiles.length === 0, 'reset clears projectiles');
  ok(ws.flares.length === 0, 'reset clears flares');
  ok(ws.ammo.GUN === 510 && ws.ammo.AIM9 === 4 && ws.ammo.MK82 === 6
    && ws.ammo.BFFG === 2 && ws.ammo.FLARE === 30,
  'reset restores full loadout');
  ok(ws.ccip.valid === false, 'reset invalidates CCIP');
  ok(ws.fire(flight).fired === true, 'can fire immediately after reset');
}

// ------------------------------------------------ 6. Feature 12A gun solution
{
  const ws = new WeaponSystem(null);
  ws.selectWeapon('GUN');
  const flatStrafe = strafeBurst(flatWorld, [0, 400, 0], 30, 220, 10);
  ok(flatStrafe.solved === 10, '12A: flat diving strafe solved all 10 shots');
  ok(flatStrafe.worst < 15, '12A: flat strafe rounds land within 15 m of gunSolution.impactPoint',
    flatStrafe.worst.toFixed(2) + ' m');

  const slopedWorld = { heightAt: (x, z) => Math.max(0, -z * 0.08) };
  const slopeStrafe = strafeBurst(slopedWorld, [0, 450, 0], 40, 220, 10);
  ok(slopeStrafe.solved === 10, '12A: sloped strafe solved all 10 shots');
  ok(slopeStrafe.worst < 15, '12A: sloped strafe rounds land within 15 m of impactPoint',
    slopeStrafe.worst.toFixed(2) + ' m');

  // Zero-dispersion exact parity (< 1 m)
  withDispersion(0, () => {
    const exact = strafeBurst(flatWorld, [0, 400, 0], 30, 220, 1);
    ok(exact.worst < 1.0, '12A: zero-dispersion GUN matches impactPoint within 1 m',
      exact.worst.toFixed(3) + ' m');
  });

  // Air-to-air crossing bandit lead accuracy (< 15 m)
  withDispersion(0, () => {
    const wLead = new WeaponSystem(null);
    wLead.selectWeapon('GUN');
    const own = makeFlight({ pos: [0, 2000, 0], vel: [0, 0, -220], pitch: 0 });
    const bandit = {
      id: 'mig-1', alive: true, airborne: true, hitRadius: 16,
      position: new THREE.Vector3(0, 2000, -800),
      velocity: new THREE.Vector3(200, 0, 0),
    };
    const sol = wLead.computeGunSolution(own, flatWorld, bandit);
    ok(sol.valid && sol.leadValid, '12A: lead solution valid for crossing bandit');
    ok(sol.leadPoint.x > bandit.position.x + 80, '12A: lead point leads east of crossing bandit');

    // Aim nose directly at leadPoint and fire
    const muzzle = new THREE.Vector3(-0.75, 0.25, -2.5).applyQuaternion(own.quaternion).add(own.position);
    const aimDir = new THREE.Vector3(sol.leadPoint.x, sol.leadPoint.y, sol.leadPoint.z).sub(muzzle).normalize();
    const aimedQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), aimDir);
    const aimedFlight = { ...own, quaternion: aimedQ };
    const tof = sol.tof;
    const fired = wLead.fire(aimedFlight);
    ok(fired.fired, '12A: fired aimed lead shot');
    const round = wLead.projectiles[0];
    // Step round and bandit together to tof
    const steps = Math.max(1, Math.round(tof / (1 / 60)));
    const dt = tof / steps;
    let minMiss = Infinity;
    for (let i = 0; i < steps; i++) {
      wLead.update(dt, aimedFlight, flatWorld, []);
      bandit.position.addScaledVector(bandit.velocity, dt);
      if (wLead.projectiles.length > 0) {
        minMiss = Math.min(minMiss, wLead.projectiles[0].position.distanceTo(bandit.position));
      }
    }
    ok(minMiss < 15, '12A: aimed lead round passes within 15 m of moving bandit',
      minMiss.toFixed(2) + ' m');
  });

  // boresightPoint and ccipOrigin
  const wb = new WeaponSystem(null);
  const fLevel = makeFlight({ pos: [0, 1200, 0], vel: [0, 0, -240], pitch: 0 });
  wb.selectWeapon('MK82');
  wb.update(1 / 60, fLevel, flatWorld);
  ok(wb.boresightPoint.valid && wb.boresightPoint.z < -1100, '12A: boresightPoint valid ahead of nose');
  ok(wb.ccipOrigin.valid && wb.ccipOrigin.z < -200, '12A: ccipOrigin valid along flight velocity');
}

// ------------------------------------ 7. Feature 13A high-altitude CCIP
// Deterministic hills (±~60 m) so banked diving releases cross real ridges.
function hillyWorld() {
  return {
    heightAt: (x, z) =>
      20 + 30 * Math.sin(x / 260) + 25 * Math.cos(z / 320) + 12 * Math.sin((x + z) / 150),
  };
}

// Release an Mk-82 and compare the real impact against the predicted pipper.
function mk82Drop({
  world, pos, speed, diveDeg = 0, bankDeg = 0, headingDeg = 0, maxSeconds = 45,
}) {
  const ws = new WeaponSystem(null);
  ws.selectWeapon('MK82');
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    (-diveDeg * Math.PI) / 180,
    (-headingDeg * Math.PI) / 180,
    (bankDeg * Math.PI) / 180,
    'YXZ',
  ));
  const velocity = new THREE.Vector3(0, 0, -1).applyQuaternion(q).multiplyScalar(speed);
  const flight = { position: new THREE.Vector3(...pos), velocity, quaternion: q };

  const sol = ws.computeCCIP(flight, world);
  const predicted = { x: sol.x, y: sol.y, z: sol.z, valid: sol.valid, tof: sol.timeToImpact };

  const fired = ws.fire(flight);
  ok(fired.fired === true, '13A: MK82 releases for drop check');

  let impact = null;
  let trails = 0;
  const steps = Math.ceil(maxSeconds * 60);
  for (let i = 0; i < steps && !impact; i++) {
    for (const e of ws.update(1 / 60, flight, world)) {
      if (e.kind === 'trail') trails++;
      else if (e.kind === 'impact' && e.weapon === 'MK82') impact = e;
    }
  }

  const miss = impact
    ? Math.hypot(
      impact.position.x - predicted.x,
      impact.position.y - predicted.y,
      impact.position.z - predicted.z,
    )
    : Infinity;
  return { ws, impact, predicted, miss, trails };
}

{
  const hi2200 = mk82Drop({ world: flatWorld, pos: [0, 2200, 0], speed: 250 });
  ok(hi2200.predicted.valid === true, '13A: CCIP valid for 2200 m level release');
  ok(!!hi2200.impact, '13A: 2200 m level release impacts the ground');
  ok(hi2200.miss < 2.0, '13A: 2200 m level release lands within 2 m of CCIP',
    hi2200.miss.toFixed(2) + ' m');

  const hi4500 = mk82Drop({ world: flatWorld, pos: [0, 4500, 0], speed: 260 });
  ok(hi4500.predicted.valid === true, '13A: CCIP valid for 4500 m level release');
  ok(!!hi4500.impact, '13A: 4500 m level release impacts the ground');
  ok(hi4500.miss < 2.0, '13A: 4500 m level release lands within 2 m of CCIP',
    hi4500.miss.toFixed(2) + ' m');

  const hills = hillyWorld();
  const bankRight = mk82Drop({
    world: hills, pos: [0, 2500, 0], speed: 300, diveDeg: 35, bankDeg: 45,
  });
  ok(bankRight.predicted.valid === true, '13A: CCIP valid for 45° banked dive over hills');
  ok(!!bankRight.impact, '13A: banked dive impacts hilly terrain');
  ok(bankRight.miss < 2.0, '13A: 45° right bank dive within 2 m of CCIP over hills',
    bankRight.miss.toFixed(2) + ' m');

  const bankLeft = mk82Drop({
    world: hills, pos: [400, 2600, 400], speed: 280, diveDeg: 25, bankDeg: -45, headingDeg: 120,
  });
  ok(bankLeft.predicted.valid === true, '13A: CCIP valid for opposite bank direction');
  ok(!!bankLeft.impact, '13A: opposite-bank dive impacts hilly terrain');
  ok(bankLeft.miss < 2.0, '13A: 45° left bank dive within 2 m of CCIP over hills',
    bankLeft.miss.toFixed(2) + ' m');

  ok(hi2200.trails > 5, '13A: falling Mk-82 emits trail events', String(hi2200.trails));
  ok(hi4500.trails > hi2200.trails, '13A: longer fall emits more trail events',
    hi4500.trails + ' vs ' + hi2200.trails);
}

// ------------------------ 8. Feature 21 blast data & unguided rocket descent
{
  ok(WEAPONS.MK82.damage >= 160, '21: Mk-82 damage >= 160', String(WEAPONS.MK82.damage));
  ok(WEAPONS.MK82.splashRadius >= 70, '21: Mk-82 splashRadius >= 70',
    String(WEAPONS.MK82.splashRadius));
  ok(WEAPONS.AIM9.damage >= 120, '21: AIM-9 damage >= 120', String(WEAPONS.AIM9.damage));
  ok(WEAPONS.AIM9.splashRadius >= 30, '21: AIM-9 splashRadius >= 30',
    String(WEAPONS.AIM9.splashRadius));

  // A Mk-82 impact event always carries its full blast payload.
  {
    const ws = new WeaponSystem(null);
    ws.selectWeapon('MK82');
    const flight = makeFlight({ pos: [0, 900, 0], vel: [0, 0, -220] });
    ws.fire(flight);
    let impact = null;
    for (let i = 0; i < 60 * 20 && !impact; i++) {
      const ev = ws.update(1 / 60, flight, flatWorld)
        .find((e) => e.kind === 'impact' && e.weapon === 'MK82');
      if (ev) impact = ev;
    }
    ok(!!impact, '21: Mk-82 impact event raised');
    if (impact) {
      ok(impact.kind === 'impact' && impact.weapon === 'MK82'
        && Number.isFinite(impact.position.x) && Number.isFinite(impact.position.y)
        && Number.isFinite(impact.position.z),
      '21: Mk-82 impact carries kind/weapon/finite position');
      ok(impact.hitTargetId === null, '21: Mk-82 terrain impact has null hitTargetId');
      ok(impact.damage === WEAPONS.MK82.damage
        && impact.splashRadius === WEAPONS.MK82.splashRadius,
      '21: Mk-82 impact carries damage + splashRadius');
    }
  }

  // An unlocked AIM-9 must eventually fall out of the sky instead of coasting
  // dead level forever.
  {
    const ws = new WeaponSystem(null);
    ws.selectWeapon('AIM9');
    const flight = makeFlight({ pos: [0, 500, 0], vel: [0, 0, -250] });
    const shot = ws.fire(flight, null);
    ok(shot.fired === true && shot.targetId === null, '21: stray AIM-9 launches unlocked');

    let impact = null;
    let minAlt = Infinity;
    for (let i = 0; i < 60 * 14 && !impact; i++) {
      const ev = ws.update(1 / 60, flight, flatWorld, [])
        .find((e) => e.kind === 'impact' && e.weapon === 'AIM9');
      if (ev) impact = ev;
      else if (ws.projectiles.length) minAlt = Math.min(minAlt, ws.projectiles[0].position.y);
    }
    ok(!!impact, '21: unlocked AIM-9 drops onto the terrain',
      impact ? '' : 'min altitude ' + minAlt.toFixed(1) + ' m');
    if (impact) {
      ok(impact.position.y <= 0.01, '21: stray AIM-9 impact sits on the ground',
        impact.position.y.toFixed(3));
      ok(impact.damage === 120 && impact.splashRadius === 32,
        '21: AIM-9 impact carries damage + splashRadius');
    }
  }
}

// ------------------------------------ 9. Feature 23 BFFG mega-ordnance
{
  ok(WEAPON_TYPES.includes('BFFG'), '23: WEAPON_TYPES includes BFFG');
  ok(DEFAULT_AMMO.BFFG === 2, '23: DEFAULT_AMMO.BFFG === 2', String(DEFAULT_AMMO.BFFG));
  ok(WEAPONS.BFFG.name === 'BFFG-9000 Mega-Ordnance', '23: BFFG name');
  ok(WEAPONS.BFFG.damage >= 4000, '23: BFFG damage >= 4000', String(WEAPONS.BFFG.damage));
  ok(WEAPONS.BFFG.splashRadius >= 400, '23: BFFG splashRadius >= 400',
    String(WEAPONS.BFFG.splashRadius));

  const ws = new WeaponSystem(null);
  ok(ws.selectWeapon('BFFG') === 'BFFG', '23: BFFG selectable');
  const flight = makeFlight({ pos: [0, 2500, 0], vel: [0, 0, -240] });

  // While BFFG is selected a live impact solution must drive the HUD reticle.
  ws.update(1 / 60, flight, flatWorld);
  ok(ws.ccip.valid === true, '23: BFFG live CCIP solution valid');
  ok(ws.ccip.timeToImpact > 0, '23: BFFG CCIP timeToImpact > 0',
    ws.ccip.timeToImpact.toFixed(2));
  const predicted = { x: ws.ccip.x, y: ws.ccip.y, z: ws.ccip.z };

  const shot = ws.fire(flight);
  ok(shot.fired === true && shot.type === 'BFFG', '23: BFFG fires');
  ok(ws.ammo.BFFG === 1, '23: BFFG ammo decrements', String(ws.ammo.BFFG));
  ok(ws.projectiles.length === 1 && ws.projectiles[0].type === 'BFFG',
    '23: BFFG projectile spawned');
  ok(ws.fire(flight).fired === false, '23: BFFG respects 2.5 s cooldown');

  let impact = null;
  let cyanTrails = 0;
  for (let i = 0; i < 60 * 40 && !impact; i++) {
    for (const e of ws.update(1 / 60, flight, flatWorld)) {
      if (e.kind === 'trail' && e.color === 0x66f7ff) cyanTrails++;
      else if (e.kind === 'impact' && e.weapon === 'BFFG') impact = e;
    }
  }
  ok(cyanTrails > 5, '23: BFFG emits cyan plasma trail events', String(cyanTrails));
  ok(!!impact, '23: BFFG detonates');
  if (impact) {
    ok(impact.weapon === 'BFFG' && impact.damage === 5000 && impact.splashRadius === 420,
      '23: BFFG impact carries the 5000 dmg / 420 m blast payload');
    const miss = Math.hypot(
      impact.position.x - predicted.x,
      impact.position.y - predicted.y,
      impact.position.z - predicted.z,
    );
    ok(miss < 20, '23: BFFG lands within 20 m of its live CCIP reticle (inside the 420 m blast)',
      miss.toFixed(2) + ' m');
  }
}

// --------------------- 10. Feature 23 3D building side-wall impacts
const WALL_Y = 45;
function wallWorld() {
  return {
    heightAt: () => 0,
    buildings: {
      hitBuilding(p0, p1) {
        if (p0.y >= WALL_Y && p1.y <= WALL_Y) {
          const dy = p0.y - p1.y;
          const f = dy > 1e-9 ? (p0.y - WALL_Y) / dy : 0;
          return {
            x: p0.x + (p1.x - p0.x) * f,
            y: WALL_Y,
            z: p0.z + (p1.z - p0.z) * f,
            t: f,
          };
        }
        return null;
      },
    },
  };
}

function wallShot(weapon, world) {
  const ws = new WeaponSystem(null);
  ws.selectWeapon(weapon);
  const pitch = (-45 * Math.PI) / 180;
  const flight = makeFlight({
    pos: [0, 400, 0],
    vel: [0, Math.sin(pitch) * 220, -Math.cos(pitch) * 220],
    pitch,
  });
  const fired = ws.fire(flight);
  let impact = null;
  for (let i = 0; i < 60 * 40 && !impact; i++) {
    impact = ws.update(1 / 60, flight, world)
      .find((e) => e.kind === 'impact' && e.weapon === weapon) || null;
  }
  return { ws, fired, impact };
}

for (const weapon of ['GUN', 'AIM9', 'MK82', 'BFFG']) {
  // Baseline: with no building system the same shot reaches the ground.
  const open = wallShot(weapon, flatWorld);
  ok(open.fired.fired === true, `23: ${weapon} test shot fired`);
  ok(!!open.impact && open.impact.position.y <= 0.01,
    `23: ${weapon} passes through to the ground with no buildings`,
    open.impact ? open.impact.position.y.toFixed(2) : 'no impact');
  ok(!!open.impact && open.impact.hitBuilding === undefined,
    `23: ${weapon} ground impact is not flagged as a building hit`);

  // With a standing wall the round must detonate at the facade, mid-air.
  const wall = wallShot(weapon, wallWorld());
  ok(!!wall.impact, `23: ${weapon} detonates on the building wall`);
  if (wall.impact) {
    ok(Math.abs(wall.impact.position.y - WALL_Y) < 1e-6,
      `23: ${weapon} detonates at y = 45 m, not y = 0`,
      wall.impact.position.y.toFixed(2));
    ok(wall.impact.hitBuilding === true,
      `23: ${weapon} building impact sets hitBuilding: true`);
  }
}

// ------------------------------------------------------------ summary
console.log(`weapons checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL WEAPONS CHECKS PASSED');