# Feature 27 — Real 100×100 km Vipava Valley DEM Theater

## Goal
Add **`VIPAVA VALLEY`** (`vipava`) as a 3rd selectable Theater in `FALCON / INFINITE` (alongside `TEMPERATE` and `DESERT STRIKE`), powered by the real baked **100 km × 100 km** elevation dataset (`public/media/vipava_dem.png`, `1024×1024` lossless 16-bit RG-encoded DEM centered on Ajdovščina Airfield `LJAJ` at `45.8878°N, 13.8869°E`).

## File Ownership (STRICT)
Create / modify ONLY:
- `src/world/dem.js` (new — headless-safe 16-bit RG DEM loader + bilinear sampler + smooth edge blend)
- `src/world/terrain.js` (hook optional active DEM into `baseHeight(x, z)` + expose `setActiveDEM(dem)` and `getActiveDEM()`)
- `src/config.js` (add `vipava` entry to `THEATERS`)
- `src/world/terrainview.js` & `src/sim/sky.js` (Mediterranean/Karst limestone & vineyard valley palette for `vipava` theater)
- `index.html` (add `VIPAVA` button in theater selector)
- `tests/dem_test.mjs` (new — headless unit test)

(Note: `src/main.js` wiring — loading `./media/vipava_dem.png` on theater switch to `'vipava'`, setting `setActiveDEM(dem)`, refreshing terrain/buildings/roads/carrier, and spawning at `LJAJ` `(0, 0)` — will be wired in the sequential integration step alongside Feature 25/26!)

## Module Contract (`src/world/dem.js`)
Must be **100% headless-safe** (never touch `document` or `Image` at import time; accept raw `Uint8Array` RGBA pixels directly for unit tests AND provide `loadDEMFromPNG(url, meta)` for browsers).

Export `export class HeightmapDEM`:
- `new HeightmapDEM({ width, height, sizeM, offset = -200, scale = 16, pixels })`
  - `pixels`: `Uint8Array` / `Uint8ClampedArray` of length `width * height * 4` (RGBA where `R` is high byte, `G` is low byte -> `val = (R << 8) | G`, `elev = val / scale + offset`), OR `Float32Array` of length `width * height`.
  - Decodes once into a `Float32Array(width * height)` (`this.data`) for ultra-fast O(1) bilinear lookup!
- Methods:
  - `sample(x, z)`:
    - World `(x, z)` in `[-sizeM/2, +sizeM/2]`:
      - `u = (x / sizeM + 0.5) * (width - 1)`
      - `v = (z / sizeM + 0.5) * (height - 1)`
    - Returns bilinear-interpolated elevation in metres if inside bounds, or `null` if outside `[-sizeM/2, +sizeM/2]`.
  - `blendWeight(x, z)`:
    - Returns `1.0` inside `[-44000, +44000]` (inner 88 km), smoothly ramping via cubic smoothstep to `0.0` at `±50000 m` (edge of the 100 km box), so the real Vipava Valley DEM blends seamlessly into the infinite procedural world with zero cliff seams!
- Export `export async function loadVipavaDEM(pngUrl = './media/vipava_dem.png', metaUrl = './media/vipava_meta.json')`:
  - Fetches `metaUrl` JSON and loads `pngUrl` into an offscreen `<canvas>` (`2d` context, `getImageData`), constructs and returns a `HeightmapDEM` (attaching `dem.meta = meta`). Caches the loaded promise so switching back to `vipava` is instant!

## Integration in `src/world/terrain.js`
- Export `setActiveDEM(dem)` and `getActiveDEM()`.
- In `baseHeight(x, z)`:
  - If `_activeDEM` is set:
    - `const w = _activeDEM.blendWeight(x, z);`
    - If `w > 0`:
      - `const demH = _activeDEM.sample(x, z);`
      - If `w >= 0.9999` return `demH`;
      - Otherwise smoothly blend `demH * w + proceduralBaseHeight(x, z) * (1 - w)`!
  - When `_activeDEM === null` (default for `temperate` / `desert`), `baseHeight(x, z)` is **100% bit-identical** to before so `tests/settlements_test.mjs` and all other tests are completely unaffected!

## Theater Palette (`src/config.js`, `src/world/terrainview.js`, `src/sim/sky.js`, `index.html`)
- `THEATERS.vipava = { label: 'VIPAVA VALLEY', demUrl: './media/vipava_dem.png', metaUrl: './media/vipava_meta.json' }`.
- `terrainview.js`: add `vipava` Mediterranean-Karst palette (rich vineyard valley green, pale Karst limestone cliffs, alpine spruce forest, deep Adriatic blue water, warm Mediterranean sunlight).
- `sky.js`: crisp Adriatic/Mediterranean blue sky + warm limestone horizon haze for `vipava`.
- `index.html`: add `<button data-theater="vipava">VIPAVA</button>` in the Theater pill group.

## Verification (`tests/dem_test.mjs`)
Standalone headless Node test verifying:
1. `HeightmapDEM` decodes synthetic 16-bit RG pixels accurately (`-135 m` sea, `112.4 m` valley, `1313 m` Nanos, `2236 m` Alps) within `< 0.1 m`.
2. Bilinear interpolation between grid cells is smooth and exact.
3. `blendWeight(0, 0) === 1`, `blendWeight(47000, 0)` is strictly between `0` and `1`, and `blendWeight(51000, 0) === 0`.
4. `setActiveDEM(dem)` makes `baseHeight(0, 0)` return the DEM elevation, blends smoothly at `47 km`, and `setActiveDEM(null)` restores exact procedural `baseHeight`.
5. `node tests/dem_test.mjs` exits `0` and prints `ALL DEM CHECKS PASSED`.
