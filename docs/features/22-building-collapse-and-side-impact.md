# Feature 22 — 3D Building Side-Wall Impacts & Animated Burn / Collapse

## Goal
1. **3D Mid-Air Building Collision (`hitBuilding`)**: Projectiles hitting the *side wall* or *roof* of any standing city building detonate right at the exact 3D impact point instead of passing through to the ground.
2. **Animated Building Burn & Collapse**: Destroyed buildings no longer snap instantly to flat rubble; instead they ignite, tilt, shake, and collapse smoothly into dark charred rubble over `2.4–3.8 s` while exposing their burning positions so VFX can emit flames and smoke plumes during the collapse.

## File Ownership (STRICT)
Modify ONLY:
- `src/world/buildings.js`
- `tests/cities_destruction_test.mjs`

Do NOT modify any other files.

## Module Contract (`src/world/buildings.js`)

### 1. `hitBuilding(p0, p1)` on `BuildingSystem`
Headless-safe (works when `scene === null`!).
- Inputs: `p0`, `p1` (`{ x, y, z }` segment endpoints in world space).
- Algorithm:
  - Compute segment midpoint `(mx, mz)` and half-length `halfLen = 0.5 * hypot(p1.x - p0.x, p1.z - p0.z)`.
  - Query `settlementsNear(mx, mz, halfLen + 1600)` (or fast bounding rejection per settlement `dist(mid, s) <= s.radius + halfLen + 60`).
  - For each settlement `s` and building `b` in `s.buildings`:
    - Skip if `this.destroyed.has(key)` (already flat rubble).
    - Compute building vertical bounds: `minY = cornerMinY(b) - 1.2`, `topY = cornerMaxY(b) + b.h` (if `this.collapsing.has(key)`, scale current top height by remaining collapse fraction!).
    - Quick XZ bounding-circle reject against segment midpoint.
    - Transform `p0` and `p1` into the building's local unrotated frame around `(b.x, 0, b.z)` by rotating `(x - b.x, z - b.z)` by `-b.rot` (note: in Three.js `rotation.y = rot` maps local `(lx, lz)` to world `(lx*cos + lz*sin, -lx*sin + lz*cos)`, so inverse is `(dx*cos - dz*sin, dx*sin + dz*cos)` — verify exact sign matches `addBox`!).
    - Perform exact slab ray-AABB intersection against `[-b.w/2, +b.w/2] × [minY, topY] × [-b.d/2, +b.d/2]` for `t ∈ [0, 1]`.
    - Keep the smallest `t` (earliest entry point along `p0 -> p1`).
  - If hit, return `{ x, y, z, t, key, building: b, settlement: s }`; otherwise return `null`.

### 2. Animated Burn & Collapse (`this.collapsing`)
- Maintain `this.collapsing = new Map()` (`key -> { key, b, s, minY, topY, height, t, duration, tiltX, tiltZ, seed }`).
- In `applyBlast(position, splashRadius, damage = 100)`:
  - Same crater creation and radius check as before.
  - Skip any building already in `this.destroyed` OR `this.collapsing` (so repeat blasts never double-count).
  - For each newly hit building:
    - Add it to `this.collapsing` with deterministic `duration = 2.4 + hash * 1.4` (`2.4..3.8 s`), deterministic lean direction `(tiltX, tiltZ)` (`±0.14..0.32 rad`), `t = 0`.
    - Include `{ x: b.x, y: baseY + b.h * 0.45, z: b.z }` in returned `positions`.
  - Set `this._needsRebuild = true`.
  - Return `{ destroyedCount, positions }` (backward compatible!).
- In `update(dt, camera, sky)` (must also work safely when `this.scene === null` if called with `(dt)` in headless tests!):
  - Advance all active entries in `this.collapsing`: `c.t += dt`.
  - If `c.t >= c.duration`: delete from `this.collapsing`, add `c.key` to `this.destroyed`.
  - Whenever `this.collapsing.size > 0` (or any entry just finished), mark `this._needsRebuild = true` so `rebuild(camera)` (when `this.scene` is present) renders the live collapsing tilt, shrinking height, slight lateral shake, and fiery burning color (`0xff6a1a` -> `0xb8350c` -> `0x22201e`)!
- Add `getCollapsingFirePoints()`:
  - Returns an array of `{ x, y, z, progress }` for currently collapsing buildings (for `main.js` to spawn flickering fire/smoke puffs while they burn and fall!).
- In `resetDamage()`: clear `this.destroyed`, `this.collapsing`, and `this.craters`.

## Verification (`tests/cities_destruction_test.mjs`)
Keep all existing 162 checks passing AND add new checks verifying:
1. `hitBuilding(p0, p1)` hits the **side wall** of a real tall building mid-air (`y = baseY + h * 0.5`), returning an impact point strictly above ground (`y > baseY + 2`) on the building facade.
2. `hitBuilding` returns `null` for a ray passing cleanly above the roof or beside the building.
3. `applyBlast` puts hit buildings into `this.collapsing` (`collapsing.size >= 1`), `getCollapsingFirePoints()` returns active fire points, stepping `update(0.5)` advances collapse, and after `4.5 s` all collapsing buildings finish into `this.destroyed` (`collapsing.size === 0`, `destroyed.size >= 1`).
4. `hitBuilding` returns `null` once the building has collapsed into `destroyed`.
5. `node tests/cities_destruction_test.mjs` exits `0` and prints `ALL CITIES & DESTRUCTION CHECKS PASSED`.
