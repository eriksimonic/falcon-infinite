# Feature 04 — Combat VFX, Wingtip Vortices, Mach Cone & Explosions

## Inspiration
Nothing makes an F-16 feel alive like pulling 6G into a hard break-turn and watching condensation trails ribbon off the wingtips, punching through Mach 1.0 with a flashing vapor cone, and seeing massive fiery explosions and dark oil-fire smoke columns rising over destroyed Baghdad targets from 10 km away.

## File Ownership (STRICT)
Create ONLY:
- `src/sim/vfx.js`
- `tests/vfx_test.mjs`

Do NOT modify any existing files.

## Module Contract (`src/sim/vfx.js`)
Export `export class CombatVFX`:

### Constructor
`new CombatVFX(scene)` — `scene` may be `null` in headless tests (all particle/pool logic still runs cleanly without throwing).

### Visual Systems Owned by `CombatVFX`
1. **Wingtip & LEX High-G Vapor Ribbons**:
   - Two ribbon trail pools anchored to the F-16 wingtips (`(±4.95, 0.02, 2.25)` in aircraft local frame).
   - Intensity ramps in smoothly when `!flight.onGround && flight.speed > 90 && (Math.abs(flight.gForce) > 3.4 || Math.abs(flight.aoa) > 0.17)` (boosted slightly in humid/cloudy weather).
   - Smooth fading alpha along ribbon history (`36` segments per wingtip), zero allocation per frame (preallocated `BufferGeometry` updated in place).
2. **Transonic Mach 1.0 Vapor Cone**:
   - Translucent tapered double-cone halo around the fuselage (`mach` between `0.95` and `1.06`, peaking sharply near `1.00`).
   - Emits a rising-edge boolean `sonicBoom` when crossing `mach >= 1.0` from below (`cooldown >= 4s`) so audio can trigger a crisp sonic boom crack!
3. **Explosion & Shockwave Pool (`spawnExplosion(pos, scale = 1)`)**:
   - Multi-stage procedural explosion (pooled, no GC churn):
     - Bright white-orange core flash sphere expanding rapidly & fading over `0.45s`.
     - Expanding golden-orange shockwave ring (`RingGeometry` / torus) flat near ground or billboarded.
     - 12–18 hot flying debris/spark embers arcing with gravity.
     - Dark billowing smoke puffs rising upward.
4. **Persistent Burning Wreck Smoke Plumes (`spawnSmokePlume(pos, duration = 60)`)**:
   - Spawns dark rising black-grey smoke clouds (classic Desert Storm / *Back to Baghdad* horizon landmark!) above destroyed ground targets, drifting gently with the live wind `(weather.state.windX, weather.state.windZ)`.
5. **Missile / Flare Smoke Trail Puffs (`spawnTrail(pos, color = 0xe8eef2, size = 1.6)`)**:
   - Lightweight instanced/pooled puff system for AIM-9, SAM, and magnesium flare smoke trails drifting with wind and fading smoothly over `1.4–2.5s`.
6. **Cannon Muzzle Flash (`triggerMuzzleFlash(flight)`)**:
   - Brief bright flickering star/cone flash at the M61A1 gun port (`(-0.75, 0.25, -2.5)` local) lasting `0.06s`.

### Methods
- `reset()` — Clears all active explosions, plumes, trails, and vapor ribbons.
- `spawnExplosion(pos, scale = 1)`
- `spawnSmokePlume(pos, duration = 60)`
- `spawnTrail(pos, color, size)`
- `triggerMuzzleFlash(flight)`
- `update(dt, flight, weather, camera)` — Updates all active pools, ribbons, Mach cone, and muzzle flash. Returns `{ sonicBoom: boolean, activeParticles: number, activeExplosions: number, activePlumes: number }`.

## Verification (`tests/vfx_test.mjs`)
Write a standalone headless Node test verifying:
1. `CombatVFX(null)` initializes and updates cleanly with zero errors.
2. Pulling 6G at 220 m/s activates wingtip vapor trails; returning to 1G decays them to 0.
3. Crossing `speed` from `320 m/s` (M 0.94) to `350 m/s` (M 1.03) triggers `sonicBoom === true` once and respects cooldown.
4. `spawnExplosion`, `spawnSmokePlume`, and `spawnTrail` populate pools, advance with `dt`, drift with wind, and expire cleanly without leaking memory.
5. `reset()` empties all pools.
