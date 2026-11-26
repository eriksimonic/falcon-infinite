# FALCON / INFINITE

A browser-based F-16 flight simulator over an endless procedural world: airports,
cities and towns, roads, weather, clouds, day/night and time acceleration. No
weapons. Three.js + Vite, plain ES modules, modular systems.

## Run

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # production build into dist/
npm run preview    # serve the production build on :4173
npm test           # settlement + flight-model tests (Node, no browser)
```

Open the page, pick weather/quality/time, and press **START FLIGHT**. The
aircraft starts lined up on a regional runway next to a city.

## Controls

| Key | Action |
| --- | --- |
| W / S | pitch down / up |
| A / D | roll left / right |
| Q / E | rudder |
| Shift / Ctrl (or ↑ / ↓) | throttle up / down |
| G | landing gear |
| F | flaps (0 / 1 / 2) |
| B or Space | airbrake / wheel brakes |
| V | cockpit ↔ external |
| C | cycle camera (cockpit, chase, wing, orbit) |
| T | time scale ×1 → ×5 → ×20 → ×60 → ×300 |
| [ / ] | time of day − / + 1 h |
| R | reset to the nearest runway |
| Y | cycle weather preset |
| H | help |
| M | mute |
| F1 | hide interface |
| F3 | performance panel |
| P / Esc | pause |

Hold the right mouse button (or click the canvas to capture the pointer) in the
cockpit to look around. In external view, drag to orbit and scroll to zoom.

## World

- **Infinite terrain** — analytic fbm/ridged landforms, quadtree LOD tiles built
  around the camera, ocean shader, vertex-coloured biomes, tile skirts.
- **Airports** — deterministic airports every ~16 km with flattened pads,
  runways/markings, taxiways, aprons, hangars, terminals, towers, PAPI and
  runway lighting. The start airport is chosen next to a city.
- **Settlements** — deterministic metros, towns, villages and hamlets with
  street grids, parks, industrial edges, tiered towers, rooftop plant rooms and
  lit windows. Urban ground patches and street lamps make them read as built-up
  areas from the air and at night.
- **Roads** — a deterministic inter-settlement network links villages to towns
  and towns to cities with terrain-following highways; city streets are
  generated with the settlement.
- **Weather** — clear/few/scattered/overcast/storm with wind, turbulence,
  cumulus clusters (no flat cloud-deck sheets), rain and lightning.
- **Day/night** — sun, moon, stars, sky gradient, city/runway lights, and a
  controllable clock with up to ×300 acceleration.

## Aircraft

- Procedural F-16C Block 50 exterior: solid outward-wound blended wing-body
  fuselage with deterministic two-tone USAF Compass Ghost Grey panel textures,
  pointed radome, frameless gold-tinted teardrop bubble canopy (crystal clear
  inside the cockpit) with external pilot figure, tapered airfoil cropped-delta
  wings and LERX strakes, swept vertical fin with parabrake fairing and flush
  rudder, dual canted ventral fins, hinged all-moving stabilators, animated
  flaperons and split speedbrakes, sculpted chin intake, turkey-feather exhaust
  nozzle with afterburner shock diamonds, 370-gal external tanks (no weapons),
  nav lights, and belly-folding retractable landing gear.
- Cockpit interior: instrument panel, two live MFDs (ADI/HSI), standby gauges,
  ICP keypad, warning panel, HUD combiner, side consoles, throttle, sidestick,
  pedals, ejection seat and canopy rails.
- Flight model: thrust/drag/lift, afterburner, flaps, gear, brakes, ground
  handling, stall with a low-speed gate, and FBW-style AoA/G protection so a
  high-speed pull does not depart the aircraft.
- Cameras: cockpit with mouse look, chase, wing, and orbit.
- Dual-mode Canvas HUD:
  - **Cockpit view**: green F-16-style pitch ladder, flight-path marker, speed
    and altitude tapes, heading tape, Mach/G/AoA/VS/AGL block, throttle bar,
    gear/flaps, and caution warnings.
  - **External views (`chase`, `wing`, `orbit`)**: completely unobstructed
    center viewport with edge-anchored dark-glass telemetry — top magnetic
    compass strip with airport bearing caret, top-right camera mode pill,
    compact bottom flight dock (IAS/Mach, throttle/AB bar, live mini attitude
    ball, ALT/AGL/VSI, G/AoA, GEAR/FLP/BRK pills), and bottom-left ATC card.

## Project layout

```
src/
  main.js                 app, boot, input actions, frame loop
  config.js               tunables, quality presets, weather presets
  core/                   input, audio, events
  world/                  noise, terrain height, terrain view, airports,
                          settlements, buildings, road network, vegetation
  aircraft/               F-16 model, cockpit, flight model, camera assembly
  sim/                    sky, time, weather, clouds/rain
  ui/                     HUD, menu/overlays, styles
tests/                    settlement generator + flight model
```

## Technical notes

- 1 unit = 1 metre. Y up. Airport pads are flattened in the analytic height
  function, used by rendering, physics and city placement.
- Terrain tiles are built around the camera; old LOD tiles stay until their
  replacements are ready to avoid rectangular holes during fast flight.
- All world content is seeded; no `Math.random` in terrain/settlement/road
  generation.
- Quality presets trade pixel ratio, cloud counts, building radius and tree
  counts. Medium targets a laptop iGPU.

## Known limits

- Visuals are stylised/procedural, not study-level. The F-16 and cockpit are
  recognizable but simplified.
- Cloud puffs are billboard clusters, not true volumetric cloud raymarching.
- The HUD is a screen-space overlay, not clipped to the 3D combiner.
- Automation tests cover world generation and flight physics; a full manual
  takeoff/landing and FPS pass on the target display is still the best final
  check.