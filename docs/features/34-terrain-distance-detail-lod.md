# Feature 34 — Multi-Scale Terrain Detail Distance LOD

## Goal
Fix terrain micro-detail disappearing unless flying dangerously low (< 450 m) and replace it with a smooth **4-octave continuous distance/altitude LOD cascade** so terrain detail is clearly visible from high altitude and progressively gains crispness as you descend (and smoothly loses fine resolution as you climb away).

## Owned Files (DO NOT modify files outside this list)
- `src/world/terrainview.js`

## Root Cause Found
In `src/world/terrainview.js` (`DETAIL_NORMAL`, line 266):
```glsl
float microAA = 1.0 - smoothstep( 0.35, 1.6, fwidth( terrP.x ) + fwidth( terrP.y ) );
```
Because `terrP` is in metres, `fwidth(terrP.x) + fwidth(terrP.y)` already exceeds `1.6 m/px` by ~450–600 m distance/altitude, zeroing out `bumpAmt` for **all** octaves (even 28 m and 140 m)!

## Detailed Specification (`src/world/terrainview.js`)

### 1. 4-Octave Per-Band Continuous Mip/Distance Fade (`DETAIL_ALBEDO` & `DETAIL_NORMAL`)
- Compute screen-space pixel footprint in metres:
  ```glsl
  float pxM = max( fwidth( terrP.x ), fwidth( terrP.y ) );
  ```
- Replace the 2-band fade (`f6`, `f28`) + global `microAA` with **4 independent octave weights**, each combining a smooth distance rolloff AND a wavelength-matched Nyquist anti-aliasing rolloff (so each octave gracefully fades out right before it would shimmer, while coarser octaves stay vivid at high altitude):
  - **Fine `6 m` (`f6`)**: `(1.0 - smoothstep(1200.0, 4800.0, terrDist)) * (1.0 - smoothstep(1.4, 4.2, pxM))`
  - **Medium `28 m` (`f28`)**: `(1.0 - smoothstep(4500.0, 16000.0, terrDist)) * (1.0 - smoothstep(6.5, 19.0, pxM))`
  - **Coarse `140 m` (`f140`)**: `(1.0 - smoothstep(15000.0, 36000.0, terrDist)) * (1.0 - smoothstep(32.0, 92.0, pxM))`
  - **Macro `520 m` (`f520`)**: `1.0 - smoothstep(34000.0, 56000.0, terrDist)` (sample `vec3 n520 = thNoise(terrP * (1.0 / 520.0), 131.0); float d520 = n520.x - 0.5;`)
- **Albedo detail (`DETAIL_ALBEDO`)**:
  - Blend all 4 octaves smoothly so high-altitude flight shows rich valley/mountain sculpt (`d520`, `d140`), mid-altitude reveals crisp parcels/ledges (`d28`), and low-altitude reveals rocks/grass/vine rows (`d6`):
    ```glsl
    float tone = 1.0 + ( d6 * 0.24 * f6 + d28 * 0.30 * f28 + d140 * 0.24 * f140 + d520 * 0.18 * f520 ) * detailA;
    ```
  - Widen **Karst strata AA** (`strataAA`) so limestone cliff bands on Nanos & Trnovski Gozd remain crisp from 4–12 km away (`1.0 - smoothstep(0.35, 1.35, fwidth(vTerrWorld.y) / max(uTerrStrata.x, 1.0))`).
  - Widen **Valley agricultural patchwork AA** (`fieldAA`) so Vipava Valley vineyards & fields stay clearly visible from high altitude (`1.0 - smoothstep(0.28, 0.95, pxM / 120.0)` and smooth distance fade `1.0 - smoothstep(14000.0, 26000.0, terrDist)`), and keep vine rows visible out to `4,200 m`.
- **Analytic Micro-Bump Normal (`DETAIL_NORMAL`)**:
  - Remove the global `microAA` killer!
  - Compute per-octave gradient directly weighted by each octave's own fade (`f6`, `f28`, `f140`, `f520`):
    ```glsl
    vec2 detailG = n6.yz   * ( 0.65 * f6   / 6.0 )
                 + n28.yz  * ( 2.40 * f28  / 28.0 )
                 + n140.yz * ( 6.80 * f140 / 140.0 )
                 + n520.yz * ( 14.0 * f520 / 520.0 );
    ```
  - Widen `bumpFade` to `1.0 - smoothstep(32000.0, 52000.0, terrDist)` so sunlight carves out 3D ridges, karst ledges, and valley relief all the way from high cruise altitude down to treetop level!

### 2. Quadtree Geometric LOD Smoothness (`_rebuild`)
- Raise the quadtree split factor in `_rebuild` slightly from `CONFIG.world.terrainDetailDistance * 1.06` to `CONFIG.world.terrainDetailDistance * 1.22` (keeping `maxLevel` and `tileCacheLimit` safe) so mountain ridges and valley slopes gain geometric resolution earlier as you approach from altitude.

### 3. Verification
- Verify `npm test` and `npm run build` pass with zero errors and no shader syntax issues.
