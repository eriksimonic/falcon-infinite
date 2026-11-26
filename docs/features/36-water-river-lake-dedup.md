# Feature 36 — Fix Overlapping / Floating River Ribbons Over Water Polygons

## Root Cause
In `public/media/vipava_water.json`, OSM maps wide rivers (Soča, Vipava, Isonzo) and reservoirs as **both** `water=river` / `natural=water` polygons (`lakes`, 351 polygons) **and** `waterway=river` centerlines (`rivers`, 1,124 polylines). Diagnostic check confirmed **5,345 of 24,221 river vertices (22%)** lie directly inside lake/water polygons, causing river ribbons (`terrainHeight + 0.35 m`) and water sheets (`medianPerimeterH + 0.85 m`) to stack, intersect, and float one over another!

## Owned Files
- `src/world/water.js`
- `tests/water_test.mjs`

## Detailed Specification

### 1. Pre-Collect Lake Polygons & AABBs (`src/world/water.js`)
In `buildInlandWaterGeometry(data, heightAt)`:
- First pass over `lakes`: normalize each polygon with `openPolygon(raw)`, compute `level = lakeWaterLevel(contour, heightAt)`, and compute its 2D bounding box `{ minX, maxX, minZ, maxZ, contour, level }`. Keep only valid lakes (`Number.isFinite(level)`).
- Add a fast helper `pointInLakePolygons(x, z, preparedLakes)` using AABB rejection + standard ray-casting point-in-polygon.

### 2. Clip Duplicate River Samples Inside Lake / River-Bank Polygons (`src/world/water.js`)
- During the river ribbon loop:
  - When a resampled river point `[x, z]` lies inside any prepared lake/water polygon (`pointInLakePolygons(x, z, preparedLakes)`), skip emitting that ribbon sample and break the strip (`prevPair = null; continue;`).
  - This eliminates all 5,345 overlapping centerline-over-polygon river segments so wide rivers and reservoirs render as one clean, non-overlapping water surface without ribbons floating over one another!
  - All rivers *outside* lake polygons keep their exact existing `heightAt + 0.35` lift, resampling, and `+Y` winding so all existing tests in `tests/water_test.mjs` continue passing.

### 3. Acceptance Test (`tests/water_test.mjs`)
- Add a focused test section verifying that when a river polyline crosses through a lake polygon, the river samples inside the lake polygon are clipped out (no overlapping river triangles inside the lake) while river segments outside the lake still build cleanly.
- Run `node tests/water_test.mjs` and `npm run build` to verify zero failures.
