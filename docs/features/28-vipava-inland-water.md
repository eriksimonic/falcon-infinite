# Feature 28 — Real Inland Water Bodies (Vipava & Soča Rivers + Lakes/Reservoirs)

## Goal
Render real OpenStreetMap inland rivers (`Vipava`, `Soča`, `Idrijca`, `Hubelj`, etc.) and lakes/reservoirs (`Vogršček`, `Solkan`, `Cerknica`, etc.) from `public/media/vipava_water.json` onto the 100×100 km Vipava Valley DEM as reflective, animated blue water surfaces!

## File Ownership (STRICT)
Create / modify ONLY:
- `src/world/water.js` (new — `InlandWaterSystem` + headless-safe `buildInlandWaterGeometry(data, heightAt)`)
- `src/world/dem.js` (add `loadVipavaWater(url = './media/vipava_water.json')`)
- `src/world/world.js` (own `this.inlandWater = new InlandWaterSystem(scene)` and update its atmosphere/time in `update()`)
- `src/main.js` (load `loadVipavaWater()` in `setTheater('vipava')` and call `this.world.inlandWater.setWaterData(water)` — clear with `setWaterData(null)` on other theaters)
- `tests/water_test.mjs` (new — headless unit test)
- `package.json` (append `&& node tests/water_test.mjs` to `scripts.test`)

## Module Contract (`src/world/water.js`)
Must be **100% headless-safe** when `scene === null`.

### 1. Pure Export: `export function buildInlandWaterGeometry(data, heightAt)`
- `data`: `{ rivers: Array<{ w: number, pts: Array<[x, z]> }>, lakes: Array<Array<[x, z]>> }`
- `heightAt`: `(x, z) => number`
- **Rivers**:
  - Resample each river polyline every `~25 m`.
  - Place left/right surface vertices at `heightAt(x, z) + 0.35` (skipping points already below sea level `<= 0.4 m`, since the Adriatic Sea plane handles sea level!).
  - Emit smooth upward-facing normals (`0, 1, 0`) and continuous triangles with `Uint32Array` indices.
- **Lakes / Reservoirs**:
  - For each polygon `pts` (array of `[x, z]`):
    - Sample `heightAt` around the perimeter/centroid to compute a consistent flat water level `lakeY = Math.max(1.2, minPerimeterH + 0.45)`.
    - Triangulate the polygon cleanly using `THREE.ShapeUtils.triangulateShape(contour, [])` (using `THREE.Vector2(x, z)`!) so concave lakes/reservoirs (like Vogršček!) triangulate cleanly with zero artifacts!
    - Emit vertices `(x, lakeY, z)` and upward-facing triangles (ensuring counter-clockwise / `+Y` winding!).
- Returns `{ positions: Float32Array, normals: Float32Array, indices: Uint32Array, riverSegments: number, lakeCount: number }`.

### 2. `export class InlandWaterSystem`
- `new InlandWaterSystem(scene = null)`
- Uses a reflective animated Mediterranean-river/lake `ShaderMaterial` (matching `WaterSurface`'s Adriatic blue-emerald palette with gentle animated ripples, Fresnel sky reflection, sun specular attenuated with distance, `fog: true`, `polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1` so inland rivers/lakes sit crisply on top of terrain with zero Z-fighting!).
- `setWaterData(data, heightAt = terrainHeight)`: builds & attaches the merged `BufferGeometry` mesh (or hides/clears if `data == null`).
- `update(dt, sky)`: updates `uTime`, `uSunDir`, `uSunColor`, `uSkyColor`.
- `dispose()`: disposes geometry & material cleanly.

## Verification (`tests/water_test.mjs`)
Standalone headless Node test verifying:
1. `buildInlandWaterGeometry` builds finite positions/normals/indices for both rivers on sloped terrain (within `0.35 ± 0.05 m` of `heightAt`) and concave lake polygons (`THREE.ShapeUtils.triangulateShape`).
2. Sea-level river segments (`heightAt <= 0.4`) are skipped cleanly.
3. `InlandWaterSystem(null)` constructs, accepts `setWaterData`, updates, and clears on `setWaterData(null)` without DOM/WebGL.
4. `node tests/water_test.mjs` exits `0` and prints `ALL WATER CHECKS PASSED`.
