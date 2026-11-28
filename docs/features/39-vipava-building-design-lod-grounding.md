# Feature 39 — Primorska/Karst Building Architecture, Spatial Chunking, 4-Tier Procedural Distance LOD & True Slope Grounding

## Goal
Upgrade `src/world/buildings.js` so that:
1. Real OSM towns (35,000–55,000+ buildings) stream effortlessly at 60 FPS via a **spatial chunk grid** (`1 km × 1 km` cells).
2. A **4-tier procedural display/hide LOD system** smoothly reveals architectural detail up close (sheds, pitched terracotta roofs, chimneys, church campaniles, streetlights) and progressively hides fine detail / small houses as you fly farther away, with **smooth shader-based distance fade (no abrupt pop-in)** and **real OSM urban ground patches** keeping distant towns legible from cruise altitude.
3. Flat boxes are replaced with **authentic Vipava/Adriatic architecture** (stone retaining foundation plinths, pitched gable & hipped terracotta/slate roofs, proper church nave + white campanile bell towers, modern apartments, industrial halls).
4. **Zero floating or buried buildings**: fix the `-rot` → `+rot` corner-grounding sign bug and implement **5-point + terrain-LOD-sag-aware grounding** with windowless stone foundation plinths so hillside buildings sit naturally terraced on slopes instead of floating or turning into 40 m stretched window monoliths.

## Owned Files (DO NOT modify files outside this list)
- `src/world/buildings.js`
- `tests/cities_destruction_test.mjs`

## Detailed Specification (`src/world/buildings.js`)

### 1. Fix Rotation Sign Bug & 5-Point Slope/LOD-Aware Grounding (`_ground(b)`)
- **Bug Fix**: In `_ground(b)`, Three.js `Euler(0, b.rot, 0)` rotates local `(su, sv)` to world:
  ```js
  const wx = b.x + su * c + sv * s;
  const wz = b.z - su * s + sv * c;
  ```
  (The previous code had `su * c - sv * s` and `su * s + sv * c`, which was `-b.rot` and mismatched 1,170 OSM buildings!)
- **5-Point Grounding + Terrain-LOD Sag Margin**:
  - Sample `terrainHeight` at the 4 rotated footprint corners AND the center `(b.x, b.z)` → `lo`, `hi`, `centerH`.
  - Estimate local terrain curvature / quadtree sag margin by also comparing `centerH` against corner mean `avgCorner = (h0+h1+h2+h3)*0.25`:
    - `curvMargin = Math.abs(centerH - avgCorner) * 1.5`
    - `slopeRelief = hi - lo`
    - `plinthDepth = Math.max(3.5, Math.min(28.0, 2.5 + slopeRelief * 0.4 + curvMargin))`
  - Compute **terrace floor elevation** (`floorY`) where the habitable facade starts:
    - On gentle ground (`slopeRelief <= 3.0`): `floorY = lo + slopeRelief * 0.35` (slight embed into uphill side).
    - On steep hillsides: `floorY = Math.max(centerH, hi - Math.min(b.h * 0.45, 3.2))` so the roof (`top = floorY + b.h`) is **NEVER buried below `hi`**, AND the habitable facade stays a realistic height (`b.h`), NOT stretched to `hi - lo + b.h`!
  - Compute **plinth bottom**: `plinthBase = lo - plinthDepth` (always safely below `lo` AND below coarse mid-range terrain triangles!).
  - Return `{ base: plinthBase, floorY, top: floorY + b.h, ground: lo, hi, relief: slopeRelief }`.
  - Keep `base` and `top` properties on the returned object so `hitBuilding()`, `applyBlast()`, `_addCollapse()`, `_addRuin()`, and `tests/cities_destruction_test.mjs` remain 100% compatible!

### 2. Spatial Chunk Index (`1000 m` cells) & Binary/Rich Custom Buildings Support
- Update `setCustomBuildings(rawList, urbanZones = null)` to accept:
  - Legacy 7-element tuples `[x, z, w, d, h, rot, kindCode]` (preserving 100% compatibility with existing tests!)
  - New 10-element tuples `[x, z, w, d, h, rot, kindCode, roofCode, tier, colorSeed]` (from `loadVipavaBuildings()`)
- Update `CUSTOM_KINDS = ['house', 'apartment', 'industrial', 'tower', 'church', 'shed']` (keeping indices `0..3` identical to existing tests: `0=house, 1=apartment, 2=industrial, 3=tower`, adding `4=church, 5=shed`).
- Add warm Vipava/Primorska/Adriatic regional wall palettes (`CUSTOM_PALETTE`) for `house`, `apartment`, `industrial`, `tower`, `church`, `shed` (warm ochre, limestone cream, pale apricot/terracotta wash, weathered stone, modern concrete).
- Clear OSM buildings off **ALL custom airport runway strips** (not just LJAJ — check `getCustomAirports()` if available, plus keep the exact LJAJ strip check `|x| < 960 && |z| < 95` so existing tests pass identically!).
- Build a **spatial hash grid** (`CELL_SIZE = 1000 m`, `Map<string, Array<building>>`) inside `setCustomBuildings()` so querying buildings near `(camX, camZ)` within `radius` only visits cells inside the bounding box — `O(visible cells)` instead of scanning 50,000 buildings!
- Store optional `urbanZones` (`[[x, z, radius, density], ...]`) on `this.customSettlement` and render subtle blended urban ground patches (draped on terrain) for real towns when camera is nearby/mid/far!
- Keep `_streamBuildings(s, camX, camZ, radius, budget)` preserving the exact API & behavior verified by `tests/landmarks_test.mjs` (returns buildings within `radius` capped to nearest `budget`).

### 3. 4-Tier Procedural Display/Hide LOD System (With Smooth Shader Dissolve)
Compute per-building horizontal distance `dist = Math.hypot(b.x - camX, b.z - camZ)` and camera altitude `alt = Math.max(0, camera.position.y)`:
- **Distance thresholds** (scaled smoothly by quality preset `low` / `medium` / `high` and modestly by `alt`):
  - **Tier 0 · Close Detail (`R_CLOSE`)**: `low: 2200 m`, `medium: 3600 m`, `high: 5000 m`
    - Show ALL buildings (`tier >= 0`, including sheds/garages/small cottages)
    - Emit **full architecture**: stone foundation plinths + main walls + **3D pitched gable / hipped roofs** + rooftop accents (chimneys, penthouses, industrial clerestories, church campanile + spire)
  - **Tier 1 · Mid Urban (`R_MID`)**: `low: 6500 m`, `medium: 10500 m`, `high: 14500 m`
    - Hide `tier === 0` (tiny sheds/outbuildings `< 55 m²`) and small chimneys/rooftop details
    - Show `tier >= 1` (all real houses, apartments, factories, churches) with **plinths + main walls + 3D pitched roofs**
  - **Tier 2 · Far Skyline (`R_FAR`)**: `low: 14000 m`, `medium: 22000 m`, `high: 28000 m` (clamped by `alt` visibility boost)
    - Hide ordinary small houses (`tier < 2`); keep **prominent skyline structures (`tier === 2`: churches, apartments, large industrial halls, towers)** + **real OSM urban ground patches** so distant towns remain clearly visible in their exact locations!
  - **Tier 3 · Horizon (`> R_FAR`)**: Individual buildings hidden; landmarks & urban ground patches carry the visual read.
- **Smooth Procedural Distance Dissolve (Zero Pop-In)**:
  - Pass `uCamPos` and `uFadeStart` / `uFadeEnd` (or per-instance distance fade via shader using `vWorld` & `cameraPosition`!) into the building/roof/plinth shaders:
  - Use a crisp **4×4 Bayer screen-door dither discard** (or smooth alpha-cutoff fade) in the outer `12%` of the visibility ring (`smoothstep(uCullDist * 0.86, uCullDist, distXZ)`) so buildings smoothly dissolve in/out as you approach or fly away instead of popping!
- Expose `this.stats.lod = { close, mid, far, roofs, plinths }` for debugging and automated tests.

### 4. Multi-Mesh Procedural Architectural Design (Low Draw Calls)
Keep total draw calls tiny by adding **3 batched `InstancedMesh` pools** alongside `this.mesh` (standing walls) and `this.ruinMesh`:
1. **`this.plinthMesh`** (Foundation Retaining Plinths):
   - Unit box `(1, 1, 1)` shifted `[0..1]` in Y, rendered with a weathered Karst limestone/concrete Lambert/Shader material (NO windows, subtle vertical stone-course shading + base AO).
   - Placed from `g.base` to `g.floorY + 0.35`, width `b.w * 1.03`, depth `b.d * 1.03` — visually grounds every hillside house like authentic Primorska stone-base construction!
2. **`this.gableRoofMesh`** (3D Pitched Gable Roofs):
   - Pure procedural `BufferGeometry` triangular prism (`width = 1` along X, `height = 1` along Y `[0..1]`, `depth = 1` along Z, ridge along Z — rotated by `b.rot + (b.w > b.d ? Math.PI/2 : 0)` so the ridge ALWAYS runs along the building's longer axis!).
   - Terracotta tile / dark slate procedural shader matching lighting, fog, sun direction, and smooth distance fade.
   - Slight eaves overhang (`1.06×` width and depth) for realistic shadows and silhouettes!
3. **`this.hipRoofMesh`** (3D Hipped / Pyramidal Roofs & Church Spires):
   - Pure procedural 4-sided pyramid/hipped-roof `BufferGeometry` (4 sloped faces + base, height `[0..1]`), used for square Mediterranean houses/villas (`roofCode === 1`) and church bell-tower spires (`kindCode === 4`)!
- **Church Architecture (`b.kind === 'church'`)**:
  - Main limestone nave (`floorY` → `floorY + h * 0.72`) + terracotta gable roof + slender white limestone **campanile bell tower** at one end (`h * 1.35..1.65`) topped with a pointed terracotta/slate pyramidal spire! (No more glass skyscraper for village churches!)
- **House / Apartment / Industrial / Tower / Shed**:
  - `house`: warm stucco walls + stone plinth + pitched terracotta gable (or hip) roof (`rise = min(w, d) * 0.28..0.38`) + tiny terracotta chimney at close LOD (`Tier 0`).
  - `apartment`: multi-story walls + plinth + flat parapet & rooftop mechanical penthouse (or low-pitch hip roof for smaller European apartment blocks).
  - `industrial`: wide hall + plinth + low-pitch dark-slate/metal gable roof (`rise = min(w, d) * 0.14`) + optional clerestory monitor at close LOD.
  - `shed`: low plaster/timber walls + terracotta/metal gable roof (shown only in `Tier 0`).
- **Headless Safety & Resource Cleanup**:
  - All new meshes are only created when `this.scene` is truthy (`new BuildingSystem(null, preset)` stays 100% headless-safe!).
  - `dispose()` disposes all new geometries and materials cleanly.
  - Rebuild trigger cadence: reduce rebuild distance threshold from `500 m` to `250 m` (now cheap because of the spatial grid!) so close-range Tier 0 buildings appear smoothly well ahead of the aircraft.

### 5. Tests (`tests/cities_destruction_test.mjs`)
- Ensure ALL existing assertions in `tests/cities_destruction_test.mjs` continue passing!
- Add headless unit tests verifying:
  - `_ground(b)` uses the exact `+rot` corner transform matching `hitBuilding()` and Three.js `Euler(0, rot, 0)` (test on a tilted plane with `rot = 0.7` rad!).
  - On a steep hillside (`relief = 12 m`), `g.base < lo - 3`, `g.top >= hi + b.h * 0.5` (roof is NEVER buried!), and `g.floorY >= lo`.
  - 4-tier procedural LOD (`close`, `mid`, `far`) shows more detail/buildings when close and hides `tier 0` sheds at `> 5 km` and `tier 1` houses at `> 12 km`.
  - Spatial grid streaming handles 20,000 synthetic custom buildings with rebuild time `< 25 ms`.
- Run `node tests/cities_destruction_test.mjs && node tests/landmarks_test.mjs`.
