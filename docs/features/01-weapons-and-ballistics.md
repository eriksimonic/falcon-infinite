# Feature 01 — Weapons, Ballistics, CCIP & Countermeasure Flares

## Inspiration
In *F-16: Back to Baghdad*, switching between the 20mm Vulcan gun, Sidewinders, and iron bombs with a live CCIP dive-bombing pipper — and popping flares when a SAM launches — is the heartbeat of every sortie.

## File Ownership (STRICT)
Create ONLY:
- `src/combat/weapons.js`
- `tests/weapons_test.mjs`

Do NOT modify any existing files.

## Module Contract (`src/combat/weapons.js`)
Export `WEAPONS` constants and `export class WeaponSystem`:

```js
export const WEAPON_TYPES = ['GUN', 'AIM9', 'MK82'];
```

### Constructor
`new WeaponSystem(scene)` — `scene` may be `null` in headless unit tests (guard all Three.js mesh creation/additions when `!scene`).

### State & Loadout
- `this.selected = 'GUN'` (`'GUN' | 'AIM9' | 'MK82'`)
- `this.ammo = { GUN: 510, AIM9: 4, MK82: 6, FLARE: 30 }`
- `this.projectiles = []` — active rounds, missiles, bombs
- `this.flares = []` — active burning countermeasure flares
- `this.ccip = { valid: false, x: 0, y: 0, z: 0, timeToImpact: 0 }` — live ground impact solution for Mk-82

### Methods
1. `reset()` — Restores full loadout, removes/disposes active projectile & flare meshes from `scene`, clears arrays.
2. `cycleWeapon()` — Cycles `'GUN' -> 'AIM9' -> 'MK82' -> 'GUN'`, returns new `selected`.
3. `selectWeapon(type)` — Selects valid type.
4. `fire(flight, lockedTarget = null)` — Attempts to fire current weapon (respects fire cooldown: GUN ~0.07s / ~850 RPM bursts, AIM9 0.8s, MK82 0.45s). Returns an event object `{ fired: boolean, type, position, velocity, targetId }` (or `{ fired: false }` if empty/cooldown).
   - **GUN (M61A1 20mm)**: Spawns from left strake gun port (`(-0.75, 0.25, -2.5)` in aircraft local frame) with `flight.velocity + forward * 1030 m/s` + tiny realistic dispersion (`±0.004 rad`). Bright glowing amber tracer mesh (`BoxGeometry` / stretched capsule).
   - **AIM-9 Sidewinder**: Launches off wingtip rails (alternating `x = ±4.95`) with initial forward boost + rocket burn (`accel = 180 m/s²` for `2.6s`, max speed `880 m/s`). Uses **proportional navigation** (`N = 3.5`) toward `lockedTarget` if valid and alive, otherwise flies ballistic forward. Proximity fuse detonation within `18 m` of target.
   - **Mk-82 500lb Bomb**: Drops cleanly from underwing pylons (alternating `x = ±2.1, y = -0.55`) inheriting aircraft velocity + gentle downward ejection (`-2.5 m/s`), gravity (`-9.81 m/s²`), and low aerodynamic drag.
5. `deployFlare(flight)` — Launches a pair of hot magnesium flares downward/aft (`±1.2` lateral, `-5` down, `-18` aft in aircraft frame) with `0.25s` cooldown. Flares burn for `4.5s` (high IR signature for SAM decoying) and fall with drag + gravity. Returns `{ deployed: boolean, position }`.
6. `computeCCIP(flight, world)` — Analytically/iteratively integrates a Mk-82 ballistic trajectory from aircraft position/velocity in `0.15s` steps (up to `18s` max) against `world.heightAt(x, z)`, refining the crossing step linearly. Populates and returns `this.ccip`.
7. `update(dt, flight, world, targets = [])` — Steps all projectiles and flares, handles terrain impacts (`y <= world.heightAt(x, z)`), direct/proximity hits against `targets` (checking `target.alive`, `target.position`, `target.hitRadius`), updates Three.js meshes, and updates `this.ccip` when `selected === 'MK82'`.
   - Returns an array of combat events emitted this frame:
     - `{ kind: 'impact', weapon, position: {x,y,z}, hitTargetId: string | null, splashRadius, damage }`
     - `{ kind: 'trail', position: {x,y,z}, color, size }` (throttled for missiles & flares so VFX system can spawn smoke puffs)

### Damage & Splash Values
- `GUN`: `damage: 18`, `splashRadius: 6`
- `AIM9`: `damage: 100`, `splashRadius: 24`
- `MK82`: `damage: 140`, `splashRadius: 55`

## Verification (`tests/weapons_test.mjs`)
Write a standalone headless Node test verifying:
1. Weapon cycling and ammo decrement (`GUN`, `AIM9`, `MK82`, `FLARE`).
2. `computeCCIP` computes an accurate impact point ahead of a diving aircraft over flat terrain (`y = 0`), and a dropped `MK82` lands within `12 m` of the predicted CCIP point.
3. `AIM9` with proportional navigation intercepts a moving airborne target within 6 seconds and emits a hit event with `hitTargetId`.
4. `deployFlare` spawns active flares with `ttl > 0` that expire cleanly after `5s`.
5. `reset()` restores full ammo and clears all projectiles/flares.
