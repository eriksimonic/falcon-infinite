# Feature 13A — High-Altitude & Hilly-Terrain Mk-82 CCIP Precision

## Problems to Fix
1. `computeCCIP` in `src/combat/weapons.js` caps integration at `maxTime = 18` seconds, causing `ccip.valid` to become `false` above ~1,500 m AGL (so the CCIP pipper vanishes in normal flight).
2. `computeCCIP` uses a coarse `step = 0.15` s (~39 m horizontal jump at 260 m/s), which can skip over terrain ridges that `_stepProjectile` (`h = 0.02` s) impacts.
3. `fire('MK82')` and `computeCCIP` subtract `ejectSpeed` from world `vel.y` instead of aircraft local `-Y` (`(0, -def.ejectSpeed, 0).applyQuaternion(q)`).
4. Falling Mk-82 bombs emit no trail and have small meshes, making it hard to visually verify the drop trajectory against the CCIP pipper.

## File Ownership (STRICT)
Modify ONLY:
- `src/combat/weapons.js`
- `tests/weapons_test.mjs`

Do NOT touch any other files.

## Required Changes (`src/combat/weapons.js`)
1. In both `fire('MK82')` and `computeCCIP(flight, world)`:
   - Compute local downward ejection vector: `eject = (0, -def.ejectSpeed, 0).applyQuaternion(q)` and add it to `flight.velocity` (exact parity between `fire` and `computeCCIP`).
2. In `computeCCIP(flight, world)`:
   - Increase `maxTime` to `45` seconds and tighten `step` to `0.06` seconds.
   - Keep `ccipOrigin` at `flight.position + flight.velocity * 1.2` (when `flight.velocity` exists).
3. In `_stepProjectile` for `p.type === 'MK82'`:
   - Emit a subtle visible smoke/condensation trail (`this._trail(p, events, h, 0.08, 0xd8dfe6, 0.85)`) so the player can visually track the bomb all the way to the CCIP impact point.
   - Make the Mk-82 bomb mesh slightly more readable in chase cam (e.g., length ~2.2 m, radius ~0.24 m, dark olive/steel with amber nose band).

## Verification (`tests/weapons_test.mjs`)
Add checks verifying:
1. High-altitude level drops at `2200 m` and `4500 m` produce `ccip.valid === true` and actual bomb impact matches predicted CCIP within `< 2.0 m`.
2. Banked (`45°`) diving drops over hilly terrain match predicted CCIP within `< 2.0 m`.
3. Falling Mk-82 emits `trail` events.
4. All existing checks continue to pass (`node tests/weapons_test.mjs` exits 0).
