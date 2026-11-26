# FALCON / INFINITE — Development & Subagent Workflow Handoff (2026-11-26 Evening)

## 1. Project Snapshot & Live Deployment
**FALCON / INFINITE** (`/home/erik/Documents/testflight`) is a zero-build-asset, procedural + real-world-DEM Three.js + Vite F-16C Block 50 flight & tactical combat simulator inspired by *F-16: Back to Baghdad*.

- **GitHub Repo**: https://github.com/eriksimonic/falcon-infinite (public, PR-only branch protection on `main` for non-admins; owner bypass enabled).
- **Live GitHub Pages URL**: https://eriksimonic.github.io/falcon-infinite/ (auto-deploys on every push to `main` via `.github/workflows/deploy.yml`).
- **Stack**: Plain ES modules (`"type": "module"`), `three`, `vite` (`vendor-three` manual chunk split, `base: './'`), zero other runtime npm dependencies.
- **Commands**:
  - `npm run dev` — Vite dev server (`http://127.0.0.1:5173`, auto-enables MCP browser bridge)
  - `npm run build` — Production bundle (`dist/`, zero warnings, splits `vendor-three` + `index`)
  - `npm test` — Runs all **21 headless Node test suites** (`tests/*_test.mjs`)
  - `npm run mcp` — Runs the local stdio MCP server (`mcp/server.mjs`, HTTP bridge on `127.0.0.1:5179`)
  - `npm run wso` — Runs the real-time AI WSO / Co-Pilot (`mcp/wso_copilot.mjs`) over MCP

---

## 2. How We Develop: Coordinator + Hermes Subagent Workflow (`deepseek-v4.1-flash-1017`)

### Strict Role Split (IMPORTANT — Follow This Rule)
- **AGY (Antigravity) = Coordinator ONLY**:
  - Plans architecture and feature breakdowns.
  - Writes clear, disjoint, worker-ready spec documents in `docs/features/` (next number: **`30-...`**).
  - Dispatches parallel **Hermes** workers for **ALL implementation** AND **ALL validation**.
  - Reviews worker summaries, manages git commits/pushes/handoffs — **does NOT write feature implementation code directly**.
- **Hermes (`/home/erik/.local/bin/hermes`) = Implementation & Validation Workers**:
  - Configured and authenticated with **`deepseek-v4.1-flash-1017`**.
  - Implementation: `hermes chat -Q --oneshot --yolo --in /home/erik/Documents/testflight -m deepseek-v4.1-flash-1017 --max-turns 30 -q "..."`
  - Validation: add `--reasoning high` after integration waves.

---

## 3. Completed Systems (Waves 1–12, Features 01–29)

### Core, Audio & MCP / AI WSO
- `src/core/audio.js` — Layered procedural F-16 turbofan engine + atmospheric wind + radial-velocity **Doppler pitch shift** for flyby camera.
- `src/core/combat_audio.js` — Hybrid WebAudio sample loader (`./media/sfx/`, GitHub-Pages-safe relative URLs) + procedural fallback: Vulcan 20mm, AIM-9 growl/launch, Mk-82 release, **`BFFG` plasma-thermobaric launch & mega-detonation**, distance-filtered explosions, sonic boom, RWR, KC-135 boom contact.
- `src/core/betty.js` — Bitching Betty priority voice warning queue.
- `src/core/mcp_bridge.js` + `mcp/server.mjs` — Zero-dependency stdio JSON-RPC 2.0 MCP server + loopback `127.0.0.1:5179` bridge (8 live tools, including `vsFpm`, `flyby` camera, and `BFFG`).
- `mcp/wso_copilot.mjs` — Real-time AI WSO Co-Pilot (`npm run wso -- --scenario patrol|cruise|evade`), `< 2 ms` deterministic defense loop (auto-flare on SAM launch, threat/pull-up/bingo radio callouts) + optional non-blocking LLM advisor hook (`WSO_LLM_URL` / `WSO_LLM_MODEL` — ready for local Ollama `qwen2.5:1.5b` or `llama3.2:1b` once Ollama is installed).

### Flight, Aircraft, Cameras & Immersion
- `src/aircraft/f16.js` & `src/aircraft/cockpit.js` — Sculpted 99-mesh F-16C Block 50 exterior (headless-safe) + 3D cockpit with **AoA indexer lights**, flashing **Master Caution lamp**, **night backlighting**, and airspeed-scaled **canopy raindrop streaks**.
- `src/aircraft/aircraft.js` & `src/core/input.js` — 5 camera modes (`cockpit`, `chase`, `wing`, `orbit`, **`flyby`** with auto-reanchoring tripod & Doppler); **`Alt + Arrow Keys`** camera pan (suppressing throttle arrows), **`Alt + +/−`** camera distance (`12–120 m`), **`Alt + 0`** recenter; dynamic `camera.near` (`0.22 m` cockpit / `1.5 m` external) for 12× horizon depth precision.
- `src/aircraft/autopilot.js` — `AutopilotSystem` (`OFF`/`ALT_HDG`/`ATT`) + `ILSComputer` (wired to HUD localizer/glideslope needles + kneeboard diversion airport).
- `src/aircraft/replay.js` — Preallocated 30-second (`900`-frame) instant replay ring buffer (`F2` toggle, `F4` cycle `1×/0.5×/2×` speed).
- `src/aircraft/ejection.js` — ACES II ejection sequence.
- `src/sim/fuel.js` — 7,000 lb fuel + orbiting KC-135 Stratotanker aerial refueling.
- `src/sim/traffic.js` — 4 high-altitude contrail airliners + **`VIPER 1-2` F-16C wingman** using the real sculpted `createF16()` + `updateF16Visual()` model.
- `src/world/carrier.js` — Offshore Nimitz-class carrier (`CVN-71`) with landable `18.5 m` deck, FLOLS meatball (3D + HUD), 4 arresting wires (proper `1.55 m` wheel rest height), and bow steam catapult (`82 m/s` in `2.2 s`); floats in the Gulf of Trieste in Vipava Valley theater.

### Real-World 100×100 km Vipava Valley Theater & Terrain Detail
*(See `docs/decisions/terrain-detail-grids.md` for the reusable 4-layer real-world grid ADR)*
- `src/world/dem.js` + `public/media/vipava_dem.png` (`2048×2048`, Zoom 11, 49 m/sample, 16-bit RG PNG) + `public/media/vipava_meta.json` — Real `100 × 100 km` elevation from Adriatic Sea (`-7.7 m`) to Julian Alps (`2,251.8 m`), blending smoothly to procedural terrain at `44–50 km`.
- `src/world/terrain.js` + `src/world/airports.js` — `setCustomAirports()` flattens and renders real Vipava Valley runways: **Ajdovščina `LJAJ` (RWY 09/27, `090°` East–West, 1,800 m)**, `LJPO` Postojna, `LJDI` Divača, `LIPQ` Trieste Intl, `LJPZ` Portorož.
- `public/media/vipava_osm.json` (`608 KB`) + `src/world/buildings.js` + `src/world/roadnet.js` — **7,770 real OSM buildings** across 11 cities (Ajdovščina, Vipava, Nova Gorica, Gorizia, Solkan, Tolmin, Trieste, Koper, Postojna, Sežana, Divača, Idrija, Monfalcone, Štanjel) with per-building distance streaming, plus **2,933 real OSM highways** (continuous terrain-conforming ribbons, `<= 10.5 m` carriageway cap, airport-pad clipped, `renderOrder: 1`).
- `src/world/landmarks.js` — **12 iconic 3D landmarks** with `-4 m` foundation skirts & animated beacons: Sveta Gora Basilica, Solkan Stone Arch Bridge, Solkan Dam, Vogršček Dam, Nanos Broadcast Tower (Pleša), Gorizia Castle, Kostanjevica Monastery, Trieste Faro della Vittoria, Piran St. George Bell Tower, Predjama Castle, Štanjel, Vipava H4 Viaduct.
- `src/world/water.js` + `public/media/vipava_water.json` (`917 KB`) — **1,124 real OSM rivers** (Vipava, Soča, Idrijca, Hubelj) and **351 inland lakes/reservoirs** (including **Vogršček Reservoir** and **Cerkniško jezero**, sea-level coastal lagoons filtered out, dammed reservoirs elevated via `max(medianPerimeterH, centerH) + 0.85`).
- `src/world/terrainview.js` — Realistic multi-scale terrain shader (`onBeforeCompile` on `MeshLambertMaterial`): `6/28/140 m` procedural world detail with analytical gradient micro-bump lighting, Karst limestone cliff strata (`8.2 m` period in Vipava), valley vineyard/agricultural patchwork, and coastal `WaterSurface` sunken `-0.45 m` (`polygonOffset: 4`) + distance-faded waves for flicker-free Monfalcone/Grado shorelines.

### Weapons, Dynamic Destruction, VFX & UI
- `src/combat/weapons.js` — `GUN`, `AIM9`, `MK82` (`180` dmg, `75 m` splash), and **`BFFG`** (`4` key / `Tab`, 2 rounds, `5000` dmg, `420 m` splash, cyan-gold plasma warhead + live CCIP). All weapons raycast against **3D rotated building facades (`hitBuilding`)** for mid-air side-wall detonations.
- `src/world/buildings.js` — Wall-aligned reflective glass window shader, 4-corner slope grounding, cumulative HP damage for `GUN`, animated **burn & collapse** (`2.4–3.8 s` tilt/shrink/glow), **permanent multi-piece jagged ruins**, weapon-scaled craters (`4–6 m` GUN, `18 m` AIM-9, `38 m` Mk-82, **`160 m` BFFG wasteland**), and 75-second smoldering ruin fires (`getRuinFirePoints()`).
- `src/sim/vfx.js` — **5-lobe turbulent billowing fireball clusters**, dynamic blast flash `PointLight`, **160-chunk ballistic tumbling 3D debris**, `16`-slot rising smoke plumes, building fire puffs (`spawnFirePuff`), tire/catapult smoke, Mach vapor cone, wingtip vapor.
- `src/ui/hud.js`, `src/ui/tactical.js`, `src/ui/kneeboard.js` — 60 FPS HUD with ILS needles (cockpit + minimal external), carrier FLOLS meatball, replay banner, cloud-entry mist wash, `BFFG-9000 · DANGER` reticle, and **Kneeboard (`K`)** with city/landmark labels + live `"OVER <PLACE> / X.X KM <DIR> OF <PLACE>"` + GPS readout.

---

## 4. Next Roadmap Ideas
1. **Local Mini LLM for AI WSO**: Install Ollama (`ollama pull qwen2.5:1.5b` or `llama3.2:1b`) and run `WSO_LLM_URL=http://127.0.0.1:11434/v1/chat/completions WSO_LLM_MODEL=qwen2.5:1.5b npm run wso` alongside `npm run dev` for live local AI tactical callouts.
2. **Additional 100×100 km Real-World Theaters**: Reuse `scripts/bake_*.py` + `docs/decisions/terrain-detail-grids.md` to bake new real-world grids (e.g., Julian Alps / Triglav / Bled, Istria / Pula, Dolomites, or Grand Canyon).
3. **Vipava Valley Missions**: Add Vipava-specific combat/navigation sorties (e.g. Soča Valley canyon run, Nanos radar SEAD, Gulf of Trieste carrier qualification) and real Vipava **Burja** northeast gust wind preset.
4. **Izola & Piran OSM Buildings**: Re-run just the `Izola+Piran` Overpass box (timed out during the 11-city batch) and merge into `public/media/vipava_osm.json`.
