// Headless acceptance tests for the procedural F-16C Block 50 exterior.
// Run: node tests/f16_spec_test.mjs
//
// Verifies the published Lockheed Martin F-16C Block 50 3-view dimensions, the
// tail planform sweep direction, the cockpit/HUD clearance contract from
// cockpit.js, the required userData animation handles, and that the additive
// effects never pollute the airframe's measured bounding box or the shadow pass.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createF16, updateF16Visual } from '../src/aircraft/f16.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const DEG = Math.PI / 180;

function flightAt(over = {}) {
  return {
    aoa: 4 * DEG,
    gearPos: 1,
    throttle: 0.45,
    afterburner: false,
    controls: { pitch: 0, roll: 0, yaw: 0 },
    flapPos: 0,
    speed: 120,
    onGround: true,
    brake: false,
    ...over,
  };
}

function step(model, flight, seconds = 1, mode = 'chase', started = true, dt = 1 / 60) {
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) updateF16Visual(model, flight, dt, mode, started);
}

/** World Y of the outboard leading-edge vertex of a leading-edge flap. */
function lefTipY(lef) {
  const g = lef.mesh.geometry.attributes.position;
  let best = -1;
  let bestZ = Infinity;
  for (let i = 0; i < g.count; i++) {
    if (Math.abs(g.getX(i)) < 4.6) continue;
    if (g.getZ(i) < bestZ) {
      bestZ = g.getZ(i);
      best = i;
    }
  }
  if (best < 0) return NaN;
  lef.mesh.updateWorldMatrix(true, false);
  return new THREE.Vector3().fromBufferAttribute(g, best).applyMatrix4(lef.mesh.matrixWorld).y;
}

// ---------------------------------------------------------------------------
// 1. Headless construction and animation safety
// ---------------------------------------------------------------------------
ok(typeof document === 'undefined', 'test runs without a DOM (headless Node)');

const model = createF16();
ok(model && model.isObject3D, 'createF16() returns an Object3D');
model.updateMatrixWorld(true);

// Every camera mode / gear / burner / brake / AoA combination must not throw.
const scenarios = [
  ['chase gear down', flightAt(), 'chase'],
  ['cockpit gear down', flightAt(), 'cockpit'],
  ['chase gear up', flightAt({ gearPos: 0, onGround: false }), 'chase'],
  ['cockpit gear up', flightAt({ gearPos: 0, onGround: false }), 'cockpit'],
  ['wing view', flightAt(), 'wing'],
  ['orbit view', flightAt(), 'orbit'],
  ['afterburner', flightAt({ afterburner: true, throttle: 1, gearPos: 0, onGround: false }), 'chase'],
  ['speedbrakes', flightAt({ brake: true, gearPos: 0, onGround: false }), 'chase'],
  ['brake on ground', flightAt({ brake: true, onGround: true }), 'chase'],
  ['high AoA', flightAt({ aoa: 20 * DEG, gearPos: 1 }), 'chase'],
  ['lefDeg telemetry', flightAt({ lefDeg: 18 }), 'chase'],
  ['unstarted menu', flightAt({ gearPos: 0 }), 'chase'],
];
for (const [label, flight, mode] of scenarios) {
  let threw = null;
  try {
    updateF16Visual(model, flight, 1 / 60, mode, label !== 'unstarted menu');
  } catch (e) {
    threw = e;
  }
  ok(!threw, `updateF16Visual survives ${label}`, threw ? String(threw && threw.message) : '');
}

// Junk / partial flight telemetry must degrade gracefully.
{
  let threw = null;
  try {
    updateF16Visual(model, {}, 1 / 60, 'chase', true);
    updateF16Visual(model, { gearPos: 1, aoa: NaN, controls: null }, 1 / 60, 'chase', true);
  } catch (e) {
    threw = e;
  }
  ok(!threw, 'updateF16Visual tolerates missing/NaN telemetry', threw ? String(threw.message) : '');
}

// ---------------------------------------------------------------------------
// 2. Published 3-view dimensions (gear down, burner off)
// ---------------------------------------------------------------------------
step(model, flightAt({ gearPos: 1, afterburner: false, throttle: 0.45, onGround: true }), 1.2);
model.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(model);
const size = box.getSize(new THREE.Vector3());

ok(box.min.z > -7.95 && box.min.z < -7.80,
  'pitot tip sits at z ≈ -7.86', box.min.z.toFixed(3));
ok(box.max.z > 7.15 && box.max.z < 7.30,
  'nozzle exit sits at z ≈ +7.20 with the burner collapsed', box.max.z.toFixed(3));
ok(size.z >= 14.7 && size.z <= 15.4,
  'overall length incl. pitot is 14.7..15.4 m (15.06 target)', size.z.toFixed(3));
ok(Math.abs(size.z - 15.06) < 0.15,
  'overall length is within 15 cm of the published 15.06 m', size.z.toFixed(3));

ok(size.x >= 9.7 && size.x <= 10.2,
  'overall wingspan over the LAU-129 rails is 9.7..10.2 m (9.96 target)', size.x.toFixed(3));
ok(Math.abs(size.x - 9.96) < 0.15,
  'overall wingspan is within 15 cm of 9.96 m', size.x.toFixed(3));

ok(size.y >= 4.9 && size.y <= 5.3,
  'overall height matches 5.09 m (4.9..5.3)', size.y.toFixed(3));
ok(box.min.y >= -1.60 && box.min.y <= -1.52,
  'wheel bottoms sit at y ≈ -1.56 (CONFIG.aircraft.gearHeight = 1.58)',
  box.min.y.toFixed(3));
ok(box.max.y >= 3.45 && box.max.y <= 3.58,
  'fin tip cap reaches y ≈ +3.53', box.max.y.toFixed(3));
ok(Math.abs((box.max.y - box.min.y) - 5.09) < 0.06,
  'wheel bottom -> fin cap spans exactly 5.09 m',
  (box.max.y - box.min.y).toFixed(3));

// ---------------------------------------------------------------------------
// 3. Planform: wings, stabilators, gear track
// ---------------------------------------------------------------------------
const ud = model.userData;

{
  // Stabilator span must be the published 5.57 m (NOT the old 6.16 m).
  const stabBox = new THREE.Box3();
  stabBox.expandByObject(ud.stabPivotL);
  stabBox.expandByObject(ud.stabPivotR);
  const stabSize = stabBox.getSize(new THREE.Vector3());
  ok(stabSize.x >= 5.3 && stabSize.x <= 5.8,
    'stabilator span is 5.57 m (5.3..5.8)', stabSize.x.toFixed(3));
  ok(Math.abs(stabSize.x - 5.57) < 0.06,
    'stabilator span within 6 cm of 5.57 m', stabSize.x.toFixed(3));
  // ~10° anhedral: tips drop ~0.38 m across the 2.145 m exposed half-span.
  ok(stabSize.y > 0.3 && stabSize.y < 0.5,
    'stabilator anhedral drops the tips ~0.38 m', stabSize.y.toFixed(3));
}

for (const side of [-1, 1]) {
  const wing = model.getObjectByName(side < 0 ? 'wingL' : 'wingR');
  ok(!!wing, `wing mesh exists (${side < 0 ? 'left' : 'right'})`);
  if (!wing) continue;
  const p = wing.geometry.attributes.position;
  let rootLE = Infinity;
  let rootTE = -Infinity;
  let tipLE = Infinity;
  let tipTE = -Infinity;
  let tipX = 0;
  for (let i = 0; i < p.count; i++) {
    const x = Math.abs(p.getX(i));
    const z = p.getZ(i);
    tipX = Math.max(tipX, x);
    if (Math.abs(x - 0.85) < 1e-6) {
      rootLE = Math.min(rootLE, z);
      rootTE = Math.max(rootTE, z);
    }
    if (Math.abs(x - 4.725) < 1e-6) {
      tipLE = Math.min(tipLE, z);
      tipTE = Math.max(tipTE, z);
    }
  }
  const rootChord = rootTE - rootLE;
  const tipChord = tipTE - tipLE;
  const leSweep = (Math.atan2(tipLE - rootLE, tipX - 0.85) * 180) / Math.PI;
  const teSweep = (Math.atan2(tipTE - rootTE, tipX - 0.85) * 180) / Math.PI;

  ok(Math.abs(tipX - 4.725) < 0.01, 'bare wing tip at x = ±4.725 (9.45 m span)',
    `${(tipX * 2).toFixed(3)} m`);
  ok(rootChord > 4.1 && rootChord < 4.6, 'wing root chord ≈ 4.15..4.4 m', rootChord.toFixed(3));
  ok(Math.abs(tipChord - 1.12) < 0.12, 'wing tip chord ≈ 1.12 m', tipChord.toFixed(3));
  ok(Math.abs(leSweep - 40) < 1.5, 'wing LE sweep is 40°', leSweep.toFixed(2));
  ok(Math.abs(teSweep) < 1.0, 'wing TE is dead straight (0° sweep)', teSweep.toFixed(2));
}

{
  // Main gear track: wheel centres at x = ±1.18 -> 2.36 m.
  const wheelXs = ud.wheels.map((w) => {
    const v = new THREE.Vector3();
    w.getWorldPosition(v);
    return v.x;
  });
  const mainXs = wheelXs.filter((x) => Math.abs(x) > 0.9);
  ok(mainXs.length === 2, 'two main wheels present', String(mainXs.length));
  if (mainXs.length === 2) {
    const track = Math.abs(mainXs[0] - mainXs[1]);
    ok(track > 2.2 && track < 2.5, 'main gear track ≈ 2.36 m', track.toFixed(3));
    ok(Math.abs(track - 2.36) < 0.06, 'main gear track within 6 cm of 2.36 m', track.toFixed(3));
  }
}

// ---------------------------------------------------------------------------
// 4. Vertical tail: aft sweep on BOTH edges, 5.09 m tip
// ---------------------------------------------------------------------------
{
  const fin = model.getObjectByName('tailFin');
  ok(!!fin, 'tail fin mesh exists');
  const p = fin.geometry.attributes.position;
  let rootMinZ = Infinity;
  let rootMaxZ = -Infinity;
  let tipMinZ = Infinity;
  let tipMaxZ = -Infinity;
  let tipY = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const z = p.getZ(i);
    tipY = Math.max(tipY, y);
    if (y < 0.62) {
      rootMinZ = Math.min(rootMinZ, z);
      rootMaxZ = Math.max(rootMaxZ, z);
    }
    if (y > 3.44) {
      tipMinZ = Math.min(tipMinZ, z);
      tipMaxZ = Math.max(tipMaxZ, z);
    }
  }
  ok(tipMaxZ > rootMaxZ + 0.05,
    'fin TRAILING edge sweeps AFT (tipTE.z > rootTE.z)',
    `root=${rootMaxZ.toFixed(2)} tip=${tipMaxZ.toFixed(2)}`);
  ok(tipMinZ > rootMinZ + 1.0,
    'fin LEADING edge sweeps aft too', `root=${rootMinZ.toFixed(2)} tip=${tipMinZ.toFixed(2)}`);
  ok(tipY >= 3.45, 'fin tip reaches y >= 3.45', tipY.toFixed(3));
  ok(Math.abs(rootMaxZ - 5.95) < 0.05 && Math.abs(tipMaxZ - 6.15) < 0.05,
    'fin TE runs z = 5.95 (root) -> 6.15 (tip)',
    `${rootMaxZ.toFixed(2)}/${tipMaxZ.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 5. Cockpit / HUD clearance contract from cockpit.js
// ---------------------------------------------------------------------------
{
  const canopy = ud.canopy;
  ok(!!canopy, 'canopy mesh present');
  const p = canopy.geometry.attributes.position;
  const tops = [];
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getX(i)) < 1e-4) tops.push([p.getZ(i), p.getY(i)]);
  }
  tops.sort((a, b) => a[0] - b[0]);
  const topAt = (z) => {
    for (let i = 0; i < tops.length - 1; i++) {
      const [z0, y0] = tops[i];
      const [z1, y1] = tops[i + 1];
      if (z >= z0 && z <= z1 && z1 > z0) return y0 + ((y1 - y0) * (z - z0)) / (z1 - z0);
    }
    return null;
  };
  let minClear = Infinity;
  let worstZ = null;
  for (let z = -3.48; z <= -2.0 + 1e-9; z += 0.02) {
    const y = topAt(z);
    if (y !== null && y < minClear) {
      minClear = y;
      worstZ = z;
    }
  }
  ok(minClear >= 1.38,
    'canopy clears y >= 1.38 over z = -3.48..-2.0 (HUD at y = 1.13 / z = -3.38)',
    `min=${minClear.toFixed(3)} at z=${worstZ === null ? '?' : worstZ.toFixed(2)}`);
  ok(tops.every(([z, y]) => y <= 1.45 || z < -4.0),
    'canopy stays a low-drag teardrop (top <= 1.45 m, not a balloon)',
    `max=${Math.max(...tops.map((t) => t[1])).toFixed(3)}`);
  ok(tops[0][0] < -4.2 && tops[tops.length - 1][0] <= -0.95,
    'canopy runs from the windscreen base into the dorsal spine',
    `${tops[0][0].toFixed(2)}..${tops[tops.length - 1][0].toFixed(2)}`);

  // The fuselage must actually be cut open under the canopy (cockpit cutout).
  const fg = model.getObjectByName('fuselage').geometry;
  const fp = fg.attributes.position;
  let openFaces = 0;
  let blockedFaces = 0;
  const fi = fg.index.array;
  for (let i = 0; i < fi.length; i += 3) {
    const a = fi[i];
    const b = fi[i + 1];
    const c = fi[i + 2];
    const cy = (fp.getY(a) + fp.getY(b) + fp.getY(c)) / 3;
    const cz = (fp.getZ(a) + fp.getZ(b) + fp.getZ(c)) / 3;
    const cx = (fp.getX(a) + fp.getX(b) + fp.getX(c)) / 3;
    if (cy > 0.62 && cz > -3.68 && cz < -1.0 && Math.abs(cx) < 0.5) blockedFaces++;
    if (cy > 0.70 && cz > -3.6 && cz < -1.1 && Math.abs(cx) < 0.5) openFaces++;
  }
  ok(blockedFaces === 0, 'fuselage top is cut away over the cockpit tub', String(blockedFaces));
  ok(openFaces === 0, 'no fuselage skin above the canopy sill inside the tub', String(openFaces));
}

// ---------------------------------------------------------------------------
// 6. Required userData animation handles
// ---------------------------------------------------------------------------
const requiredKeys = [
  'gearGroup', 'noseGearPivot', 'noseDoorPivot', 'mainGearPivots', 'mainDoorPivots',
  'wheels', 'burnerGroup', 'burnerGlow', 'burnerCore', 'shockDiamonds', 'flameHolder',
  'canopy', 'glassMat', 'pilotGroup', 'navLights', 'stabPivotL', 'stabPivotR',
  'flaperons', 'leFlaps', 'rudderPivot', 'speedbrakes', 'nozzlePetals',
];
for (const key of requiredKeys) {
  ok(ud[key] !== undefined && ud[key] !== null, `userData.${key} is present`);
}
ok(Array.isArray(ud.navLights.halos) && ud.navLights.halos.length >= 2,
  'navLights.halos is populated for the aircraft-systems pulse',
  String(ud.navLights.halos.length));
ok(ud.leFlaps.length === 2, 'two leading-edge flaps are wired', String(ud.leFlaps.length));
ok(ud.flaperons.length === 2, 'two flaperons are wired', String(ud.flaperons.length));
ok(ud.speedbrakes.length === 4, 'split clam-shell speedbrakes (4 paddles)', String(ud.speedbrakes.length));
ok(ud.nozzlePetals.length === 2, 'nozzle iris rings are wired', String(ud.nozzlePetals.length));

// ---------------------------------------------------------------------------
// 7. Animation contracts: LEF, nozzle iris, gear, plume
// ---------------------------------------------------------------------------
{
  step(model, flightAt({ lefDeg: 0 }), 1.5);
  const rest = ud.leFlaps.map((l) => l.pivot.quaternion.angleTo(new THREE.Quaternion()));
  const restTip = ud.leFlaps.map((l) => lefTipY(l));
  step(model, flightAt({ lefDeg: 22, aoa: 18 * DEG }), 1.5);
  const drooped = ud.leFlaps.map((l) => l.pivot.quaternion.angleTo(new THREE.Quaternion()));
  const droopTip = ud.leFlaps.map((l) => lefTipY(l));
  ok(rest.every((a) => a < 0.02), 'LEFs rest flush at lefDeg = 0',
    rest.map((a) => a.toFixed(3)).join(','));
  ok(drooped.every((a) => a > 0.3), 'LEFs droop ~22° when lefDeg = 22',
    drooped.map((a) => a.toFixed(3)).join(','));
  ok(drooped.every((a, i) => a > rest[i] + 0.2), 'LEF deflection increases with AoA/telemetry');
  // The panel must actually move DOWN at the leading edge (hinge sign check).
  ok(droopTip.every((y, i) => y < restTip[i] - 0.1),
    'LEF leading edge deflects downward about its swept hinge',
    `rest=${restTip.map((y) => y.toFixed(3))} drooped=${droopTip.map((y) => y.toFixed(3))}`);
  ok(Math.abs(restTip[0] - 0.02) < 0.03, 'resting LEF tip sits in the wing plane',
    restTip[0].toFixed(3));

  // AoA fallback when the sim does not provide lefDeg.
  step(model, flightAt({ aoa: 0 }), 1.5);
  const clean = ud.leFlaps[0].pivot.quaternion.angleTo(new THREE.Quaternion());
  step(model, flightAt({ aoa: 16 * DEG }), 1.5);
  const high = ud.leFlaps[0].pivot.quaternion.angleTo(new THREE.Quaternion());
  ok(high > clean + 0.15, 'AoA fallback (clamp(aoa*1.2, 0, 22)) droops the LEF',
    `${clean.toFixed(3)} -> ${high.toFixed(3)}`);
}

{
  step(model, flightAt({ afterburner: false, throttle: 0.4, gearPos: 0, onGround: false }), 1);
  const dry = ud.nozzlePetals[0].scale.x;
  const dryPlume = ud.burnerGroup.scale.z;
  step(model, flightAt({ afterburner: true, throttle: 1, gearPos: 0, onGround: false }), 1);
  const wet = ud.nozzlePetals[0].scale.x;
  const wetPlume = ud.burnerGroup.scale.z;
  ok(dry < 0.95 && wet > 1.02, 'F110 nozzle constricts dry / flares in afterburner',
    `${dry.toFixed(3)} -> ${wet.toFixed(3)}`);
  ok(wetPlume > dryPlume * 5, 'afterburner plume extends aft only when lit',
    `${dryPlume.toFixed(4)} -> ${wetPlume.toFixed(3)}`);
}

{
  step(model, flightAt({ gearPos: 0, onGround: false }), 1.2);
  ok(ud.gearGroup.visible === false, 'gear group hides when fully retracted');
  step(model, flightAt({ gearPos: 1 }), 1.2);
  ok(ud.gearGroup.visible === true, 'gear group shows when extended');
  const nose = new THREE.Vector3();
  ud.noseGearPivot.getWorldPosition(nose);
  ok(Math.abs(nose.z + 3.10) < 0.05, 'nose gear is at z ≈ -3.10 under the MCID intake',
    nose.z.toFixed(3));
}

{
  step(model, flightAt({ brake: false, gearPos: 0, onGround: false }), 1);
  const closed = ud.speedbrakes[0].pivot.rotation.y;
  step(model, flightAt({ brake: true, gearPos: 0, onGround: false }), 1);
  const open = ud.speedbrakes[0].pivot.rotation.y;
  ok(Math.abs(closed) < 0.01 && Math.abs(open) > 0.4,
    'speedbrakes open only with brake && !onGround',
    `${closed.toFixed(3)} -> ${open.toFixed(3)}`);
  step(model, flightAt({ brake: true, onGround: true }), 1);
  ok(Math.abs(ud.speedbrakes[0].pivot.rotation.y) < 0.01,
    'speedbrakes stay shut on the ground');
}

// ---------------------------------------------------------------------------
// 8. Mesh budget and shadow hygiene
// ---------------------------------------------------------------------------
{
  let meshes = 0;
  let badShadow = 0;
  model.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const effect = mats.some((m) => !m || m.transparent || m.blending === THREE.AdditiveBlending);
    if (effect && o.castShadow) badShadow++;
  });
  ok(meshes <= 120, 'airframe mesh count stays within the ~120 draw-call budget', String(meshes));
  ok(badShadow === 0, 'transparent/additive meshes never cast shadows', String(badShadow));
  ok(ud.canopy.castShadow === false, 'the bubble canopy is excluded from the shadow pass');
}

// ---------------------------------------------------------------------------
// 9. Source-level contracts
// ---------------------------------------------------------------------------
{
  const src = readFileSync(fileURLToPath(new URL('../src/aircraft/f16.js', import.meta.url)), 'utf8');
  ok(!/Math\.random\s*\(/.test(src), 'f16.js is fully deterministic (no Math.random)');
  ok(/const HAS_DOM = typeof document !== 'undefined'/.test(src),
    'f16.js guards DOM access with HAS_DOM');
  ok(/export function updateF16Visual\(model, flight, dt, mode = 'chase', started = true\)/.test(src),
    'updateF16Visual keeps its exact signature');
  ok(/cz > -3\.68 && cz < -1\.00 && Math\.abs\(cx\) < 0\.59/.test(src),
    'the cockpit cutout matches cockpit.js (y > 0.62, z -3.68..-1.00, |x| < 0.59)');
  ok(/mulberry32\(/.test(src), 'procedural textures are seeded deterministically');
  for (const token of ['FS 36118', 'FS 36270', 'FS 36375', 'Compass Ghost', 'LAU-129', 'MCID']) {
    ok(src.includes(token), `f16.js documents ${token}`);
  }
}

// ---------------------------------------------------------------------------
console.log(`f16 spec checks: ${checks}, failures: ${failures.length}`);
if (failures.length) {
  console.error('\nFailed checks:');
  for (const f of failures) console.error('  ✗ ' + f);
  console.error(`\n${checks - failures.length}/${checks} passed`);
  process.exit(1);
}
console.log('ALL F-16C BLOCK 50 SPEC CHECKS PASSED');
process.exit(0);