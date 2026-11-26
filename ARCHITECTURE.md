# FALCON / Infinite — module contract

A browser flight simulator: F-16C, procedural infinite world, airports, cities,
weather, day/night, time acceleration. Three.js + Vite, plain ES modules.

## World conventions

- 1 world unit = 1 metre. Y is up. Sea level `y = 0`.
- North = `-Z`, East = `+X`. Heading degrees clockwise from north:
  `forward = (sin(h), 0, -cos(h))`.
- Aircraft local axes: nose `-Z`, up `+Y`, right `+X`.
  `forward = (0,0,-1).applyQuaternion(q)`.
- Aircraft origin = centre of gravity; wheels bottom at `y = -1.55` (gear down).
- All procedural randomness is seeded and deterministic. Never `Math.random`
  for world content. `mulberry32` from `world/noise.js`.
- Terrain height is analytic (`terrainHeight(x,z)`) and includes airport
  flattening, so physics, cities and rendering agree.

## Modules

### core
- `core/events.js` — `events.on(name, fn)`, `emit(name, payload)`, `off`.
- `core/input.js` — keyboard state, `pressed(code)` edge triggers, action map.
- `core/audio.js` — synth engine/wind/gear/rain audio, `update(dt, telemetry)`.
- `core/loop.js` — fixed-ish timing, system registry, FPS stats.
- `core/quality.js` — presets: low / medium / high; applies pixel ratio, radii.

### world
- `world/noise.js` — seeded hash / value noise / fbm / ridged / mulberry32.
- `world/terrain.js` — `baseHeight`, `terrainHeight`, `terrainNormal`, `slopeAt`,
  airport lookup & flattening, world constants.
- `world/terrainview.js` — quadtree LOD terrain meshes + water surface.
- `world/airports.js` — airport geometry (runway, taxiway, lights, buildings).
- `world/settlements.js` — deterministic settlements & building/road layouts.
- `world/buildings.js` — instanced buildings (towers/rooftops), city roads,
  street lamps, urban ground patches with night windows.
- `world/roadnet.js` — deterministic inter-settlement highway network.
- `world/vegetation.js` — instanced trees near the camera.
- `world/world.js` — owns terrain view, airports, settlements, roads,
  vegetation,
  exposes `heightAt`, `airportNear`, update streaming.

### aircraft
- `aircraft/f16.js` — exterior model builder (`createF16()` → Group with refs;
  `updateF16Visual(model, flight, dt, mode, started)` animates gear folding,
  afterburner/shock diamonds, stabilators, flaperons, rudder, speedbrakes,
  canopy exterior/interior opacity, and external pilot visibility).
- `aircraft/cockpit.js` — interior model builder (`createCockpit()` → Group).
- `aircraft/flight.js` — flight dynamics + ground handling + gear/flaps.
- `aircraft/aircraft.js` — combines model, cockpit, camera modes, lights.

### sim
- `sim/sky.js` — sky dome shader (sun, moon, stars, gradient), lights.
- `sim/clouds.js` — instanced cumulus puff clusters, rain, lightning.
- `sim/weather.js` — presets, wind, turbulence, visibility.
- `sim/time.js` — time of day, time scale.

### ui
- `ui/hud.js` — dual-mode canvas HUD (`drawCockpitHUD` green F-16 symbology;
  `drawExternalHUD` edge-anchored telemetry dock with unobstructed center).
- `ui/menu.js` — start / pause / help / crash overlays, toasts, `#atc` card.
- `ui/debug.js` — F3 perf panel.

### main.js
Owns the `App`: renderer, scene, camera, systems, RAF loop. Each system
exposes `update(dt, ctx)` and optional `reset()`.

## APIs (stable)

```js
// terrain.js
baseHeight(x, z) -> metres
terrainHeight(x, z) -> metres (airport pads applied)
terrainNormal(x, z, out) -> Vector3
airportAtCell(cx, cz) -> Airport | null
airportsNear(x, z, cellRadius=1) -> Airport[]
// Airport: { id, name, code, cx, cz, x, z, elevation, heading, length, width,
//            padRadius, kind }
// settlements.js
settlementsNear(x, z, radius) -> Settlement[]
// Settlement: { id, type, x, z, radius, population, name, seed,
//               buildings: Building[], roads: Road[] }
// Building: { x, z, w, d, h, rot, color, kind }
// Road: { x1, z1, x2, z2, width }
```

## Controls

| Key | Action |
| --- | --- |
| W / S | pitch down / up |
| A / D | roll left / right |
| Q / E | rudder left / right |
| Shift / Ctrl (or Up/Down) | throttle up / down |
| G | landing gear |
| F | flaps |
| B | airbrake / wheel brakes |
| V | cockpit / external view |
| C | cycle camera |
| T | time scale (1×, 5×, 20×, 60×, 300×) |
| [ / ] | time of day −/+ 1 h |
| P / Esc | pause |
| H | help |
| M | mute |
| R | reset to runway |
| F1 | hide UI |
| F3 | perf panel |
| Mouse wheel | chase zoom |