# Falcon Infinite — Unreal Engine 5 + Cesium Porting Plan

A complete blueprint for rebuilding **Falcon Infinite** in **Unreal Engine 5 (5.4 / 5.5+)** with **Cesium for Unreal**, keeping our hard-won F-16 flight physics, weapons, radar, and Vipava Valley mission logic while replacing WebGL2 terrain/sky/building bottlenecks with UE5's native AAA rendering stack.

---

## 1. Core Architectural Rule: Split Into Two C++ Modules (AI-Friendly Workflow)

The #1 pitfall in UE5 projects is putting gameplay logic inside binary `.uasset` Blueprints (which AI agents cannot read, diff, or test without opening the editor) and waiting 60+ seconds on UnrealBuildTool for every 1-line tweak.

Avoid both by splitting the project into **two C++ modules**:

1. **`FalconSimCore`** *(Pure C++20 static library — ZERO `#include "Engine.h"`)*:
   - Compiles with `cmake + ninja + clang++` in **< 1 second**.
   - Runs a full headless unit test suite (mirroring our 26 Node test suites) in **< 0.5 seconds** without launching Unreal Editor.
   - **Hermes (`deepseek-v4.1-flash`)** can port, refactor, and test all physics/weapons/combat/AI logic at full speed!
2. **`FalconUE`** *(Thin Unreal Engine 5 C++ module)*:
   - Binds `FalconSimCore` ticks to `AFalconJetPawn`, `EnhancedInput`, `ACesiumGeoreference`, `USkyAtmosphere`, `UVolumetricCloud`, `UNiagaraComponent`, `MetaSounds`, and Slate/UMG HUD widgets.
   - **Blueprints are strictly data/asset shells** (mesh assignments, material instances, Niagara asset refs, input mapping contexts) — **no Blueprint spaghetti**.

---

## 2. Complete Module-by-Module Porting Matrix (All 48 Modules / 32,320 LOC)

### A. Drop & Replace with UE5 + Cesium *(~11,500 LOC eliminated!)*

| Current Module (LOC) | UE5 + Cesium Replacement |
|---|---|
| `src/world/dem.js` (1,104) | **Cesium World Terrain** (1–10 m global terrain streamed automatically via `ACesium3DTileset`) |
| `src/world/terrainview.js` (1,252) | **Cesium 3D Tileset** + Bing Aerial / Sentinel-2 / **Google Photorealistic 3D Tiles** |
| `src/world/terrain.js` (384) | Cesium line-trace ground queries (`UWorld::LineTraceSingleByChannel`) + optional local height cache for headless tests |
| `src/world/buildings.js` (2,502) | **Cesium OSM Buildings** (global 3D buildings auto-grounded on terrain) or Google 3D Tiles |
| `src/world/settlements.js` (1,140) | Replaced by real Cesium world + lightweight GPS town registry JSON (`Data/vipava_places.json`) |
| `src/world/roadnet.js` (769) | Visible in Cesium satellite / 3D tiles; optional spline roads only around custom airfields |
| `src/world/water.js` (647) | **UE5 Water Plugin** (`AWaterBodyOcean` for Adriatic + `AWaterBodyRiver` spline for Soča/Vipava) |
| `src/world/vegetation.js` (127) | **UE5 PCG Framework + Nanite Foliage** (Mediterranean pines, oaks, vineyards driven by slope/altitude) |
| `src/sim/sky.js` (253) | **UE5 `ASkyAtmosphere` + `ADirectionalLight` (SunSky plugin) + `AExponentialHeightFog`** |
| `src/sim/clouds.js` (431) | **UE5 `AVolumetricCloud`** (true 3D raymarched fly-through clouds with automatic ground shadows) |
| `src/sim/postfx.js` (258) | **UE5 `APostProcessVolume`** (Lumen GI, ACES Filmic, Bloom, Auto-Exposure, Motion Blur) |
| `src/world/noise.js` (116) | Standard C++ deterministic PRNG (`SplitMix64` / `PCG32`) in `FalconSimCore` |

### B. Port 1-for-1 to `FalconSimCore` Pure C++20 *(~7,400 LOC — Core Simulation IP)*

| Current Module (LOC) | Target File in `FalconSimCore` | Notes |
|---|---|---|
| `src/config.js` (178) | `SimConfig.h` | Aero constants, weapon specs, presets, radar ranges |
| `src/aircraft/flight.js` (489) | `FlightModel.h/.cpp` | 6-DOF aerodynamics, AoA/CL/CD curves, FLCS G-limiter, afterburner, ground/gear contact |
| `src/aircraft/autopilot.js` (337) | `Autopilot.h/.cpp` | Alt hold, heading hold, pitch/bank hold, waypoint steering |
| `src/sim/fuel.js` (592) | `FuelSystem.h/.cpp` | Internal/drop tanks, bingo/joker fuel, afterburner burn curves, aerial/ground refuel |
| `src/combat/weapons.js` (1,108) | `WeaponSystem.h/.cpp` | M61 Vulcan, AIM-9X/AIM-120 PN guidance & seekers, Mk-82/JDAM CCIP/CCRP, flares/chaff |
| `src/combat/targets.js` (995) | `CombatWorld.h/.cpp` | SAM batteries, search/track radar states, RWR threat emitters, bandit AI, blast damage |
| `src/combat/missions.js` (642) | `MissionSystem.h/.cpp` | Free Flight, SEAD, Strike, CAP, Vipava scenarios (`soca_run`, `nanos_sead`, `adriatic_cap`) |
| `src/combat/canyon_run.js` (384) | `CanyonRun.h/.cpp` | Exact 8 Soča canyon gates (`LJAJ` → Sveta Gora) + Gold/Silver/Bronze timing |
| `src/sim/weather.js` (190) | `WeatherModel.h/.cpp` | Wind presets including `WIND.burja` (42 kt NE @ 21.6 m/s, 135°), turbulence, visibility |
| `src/sim/time.js` (59) | `TimeOfDay.h/.cpp` | Solar ephemeris driving UE5 `ADirectionalLight` & `ASkyAtmosphere` |
| `src/aircraft/replay.js` (331) | `ReplayBuffer.h/.cpp` | Fixed-rate ring buffer recording pose, throttle, weapons, events |
| `src/aircraft/ejection.js` (390) | `EjectionSeat.h/.cpp` | ACES II rocket-seat trajectory & parachute descent |
| `src/sim/traffic.js` (391) | `AirTraffic.h/.cpp` | Ambient AI aircraft corridors |
| `src/core/events.js` (29) | `EventBus.h` | Lightweight typed C++ callback/ring queue bridging SimCore → UE5 |

### C. Rebuild Cleanly in `FalconUE` C++ + Native UE5 Assets *(~13,400 LOC JS → ~3,800 LOC UE5)*

| Current Module (LOC) | Target in `FalconUE` | Implementation Approach |
|---|---|---|
| `src/aircraft/f16.js` (1,170) + `cockpit.js` (761) + `aircraft.js` (427) | `AFalconJetPawn` + `UFalconCockpitComponent` | Import high-poly F-16C static/skeletal mesh (separate control surfaces, gear, canopy, nozzle) + 3D cockpit with emissive HUD combiner glass & RenderTarget MFDs |
| `src/aircraft/weapon_cam.js` (600) | `AFreeCamPawn` + `UWeaponCamComponent` | Detached 6-DOF Free Cam (`Ctrl+F`), reload pose persistence (`UGameUserSettings` / JSON), weapon follow-cam, photo mode |
| `src/ui/hud.js` (1,200) | `UFalconHudWidget` (Slate/UMG) | Vector-crisp collimated F-16 HUD (pitch ladder, FPM, airspeed/alt tapes, CCIP pipper, TD box, G/AoA) with emissive bloom |
| `src/ui/tactical.js` (1,371) + `kneeboard.js` (1,001) | `URwrWidget`, `UHsdWidget`, `UKneeboardWidget` | Live RWR threat ring, radar/HSD tactical scope, kneeboard frequencies/waypoints |
| `src/ui/inspector_map.js` (558) + `menu.js` (308) | `UInspectorMapWidget` + `UMainMenuWidget` | Click-to-teleport map over Vipava/Europe + Time/Weather sliders + quick-jump buttons |
| `src/sim/vfx.js` (1,572) + `juice.js` (187) | `UFalconVfxComponent` + **Niagara** | Niagara emitters for Mach-diamond afterburner, wingtip vortices, contrails, flares, SAM plumes, explosions + UE5 `UCameraShakeBase` |
| `src/core/audio.js` (797) + `combat_audio.js` (953) + `betty.js` (202) | `UFalconAudioComponent` + **MetaSounds** | Parametric F110 turbine/afterburner/wind/G-breath MetaSound, RWR audio synth, Betty warning cues |
| `src/world/airports.js` (555) | `AAirfieldActor` (`LJAJ`, `LIPQ`, `LJPZ`, `LJPO`, `LJDI`) | Georeferenced runway meshes + Cesium Cartographic Polygon cutout/flattening + PAPI/strobe lights + windsock |
| `src/world/landmarks.js` (989) | `ALandmarkActor` (optional overrides) | Custom detailed meshes for iconic sites where OSM/3D tiles are coarse (Solkan Stone Arch Bridge, Sveta Gora Basilica, Nanos Tower) |
| `src/world/carrier.js` (597) | `ACarrierActor` | Moving Adriatic CVN with collision deck, optical landing ball (IFLOLS), catapult & arresting wires |
| `src/world/traffic_roads.js` (388) | `UNiagara` / `UInstancedStaticMesh` spline lights | Night headlight/taillight streaks along H4 expressway |
| `src/core/input.js` (146) | **UE5 Enhanced Input** | Keyboard/mouse + native **HOTAS/Joystick (RawInput/DirectInput/SDL)** + VR-ready bindings |
| `src/core/mcp_bridge.js` (1,346) | `UFalconBridgeSubsystem` *(optional)* | Local HTTP/JSON server (`FHttpServerModule`) for automated flight tests & AI inspection |

### D. Data Assets to Copy Directly From This Repo
All curated geographic data is already real WGS-84 `(lat, lon)` — copy straight into `Data/` in the new repo:
- `public/media/vipava_meta.json` → exact `LJAJ` origin (`45.8878°N, 13.8869°E`) and all 5 real airports (`LJAJ`, `LJPO`, `LJDI`, `LIPQ`, `LJPZ`)
- `scripts/bake_vipava_osm.py` landmark coordinates (`RAW_LANDMARKS`: Sveta Gora `45.9993, 13.6557`, Solkan Bridge `45.9781, 13.6506`, Solkan Dam, Vogršček Dam, Nanos Tower, Gorizia Castle, Kostanjevica, Faro della Vittoria, Piran, Predjama, Štanjel, Vipava H4 Viaduct)
- `src/combat/canyon_run.js` → exact 8 Soča canyon run gate coordinates
- `public/media/sfx/*` → existing sound samples

---

## 3. Geospatial & Coordinate System Contract

| Property | Falcon Infinite (Three.js) | `FalconSimCore` (C++20) | Unreal Engine 5 (`FalconUE`) |
|---|---|---|---|
| **Units** | Metres (`m`) | Metres (`m`, `double`) | Centimetres (`1 m = 100 uu`, `double` LWC) |
| **Handedness / Up** | Right-handed, `+Y` Up, `-Z` North, `+X` East | **ENU** (`+X` East, `+Y` North, `+Z` Up) | Left-handed, `+Z` Up (`+X` East, `-Y` North in Cesium ENU) |
| **World Origin** | `LJAJ (45.8878°N, 13.8869°E)` | Geodetic origin `LJAJ` | `ACesiumGeoreference` at `(45.8878, 13.8869, 113.1 m)` |
| **Precision** | Float32 (jitters >50 km) | IEEE-754 `double` | UE5 Large World Coordinates (`FVector` = `double`) + `CesiumOriginShiftComponent` |

Keep **all physics math in `FalconSimCore` in SI metres** and convert `m <-> cm` + handedness in a single tested `CoordConvert.h` helper inside `FalconUE`. Never mix centimetres into aerodynamic equations.

---

## 4. Target Project Structure & `AGENTS.md` Setup

Create a fresh folder (e.g. `/home/erik/Desktop/falcon-ue5`):

```text
falcon-ue5/
├── AGENTS.md                        # Same Orchestrator + Hermes (deepseek-v4.1-flash) rules
├── FalconInfinite.uproject          # UE 5.4/5.5 + CesiumForUnreal, EnhancedInput, Water, Niagara, PCG
├── CMakeLists.txt                   # Standalone fast build for FalconSimCore + headless CTest suite
├── Data/
│   ├── vipava_airports.json         # Copied from falcon-infinite
│   ├── vipava_landmarks.json        # Real GPS coordinates of 12 landmarks
│   └── vipava_missions.json         # Scenarios & 8 Soča canyon gates
├── Source/
│   ├── FalconInfinite.Target.cs
│   ├── FalconInfiniteEditor.Target.cs
│   ├── FalconSimCore/               # Pure C++20 (NO UE headers) — Hermes builds & tests in <1s
│   │   ├── FalconSimCore.Build.cs
│   │   ├── Public/                  # FlightModel.h, WeaponSystem.h, CombatWorld.h, ...
│   │   └── Private/
│   └── FalconUE/                    # Thin UE5 adapter (Cesium, Pawn, HUD, Niagara, MetaSounds)
│       ├── FalconUE.Build.cs
│       ├── Public/
│       └── Private/
├── Tests/                           # Pure C++ headless tests (Catch2 / lightweight assert)
│   ├── flight_test.cpp
│   ├── weapons_test.cpp
│   ├── targets_test.cpp
│   ├── autopilot_fuel_test.cpp
│   └── missions_canyon_test.cpp
└── Content/                         # Minimal binary UE5 assets (F-16 mesh, Materials, Niagara, Map)
    ├── Maps/VipavaValley.umap
    ├── Aircraft/F16/
    ├── VFX/
    └── Audio/
```

### Orchestrator + Hermes (`deepseek-v4.1-flash`) Workflow in the New Repo
Keep the exact same delegation workflow from `falcon-infinite/AGENTS.md`:
- **Primary Orchestrator**: Architecture, UE5 editor setup guidance, C++ interface contracts, diff reviews, and verification.
- **Hermes CLI (`--provider alibaba-coding-plan -m deepseek-v4.1-flash`)**: Implements `FalconSimCore` C++20 modules, headless unit tests (`cmake --build build && ctest --test-dir build --output-on-failure`), and `FalconUE` C++ classes.
- **Fast Verification Gate**:
  - Core logic changes: `cmake --build build && ctest --test-dir build --output-on-failure` (**~1 second**).
  - UE5 adapter changes: UnrealBuildTool compile (`Build.sh FalconInfiniteEditor Linux Development ...`).

---

## 5. Prerequisites Before Starting

1. **Unreal Engine 5.4 or 5.5** (Linux native binary from Epic Games Linux downloads, or Windows — requires a Vulkan-capable GPU with >= 8 GB VRAM and ~50–60 GB free disk space).
2. **Plugins**:
   - **Cesium for Unreal** (free from Fab / GitHub Releases `CesiumGS/cesium-unreal` — includes prebuilt Linux binaries).
   - Free **Cesium ion** account token (for Cesium World Terrain + Bing Maps Aerial + Cesium OSM Buildings) *and/or* free-tier **Google Photorealistic 3D Tiles** API key.
   - Built-in UE5 plugins enabled in `.uproject`: `EnhancedInput`, `SunPosition`, `Water`, `Niagara`, `PCG`, `HTTPServer`, `MetaSound`.
3. **Local C++ Toolchain**: `cmake`, `ninja`, `clang++` (or `g++`) so `FalconSimCore` headless tests run independently of Unreal Editor.

---

## 6. Phased Implementation Roadmap

### Phase 0 — Project Bootstrap & Photorealistic Vipava Flyover *(Day 1)*
- Create `falcon-ue5` folder with `AGENTS.md`, `CMakeLists.txt`, `FalconInfinite.uproject`, and `Source/FalconSimCore` + `Source/FalconUE` skeletons.
- Create `Content/Maps/VipavaValley.umap`:
  - `ACesiumGeoreference` at `45.8878°N, 13.8869°E, 113.1 m` (`LJAJ` Ajdovščina).
  - `ACesium3DTileset` for **Cesium World Terrain + Bing Aerial** (or Google Photorealistic 3D Tiles) + **Cesium OSM Buildings**.
  - `ASkyAtmosphere` + `ADirectionalLight` (SunSky) + `AVolumetricCloud` + `AExponentialHeightFog` + Lumen GI enabled.
- Implement `AFreeCamPawn` in C++ (WASD/QE + Shift ×4 + Wheel speed + `Ctrl+F` + reload pose persistence + `1–9` Vipava quick-jumps).
- **Milestone**: Fly a smooth 60+ FPS Free Cam over photorealistic Ajdovščina, Solkan Bridge, Sveta Gora, Nanos, and Trieste with volumetric clouds & Lumen lighting.

### Phase 1 — `FalconSimCore` Core Flight & Atmosphere Port *(Days 2–4)*
- Port `config.js`, `flight.js`, `autopilot.js`, `fuel.js`, `weather.js`, `time.js` to pure C++20 in `Source/FalconSimCore/`.
- Port acceptance tests (`flight_test`, `autopilot_test`, `fuel_test`) to `Tests/` and verify numerically against JS outputs (stall speed, climb rate, max G, Mach curve, Burja 42 kt wind).
- **Milestone**: All core flight/aero/fuel headless CTest suites green in `< 1 s`.

### Phase 2 — Flyable F-16C Pawn, Cockpit & Collimated HUD *(Days 5–8)*
- Implement `AFalconJetPawn` in `FalconUE` driving `FlightModel` every substep, wired to `EnhancedInput` (keyboard/mouse + HOTAS axis support).
- Attach F-16C mesh (moving elevons/rudder/flaps/gear/afterburner nozzle) + chase/cockpit/orbit cameras.
- Build crisp vector **F-16 HUD** (`UFalconHudWidget`) with pitch ladder, flight path marker, airspeed/altitude/heading tapes, AoA/G readout, plus `AAirfieldActor` for `LJAJ` runway (with Cesium polygon flattening so you can take off and land cleanly).
- **Milestone**: Take off from real `LJAJ` Ajdovščina, fly through Solkan Gorge and over Nanos under Volumetric Clouds, and land back on RWY 08/26.

### Phase 3 — Combat Core: Weapons, Radar, RWR, SAMs & Bandits *(Days 9–13)*
- Port `weapons.js`, `targets.js`, `missions.js`, `canyon_run.js`, `ejection.js`, `replay.js` to `FalconSimCore` + CTest verification.
- Wire `UFalconVfxComponent` (**Niagara**: afterburner, gun tracers, missile plumes, flares/chaff, explosions) and `UFalconAudioComponent` (**MetaSounds**: F110 jet roar, RWR lock/launch tones, Betty warnings).
- Add Slate/UMG **RWR + HSD MFDs** and the 8-gate **Soča Canyon Run** (`LJAJ` → Sveta Gora).
- **Milestone**: Complete playable Free Flight, SEAD, Strike, CAP, and Soča Canyon Run missions in UE5.

### Phase 4 — Adriatic Water, Forests, Carrier & Polish *(Days 14+)*
- Add **UE5 Water** (`AWaterBodyOcean` + Soča/Vipava river splines) and **PCG Nanite forests** over Trnovski Gozd, Sabotin, and Nanos.
- Add Adriatic **CVN Carrier** (`ACarrierActor`) with catapult launch & arresting wires.
- Add `UInspectorMapWidget` (big interactive click-to-teleport map) and optional `UFalconBridgeSubsystem` HTTP bridge.

---

## 7. First Step When You Open the New Folder

1. Create `/home/erik/Desktop/falcon-ue5` and verify UE5 + `cmake`/`clang++` are installed (`which cmake ninja clang++`).
2. Copy `AGENTS.md` (configured for `hermes --provider alibaba-coding-plan -m deepseek-v4.1-flash`) and `docs/UE5_PORT_PLAN.md` into the new folder.
3. Kick off **Phase 0**: scaffold `CMakeLists.txt` + `FalconSimCore` + `FalconUE` + `VipavaValley.umap` with Cesium anchored at `LJAJ (45.8878, 13.8869)`.
