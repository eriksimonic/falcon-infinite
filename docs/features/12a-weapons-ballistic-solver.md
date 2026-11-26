# Feature 12A — Exact 3D Ballistic Gun Solution, Lead Solver & CCIP Parity

## Problem
Currently `WeaponSystem` computes `ccip` for `MK82` bombs, but exposes **no 3D ballistic aiming solution** for the `GUN` (20mm Vulcan) or true 3D `boresightPoint` for `AIM9`. Because the follow/chase camera sits above and behind the aircraft looking slightly down (and cockpit camera can head-look), drawing fixed screen-center reticles causes the HUD pipper and actual weapon trajectories to diverge badly.

## File Ownership (STRICT)
Modify ONLY:
- `src/combat/weapons.js`
- `tests/weapons_test.mjs`

Do NOT modify any other files.

## Required Additions to `WeaponSystem` (`src/combat/weapons.js`)

### New Public Fields (initialized in constructor & reset in `reset()`)
```js
this.boresightPoint = { valid: false, x: 0, y: 0, z: 0 };
this.ccipOrigin = { valid: false, x: 0, y: 0, z: 0 };
this.gunSolution = {
  valid: false,
  aimPoint: { x: 0, y: 0, z: 0 },     // 3D point where gun rounds actually pass (impactPoint if terrain within range, else ballistic point at ref range)
  impactValid: false,
  impactPoint: { x: 0, y: 0, z: 0 },  // exact terrain impact of a zero-dispersion 20mm round
  leadValid: false,
  leadPoint: { x: 0, y: 0, z: 0 },    // true 3D ballistic lead aim point for locked moving target (compensating own vel + target vel + gravity drop)
  range: 0,
  tof: 0,
};
```

### Method: `computeGunSolution(flight, world, lockedTarget = null)`
Must use the **EXACT same muzzle origin, velocity, gravity (`G = 9.81`), and `ballisticStep` integrator** as `fire(flight)` for `'GUN'`:
1. Muzzle origin: `muzzle = (-0.75, 0.25, -2.5).applyQuaternion(q).add(flight.position)`.
2. Aircraft forward: `forward = (0, 0, -1).applyQuaternion(q)`.
3. `boresightPoint`: `{ valid: true, ...muzzle + forward * 1200 }` (true 3D line-of-sight along nose/gun axis).
4. Zero-dispersion round initial velocity: `vel0 = flight.velocity + forward * WEAPONS.GUN.muzzleSpeed`.
5. Integrate using `ballisticStep(pos, vel, step, WEAPONS.GUN.drag)` (`step = 0.05s`, up to `WEAPONS.GUN.ttl = 3.0s`):
   - Track exact terrain crossing (`pos.y <= heightAt(world, pos.x, pos.z)`) with linear crossing interpolation -> sets `impactValid = true`, `impactPoint`, `tof`, `range = dist(muzzle, impactPoint)`.
   - Determine reference range `refRange`:
     - If `lockedTarget && lockedTarget.alive !== false && lockedTarget.position`: `clamp(dist(muzzle, lockedTarget.position), 120, 2200)`.
     - Else if `impactValid`: use `impactPoint` directly!
     - Else: `900 m` (air-to-air default gun convergence range).
   - `aimPoint`: the exact ballistic position of the zero-dispersion round when it reaches `refRange` (or `impactPoint` if terrain is reached first!).
6. **Ballistic Lead Point** (when `lockedTarget && lockedTarget.alive !== false && lockedTarget.position`):
   - Iteratively refine time-of-flight `tof` (3 iterations):
     - Target future position: `pT = target.position + target.velocity * tof`
     - Compensate for ownship velocity drift (`-flight.velocity * tof`) and bullet gravity drop (`+0.5 * G * tof * tof` in `+Y`) so that pointing the aircraft nose at `leadPoint` (such that `forward` aims along `(leadPoint - muzzle).normalize()`) launches a round whose actual trajectory `muzzle + (flight.velocity + forward * muzzleSpeed) * tof - 0.5 * G * tof^2 * Y` passes directly through `pT`!
     - Specifically: desired aim direction `d = (pT - muzzle - flight.velocity * tof + (0, 0.5 * G * tof^2, 0))` -> `tof = clamp(d.length() / WEAPONS.GUN.muzzleSpeed, 0.05, 2.8)`.
     - Set `leadPoint = muzzle + d` (a 3D world point at distance `|d|` along the exact required bore direction, so projecting `leadPoint` onto the HUD tells the pilot *exactly* where to put their nose/boresight pipper!).
     - Set `leadValid = true` when `tof < 2.8` and target is ahead (`dot(d, forward) > 0`).

### `computeCCIP(flight, world)` Enhancement
- Also populate `this.ccipOrigin` with `{ valid: true, x: pos.x + vel.x * 1.2, y: pos.y + vel.y * 1.2, z: pos.z + vel.z * 1.2 }` (using aircraft velocity vector / flight path direction ahead of the jet) so the HUD bomb fall line originates along the actual 3D flight path rather than an arbitrary screen coordinate.

### `update(dt, flight, world, targets = [], lockedTarget = null)`
- Always update `boresightPoint` when `flight && flight.position`.
- Update `computeGunSolution(flight, world, lockedTarget)` whenever `this.selected === 'GUN'`.
- Update `computeCCIP(flight, world)` whenever `this.selected === 'MK82'`.
- Keep backwards compatibility when `lockedTarget` is omitted.

## Verification (`tests/weapons_test.mjs`)
Add checks proving:
1. Diving strafe accuracy: firing a `GUN` round (or testing zero-dispersion equivalence across 10 shots) lands within `< 15 m` of `gunSolution.impactPoint` over flat & sloped terrain (and zero-dispersion ballistic trajectory matches `impactPoint` within `< 1 m`).
2. Air-to-air lead accuracy: orienting the aircraft so `forward` points directly at `gunSolution.leadPoint` for a crossing moving bandit (e.g. `200 m/s` perpendicular at `800 m` range) and firing `GUN` passes within `< 15 m` of the moving bandit at `t = tof`!
3. `boresightPoint` and `ccipOrigin` are valid and match aircraft forward / velocity vector.
4. All existing 67 checks continue to pass (`node tests/weapons_test.mjs` exits 0).
