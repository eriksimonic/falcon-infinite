# Feature 40 — True Per-Pier & Per-Footprint Grounding for Landmarks, Bridges, Viaducts & Traffic

## Goal
Eliminate every floating and buried bridge, viaduct, dam, church, castle, tower, and highway across Vipava Valley by replacing single-point center sampling with **exact per-pier and per-corner terrain grounding**, adding real **OSM bridge viaduct spans with piers** in `roadnet.js`, and aligning night highway traffic over bridged decks.

## Owned Files (DO NOT modify files outside this list)
- `src/world/landmarks.js`
- `src/world/roadnet.js`
- `src/world/traffic_roads.js`
- `tests/landmarks_test.mjs`
- `tests/roadnet_test.mjs`

## Detailed Specification

### 1. Landmark Per-Pier & Per-Corner Grounding (`src/world/landmarks.js`)
Keep `obj.position.set(lm.x, lm.y, lm.z)` and `obj.rotation.y = lm.rot` (so `tests/landmarks_test.mjs` contract `lm.y === heightAt(lm.x, lm.z)` stays 100% intact!), and pass the active `heightAt` sampler into `_buildLandmark(lm, sample)` so every child builder can convert any local `(lx, lz)` to world `(wx, wz)` using Three.js's exact `rotation.y = rot` transform:
```js
const localGroundY = (lm, heightAt, lx, lz) => {
  const c = Math.cos(lm.rot || 0);
  const s = Math.sin(lm.rot || 0);
  const wx = lm.x + lx * c + lz * s;
  const wz = lm.z - lx * s + lz * c;
  const h = heightAt(wx, wz);
  return Number.isFinite(h) ? h - lm.y : 0; // local Y of the ground at (lx, lz)
};
```

1. **Fix `_foundation()`**:
   - Upgrade `_foundation(parent, w, d, color, x = 0, z = 0, topY = FOUNDATION_TOP, bottomY = -FOUNDATION_DEPTH)`:
     ```js
     const h = Math.max(1.0, topY - bottomY);
     return this._box(parent, color, x, bottomY + h * 0.5, z, w, h, d);
     ```
   - Never hardcode `(0, ..., 0)`! Every sub-structure passes its own local `(x, z)` and exact `bottomY = minCornerLocalY - 6.0`!
2. **Helper `_footprintRange(lm, heightAt, cx, cz, w, d)`**:
   - Samples the 4 corners + center of local box `(cx ± w/2, cz ± d/2)` via `localGroundY` and returns `{ minY, maxY, centerY }`.
3. **Terrain-Conforming Multi-Pier Bridges (`_buildBridge(parent, lm, heightAt)`)**:
   - Sample ground height along the entire bridge length (`t = -0.5, -0.35, -0.2, 0, 0.2, 0.35, 0.5`):
     - `yStart = localGroundY(lm, heightAt, -length * 0.5, 0)`
     - `yEnd = localGroundY(lm, heightAt, +length * 0.5, 0)`
     - `yMinSpan = min` of interior samples (the river/gorge bottom!)
     - `yMaxSpan = max` of all samples
   - **Deck elevation** (`deckYAt(lx)`):
     - Set a realistic level-or-gently-sloped deck that connects both banks cleanly AND clears the valley floor:
       - `targetA = Math.max(yStart + 1.2, yMinSpan + Math.min(height, 18))`
       - `targetB = Math.max(yEnd + 1.2, yMinSpan + Math.min(height, 18))`
       - Clamp deck slope `|targetB - targetA| / length <= 0.08` (max 8% bridge grade!) by raising the lower end if a canyon is asymmetric, AND ensure the deck stays at least `Math.max(yMaxSpan + 0.8, yMinSpan + Math.min(height, 26))` above ground along the interior so the roadway is **NEVER buried inside the hillside**!
     - Build the deck, roadway strip, and parapets following the exact bank-to-bank pitch `deckPitch = Math.atan2(deckB - deckA, length)` (rotating deck boxes around local Z by `deckPitch`, centered at `y = (deckA + deckB) * 0.5`, length `Math.hypot(length, deckB - deckA)`).
   - **Every Pier Independently Grounded**:
     - For each pier at local `px`:
       - Sample exact ground under that pier: `gPier = Math.min(localGroundY(lm, heightAt, px, -pierD*0.5), localGroundY(lm, heightAt, px, 0), localGroundY(lm, heightAt, px, pierD*0.5))`
       - Pier top meets the deck underside at `pierTop = deckYAt(px) - 0.8`
       - Pier bottom extends deep underground to `pierBot = gPier - 6.0` (deep foundation footing anchored at `(px, 0)`, NOT `(0, 0)`!)
       - Pier height `pierH = Math.max(2.0, pierTop - pierBot)`
       - Place pier shaft at `(px, pierBot + pierH * 0.5, 0)` and cutwater footing at `(px, gPier + 1.0, 0)`.
     - Place the grand central arch voussoirs & spandrels cleanly between the two central flanking piers (`-span/2` and `+span/2`), springing cleanly below the deck underside and never floating in thin air.
   - Store `lm._groundMeta = { deckA, deckB, pierGrounds }` (pure numbers) so automated grounding tests can directly audit every pier!
4. **Canyon-Anchored Dams (`_buildDam(parent, lm, heightAt)`)**:
   - Sample terrain along the dam (`-L/2, -L/4, 0, +L/4, +L/2`) → `minY`, `maxY`.
   - Set crest height `crestY = Math.max(height, maxY + 2.0)` and wall bottom `botY = minY - 6.0`, building the gravity wall, foundation, spillway chutes, and toe buttresses from `botY` to `crestY` so neither end floats nor sinks below the canyon floor!
5. **Corner-Grounded Churches, Castles, Towers & Lighthouses**:
   - `_buildChurch`: sample nave footprint (`_footprintRange(..., 0, 0, naveW+4, naveD+4)`) AND campanile footprint (`_footprintRange(..., 0, tz, towerW+3, towerW+3)`). Place nave plinth at `(0, 0)` down to `naveRange.minY - 6.0` and campanile plinth at **`(0, tz)`** down to `towerRange.minY - 6.0`! Start the visible church floor at `Math.max(0, naveRange.maxY - 1.5)` so uphill slopes never bury the church portal!
   - `_buildCastle`: sample full curtain-wall & 4 corner-tower footprints; extend the castle plinth down to `minY - 6.0` and place each corner tower's base down to its own local ground `- 6.0`!
   - `_buildTower` & `_buildLighthouse`: sample base pad 4 corners and extend plinth down to `minY - 6.0`.
   - Ensure `_addNightGlow` aligns vertically with any adjusted deck/nave height.

### 2. Real OSM Road Bridges / Viaducts & Coastal Bridge Piers (`src/world/roadnet.js`)
1. **Preserve `bridge` flag in `setCustomRoads`**:
   - Accept optional `r.b === 1 || r.bridge === true` on each baked road item and preserve `bridge: Boolean(...)` on each normalized polyline (passing it through `splitAroundAirports`).
2. **Bridge Deck Smoothing & Pier Generation in `buildRoadRibbonData(polylines, heightAt)`**:
   - Keep **100% backwards-compatibility** for standard (non-bridge, dry land) polylines so `tests/roadnet_test.mjs` exact `DECK_LIFT = 0.38` and `SKIRT_DEPTH = 1.6` checks pass untouched!
   - For polylines with **`line.bridge === true`** (real OSM bridges & viaducts, e.g. H4 Vipava viaducts, Soča bridges):
     - Sample terrain at endpoints `hStart = heightAt(pts[0])` and `hEnd = heightAt(pts[n-1])`.
     - Compute smooth interpolated deck elevation `interpY(t) = hStart*(1-t) + hEnd*t + DECK_LIFT`, clamped to `Math.max(interpY(t), localTerrain + 1.2)` along interior samples so the bridge cleanly spans rivers/ravines without ever diving underground!
     - Count each bridged polyline in `bridgeCount`.
     - Emit concrete **bridge pier descriptors** (`piers: [{ x, z, topY, bottomY, width, rot }]`) every `~45 m` along spans where `deckY - localTerrain > 1.8 m`, extending down to `localTerrain - 5.0 m` (so every viaduct pier is firmly rooted in the valley floor!).
   - For **water-level bridges** (`localTerrain < WATER_LEVEL`):
     - Keep deck at `>= BRIDGE_DECK (2.6 m)` and emit pier descriptors every `~40 m` extending down to `Math.min(localTerrain, -3.5)` (well below the Adriatic sea plane at `-0.45 m`) so coastal bridges never float above water!
   - Return `piers` array from `buildRoadRibbonData` (in addition to existing `positions, normals, uvs, indices, segmentCount, bridgeCount`).
3. **Attach Bridge Piers Mesh as a Child of `this.mesh` in `RoadNetwork`**:
   - Create `this.pierMesh = new THREE.Mesh(new THREE.BufferGeometry(), pierMat)` (`name = 'highway-piers'`) and attach via **`this.mesh.add(this.pierMesh)`** (NOT `scene.add`, so `scene.add` is still called once with `this.mesh` and `tests/roadnet_test.mjs` line 188 passes cleanly!).
   - Build merged box geometry for all `data.piers` inside `_applyGeometry(data)` and dispose cleanly in `dispose()`.

### 3. Align Highway Traffic Over Bridged Roads (`src/world/traffic_roads.js`)
- When `raw.b === 1 || raw.bridge === true` in `setCustomRoads()`, compute road point `ys[i]` using the same linear-interpolated bridge deck profile (`Math.max(interpY, localTerrain + 1.2) + LIGHT_LIFT`) so night headlight/taillight streaks glide smoothly across H4 viaducts and bridges instead of dipping underneath the deck!

### 4. Tests & Verification (`tests/landmarks_test.mjs`, `tests/roadnet_test.mjs`)
- Keep ALL existing assertions passing in both tests.
- Add tests in `tests/landmarks_test.mjs`:
  - Steep canyon bridge test (60 m elevation difference across 220 m span): assert every pier reaches `<= localGroundY - 4 m` and deck never falls below local ground along the span!
  - Hilltop church test (12 m slope): assert BOTH nave and campanile foundations extend below their local corners!
- Add tests in `tests/roadnet_test.mjs`:
  - Bridged polyline over a deep canyon (`bridge: true`): assert smooth elevated deck above canyon floor, `bridgeCount >= 1`, and grounded piers extending below canyon ground!
- Run `node tests/landmarks_test.mjs && node tests/roadnet_test.mjs && node tests/living_vipava_test.mjs`.
