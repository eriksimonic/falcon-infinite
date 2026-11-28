# Feature 38 — Real OpenStreetMap Vipava Valley Towns, Buildings, Urban Zones & Road Bridges

## Goal
Replace the sparse, volume-capped 7,770-building extract with a complete, accurately oriented real-world OpenStreetMap dataset covering **every town and village across Vipava Valley and the 100 × 100 km region** (including all missing valley villages like Dornberk, Branik, Šempas, Črniče, Renče, Miren, Bilje, Prvačina, Goče, Podnanos, Slap, Lokavec, plus Izola & Piran), packed into a compact binary format (`public/media/vipava_buildings.bin`), alongside real OSM road bridge tags, urban ground footprints, and verified GPS coordinates/headings for all 12 iconic landmarks.

## Owned Files (DO NOT modify files outside this list)
- `scripts/bake_vipava_osm.py`
- `public/media/vipava_buildings.bin`
- `public/media/vipava_osm.json`
- `tests/osm_bake_audit_test.mjs`

## Detailed Specification

### 1. Fix OBB Orientation & Center Math (`scripts/bake_vipava_osm.py`)
The old script had two geometry bugs:
1. It used `c, sn = math.cos(-rot), math.sin(-rot)` with `us = dx*c - dz*sn`, which projected into the **mirrored `-rot` frame** instead of Three.js's `rotation.y = rot` frame!
2. It used vertex-mean `(cx, cz)` instead of the true Oriented Bounding Box center.

**Required exact Three.js `rotation.y = rot` convention:**
- Three.js maps local `(u, v)` (where `u` is local X width and `v` is local Z depth) to world `(x, z)` via:
  ```python
  world_x = cx + u * math.cos(rot) + v * math.sin(rot)
  world_z = cz - u * math.sin(rot) + v * math.cos(rot)
  ```
- Therefore, the exact inverse (world `(dx, dz)` → local `(u, v)`) is:
  ```python
  c, s = math.cos(rot), math.sin(rot)
  u = dx * c - dz * s
  v = dx * s + dz * c
  ```
- Compute **minimum-area OBB** by testing candidate angles from every polygon edge (`rot = math.atan2(dx, dz)`, which aligns local `+Z` with the edge, and picking the angle minimizing `(max(u)-min(u)) * (max(v)-min(v))`).
- Compute the **true OBB center**:
  ```python
  u_mid = 0.5 * (u_min + u_max)
  v_mid = 0.5 * (v_min + v_max)
  cx = x_ref + u_mid * c + v_mid * s
  cz = z_ref - u_mid * s + v_mid * c
  bw = max(4.0, min(120.0, u_max - u_min))
  bd = max(4.0, min(120.0, v_max - v_min))
  ```
- Verify via a self-check inside the script that reconstructing the 4 OBB corners with Three.js's forward formula wraps all original polygon vertices within tolerance!

### 2. Full Vipava Valley + Regional OSM Coverage (`scripts/bake_vipava_osm.py`)
Query OpenStreetMap systematically across **tiled/regional boxes** with polite retry, mirror failover (`overpass-api.de`, `maps.mail.ru/osm/tools/overpass/api/interpreter`, `overpass.kumi.systems`), and local disk cache in `/tmp/vipava_osm_cache/` (not committed to git) so reruns are instant and never time out.
Cover ALL of the following regions (deduplicating by OSM way ID!):
1. **Core Vipava Valley (HIGH DENSITY — preserve real village/town layouts!)**:
   - Tile the entire valley corridor from Nova Gorica / Gorizia / Solkan / Šempeter / Miren / Bilje / Renče / Bukovica / Volčja Draga / Prvačina / Dornberk / Branik / Šempas / Ozeljan / Črniče / Batuje / Selo / Dobravlje / Ajdovščina / Lokavec / Vipava / Slap / Goče / Podnanos / Col / Štanjel (`lat 45.78..46.02, lon 13.56..14.02`) in small `~0.06° × 0.08°` sub-tiles so Overpass responds fast and never truncates.
2. **Coastal & Regional Cities**:
   - Trieste (`45.61..45.69, 13.73..13.84`)
   - Koper (`45.52..45.57, 13.70..13.78`)
   - **Izola & Piran & Portorož** (`45.50..45.55, 13.55..13.68`) — previously timed out (`0` buildings); split into 2 small boxes so it reliably succeeds!
   - Monfalcone & Ronchi (`45.78..45.84, 13.49..13.58`)
   - Postojna (`45.75..45.80, 14.18..14.24`)
   - Sežana & Divača (`45.66..45.73, 13.84..14.00`)
   - Idrija (`45.98..46.03, 14.00..14.06`)
   - Tolmin & Most na Soči (`46.14..46.20, 13.70..13.77`)
   - Grado (`45.67..45.70, 13.37..13.42`)

### 3. Density-Preserving Selection & Rich Building Classification
- **Do NOT use naive volume-only capping** that deletes residential houses!
- Keep **100%** of churches/cathedrals/chapels (`kindCode = 4`).
- Inside the **Core Vipava Valley + Nova Gorica/Gorizia/Solkan/Štanjel box**, keep **all buildings with area ≥ 24 m²** (up to ~35,000 buildings), preserving authentic dense town cores and village clusters! If a sub-tile exceeds its cap, use **spatial-grid stratified sampling** (keeping churches + largest buildings + evenly distributed residential houses across 150 m cells) so every village and street retains its real footprint.
- Target **35,000–55,000 total buildings** across the entire theater.
- **Classification**:
  - `kindCode`:
    - `0` = `house` (`house`, `residential`, `detached`, `semidetached_house`, `terrace`, `farm`, `yes` with area < 350 m² and levels ≤ 3)
    - `1` = `apartment` (`apartments`, `office`, `public`, `school`, `hospital`, `hotel`, `civic`, `university`, `dormitory`, or levels ≥ 4)
    - `2` = `industrial` (`industrial`, `warehouse`, `commercial`, `retail`, `supermarket`, `hangar`, `manufacture`, `barn` > 200 m²)
    - `3` = `tower` (tall urban towers ≥ 24 m or `man_made=tower`)
    - `4` = `church` (`church`, `cathedral`, `chapel`, `basilica`, `monastery`, `shrine`)
    - `5` = `shed` (`shed`, `garage`, `garages`, `greenhouse`, `hut`, `outbuilding`, `farm_auxiliary`, or tiny `< 50 m²` unnamed building)
  - `roofCode`:
    - `4` = `church_spire` for `kindCode == 4`
    - `3` = `industrial_gable` for `kindCode == 2`
    - `2` = `flat` if `roof:shape == flat` OR `kindCode == 3` OR (`kindCode == 1` and `h >= 14`)
    - `1` = `hip` if `roof:shape in ('hipped','pyramidal')` OR (`kindCode == 0` and aspect ratio `max(w,d)/min(w,d) < 1.25` and hash < 0.45)
    - `0` = `gable` (default for Vipava/Primorska houses, farmhouses, low-rise apartments, sheds)
  - `tier` (for Feature 39's procedural distance show/hide LOD):
    - `2` (far-prominent, visible out to 22 km): churches (`kindCode == 4`), towers (`kindCode == 3`), tall/large buildings (`h >= 12 m` OR footprint area `>= 320 m²`)
    - `1` (mid-town, visible out to 10 km): regular houses, shops, apartments (`area >= 55 m²`)
    - `0` (close-only, visible out to 3.5 km): small cottages, sheds, garages, vineyard outbuildings (`area < 55 m²` or `kindCode == 5`)
  - `colorSeed`: deterministic `0..255` integer hashed from `(round(cx), round(cz))`.
- **Heights**: Use OSM `height` tag if present, else `building:levels * floorH` (house `3.0 m`, apartment `3.3 m`, industrial `4.2 m`), else realistic regional defaults (`house: 6.0..8.5 m`, `shed: 3.5..4.8 m`, `apartment: 13..22 m`, `industrial: 7.5..11 m`, `church: 14..22 m`).

### 4. Output Binary Format (`public/media/vipava_buildings.bin`) + Updated `public/media/vipava_osm.json`
- Write `public/media/vipava_buildings.bin` using the exact **`FBLD` v1 little-endian binary contract**:
  - Header (16 bytes): `b'FBLD'`, `uint32(1)`, `uint32(count)`, `uint32(20)`
  - Record (20 bytes): `<ffHHHhbBBB`? **Careful with sign**: `<ffHHHhBBBB` (`float32 x`, `float32 z`, `uint16 round(w*10)`, `uint16 round(d*10)`, `uint16 round(h*10)`, `int16 round(rot*10000)`, `uint8 kindCode`, `uint8 roofCode`, `uint8 tier`, `uint8 colorSeed`). Total = `4+4+2+2+2+2+1+1+1+1 = 20` bytes!
- **Real OSM Road Bridges**:
  - Query OSM highways (`motorway|trunk|primary|secondary`) with `bridge=yes|viaduct` tag preserved (or augment existing `roads` with bridged segments from Overpass for H4 / Soča / Vipava crossings) so bridged road ways carry `"b": 1` in `vipava_osm.json`.
- **Real Urban Footprints (`urbanZones`)**:
  - Compute clustered town/village ground footprints `[[cx, cz, radius, density], ...]` from the actual building spatial distribution (one cluster per town/village neighborhood, `radius` `80..900 m`) and save as `"urbanZones"` in `vipava_osm.json`.
- **Verify & Fix All 12 Iconic Landmarks (`landmarks` in `vipava_osm.json`)**:
  - Verify exact real-world GPS coordinates & bridge/dam headings (using Three.js `rotation.y = rot` where bridge length runs along local `X`, i.e., world direction `(cos(rot), -sin(rot))`!):
    - **Sveta Gora Basilica**: real summit is `45.9917°N, 13.6567°E` (681 m peak — NOT `45.9953, 13.6584` which was down on the north flank at 560 m!).
    - **Solkan Stone Arch Bridge**: real bridge center is `45.9781°N, 13.6522°E`, spanning the Soča roughly WNW–ESE across the narrow gorge (~110–140° azimuth → verify `rot` so local X spans bank-to-bank perpendicular to the Soča river rather than along the cliff!).
    - **Vipava H4 Viaduct** & **Solkan Dam** & **Vogršček Dam**: verify exact coordinates & orientation against real river/road geometry.
- Keep a compact fallback `buildings` array in `vipava_osm.json` (e.g. top ~1,500 prominent buildings in legacy 7-element format `[x, z, w, d, h, rot, kindCode]`) ONLY so any legacy code calling `loadVipavaOSM()` alone still sees buildings, while `main.js` loads the full 35k–55k dataset from `vipava_buildings.bin`!

### 5. Verification (`tests/osm_bake_audit_test.mjs`)
Write a headless Node acceptance test `tests/osm_bake_audit_test.mjs` that loads `public/media/vipava_buildings.bin` and `public/media/vipava_osm.json` directly from disk and checks:
- Binary header magic `'FBLD'`, version `1`, stride `20`, `count >= 25000`, file size `< 2.5 MB`.
- Every record has finite `(x, z, w, d, h, rot)`, `w >= 4`, `d >= 4`, `h >= 2.5`, valid `kindCode (0..5)`, `roofCode (0..4)`, `tier (0..2)`.
- Real town coverage: Ajdovščina, Vipava, Nova Gorica, Gorizia, Solkan, Dornberk, Branik, Šempas, Črniče, Renče, Štanjel, Izola, Piran, Koper, Trieste, Postojna, Sežana ALL have `> 30` buildings within 2.5 km (no more 0-building towns!).
- `urbanZones` array is non-empty and covers major towns.
- `roads` has `>= 15` segments with `b === 1` (real OSM bridges/viaducts).
- `landmarks` has all 12 entries with valid coordinates.
- Run `python3 scripts/bake_vipava_osm.py && node tests/osm_bake_audit_test.mjs`.
