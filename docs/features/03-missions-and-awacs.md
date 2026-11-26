# Feature 03 — Dynamic Missions, Steerpoints & AWACS Radio Comms

## Inspiration
*F-16: Back to Baghdad* nailed the feeling of flying a real theater sortie: getting briefed on target packages, following HUD steerpoints to the objective area, hearing AWACS call out bogeys and SAM launches, and calling *"Shack!"* or *"Splash one!"* on the radio.

## File Ownership (STRICT)
Create ONLY:
- `src/combat/missions.js`
- `tests/missions_test.mjs`

Do NOT modify any existing files.

## Module Contract (`src/combat/missions.js`)
Export `MISSIONS` metadata and `export class MissionDirector`:

```js
export const MISSIONS = {
  free:   { id: 'free',   label: 'FREE FLIGHT',   short: 'FREE',   briefing: 'Open skies — fly anywhere, practice weapons or explore.' },
  sead:   { id: 'sead',   label: 'WILD WEASEL',   short: 'SEAD',   briefing: 'Suppress enemy SA-6 SAM battery and early-warning radar guarding the valley.' },
  strike: { id: 'strike', label: 'BAGHDAD STRIKE',short: 'STRIKE', briefing: 'Low-level deep strike on fortified fuel depot and radar complex.' },
  cap:    { id: 'cap',    label: 'BARCAP SWEEP',  short: 'CAP',    briefing: 'Intercept hostile MiG-29 patrol flight before they reach friendly airspace.' },
};
```

### Constructor
`new MissionDirector()`

### Methods
1. `startMission(missionId, spawn, world)`:
   - Uses `mulberry32` seeded from `spawn.x, spawn.z, missionId` so target packages are deterministic and placed cleanly along/near the takeoff corridor (`6 km` to `14 km` ahead of the spawn runway heading, avoiding ocean `heightAt <= 1` when placing ground targets by searching candidate offsets!).
   - Returns `targetSpecs` array matching Feature 02's `TargetSystem.spawnScenario(specs, world)` format:
     - `free`: `[]` (or optional 2 harmless range targets? Keep `free` empty/peaceful so Free Flight stays pure!).
     - `sead`: 1 `RADAR` + 2 `SAM` batteries guarding an outpost `7–10 km` out.
     - `strike`: 2 `DEPOT` bunkers + 1 `RADAR` + 1 `SAM` defender `9–12 km` out.
     - `cap`: 3 `BANDIT` fighters patrolling `8–13 km` out at `1400–2800 m` altitude.
   - Queues opening AWACS radio callout (e.g. `MAGIC: VIPER 1-1 CLEARED HOT — STEERPOINT 1, 092 FOR 6 NM`).
2. `notifyDestroyed(destroyedTargets)` — Updates objective counter, score (`+250` Depot/Radar, `+350` SAM, `+500` Bandit), and pushes authentic tactical radio messages (`VIPER 1-1: SHACK! TARGET DESTROYED`, `VIPER 1-1: SPLASH ONE BANDIT`, and upon final objective `MAGIC: ALL OBJECTIVES DESTROYED — RTB HOME PLATE`).
3. `notifyMissileLaunch(rwrContact)` — Rate-limited (`>= 6s`) urgent radio warning (`MAGIC: SPIKE! SAM LAUNCH BEARING 240 — DEFEND & FLARE!`).
4. `notifyPlayerHit()` — Pushes damage/warning callout (`VIPER 1-1: TAKING FIRE!`).
5. `update(dt, flight, targets = [], rwrContacts = [])`:
   - Selects the active **Steerpoint**:
     - While primary objectives remain alive: nearest alive objective (`label`, `x`, `y`, `z`, `kind`).
     - Once all objectives are destroyed (`status === 'RTB'`): home spawn airport (`HOME PLATE`).
     - When back within `1500 m` of home airport and `flight.onGround && flight.speed < 12` while `status === 'RTB'`: marks `status = 'COMPLETE'` and pushes mission complete callout.
   - Computes steerpoint navigation:
     - `bearingDeg` (`0..360`), `distanceM`, `distanceNm`, `etaSec` (clamped sensibly when slow), `relBearingDeg` (`-180..+180` relative to aircraft heading).
   - Ages out radio log messages (keeps last 3 active messages, each visible for `7.5s` with fade).
   - Returns mission snapshot:
     ```js
     {
       id, label, status: 'FREE' | 'ACTIVE' | 'RTB' | 'COMPLETE',
       score, destroyedCount, totalObjectives,
       steerpoint: { label, x, y, z, bearingDeg, relBearingDeg, distanceM, distanceNm, etaSec } | null,
       radio: [{ sender, text, priority: 'info'|'warn'|'urgent', age, ttl }],
     }
     ```

## Verification (`tests/missions_test.mjs`)
Write a standalone headless Node test verifying:
1. Each mission (`free`, `sead`, `strike`, `cap`) generates expected deterministic target counts and places ground targets on dry land (`heightAt > 1`).
2. Steerpoint bearing/distance/relBearing math matches `ARCHITECTURE.md` conventions (North = `-Z`, East = `+X`).
3. Destroying all targets transitions `ACTIVE -> RTB`, emits radio callouts, and points steerpoint back to `HOME PLATE`.
4. Landing at home base transitions `RTB -> COMPLETE`.
5. Radio messages expire cleanly as `dt` advances.
