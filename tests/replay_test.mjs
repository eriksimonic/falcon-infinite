// Headless acceptance tests for src/aircraft/replay.js (Feature 16).
// Run: node tests/replay_test.mjs
//
// Covers the 30 s ring buffer (900 frames at 30 Hz), eviction after 35 s of
// 60 Hz recording, interpolated playback (position / quaternion / telemetry),
// speed cycling, end-of-buffer reporting, live-snapshot save/restore, and the
// applyToFlight helper against the real FlightModel.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ReplaySystem } from '../src/aircraft/replay.js';
import { FlightModel } from '../src/aircraft/flight.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}
function near(actual, expected, tol, msg) {
  ok(Math.abs(actual - expected) <= tol, msg, `got ${actual}, expected ${expected} ±${tol}`);
}

const SRC = fileURLToPath(new URL('../src/aircraft/replay.js', import.meta.url));
const source = readFileSync(SRC, 'utf8');

// Known, analytically simple trajectory: constant ground velocity plus a
// constant-rate yaw, so interpolation between samples has an exact answer.
const VEL = new THREE.Vector3(120, 40, -260);
const YAW_RATE = 0.35;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

function flightAt(t) {
  _q.setFromAxisAngle(Y_AXIS, YAW_RATE * t);
  return {
    position: new THREE.Vector3(VEL.x * t, 1500 + VEL.y * t, VEL.z * t),
    quaternion: _q.clone(),
    velocity: VEL.clone(),
    speed: 310 + 0.5 * t,
    aoa: 3 + 0.2 * t,
    gForce: 1 + 0.1 * t,
    throttle: 0.72,
    afterburner: true,
    gearPos: 0.4,
    flapPos: 0.25,
    flapsIndex: 1,
    brake: false,
  };
}

function yawQuat(angle) {
  return new THREE.Quaternion().setFromAxisAngle(Y_AXIS, angle);
}

// ------------------------------------------------------- 0. source hygiene
{
  ok(!/Math\.random\s*\(/.test(source), 'replay.js uses no Math.random');
  ok(!/\bdocument\./.test(source) && !/\bwindow\./.test(source),
    'replay.js has no DOM dependencies (headless-safe)');
  ok(/export class ReplaySystem/.test(source), 'replay.js exports ReplaySystem');
}

// ---------------------------------------- 1. construction / preallocation
{
  const rs = new ReplaySystem();
  ok(rs.capacity === 900, 'default capacity is 900 frames (30 s @ 30 Hz)',
    String(rs.capacity));
  ok(rs.frames.length === 900, 'ring buffer is preallocated', String(rs.frames.length));
  ok(rs.count === 0 && rs.duration === 0 && rs.playTime === 0,
    'starts with an empty buffer');
  ok(rs.playing === false && rs.playbackRate === 1, 'starts stopped at 1x');

  const custom = new ReplaySystem({ maxSeconds: 10, sampleHz: 20 });
  ok(custom.capacity === 200, 'custom capacity = ceil(maxSeconds * sampleHz)',
    String(custom.capacity));
  ok(new ReplaySystem({ maxSeconds: 0.5, sampleHz: 10 }).capacity === 5,
    'capacity rounds up');

  // First record() call writes immediately, even for a tiny dt.
  custom.record(0.001, flightAt(0));
  ok(custom.count === 1, 'first sample is written immediately', String(custom.count));
  ok(custom.startPlayback() === false, 'playback needs at least two frames');
  custom.record(1 / 20, flightAt(1 / 20));
  ok(custom.count === 2 && custom.startPlayback() === true,
    'playback starts once two frames exist');
}

// ------------------------------- 2. 35 s at 60 Hz wraps at capacity (item 1)
const rs60 = new ReplaySystem();
const frameRefs = rs60.frames.slice();
const DT60 = 1 / 60;
for (let i = 0; i < Math.round(35 * 60); i++) rs60.record(DT60, flightAt(i * DT60));
{
  ok(rs60.count === rs60.capacity, 'buffer is full after 35 s of recording',
    `${rs60.count}/${rs60.capacity}`);
  ok(rs60.frames.every((f, i) => f === frameRefs[i]),
    'recording reuses the preallocated frame objects (no per-frame allocation)');
  near(rs60.duration, (rs60.count - 1) / rs60.sampleHz, 1e-9,
    'duration spans capacity - 1 sample intervals');
  ok(rs60.duration > 29.9 && rs60.duration <= 30,
    '~30 s of history is available', rs60.duration.toFixed(4));
  near(35 - rs60.duration, 5, 0.05, 'the oldest ~5 s were evicted');

  // The oldest surviving sample must be around t = 5 s, not t = 0.
  rs60.startPlayback(30);
  ok(rs60.playTime === 0, 'startPlayback(30) rewinds to the oldest frame',
    String(rs60.playTime));
  const first = rs60.stepPlayback(0);
  ok(first !== null, 'stepPlayback returns a sample at the start of history');
  const tFirst = first.position.x / VEL.x;
  ok(tFirst > 4.9 && tFirst < 5.15, 'history starts ~5 s in, not at t = 0',
    tFirst.toFixed(4));
  // Stamps stay strictly ordered across the wrap point.
  ok(rs60._frameAt(0).t < rs60._frameAt(rs60.count - 1).t,
    'ring order stays chronological after wrapping');
  rs60.stopPlayback();
}

// ------------------- 3. startPlayback(10) + interpolation (item 2, coarse)
{
  ok(rs60.startPlayback(10) === true, 'startPlayback(10) succeeds');
  ok(rs60.playing === true, 'playing flag is set');
  ok(rs60.playbackRate === 1, 'playback starts at 1x');
  near(rs60.playTime, rs60.duration - 10, 1e-9,
    'starts ~10 s before the end of the buffer');

  const sample = rs60.stepPlayback(0);
  ok(sample !== null, 'stepPlayback(0) returns a sample without advancing');
  near(rs60.playTime, rs60.duration - 10, 1e-9, 'stepPlayback(0) does not advance');
  near(sample.timeSec, rs60.duration - 10, 1e-9, 'timeSec reports the play offset');
  near(sample.durationSec, rs60.duration, 1e-9, 'durationSec reports the buffer length');
  near(sample.progress, (rs60.duration - 10) / rs60.duration, 1e-9, 'progress is playTime/duration');
  ok(sample.done === false, 'not done mid-buffer');

  // 10 s before the end of a 35 s recording is t = 25 s; sampling leaves at
  // most one sample interval of lag, so allow two.
  const tExpected = 25;
  ok(Math.abs(sample.position.x / VEL.x - tExpected) < 2 * DT60 + 1e-9,
    'sample lands ~10 s before the end of the recording',
    (sample.position.x / VEL.x).toFixed(4));
  rs60.stopPlayback();
}

// --------------------- 3b. exact interpolation on a 30 Hz buffer (item 2)
const rs30 = new ReplaySystem();
for (let i = 0; i < 40 * 30; i++) rs30.record(1 / 30, flightAt(i / 30));
let basePos;
let baseQuat;
let basePlayTime;
{
  ok(rs30.count === 900 && rs30.playing === false, '30 Hz recording fills the buffer');
  ok(rs30.startPlayback(30) === true, 'startPlayback(30) rewinds to the oldest frame');
  basePlayTime = rs30.playTime;
  ok(basePlayTime === 0, 'rewind to 30 s of history starts at playTime 0',
    String(basePlayTime));

  const s0 = rs30.stepPlayback(0);
  basePos = s0.position.clone();
  baseQuat = s0.quaternion.clone();
  ok(Math.abs(basePos.x / VEL.x - 10.0) < 1e-6,
    'buffer holds the most recent 30 s of a 40 s recording',
    (basePos.x / VEL.x).toFixed(6));

  // Walk forward at 60 Hz and compare against the closed-form trajectory.
  const dt = 1 / 60;
  let maxPosErr = 0;
  let maxQuatErr = 0;
  let maxStep = 0;
  let prev = basePos.clone();
  const expectPos = new THREE.Vector3();
  const expectQuat = new THREE.Quaternion();
  for (let i = 0; i < 600; i++) {
    const s = rs30.stepPlayback(dt);
    ok(s !== null, 'stepPlayback returns a sample while playing');
    const p = rs30.playTime;
    expectPos.copy(basePos).addScaledVector(VEL, p);
    maxPosErr = Math.max(maxPosErr, s.position.distanceTo(expectPos));
    expectQuat.copy(baseQuat).multiply(yawQuat(YAW_RATE * p));
    maxQuatErr = Math.max(maxQuatErr, 1 - Math.abs(s.quaternion.dot(expectQuat)));
    maxStep = Math.max(maxStep, s.position.distanceTo(prev));
    prev.copy(s.position);
    if (i === 0) {
      near(s.velocity.x, VEL.x, 1e-6, 'velocity is interpolated');
      // aoa / gForce / flaps / airbrake interpolate linearly too.
      const T = 10 + p;
      near(s.aoa, 3 + 0.2 * T, 1e-6, 'aoa is interpolated');
      near(s.gForce, 1 + 0.1 * T, 1e-6, 'gForce is interpolated');
      near(s.flaps, 0.25, 1e-9, 'flaps are interpolated');
      near(s.airbrake, 0, 1e-9, 'airbrake is interpolated');
      near(s.gearPos, 0.4, 1e-9, 'gearPos is interpolated');
      near(s.throttle, 0.72, 1e-9, 'throttle is interpolated');
      ok(s.afterburner === true, 'afterburner carries through the sample');
      ok(typeof s.rate === 'number' && s.rate === 1, 'sample reports the playback rate');
    }
  }
  ok(maxPosErr < 1e-6, 'positions interpolate exactly between recorded frames',
    maxPosErr.toExponential(2));
  ok(maxQuatErr < 1e-9, 'quaternions slerp smoothly between recorded frames',
    maxQuatErr.toExponential(2));
  const stepLen = VEL.length() / 60;
  ok(maxStep <= stepLen + 1e-6, 'no positional jump between replay steps',
    `${maxStep.toFixed(4)} vs ${stepLen.toFixed(4)}`);
  near(rs30.playTime, 600 / 60, 1e-9, 'playTime advanced by wall-clock dt at 1x');
  ok(Math.abs(rs30.stepPlayback(0).quaternion.length() - 1) < 1e-9,
    'returned quaternion is normalised');
}

// ------------------------------- 4. speed cycling + progression (item 3)
{
  near(rs30.playbackRate, 1, 1e-12, 'rate is 1x before cycling');
  const p0 = rs30.playTime;
  ok(rs30.cycleSpeed() === 0.5, '1 -> 0.5');
  rs30.stepPlayback(0.4);
  near(rs30.playTime - p0, 0.2, 1e-9, '0.5x advances half of dt');
  const p1 = rs30.playTime;
  ok(rs30.cycleSpeed() === 2, '0.5 -> 2');
  rs30.stepPlayback(0.4);
  near(rs30.playTime - p1, 0.8, 1e-9, '2x advances double dt');
  const p2 = rs30.playTime;
  ok(rs30.cycleSpeed() === 1, '2 -> 1');
  rs30.stepPlayback(0.4);
  near(rs30.playTime - p2, 0.4, 1e-9, '1x advances dt once more');
  ok(rs30.stepPlayback(0).rate === 1, 'sample rate tracks the cycled speed');

  // Speed cycling works outside playback too.
  const idle = new ReplaySystem();
  ok(idle.cycleSpeed() === 0.5 && idle.cycleSpeed() === 2 && idle.cycleSpeed() === 1,
    'cycleSpeed cycles 1 -> 0.5 -> 2 -> 1 while stopped');
}

// ------------------------------------ 5. end of buffer / done (item 4)
{
  ok(rs30.startPlayback(2) === true, 'startPlayback(2) succeeds');
  near(rs30.playTime, rs30.duration - 2, 1e-9, 'starts 2 s before the end');
  const mid = rs30.stepPlayback(0);
  ok(mid.done === false && mid.progress < 1, 'not done 2 s before the end');
  const last = rs30.stepPlayback(10);
  ok(last !== null, 'still returns a sample at the end of the buffer');
  near(rs30.playTime, rs30.duration, 1e-9, 'playTime clamps to duration');
  ok(last.done === true, 'done is reported at the end');
  near(last.progress, 1, 1e-12, 'progress is 1 at the end');
  near(last.timeSec, last.durationSec, 1e-9, 'timeSec reaches durationSec');
  // The final sample is the newest recorded frame (35 s + 5 s at 30 Hz).
  near(last.position.x, VEL.x * (40 - 1 / 30), 1e-6,
    'playback ends on the most recent recorded frame');
  // Nothing left to advance: stays pinned at the end.
  const again = rs30.stepPlayback(5);
  ok(again.done === true && rs30.playTime === rs30.duration, 'stays pinned at the end');

  rs30.stopPlayback();
  ok(rs30.stepPlayback(1 / 60) === null, 'stepPlayback returns null when stopped');
}

// ------------------------------ 6. stopPlayback restores live state (item 5)
{
  const rs = new ReplaySystem();
  for (let i = 0; i < 5 * 30; i++) rs.record(1 / 30, flightAt(i / 30));

  const live = new FlightModel();
  live.position.set(1234.5, 2345.5, -3456.5);
  live.quaternion.setFromAxisAngle(Y_AXIS, 1.234);
  live.velocity.set(0, 0, -250);
  live.throttle = 0.66;
  live.targetThrottle = 0.7;
  live.afterburner = false;
  live.gearPos = 0.15;
  live.gearTarget = 0;
  live.speed = 250;
  live.flapPos = 0.5;
  live.flapsIndex = 1;
  live.brake = true;
  live.aoa = 4.2;
  live.gForce = 1.7;

  ok(rs.startPlayback(3, live) === true, 'playback starts with a live flight');
  ok(rs.playing === true, 'playing while reviewing');

  const countBefore = rs.count;
  const durationBefore = rs.duration;
  for (let i = 0; i < 30; i++) rs.record(1 / 30, flightAt(10 + i / 30));
  ok(rs.count === countBefore && rs.duration === durationBefore,
    'record() is a no-op during playback');

  const s = rs.stepPlayback(1 / 30);
  ok(s !== null, 'review frames are produced');

  const saved = rs.stopPlayback();
  ok(rs.playing === false, 'stopPlayback leaves replay mode');
  ok(saved !== null, 'stopPlayback returns the live snapshot');
  ok(saved.position !== live.position && saved.quaternion !== live.quaternion
    && saved.velocity !== live.velocity, 'snapshot vectors are copies, not aliases');
  near(saved.position.x, 1234.5, 1e-9, 'snapshot keeps the live position');
  near(saved.position.y, 2345.5, 1e-9, 'snapshot keeps the live altitude');
  near(saved.position.z, -3456.5, 1e-9, 'snapshot keeps the live z');
  near(saved.quaternion.angleTo(live.quaternion), 0, 1e-9, 'snapshot keeps the live attitude');
  near(saved.velocity.z, -250, 1e-9, 'snapshot keeps the live velocity');
  near(saved.throttle, 0.66, 1e-9, 'snapshot keeps throttle');
  near(saved.targetThrottle, 0.7, 1e-9, 'snapshot keeps the throttle target');
  near(saved.gearPos, 0.15, 1e-9, 'snapshot keeps gear position');
  near(saved.flaps, 0.5, 1e-9, 'snapshot keeps flaps');
  near(saved.airbrake, 1, 1e-9, 'snapshot keeps the airbrake state');
  near(saved.speed, 250, 1e-9, 'snapshot keeps airspeed');
  ok(saved.afterburner === false, 'snapshot keeps afterburner');

  // The live object can be mutated afterwards without touching the snapshot.
  live.position.set(0, 0, 0);
  near(saved.position.x, 1234.5, 1e-9, 'snapshot is independent of the live object');

  ok(rs.stopPlayback() === null, 'second stopPlayback returns null');
  ok(rs.startPlayback(3, null) === true && rs.stopPlayback() === null,
    'playback without a live flight yields a null snapshot');
}

// ------------------------------------- 7. applyToFlight + flight forward
{
  const rs = new ReplaySystem();
  for (let i = 0; i < 4 * 30; i++) rs.record(1 / 30, flightAt(i / 30));
  rs.startPlayback(2);

  const fm = new FlightModel();
  const s = rs.stepPlayback(1 / 30);
  ok(rs.applyToFlight(fm, s) === fm, 'applyToFlight returns the flight');

  near(fm.position.distanceTo(s.position), 0, 1e-9, 'flight position follows the replay');
  near(1 - Math.abs(fm.quaternion.dot(s.quaternion)), 0, 1e-12, 'flight attitude follows the replay');
  near(fm.velocity.distanceTo(s.velocity), 0, 1e-9, 'flight velocity follows the replay');
  near(fm.throttle, s.throttle, 1e-12, 'flight throttle follows the replay');
  near(fm.gearPos, s.gearPos, 1e-12, 'flight gear position follows the replay');
  near(fm.flapPos, s.flaps, 1e-12, 'flight flap position follows the replay');
  ok(fm.flapsIndex === s.flapsIndex, 'flight flap detent follows the replay');
  ok(fm.brake === (s.airbrake >= 0.5), 'flight brake follows the replay');
  near(fm.speed, s.speed, 1e-9, 'flight airspeed follows the replay');
  ok(fm.afterburner === s.afterburner, 'flight afterburner follows the replay');
  const expectedFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(s.quaternion);
  near(fm.forward.distanceTo(expectedFwd), 0, 1e-9, 'FlightModel.forward tracks the replayed attitude');

  // A plain object with an explicit forward vector is updated in place.
  const plain = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    forward: new THREE.Vector3(1, 0, 0),
  };
  const fwdRef = plain.forward;
  rs.applyToFlight(plain, s);
  ok(plain.forward === fwdRef, 'forward vector is updated in place');
  near(plain.forward.distanceTo(expectedFwd), 0, 1e-9, 'forward points along the replayed nose');
  near(plain.position.distanceTo(s.position), 0, 1e-9, 'plain position copied');

  ok(rs.applyToFlight(null, s) === null, 'applyToFlight tolerates a null flight');
  ok(rs.applyToFlight(fm, null) === fm, 'applyToFlight tolerates a null sample');

  // reset() clears everything.
  rs.reset();
  ok(rs.count === 0 && rs.duration === 0 && rs.playTime === 0 && rs.playing === false,
    'reset() clears the buffer state');
  ok(rs.startPlayback() === false, 'no playback after reset');
  rs.record(1 / 30, flightAt(0));
  ok(rs.count === 1 && rs.frames.every((f) => f !== undefined),
    'recording resumes after reset');
}

// ---------------------------------------------------------------- summary
console.log(`replay checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL REPLAY CHECKS PASSED');