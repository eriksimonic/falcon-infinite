# Feature 29 — All 100×100 km Vipava Region Cities (Distance-Streamed) & Iconic 3D Landmarks

## Goal
1. Stream real OpenStreetMap buildings across **all 10 major cities & towns** in the 100×100 km Vipava Valley region (**Ajdovščina, Vipava, Nova Gorica, Gorizia, Tolmin, Trieste, Koper, Izola, Piran, Postojna, Sežana, Divača, Idrija, Monfalcone, Štanjel**) cleanly as the aircraft approaches each city.
2. Render **iconic 3D landmarks** (churches/basilicas, stone arch bridges, hydro dams, broadcast towers, castles, and lighthouses) at their real GPS coordinates on the Vipava Valley DEM — including **Sveta Gora Basilica**, **Solkan Stone Arch Bridge**, **Solkan Dam**, **Vogršček Dam**, **Nanos Broadcast Tower (Pleša)**, **Gorizia Castle**, **Kostanjevica Monastery**, **Trieste Faro della Vittoria**, **Piran St. George Bell Tower**, **Predjama Castle**, **Štanjel**, and **Vipava H4 Viaduct**!

## File Ownership (STRICT)
Create / modify ONLY:
- `src/world/landmarks.js` (new — `LandmarkSystem`)
- `src/world/buildings.js` (per-building distance culling & `CUSTOM_SETTLEMENT_RADIUS = 52000` so all 10 cities stream smoothly as you fly close!)
- `src/world/dem.js` (include `landmarks` array in `loadVipavaOSM()` return value)
- `src/world/world.js` (own `this.landmarks = new LandmarkSystem(scene)` and call `this.landmarks.update(dt)`)
- `src/main.js` (pass `osm?.landmarks || null` to `this.world.landmarks.setLandmarks(...)` in `setTheater('vipava')`, clear on other theaters)
- `tests/landmarks_test.mjs` (new — headless unit test)
- `package.json` (append `&& node tests/landmarks_test.mjs` to `scripts.test`)

## Module Contract (`src/world/landmarks.js`)
Must be **100% headless-safe** when `scene === null`.

Export `export class LandmarkSystem`:
- `new LandmarkSystem(scene = null)`
- State: `this.landmarks = []`, `this.group = scene ? new THREE.Group() : null`, `this._beacons = []`, `this._time = 0`.
- `setLandmarks(list, heightAt = terrainHeight)`:
  - Clears existing landmark meshes.
  - If `!Array.isArray(list) || list.length === 0`, returns `0`.
  - Stores normalized landmark records `{ id, name, kind, x, y, z, ... }` (where `y = heightAt(x, z)`).
  - When `this.group` exists, builds rich multi-part procedural 3D meshes grounded deeply (`-4 m` foundation skirt so hilltop landmarks like Sveta Gora & Nanos never float!):
    - `'church'`: white Karst limestone nave + terracotta pitched roof + tall bell tower / campanile + tapered spire + golden finial cross.
    - `'bridge'`: multi-pier stone/concrete arch viaduct (`length`, `height`) with grand central arch opening, roadway deck, and parapets.
    - `'dam'`: massive sloped concrete dam wall (`length`, `height`) with spillway chutes and crest intake blocks.
    - `'tower'`: red-and-white striped broadcast mast (`height`, e.g. `95 m` on Nanos!) with dish platforms and a blinking red aviation strobe beacon (`this._beacons`).
    - `'castle'`: limestone keep, crenellated walls, and corner round towers.
    - `'lighthouse'`: fluted white monument column (`height`), lantern cupola, and pulsing bright white beacon (`this._beacons`).
  - Returns `this.landmarks.length`.
- `update(dt)`:
  - Advances `this._time += dt` and pulses/blinks all aviation & lighthouse beacons (`visible` / `emissiveIntensity` / `scale`).
- `clear()` / `dispose()`: cleanly removes & disposes all landmark meshes.

## `src/world/buildings.js` Streaming Upgrade
- Set `CUSTOM_SETTLEMENT_RADIUS = 52000` so `customSettlement` is reachable everywhere inside the 100×100 km Vipava region.
- In `rebuild(camera)`:
  - For `customSettlement` (or any large settlement), compute `r2 = radius * radius` (where `radius = clamp(preset.buildingRadius + alt * 5, preset.buildingRadius, 24000)`) and skip buildings where `(b.x - camX)² + (b.z - camZ)² > r2`!
  - If nearby buildings exceed `limit`, prefer closer buildings (or draw nearest first) so flying into Trieste, Nova Gorica, Tolmin, Koper, or Postojna ALWAYS renders that city cleanly right in front of you!

## Verification (`tests/landmarks_test.mjs`)
Standalone headless Node test verifying:
1. `LandmarkSystem(null)` accepts all 6 landmark kinds (`church`, `bridge`, `dam`, `tower`, `castle`, `lighthouse`), grounds them on `heightAt`, and `clear()` resets cleanly.
2. `LandmarkSystem(stubScene)` builds real 3D meshes + animated beacons for all 6 kinds without DOM/WebGL, and `update(dt)` animates beacons without error.
3. `node tests/landmarks_test.mjs` exits `0` and prints `ALL LANDMARK CHECKS PASSED`.
