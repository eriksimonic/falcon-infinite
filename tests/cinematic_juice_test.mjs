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
import { WeaponCamSystem, PhotoModeController, FreeCamController } from '../src/aircraft/weapon_cam.js';
import { InspectorMap, camYawToHeadingDeg } from '../src/ui/inspector_map.js';
import { PostFXSystem } from '../src/sim/postfx.js';
import { FlightModel } from '../src/aircraft/flight.js';

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
  ok(Math.abs(fx.threshold - 0.94) < 1e-6, 'night threshold reaches 0.94',
    `threshold=${fx.threshold}`);
  ok(Math.abs(fx.strength - 0.19) < 1e-6, 'night strength reaches 0.19',
    `strength=${fx.strength}`);
  ok(Math.abs(fx.radius - 0.26) < 1e-6, 'bloom radius is a tight 0.26');

  fx.setNight(false);
  fx.update(2);
  ok(Math.abs(fx.threshold - 1.05) < 1e-6, 'day threshold returns to 1.05');
  ok(Math.abs(fx.strength - 0.14) < 1e-6, 'day strength returns to 0.14');

  // Golden hour (sky.night ~ 0.05) must stay on the day preset, not snap.
  fx.setNight(0.05);
  fx.update(2);
  ok(Math.abs(fx.threshold - 1.0445) < 1e-3, 'golden hour keeps the day threshold',
    `threshold=${fx.threshold}`);
  ok(Math.abs(fx.strength - 0.1425) < 1e-3, 'golden hour keeps the day strength',
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

// ---------------------------------------------------------------------------
// 6. FreeCamController & InspectorMap — headless motion, speed, ground clamp,
//    teleport & map coordinate round-trip
// ---------------------------------------------------------------------------
{
  const fc = new FreeCamController();
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 60000);
  ok(fc.active === false, 'free cam starts inactive');

  fc.enter(new THREE.Vector3(0, 200, 0), 0, 0);
  ok(fc.active === true, 'free cam enters cleanly');
  fc.update(0.1, cam, { forward: 1 }, () => 100);
  ok(fc.position.z < -20 && Math.abs(cam.position.z - fc.position.z) < 1e-6,
    'W moves free cam forward along -Z');

  // Ground clearance clamp prevents clipping below terrain + 2 m.
  fc.teleport(50, 50, 50, 0, 0);
  fc.update(0.1, cam, { up: -1 }, () => 120);
  ok(fc.position.y >= 121.99, `free cam clipped below terrain (${fc.position.y})`);

  // Speed wheel clamps between 15 and 5000 m/s.
  fc.adjustSpeed(100);
  ok(fc.speed === 5000, `max speed clamp failed (${fc.speed})`);
  fc.adjustSpeed(-100);
  ok(fc.speed === 15, `min speed clamp failed (${fc.speed})`);

  fc.exit();
  ok(fc.active === false, 'free cam exits cleanly');

  // InspectorMap world <-> canvas coordinate round-trip (headless-safe).
  const imap = new InspectorMap();
  const cPt = imap.worldToCanvas(-18201, -10035, 840, 620);
  const wPt = imap.canvasToWorld(cPt.px, cPt.py, 840, 620);
  ok(Math.abs(wPt.x - (-18201)) < 1e-4 && Math.abs(wPt.z - (-10035)) < 1e-4,
    'InspectorMap world <-> canvas coordinate round-trip failed');
}

// ---------------------------------------------------------------------------
// 7. Last-view persistence — Free Cam pose survives a browser reload
// ---------------------------------------------------------------------------
{
  // main.js owns the browser bootstrap, so its contract is asserted statically
  // (it cannot be imported headlessly: it pulls CSS and builds a WebGL context).
  const mainSrc = read('../src/main.js');
  ok(/const LAST_VIEW_KEY = 'falcon\.lastView\.v1'/.test(mainSrc),
    'last view persists under falcon.lastView.v1');
  ok(/\n  _saveLastView\(\) \{/.test(mainSrc), 'main defines _saveLastView()');
  ok(/\n  _loadLastView\(\) \{/.test(mainSrc), 'main defines _loadLastView()');
  ok(/localStorage\.setItem\(\s*LAST_VIEW_KEY/.test(mainSrc),
    '_saveLastView writes the localStorage slot');
  ok(/typeof window !== 'undefined'[\s\S]{0,200}beforeunload[\s\S]{0,200}pagehide/.test(mainSrc),
    'beforeunload + pagehide flush the view (window-guarded)');

  // Both storage paths must sit inside try/catch, so private mode never throws.
  for (const fn of ['_saveLastView', '_loadLastView']) {
    const body = mainSrc.slice(mainSrc.indexOf(fn + '() {'));
    // Flight snapshots made _saveLastView longer; keep enough of the body to
    // see the localStorage write and its catch.
    const head = body.slice(0, fn === '_saveLastView' ? 3200 : 700);
    ok(/try \{/.test(head) && /\} catch/.test(head),
      `${fn}() wraps localStorage in try/catch`);
  }

  // The record carries pose, speed and the full environment.
  for (const field of ['active', 'x', 'y', 'z', 'yaw', 'pitch', 'speed', 'theater', 'hour', 'weather', 'quality']) {
    ok(new RegExp(`\\n\\s+${field}:`).test(mainSrc), `saved view carries ${field}`);
  }

  // Autosave triggers: free cam loop, enter/exit, teleport, map, quality, boot.
  const saveCalls = (mainSrc.match(/this\._saveLastView\(\)/g) || []).length;
  ok(saveCalls >= 9, `_saveLastView() is wired to every trigger (${saveCalls} call sites)`);
  ok(/this\._lastViewTimer = 0\.5;\s*\n\s*this\._saveLastView\(\)/.test(mainSrc),
    'free cam autosaves on a 0.5 s throttle');

  // Boot restores the pose without stealing a pointer lock (needs a gesture).
  ok(/await this\._restoreLastView\(\);/.test(mainSrc),
    'boot() awaits the last-view restore after the menu is ready');
  const restore = mainSrc.slice(mainSrc.indexOf('_restoreLastView() {'));
  const restoreBody = restore.slice(0, restore.indexOf('\n  /** F5:'));
  ok(!/requestPointerLock/.test(restoreBody),
    'restore never calls requestPointerLock()');
  ok(/this\.time\.setHour\(saved\.hour\)/.test(restoreBody),
    'restore applies the hour exactly like the Inspector Map');
  ok(/this\.weather\.setPreset\(saved\.weather, true\)/.test(restoreBody),
    'restore applies the weather exactly like the Inspector Map');
  ok(/this\._freeCamReturnMode = 'menu'/.test(restoreBody),
    'restored free cam returns to the menu on exit');
  ok(/RESTORED LAST POSITION/.test(restoreBody), 'restore toasts the user');

  // --- Flight restore (reload while in flight) -----------------------------
  // The record is tagged by kind so a live jet, the Free Cam and a clean menu
  // start never get confused with each other.
  ok(/kind = 'freecam'/.test(mainSrc), "saving tags the spectator camera as kind 'freecam'");
  ok(/kind = 'flight'/.test(mainSrc), "saving tags a live jet as kind 'flight'");
  ok(/kind = 'none'/.test(mainSrc) && /active: kind !== 'none'/.test(mainSrc),
    "anything else saves as kind 'none' with active:false");
  ok(/\(this\.mode === 'fly' \|\| this\.mode === 'pause'\) && f && !f\.crashed && !this\.ejection\?\.active/.test(mainSrc),
    "kind 'flight' requires a live, non-crashed, non-ejecting jet (paused too)");

  // ESC → pause() drops the pointer lock so the player can click Reload, so a
  // paused jet must still save as a flight AND be flushed at the moment of pause.
  const pauseBody = mainSrc.slice(mainSrc.indexOf('\n  pause() {'));
  const pauseHead = pauseBody.slice(0, 700);
  ok(/this\.mode = 'pause';[\s\S]{0,300}this\._saveLastView\(\)/.test(pauseHead),
    'pause() flushes the view immediately (reload after ESC keeps the flight)');

  // A reload mid-boot must never wipe a record _restoreLastView() has not read.
  ok(/if \(this\._restoringLastView \|\| !this\.ready \|\| this\.mode === 'boot'\) return;/.test(mainSrc),
    '_saveLastView() bails out while booting or restoring');

  // Tab switch / mobile backgrounding flushes the pose too.
  ok(/visibilitychange[\s\S]{0,160}document\.visibilityState === 'hidden'[\s\S]{0,120}this\._saveLastView\(\)/.test(mainSrc),
    'visibilitychange flushes the view when the tab is hidden');

  // Airframe snapshot: position, attitude, velocity, rates, controls, camera.
  for (const field of [
    'px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw', 'vx', 'vy', 'vz', 'rx', 'ry', 'rz',
    'throttle', 'targetThrottle', 'gearDown', 'gearPos', 'gearTarget',
    'flapsIndex', 'flapPos', 'brake', 'onGround', 'afterburner', 'cameraMode', 'mission',
  ]) {
    ok(new RegExp(`[\\s,{]${field}:`).test(mainSrc), `saved flight snapshot carries ${field}`);
  }
  ok(/cameraMode: this\.aircraft\.mode \|\| 'cockpit'/.test(mainSrc),
    'snapshot stores the active camera mode');

  // Flight autosave + event-driven flushes.
  const timerSaves = (mainSrc.match(
    /this\._lastViewTimer = 0\.5;\s*\n\s*this\._saveLastView\(\)/g,
  ) || []).length;
  ok(timerSaves >= 2, `flight and free cam both autosave on a 0.5 s throttle (${timerSaves})`);
  ok(/onCrash\(\) \{[\s\S]{0,800}this\._saveLastView\(\)/.test(mainSrc),
    'a crash flushes the view so it cannot reload into the crash');
  ok(/returnToMenu\(\)[\s\S]{0,1600}this\._saveLastView\(\)/.test(mainSrc),
    'returning to the menu flushes a clean menu record');
  ok(/'VIEW · ' \+ m\.toUpperCase\(\)\);\s*\n\s*this\._saveLastView\(\)/.test(mainSrc),
    'a camera view switch flushes the view');

  // Restore branch.
  ok(/saved\.kind === 'flight' && !!saved\.flight/.test(restoreBody),
    'restore branches on kind flight');
  for (const field of ['px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw', 'vx', 'vy', 'vz']) {
    ok(new RegExp(`'${field}'`).test(restoreBody), `flight restore validates ${field}`);
  }
  ok(/Math\.hypot\(fl\.qx, fl\.qy, fl\.qz, fl\.qw\)/.test(restoreBody),
    'flight restore guards against a zero-length quaternion');
  ok(/f\.position\.set\(fl\.px, safeY, fl\.pz\)/.test(restoreBody),
    'flight restore reapplies the saved position at a safe altitude');
  ok(/fl\.onGround[\s\S]{0,120}ground \+ 1\.8[\s\S]{0,120}ground \+ 12/.test(restoreBody),
    'grounded restores clear the gear, airborne restores clear the ridge');
  ok(/f\.quaternion\.set\(fl\.qx \/ qLen/.test(restoreBody),
    'flight restore reapplies the normalised attitude');
  ok(/f\.velocity\.set\(fl\.vx, fl\.vy, fl\.vz\)/.test(restoreBody) &&
    /f\.rates\.set\(fl\.rx, fl\.ry, fl\.rz\)/.test(restoreBody),
    'flight restore reapplies velocity and body rates');
  ok(/f\.speed = f\.velocity\.length\(\)/.test(restoreBody),
    'flight restore recomputes speed from the velocity vector');
  ok(/f\.onGround = !!fl\.onGround;[\s\S]{0,220}f\._lastOnGround = f\.onGround;/.test(restoreBody),
    'flight restore syncs _lastOnGround so an airborne restore is not a landing');
  ok(/this\.ui\.applySettings\?\.\(\{ mission: this\.ui\.mission \}\)/.test(restoreBody),
    'flight restore syncs the menu mission pill');
  ok(/this\.aircraft\.setMode\(camModes\.includes\(fl\.cameraMode\)/.test(restoreBody),
    'flight restore reapplies the camera mode');
  ok(/this\._syncAircraftModel\(\)/.test(restoreBody) &&
    /this\.aircraft\._updateCamera\(0, this\.input, true\)/.test(restoreBody),
    'flight restore syncs the model and camera immediately');
  ok(/startFlight\(\{\s*\n\s*restore: true/.test(restoreBody),
    'flight restore enters flight through startFlight() in restore mode');
  ok(/this\.mode = 'fly'/.test(restoreBody),
    'flight restore leaves the app in fly mode');
  ok(!/requestPointerLock/.test(restoreBody),
    'flight restore never steals a pointer lock inside boot()');
  ok(/RESTORED LAST FLIGHT · CLICK TO CONTROL · ESC PAUSE/.test(restoreBody),
    'flight restore toasts the restore contract');

  // startFlight() honours restore mode: no pointer lock, no theater reload.
  const startFlight = mainSrc.slice(mainSrc.indexOf('async startFlight('));
  const startBody = startFlight.slice(0, startFlight.indexOf("\n  pause()"));
  ok(/if \(!restore\) this\.input\.requestPointerLock\(\)/.test(startBody),
    'restore-mode startFlight skips the pointer lock request');
  ok(/if \(!\(restore && this\._activeTheater ===/.test(startBody),
    'restore-mode startFlight keeps the environment already applied');

  // Solkan quick-jump follows the recentered stone arch bridge.
  ok(/'SOLKAN BRIDGE & GORGE', x: -18325/.test(mainSrc),
    'quick-jump 3 sits at the recentered Solkan bridge');
}

// ---------------------------------------------------------------------------
// 8. Sticky menu settings — quality / theater / mission / weather / wind / hour
//    survive a page reload (falcon.settings.v1)
// ---------------------------------------------------------------------------
{
  const mainSrc = read('../src/main.js');
  const menuSrc = read('../src/ui/menu.js');

  ok(/const SETTINGS_KEY = 'falcon\.settings\.v1'/.test(mainSrc),
    'settings persist under falcon.settings.v1');
  ok(/\n  _loadSettings\(\) \{/.test(mainSrc), 'main defines _loadSettings()');
  ok(/\n  _saveSettings\(\) \{/.test(mainSrc), 'main defines _saveSettings()');

  // Both storage paths must be storage-proof: private mode, quota errors and
  // headless imports may never throw out of a menu click or the boot path.
  for (const fn of ['_loadSettings', '_saveSettings']) {
    const body = mainSrc.slice(mainSrc.indexOf(fn + '() {'));
    const head = body.slice(0, 1200);
    ok(/try \{/.test(head) && /\} catch/.test(head),
      `${fn}() wraps localStorage in try/catch`);
    ok(/localStorage\.(get|set)Item\(\s*SETTINGS_KEY/.test(head),
      `${fn}() touches the SETTINGS_KEY slot`);
  }

  // Every stored field is validated against the preset tables on read.
  const loadBody = mainSrc.slice(mainSrc.indexOf('_loadSettings() {'));
  const loadHead = loadBody.slice(0, loadBody.indexOf('\n  }'));
  for (const key of ['QUALITY', 'THEATERS', 'MISSIONS', 'WEATHER', 'WIND']) {
    ok(new RegExp(`if \\(${key}\\[saved\\.`).test(loadHead),
      `_loadSettings() validates against ${key}`);
  }
  ok(/Number\.isFinite\(saved\.hour\) && saved\.hour >= 0 && saved\.hour <= 24/.test(loadHead),
    '_loadSettings() clamps the saved hour to 0..24');

  // Quality is picked before the renderer, world and PostFX are built so a
  // reload on `high` really boots with 2048² shadows and 18000 trees.
  const loadIdx = mainSrc.indexOf('const savedSettings = this._loadSettings();');
  const presetIdx = mainSrc.indexOf(
    'this.preset = (savedSettings.quality && QUALITY[savedSettings.quality]) || QUALITY.medium;',
  );
  const rendererIdx = mainSrc.indexOf('new THREE.WebGLRenderer');
  ok(loadIdx > 0 && presetIdx > loadIdx && rendererIdx > presetIdx,
    'this.preset initialises from savedSettings.quality before new THREE.WebGLRenderer');

  ok(/this\.sky\.setShadowQuality\?\.\(this\.preset\.name\);/.test(mainSrc),
    'startup applies the preset shadow quality to the sky');

  // Pills are painted before the time / weather systems read this.ui.
  const applyIdx = mainSrc.indexOf('this.ui.applySettings(savedSettings);');
  const timeIdx = mainSrc.indexOf('this.time.setHour(this.ui.hour);');
  ok(applyIdx > 0 && timeIdx > applyIdx,
    'saved pills are applied before the time/weather systems start');

  // Menu picks are persisted (all six groups).
  for (const cb of ['onMission', 'onTheater', 'onWeather', 'onWind', 'onQuality', 'onTime']) {
    const at = mainSrc.indexOf(cb + ':');
    ok(at > 0 && /this\._saveSettings\(\)/.test(mainSrc.slice(at, at + 320)),
      `${cb} persists the sticky settings`);
  }

  // setQuality keeps the pill, the settings slot and the view slot in sync.
  const qualityFn = mainSrc.slice(mainSrc.indexOf('setQuality(name) {'));
  const qualityHead = qualityFn.slice(0, qualityFn.indexOf('\n  }'));
  ok(/this\.ui\?\.applySettings\?\.\(\{ quality: name \}\)/.test(qualityHead),
    'setQuality repaints the quality pill');
  ok(/this\._saveSettings\(\)/.test(qualityHead),
    'setQuality persists settings via _saveSettings()');
  ok(/this\._saveLastView\(\)/.test(qualityHead),
    'setQuality still persists the last view');

  // A saved theater must actually load during boot, not just highlight.
  ok(/else if \(this\.ui\.theater !== 'temperate' && THEATERS\[this\.ui\.theater\]\)/.test(mainSrc),
    'boot() branches on a saved non-default theater');
  ok(/await this\.setTheater\(this\.ui\.theater\);/.test(mainSrc),
    'boot() loads the saved theater');

  // A stale last-view record can never revert the sticky quality.
  const restore = mainSrc.slice(mainSrc.indexOf('_restoreLastView() {'));
  const restoreBody = restore.slice(0, restore.indexOf('\n  /** F5:'));
  ok(/this\._savedSettings\?\.quality/.test(restoreBody),
    'restore prefers the sticky settings quality');
  ok(/QUALITY\[stickyQuality\] \? stickyQuality : saved\.quality/.test(restoreBody),
    'sticky quality wins over lastView.quality');
  ok(/this\.ui\.applySettings\(\{ quality: this\.preset\.name \}\)/.test(restoreBody),
    'restore keeps the quality pill synced');
  ok(/this\.ui\.applySettings\(\{ theater: wantTheater \}\)/.test(restoreBody),
    'restore keeps the theater pill synced');

  // menu.js: applySettings() paints all six pill groups.
  ok(/\n  _setPill\(id, value, isFloat = false\) \{/.test(menuSrc),
    'UI defines _setPill(id, value, isFloat)');
  ok(/\n  applySettings\(s = \{\}\) \{/.test(menuSrc), 'UI defines applySettings(s)');
  ok(/b\.dataset\.v === String\(value\)/.test(menuSrc),
    '_setPill matches exact pill values');
  ok(/Math\.abs\(parseFloat\(b\.dataset\.v\) - Number\(value\)\) < 0\.05/.test(menuSrc),
    '_setPill matches numeric pills within 0.05');
  ok(/if \(!match\) return;[\s\S]{0,140}classList\.remove\('on'\)[\s\S]{0,80}classList\.add\('on'\)/.test(menuSrc),
    '_setPill only repaints when a button matches');
  for (const id of ['opt-mission', 'opt-theater', 'opt-weather', 'opt-wind', 'opt-quality', 'opt-time']) {
    ok(new RegExp(`_setPill\\('${id}'`).test(menuSrc), `applySettings paints ${id}`);
  }
  ok(/_setPill\('opt-time', s\.hour, true\)/.test(menuSrc),
    'applySettings matches the hour pill numerically');
  ok(/Number\.isFinite\(s\.hour\)/.test(menuSrc), 'applySettings validates the hour');
}

// ---------------------------------------------------------------------------
// 9. Map / Free Cam "Spawn F-16" — heading convention, map defaults & wiring
// ---------------------------------------------------------------------------
{
  // FreeCamController forward is (-sin yaw, 0, -cos yaw). FlightModel.reset()
  // rotates (0,0,-1) by -heading around Y, which yields (+sin h, 0, -cos h),
  // so the spawn heading must be -yaw in degrees, normalised to [0, 360).
  const cases = [
    [0, 0],
    [-Math.PI / 2, 90],
    [Math.PI, 180],
    [Math.PI / 2, 270],
  ];
  for (const [yaw, wantDeg] of cases) {
    const got = camYawToHeadingDeg(yaw);
    ok(Math.abs(got - wantDeg) < 1e-9,
      `camYawToHeadingDeg(${yaw.toFixed(3)}) is ${wantDeg}°`, `got ${got}`);

    const f = new FlightModel();
    f.reset({ x: 0, y: 1000, z: 0, heading: got, speed: 154 });
    const fm = f.forward;
    const gotX = fm.x;
    const gotY = fm.y;
    const gotZ = fm.z;
    const fcX = -Math.sin(yaw);
    const fcZ = -Math.cos(yaw);
    ok(Math.abs(gotX - fcX) < 1e-6 && Math.abs(gotY) < 1e-6 && Math.abs(gotZ - fcZ) < 1e-6,
      `heading ${Math.round(wantDeg)}° flies exactly where the Free Cam looks`,
      `f16=(${gotX.toFixed(4)}, ${gotY.toFixed(4)}, ${gotZ.toFixed(4)}) ` +
      `cam=(${fcX.toFixed(4)}, 0, ${fcZ.toFixed(4)})`);
  }
  ok(camYawToHeadingDeg(NaN) === 0 && camYawToHeadingDeg(undefined) === 0,
    'camYawToHeadingDeg falls back to 0 for junk input');
  ok(camYawToHeadingDeg(2 * Math.PI) === 0 && camYawToHeadingDeg(-2 * Math.PI) === 0,
    'camYawToHeadingDeg normalises full turns into [0, 360)');
  const wrapped = camYawToHeadingDeg(3 * Math.PI / 2);
  ok(wrapped >= 0 && wrapped < 360, `camYawToHeadingDeg stays in range (${wrapped})`);

  // Headless InspectorMap defaults + coordinate round-trip.
  const imap = new InspectorMap();
  ok(imap.clickMode === 'teleport', "InspectorMap defaults to clickMode 'teleport'");
  ok(imap.selectedPoint === null, 'InspectorMap starts with no selected point');
  ok(Array.isArray(imap._modeBtns) && imap._modeBtns.length === 0,
    'InspectorMap starts with an empty mode-button list');
  ok(imap._spawnBtn === null, 'InspectorMap starts with no spawn button');
  {
    const c = imap.worldToCanvas(-450, 7135, 840, 620);
    const w = imap.canvasToWorld(c.px, c.py, 840, 620);
    ok(Math.abs(w.x - (-450)) < 1e-4 && Math.abs(w.z - 7135) < 1e-4,
      'InspectorMap round-trip still holds for a spawn target',
      `x=${w.x} z=${w.z}`);
  }

  // main.js wiring (browser-only module, asserted statically).
  const mainSrc = read('../src/main.js');
  ok(/const MAP_SPAWN_ALT_M = 5000 \* 0\.3048;/.test(mainSrc),
    'main defines MAP_SPAWN_ALT_M as 5,000 ft in metres');
  ok(/const MAP_SPAWN_SPEED_MS = 300 \* 0\.514444444;/.test(mainSrc),
    'main defines MAP_SPAWN_SPEED_MS as 300 kts in m/s');
  ok(/const MAP_SPAWN_MIN_AGL_M = 305;/.test(mainSrc),
    'main keeps a ~1,000 ft AGL floor');
  ok(/async spawnAircraftAt\(x, z, headingDeg = null\) \{/.test(mainSrc),
    'main implements async spawnAircraftAt(x, z, headingDeg)');
  ok(/onSpawnAircraft: \(x, z, heading\) => this\.spawnAircraftAt\(x, z, heading\)/.test(mainSrc),
    'InspectorMap is wired to onSpawnAircraft');
  ok(/onFreeCamSpawn: \(\) => this\.spawnAircraftAt\(/.test(mainSrc),
    'Free Cam bar is wired to onFreeCamSpawn');
  ok(/speed: MAP_SPAWN_SPEED_MS,\s*\n\s*throttle: 0\.72,\s*\n\s*airborne: true,/.test(mainSrc),
    'spawnAircraftAt drops 300 kts / 0.72 throttle airborne');
  ok(/f\.flapsIndex = 0;/.test(mainSrc) && /f\.flapPos = 0;/.test(mainSrc) &&
    /f\._lastOnGround = false;/.test(mainSrc),
    '_placeAtSpawn gives airborne spawns a clean wing and ground flag');

  // UI surface: the buttons the two callbacks are bound to.
  const htmlSrc = read('../index.html');
  ok(/<button id="freecam-spawn"[^>]*>SPAWN F-16 \(5000FT\)<\/button>/.test(htmlSrc),
    'index.html carries #freecam-spawn');
  ok(/data-mode="teleport"/.test(htmlSrc) && /data-mode="spawn"/.test(htmlSrc),
    'index.html carries the teleport/spawn mode toggle');
  ok(/id="inspector-spawn-btn"/.test(htmlSrc), 'index.html carries #inspector-spawn-btn');
  const menuSrc = read('../src/ui/menu.js');
  ok(/this\.freeCamSpawn = this\.\$\('freecam-spawn'\)/.test(menuSrc) &&
    /this\.freeCamSpawn\?\.addEventListener\('click', \(\) => this\.cb\.onFreeCamSpawn\?\.\(\)\)/.test(menuSrc),
    'menu.js binds #freecam-spawn to onFreeCamSpawn');
  const cssSrc = read('../src/ui/style.css');
  ok(/\.im-controls button\.im-spawn\.on/.test(cssSrc) && /#freecam-spawn,/.test(cssSrc),
    'style.css gives Spawn F-16 its amber accent');
}

console.log(`cinematic juice checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL CINEMATIC JUICE CHECKS PASSED');