# Feature 08 — Fuel Management & KC-135 Aerial Refueling Tanker

## Inspiration
Managing internal fuel between dry cruise and thirsty afterburner — hearing *"Bingo Fuel"* and climbing to join a patrolling KC-135 Stratotanker for mid-air refueling — brings true tactical mission depth to F-16 sorties.

## File Ownership (STRICT)
Create ONLY:
- `src/sim/fuel.js`
- `tests/fuel_test.mjs`

Do NOT modify any existing files.

## Module Contract (`src/sim/fuel.js`)
Export `export class FuelSystem` and `export class TankerSystem`:

### `FuelSystem`
- Constants: `MAX_FUEL_LB = 7000`, `BINGO_LB = 1500`
- State:
  - `this.fuelLb = 7000`
  - `this.fraction = 1.0`
  - `this.burnRateLbSec = 0`
  - `this.bingo = false`
  - `this.empty = false`
  - `this.refueling = false`
- `reset(fuelLb = 7000)` — Resets fuel and flags.
- `update(dt, flight, tankerContact = false)`:
  - Realistic burn model (tuned for fun gameplay so a full sortie lasts ~10–15 min dry, ~3.5 min continuous full AB):
    - Idle: `0.6 lb/s`, Full Military dry: `6.8 lb/s`, Full Afterburner: `28.0 lb/s` (reduced slightly with altitude density).
  - Ground refuel: if `flight.onGround && flight.speed < 3 && flight.throttle < 0.05`, tops off at `+420 lb/s`.
  - Aerial refuel: if `tankerContact === true`, transfers `+360 lb/s` and sets `this.refueling = true`.
  - Sets `this.bingo = this.fuelLb <= BINGO_LB`, `this.empty = this.fuelLb <= 0.1`.
  - Returns `{ fuelLb, maxFuelLb, fraction, burnRateLbSec, bingo, bingoTriggered, empty, refueling }`.

### `TankerSystem`
- `new TankerSystem(scene)` — `scene` may be `null` in headless tests.
- Orbits deterministically in a wide smooth racetrack/circle around a patrol anchor near the spawn area (`radius ~7500 m`, altitude `3000 m`, steady speed `165 m/s` / ~320 kt — comfortable F-16 join-up speed!).
- Procedural 3D **KC-135 Stratotanker** mesh (when `scene` provided): swept wings, 4 underwing turbofan pods, tall swept vertical tail, USAF grey fuselage, glowing white/amber director lights on belly, and angled aft refueling boom!
- `reset(spawn)` — Places tanker orbit `~5 km` ahead/offset of spawn at `3000 m`.
- `update(dt, flight)`:
  - Advances tanker smoothly along its orbit, updating `position`, `velocity`, `heading`, and mesh orientation.
  - Computes boom contact box (`12–34 m` aft of tanker, `2–12 m` below, within `10 m` laterally, relative speed `< 22 m/s`):
    - Returns `{ active: true, position, heading, speed, distanceM, bearingDeg, contact: boolean, preContact: boolean }`.

## Verification (`tests/fuel_test.mjs`)
Write a standalone headless Node test verifying:
1. Afterburner burns fuel > 3x faster than dry military power; `bingoTriggered` fires once crossing `1500 lb`; `empty` triggers at `0 lb`.
2. Ground refuel on stopped runway restores fuel cleanly to `7000 lb`.
3. `TankerSystem(null)` orbits smoothly at ~3000 m / 165 m/s, detects `contact === true` when player holds position behind/below the boom at matching speed, and transfers fuel via `FuelSystem.update(..., true)`.
