# FALCON / INFINITE — Development & Subagent Workflow Handoff (2026-11-26)

## 1. Project Snapshot
**FALCON / INFINITE** (`/home/erik/Documents/testflight`) is a zero-build-asset, procedural Three.js + Vite F-16C Block 50 flight & tactical combat simulator inspired by *F-16: Back to Baghdad*.

- **Repo**: Git initialized on `main` (clean commit history from initial baseline through Waves 1–4, Control Map, real F-16 audio samples, and 3D ballistic HUD alignment).
- **Stack**: Plain ES modules (`"type": "module"`), `three`, `vite`, zero other runtime npm dependencies.
- **Commands**:
  - `npm run dev` — Vite dev server (`http://127.0.0.1:5173`, auto-enables MCP browser bridge)
  - `npm run build` — Production bundle (`dist/`, includes `dist/media/sfx/`)
  - `npm test` — Runs all **12 headless Node test suites** (`tests/*_test.mjs`)
  - `npm run mcp` — Runs the local stdio MCP server (`mcp/server.mjs`, HTTP bridge on `127.0.0.1:5179`)

---

## 2. How We Develop: Parallel Subagent Workflow with Hermes (`deepseek-v4.1-flash-1017`)

### Why Hermes instead of `pi`
- `pi` (`/home/erik/.local/bin/pi`) currently has an expired/invalid Alibaba Cloud API key (`401 invalid_api_key`).
- **Hermes** (`/home/erik/.local/bin/hermes`) is configured, authenticated, and works reliably with **`deepseek-v4.1-flash-1017`**!

### Exact Worker Invocation Command
Launch independent workers in parallel using `run_command` (`WaitMsBeforeAsync: 500`, `NotificationTimeoutSeconds: 300`, no polling — wait reactively for completion notifications):

```bash
hermes chat -Q --oneshot --yolo \
  --in /home/erik/Documents/testflight \
  -m deepseek-v4.1-flash-1017 \
  --max-turns 30 \
  -q "Read ARCHITECTURE.md and docs/features/<spec>.md thoroughly. Implement Feature <N> strictly following the module contract and file ownership rules: create/modify ONLY <owned files>. Do not touch any other files. Run 'node tests/<suite>_test.mjs' until all checks pass with exit code 0. Finish with a brief summary."
```

> **Tip**: Use `--max-turns 30` (or `35`) for complex features with large test files; `--max-turns 25` was occasionally just 1–2 turns short when workers wrote extensive probe/verification tests.

### Wave-Based Parallel Execution Rules (Zero Collisions)
1. **Write per-feature spec docs first** in `docs/features/<NN>-<slug>.md` with:
   - Exact **strict file ownership** (disjoint files for every parallel worker in a wave!)
   - Exact **exported classes/methods & data shapes** (so modules snap together cleanly)
   - **Headless-safe requirement** (`scene = null`, no DOM/browser globals at import time)
   - **Dedicated unit test** (`tests/<feature>_test.mjs`)
2. **Run Wave N workers in parallel** — because file ownership is 100% disjoint, 2–5 Hermes workers can run simultaneously with zero merge conflicts.
3. **Commit verified wave modules** once each worker's `node tests/<feature>_test.mjs` exits 0.
4. **Run Integration sequentially** in the coordinator agent (wiring into shared files: `src/main.js`, `src/ui/hud.js`, `src/ui/menu.js`, `index.html`, `package.json`), then run `npm test && npm run build` and commit.

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

## 4. Unfinished Business & Next Roadmap Ideas

### High-Priority Next Items (Discussed with User)
1. **Ultra-Fast AI WSO / Co-Pilot over MCP**:
   - The MCP server (`mcp/server.mjs`) and browser bridge (`src/core/mcp_bridge.js`) are already built and tested.
   - Next step: design a lightweight real-time AI Co-Pilot runner (using an ultra-fast model like Gemini Flash-Lite or a fast local model) connected to `mcp/server.mjs` that watches `get_telemetry` and acts as a real WSO/AWACS: calling threats via `send_radio`, popping flares on SAM launch, managing autopilot/route, or running automated flight-test scenarios.
2. **ILS HUD Needles & Kneeboard Diversion Steerpoint Wiring**:
   - `ILSComputer` (`src/aircraft/autopilot.js`) is wired for callouts & touchdown grading, and `t.ils` is passed to `HUD`, but visual **localizer & glideslope needles** are not yet drawn on the HUD when `t.ils.active === true`.
   - `KneeboardMap.pickAirportAt()` selects a diversion airport and shows a toast, and can be wired to override the active steerpoint when no combat objective is active (or in Free Flight).
3. **Additional Non-Combat Polish (from Feature Brainstorm)**:
   - **Offshore Aircraft Carrier Group** (Nimitz-class carrier with Fresnel meatball, arresting wires, steam catapult).
   - **Tower / Ground Flyby Camera with Doppler Audio** + 30-second instant replay buffer.
   - **Cockpit Polish**: AoA indexer lights beside HUD combiner, Master Caution lamp, night cockpit backlighting, and canopy raindrop streaks.
   - **Dynamic Cloud-Entry Mist Wash & Tire Touchdown Smoke Puffs**.
   - **Code-Splitting** (optional): Vite warns `dist/assets/index-*.js` is ~910 kB; dynamic imports or `manualChunks` for `three` can split vendor vs app cleanly.

### Known Minor Quirks / Notes
- All feature specs live in `docs/features/` (`README.md`, `01`–`11`, `12a`, `12b`) — keep new feature specs in the same numbering sequence (`13-...`).
- User strongly prefers **follow/chase camera** as primary view: always keep the external HUD clean and minimal (micro-HUD style) so nothing overpowers the aircraft and world view.
- If `pi` API key is refreshed later, `pi --model alibaba-plan/deepseek-v4.1-flash-1017` can also be used, otherwise keep using `hermes chat -Q --oneshot --yolo -m deepseek-v4.1-flash-1017`.
