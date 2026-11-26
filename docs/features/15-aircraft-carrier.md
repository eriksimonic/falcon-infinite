# Feature 15 — Offshore Nimitz-Class Aircraft Carrier Group

## Goal
Add a procedural, zero-asset Nimitz-class offshore aircraft carrier (`CVN-71`) anchored in deep water, complete with:
- Angled flight deck landing surface (`deckHeight = 18.5 m`)
- Procedural 3D hull, island superstructure, radar mast, deck markings, 4 arresting wires, and bow steam catapult track
- Functional **Fresnel Lens Optical Landing System (FLOLS / "meatball")** with 3.5° glideslope guidance
- **4 Arresting Wires** that catch the F-16 on touchdown and decelerate it smoothly to a stop (grading Wire 1–4)
- **Steam Catapult** that launches the F-16 from the bow deck to `82 m/s` (`~160 kts`) in `2.2 s`

## File Ownership (STRICT)
Create ONLY:
- `src/world/carrier.js`
- `tests/carrier_test.mjs`

Do NOT modify any existing files.

## Module Contract (`src/world/carrier.js`)
Use `THREE` (`import * as THREE from 'three'`) and `baseHeight` from `./terrain.js`.
Must be **100% headless-safe** when `scene === null`.

Export `export class CarrierGroup`:
- `new CarrierGroup(scene = null, options = {})`
  - Constants:
    - `DECK_HEIGHT = 18.5` (metres above sea level `y = 0`)
    - `DECK_LENGTH = 330` (metres)
    - `DECK_WIDTH = 76` (metres)
    - `GLIDESLOPE_DEG = 3.5`
    - `CATAPULT_SPEED_MS = 82`
    - `CATAPULT_DURATION = 2.2`
  - State:
    - `this.x`, `this.z`, `this.heading` (degrees clockwise from North; default `0`, i.e. bow points North `-Z`)
    - `this.deckHeight = 18.5`
    - `this.name = 'USS THEODORE ROOSEVELT'`
    - `this.code = 'CVN71'`
    - `this.wireCaught = 0` (`0` = none, `1..4` = caught wire index)
    - `this.wireTimer = 0`
    - `this.catapultActive = false`
    - `this.catapultTimer = 0`
    - `this.group` (`THREE.Group` when `scene` is provided, else `null`)
- Methods:
  - `placeNear(originX, originZ)`:
    - Searches deterministically in expanding rings (`6 km` to `36 km` in steps) for deep water where `baseHeight(x, z) < -6`.
    - If no deep water is found within 36 km, falls back to `(originX + 18000, originZ - 18000)` at sea level `y = 0`.
    - Updates `this.x`, `this.z`, `this.heading`, and moves `this.group` if present.
    - Returns `{ x: this.x, z: this.z, heading: this.heading, deckHeight: this.deckHeight }`.
  - `worldToDeck(x, z)`:
    - Transforms world `(x, z)` into carrier-local coordinates `{ along, right }` where:
      - `along > 0` is toward the bow (along `heading`), `along < 0` is toward the stern (`[-165, +165]`).
      - `right > 0` is starboard (`[-38, +38]`).
  - `isOverDeck(x, z)`:
    - Returns `true` if `Math.abs(along) <= DECK_LENGTH * 0.5 && Math.abs(right) <= DECK_WIDTH * 0.5`.
  - `getDeckElevation(x, z)`:
    - Returns `this.deckHeight` if `isOverDeck(x, z)`, otherwise `null`.
  - `getDeckPoint()`:
    - Returns an airport-compatible object `{ id: 'CVN71', code: 'CVN71', name: this.name, x: this.x, z: this.z, elevation: this.deckHeight, heading: this.heading, length: 330, width: 76, kind: 'carrier' }`.
  - `getMeatball(flight)`:
    - Computes glideslope & centerline deviation for a jet approaching from aft (`along < 0`, within `8 km` and `±30°` of stern approach axis):
    - Returns `{ active, ballOffset, glideslopeErrorDeg, lineupErrorM, distNm, bearing, deckHeading: this.heading }`:
      - `ballOffset` in `[-1, +1]` (`0` = centered on 3.5° glideslope, `+1` = high, `-1` = low).
  - `triggerCatapult(flight)`:
    - If aircraft is on deck (`isOverDeck`) and slow (`flight.speed < 25`), arms and starts catapult launch (`this.catapultActive = true`, `this.catapultTimer = 0`, releases `wireCaught = 0`). Returns `true` if triggered, else `false`.
  - `update(dt, flight, weather = null)`:
    - Updates 3D FLOLS meatball light position if `this.group` exists.
    - **Arresting Wire Catch**:
      - When `!this.catapultActive && this.wireCaught === 0` and aircraft is on/touching the deck (`isOverDeck`, `flight.position.y <= this.deckHeight + 3.2`, `flight.gearPos > 0.5`, `flight.speed > 28`) inside the wire zone (`along` in `[-125, -45]`):
        - Picks wire `1..4` based on `along` (`-125..-105` -> 1, `-105..-85` -> 2, `-85..-65` -> 3, `-65..-45` -> 4).
        - Sets `this.wireCaught = wire`, `this.wireTimer = 0`.
      - While `this.wireCaught > 0`:
        - Decelerates `flight.velocity` along deck forward smoothly to `0` over `2.0 s` (`flight.speed` approaches `0`, keeps jet on deck height), then resets `this.wireCaught = 0` once stopped (`speed < 1.5`).
    - **Steam Catapult**:
      - Auto-triggers if aircraft is on bow catapult zone (`along` in `[+20, +130]`, `onGround` or `y <= deckHeight + 2.6`, `flight.speed < 12`, `flight.throttle > 0.92`, `!this.catapultActive`).
      - While `this.catapultActive`:
        - Advances `this.catapultTimer += dt`, accelerates `flight.velocity` along carrier forward vector up to `CATAPULT_SPEED_MS` (`82 m/s`) over `CATAPULT_DURATION` (`2.2 s`).
        - Disengages when `this.catapultTimer >= CATAPULT_DURATION` or jet leaves the bow (`along > 165`).
    - Returns `{ onDeck, meatball, wireCaught, newlyCaughtWire, catapultActive, catapultLaunched }`.

## Verification (`tests/carrier_test.mjs`)
Standalone headless Node test verifying:
1. `CarrierGroup(null)` constructs cleanly and `placeNear(0, 0)` places the carrier deterministically.
2. `isOverDeck` and `getDeckElevation` return `18.5` over the deck and `null` outside.
3. `getMeatball(flight)` returns `active: true`, `ballOffset ≈ 0` on a 3.5° glideslope, positive when high, negative when low.
4. Arresting wire catches a landing jet in the wire zone (`wireCaught` in `1..4`) and decelerates it from `72 m/s` to `< 2 m/s` within `2.5 s`.
5. Steam catapult triggers at bow with full throttle (`0.95`) and accelerates jet from `0` to `>= 78 m/s` within `2.3 s`.
6. Exits with code `0` and prints `ALL CARRIER CHECKS PASSED`.
