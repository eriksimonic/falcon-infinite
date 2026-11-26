# Feature 31 — Living Vipava Valley (Glowing Night Cities, Animated OSM Highway Traffic & Runway Approach Strobes)

## Goal
Make the 100×100 km Vipava Valley come alive at golden hour, dusk, and night:
1. Rich warm emissive window clusters across all 7,770 real OSM buildings in `src/world/buildings.js`.
2. Architectural night uplighting & beacons on the 12 iconic Vipava landmarks in `src/world/landmarks.js`.
3. Animated instanced headlight & taillight traffic streaks cruising along the real baked OSM roads (Vipava H4 expressway & valley arteries) in `src/world/traffic_roads.js`.
4. Runway PAPI glideslope lamps + sequenced flashing "rabbit" approach strobes + brighter night edge lights in `src/world/airports.js`.

## Owned Files (DO NOT modify files outside this list)
- `src/world/buildings.js`
- `src/world/landmarks.js`
- `src/world/traffic_roads.js` (new)
- `src/world/airports.js`
- `tests/living_vipava_test.mjs` (new)

## Detailed Specification

### 1. Glowing Night Cities (`src/world/buildings.js`)
- In `makeBuildingMaterial()` fragment shader:
  - Keep daytime wall-aligned reflective glass facade look intact.
  - Enhance the `uNight` emissive window response so dusk (`uNight ~ 0.35`) and night (`uNight ~ 1.0`) bring towns like Ajdovščina, Nova Gorica, Gorizia, Trieste, and Koper vividly to life:
    - Varied warm tungsten (`vec3(1.0, 0.78, 0.42)`), cozy amber (`vec3(1.0, 0.62, 0.25)`), and occasional cool white office windows (`vec3(0.78, 0.90, 1.0)`) hashed per window cell.
    - Higher lit-window probability (`~45–65%`) with subtle per-building occupancy variation so skylines look organic rather than uniform.
    - Add a warm emissive boost (`* 1.45` at full night) so selective bloom picks up city clusters beautifully from 3,000–15,000 m altitude.
- Ensure existing `tests/cities_destruction_test.mjs` continues passing 100%.

### 2. Landmark Night Uplighting (`src/world/landmarks.js`)
- Add `setNight(night)` (or accept optional `night` parameter in `update(dt, night = 0)`):
  - Store uplight materials/meshes for landmarks (`church`, `castle`, `bridge`, `lighthouse`, `tower`):
    - At dusk/night (`night > 0.15`), softly illuminate warm stone facades (`emissive` warm gold `0xffb860` scaled by `night * 0.45`) on `Sveta Gora Basilica`, `Gorizia Castle`, `Kostanjevica`, `Predjama Castle`, `Štanjel`, and `Solkan Bridge` arches.
    - Boost `lighthouse` (`Faro della Vittoria`) rotating white beam/lantern glow and `tower` (`Nanos Broadcast Tower`) red obstruction beacons so they are unmistakable night navigation markers across the valley.
- Remain 100% headless-safe (`scene === null`) and keep `tests/landmarks_test.mjs` passing.

### 3. Animated OSM Highway Traffic (`src/world/traffic_roads.js`)
Create `export class RoadTrafficSystem`:
- **Headless-safe**: `new RoadTrafficSystem(scene = null, preset = null)`. When `scene === null`, still tracks logical vehicle state & stats so Node tests can verify movement without WebGL.
- **API**:
  - `setCustomRoads(roads, heightAt)` — accepts the baked OSM road array (`[{ points: [{x,z}, ...], width, kind }, ...]`) from `vipava_osm.json`.
  - Filters for major/longer road polylines (total length `>= 350 m`, preferring highways/arterials, capping at ~180 longest segments) and precomputes cumulative arc lengths + terrain elevations (`heightAt(x, z) + 1.15`).
  - Spawns up to `MAX_VEHICLES` (e.g. `120` low / `220` medium / `320` high) virtual cars moving bidirectionally along roads at realistic speeds (`18–34 m/s`, ~65–120 km/h on H4).
  - **Visuals (when `scene` provided)**:
    - Two `THREE.InstancedMesh` pools (zero per-frame allocations):
      - **Headlights**: stretched warm-white glowing streaks (`0xfff2d2`, `MeshBasicMaterial({ toneMapped: false, transparent: true })`)
      - **Taillights**: stretched crimson-red glowing streaks (`0xff2a1e`, `MeshBasicMaterial({ toneMapped: false, transparent: true })`)
    - Vehicles offset slightly right of road centerline (`±1.8 m`) in their travel direction so two-way traffic separates cleanly into opposite lanes!
    - Visibility/opacity scales smoothly with `night` (`0.18` subtle glint by day, `0.95` bright glowing streaks at dusk/night, automatically culled beyond `22,000 m` from camera).
  - `clear()` — removes all custom road traffic.
  - `update(dt, cameraPos, night = 0)` — advances every vehicle along its polyline (wrapping seamlessly) and updates instance matrices + material opacity.
  - `dispose()` — frees geometries & materials.
  - `stats` — `{ roads, vehicles, visible }`.

### 4. Runway PAPI & Sequenced Approach Strobes (`src/world/airports.js`)
- Enhance `AirportSystem` to add:
  - **PAPI lights** (4-lamp bar beside touchdown zone on runway approach) — 2 crisp white + 2 crisp red glowing lamps (`toneMapped: false`).
  - **Sequenced Flashing Approach Strobes ("the rabbit")**: 6 approach strobe lamps extending `120 m` to `620 m` out from the primary threshold (`heading` approach end), grounded on `terrainHeight(x, z) + 1.5`, flashing in rapid inward sequence toward the runway threshold (`~2 Hz` cycle).
  - Make `update(dt, cameraPos, night = 0)` animate the rabbit strobe sequence and scale runway/PAPI/strobe glow cleanly for dusk/night (while keeping them visible in poor weather/dusk).
- Remain headless-safe if `document` is absent and keep all existing airport/terrain tests passing.

### 5. Tests (`tests/living_vipava_test.mjs`)
- Verify `RoadTrafficSystem` headless mode: `setCustomRoads` filters/builds segments, spawns vehicles, `update(dt)` advances positions along polylines, wraps cleanly, and `clear()` resets stats.
- Verify `LandmarkSystem.update(dt, night)` runs cleanly headlessly across `night = 0` and `night = 1`.
- Run `npm test` and confirm all tests pass.
