// Headless acceptance tests for src/sim/vfx.js.
// Run: node tests/vfx_test.mjs
//
// Verifies the CombatVFX contract with no WebGL/context: null-scene safety,
// high-G wingtip vapor, transonic Mach cone + sonic-boom edge, pooled
// explosions/plumes/trails with wind drift and expiry, and reset().
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CombatVFX } from '../src/sim/vfx.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const SRC = fileURLToPath(new URL('../src/sim/vfx.js', import.meta.url));
const source = readFileSync(SRC, 'utf8');

function weather(windX = 0, windZ = 0, coverage = 0.12, density = 0, rain = 0) {
  return { state: { windX, windZ, coverage, density, rain } };
}

function makeFlight(over = {}) {
  return {
    position: new THREE.Vector3(0, 1200, 0),
    quaternion: new THREE.Quaternion(),
    speed: 220,
    gForce: 1,
    aoa: 0,
    onGround: false,
    ...over,
  };
}

function run(vfx, seconds, flight, wx, camera = null, dt = 1 / 60) {
  let booms = 0;
  const steps = Math.max(1, Math.round(seconds / dt));
  let last = null;
  for (let i = 0; i < steps; i++) {
    last = vfx.update(dt, flight, wx, camera);
    if (last.sonicBoom) booms++;
  }
  return { booms, last };
}

// ---------------------------------------------------------------- 0. source
{
  ok(!source.includes('Math.random'), 'vfx.js uses no Math.random (seeded rng only)');
  ok(!/\bdocument\./.test(source) && !/\bwindow\./.test(source),
    'vfx.js has no DOM dependencies (headless-safe)');
}

// ------------------------------------------------------- 1. null-scene safety
{
  let threw = null;
  let v = null;
  try {
    v = new CombatVFX(null);
    const r1 = v.update(1 / 60, null, null, null);
    const r2 = v.update(0, null, null, null);
    const r3 = v.update(1 / 30, makeFlight(), weather(), { position: new THREE.Vector3() });
    for (const r of [r1, r2, r3]) {
      ok(typeof r.sonicBoom === 'boolean', 'update returns boolean sonicBoom');
      ok(Number.isFinite(r.activeParticles), 'update returns numeric activeParticles');
      ok(Number.isFinite(r.activeExplosions), 'update returns numeric activeExplosions');
      ok(Number.isFinite(r.activePlumes), 'update returns numeric activePlumes');
    }
  } catch (err) {
    threw = err;
  }
  ok(!threw, 'CombatVFX(null) initializes and updates cleanly', threw && threw.message);
  ok(v && v.vaporIntensity === 0 && v.activeParticles === 0,
    'null-scene instance starts idle');
}

// ------------------------------------------- 2. wingtip vapor at 6G / 220 m/s
{
  const vfx = new CombatVFX(null);
  const wx = weather(0, 0, 0.1);
  const flight = makeFlight({ speed: 220, gForce: 6, aoa: 0.1, onGround: false });

  run(vfx, 1.5, flight, wx);
  ok(vfx.vaporIntensity > 0.45, '6G / 220 m/s activates wingtip vapor',
    vfx.vaporIntensity.toFixed(3));
  ok(vfx.ribbons.every((r) => r.filled === 36), 'both wingtip ribbons fill 36 segments',
    vfx.ribbons.map((r) => r.filled).join('/'));
  ok(vfx.ribbons.every((r) => r.mesh.visible), 'vapor ribbon meshes are visible');
  const finite = vfx.ribbons.every((r) => {
    for (let i = 0; i < r.filled * 6; i++) if (!Number.isFinite(r.positions[i])) return false;
    return true;
  });
  ok(finite, 'ribbon geometry positions are finite');

  // Camera-facing ribbon path must also be safe and produce sane geometry.
  run(vfx, 0.2, flight, wx, { position: new THREE.Vector3(20, 1210, 60) });
  ok(vfx.ribbons.every((r) => r.mesh.visible), 'camera-facing ribbons stay visible');

  // Back to 1G: ribbons decay smoothly to zero.
  flight.gForce = 1;
  flight.aoa = 0.02;
  run(vfx, 3, flight, wx);
  ok(vfx.vaporIntensity < 0.005, 'returning to 1G decays vapor to ~0',
    vfx.vaporIntensity.toFixed(5));
  ok(vfx.ribbons.every((r) => !r.mesh.visible && r.filled === 0),
    'ribbon meshes hide once vapor decays');

  // On the ground no vapor even when the model reports load.
  const onGround = makeFlight({ speed: 220, gForce: 6, aoa: 0.1, onGround: true });
  run(vfx, 1, onGround, wx);
  ok(vfx.vaporIntensity < 0.005, 'no wingtip vapor while on the ground');
}

// ------------------------------------------- 3. Mach cone & sonic boom edge
{
  const vfx = new CombatVFX(null);
  const wx = weather();
  const flight = makeFlight({ speed: 320 }); // M 0.94

  const pre = run(vfx, 0.5, flight, wx);
  ok(pre.booms === 0, 'subsonic M0.94 does not boom');
  ok(vfx.machIntensity < 0.05, 'Mach cone is invisible below M0.95',
    vfx.machIntensity.toFixed(3));

  flight.speed = 350; // M 1.03
  const cross = run(vfx, 1 / 60, flight, wx);
  ok(cross.booms === 1 && cross.last.sonicBoom === true,
    'crossing M1.0 emits sonicBoom once');
  ok(vfx.mach.mesh.visible, 'Mach cone halo appears in the transonic band');

  const held = run(vfx, 1, flight, wx);
  ok(held.booms === 0, 'staying supersonic does not re-trigger the boom');

  // Drop below and re-cross inside the 4 s cooldown: must stay silent.
  flight.speed = 320;
  const below = run(vfx, 0.5, flight, wx);
  ok(below.booms === 0, 'dropping below M1.0 is silent');
  flight.speed = 350;
  const early = run(vfx, 1 / 60, flight, wx);
  ok(early.booms === 0, 'sonic boom respects the 4 s cooldown',
    'cooldown=' + vfx.sonicCooldown.toFixed(2));

  // Spend the cooldown subsonic, then cross again.
  flight.speed = 320;
  run(vfx, 3, flight, wx);
  ok(vfx.sonicCooldown === 0, 'cooldown reaches zero');
  flight.speed = 350;
  const again = run(vfx, 1 / 60, flight, wx);
  ok(again.booms === 1, 'boom fires again after the cooldown expires');

  // Sharp peak near M1.00.
  const peak = new CombatVFX(null);
  const pf = makeFlight({ speed: 340 });
  run(peak, 0.4, pf, wx);
  const nearOne = peak.machIntensity;
  pf.speed = 361; // M 1.062, outside the halo band
  run(peak, 0.7, pf, wx);
  ok(nearOne > 0.85, 'Mach cone peaks sharply at M1.00', nearOne.toFixed(3));
  ok(peak.machIntensity < 0.03, 'Mach cone fades beyond M1.06',
    peak.machIntensity.toFixed(3));
}

// --------------------------------- 4. explosions, plumes, trails, wind, expiry
{
  const vfx = new CombatVFX(null);
  const wx = weather(6, -2, 0.2);
  const zero = makeFlight({ speed: 0, onGround: true });

  // -- explosion populates and animates its pooled meshes
  vfx.spawnExplosion(new THREE.Vector3(10, 0, 20), 2);
  const e0 = vfx.update(1 / 60, zero, wx, null);
  ok(e0.activeExplosions === 1, 'spawnExplosion activates one explosion');
  ok(e0.activeParticles >= 12, 'explosion emits 12–18 sparks/smoke particles',
    String(e0.activeParticles));
  ok(vfx.explosions[0].core.visible && vfx.explosions[0].ring.visible,
    'explosion core flash and shockwave ring are visible');
  run(vfx, 0.12, zero, wx);
  ok(vfx.explosions[0].core.scale.x > 3, 'core flash expands rapidly',
    vfx.explosions[0].core.scale.x.toFixed(2));
  ok(vfx.explosions[0].ring.scale.x > 5, 'shockwave ring expands outward',
    vfx.explosions[0].ring.scale.x.toFixed(2));

  // -- plume emits a persistent column
  vfx.spawnSmokePlume(new THREE.Vector3(-40, 0, 10), 1.0);
  const p0 = vfx.update(1 / 60, zero, wx, null);
  ok(p0.activePlumes === 1, 'spawnSmokePlume activates a plume');
  const puffBefore = vfx.puffs.count;
  run(vfx, 0.5, zero, wx);
  ok(vfx.puffs.count > puffBefore, 'plume keeps emitting smoke puffs');

  // -- trail puffs populate the pool
  const beforeTrail = vfx.puffs.count;
  for (let i = 0; i < 5; i++) vfx.spawnTrail(new THREE.Vector3(0, 100, -i * 2), 0xff8800, 1.6);
  const withTrail = vfx.update(1 / 60, zero, wx, null);
  ok(vfx.puffs.count >= beforeTrail + 5, 'spawnTrail adds pooled puffs',
    `${beforeTrail} -> ${vfx.puffs.count}`);
  ok(withTrail.activeParticles >= 5, 'activeParticles counts trail puffs');

  // -- wind drift: isolated trail puff must move downwind
  vfx.reset();
  const windWx = weather(8, 0, 0.1);
  vfx.spawnTrail(new THREE.Vector3(0, 100, 0), 0xff8800, 1.6);
  vfx.update(1 / 60, zero, windWx, null);
  let idx = -1;
  for (let i = 0; i < vfx.puffs.capacity; i++) {
    if (vfx.puffs.active[i]) { idx = i; break; }
  }
  ok(idx >= 0, 'trail puff found in pool');
  ok(vfx.puffs.colAttr.version > 0, 'trail colour attribute is flagged for upload');
  ok(vfx.puffs.col[idx * 3] > 0.95 && vfx.puffs.col[idx * 3 + 1] > 0.4
    && vfx.puffs.col[idx * 3 + 1] < 0.7 && vfx.puffs.col[idx * 3 + 2] < 0.1,
  'spawnTrail applies the requested colour');
  const x0 = vfx.puffs.pos[idx * 3];
  const y0 = vfx.puffs.pos[idx * 3 + 1];
  vfx.update(0.5, zero, windWx, null);
  ok(vfx.puffs.pos[idx * 3] > x0 + 1, 'smoke drifts with wind (X)',
    (vfx.puffs.pos[idx * 3] - x0).toFixed(2) + ' m');
  ok(vfx.puffs.pos[idx * 3 + 1] > y0 + 0.02, 'smoke rises buoyantly');

  // -- pooled: heavy spawning must never grow storage
  const cap = vfx.puffs.capacity;
  const len = vfx.puffs.pos.length;
  const children = vfx.group.children.length;
  for (let i = 0; i < 5000; i++) vfx.spawnTrail(new THREE.Vector3(i, 10, 0));
  for (let i = 0; i < 200; i++) vfx.spawnExplosion(new THREE.Vector3(i, 0, 0), 1);
  vfx.update(1 / 60, zero, wx, null);
  ok(vfx.puffs.pos.length === len && vfx.puffs.capacity === cap,
    'particle storage is fixed-size (no allocation on spawn)');
  ok(vfx.group.children.length === children,
    'spawning allocates no new meshes (pooled)', `${children} -> ${vfx.group.children.length}`);
  ok(vfx.puffs.count <= cap, 'puff count never exceeds capacity');
  ok(vfx.explosions.length === 12, 'explosion pool is fixed at 12 meshes',
    String(vfx.explosions.length));
  ok(vfx.activeExplosions === 12, 'explosion slots recycle when saturated');

  // -- everything expires and returns to zero without leaked slots
  vfx.reset();
  vfx.spawnExplosion(new THREE.Vector3(300, 0, 0), 1.5);
  vfx.spawnSmokePlume(new THREE.Vector3(320, 0, 0), 0.5);
  for (let i = 0; i < 6; i++) vfx.spawnTrail(new THREE.Vector3(300, 5, i), 0xe8eef2, 1.4);
  run(vfx, 14, zero, wx, null, 1 / 30);
  ok(vfx.activeExplosions === 0, 'explosions expire');
  ok(vfx.activePlumes === 0, 'plumes expire after their duration');
  ok(vfx.activeParticles === 0, 'all particles expire', String(vfx.activeParticles));
  ok(vfx.puffs.count === 0 && vfx.sparks.count === 0, 'pool counters return to zero');

  // -- muzzle flash lifetime
  const mf = new CombatVFX(null);
  const mflight = makeFlight();
  mf.triggerMuzzleFlash(mflight);
  ok(mf.muzzleTimer > 0 && mf.muzzle.mesh.visible, 'muzzle flash triggers at the gun port');
  mf.update(1 / 60, mflight, wx, null);
  ok(mf.muzzle.mesh.visible, 'muzzle flash survives one frame');
  mf.update(0.1, mflight, wx, null);
  ok(mf.muzzleTimer === 0 && !mf.muzzle.mesh.visible, 'muzzle flash ends after ~0.06 s');
}

// ------------------------- 4b. Feature 21 multi-stage blast visibility
{
  const vfx = new CombatVFX(null);
  const wx = weather(0, 0, 0.1);
  const zero = makeFlight({ speed: 0, onGround: true });
  const slot = vfx.spawnExplosion(new THREE.Vector3(0, 0, 0), 4.5);

  ok(slot.duration === 5.5, '21: explosion lingers 5.5 s', String(slot.duration));
  ok(!!slot.fireball && !!slot.fireballMat, '21: pooled fireball shell exists');
  ok(slot.fireballMat.blending === THREE.NormalBlending,
    '21: fireball uses normal blending (daylight-visible)');
  ok(slot.fireballMat.color.getHex() === 0xff5a18, '21: fireball is orange-red 0xff5a18',
    '0x' + slot.fireballMat.color.getHex().toString(16));
  ok(slot.coreMat.color.getHex() === 0xfff0b8,
    '21: incandescent core stays white-yellow 0xfff0b8');

  const first = vfx.update(1 / 60, zero, wx, null);
  ok(vfx.sparks.count >= 20 && vfx.sparks.count <= 28,
    '21: detonation throws 20–28 hot sparks', String(vfx.sparks.count));
  ok(vfx.puffs.count >= 14, '21: detonation bursts 14 smoke puffs',
    String(vfx.puffs.count));
  ok(first.activeExplosions === 1, '21: explosion active on the first frame');

  // Shockwave ring reaches a very large radius inside its 1.35 s life.
  run(vfx, 0.6, zero, wx, null, 1 / 120);
  ok(slot.ring.visible && slot.ring.scale.x > 4.5 * 10,
    '21: shockwave ring expands past 45 m', slot.ring.scale.x.toFixed(1) + ' m');
  ok(slot.fireball.visible, '21: fireball still burning at 0.6 s');

  // Past 1.2 s the blast must still be a big, particle-rich event.
  const mid = run(vfx, 0.7, zero, wx, null, 1 / 60);
  ok(mid.last.activeExplosions >= 1, '21: blast still active past 1.2 s',
    't=' + slot.t.toFixed(2) + 's');
  ok(mid.last.activeParticles >= 25, '21: >= 25 smoke/spark particles past 1.2 s',
    String(mid.last.activeParticles));
  ok(slot.fireball.visible && slot.fireball.scale.x > 4.5 * 8,
    '21: fireball expands to ~50 m for a Mk-82', slot.fireball.scale.x.toFixed(1) + ' m');
  ok(slot.core.visible, '21: incandescent core keeps glowing at ~1.3 s');

  // Lingering smoke column: the blast is not gone at 3 s either.
  const late = run(vfx, 2.2, zero, wx, null, 1 / 60);
  ok(late.last.activeExplosions === 1, '21: explosion lingers past 3 s');
  ok(late.last.activeParticles >= 10, '21: mushroom column keeps smoking past 3 s',
    String(late.last.activeParticles));

  // ... and it completes cleanly at duration, with all meshes stood down.
  run(vfx, 3, zero, wx, null, 1 / 60);
  ok(vfx.activeExplosions === 0, '21: explosion completes after its duration');
  ok(!slot.core.visible && !slot.ring.visible && !slot.fireball.visible,
    '21: all explosion meshes hidden after expiry');
  ok(slot.fireballMat.opacity === 0 && slot.coreMat.opacity === 0 && slot.ringMat.opacity === 0,
    '21: all explosion opacities zeroed after expiry');

  // No per-frame allocation: the fireball is part of the fixed pool.
  ok(vfx.explosions.length === 12 && vfx.group.children.length > 0,
    '21: fireball is pooled, not created per blast');
}

// --------------------------------------------------------------- 5. reset()
{
  const vfx = new CombatVFX(null);
  const wx = weather(4, 4, 0.5, 0.3, 0.2);
  const flight = makeFlight({ speed: 350, gForce: 7, aoa: 0.2 });

  run(vfx, 1, flight, wx);
  ok(vfx.vaporIntensity > 0.1 && vfx.machIntensity > 0, 'effects active before reset');
  vfx.spawnExplosion(new THREE.Vector3(1, 0, 2), 1);
  vfx.spawnSmokePlume(new THREE.Vector3(3, 0, 4), 60);
  for (let i = 0; i < 10; i++) vfx.spawnTrail(new THREE.Vector3(0, 50, 0));
  vfx.triggerMuzzleFlash(flight);
  const before = vfx.update(1 / 60, flight, wx, null);
  ok(before.activeParticles > 0 && before.activeExplosions === 1 && before.activePlumes === 1,
    'all pools populated before reset');

  vfx.reset();
  ok(vfx.vaporIntensity === 0, 'reset clears vapor ribbons');
  ok(vfx.machIntensity === 0 && !vfx.mach.mesh.visible, 'reset hides the Mach cone');
  ok(vfx.ribbons.every((r) => r.filled === 0 && !r.mesh.visible), 'reset clears ribbon history');
  ok(vfx.explosions.every((e) => !e.active && !e.core.visible && !e.ring.visible),
    'reset clears explosions');
  ok(vfx.plumes.every((p) => !p.active), 'reset clears plumes');
  ok(vfx.puffs.count === 0 && vfx.sparks.count === 0, 'reset clears particle pools');
  ok(vfx.muzzleTimer === 0 && !vfx.muzzle.mesh.visible, 'reset clears the muzzle flash');
  ok(vfx.sonicCooldown === 0 && vfx._wasSupersonic === false, 'reset clears boom state');

  const after = vfx.update(1 / 60, null, null, null);
  ok(after.activeParticles === 0 && after.activeExplosions === 0 && after.activePlumes === 0,
    'update after reset stays empty');

  // Re-arms: a fresh supersonic crossing booms again after reset.
  const f2 = makeFlight({ speed: 320 });
  vfx.update(1 / 60, f2, wx, null);
  f2.speed = 350;
  const re = vfx.update(1 / 60, f2, wx, null);
  ok(re.sonicBoom === true, 'reset re-arms the sonic boom');
}

console.log(`vfx checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL VFX CHECKS PASSED');