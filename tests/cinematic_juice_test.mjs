// Headless acceptance tests for Feature 32 — cinematic bloom, flight juice,
// weapon follow-cam and photo mode.
// Run: node tests/cinematic_juice_test.mjs
//
// No WebGL, no DOM: every system must construct, update and degrade to a
// passthrough without a renderer, exactly as it does on a dedicated server.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FlightJuiceSystem } from '../src/sim/juice.js';
import { WeaponCamSystem, PhotoModeController } from '../src/aircraft/weapon_cam.js';
import { PostFXSystem } from '../src/sim/postfx.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function step(system, seconds, state, dt = 1 / 60) {
  let last = null;
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) last = system.update(dt, state);
  return last;
}

function proj(id, type, x, y, z, vx, vy, vz) {
  return {
    id,
    type,
    position: new THREE.Vector3(x, y, z),
    velocity: new THREE.Vector3(vx, vy, vz),
    dead: false,
  };
}

// ---------------------------------------------------------------------------
// 1. FlightJuiceSystem — sustained G-LOC, redout, Mach crossing, shake
// ---------------------------------------------------------------------------
{
  const juice = new FlightJuiceSystem();
  ok(juice.blackout === 0 && juice.redout === 0 && juice.gStrain === 0,
    'juice starts clean');

  const sustained = step(juice, 2, { gLoad: 8.5, mach: 0.6, speed: 250 });
  ok(sustained.blackout > 0.5, 'sustained 8.5 G builds blackout > 0.5',
    `blackout=${sustained.blackout.toFixed(3)}`);
  ok(sustained.blackout <= 1, 'blackout stays clamped to 1');
  ok(sustained.gStrain > 0.5, 'sustained 8.5 G raises gStrain',
    `gStrain=${sustained.gStrain.toFixed(3)}`);
  ok(sustained.gStrain <= 1, 'gStrain stays clamped to 1');

  // Above 7.5 G must build strictly faster than just above 5.8 G.
  const mild = new FlightJuiceSystem();
  const severe = new FlightJuiceSystem();
  const mild2s = step(mild, 1, { gLoad: 6.2 });
  const severe2s = step(severe, 1, { gLoad: 8.2 });
  ok(severe2s.blackout > mild2s.blackout, 'G above 7.5 blacks out faster',
    `6.2G=${mild2s.blackout.toFixed(3)} 8.2G=${severe2s.blackout.toFixed(3)}`);

  for (let i = 0; i < 60; i++) juice.update(1 / 60, { gLoad: 4.0 });
  const held = juice.blackout;
  ok(held > 0, 'blackout holds between 4.5 G and 5.8 G');

  const recovered = step(juice, 3, { gLoad: 1 });
  ok(recovered.blackout === 0, 'blackout recovers at 1 G',
    `blackout=${recovered.blackout}`);

  // Negative G.
  const red = new FlightJuiceSystem();
  const push = step(red, 1.5, { gLoad: -3.5 });
  ok(push.redout > 0.3, 'sustained -3.5 G builds redout > 0.3',
    `redout=${push.redout.toFixed(3)}`);
  ok(push.blackout === 0, 'negative G does not build blackout');
  const redClear = step(red, 3, { gLoad: 1 });
  ok(redClear.redout === 0, 'redout recovers at 1 G');

  const positives = step(new FlightJuiceSystem(), 1.5, { gLoad: 6.5 });
  ok(positives.redout === 0, 'positive G does not build redout');

  // Mach 1.0 crossing.
  const mach = new FlightJuiceSystem();
  const sub = mach.update(1 / 60, { gLoad: 1, mach: 0.95 });
  ok(sub.shockwaveCrossed === false && sub.machPulse === 0,
    'subsonic flight does not fire the shockwave');
  const cross = mach.update(1 / 60, { gLoad: 1, mach: 1.05 });
  ok(cross.shockwaveCrossed === true, 'crossing Mach 1.0 reports shockwaveCrossed');
  ok(cross.machPulse > 0.9, 'Mach crossing sets machPulse near 1',
    `machPulse=${cross.machPulse.toFixed(3)}`);
  ok(Math.abs(cross.shakeX) > 0 || Math.abs(cross.shakeY) > 0,
    'Mach crossing punches the camera shake');

  const again = mach.update(1 / 60, { gLoad: 1, mach: 1.05 });
  ok(again.shockwaveCrossed === false && again.machPulse > 0 && again.machPulse < 1,
    'machPulse decays after the crossing');

  // Cooldown: drop subsonic and re-cross immediately.
  mach.update(1 / 60, { gLoad: 1, mach: 0.9 });
  const cooldownCross = mach.update(1 / 60, { gLoad: 1, mach: 1.02 });
  ok(cooldownCross.shockwaveCrossed === false, 'Mach crossing respects the cooldown');

  const pulseDone = step(mach, 1.2, { gLoad: 1, mach: 1.05 });
  ok(pulseDone.machPulse === 0, 'machPulse decays to 0 over 0.8 s');

  // Re-arm after cooldown.
  step(mach, 2.0, { gLoad: 1, mach: 0.9 });
  const reCross = mach.update(1 / 60, { gLoad: 1, mach: 1.05 });
  ok(reCross.shockwaveCrossed === true, 'Mach crossing re-arms after the cooldown');

  // Shake impulses.
  const shake = new FlightJuiceSystem();
  ok(shake.addImpulse(0, 0.2) === shake && shake.impulses.length === 0,
    'zero-intensity impulse is ignored');
  shake.addImpulse(0.6, 0.2);
  ok(shake.impulses.length === 1, 'addImpulse queues one impulse');
  const hit = shake.update(0.05, { gLoad: 1, mach: 0.4 });
  ok(Math.abs(hit.shakeX) > 0 || Math.abs(hit.shakeY) > 0,
    'impulse produces non-zero shake');
  ok(Math.abs(hit.shakeRoll) > 0, 'impulse produces non-zero roll shake');

  let decayed = null;
  for (let i = 0; i < 60; i++) decayed = shake.update(1 / 60, { gLoad: 1, mach: 0.4 });
  ok(decayed.shakeX === 0 && decayed.shakeY === 0 && decayed.shakeRoll === 0,
    'shake decays fully to 0',
    `x=${decayed.shakeX} y=${decayed.shakeY} roll=${decayed.shakeRoll}`);
  ok(shake.impulses.length === 0, 'expired impulses are released');

  // Afterburner rumble: continuous, subtle, no impulses.
  const rumble = step(new FlightJuiceSystem(), 0.5,
    { gLoad: 1, mach: 0.7, speed: 300, afterburner: true });
  ok(Math.abs(rumble.shakeX) > 0, 'afterburner produces continuous rumble');
  ok(Math.abs(rumble.shakeX) < 0.1, 'afterburner rumble stays subtle',
    `shakeX=${rumble.shakeX.toFixed(4)}`);

  // reset() clears everything.
  shake.addImpulse(0.8, 0.4);
  shake.update(1 / 60, { gLoad: 8, mach: 1.1 });
  shake.reset();
  ok(shake.blackout === 0 && shake.redout === 0 && shake.machPulse === 0 &&
    shake.shakeX === 0 && shake.impulses.length === 0, 'reset clears all juice state');

  // Defensive: garbage dt/state must not throw.
  const junk = new FlightJuiceSystem().update(NaN, { gLoad: NaN, mach: NaN });
  ok(Number.isFinite(junk.blackout) && Number.isFinite(junk.shakeX),
    'invalid dt/state produce finite output');
}

// ---------------------------------------------------------------------------
// 2. WeaponCamSystem — priority, trailing camera, 2.2 s impact linger
// ---------------------------------------------------------------------------
{
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 60000);
  cam.position.set(0, 0, 0);

  const bffg = proj(7, 'BFFG', 0, 1000, -2000, 0, 0, -400);
  const aim9 = proj(3, 'AIM9', 0, 1000, -1900, 0, 0, -500);
  const weapons = { projectiles: [aim9, bffg] };

  const wc = new WeaponCamSystem();
  ok(wc.active === false, 'weapon cam starts inactive');
  ok(wc.toggle() === true && wc.active === true, 'toggle activates the weapon cam');

  const st = wc.update(1 / 60, cam, weapons, new THREE.Vector3(0, 1000, 0));
  ok(st.active === true && st.tracking === true, 'weapon cam reports tracking');
  ok(wc.trackId === 7, 'weapon cam picks BFFG over AIM9', `trackId=${wc.trackId}`);
  ok(/BFFG/.test(st.label), 'status label names the tracked ordnance', st.label);

  // Camera trails behind and above the warhead, looking down the velocity
  // vector.
  {
    const toCam = cam.position.clone().sub(bffg.position);
    const dir = bffg.velocity.clone().normalize();
    const behind = toCam.dot(dir);
    const dist = toCam.length();
    ok(behind < 0, 'camera sits behind the warhead', `along=${behind.toFixed(1)}`);
    ok(dist >= 13 && dist <= 26, 'camera trails 14-22 m back with offset',
      `dist=${dist.toFixed(1)}`);
    ok(cam.position.y > bffg.position.y, 'camera sits above the warhead');
    ok(st.altFt > 3200, 'status reports altitude in feet', `altFt=${st.altFt}`);
    ok(st.speedKts > 700, 'status reports speed in knots', `speedKts=${st.speedKts}`);
  }

  const beforeZ = cam.position.z;
  bffg.position.z -= 600;
  const moved = wc.update(1, cam, weapons, null);
  ok(moved.tracking === true, 'cam keeps tracking the moving warhead');
  ok(cam.position.z < beforeZ, 'camera follows the warhead forward');
  {
    const toCam = cam.position.clone().sub(bffg.position);
    const dist = toCam.length();
    const behind = toCam.dot(bffg.velocity.clone().normalize());
    ok(behind < 0 && dist >= 13 && dist <= 26,
      'cam still trails the warhead after it moves',
      `dist=${dist.toFixed(1)}`);
  }

  // Projectile disappears -> 2.2 s impact linger.
  const impact = bffg.position.clone();
  const vanish = wc.update(1 / 60, cam, { projectiles: [aim9] }, null);
  ok(vanish.lingering === true && vanish.tracking === false,
    'vanishing projectile enters impact linger');
  ok(wc.lingerTimer > 2.1 && wc.lingerTimer <= 2.2,
    'linger timer starts at 2.2 s', `timer=${wc.lingerTimer.toFixed(2)}`);
  ok(/BFFG/.test(vanish.label), 'linger keeps the ordnance label');

  // Pulled-back dramatic angle: ~65 m back, 28 m up.
  for (let i = 0; i < 4; i++) wc.update(0.25, cam, { projectiles: [aim9] }, null);
  {
    const rel = cam.position.clone().sub(impact);
    const dist = rel.length();
    ok(dist >= 60 && dist <= 80, 'linger camera pulls back ~65 m',
      `dist=${dist.toFixed(1)}`);
    ok(rel.y > 22 && rel.y < 34, 'linger camera sits ~28 m up',
      `y=${rel.y.toFixed(1)}`);
  }

  // Remaining linger time, then it hops to the next live round.
  let elapsed = 1.0;
  let last = null;
  for (let i = 0; i < 120 && wc.lingering; i++) {
    last = wc.update(1 / 60, cam, { projectiles: [aim9] }, null);
    elapsed += 1 / 60;
  }
  ok(elapsed > 2.1 && elapsed < 2.35, 'linger lasts ~2.2 s',
    `elapsed=${elapsed.toFixed(2)}`);
  ok(last && last.lingering === false, 'linger ends cleanly');
  ok(last && last.tracking === true && /AIM-9/.test(last.label),
    'linger switches to the next live projectile', last && last.label);

  // Empty sky after the linger: hand control back.
  {
    const solo = new WeaponCamSystem();
    solo.setActive(true);
    const p = proj(11, 'MK82', 0, 500, 0, 0, -80, -180);
    const s1 = solo.update(1 / 60, cam, { bombs: [p] }, null);
    ok(s1.tracking === true && /MK-82/.test(s1.label), 'bombs list is tracked', s1.label);
    const s2 = solo.update(1 / 60, cam, { bombs: [] }, null);
    ok(s2.lingering === true, 'empty ordnance list starts the linger');
    for (let i = 0; i < 200 && solo.lingering; i++) solo.update(1 / 60, cam, { bombs: [] }, null);
    ok(solo.lingering === false && solo.active === false,
      'weapon cam auto-deactivates when nothing is left to watch');
  }

  // getActiveOrdnance() is the preferred source.
  {
    const g = new WeaponCamSystem();
    g.setActive(true);
    const p = proj(21, 'AIM9', 0, 3000, 0, 0, 0, -600);
    const got = g.update(1 / 60, cam, { getActiveOrdnance: () => [p] }, null);
    ok(got.tracking === true && /AIM-9/.test(got.label),
      'getActiveOrdnance() is honoured', got.label);
  }

  // Priority ordering MK82 > AIM9, and inactive cam never moves the camera.
  {
    const g = new WeaponCamSystem();
    g.setActive(true);
    const bomb = proj(31, 'MK82', 0, 800, 0, 0, -60, -200);
    const missile = proj(32, 'AIM9', 0, 800, 0, 0, 0, -700);
    g.update(1 / 60, cam, { projectiles: [missile, bomb] }, null);
    ok(g.trackId === 31, 'MK82 outranks AIM9');

    const idle = new WeaponCamSystem();
    const frozen = cam.position.clone();
    const s = idle.update(1 / 60, cam, { projectiles: [bomb] }, null);
    ok(s.active === false && s.tracking === false, 'inactive cam reports idle');
    ok(cam.position.equals(frozen), 'inactive cam leaves the camera alone');
  }

  // setActive(false) clears tracking.
  wc.setActive(false);
  ok(wc.active === false && wc.trackId === null && wc.lingering === false,
    'setActive(false) clears the track');
}

// ---------------------------------------------------------------------------
// 3. PhotoModeController — enter / orbit / zoom / FOV / snapshot / exit
// ---------------------------------------------------------------------------
{
  const photo = new PhotoModeController();
  ok(photo.active === false && photo.fov === 50 && photo.dist === 28,
    'photo mode starts inactive with the default lens');

  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 60000);
  cam.position.set(0, 0, 0);

  const anchor = new THREE.Vector3(120, 2400, -80);
  photo.enter(anchor, 0, 0);
  ok(photo.active === true && photo.frozen === true, 'enter freezes the sim');
  ok(photo.target.distanceTo(anchor) < 1e-6, 'enter anchors on the aircraft');

  ok(photo.updateCamera(cam, 1) === true, 'updateCamera places the camera');
  ok(Math.abs(cam.position.distanceTo(anchor) - photo.dist) < 0.01,
    'camera sits on the orbit shell at `dist`',
    `d=${cam.position.distanceTo(anchor).toFixed(2)}`);
  ok(Math.abs(cam.fov - photo.fov) < 1e-6, 'updateCamera applies the FOV');

  const yaw0 = photo.yaw;
  const pitch0 = photo.pitch;
  photo.orbit(100, 40);
  ok(Math.abs(photo.yaw - yaw0) > 0.1, 'orbit changes yaw');
  ok(Math.abs(photo.pitch - pitch0) > 0.05, 'orbit changes pitch');
  photo.orbit(0, 100000);
  ok(photo.pitch <= 1.36, 'pitch is clamped');

  const d0 = photo.dist;
  photo.zoom(1);
  ok(photo.dist < d0, 'positive zoom pulls the camera in');
  photo.zoom(1000);
  ok(photo.dist === 8, 'zoom clamps at 8 m');
  photo.zoom(-1000);
  ok(photo.dist === 180, 'zoom clamps at 180 m');

  photo.adjustFov(15);
  ok(photo.fov === 65, 'adjustFov widens the lens');
  photo.adjustFov(1000);
  ok(photo.fov === 90, 'fov clamps at 90');
  photo.adjustFov(-1000);
  ok(photo.fov === 20, 'fov clamps at 20');
  photo.adjustFov(30);
  photo.updateCamera(cam, 1 / 60);
  ok(cam.fov === photo.fov, 'camera FOV follows the controller');

  ok(photo.captureSnapshot(null) === null, 'snapshot without a canvas is a no-op');
  ok(photo.captureSnapshot({ width: 10, height: 10 }) === null,
    'snapshot without a DOM is a no-op');

  photo.exit();
  ok(photo.active === false && photo.frozen === false, 'exit restores flight');
  ok(photo.updateCamera(cam) === false, 'updateCamera is inert after exit');

  // Re-entry reuses the previous framing.
  photo.enter(anchor);
  ok(photo.active === true, 'photo mode can re-enter');
  photo.exit();
}

// ---------------------------------------------------------------------------
// 4. PostFXSystem — headless passthrough + tuning
// ---------------------------------------------------------------------------
{
  const fx = new PostFXSystem(null, null, null, { enabled: true });
  ok(fx.supported === false, 'PostFX is unsupported without a renderer');
  ok(fx.enabled === false, 'PostFX disables itself headlessly');
  ok(fx.composer === null && fx.bloomPass === null, 'no composer is built headlessly');
  ok(fx.render(null, null) === false, 'render without a renderer returns false');

  ok(fx.setEnabled(true) === false && fx.enabled === false,
    'setEnabled(true) stays inert headlessly');
  ok(fx.setNight(true) === fx, 'setNight is chainable');
  fx.update(2);
  ok(Math.abs(fx.threshold - 0.88) < 1e-6, 'night threshold reaches 0.88',
    `threshold=${fx.threshold}`);
  ok(Math.abs(fx.strength - 0.24) < 1e-6, 'night strength reaches 0.24',
    `strength=${fx.strength}`);
  ok(Math.abs(fx.radius - 0.36) < 1e-6, 'bloom radius is 0.36');

  fx.setNight(false);
  fx.update(2);
  ok(Math.abs(fx.threshold - 1.05) < 1e-6, 'day threshold returns to 1.05');
  ok(Math.abs(fx.strength - 0.14) < 1e-6, 'day strength returns to 0.14');

  // Golden hour (sky.night ~ 0.05) must stay on the day preset, not snap.
  fx.setNight(0.05);
  fx.update(2);
  ok(Math.abs(fx.threshold - 1.0415) < 1e-3, 'golden hour keeps the day threshold',
    `threshold=${fx.threshold}`);
  ok(Math.abs(fx.strength - 0.145) < 1e-3, 'golden hour keeps the day strength',
    `strength=${fx.strength}`);
  fx.setNight(false);
  fx.update(2);

  fx.pulseBloom();
  ok(fx.bloomPulse > 0.5, 'pulseBloom spikes the pulse');
  const peak = fx.bloomPulse;
  fx.update(0.3);
  ok(fx.bloomPulse > 0 && fx.bloomPulse < peak, 'bloom pulse decays');
  fx.update(1.5);
  ok(fx.bloomPulse === 0, 'bloom pulse reaches 0');

  ok(fx.resize(1920, 1080, 2) === fx, 'resize is safe headlessly');
  ok(fx.dispose() === fx && fx.composer === null, 'dispose is safe headlessly');

  // A renderer with no GL context must fall back to plain renderer.render().
  {
    const calls = [];
    const stub = {
      render(scene, camera) {
        calls.push([scene, camera]);
      },
      getContext: () => null,
      getPixelRatio: () => 1,
      getSize: (v) => {
        v.set(640, 360);
        return v;
      },
    };
    const scene = { name: 'scene' };
    const camera = { name: 'camera' };
    const fallback = new PostFXSystem(stub, scene, camera, {});
    ok(fallback.supported === false, 'renderer without a GL context is unsupported');
    ok(fallback.render(scene, camera) === true && calls.length === 1,
      'passthrough forwards to renderer.render()');
    ok(calls[0][0] === scene && calls[0][1] === camera,
      'passthrough forwards the supplied scene and camera');

    const disabled = new PostFXSystem(stub, scene, camera, { enabled: false });
    ok(disabled.enabled === false, 'enabled:false keeps bloom off');
  }

  // Defensive: junk arguments never throw.
  const junk = new PostFXSystem(undefined, undefined, undefined, undefined);
  junk.update(NaN);
  junk.pulseBloom(NaN);
  junk.resize(NaN, NaN, NaN);
  junk.render();
  junk.dispose();
  ok(Number.isFinite(junk.threshold), 'junk arguments leave the tuning finite');
}

// ---------------------------------------------------------------------------
// 5. Source-level contract (the wiring in main.js relies on these exports)
// ---------------------------------------------------------------------------
{
  const postfx = read('../src/sim/postfx.js');
  ok(/from 'three\/examples\/jsm\/postprocessing\/EffectComposer\.js'/.test(postfx),
    'postfx imports EffectComposer');
  ok(/from 'three\/examples\/jsm\/postprocessing\/RenderPass\.js'/.test(postfx),
    'postfx imports RenderPass');
  ok(/from 'three\/examples\/jsm\/postprocessing\/UnrealBloomPass\.js'/.test(postfx),
    'postfx imports UnrealBloomPass');
  ok(/from 'three\/examples\/jsm\/postprocessing\/OutputPass\.js'/.test(postfx),
    'postfx imports OutputPass');
  ok(/threshold\s*=\s*clamp\(this\.threshold/.test(postfx),
    'postfx drives UnrealBloomPass.threshold');
  for (const fn of ['setEnabled', 'setNight', 'pulseBloom', 'update', 'resize', 'render', 'dispose']) {
    ok(new RegExp(`\\n  ${fn}\\(`).test(postfx), `postfx exports ${fn}()`);
  }

  const juiceSrc = read('../src/sim/juice.js');
  ok(/addImpulse\s*\(/.test(juiceSrc), 'juice exposes addImpulse()');
  ok(/shockwaveCrossed/.test(juiceSrc), 'juice reports shockwaveCrossed');
  ok(!/import .*'three'/.test(juiceSrc), 'juice stays dependency-free');

  const camSrc = read('../src/aircraft/weapon_cam.js');
  ok(/const LINGER_TIME = 2\.2/.test(camSrc), 'weapon cam lingers exactly 2.2 s');
  ok(/const LINGER_BACK = 65/.test(camSrc) && /const LINGER_UP = 28/.test(camSrc),
    'linger angle is ~65 m back / 28 m up');
  ok(/PRIORITY = \{ BFFG: 0, MK82: 1, AIM9: 2 \}/.test(camSrc),
    'ordnance priority is BFFG > MK82 > AIM9');
  ok(/FALCON \/ INFINITE/.test(camSrc), 'snapshot stamp carries the wordmark');
}

console.log(`cinematic juice checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL CINEMATIC JUICE CHECKS PASSED');