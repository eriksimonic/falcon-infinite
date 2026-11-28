# Feature 37 — Vipava High-Fidelity Nested DEM, Bicubic Sampling & Terrain Mesh LOD

## Goal
Dramatically increase Vipava Valley terrain elevation fidelity (Nanos escarpment, Trnovski gozd cliff rim, Soča gorge at Solkan, Sveta Gora summit, Štanjel hill, vineyard slopes) while tightening mid-range quadtree mesh resolution so terrain triangles stay close to the true heightfield under towns, buildings, and bridges.

## Owned Files (DO NOT modify files outside this list)
- `scripts/bake_vipava.py`
- `public/media/vipava_dem.png`
- `public/media/vipava_dem_hd.png`
- `public/media/vipava_meta.json`
- `src/world/dem.js`
- `src/world/terrainview.js`
- `src/config.js`
- `tests/dem_test.mjs`

## Detailed Specification

### 1. Dual-Resolution Baked Vipava DEM (`scripts/bake_vipava.py`)
1. **Outer Regional DEM (`public/media/vipava_dem.png`, 100 × 100 km, `2048 × 2048`)**:
   - Upgrade tile zoom from `ZOOM = 11` to **`ZOOM = 12`** (~26.6 m/px at 45.9°N) from AWS Open Terrain Tiles (`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/{tx}/{ty}.png`), using parallel downloads (`ThreadPoolExecutor(max_workers=12)`) with retry logic.
   - Keep the exact 16-bit RG PNG encoding (`val = round((h + 200.0) * 16.0)`, clamped `0..65535`, `offset = -200.0`, `scale = 16.0`).
2. **Inner Vipava Valley + Soča Gorge HD Inset DEM (`public/media/vipava_dem_hd.png`, `2048 × 2048`)**:
   - Bounds centered on the Vipava Valley + Soča Gorge + Nanos + Štanjel corridor:
     - `xMin = -25000.0`, `xMax = 15000.0` (`40 km` East–West: covers Gorizia, Nova Gorica, Solkan, Sabotin, Sveta Gora, Dornberk, Branik, Ajdovščina, Vipava, Štanjel, Nanos, Predjama)
     - `zMin = -15000.0`, `zMax = 15000.0` (`30 km` North–South)
     - Sample spacing: **~19.5 m × 14.6 m per sample** (~9× denser elevation area resolution than the old Zoom 11 grid!).
   - Sample from **AWS Terrarium `ZOOM = 13`** (~13.3 m/px at 45.9°N) using bilinear tile sampling (or `ZOOM = 14` where helpful; `ZOOM = 13` is ~35 tiles and matches the ~14–19 m output pixel cleanly without aliasing).
   - Encode with the exact same 16-bit RG PNG format (`offset = -200.0`, `scale = 16.0`).
   - Recompute `airports` elevations (`LJAJ`, `LJPO`, `LJDI`, `LIPQ`, `LJPZ`) using the highest-res available DEM at each airport's `(lat, lon)`.
   - Save inset metadata in `public/media/vipava_meta.json`:
     ```json
     "hd": {
       "url": "./media/vipava_dem_hd.png",
       "grid": 2048,
       "xMin": -25000.0,
       "xMax": 15000.0,
       "zMin": -15000.0,
       "zMax": 15000.0,
       "blendM": 1500.0,
       "offset": -200.0,
       "scale": 16.0
     }
     ```
3. Run `python3 scripts/bake_vipava.py` to actually generate the updated `public/media/vipava_dem.png`, `public/media/vipava_dem_hd.png`, and `public/media/vipava_meta.json`. Verify file sizes are reasonable (~4–6 MB each) and elevation ranges are physically accurate (Adriatic ~0 m, Ajdovščina LJAJ ~112 m, Nanos ~1,250–1,310 m, Julian Alps ~2,250 m).

### 2. Multi-Resolution `HeightmapDEM` + Bicubic Sampling + Binary Buildings Loader (`src/world/dem.js`)
1. **Arbitrary Rectangular Bounds Support in `HeightmapDEM`**:
   - Support optional `xMin`, `xMax`, `zMin`, `zMax` in `HeightmapDEM` constructor (defaulting to `-sizeM/2 .. +sizeM/2` when omitted so all existing callers and tests stay 100% backwards-compatible).
   - Add `blendM` (default `6000` for outer DEM, or `meta.hd.blendM` for inset) so `blendWeight(x, z)` smoothly ramps from `1` inside the inner box to `0` at the outer edge along both X and Z axes.
2. **Smooth Catmull-Rom Bicubic Interpolation**:
   - For grids with `width >= 4 && height >= 4`, use fast Catmull-Rom bicubic interpolation in `_sampleSelf(x, z)` (clamping to the min/max of the 2×2 cell corners when needed or mild clamping so bicubic never introduces overshoot spikes over flat sea/runways; note: on any linear ramp Catmull-Rom is mathematically exact, and for `width < 4 || height < 4` fall back to bilinear so every 2×2 unit test passes bit-identically!).
   - Keep `sample(x, z)` O(1), allocation-free, and returning `null` outside bounds.
3. **Nested HD Inset Support (`setDetailDEM(hdDem)`)**:
   - Add `this.detailDEM = null;` and `setDetailDEM(hdDem)` on `HeightmapDEM`.
   - In `sample(x, z)`: if `this.detailDEM` is set and `(x, z)` is inside its bounds, compute `w = this.detailDEM.blendWeight(x, z)`. If `w >= 0.9999`, return `this.detailDEM.sample(x, z)`; if `w > 0`, smoothly blend `hdH * w + baseH * (1 - w)`.
   - In `loadVipavaDEM(pngUrl, metaUrl)`: if `meta.hd && meta.hd.url`, fetch and decode `meta.hd.url` in parallel with `pngUrl`, construct the child `HeightmapDEM` with `xMin/xMax/zMin/zMax/blendM/offset/scale`, and attach via `dem.setDetailDEM(hdDem)`. If the HD PNG fails to load (e.g. offline/404), gracefully fall back to the outer DEM without throwing.
4. **Compact Binary Buildings Loader (`loadVipavaBuildings` + `parseBuildingsBinary`)**:
   - Export pure headless-safe `parseBuildingsBinary(arrayBuffer)` and browser loader `loadVipavaBuildings(url = './media/vipava_buildings.bin')` + `_resetVipavaBuildingsCache()`.
   - Binary contract (`FBLD` v1, little-endian):
     - Header (16 bytes): magic `'FBLD'` (`0x46, 0x42, 0x4C, 0x44`), `uint32 version = 1`, `uint32 count`, `uint32 stride = 20`.
     - Per-building record (20 bytes):
       - `0`: `float32 x`
       - `4`: `float32 z`
       - `8`: `uint16 w10` (`w = w10 * 0.1`)
       - `10`: `uint16 d10` (`d = d10 * 0.1`)
       - `12`: `uint16 h10` (`h = h10 * 0.1`)
       - `14`: `int16 rotQ` (`rot = rotQ * 0.0001`)
       - `16`: `uint8 kindCode` (`0=house, 1=apartment, 2=industrial, 3=tower, 4=church, 5=shed`)
       - `17`: `uint8 roofCode` (`0=gable, 1=hip, 2=flat, 3=industrial_gable, 4=church_spire`)
       - `18`: `uint8 tier` (`0=close, 1=mid, 2=far`)
       - `19`: `uint8 colorSeed` (`0..255`)
   - `parseBuildingsBinary(buf)` returns `{ count, records }` where `records` is an array of compact tuples `[x, z, w, d, h, rot, kindCode, roofCode, tier, colorSeed]` (or `null` if invalid magic/size).
   - `loadVipavaBuildings()` caches successful results, resolves to `null` on failure (never throws), and clears in-flight promise on error.
   - Also extend `loadVipavaOSM()` to pass through optional `urbanZones: Array.isArray(json.urbanZones) ? json.urbanZones : []` alongside `roads`, `buildings`, `landmarks`.

### 3. Terrain Quadtree Mesh Resolution & Slope-Aware Splitting (`src/config.js`, `src/world/terrainview.js`)
- In `src/config.js`:
  - Set `terrainMinSize: 128` (was `256`), `terrainMaxLevel: 8` (was `7`), `terrainDetailDistance: 1.55` (was `1.35`), `tileCacheLimit: 900` (was `700`).
  - Keep `QUALITY.low/medium/high` `segmentsNear`/`segmentsFar` reasonable so FPS stays 60.
- In `src/world/terrainview.js`:
  - In `_buildTile(node)`: increase mid-ring density (`level >= 6 ? preset.segmentsNear : level >= 3 ? Math.max(30, Math.min(preset.segmentsNear, 36)) : preset.segmentsFar`).
  - In `_rebuild(center)`: add lightweight **elevation/slope-aware splitting** for mid-level tiles (`level >= 3 && level < maxLevel`): sample 5 points on the tile (4 corners + center); if `maxH - minH > Math.max(35, size * 0.06)`, boost the split factor by `1.30×` so steep valley rims (Nanos, Trnovski gozd, Solkan gorge, Štanjel hill) subdivide one level deeper while flat plains/ocean don't waste triangles!
  - Bump per-frame build budget slightly (`_cam.y > 3000 ? 10 : 6`) so finer tiles stream in seamlessly without holes.

### 4. Tests & Verification (`tests/dem_test.mjs`)
- Keep all existing assertions passing.
- Add unit tests in `tests/dem_test.mjs` covering:
  - Nested `detailDEM` blending (exact HD inside inner box, smooth transition across `blendM` border, exact outer DEM outside inset).
  - Bicubic interpolation smoothness & non-overshoot on a 6×6 grid (and linear ramp exactness).
  - `parseBuildingsBinary()` round-trip verification (header validation, record decoding, invalid magic returns `null`).
- Run `node tests/dem_test.mjs && npm test && npm run build` and confirm all pass.
