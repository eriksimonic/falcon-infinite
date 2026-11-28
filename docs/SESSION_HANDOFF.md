# Session Handoff — Falcon Infinite

**Date:** 2026-11-28
**Branch:** `main` → `origin/main`
**HEAD / base commit:** `fc05844` — "Realism pass: shadows, organic forests, night lighting, MSAA+FXAA, sticky settings, flight resume, and Free Map F-16 spawn"
**Working tree:** 32 modified files, 14 untracked (all uncommitted — nothing in this session has been committed)
**Gate:** `npm test && npm run build` (33 headless suites + Vite 8 production bundle)

---

## 1. Executive Summary & Current Repo State

**Falcon Infinite** is a browser-native fighter simulator built on **Three.js r187** + **Vite 8.3.8**, targeting WebGL2. You fly a procedural **F-16C Block 50** over a real **100 × 100 km Vipava Valley / Kras / Adriatic** theater: 2048² DEM macro terrain, three satellite-ortho tiers, ~53k OSM buildings, hydrology, organic vegetation, volumetric weather, and a full HUD/cockpit stack.

| Item | Value |
|---|---|
| Engine | Three.js `^0.187.0`, WebGL2, ACESFilmic + sRGB output |
| Bundler | Vite `^8.3.8` |
| Entry | `index.html` → `src/main.js` |
| Dev server | `npm run dev` → `http://127.0.0.1:5173` (bound to 127.0.0.1, port 5173) |
| Test suites | **33** chained in `package.json` → `npm test` |
| Build | `npm run build` → `vite build` |
| Python toolchain | Python 3 + **Pillow 13.0.0 only** — `numpy` is *not* installed |

### Changes present in the working tree (uncommitted)

Modified (32):
```
package.json
public/media/vipava_dem.png
public/media/vipava_ortho.jpg
public/media/vipava_ortho_hd.jpg
public/media/vipava_ortho_macro.jpg
src/aircraft/aircraft.js      src/aircraft/autopilot.js
src/aircraft/cockpit.js       src/aircraft/f16.js
src/aircraft/flight.js        src/config.js
src/main.js                   src/sim/clouds.js
src/sim/juice.js              src/sim/postfx.js
src/sim/sky.js                src/sim/traffic.js
src/sim/vfx.js                src/ui/hud.js
src/world/airports.js         src/world/buildings.js
src/world/carrier.js          src/world/landmarks.js
src/world/roadnet.js          src/world/terrain.js
src/world/terrainview.js      src/world/vegetation.js
src/world/water.js            src/world/world.js
tests/autopilot_test.mjs      tests/flight_test.mjs
vite.config.js
```

Untracked (14):
```
docs/SESSION_HANDOFF.md
docs/findings/rendering-bottlenecks.md
scripts/__pycache__/                     (build artifact — do NOT commit)
scripts/fix_grado_polders.py
scripts/harmonize_vipava_ortho.py
src/ui/terrain_editor.js
src/world/terrain_edits.js
tests/buildings_perf_test.mjs
tests/f16_spec_test.mjs
tests/optics_perf_test.mjs
tests/sky_perf_test.mjs
tests/terrain_edits_test.mjs
tests/terrain_stream_perf_test.mjs
tests/vegetation_perf_test.mjs
```

Diff volume: **9,126 insertions / 1,628 deletions** across the modified files.

### New test suites wired into `npm test`

The gate grew from 26 to **33** suites (all passing). The seven added this session:

| Suite | Guards |
|---|---|
| `tests/optics_perf_test.mjs` | Helmet-cam optics pass + GoPro barrel-distortion sun-flare lock: uniforms, render-scale floor, zero extra render targets, inert-safe without a renderer (303/303) |
| `tests/f16_spec_test.mjs` | F-16C Block 50 published geometry + TLAR/flight-envelope numbers |
| `tests/sky_perf_test.mjs` | Cloud HDR cap under bloom threshold, overcast morphology, `uFlash` |
| `tests/buildings_perf_test.mjs` | Building/roof instancing budgets and quay placement |
| `tests/vegetation_perf_test.mjs` | Forest instance budgets, LOD survival |
| `tests/terrain_stream_perf_test.mjs` | Terrain tile streaming / LOD invalidation budgets |
| `tests/terrain_edits_test.mjs` | Painted terrain: height brush math, bilinear sampling, colour DataTexture (headless), undo batching, sparse JSON round-trip, `terrain.js` delta hook |

---

## 2. Everything Built & Upgraded This Session

### 2.1 Viper One-One Camera Optics & PostFX
**Files:** `src/sim/postfx.js`, `src/aircraft/aircraft.js`, `src/main.js`, `tests/optics_perf_test.mjs`

- **GoPro fisheye curvature** (~0.66× centre zoom) folded into the *existing* FXAA pass — no new `EffectComposer` targets, no extra full-screen passes (`src/sim/postfx.js:26-77`).
- **Zero edge smear:** the barrel warp is masked so the frame corners keep detail instead of smearing; peripheral buffering is handled in `src/world/terrainview.js` instead.
- **Subtle radial chromatic aberration** (`src/sim/postfx.js:266`) + peripheral optical blur, plus filmic S-curve and split toning.
- **90% internal render scale:** `INTERNAL_RENDER_SCALE = 0.90`, floor `RENDER_SCALE_MIN = 0.5` (`src/sim/postfx.js:79-80`). Targets rasterise at `CSS × dpr × renderScale` (`src/sim/postfx.js:511-516`).
- **3D-distance terrain blur + air shimmer** live in the terrain shader, not the post pass: atmospheric blur ramps from 0 under 4.5 km, subtle rising heat-haze refraction beyond ~6 km (`src/world/terrainview.js:445-462`).
- **ASA 200 35 mm film grain** (`src/sim/postfx.js:415-459`): 24 fps quantised grain field, 82% correlated luminance + 18% independent R/G/B dye scatter, so it reads as emulsion rather than digital RGB noise.

### 2.2 F-16C Block 50 Flight Physics, 3D Airframe & Cockpit
**Files:** `src/aircraft/flight.js`, `src/aircraft/f16.js`, `src/aircraft/cockpit.js`, `src/sim/sky.js`, `src/config.js`, `tests/f16_spec_test.mjs`, `tests/flight_test.mjs`

- **NASA TP-1538 / Stevens & Lewis aerodynamics** (`src/aircraft/flight.js:1`): TP-1538 transonic wave-drag hump continuous in Mach (`:72`), LEF schedule (`:373`), buffet onset above 14° AoA plus transonic shock buffet (`:739`), standard-atmosphere air data for HUD instrumentation (`:339`).
- **True-to-spec airframe geometry** (`src/aircraft/f16.js:3-11`): 15.06 m overall / 14.56 m structural length, 9.45 m bare wing span, 9.96 m over LAU-129 rails, 5.09 m gear-down height, 5.57 m stabilator span, 2.36 m main-gear track.
- **2.4 mm/texel cockpit sun shadows:** a cockpit-only `SpotLight` rakes a 1024² shadow map across a ~2.5 m cone (`src/aircraft/cockpit.js:8-9`), hidden outside the cockpit so it never costs exterior frames.
- **84° helmet-cam framing:** `CONFIG.camera.cockpitFov = 84`, `externalFov = 66` (`src/config.js:47-48`); eye sits just forward of the ACES II headrest front (`src/aircraft/aircraft.js:342`).
- **First-person pilot legs, kneeboard and forearms** modelled in-cockpit (`src/aircraft/cockpit.js:1446`), with glove material at `:838`.

### 2.3 Press-and-Hold `H` Smart Autopilot
**Files:** `src/aircraft/autopilot.js`, `src/main.js`, `src/ui/hud.js`, `tests/autopilot_test.mjs`

- **Quick tap `H`** toggles Controls Help on `keyup`; **holding 450 ms** hands control to the smart autopilot (`src/main.js:135`, `:831-832`, `:850`, `:1908`).
- **Cycle:** `AUTO_LAND` → `AUTO_REFUEL` → manual (`src/main.js:859-885`). Low fuel inside 18 km of the tanker prefers a refuel join immediately.
- **`AUTO_LAND` phases** (`src/aircraft/autopilot.js:79-95`, `:299-360`): `INTERCEPT` → `FINAL` (3.2° glideslope) → `FLARE` → `ROLLOUT`; the smart mode owns the ground phase so ground contact does not fight it (`:198`).
- **`AUTO_REFUEL`** joins the **KC-135 boom box** (`src/aircraft/autopilot.js:109`, `:211`).
- **HUD readout:** `t.autopilot = 'AUTO_LAND · <code>'` / `'AUTO_REFUEL'` (`src/main.js:2254-2262`), rendered by the HUD as `AP LAND · <code>` / `AP REFUEL` (`src/ui/hud.js:462-467`).

### 2.4 Volumetric Clouds & Storm Overhaul
**Files:** `src/sim/clouds.js`, `tests/sky_perf_test.mjs`

- **Capped daytime cloud HDR below the `1.05` bloom knee** (`src/sim/clouds.js:323`) so cream-white tops never bloom into glowing white blobs.
- **Dark moonlit night clouds** via `uNight` / `uDark`, with storm-density self-shadowing at the tower bases (`:253`, `:339`).
- **Weather-responsive overcast decks** driven by `overcast` / `storm` severity (`:542-584`); decks merge into continuous banks once `overcast > 0.35 || storm > 0.3` (`:560`), scaling cluster radius `19000 + overcast × 5000` (`:550`) and tower height `1.0 + storm × 1.25` (`:622`).
- **Charcoal-slate storm bases + internal lightning glow** via `uFlash`, tinted `vec3(0.80, 0.86, 1.0)` (`:377`).

### 2.5 Adriatic Coastline, Waterfront Quays & Zero-Artifact Open Sea
**Files:** `src/world/terrainview.js`, `src/world/buildings.js`

- **The clean sea/depth invariant** (`src/world/terrainview.js:263-270`, inside `DETAIL_ALBEDO`):
  ```glsl
  if ( vTerrWorld.y < -0.24 ) discard;
  ```
  `WaterSurface` is an opaque plane at `y = -0.18 m` spanning the whole world. Discarding terrain strictly below `-0.24 m` kills seabed Z-fighting at every distance (0…160 km) and every near plane (0.08…0.3 m) while keeping a **6 cm overlap at the waterline** — zero crack, zero double coastline.
- **Monotonic sea-datum sink:** pure sea/seabed (`h <= 0.03`) is remapped monotonically onto `[-16, -0.45] m` (`src/world/terrainview.js:1460-1468`), guaranteeing it is always below the discard plane. The coastal margin `0.03 < h < 1.1` keeps organic jagged rocky coves, karst boulder/cobble shoreline shading and micro-bump (`:523`, `:744`).
- **Concrete harbour quay pads** (`src/world/buildings.js:2223-2242`): any building whose ground sits in `-2.2 <= g.ground < 0.35` gets a plinth rising to `quayY = max(floorY, 0.85)`, putting waterfront buildings on dry concrete decks instead of the seabed. Buildings below `-2.2 m` are skipped (`:2223`).

### 2.6 Esri Ortho Italy/Slovenia Border Seam Harmonization
**Files:** `scripts/harmonize_vipava_ortho.py` (new), `public/media/vipava_ortho{,_hd,_macro}.jpg` (modified)

- Pure-**Pillow** harmonization of the Esri World Imagery tiers against **EOX Sentinel-2 Cloudless 2024** (`scripts/harmonize_vipava_ortho.py:48`), calibrated to the Slovenian Kras tone.
- Report / verification harness built into the script: low-frequency Kras tone profile, high-frequency edge-energy retention, and landmark colour checks with a pass/fail summary (`:459-521`, final line `ALL ORTHO TIERS HARMONIZED AND VERIFIED`).
- Session-reported metrics: border luminance delta `7.9 → 1.1`, green delta `9.2 → 1.4`, **97%** of edge detail retained.
- Original tiers backed up **and verified present** at `/tmp/vipava_ortho_orig/`:
  `vipava_ortho.jpg`, `vipava_ortho_hd.jpg`, `vipava_ortho_macro.jpg`.

### 2.7 Photorealistic Organic Alpine Rivers
**Files:** `src/world/water.js`, `tests/water_test.mjs`

- **Width-modulated river strips:** `RIVER_WIDTH_SCALE = 1.38` (`src/world/water.js:21`) plus sinusoidal pool/reach variation so ribbons breathe instead of running as constant-width bands.
- **Noise-warped, alpha-feathered banks:** `transparent: true, depthWrite: false` (`:782-786`) so overlapping translucent rims never clip each other.
- **Pale Soča limestone cobble/gravel bars** with matte specular attenuation.
- **Deep emerald-teal thalweg → luminous turquoise shallow shelf** transition (`:651`).
- **Animated downstream flow streaks** plus Nyquist-filtered **whitewater riffles** breaking over shallow gravel (`:609-621`, `:740-743`).
- Lake / wide-river polygons bypass the whole ribbon path (`:440`).

### 2.8 Grado Coastal Polder Lift & In-Game `F9` Terrain/Colour Editor — **SHIPPED**

Both pieces that were designed in the previous handoff are now in the working tree and green under the gate.

| Path | What it does |
|---|---|
| `scripts/fix_grado_polders.py` | Lifts the Grado lagoon polders + SR352 causeway in `public/media/vipava_dem.png` from OSM road/building + satellite dry-island evidence (SRTM returned `0.0 m` for both land and sea, see §3.2). Original DEM backed up to `/tmp/vipava_dem_orig.png`. |
| `src/world/terrain_edits.js` | `TerrainEdits` store: `2048²` Int16 height-delta grid (0.05 m quantum) + `1024²` RGBA tint/saturation grid exposed as a `DataTexture`; stroke-batched undo (40 deep), sparse JSON export/import, `localStorage` draft, `fetchProjectEdits()`, and the `setActiveTerrainEdits()` singleton that `terrainHeight()` adds. 100% headless-safe. |
| `src/ui/terrain_editor.js` | `TerrainEditorUI`: tactical sidebar, terrain-hugging 3D brush ring, analytical ray-march picker (`max(heightAt, 0)`, so land can be raised out of the Adriatic), height brushes RAISE / LOWER / FLATTEN / SMOOTH / ERASE H, colour brushes TAME NEON / DARKEN / LIGHTEN / DEEP FOREST / WARM OLIVE / KARST STONE / ERASE C, quick-jump, undo, export/import. |
| `vite.config.js` | Dev-only `POST /__dev/save-edits` middleware that atomically writes `public/media/vipava_edits.json` (25 MB cap, `version === 1` validated). |
| `src/world/terrain.js` | `terrainHeight()` = baked/procedural base + `sampleActiveHeightDelta(x, z)`. |
| `src/world/terrainview.js` | `uEditColorTex` / `uEditBounds` / `uEditEnabled` uniforms + `DETAIL_ALBEDO` pass 3h: the painted tint multiplies albedo and the alpha byte drives saturation (`byte 128` = exact 1.0 identity). Also pass 3f-bis, the **soft global neon-green chroma guard**, which pulls loud lime pasture toward natural Mediterranean olive while leaving deep Kras conifers alone. New `setEditColorTexture()` / `clearEditColorTexture()` bind the grid per theater. |
| `src/main.js` | `F9` toggle, pointer wiring (capture-phase, so the canvas can never grab the pointer lock mid-stroke), right-drag look through `freeCam.look()`, live tile rebuild via `invalidateBounds()` + `_buildPending(6, 8)`, project/localStorage load on `setTheater('vipava')`, save-to-project, quick-jump teleport. |
| `tests/terrain_edits_test.mjs` | The 33rd suite: brush math, bilinear sampling, headless colour texture, undo batching, JSON round-trip, `terrain.js` hook. |

Operation: `F9` opens the painter (it opens Free Cam and immediately releases the pointer lock, keeping the OS cursor). Left-drag paints, right-drag looks, `WASD`/`QE` fly, wheel changes speed, `[` / `]` resize the brush, `Ctrl+Z` undoes, `Esc` / `F9` exits. `SAVE TO PROJECT` hits the Vite dev middleware; under a static build/preview it falls back to the `localStorage` draft (`falcon.vipava.edits.v1`).

Everything above is uncommitted. §3.2's polder fix and brush overrides are now the shipped layers 2 and 3 of that solution, not plans.

---

## 3. Key Architectural Decisions & Hard-Won Lessons

### 3.1 Depth precision at `far = 160 km` — use a fragment discard, not vertex offsets
The camera runs `near = 0.08…0.3 m`, `far = 160 km`. A 24-bit depth buffer across that range cannot resolve seabed vertices against the opaque `WaterSurface` at `y = -0.18 m` once you are tens of kilometres out. Vertex-level sinking alone always leaves distant Z-fighting and a visible double coastline.

**Invariant:** `if (vTerrWorld.y < -0.24) discard;` in `DETAIL_ALBEDO` (`src/world/terrainview.js:270`). The 6 cm band between `-0.24` and `-0.18` is a deliberate waterline overlap — it prevents a crack at the shore. Any new terrain material must carry the same discard or it will reintroduce the artifact.

### 3.2 SRTM `0.0 m` ambiguity
SRTM cannot distinguish **open Adriatic Sea** from **low-lying coastal polders** (Grado, the lagoon causeways) — both come back as exactly `0.0 m`. Global shoreline jitter or a blanket "everything at 0 is sea" rule therefore either floods real land or raises the sea.

**Chosen solution (in order):**
1. §2.5's *targeted* sea-datum sink for `h <= 0.03`, which is safe because it only affects terrain the discard plane already treats as seabed.
2. Per-site evidence lift from OSM roads/buildings + satellite dry-island detection (`scripts/fix_grado_polders.py`, §2.8).
3. Interactive `F9` brush overrides persisted to `public/media/vipava_edits.json` (shipped, §2.8).

### 3.3 Mandatory Hermes delegation (`AGENTS.md`)
The primary agent orchestrates; **implementation goes to a cheap local worker**. Never spawn built-in IDE/Antigravity subagents for implementation — they burn primary-model quota.

```bash
hermes chat --oneshot --yolo \
  --provider alibaba-coding-plan \
  -m deepseek-v4.1-flash \
  --in /home/erik/Desktop/falcon-infinite \
  --query-file - <<'EOF'
<clear, scoped task prompt naming exact files, invariants, and verification command>
EOF
```

Rules that held up in practice:
- Use `--query-file -` with a **quoted** heredoc so GLSL, quotes and `$` reach the worker verbatim.
- Scope every task to a narrow file set and require the worker to run its own suite + `npm run build` before finishing.
- **Never let the worker call its internal `vision` tool** — it times out.
- **Never run two workers concurrently on the same file.**
- After the worker exits, the primary agent reads `git diff` and runs the full `npm test && npm run build` gate.

### 3.4 Headless-Node & shader contracts (regression traps)
- `src/world/`, `src/sim/`, `src/aircraft/` are imported directly in Node with **no DOM and no WebGL**. Every `window` / `document` / `camera` / `renderer` access must be guarded.
- `tests/living_vipava_test.mjs` asserts specific window-lighting substrings inside `BuildingSystem.material.fragmentShader` — editing that shader means updating the test's expected strings.
- `tests/roadnet_test.mjs` asserts `RoadNetwork` adds exactly **one** root mesh (`net.mesh`). Auxiliary geometry (bridge piers) must be **children of `net.mesh`**, not siblings.
- `tests/cities_destruction_test.mjs` covers the fallback runway clear zone when `getCustomAirports()` returns `null`.
- Custom `ShaderMaterial`s in `src/world/` **must** include `#include <fog_fragment>`, `#include <tonemapping_fragment>` and `#include <colorspace_fragment>` to match the ACESFilmic sRGB pipeline.

### 3.5 Local Python environment
Pure Python + **Pillow** only. `import numpy` raises `ModuleNotFoundError`. Any image tooling must be written against `PIL.Image`/`ImageFilter` and pure-Python loops — no vectorised array math.

---

## 4. Next Session Backlog

### P0 — Commit the shipped Grado / `F9` editor work (§2.8)
All of it is in the tree and green; what remains is a commit + a content pass:
1. `scripts/fix_grado_polders.py` — already run on `public/media/vipava_dem.png` (backup at `/tmp/vipava_dem_orig.png`).
2. `src/world/terrain_edits.js`, `src/ui/terrain_editor.js`, `vite.config.js`, `src/world/terrain.js`, `src/world/terrainview.js`, `src/main.js` — shipped and wired; verify in-game with `F9` before committing.
3. `tests/terrain_edits_test.mjs` — already the 33rd suite in `npm test`.

### P1 — Content pass once `F9` ships
- Paint the Grado lagoon, Monfalcone coast and any remaining **neon-green Italian farmland** patches; save into `public/media/vipava_edits.json`.
- Re-run `scripts/harmonize_vipava_ortho.py` only if the ortho tiers are rebaked (it rewrites the JPEGs in place; restore from `/tmp/vipava_ortho_orig/` first).

### P2 — Visual polish candidates
- Shoreline foam wave animation + coastal boats / harbour piers.
- River waterfall / Solkan gorge bridge water-contact tuning.
- Dynamic weather transitions and rain droplets on the canopy.
- Performance profiling on the **High** preset (`docs/findings/rendering-bottlenecks.md` is the starting point).

### Housekeeping before commit
- `scripts/__pycache__/` is untracked build noise — add it to `.gitignore` or delete it before committing.
- The session diff is large (≈9.1k insertions). Run the full gate before `git commit`.

---

## 5. Quick-Start for the Next Session

```bash
cd /home/erik/Desktop/falcon-infinite

npm run dev                       # http://127.0.0.1:5173
npm test && npm run build         # 33 suites + Vite production bundle
git status --short                # 32 modified, 14 untracked — still uncommitted
```

Key bindings:

| Key | Action |
|---|---|
| `F7` / `Ctrl+F` | Detached 6-DOF Free Cam (`src/main.js:704`) |
| `H` tap | Toggle Controls Help |
| `H` hold 450 ms | Smart autopilot cycle: `AUTO_LAND` → `AUTO_REFUEL` → manual |
| `M` | Big map (in Free Cam) |
| `1–9` | Map / Free Cam jump presets |
| `F9` | **Terrain & Color Paint Editor** (`src/ui/terrain_editor.js`, §2.8) |

Verification reminder: `npm test` must pass **33/33** suites and `npm run build` must produce a clean bundle before anything is committed. `docs/SESSION_HANDOFF.md` is the only file written by this handoff step.