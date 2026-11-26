# Feature 30 — Vipava Valley Hero Scenarios, Soča Canyon Run & Authentic *Burja* Wind

## Goal
Make the real 100×100 km **Vipava Valley** theater the star showcase of FALCON / INFINITE by adding:
1. Authentic **Vipava *Burja*** northeast katabatic wind preset (`WIND.burja`) with fixed NE heading (`045°`) and violent lee-wave rotor turbulence.
2. **3 bespoke Vipava Valley missions** anchored to real baked landmarks (`soca_run`, `nanos_sead`, `adriatic_cap`).
3. A 3D glowing sky-gate course module (`src/combat/canyon_run.js`) for the *Top Gun: Maverick*-style **Soča & Vipava Canyon Run**.

## Owned Files (DO NOT modify files outside this list)
- `src/config.js`
- `src/sim/weather.js`
- `src/combat/missions.js`
- `src/combat/canyon_run.js` (new)
- `tests/vipava_scenarios_test.mjs` (new)

## Detailed Specification

### 1. Authentic Vipava *Burja* Wind (`src/config.js` & `src/sim/weather.js`)
- In `src/config.js`, add a new entry to `WIND`:
  ```js
  burja: {
    label: 'BURJA · 42 KT NE',
    speed: 21.6,
    gustiness: 1.0,
    turbulence: 1.55,
    dirRad: Math.PI * 0.75, // blows FROM NE (045°) TOWARD SW (225°): windX < 0, windZ > 0
  }
  ```
  *(World convention: North = `-Z`, East = `+X`. A wind blowing FROM NE pushes aircraft SW: `-X, +Z`, i.e. `cos(135°) = -0.707, sin(135°) = +0.707`.)*
- In `src/sim/weather.js`:
  - When the active `WIND[this.windPresetName]` defines `dirRad != null`, lock `this.windAngle` smoothly toward `windCfg.dirRad` (plus subtle `±0.12 rad` gusting veer) instead of drifting continuously.
  - Ensure `windAt()` remains 100% backwards-compatible and adds crisp gust pulses when `windPresetName === 'burja'`.

### 2. Bespoke Vipava Valley Missions (`src/combat/missions.js`)
Add 3 new entries to `MISSIONS`:
- `soca_run`:
  - `id: 'soca_run'`, `label: 'SOČA CANYON RUN'`, `short: 'CANYON'`
  - `briefing: 'Low-level timed gate run from Ajdovščina through Vogršček, Gorizia, Solkan Bridge & Sveta Gora.'`
  - `theater: 'vipava'`
  - Spawns 0 hostile targets (pure high-speed canyon race), sets initial steerpoint to Gate 1, and emits an AWACS/range-control launch callout (`"RANGE CONTROL: VIPER 1-1 CLEARED HOT FOR SOČA CANYON RUN — STAY LOW!"`).
- `nanos_sead`:
  - `id: 'nanos_sead'`, `label: 'NANOS SEAD'`, `short: 'NANOS'`
  - `briefing: 'Destroy hostile SA-6 & early-warning radar perched on Nanos ridge and the Vipava H4 Viaduct.'`
  - `theater: 'vipava'`
  - Places real-coordinate targets using `world.heightAt`:
    - `RADAR` near Nanos Broadcast Tower (`x: 12750, z: 12800`)
    - `SAM` (SA-6 battery) on Nanos plateau (`x: 13080, z: 12650`)
    - `SAM` ambush overlooking Vipava H4 Viaduct (`x: 4720, z: 4320`)
    - `DEPOT` fortified logistics site near Vipava (`x: 5200, z: 4850`)
  - Landmark-aware AWACS radio callouts (`"OVERLORD: POP-UP SA-6 ON NANOS RIDGE — CLEARED TO ENGAGE."`).
- `adriatic_cap`:
  - `id: 'adriatic_cap'`, `label: 'ADRIATIC INTERCEPT'`, `short: 'ADRIATIC'`
  - `briefing: 'Intercept hostile MiG-29 flight sweeping inland from the Gulf of Trieste toward Nova Gorica.'`
  - `theater: 'vipava'`
  - Spawns 3 hostile `BANDIT` MiG-29s approaching from Gulf of Trieste / Faro della Vittoria (`x: -11000, z: 22000`, `x: -13500, z: 19500`, `x: -9000, z: 24000`) at 1,800–2,400 m altitude heading north toward Nova Gorica (`-18000, -7000`).
  - Landmark-aware AWACS callout (`"OVERLORD: FAST MOVERS FEET DRY OVER TRIESTE — INTERCEPT!"`).

Preserve all existing missions (`free`, `sead`, `strike`, `cap`) and ensure existing `tests/missions_test.mjs` continues passing 100%.

### 3. Soča & Vipava Canyon Run System (`src/combat/canyon_run.js`)
Export `CANYON_GATES` and `class CanyonRunSystem`:
- **Course (8 real-world Vipava Valley gates)**, each `{ id, name, x, z, agl, radius, headingDeg }`:
  1. `LJAJ DEPARTURE` (`x: -2200, z: -150`, agl `110`, radius `130`, hdg `270`)
  2. `VIPAVA VALLEY` (`x: -7500, z: -850`, agl `110`, radius `130`, hdg `275`)
  3. `VOGRŠČEK DAM` (`x: -13005, z: -1534`, agl `95`, radius `125`, hdg `290`)
  4. `ŠEMPETER APPROACH` (`x: -16800, z: -4200`, agl `100`, radius `125`, hdg `315`)
  5. `GORIZIA CASTLE` (`x: -19500, z: -6350`, agl `115`, radius `125`, hdg `010`)
  6. `SOČA GORGE ENTRY` (`x: -18600, z: -8600`, agl `90`, radius `115`, hdg `015`)
  7. `SOLKAN ARCH BRIDGE` (`x: -18201, z: -10035`, agl `85`, radius `110`, hdg `020`)
  8. `SVETA GORA FINISH` (`x: -17720, z: -11947`, agl `130`, radius `145`, hdg `015`)
- **Headless-safe**: `new CanyonRunSystem(scene = null)` skips Three.js mesh construction if `scene === null`.
- **3D Visuals (when `scene` provided)**:
  - Each gate is a glowing hexagonal/circular ring (`TorusGeometry` with `MeshBasicMaterial`, `toneMapped: false`), oriented perpendicular to `headingDeg`, grounded at `heightAt(x, z) + agl`.
  - Active next gate pulses bright cyan-gold (`0x38ffe0`) with a subtle vertical light-pillar beacon above it so you can spot it kilometers away; upcoming gates glow dim amber (`0xffaa44`); passed gates turn emerald (`0x44ff88`) and fade out.
- **State & API**:
  - `start(world)` — builds/resets gates using `world?.heightAt || terrainHeight`, resets `active = true`, `gateIndex = 0`, `elapsed = 0`, `finished = false`, `medal = null`, `splits = []`, `bestSpeedKts = 0`.
  - `stop()` — hides/clears gates, sets `active = false`.
  - `update(dt, aircraftPos, speedMs)` — advances timer once gate 0 is crossed (or immediately on start), checks sphere/plane passage within `gate.radius` of active gate, returns `{ gatePassed: gate|null, finished: bool, medal: 'GOLD'|'SILVER'|'BRONZE'|null }`.
  - Medal thresholds (for ~24 km course at ~450–650 kt): `GOLD <= 95s`, `SILVER <= 125s`, `BRONZE > 125s`.
  - `getState()` — returns `{ active, gateIndex, totalGates, nextGate, elapsed, finished, medal, splits, distToNextM, bearingToNextDeg }` for HUD/steerpoint integration.
  - `dispose()` — cleans up geometries/materials/group.

### 4. Tests (`tests/vipava_scenarios_test.mjs`)
- Verify `WIND.burja` exists and `WeatherSystem('few', 'burja')` blows from NE (`windX < 0`, `windZ > 0`) with strong speed (`> 18 m/s`).
- Verify `MISSIONS.soca_run`, `MISSIONS.nanos_sead`, `MISSIONS.adriatic_cap` exist and `MissionDirector` generates valid target specs for `nanos_sead` (Nanos/Viaduct coords) and `adriatic_cap` (Trieste bandits).
- Verify `CanyonRunSystem` headless lifecycle: `start`, gate-by-gate progression, timer accumulation, finish detection, and Gold/Silver/Bronze medal assignment.
- Run `npm test` and confirm all tests pass.
