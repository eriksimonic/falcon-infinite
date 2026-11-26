# Feature 10 — ACES II Ejection Seat & Ambient Air Traffic / Wingman

## Inspiration
Punching out of a crippled Falcon at 200 ft with the rocket seat firing into a parachute canopy — and sharing the sky with high-altitude contrail airliners and a loyal F-16 wingman holding tight formation — makes the world feel alive and dramatic.

## File Ownership (STRICT)
Create ONLY:
- `src/aircraft/ejection.js`
- `src/sim/traffic.js`
- `tests/ejection_traffic_test.mjs`

Do NOT modify any existing files.

## Module 1 Contract (`src/aircraft/ejection.js`)
Export `export class EjectionSystem`:
- `new EjectionSystem(scene)` — `scene` may be `null` in headless tests.
- State:
  - `this.active = false`
  - `this.phase = 'NONE'` (`'NONE' | 'ROCKET' | 'CHUTE' | 'LANDED'`)
  - `this.seatPos = new THREE.Vector3()`
  - `this.seatVel = new THREE.Vector3()`
  - `this.canopyPos = new THREE.Vector3()`
  - `this.canopyVel = new THREE.Vector3()`
  - `this.timer = 0`
- Methods:
  - `reset()` — Deactivates sequence, removes/hides 3D seat/chute/canopy meshes.
  - `trigger(flight)`:
    - Activates ejection from `flight.position` & `flight.velocity`:
    - Canopy jettisons upward/aft (`+16 m/s` local up, `-12 m/s` aft).
    - ACES II seat rockets upward (`+38 m/s` local up along aircraft `+Y` plus initial aircraft velocity), rocket burn lasts `0.55s` (`+55 m/s²` upward acceleration).
    - Builds simple procedural 3D pilot+seat, jettisoned canopy frame, and orange/white striped parachute dome (when `scene` provided).
    - Returns `true` if newly triggered, `false` if already active.
  - `update(dt, world, weather)`:
    - Advances canopy ballistically until ground hit.
    - Advances seat: `ROCKET` (`0..0.55s`) -> `CHUTE` (`t > 1.2s`, parachute opens smoothly, horizontal speed damps to local wind, vertical sink rate stabilizes gently around `-5.5 m/s`) -> `LANDED` when `seatPos.y <= world.heightAt(x, z) + 1.0`.
    - Returns `{ active, phase, seatPos, cameraPos, lookAt }` so the camera smoothly tracks the pilot descending under the parachute!

## Module 2 Contract (`src/sim/traffic.js`)
Export `export class AirTrafficSystem`:
- `new AirTrafficSystem(scene)` — `scene` may be `null` in headless tests.
- Manages:
  1. **Ambient High-Altitude Airliners** (4 deterministic planes cruising between `6,500 m` and `10,500 m` within `45 km` of player, recycling seamlessly as you fly across the infinite world, with swept-wing airliner silhouettes and soft white twin-contrail ribbons!).
  2. **Optional F-16 Wingman (`VIPER 1-2`)**:
     - `this.wingmanEnabled = true` (`toggleWingman()` flips on/off).
     - Smoothly flies fingertip formation (`+22 m` right, `+18 m` aft, `+2 m` up in player frame) when player is airborne (`!flight.onGround && flight.speed > 75`), banking smoothly to match player attitude without colliding!
- Methods:
  - `reset(flight)` — Seeds airliner tracks around player and resets wingman formation position.
  - `toggleWingman()` — Toggles wingman visibility/active state.
  - `update(dt, flight, weather)` — Updates airliners, contrails, and wingman position/orientation. Returns `{ airlinerCount, wingmanActive, wingmanPos }`.

## Verification (`tests/ejection_traffic_test.mjs`)
Write a standalone headless Node test verifying:
1. `EjectionSystem(null)`: `trigger()` launches seat upward in `ROCKET` phase, transitions to `CHUTE` with stabilized descent (~`-5.5 m/s`), drifts with wind, and reaches `LANDED` cleanly on terrain.
2. `AirTrafficSystem(null)`: spawns 4 deterministic cruising airliners, recycles any that drift beyond `45 km`, and wingman smoothly converges to fingertip formation offset behind/right of an airborne F-16.
