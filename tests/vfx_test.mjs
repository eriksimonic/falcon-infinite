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

// ------- 4c. Feature 24: BFFG mega-blast scaling & building fire puffs
{
  const vfx = new CombatVFX(null);
  const wx = weather(4, -2, 0.2);
  const zero = makeFlight({ speed: 0, onGround: true });

  const slot = vfx.spawnExplosion(new THREE.Vector3(0, 0, 0), 14);
  ok(slot.duration >= 8, '24: mega-blast lingers >= 8 s', String(slot.duration));
  ok(slot.duration === 8.5, '24: mega-blast duration is exactly 8.5 s', String(slot.duration));
  ok(slot.coreTime === 2.8 && slot.fireballTime === 2.8 && slot.ringTime === 2.2,
    '24: core/fireball burn 2.8 s and the ring expands 2.2 s',
    `${slot.coreTime}/${slot.fireballTime}/${slot.ringTime}`);

  const first = vfx.update(1 / 60, zero, wx, null);
  ok(first.activeExplosions === 1, '24: mega-blast active on the first frame');
  ok(vfx.sparks.count >= 32 && vfx.sparks.count <= 40,
    '24: mega-blast throws 32-40 high-velocity sparks', String(vfx.sparks.count));
  ok(vfx.puffs.count >= 26,
    '24: mega-blast seeds >= 26 fireball/mushroom puffs', String(vfx.puffs.count));
  ok(vfx.sparks.count + vfx.puffs.count >= 50,
    '24: mega-blast particle burst is rich (>= 50)',
    String(vfx.sparks.count + vfx.puffs.count));

  // The initial burst must mix fiery orange-gold lobes with cyan-white plasma.
  let fireLobes = 0;
  let plasmaPuffs = 0;
  for (let i = 0; i < vfx.puffs.capacity; i++) {
    if (!vfx.puffs.active[i]) continue;
    const r = vfx.puffs.col[i * 3];
    const g = vfx.puffs.col[i * 3 + 1];
    const b = vfx.puffs.col[i * 3 + 2];
    if (r > 0.85 && g > 0.4 && g < 0.75 && b < 0.15) fireLobes++;
    if (r < 0.7 && g > 0.85 && b > 0.9) plasmaPuffs++;
  }
  ok(fireLobes >= 8, '24: orange-gold fireball lobes seeded', String(fireLobes));
  ok(plasmaPuffs >= 5, '24: cyan-white plasma flash puffs seeded', String(plasmaPuffs));

  // Shockwave: scale * 24 = 336 m, still expanding at ~2 s.
  run(vfx, 2.0, zero, wx, null, 1 / 60);
  ok(slot.ring.visible && slot.ring.scale.x > 250,
    '24: mega shockwave ring expands past 250 m inside its 2.2 s life',
    slot.ring.scale.x.toFixed(1) + ' m');
  ok(slot.core.visible && slot.fireball.visible,
    '24: core and fireball still burning at ~2 s');

  // Lingering blast: still alive, still smoking past 2.4 s.
  run(vfx, 0.5, zero, wx, null, 1 / 60);
  ok(vfx.activeExplosions === 1, '24: mega-blast still active past 2.4 s',
    't=' + slot.t.toFixed(2) + 's');
  ok(slot.core.visible && slot.fireball.visible,
    '24: core and fireball visible past 2.4 s');
  ok(vfx.activeParticles >= 20, '24: mushroom column keeps smoking past 2.4 s',
    String(vfx.activeParticles));

  // ... and completes cleanly, standing every mesh down.
  run(vfx, 7, zero, wx, null, 1 / 30);
  ok(vfx.activeExplosions === 0, '24: mega-blast completes after 8.5 s');
  ok(!slot.core.visible && !slot.ring.visible && !slot.fireball.visible,
    '24: mega-blast meshes hidden after expiry');

  // Sub-mega blasts keep the exact Feature 21 timings.
  const normal = new CombatVFX(null).spawnExplosion({ x: 0, y: 0, z: 0 }, 9);
  ok(normal.duration === 5.5 && normal.coreTime === 1.8
    && normal.fireballTime === 1.8 && normal.ringTime === 1.35,
  '24: sub-mega blasts keep Feature 21 timings (5.5/1.8/1.35)',
  `${normal.duration}/${normal.coreTime}/${normal.ringTime}`);

  // -- spawnFirePuff: flame + soot pair, zero allocations, wind drift.
  const fp = new CombatVFX(null);
  const capBefore = fp.puffs.capacity;
  const lenBefore = fp.puffs.pos.length;
  const before = fp.puffs.count;
  const emitted = fp.spawnFirePuff(new THREE.Vector3(5, 10, 5), 1.2);
  ok(emitted === 2, '24: spawnFirePuff emits a flame + smoke pair', String(emitted));
  ok(fp.puffs.count === before + 2, '24: spawnFirePuff adds two puffs',
    `${before} -> ${fp.puffs.count}`);
  ok(fp.puffs.capacity === capBefore && fp.puffs.pos.length === lenBefore,
    '24: spawnFirePuff writes into the existing pool (no allocation)');

  let flameIdx = -1;
  let sootIdx = -1;
  for (let i = 0; i < fp.puffs.capacity; i++) {
    if (!fp.puffs.active[i]) continue;
    const r = fp.puffs.col[i * 3];
    const g = fp.puffs.col[i * 3 + 1];
    const b = fp.puffs.col[i * 3 + 2];
    if (r > 0.85 && g > 0.3 && g < 0.75 && b < 0.3) flameIdx = i;
    else if (r < 0.2 && g < 0.2 && b < 0.2) sootIdx = i;
  }
  ok(flameIdx >= 0, '24: fire puff has a bright flame (#ff6e1a / #ffb43a)');
  ok(sootIdx >= 0, '24: fire puff has thick dark smoke (0x1e1d1c)');
  if (flameIdx >= 0) {
    const life = fp.puffs.maxLife[flameIdx];
    ok(life >= 0.6 && life <= 1.1, '24: flame life is 0.6-1.1 s', life.toFixed(2));
    ok(fp.puffs.vy[flameIdx] > 3, '24: flame rises fast', fp.puffs.vy[flameIdx].toFixed(2));
  }
  if (sootIdx >= 0) {
    const life = fp.puffs.maxLife[sootIdx];
    ok(life >= 2.8 && life <= 4.5, '24: soot life is 2.8-4.5 s', life.toFixed(2));
    ok(fp.puffs.windF[sootIdx] > 0.5, '24: soot drifts with the wind',
      String(fp.puffs.windF[sootIdx]));
    const x0 = fp.puffs.pos[sootIdx * 3];
    fp.update(0.5, zero, weather(8, 0, 0.1), null);
    ok(fp.puffs.pos[sootIdx * 3] > x0 + 0.5, '24: soot puff drifts downwind',
      (fp.puffs.pos[sootIdx * 3] - x0).toFixed(2) + ' m');
  }

  const r = fp.update(1 / 60, zero, wx, null);
  ok(r.activeParticles >= 2, '24: fire puffs count as active particles',
    String(r.activeParticles));

  // Headless safety with hostile input.
  let threw = null;
  try {
    fp.spawnFirePuff(null);
    fp.spawnFirePuff(undefined, NaN);
    fp.spawnFirePuff({ x: NaN, y: undefined, z: 'x' }, -5);
    fp.spawnFirePuff({}, Infinity);
  } catch (err) {
    threw = err;
  }
  ok(!threw, '24: spawnFirePuff is headless-safe with hostile input', threw && threw.message);
  const finitePuffs = fp.puffs.pos.every((v) => Number.isFinite(v));
  ok(finitePuffs, '24: spawnFirePuff never writes NaN positions');
}

// --------- 4d. Feature 25: multi-lobe blasts, flash light, 3D debris
{
  const wx = weather(0, 0, 0.1);
  const zero = makeFlight({ speed: 0, onGround: true });

  // -- pool shape: everything preallocated in the constructor.
  const vfx = new CombatVFX(null);
  const kids = vfx.group.children.length;
  ok(vfx._blastLight instanceof THREE.PointLight, '25: preallocated blast PointLight');
  ok(vfx._blastLight.color.getHex() === 0xff9b42,
    '25: blast light is warm orange 0xff9b42',
    '0x' + vfx._blastLight.color.getHex().toString(16));
  ok(vfx._blastLight.decay === 1.5, '25: blast light uses 1.5 decay',
    String(vfx._blastLight.decay));
  ok(vfx._blastLight.intensity === 0, '25: blast light starts dark');
  ok(vfx.debris.mesh instanceof THREE.InstancedMesh, '25: debris pool is an InstancedMesh');
  ok(vfx.debris.capacity === 160 && vfx.debris.mesh.count === 0,
    '25: debris pool holds 160 chunks and starts empty',
    `${vfx.debris.capacity}/${vfx.debris.mesh.count}`);
  ok(vfx.debris.mesh.frustumCulled === false, '25: debris mesh is never frustum culled');
  ok(vfx.activeDebris === 0, '25: activeDebris starts at 0');

  const arrays = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'rx', 'ry', 'rz',
    'avx', 'avy', 'avz', 'sx', 'sy', 'sz', 'life', 'maxLife', 'floorY',
    'active', 'bounced'];
  ok(arrays.every((k) => vfx.debris[k] && vfx.debris[k].length === 160),
    '25: debris state lives in fixed 160-length typed arrays',
    arrays.filter((k) => !vfx.debris[k] || vfx.debris[k].length !== 160).join(','));

  // -- per-ordnance chunk counts: GUN 4, AIM9 12, MK82 22, BFFG 44.
  for (const [scale, expected] of [[1, 4], [2, 12], [4.5, 22], [14, 44]]) {
    const v = new CombatVFX(null);
    v.spawnExplosion({ x: 0, y: 0, z: 0 }, scale);
    const r = v.update(1 / 60, zero, wx, null);
    ok(r.activeDebris === expected,
      `25: scale ${scale} launches ${expected} debris chunks`,
      String(r.activeDebris));
    ok(v.debris.mesh.count === expected, `25: scale ${scale} renders every chunk`,
      String(v.debris.mesh.count));
  }

  // -- multi-lobe fireball cluster.
  const slot = vfx.spawnExplosion(new THREE.Vector3(10, 0, 20), 4.5);
  ok(slot.lobes && slot.lobes.length === 4, '25: each blast owns 4 extra fireball lobes',
    String(slot.lobes && slot.lobes.length));
  ok(slot.lobes.every((l) => l.geometry === vfx._coreGeo),
    '25: lobes share the pooled core geometry');
  ok(slot.lobes.every((l) => l.material !== slot.fireballMat),
    '25: each lobe owns its own material');
  const lobeHex = slot.lobes.map((l) => l.material.color.getHex()).join(',');
  ok(lobeHex === [0xff6e1a, 0xff4410, 0xff9926, 0x3a241a].join(','),
    '25: lobes use the fiery shade palette', lobeHex);

  const first = vfx.update(1 / 60, zero, wx, null);
  ok(first.activeDebris >= 18, '25: Mk-82 blast spawns >= 18 tumbling chunks',
    String(first.activeDebris));
  ok(slot.lobes.every((l) => l.visible), '25: all four lobes are visible while burning');
  ok(slot.lobes.some((l) => l.material.opacity > 0), '25: lobes fade in with opacity');
  const offsets = new Set(slot.lobes.map((l) => `${l.position.x.toFixed(2)},${l.position.z.toFixed(2)}`));
  ok(offsets.size === 4, '25: lobes occupy distinct radial offsets', String(offsets.size));
  ok(slot.lobes.every((l) => l.position.y >= slot.pos.y - 0.001),
    '25: lobes rise from the blast centre, never sink');
  ok(slot.lobes.every((l) => Number.isFinite(l.position.x) && Number.isFinite(l.position.z)),
    '25: lobe positions are finite');

  const lobe0 = slot.lobes[0];
  const yLow = lobe0.position.y;
  run(vfx, 0.5, zero, wx);
  ok(lobe0.position.y > yLow, '25: lobes billow upward over time',
    `${yLow.toFixed(2)} -> ${lobe0.position.y.toFixed(2)}`);
  ok(slot.lobes.some((l) => l.scale.x > 4.5), '25: lobes scale organically outward',
    slot.lobes.map((l) => l.scale.x.toFixed(1)).join('/'));

  // ... and dissolve into the smoke once the fireball phase is over.
  run(vfx, 2.4, zero, wx);
  ok(slot.lobes.every((l) => !l.visible && l.material.opacity === 0),
    '25: lobes fade out into the smoke column');
  ok(vfx.explosions.every((e) => (e.active ? e.lobes.length === 4 : e.lobes.every((l) => !l.visible))),
    '25: idle blast slots keep their lobes stood down');

  // -- dynamic blast flash.
  const fl = new CombatVFX(null);
  fl.spawnExplosion(new THREE.Vector3(5, 100, -8), 14);
  const peak = fl._blastLight.intensity;
  ok(peak === 252, '25: mega flash peak intensity is clamp(scale*18, 12, 260)',
    String(peak));
  ok(fl._blastLight.distance === 630, '25: mega flash range is clamp(scale*45, 90, 900)',
    String(fl._blastLight.distance));
  ok(fl._blastLight.position.y === 100 + 28,
    '25: flash light sits above the blast point', String(fl._blastLight.position.y));
  ok(fl._blastLight.position.x === 5 && fl._blastLight.position.z === -8,
    '25: flash light tracks the blast position');

  fl.update(0.3, zero, wx, null);
  const mid = fl._blastLight.intensity;
  ok(mid > 0 && mid < peak, '25: flash decays smoothly from its peak',
    `${peak} -> ${mid.toFixed(1)}`);
  run(fl, 1.3, zero, wx);
  ok(fl._blastLight.intensity === 0, '25: flash is fully dark within 1.4 s',
    String(fl._blastLight.intensity));

  const small = new CombatVFX(null);
  small.spawnExplosion({ x: 0, y: 0, z: 0 }, 0.5);
  ok(small._blastLight.intensity === 12, '25: even a gun hit flashes at the 12 intensity floor',
    String(small._blastLight.intensity));
  ok(small._blastLight.distance === 90, '25: gun flash range floors at 90 m',
    String(small._blastLight.distance));

  // -- ballistics: gravity, flight, tumble, matrices.
  const b = new CombatVFX(null);
  b.spawnExplosion(new THREE.Vector3(0, 40, 0), 2);
  const db = b.debris;
  const r0 = b.update(1 / 60, zero, wx, null);
  ok(r0.activeDebris === 12, '25: AIM-9 kill spawns 12 shrapnel chunks',
    String(r0.activeDebris));
  let ci = -1;
  for (let i = 0; i < db.capacity; i++) if (db.active[i]) { ci = i; break; }
  ok(ci >= 0, '25: a debris chunk is allocated');
  const x0 = db.px[ci];
  const z0 = db.pz[ci];
  const vy0 = db.vy[ci];
  const rx0 = db.rx[ci];
  b.update(0.1, zero, wx, null);
  ok(db.vy[ci] < vy0, '25: gravity decelerates launched chunks',
    `${vy0.toFixed(2)} -> ${db.vy[ci].toFixed(2)}`);
  ok(Math.abs(db.px[ci] - x0) > 1e-3 || Math.abs(db.pz[ci] - z0) > 1e-3,
    '25: chunks fly outward ballistically');
  ok(db.rx[ci] !== rx0 && Number.isFinite(db.ry[ci]),
    '25: chunks tumble in 3D');
  let finiteMatrices = true;
  for (let i = 0; i < db.mesh.count * 16; i++) {
    if (!Number.isFinite(db.mesh.instanceMatrix.array[i])) finiteMatrices = false;
  }
  ok(finiteMatrices, '25: instanced debris matrices are finite');

  // -- bounce: a chunk driven into its floor flips vy at 0.35 damping.
  db.py[ci] = db.floorY[ci] + 0.02;
  db.vy[ci] = -40;
  db.vx[ci] = 6;
  db.vz[ci] = -6;
  db.bounced[ci] = 0;
  b.update(1 / 30, zero, wx, null);
  ok(Math.abs(db.py[ci] - db.floorY[ci]) < 1e-4,
    '25: chunks never sink below their floor', String(db.py[ci]));
  ok(db.vy[ci] > 13.9 && db.vy[ci] < 14.4,
    '25: first bounce reverses vy at 0.35 damping', db.vy[ci].toFixed(3));
  ok(Math.abs(db.vx[ci] - 3.3) < 1e-6 && Math.abs(db.vz[ci] + 3.3) < 1e-6,
    '25: first bounce damps horizontal velocity to 0.55',
    `${db.vx[ci].toFixed(3)}/${db.vz[ci].toFixed(3)}`);

  // -- settle: a second contact kills vertical motion and scrubs the slide.
  db.py[ci] = db.floorY[ci] - 0.1;
  db.vy[ci] = -2;
  const vxBefore = db.vx[ci];
  b.update(1 / 60, zero, wx, null);
  ok(db.vy[ci] === 0, '25: settled chunks stop bouncing', String(db.vy[ci]));
  ok(db.py[ci] === db.floorY[ci], '25: settled chunks rest on the floor');
  ok(Math.abs(db.vx[ci]) < Math.abs(vxBefore),
    '25: settled chunks scrub their slide');

  // -- expiry: chunks die cleanly and the instance buffer empties.
  run(b, 12, zero, wx, null, 1 / 30);
  ok(b.activeDebris === 0, '25: debris expires cleanly', String(b.activeDebris));
  ok(db.mesh.count === 0 && db.active.every((a) => a === 0),
    '25: no debris instances left after expiry');

  // -- no allocation: heavy spawning must not grow the pools or the group.
  const lenBefore = db.px.length;
  for (let i = 0; i < 200; i++) b.spawnExplosion({ x: i, y: 0, z: 0 }, 14);
  b.update(1 / 60, zero, wx, null);
  ok(db.px.length === lenBefore && db.mesh.count <= 160,
    '25: debris pool stays fixed-size under heavy spawning',
    `${db.px.length}/${db.mesh.count}`);
  ok(b.group.children.length === kids, '25: debris/lobes are pooled, not created per blast',
    `${kids} -> ${b.group.children.length}`);

  // -- reset clears debris, lobes and the flash.
  const rr = new CombatVFX(null);
  const mega = rr.spawnExplosion(new THREE.Vector3(0, 20, 0), 14);
  const rf = rr.update(1 / 60, zero, wx, null);
  ok(rf.activeDebris === 44, '25: BFFG mega-blast launches 44 tumbling slabs',
    String(rf.activeDebris));
  ok(rr._blastLight.intensity > 0, '25: BFFG detonation boosts _blastLight.intensity',
    String(rr._blastLight.intensity));
  ok(rf.activeDebris === rr.debris.activeDebris && rf.activeDebris === rr.activeDebris,
    '25: activeDebris is exposed on the instance and in update() stats');

  rr.reset();
  ok(rr.activeDebris === 0 && rr.debris.activeDebris === 0,
    '25: reset zeroes activeDebris');
  ok(rr.debris.mesh.count === 0 && rr.debris.active.every((a) => a === 0),
    '25: reset empties the debris pool');
  ok(rr._blastLight.intensity === 0, '25: reset zeroes _blastLight.intensity',
    String(rr._blastLight.intensity));
  ok(rr.explosions.every((e) => e.lobes.every((l) => !l.visible && l.material.opacity === 0)),
    '25: reset hides every fireball lobe');
  ok(mega.lobes.length === 4, '25: reset keeps the lobe pools intact');

  const afterReset = rr.update(1 / 60, null, null, null);
  ok(afterReset.activeDebris === 0 && rr._blastLight.intensity === 0,
    '25: no debris or flash survives reset');
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