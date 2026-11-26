# Feature 16 — 30-Second Instant Replay Buffer

## Goal
Implement a lightweight, zero-GC-churn 30-second circular flight replay recorder and playback engine (`ReplaySystem`) so pilots can instantly review dogfights, bomb runs, carrier traps, or low-level flybys at `0.5x`, `1x`, or `2x` speed and seamlessly resume live flight afterward.

## File Ownership (STRICT)
Create ONLY:
- `src/aircraft/replay.js`
- `tests/replay_test.mjs`

Do NOT modify any existing files.

## Module Contract (`src/aircraft/replay.js`)
Use `THREE` (`import * as THREE from 'three'`). Headless-safe (no DOM/browser globals).

Export `export class ReplaySystem`:
- `new ReplaySystem(options = {})`
  - `options`: `{ maxSeconds = 30, sampleHz = 30 }`
  - Preallocates a ring buffer of `capacity = Math.ceil(maxSeconds * sampleHz)` frame objects (`900` by default).
  - State:
    - `this.playing = false`
    - `this.playbackRate = 1` (cycles `[0.5, 1, 2]`)
    - `this.count = 0` (number of valid recorded frames, up to `capacity`)
    - `this.duration = 0` (seconds of recorded history available)
    - `this.playTime = 0` (current offset in seconds from oldest frame)
- Methods:
  - `reset()` — clears buffer (`count = 0`, `playing = false`, `playTime = 0`, `_savedLive = null`).
  - `record(dt, flight)` — no-op while `this.playing` is true; otherwise accumulates `dt` and writes a snapshot at `sampleHz` (and immediately on the first call when `count === 0`):
    - Stores `t, px, py, pz, qx, qy, qz, qw, vx, vy, vz, throttle, afterburner, gearPos, flaps, airbrake, speed, aoa, gForce`.
  - `startPlayback(secondsBack = 30, liveFlight = null)`:
    - Requires `this.count >= 2`; returns `false` if insufficient history.
    - Saves `liveFlight` snapshot (if provided) so `stopPlayback()` can restore live state.
    - Sets `this.playing = true`, `this.playbackRate = 1`, and `this.playTime = Math.max(0, this.duration - secondsBack)`.
    - Returns `true`.
  - `stopPlayback()`:
    - Sets `this.playing = false`.
    - Returns the saved live snapshot (or `null`) and clears `_savedLive`.
  - `cycleSpeed()`:
    - Cycles `this.playbackRate` through `[1, 0.5, 2]` and returns the new rate.
  - `stepPlayback(dt)`:
    - If `!this.playing || this.count < 2`, returns `null`.
    - Advances `this.playTime = Math.min(this.duration, this.playTime + Math.max(0, dt) * this.playbackRate)`.
    - Finds bracketing frames in the ring buffer and interpolates:
      - Linearly interpolates `position`, `velocity`, `throttle`, `gearPos`, `flaps`, `airbrake`, `speed`, `aoa`, `gForce`.
      - Slerps `quaternion` cleanly (`THREE.Quaternion.slerp`).
    - Returns `{ position: THREE.Vector3, quaternion: THREE.Quaternion, velocity: THREE.Vector3, throttle, afterburner, gearPos, flaps, airbrake, speed, aoa, gForce, timeSec: this.playTime, durationSec: this.duration, progress: this.duration > 0 ? this.playTime / this.duration : 1, rate: this.playbackRate, done: this.playTime >= this.duration - 1e-4 }`.
  - `applyToFlight(flight, sample)`:
    - Convenience helper that copies `sample.position`, `sample.quaternion`, `sample.velocity`, `throttle`, `afterburner`, `gearPos`, `speed` onto a `FlightModel` (and updates `flight.forward`).

## Verification (`tests/replay_test.mjs`)
Standalone headless Node test verifying:
1. Recording 35 seconds at 60 Hz wraps cleanly at `capacity = 900` (`duration ≈ 30 s`, oldest 5 s evicted).
2. `startPlayback(10)` starts ~10 seconds before the end; `stepPlayback` interpolates positions and quaternions smoothly between recorded frames.
3. `cycleSpeed()` cycles `1 -> 0.5 -> 2 -> 1` and scales playback progression accordingly.
4. Reaching the end reports `done: true` and `progress: 1`.
5. `stopPlayback()` exits replay mode and returns the saved live snapshot.
6. Exits with code `0` and prints `ALL REPLAY CHECKS PASSED`.
