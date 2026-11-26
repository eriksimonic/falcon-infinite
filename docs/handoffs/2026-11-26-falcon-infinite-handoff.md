# FALCON / INFINITE — Development & Subagent Workflow Handoff (2026-11-26)

## 1. Project Snapshot
**FALCON / INFINITE** (`/home/erik/Documents/testflight`) is a zero-build-asset, procedural Three.js + Vite F-16C Block 50 flight & tactical combat simulator inspired by *F-16: Back to Baghdad*.

- **Repo**: Git initialized on `main` (clean commit history from initial baseline through Waves 1–4, Control Map, real F-16 audio samples, and 3D ballistic HUD alignment).
- **Stack**: Plain ES modules (`"type": "module"`), `three`, `vite`, zero other runtime npm dependencies.
- **Commands**:
  - `npm run dev` — Vite dev server (`http://127.0.0.1:5173`, auto-enables MCP browser bridge)
  - `npm run build` — Production bundle (`dist/`, includes `dist/media/sfx/`)
  - `npm test` — Runs all **16 headless Node test suites** (`tests/*_test.mjs`)
  - `npm run mcp` — Runs the local stdio MCP server (`mcp/server.mjs`, HTTP bridge on `127.0.0.1:5179`)
  - `npm run wso` — Runs the real-time AI WSO / Co-Pilot (`mcp/wso_copilot.mjs`) connected to the local MCP server

---

## 2. How We Develop: Coordinator + Hermes Subagent Workflow (`deepseek-v4.1-flash-1017`)

### Strict Role Split (IMPORTANT — Follow This Rule)
- **AGY (Antigravity) = Coordinator ONLY**:
  - Plans architecture and feature breakdowns.
  - Writes clear, disjoint, worker-ready spec documents in `docs/features/`.
  - Dispatches parallel **Hermes** workers for **ALL implementation** AND **ALL validation**.
  - Reviews worker summaries, manages git commits/handoffs, and coordinates wave ordering — **does NOT write feature implementation code directly**.
- **Hermes (`/home/erik/.local/bin/hermes`) = Implementation & Validation Workers**:
  - `pi` (`/home/erik/.local/bin/pi`) currently has an invalid Alibaba API key (`401 invalid_api_key`).
  - **Hermes** is configured, authenticated, and works reliably with **`deepseek-v4.1-flash-1017`**.

### Exact Worker Invocation Commands

**1. Implementation Worker (parallelizable when file ownership is disjoint):**
```bash
hermes chat -Q --oneshot --yolo \
  --in /home/erik/Documents/testflight \
  -m deepseek-v4.1-flash-1017 \
  --max-turns 30 \
  -q "Read ARCHITECTURE.md and docs/features/<spec>.md thoroughly. Implement Feature <N> strictly following the module contract and file ownership rules: create/modify ONLY <owned files>. Do not touch any other files. Run 'node tests/<suite>_test.mjs' until all checks pass with exit code 0. Finish with a brief summary."
```

**2. Validation Worker (run with `--reasoning high` after implementation/integration):**
```bash
hermes chat -Q --oneshot --yolo \
  --in /home/erik/Documents/testflight \
  -m deepseek-v4.1-flash-1017 \
  --reasoning high \
  --max-turns 30 \
  -q "Validate Feature <N> against docs/features/<spec>.md and ARCHITECTURE.md. Run 'npm test' and 'npm run build', audit edge cases, verify contracts and integration behavior, and report any defects or confirm all checks pass."
```

> **Tip**: Always use `run_command` with `WaitMsBeforeAsync: 500` and `NotificationTimeoutSeconds: 300` (no polling — wait reactively for completion notifications). Use `--max-turns 30` (or `35`) for complex features with large test suites.

### Wave-Based Parallel Execution Rules (Zero Collisions)
1. **Coordinator** writes per-feature spec docs in `docs/features/<NN>-<slug>.md` with:
   - Exact **strict file ownership** (100% disjoint files for every parallel worker in a wave!)
   - Exact **exported classes/methods & data shapes**
   - **Headless-safe requirement** (`scene = null`, no DOM/browser globals at import time)
   - **Dedicated unit test** (`tests/<feature>_test.mjs`)
2. **Parallel Implementation Wave (Hermes)**: launch all disjoint workers simultaneously.
3. **Integration Wave (Hermes)**: when shared files (`main.js`, `hud.js`, `menu.js`, `index.html`, `package.json`) need wiring, delegate that to a dedicated sequential Hermes worker with its own integration spec.
4. **High-Reasoning Validation (Hermes `--reasoning high`)**: dispatch a Hermes validator at `--reasoning high` to run `npm test`, `npm run build`, and audit physics/audio/UI contracts before the Coordinator commits.

---

## 3. Current Architecture & Implemented Systems

### Core & Audio
- `src/core/audio.js` — Layered procedural F-16 turbofan engine (sub-bass thrust foundation, dual-formant nozzle cavity body, N1/N2 spool whine, intake howl, afterburner ignition & crackle, canopy interior/exterior filtering) + full atmospheric wind audio (ambient gusts, resonant crosswind howl, density-scaled slipstream, transonic hiss, buffet).
- `src/core/combat_audio.js` — Hybrid WebAudio sample loader preloading **13 real F-16/military clips** from `public/media/sfx/` (Vulcan 20mm, AIM-9 growl, missile launch, bomb release, flare pop, explosions, sonic boom, RWR tones, KC-135 boom contact) with pitch randomization, distance lowpass filtering, and automatic procedural fallback.
- `src/core/betty.js` — Bitching Betty priority voice warning queue (Web Speech API + fallback chime).
- `src/core/mcp_bridge.js` + `mcp/server.mjs` — Zero-dependency stdio JSON-RPC 2.0 MCP server + loopback `127.0.0.1:5179` browser bridge exposing 8 live control tools (`get_telemetry`, `set_flight_state`, `set_controls`, `combat_action`, `set_environment`, `start_mission`, `send_radio`, `capture_screenshot`).

### Flight, World & Immersion
- `src/sim/weather.js` — Multi-layer 3D wind field (boundary layer, Ekman veer, 9.5 km jetstream, rolling gusts, thermals/ridge lift) + `WIND` presets (`auto`, `calm`, `breeze`, `windy`, `gale`).
- `src/aircraft/flight.js` — FBW flight model with live wind shear, gust bumps, crosswind weathervaning, lateral parked tire grip.
- `src/aircraft/autopilot.js` — `AutopilotSystem` (`OFF` / `ALT_HDG` / `ATT`) + `ILSComputer` (glideslope/localizer, radar-altitude callouts, touchdown grading).
- `src/aircraft/ejection.js` — ACES II ejection sequence (canopy jettison, rocket seat, wind-drifting parachute, chase cam).
- `src/sim/fuel.js` — 7,000 lb internal fuel model + orbiting 3D KC-135 Stratotanker aerial refueling.
- `src/sim/traffic.js` — 4 high-altitude contrail airliners + `VIPER 1-2` F-16 wingman in fingertip formation.
- `src/world/terrainview.js` & `src/sim/sky.js` — Switchable `TEMPERATE` and `DESERT STRIKE` (Baghdad arid sandstone + warm dust haze) theaters.

### Combat, VFX & UI
- `src/combat/weapons.js` — M61A1 20mm Vulcan, AIM-9 Sidewinder (proportional nav), Mk-82 bombs, countermeasure flares, exact 3D `computeCCIP` + `computeGunSolution` (zero-dispersion terrain impact + gravity/velocity-compensated lead point) + `boresightPoint`.
- `src/combat/targets.js` — `RADAR`, `SAM` (search/lock/launch, `<45 m AGL` terrain masking, flare decoys), `DEPOT`, and patrolling `BANDIT` MiG-29s.
- `src/combat/missions.js` — 4 sorties (`FREE FLIGHT`, `WILD WEASEL`, `BAGHDAD STRIKE`, `BARCAP SWEEP`), steerpoints, scoring, RTB landing, and `MAGIC`/`VIPER 1-1` AWACS radio log.
- `src/sim/vfx.js` — Preallocated/pooled high-G wingtip vapor ribbons, Mach 1.0 vapor cone + sonic boom trigger, muzzle flash, missile/flare trails, explosions/shockwaves, and wind-drifting wreck smoke plumes.
- `src/ui/hud.js` & `src/ui/tactical.js` — Cockpit F-16 HUD + **minimal follow-camera micro-HUD** (unobstructed center, subtle level reference, true 3D-projected gun/CCIP/lead/AIM-9 pippers, RWR scope, NVG phosphor mode, G-LOC blackout/redout).
- `src/ui/kneeboard.js` — Toggleable (`K`) north-up tactical nav map with cached terrain relief, airports (click-to-divert), targets, tanker, steerpoint, and wind barb.
- `src/ui/menu.js` & `src/ui/style.css` — Shared visual color-coded **Control Map** on both Main Menu and ESC Pause screen.

---

## 4. Wave 5 & 6 Completed Roadmap Items (Features 14–18)

All previously listed missing components have now been implemented, integrated, and validated (`16/16` test suites passing, warning-free split Vite build):
1. **Ultra-Fast AI WSO / Co-Pilot over MCP (`mcp/wso_copilot.mjs`, `npm run wso`, `tests/wso_test.mjs`)**:
   - Zero-dependency stdio JSON-RPC 2.0 MCP client + deterministic real-time WSO engine (`< 2 ms` tick): auto-flare defense on SAM launch, deduplicated threat/pull-up/bingo-fuel radio callouts, `patrol`/`cruise`/`evade` scenario automation, and optional non-blocking LLM advisor hook (`WSO_LLM_URL`/`WSO_LLM_KEY`).
   - Live bridge (`src/core/mcp_bridge.js` + `mcp/server.mjs`) updated with `vsFpm` telemetry and `'flyby'` camera mode support.
2. **ILS HUD Needles & Kneeboard Diversion Steerpoint Wiring (`src/ui/hud.js`, `src/main.js`)**:
   - Cockpit HUD renders F-16 localizer & glideslope needles + scale dots + `ILS RWY XX · X.X NM`; External HUD renders a minimal non-intrusive ILS pill preserving the unobstructed center viewport.
   - Clicking an airport (or `CVN71` carrier) on the Kneeboard (`K`) sets `_divertAirport`, overriding both the active steerpoint (in Free Flight / when no combat steerpoint is active) and the tuned ILS runway.
3. **Offshore Nimitz-Class Aircraft Carrier Group (`src/world/carrier.js`, `src/world/world.js`, `tests/carrier_test.mjs`)**:
   - Procedural `CVN-71` placed deterministically in offshore water with a landable `18.5 m` flight deck, animated 3D FLOLS meatball + HUD meatball cue, 4 arresting wires (with wheel-height deck rest and wire grading), and bow steam catapult launch (`82 m/s` in `2.2 s`).
4. **Tower / Ground Flyby Camera with Doppler Audio + 30-Second Instant Replay (`src/aircraft/aircraft.js`, `src/core/audio.js`, `src/aircraft/replay.js`, `tests/replay_test.mjs`)**:
   - Added `'flyby'` camera mode (`C`) with auto-reanchoring telephoto tripod tracking and radial-velocity Doppler pitch shift in `SimAudio`.
   - Zero-GC 30-second ring buffer (`ReplaySystem`) toggled with `F2` (`F4` cycles `1× / 0.5× / 2×` speed), syncing F-16 exterior visuals, AGL/VS telemetry, and HUD replay banner.
5. **Cockpit Polish, Cloud-Entry Mist, Tire Touchdown Smoke & Code-Splitting (`src/aircraft/cockpit.js`, `src/sim/clouds.js`, `src/sim/vfx.js`, `vite.config.js`, `tests/cockpit_test.mjs`)**:
   - 3D AoA indexer lights beside HUD combiner, flashing Master Caution lamp, night cockpit backlighting, and airspeed-scaled canopy raindrop streaks.
   - Dynamic cloud-entry radial mist wash (`CloudSystem.getCloudDensity` -> HUD) and pooled tire touchdown / catapult steam puffs (`CombatVFX.spawnTireSmoke`).
   - `vite.config.js` splits `three` into `vendor-three` (`353 kB` app + `592 kB` vendor, zero chunk-size warnings).

### Known Minor Quirks / Notes
- All feature specs live in `docs/features/` (`README.md`, `01`–`18`) — keep new feature specs in the same numbering sequence (`19-...`).
- User strongly prefers **follow/chase camera** as primary view: always keep the external HUD clean and minimal (micro-HUD style) so nothing overpowers the aircraft and world view.
- If `pi` API key is refreshed later, `pi --model alibaba-plan/deepseek-v4.1-flash-1017` can also be used, otherwise keep using `hermes chat -Q --oneshot --yolo -m deepseek-v4.1-flash-1017`.
