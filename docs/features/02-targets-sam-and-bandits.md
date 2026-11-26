# Feature 02 — Ground Targets, SAM Batteries & Bandit Patrols

## Inspiration
*F-16: Back to Baghdad* was defined by tension: weaving low through valleys to dodge radar-guided SAM batteries, hunting mobile launchers and radar domes, and tangling with patrolling MiG interceptors.

## File Ownership (STRICT)
Create ONLY:
- `src/combat/targets.js`
- `tests/targets_test.mjs`

Do NOT modify any existing files.

## Module Contract (`src/combat/targets.js`)
Export `export class TargetSystem`:

### Constructor
`new TargetSystem(scene)` — `scene` may be `null` in headless tests.

### Target Data Shape
Every target in `this.targets` exposes:
```js
{
  id: string,
  kind: 'RADAR' | 'SAM' | 'DEPOT' | 'BANDIT',
  label: string,             // e.g. 'SA-6 RADAR', 'SA-2 BATTERY', 'FUEL DEPOT', 'MIG-29'
  airborne: boolean,
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  heading: number,           // radians
  hp: number,
  maxHp: number,
  alive: boolean,
  hitRadius: number,         // metres (e.g. RADAR 18, SAM 14, DEPOT 26, BANDIT 16)
  radarActive: boolean,      // true if emitting radar (shows on RWR)
  radarRange: number,        // metres (e.g. 14000 for SAM/RADAR, 11000 for BANDIT)
  lockState: 'IDLE' | 'SEARCH' | 'LOCK' | 'LAUNCH',
  mesh: THREE.Object3D | null,
}
```

### Incoming Enemy SAM Missiles (`this.enemyMissiles`)
Each active enemy SAM exposes:
```js
{
  id: string,
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  ttl: number,
  decoyed: boolean,
  sourceId: string,
  mesh: THREE.Object3D | null,
}
```

### Methods
1. `clear()` — Removes/disposes all target & SAM meshes, clears lists.
2. `spawnScenario(specs, world)` — Deterministic spawning from an array of objective specs `[{ id, kind, label, x, z, alt?, orbitRadius?, speed? }]`:
   - Ground targets (`RADAR`, `SAM`, `DEPOT`) sit accurately on `world.heightAt(x, z)`.
   - Procedural 3D meshes (when `scene` is provided):
     - `RADAR`: concrete pad + rotating dish tower + glowing status beacon.
     - `SAM`: olive-drab tracked transporter chassis + tilted 3-rail missile launcher rack.
     - `DEPOT`: pair of cylindrical fuel/ammo storage tanks + hardened bunker + perimeter fence markers.
     - `BANDIT`: sleek swept-wing aggressor fighter silhouette (twin-tail dark grey/camo MiG-29-style jet with glowing exhaust).
3. `applyImpact(impactEvent)` — Applies splash & direct damage to all `alive` targets within `hitRadius + impactEvent.splashRadius` (with linear falloff beyond `hitRadius`). When a target transitions `alive -> false`, switches its mesh to charred/ruined state and returns array of destroyed target objects `[{ id, kind, label, position }]`.
4. `findLockTarget(flight, weaponType)` — Finds best target inside forward seeker cone:
   - `AIM9`: prefers `airborne` targets within `14000 m` and `24°` off-boresight (can also lock hot ground targets if within `6000 m` and `15°`).
   - `GUN` / `MK82`: locks closest alive target within `16000 m` and `22°` off-boresight.
   - Returns target object or `null`.
5. `update(dt, flight, world, flares = [])`:
   - Animates rotating radar dishes and patrolling `BANDIT` aircraft (smooth banking racetrack/circular orbit around anchor point, gently banking into turns, staying safely above `world.heightAt(x, z) + 350`).
   - Runs **SAM / Radar AI state machine**:
     - `SEARCH`: player within `radarRange` and line-of-sight/altitude above `45 m AGL` (terrain-masking below `45 m AGL` breaks radar lock — classic Wild Weasel tactic!).
     - `LOCK`: sustained detection for `3.5s` inside `9500 m`.
     - `LAUNCH`: fires an enemy SAM (`speed ~460 m/s`, turn-limited proportional nav, max `18s` flight) with `11s` reload cooldown.
   - **Flare Decoying**: if any active flare in `flares` passes within `240 m` of an incoming SAM while the SAM is closing, the SAM has a high deterministic chance (or guaranteed if flare is within `140 m` and player is maneuvering/banking) to switch `decoyed = true` and veer off harmlessly!
   - Checks SAM proximity to player (`< 24 m` -> emits `{ kind: 'playerHit', sourceId, position }`).
   - Returns `{ events: [...], rwrContacts: [...] }` where each `rwrContact` has `{ id, kind, bearingRad, distance, state: 'SEARCH' | 'LOCK' | 'LAUNCH', isMissile: boolean }`.

## Verification (`tests/targets_test.mjs`)
Write a standalone headless Node test verifying:
1. Spawning `RADAR`, `SAM`, `DEPOT`, `BANDIT` targets places ground units on `world.heightAt` and bandits airborne.
2. `applyImpact` reduces HP and destroys targets with splash falloff, returning destruction events once.
3. SAM transitions `SEARCH -> LOCK -> LAUNCH` when player flies within range above `45 m AGL`, and loses lock when terrain-masking below `35 m AGL`.
4. Deploying flares within `140 m` decoys an incoming SAM so it misses the player.
5. `findLockTarget` selects an airborne bandit inside the AIM-9 seeker cone and ignores targets behind the jet.
