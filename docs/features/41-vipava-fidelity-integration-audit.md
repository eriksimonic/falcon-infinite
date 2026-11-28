# Feature 41 — Vipava Fidelity Integration & Automated Grounding Audit

## Goal
Wire the new high-resolution nested Vipava DEM (`vipava_dem_hd.png`), compact binary 35k–55k real OSM buildings (`vipava_buildings.bin`), urban ground patches, upgraded building LOD, and grounded bridges/landmarks together in `src/main.js`, and add a comprehensive headless **Grounding & Fidelity Audit Test** (`tests/grounding_audit_test.mjs`) that validates the real baked Vipava assets end-to-end.

## Owned Files (DO NOT modify files outside this list)
- `src/main.js`
- `tests/grounding_audit_test.mjs`
- `package.json`

## Detailed Specification

### 1. Wire Full Vipava Fidelity Pipeline (`src/main.js`)
- Import `loadVipavaBuildings` from `./world/dem.js`.
- In `setTheater('vipava')`:
  - Fetch `loadVipavaDEM(...)`, `loadVipavaOSM()`, `loadVipavaBuildings()`, and `loadVipavaWater()` cleanly in parallel (`Promise.all` / guarded `try/catch` so failure of any optional asset gracefully falls back).
  - Pass `buildingsBin?.records || osm?.buildings || null` AND `osm?.urbanZones || null` to `this.world.buildings.setCustomBuildings(...)`.
  - Ensure `setActiveDEM(dem)` and `setCustomAirports(customAirports)` run BEFORE `setCustomBuildings`, `setCustomRoads`, `roadTraffic.setCustomRoads`, `inlandWater.setWaterData`, and `landmarks.setLandmarks`, so every single system grounds itself on the **new HD nested DEM**!
  - Expand `this._vipavaPlaces` with the key Vipava Valley towns now fully populated (Dornberk, Branik, Šempas, Črniče, Renče, Izola, etc.) so the Kneeboard & GPS readout report them accurately.
  - Ensure switching back from `vipava` to `temperate` or `desert` cleanly clears custom buildings, custom roads, inland water, landmarks, DEM, and custom airports.

### 2. Automated Real-Asset Grounding & Fidelity Audit (`tests/grounding_audit_test.mjs`)
Create a headless Node test that decodes the ACTUAL baked files in `public/media/`:
- Decode `public/media/vipava_dem.png` + `public/media/vipava_dem_hd.png` + `public/media/vipava_meta.json` (using pure Node `zlib.inflateSync` PNG decoder — zero extra npm packages needed, or minimal PNG IDAT reader!) into a real `HeightmapDEM` with its `detailDEM` attached, and install it via `setActiveDEM(dem)` + `setCustomAirports(meta.airports)`.
- Decode `public/media/vipava_buildings.bin` via `parseBuildingsBinary()`, install into `new BuildingSystem(stubScene, QUALITY.medium)`, and audit:
  1. **HD Terrain Fidelity**: Sveta Gora summit (`45.9917, 13.6567`) >= `640 m`, Nanos plateau >= `1220 m`, Ajdovščina LJAJ `100..130 m`, Adriatic sea `<= 2 m`, smooth zero-jump transition across the HD inset boundary.
  2. **Zero Floating / Buried Buildings**: Audit **all** baked buildings (or every building in the Vipava Valley + 5,000 stratified sample across the 100 km box):
     - Using Three.js `+rot` exact corners, verify `g.base <= minCornerY - 2.5` (**zero floating corners!**)
     - Verify `g.top >= maxCornerY + 1.5` (**zero buried roofs!**)
     - Verify `hitBuilding()` agrees with the rendered bounding box on rotated buildings.
  3. **Procedural Distance Show/Hide LOD & Performance**:
     - Test `rebuild()` over Ajdovščina, Vipava, and Nova Gorica/Solkan: verify rebuild completes quickly (`< 30 ms`), close tier count > 0, and distant towns hide Tier 0 sheds while retaining Tier 2 prominent landmarks/structures.
  4. **Zero Floating / Buried Landmarks & Bridges**:
     - Load all 12 real landmarks from `vipava_osm.json` into `LandmarkSystem(stubScene)` with the real HD `terrainHeight`:
     - Verify **every single landmark** bounding box extends well below its lowest footprint corner (`<= minFootprintY - 3.5 m`) and rises cleanly above ground.
     - For **Solkan Bridge** and **Vipava H4 Viaduct**, verify every pier reaches below local ground and deck clears the valley floor (never buried!).
  5. **Real OSM Road Bridges**:
     - Run `buildRoadRibbonData` on bridged OSM roads from `vipava_osm.json` against the real HD DEM and verify `bridgeCount > 0`, `piers.length > 0`, every deck stays above terrain, and every pier reaches below local ground.
- Clean up (`setActiveDEM(null)`, `setCustomAirports(null)`) before exiting.

### 3. Register New Tests in `package.json`
- Append `&& node tests/osm_bake_audit_test.mjs && node tests/grounding_audit_test.mjs` to the `"test"` script in `package.json`.
- Run `npm test && npm run build` and verify 100% pass with zero warnings/errors!
