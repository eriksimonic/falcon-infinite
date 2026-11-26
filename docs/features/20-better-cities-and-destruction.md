# Feature 20 — Better Cities, Terrain-Hugging Streets & Destructible Buildings

## Problems
1. **City streets float/clip on slopes**: `src/world/buildings.js` rendered settlement roads as 90 m flat horizontal `PlaneGeometry` instances (`rotation.set(0, yaw, 0)`), creating floating stair-steps on any sloped terrain.
2. **Floating building corners**: `buildings.js` placed buildings at `terrainHeight(center) - 0.35`, so wide buildings on hills had downhill corners hovering in mid-air.
3. **Uniform/boxy city generation**: Cities looked like scattered plain boxes without clear architectural hierarchy, and had no perimeter ring roads or varied roofs/podiums.
4. **No building destruction or craters**: Dropping Mk-82 bombs or firing AIM-9 rockets into cities dealt zero damage and left zero craters or rubble.

## Goal
1. **Better City Layouts (`src/world/settlements.js`)**:
   - Preserve **100% compatibility** with `tests/settlements_test.mjs` (every single contract check: determinism, airport clearances, nested clearances, building counts per type, road clearance, speed `< 30 ms` cold!).
   - Improve metro layouts: stronger downtown CBD skyscraper core with landmark towers, clean avenue boulevards, a perimeter ring/beltway road connecting outer blocks, clearer residential/industrial zoning, and stricter slope check on individual buildings so buildings sit on sensible ground.
2. **Terrain-Conforming City Streets, Grounded Architecture & Destruction (`src/world/buildings.js`)**:
   - **Continuous Terrain-Hugging Street Ribbons**: Replace `this.roadMesh` flat instanced planes with a single continuous `THREE.Mesh` (`BufferGeometry`) sampling `terrainHeight` every `20 m` along every settlement road (left/right edges at `terrainHeight + 0.32` plus `-1.2 m` curb skirts, with asphalt + lane-line texture).
   - **Zero Floating Building Corners**: For every building, sample `terrainHeight` at its 4 footprint corners (`cx ± hw, cz ± hd` rotated by `rot`), set `minY = Math.min(c0, c1, c2, c3) - 1.2` and `topY = Math.max(c0, c1, c2, c3) + b.h`, and draw the building from `minY` to `topY` (`height = topY - minY`) so every structure is solidly grounded into hillsides!
   - **Richer Architectural Silhouettes**:
     - `tower`: wide podium base (`1.12×` width, `16%` height), main shaft, stepped upper crown (`0.72×` width), rooftop mechanical room, and spire on tall towers (`> 75 m`).
     - `apartment`: main block + rooftop parapet/utility penthouse.
     - `industrial`: wide hall + clerestory roof monitor strip.
     - `house` / `shop`: main block + darker stepped roof cap.
   - **Destructible Buildings & Blast Craters**:
     - Maintain `this.destroyed = new Set()` (keyed by deterministic building key `${s.id}:${Math.round(b.x)}:${Math.round(b.z)}`) and `this.craters = []` (capped at 64, rendered as dark charred terrain-hugging crater discs).
     - Export method `applyBlast(position, splashRadius, damage = 100)`:
       - Adds a charred crater at `position` (if `damage >= 40`).
       - Checks nearby settlements (`settlementsNear(pos.x, pos.z, splashRadius + 1600)`): any building whose center is within `splashRadius + Math.max(b.w, b.d) * 0.4` is added to `this.destroyed`!
       - Sets `this._needsRebuild = true` so destroyed buildings immediately collapse into low dark charred rubble piles (`h = 1.6..3.2 m`, dark charcoal color `0x22201e`)!
       - Returns `{ destroyedCount, positions }` (array of `{ x, y, z }` of newly destroyed buildings so `main.js` can spawn smoke plumes and toasts).
     - Add `resetDamage()` to clear `this.destroyed` and `this.craters` on mission reset/respawn.
   - Make `BuildingSystem` **headless-safe** when `scene === null` (no `document.createElement` or WebGL calls when `scene === null`) so `tests/cities_destruction_test.mjs` can test `applyBlast`, crater creation, and rubble collapse directly in Node!

## File Ownership (STRICT)
Modify / create ONLY:
- `src/world/settlements.js`
- `src/world/buildings.js`
- `tests/cities_destruction_test.mjs`

Do NOT modify any other files.

## Verification (`tests/cities_destruction_test.mjs`)
Standalone headless Node test verifying:
1. `BuildingSystem(null, preset)` constructs cleanly without DOM.
2. `applyBlast` on a real settlement building position destroys buildings within `splashRadius`, returns `destroyedCount >= 1` and valid `positions`, and creates a crater.
3. Calling `applyBlast` a second time at the exact same spot does not double-count already-destroyed buildings (`destroyedCount === 0`).
4. `resetDamage()` clears destroyed buildings and craters cleanly.
5. Also run `node tests/settlements_test.mjs` and verify all existing settlement checks pass with 0 failures!
6. Exits with code `0` and prints `ALL CITIES & DESTRUCTION CHECKS PASSED`.
