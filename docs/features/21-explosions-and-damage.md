# Feature 21 — High-Visibility Bomb & Rocket Explosions and Blast Damage

## Problem
1. Explosions in `src/sim/vfx.js` were too small and fleeting (`coreT = t / 0.45`, additive yellow-white sphere that washed out in daylight and disappeared in 0.45 s with no rising mushroom smoke column), making Mk-82 bomb and AIM-9 rocket impacts look like nothing happened from jet altitude/distance.
2. Bombs and rockets need decisive blast radius & damage, and unguided AIM-9 rockets fired at ground/buildings should detonate reliably on impact.

## Goal
1. **Unmistakable Multi-Stage Explosions (`src/sim/vfx.js`)**:
   - Upgrade `CombatVFX._buildExplosions()` & `spawnExplosion(pos, scale)` & `update()`:
     - Keep all preallocated pools (zero per-frame GC allocations, headless-safe when `scene === null`, backward-compatible with `tests/vfx_test.mjs`).
     - **Fireball Shell (normal blending, daytime-visible!)**: Add an opaque/normal-blended fiery orange-red expanding fireball sphere (`fireball`, `0xff5a18`) alongside the bright white-yellow incandescent `core` (`0xfff0b8`), lasting **`1.8 s`** and expanding up to `scale * 11 m` so a Mk-82 (`scale = 4.5`) produces a dramatic ~50 m fireball clearly visible from 5+ km away!
     - **Expanding Shockwave Ring**: Lasts **`1.35 s`** and expands up to `scale * 24 m` (bright dusty-orange condensation wave).
     - **Rising Mushroom Smoke Column & Sparks**: Emit a dense initial burst of dark charcoal/orange-lit billowing smoke puffs (`14` puffs at detonation + continued rising column for `2.4 s`) and `20–28` high-velocity arcing hot sparks/debris.
     - Keep `slot.duration = 5.5` seconds so explosions linger dramatically.
2. **Decisive Bomb & Rocket Blast Parameters (`src/combat/weapons.js`)**:
   - Increase `WEAPONS.MK82`: `damage: 180`, `splashRadius: 75` (true 500 lb blast radius).
   - Increase `WEAPONS.AIM9`: `damage: 120`, `splashRadius: 32`.
   - Ensure `MK82` and `AIM9` impact events always include accurate `{ kind: 'impact', weapon, position, hitTargetId, splashRadius, damage }`.
   - When an `AIM9` is fired without a locked target (`lockedTarget == null`), give it gentle gravity drop after motor burn (`age > burnTime`) so stray rockets eventually impact terrain rather than flying horizontally into infinity.
   - Keep **100% compatibility** with all existing checks in `tests/weapons_test.mjs` and `tests/vfx_test.mjs`!

## File Ownership (STRICT)
Modify ONLY:
- `src/sim/vfx.js`
- `src/combat/weapons.js`
- `tests/vfx_test.mjs`
- `tests/weapons_test.mjs`

Do NOT modify any other files.

## Verification
1. Add checks in `tests/vfx_test.mjs` verifying that `spawnExplosion(pos, 4.5)` remains visibly active (`activeExplosions >= 1`) past `t = 1.2 s`, spawns rich smoke/spark particles (`activeParticles >= 25`), and cleanly completes after `duration`.
2. Verify `tests/weapons_test.mjs` confirms `MK82` has `splashRadius >= 70` and `damage >= 160`, and all CCIP/gun/AIM-9 checks pass.
3. Both `node tests/vfx_test.mjs` and `node tests/weapons_test.mjs` must exit with code `0`.
