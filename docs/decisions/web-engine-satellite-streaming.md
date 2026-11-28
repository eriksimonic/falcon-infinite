# Architecture Decision: Stay on WebGL2/Three.js with 3-Tier Satellite Ortho, 500 km Macro DEM & Live AWS Streaming (Defer UE5)

## Status
Accepted — validated on the **Vipava Valley** real-world theater (`2026-11-28`, commit `8ddbaa8`).

## Context
After completing Features 37–41 (HD DEM, 53,500 OSM buildings, grounded landmarks & bridges), procedural vertex-colored terrain still read like an older-generation flight simulator and ended sharply at `±50 km`. We evaluated rewriting Falcon Infinite in **Unreal Engine 5 (+ Cesium for Unreal)** or **Godot 4 (Vulkan Forward+)** versus pushing the Three.js / WebGL2 renderer further with real satellite imagery and multi-scale elevation streaming.

## Decisions

### 1. Stay on Three.js / WebGL2 — Ditch UE5 Rewrite for Now
- **Decision**: Continue building Falcon Infinite on **Three.js + Vite (WebGL2)** and shelve the Unreal Engine 5 port.
- **Why**:
  - Draping real 3-tier satellite ortho-imagery with aerial perspective, drifting cloud shadows, carved river depressions, and 53k OSM buildings delivered a dramatic leap in visual realism right in the browser.
  - Preserves **zero-install browser distribution**, **~150 ms Vite builds**, **26 headless Node test suites**, and a **100% plain-text codebase** that pairs cleanly with fast AI-assisted iteration.
  - Avoids UE5's ~60 GB editor footprint, multi-minute C++ rebuilds, binary `.uasset` friction, and multi-GB desktop binaries.
- **Revisit trigger**: Only reconsider UE5 + Cesium (or Godot 4) if true volumetric fly-through clouds, Lumen global illumination, or native HOTAS/VR become strict requirements later.

### 2. 3-Tier Nested DEM + Live AWS Terrarium Streaming ("Option C")
- **Decision**: Extend real-world elevation beyond the `100 × 100 km` box using a **3-tier baked stack + live on-demand AWS Open Data streaming**:
  1. **HD Core (`40 × 30 km`)**: `vipava_dem_hd.png` (`2048²`, `z=13`, `~15–19 m/px`, `blendM=1500 m`).
  2. **Regional (`100 × 100 km`)**: `vipava_dem.png` (`2048²`, `z=12`, `~49 m/px`, `blendM=6000 m`).
  3. **Macro Continental (`500 × 500 km`)**: `vipava_dem_macro.png` (`1024²`, `z=9`, `~488 m/px`, `1.79 MB`, `blendM=20000 m`) covering the Julian Alps, Dolomites, Venice, Istria, Ljubljana, and Southern Austria with zero boot pop-in.
  4. **Live Streaming Beyond `250 km`**: `StreamingTerrariumDEM` fetches CORS-open AWS Terrarium tiles (`https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png`, `Access-Control-Allow-Origin: *`) into a 64-tile LRU cache and invalidates overlapping `TerrainView` tiles on arrival, falling back smoothly to procedural terrain offline.
- **No Procedural Cities in Real-World Theaters**: While `BuildingSystem.customSettlement` is active, procedural settlements (`settlementsNear`) are completely suppressed outside `±50 km` (and `clearSettlementCaches()` runs on `setActiveDEM`) so invented cities never float over the Adriatic Sea or real-world macro terrain.

### 3. 3-Tier Real Satellite Ortho-Imagery + Atmospheric Depth
- **Decision**: Replace procedural valley ground coloring in the `vipava` theater with 3 baked **Esri World Imagery** JPEGs (`vipava_ortho_hd.jpg` `4096×3072`, `vipava_ortho.jpg` `2048²`, `vipava_ortho_macro.jpg` `2048²`) baked via exact per-output-row Web Mercator latitude mapping (`scripts/bake_vipava_ortho.py`) so imagery aligns to `< 0.5 px` across all `500 km`.
- **Shader Composition (`TerrainView`)**:
  - Cross-fade `macro → regional → hd` cleanly across each tier's `blendM` margin, with close-up micro-grain modulation (`6 m` / `28 m`) so low-altitude flight stays crisp.
  - Layer soft drifting cloud shadows (`1.8 km` scale) on direct diffuse light and altitude-aware Rayleigh aerial perspective on distant mountain ridges (`9–48 km`).
  - Keep `temperate` and `desert` procedural theaters unchanged (`uOrthoFlags = 0`).

### 4. Hydrological River Carving & Nyquist-Filtered 2D Water
- **Decision**:
  - Bake downward-only, strictly monotonic downhill riverbed depressions into `vipava_dem.png` and `vipava_dem_hd.png` (`scripts/carve_vipava_rivers.py`), keeping sea datum (`<= 0.1 m`) and airport pads untouched.
  - Filter elongated sloping OSM `natural=water` riverbank polygons (`span > 350 m`, `avgWidth < 110 m`, aspect `> 4.5`, elevation spread `> 3.5 m`) out of flat-lake triangulation in `src/world/water.js` so sloping Alpine valleys (Tolmin, Solkan) render as continuous downhill flat-bank river ribbons (`yLeft === yRight`) instead of floating/stair-stepping planks.
  - Eliminate all 1D plane sine waves in both `WaterSurface` and `InlandWaterSystem`; use screen-space Nyquist-filtered (`fwidth`) 2D quintic value noise with strictly ascending `smoothstep` edges, natural muted palettes, sun-elevation dusk/night dimming, and ACES tone-mapping/sRGB includes.

### 5. Subagent & Tooling Workflow
- **Decision**: Documented in `AGENTS.md` — keep the primary orchestrator focused on diagnosis, architecture, review, and final verification, and delegate implementation subtasks to the local **Hermes CLI** defaulting to **`deepseek-v4.1-flash`** (`--provider alibaba-coding-plan`).
- **Environment Inspection Tooling**: Maintain Free Cam (`Ctrl+F` / `F7`) with `localStorage` reload persistence (`falcon.lastView.v1`) and the interactive click-to-teleport Inspector Map (`M`) for rapid visual QA.

## Consequences
- Future realism investments stay focused on WebGL2/Three.js wins with high visual payoff (e.g., real-time directional shadows + contact AO, richer organic 3D forest canopies, weathered industrial/residential roof detail).
- The previous standalone UE5 port document (`docs/UE5_PORT_PLAN.md`) is removed so `docs/` reflects the active architecture only.
