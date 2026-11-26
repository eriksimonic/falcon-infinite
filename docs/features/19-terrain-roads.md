# Feature 19 — Terrain-Conforming Continuous Highway Network

## Problem
`src/world/roadnet.js` previously rendered highways as disconnected 70 m flat horizontal `PlaneGeometry` instances with zero pitch or roll (`dummy.rotation.set(0, yaw, 0)`). On any sloped or rolling terrain, one end of each segment floated several metres in the air while the other end clipped underground, and roads cut across water without bridges.

## Goal
Redesign `src/world/roadnet.js` so highways are **continuous, terrain-conforming 3D ribbon meshes** with:
- Smooth terrain following: sample every `18–22 m` along each curve, placing left and right road-edge vertices at `heightAt(x, z) + 0.38` so the asphalt hugs hills and valleys seamlessly with zero stair-stepping or floating slabs.
- Grounded edge skirts: add subtle downward embankment/curb skirts (`-1.6 m` below each road edge) so steep cross-slopes never reveal gaps underneath the road.
- Automatic water bridges: when `heightAt(x, z) < 0.8`, clamp road deck height smoothly to a bridge elevation (`>= 2.6 m` above sea level `y = 0`) so highways cross rivers/bays cleanly instead of diving underwater.
- Clean longitudinal UVs (`v` = cumulative metres along road / `24`) so dashed yellow centerlines and crisp white shoulders flow continuously around curves.
- Airport pad avoidance: smoothly skip or terminate segments inside `ap.padRadius + 60`.
- Clean deterministic inter-settlement graph: connect villages → towns → metros and metro → nearest metro (within 42 km), plus towns → nearest town when isolated, using smooth Catmull-Rom / quadratic curves that terminate neatly at settlement perimeters (not cutting straight through downtown skyscrapers).

## File Ownership (STRICT)
Create / modify ONLY:
- `src/world/roadnet.js`
- `tests/roadnet_test.mjs`

Do NOT modify any other files.

## Module Contract (`src/world/roadnet.js`)
Keep `export class RoadNetwork` constructor and public methods (`new RoadNetwork(scene, preset)`, `update(camera)`, `dispose()`, `this.stats`) backward-compatible.

Also export a pure headless-safe geometry builder for unit testing and reuse:
- `export function buildRoadRibbonData(polylines, heightAt)`
  - `polylines`: array of `{ width: number, points: Array<{ x: number, z: number }> }`
  - `heightAt`: `(x, z) => number`
  - Returns `{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array, segmentCount: number, bridgeCount: number }`
  - For every sample point along a polyline:
    - Computes smooth tangent and perpendicular right vector `(rx, rz)`.
    - Left/right road surface vertices at `(px ± rx * halfW, Math.max(2.6, heightAt(x, z) + 0.38) if over water else heightAt(x, z) + 0.38, pz ± rz * halfW)`.
    - Adds embankment skirt vertices `1.6 m` below left/right edges so cross-slopes are always sealed.
    - Never produces `NaN` or `Infinity`.

In `RoadNetwork`:
- Instead of `InstancedMesh` of flat planes, build a single merged `THREE.Mesh` (`this.mesh`, `name = 'highways'`) whose `BufferGeometry` is rebuilt from `buildRoadRibbonData(...)` whenever the camera moves `> 2000 m`.
- Keep `makeRoadTexture()` crisp (dark asphalt with subtle grain, dashed yellow center line, white edge lines) with `RepeatWrapping` and `anisotropy = 4`.
- Guard `document.createElement` so importing `roadnet.js` in headless Node (`tests/roadnet_test.mjs`) never throws!

## Verification (`tests/roadnet_test.mjs`)
Standalone headless Node test verifying:
1. Importing `src/world/roadnet.js` works headlessly without DOM.
2. `buildRoadRibbonData` on a steep sloped hill (`heightAt(x, z) = 10 + 0.25 * x + 0.1 * z`) places every top road-surface vertex within `0.38 ± 0.05 m` of `heightAt(x, z)` (zero floating stair-steps!).
3. `buildRoadRibbonData` across water (`heightAt(x, z) = -5`) elevates the deck to a bridge (`y >= 2.5 m`) and increments `bridgeCount > 0`.
4. All positions, normals, and UVs are finite (zero `NaN`), indices are in bounds, and skirt vertices extend below the road deck.
5. Exits with code `0` and prints `ALL ROADNET CHECKS PASSED`.
