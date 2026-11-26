# Feature 35 — Photorealistic Vipava Palette, Tamed Bloom & Building Contrast

## Goal
Address live-flight visual feedback in Vipava Valley:
1. **Reduce bloom by ~60%** and fix the dusk/golden-hour snap bug so buildings do not glow/wash out — allowing strong glare on buildings ONLY when the sun is directly behind the pilot reflecting off sun-facing glass.
2. **Desaturate the Vipava terrain** ("too green") into a realistic Mediterranean-Alpine Karst palette (muted olive/sage meadows, dusty ochre earth, dark spruce forest, pale weathered limestone) with crisper micro-relief contrast.
3. **Boost building-vs-terrain distinction** with realistic Adriatic terracotta / dark slate roofs, deeper ground-contact AO, and crisper sunlit-vs-shadow facade contrast.

## Owned Files
- `src/sim/postfx.js`
- `src/world/buildings.js`
- `src/world/terrainview.js`
- `tests/cinematic_juice_test.mjs` (only if constant assertions need updating)

## Detailed Specification

### 1. Tamed Selective Bloom (`src/sim/postfx.js`)
- Reduce bloom intensity by ~60% and raise threshold so daylight walls/terrain never bloom:
  - `DAY_THRESHOLD = 1.05` (was `0.88`)
  - `NIGHT_THRESHOLD = 0.88` (was `0.72`)
  - `DAY_STRENGTH = 0.14` (was `0.36`, ~61% reduction)
  - `NIGHT_STRENGTH = 0.24` (was `0.58`, ~59% reduction)
  - `BLOOM_RADIUS = 0.36` (was `0.45`)
- Update `setNight(night)` to accept continuous numeric `0..1` blend values (while staying backwards-compatible with booleans: `typeof night === 'number' ? clamp(night, 0, 1) : (night ? 1 : 0)`), so golden hour (`sky.night ~ 0.05`) does NOT snap to night bloom!
- Keep `pulseBloom()` working cleanly for detonations/Mach crossing (cap pulse strength softly so explosions still pop without blinding the screen).

### 2. Building Bloom Reduction, Sun-Behind-Pilot Reflection & High-Contrast Roofs (`src/world/buildings.js`)
In `makeBuildingMaterial()` fragment shader:
- **Reduce night window emissive by ~60%**: change `col += winColor * lit * uNight * 2.6 * 1.45 * brightness;` to `col += winColor * lit * uNight * 1.45 * brightness;` so night towns glow warmly without blooming into blobs.
- **Keep normal daytime facades below bloom threshold, with sun-behind-me glint**:
  - Soften base daytime wall lighting slightly (`uAmbient * 0.85 + uSunColor * (ndl * 0.78 + wrap * 0.10)`) for sharper sun-vs-shadow side contrast and zero diffuse blowout.
  - Compute `vec3 viewDir = normalize(cameraPosition - vWorld);` and `float sunBehind = smoothstep(0.45, 0.94, dot(viewDir, uSunDir));` (sun behind pilot shining directly onto the facade in front).
  - Add a crisp sun-behind-pilot reflection boost on sun-facing glass (`col += uSunColor * glass * ndl * sunBehind * day * 0.95;`) — so strong specular bloom on buildings ONLY happens when the sun is behind you!
- **Distinctive Terracotta & Dark Slate Roofs + Deeper Ground AO**:
  - Deepen base AO from `0.72` to `0.54` (`mix(0.54, 1.0, smoothstep(0.0, 0.18, vLocal.y))`) so every building sits crisply anchored on the terrain.
  - Replace the pale grey rooftop tint with a realistic Vipava/Adriatic roof palette hashed per building (`buildingSeed`):
    - ~68% weathered Mediterranean terracotta tiles (`vec3(0.56, 0.26, 0.17)` to `vec3(0.44, 0.21, 0.15)`)
    - ~32% dark architectural/industrial slate (`vec3(0.26, 0.28, 0.31)` to `vec3(0.35, 0.36, 0.37)`)
    - Lit by `(uAmbient * 0.8 + uSunColor * (ndl * 0.82 + 0.12))` with subtle tile mottle — making every town & village stand out unmistakably against the muted terrain!

### 3. Photorealistic Desaturated Vipava Terrain (`src/world/terrainview.js`)
- Desaturate `PALETTES.vipava`:
  - `grassLow: 0x6d7556` (muted olive-sage valley floor)
  - `grassHigh: 0x84896c` (dry sunlit hillside)
  - `forest: 0x324231` (deep dark alpine spruce/pine)
  - `rock: 0xb2ada0` (weathered Karst limestone)
  - `rockDark: 0x787368` (crisp shadow limestone)
  - `dirt: 0x96876b` (dusty earth)
- Desaturate `TERRAIN_DETAILS.vipava`:
  - `bump: 1.04` (crisper relief contrast from altitude)
  - `fieldColors: [0x667349, 0x99896c, 0x8f946c, 0x4c5939]` (muted vineyards, dry earth, pale meadow, dark olive groves)
- At the end of `DETAIL_ALBEDO` (just before `diffuseColor.rgb = terrAlb;`), apply a subtle realistic earth desaturation (~20% toward luminance):
  ```glsl
  float finalLum = dot( terrAlb, vec3( 0.2126, 0.7152, 0.0722 ) );
  terrAlb = mix( terrAlb, vec3( finalLum ), 0.20 );
  ```

### 4. Verification
- Run `npm test` (all 24 suites) and `npm run build` and verify zero failures.
