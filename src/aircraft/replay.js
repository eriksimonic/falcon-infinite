// Instant replay (Feature 16): fixed-size ring-buffer recorder + interpolating
// playback over the last `maxSeconds` of flight history.
//
// Zero-GC-churn: all frame objects are preallocated once in the constructor and
// recording only rewrites their numeric fields. stepPlayback() reuses
// preallocated Vector3 / Quaternion temporaries for its result, so callers must
// consume the sample immediately (applyToFlight does) or clone it.
//
// Headless-safe: no DOM or browser globals.
import * as THREE from 'three';

const SPEED_CYCLE = [1, 0.5, 2];
const DONE_EPS = 1e-4;
const TIME_EPS = 1e-9;

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Clamp a possibly-missing dt / duration to a usable, non-negative value.
function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function makeFrame() {
  return {
    t: 0,
    px: 0, py: 0, pz: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    vx: 0, vy: 0, vz: 0,
    throttle: 0, afterburner: 0, gearPos: 0, flaps: 0, flapsIndex: 0, airbrake: 0,
    speed: 0, aoa: 0, gForce: 1,
  };
}

function copyVec(dst, src, fallback = 0) {
  if (!dst) return;
  const x = num(src && src.x, fallback);
  const y = num(src && src.y, fallback);
  const z = num(src && src.z, fallback);
  if (typeof dst.set === 'function') dst.set(x, y, z);
  else { dst.x = x; dst.y = y; dst.z = z; }
}

// FlightModel exposes `flapPos` (0..1); accept a plain `flaps` field too.
function flapValue(flight) {
  if (typeof flight.flapPos === 'number') return flight.flapPos;
  if (typeof flight.flaps === 'number') return flight.flaps;
  return 0;
}

// The sample field is numeric (it is interpolated), while FlightModel carries a
// boolean `brake`.
function airbrakeValue(flight) {
  const v = flight.airbrake;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return flight.brake ? 1 : 0;
}

function snapshotLiveFlight(flight) {
  return {
    position: new THREE.Vector3(num(flight.position && flight.position.x),
      num(flight.position && flight.position.y), num(flight.position && flight.position.z)),
    quaternion: new THREE.Quaternion(num(flight.quaternion && flight.quaternion.x, 0),
      num(flight.quaternion && flight.quaternion.y, 0),
      num(flight.quaternion && flight.quaternion.z, 0),
      num(flight.quaternion && flight.quaternion.w, 1)).normalize(),
    velocity: new THREE.Vector3(num(flight.velocity && flight.velocity.x),
      num(flight.velocity && flight.velocity.y), num(flight.velocity && flight.velocity.z)),
    throttle: num(flight.throttle, 0),
    targetThrottle: num(flight.targetThrottle, num(flight.throttle, 0)),
    afterburner: !!flight.afterburner,
    gearPos: num(flight.gearPos, 0),
    gearTarget: num(flight.gearTarget, num(flight.gearPos, 0)),
    flaps: flapValue(flight),
    flapsIndex: num(flight.flapsIndex, 0),
    airbrake: airbrakeValue(flight),
    speed: num(flight.speed, 0),
    aoa: num(flight.aoa, 0),
    gForce: num(flight.gForce, 1),
  };
}

// Update `flight.forward` when it is a writable data field, and never touch an
// accessor-backed one (FlightModel derives `forward` from its quaternion).
function updateForward(flight, quaternion) {
  if (!quaternion) return;
  let holder = flight;
  let desc;
  while (holder && !(desc = Object.getOwnPropertyDescriptor(holder, 'forward'))) {
    holder = Object.getPrototypeOf(holder);
  }
  if (desc) {
    if (desc.get && !desc.set) return;   // derived getter: already correct
    if (!desc.set && desc.writable === false) return;
  }
  const target = flight.forward;
  if (target && typeof target === 'object') {
    if (typeof target.set === 'function') target.set(0, 0, -1).applyQuaternion(quaternion);
    else { target.x = 0; target.y = 0; target.z = -1; }
  } else {
    flight.forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  }
}

export class ReplaySystem {
  constructor(options = {}) {
    const maxSeconds = positive(options.maxSeconds, 30);
    const sampleHz = positive(options.sampleHz, 30);

    this.maxSeconds = maxSeconds;
    this.sampleHz = sampleHz;
    this.interval = 1 / sampleHz;
    this.capacity = Math.max(2, Math.ceil(maxSeconds * sampleHz));

    this.frames = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.frames[i] = makeFrame();

    // Public state (see module contract).
    this.playing = false;
    this.playbackRate = 1;
    this.count = 0;
    this.duration = 0;
    this.playTime = 0;

    // Ring bookkeeping.
    this._start = 0;      // ring index of the oldest valid frame
    this._acc = 0;        // seconds accumulated since the last written sample
    this._samples = 0;    // samples written since reset (monotonic)
    this._savedLive = null;

    // Interpolation scratch (reused, never reallocated).
    this._outPos = new THREE.Vector3();
    this._outVel = new THREE.Vector3();
    this._outQuat = new THREE.Quaternion();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
  }

  reset() {
    this.count = 0;
    this.duration = 0;
    this.playTime = 0;
    this.playing = false;
    this.playbackRate = 1;
    this._start = 0;
    this._acc = 0;
    this._samples = 0;
    this._savedLive = null;
  }

  /** Chronological accessor: 0 = oldest valid frame. */
  _frameAt(i) {
    return this.frames[(this._start + i) % this.capacity];
  }

  _write(flight) {
    const capacity = this.capacity;
    let index;
    if (this.count < capacity) {
      index = (this._start + this.count) % capacity;
      this.count++;
    } else {
      index = this._start;
      this._start = (this._start + 1) % capacity;
    }

    // Stamps follow the nominal sample grid so playback time and interpolation
    // stay stable even when the incoming dt jitters.
    const t = this._samples / this.sampleHz;
    this._samples++;

    const f = this.frames[index];
    const p = flight.position || null;
    const q = flight.quaternion || null;
    const v = flight.velocity || null;

    f.t = t;
    f.px = num(p && p.x);
    f.py = num(p && p.y);
    f.pz = num(p && p.z);
    f.qx = num(q && q.x, 0);
    f.qy = num(q && q.y, 0);
    f.qz = num(q && q.z, 0);
    f.qw = num(q && q.w, 1);
    f.vx = num(v && v.x);
    f.vy = num(v && v.y);
    f.vz = num(v && v.z);
    f.throttle = num(flight.throttle, 0);
    f.afterburner = flight.afterburner ? 1 : 0;
    f.gearPos = num(flight.gearPos, 0);
    f.flaps = flapValue(flight);
    f.flapsIndex = num(flight.flapsIndex, 0);
    f.airbrake = airbrakeValue(flight);
    f.speed = num(flight.speed, v ? Math.hypot(f.vx, f.vy, f.vz) : 0);
    f.aoa = num(flight.aoa, 0);
    f.gForce = num(flight.gForce, 1);

    this.duration = this.count >= 2
      ? this._frameAt(this.count - 1).t - this._frameAt(0).t
      : 0;
  }

  record(dt, flight) {
    if (this.playing || !flight) return;
    const step = nonNegative(dt);

    // Anchor the history on the very first call so a replay is possible before
    // a full sample interval has elapsed. The anchor already covers this dt,
    // so it does not feed the accumulator.
    if (this.count === 0) {
      this._write(flight);
      this._acc = 0;
      return;
    }

    this._acc += step;
    let budget = this.capacity;   // never write more than the buffer can hold
    while (budget-- > 0 && this._acc + TIME_EPS >= this.interval) {
      this._acc -= this.interval;
      this._write(flight);
    }
    // A stall longer than the whole buffer cannot be represented: drop the
    // backlog instead of looping (or leaving the accumulator permanently hot).
    if (this._acc >= this.interval) this._acc = 0;
  }

  startPlayback(secondsBack = 30, liveFlight = null) {
    if (this.count < 2) return false;
    this._savedLive = liveFlight ? snapshotLiveFlight(liveFlight) : null;
    this.playing = true;
    this.playbackRate = 1;
    const back = nonNegative(secondsBack);
    this.playTime = Math.max(0, this.duration - back);
    return true;
  }

  stopPlayback() {
    this.playing = false;
    const saved = this._savedLive;
    this._savedLive = null;
    return saved;
  }

  cycleSpeed() {
    const index = SPEED_CYCLE.indexOf(this.playbackRate);
    this.playbackRate = SPEED_CYCLE[(index + 1) % SPEED_CYCLE.length];
    return this.playbackRate;
  }

  stepPlayback(dt) {
    if (!this.playing || this.count < 2) return null;

    const step = nonNegative(dt);
    this.playTime = Math.min(this.duration,
      this.playTime + step * this.playbackRate);

    // Locate the bracketing pair for (oldest frame time + playTime).
    const target = this._frameAt(0).t + this.playTime;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._frameAt(mid).t <= target) lo = mid;
      else hi = mid - 1;
    }
    const last = this.count - 1;
    const i = lo >= last ? last - 1 : lo;
    const a = this._frameAt(i);
    const b = this._frameAt(i + 1);
    const span = b.t - a.t;
    let u = span > 0 ? (target - a.t) / span : 0;
    if (!(u > 0)) u = 0;
    if (u > 1) u = 1;

    const lerp = (x, y) => x + (y - x) * u;

    this._outPos.set(lerp(a.px, b.px), lerp(a.py, b.py), lerp(a.pz, b.pz));
    this._outVel.set(lerp(a.vx, b.vx), lerp(a.vy, b.vy), lerp(a.vz, b.vz));
    this._qa.set(a.qx, a.qy, a.qz, a.qw).normalize();
    this._qb.set(b.qx, b.qy, b.qz, b.qw).normalize();
    this._outQuat.copy(this._qa).slerp(this._qb, u);

    return {
      position: this._outPos,
      quaternion: this._outQuat,
      velocity: this._outVel,
      throttle: lerp(a.throttle, b.throttle),
      afterburner: a.afterburner > 0.5,
      gearPos: lerp(a.gearPos, b.gearPos),
      flaps: lerp(a.flaps, b.flaps),
      flapsIndex: Math.round(lerp(a.flapsIndex, b.flapsIndex)),
      airbrake: lerp(a.airbrake, b.airbrake),
      speed: lerp(a.speed, b.speed),
      aoa: lerp(a.aoa, b.aoa),
      gForce: lerp(a.gForce, b.gForce),
      timeSec: this.playTime,
      durationSec: this.duration,
      progress: this.duration > 0 ? this.playTime / this.duration : 1,
      rate: this.playbackRate,
      done: this.playTime >= this.duration - DONE_EPS,
    };
  }

  applyToFlight(flight, sample) {
    if (!flight || !sample) return flight;
    copyVec(flight.position, sample.position);
    copyVec(flight.velocity, sample.velocity);
    if (flight.quaternion) {
      const q = sample.quaternion;
      if (typeof flight.quaternion.set === 'function') {
        flight.quaternion.set(num(q && q.x, 0), num(q && q.y, 0), num(q && q.z, 0), num(q && q.w, 1));
      } else {
        flight.quaternion = q ? q.clone() : new THREE.Quaternion();
      }
    }
    flight.throttle = num(sample.throttle, 0);
    flight.afterburner = !!sample.afterburner;
    flight.gearPos = num(sample.gearPos, 0);
    flight.flapPos = num(sample.flaps, 0);
    flight.flapsIndex = Math.round(num(sample.flapsIndex, num(flight.flapsIndex, 0)));
    flight.brake = num(sample.airbrake, 0) >= 0.5;
    flight.speed = num(sample.speed, 0);
    updateForward(flight, flight.quaternion);
    return flight;
  }
}