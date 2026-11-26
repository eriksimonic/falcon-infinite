# FALCON / INFINITE — "Back to Baghdad" Combat & Immersion Feature Plan

Inspired by **F-16: Back to Baghdad**, this roadmap upgrades `FALCON / INFINITE` from a free-flight sandbox into a tactile, high-intensity tactical fighter experience while preserving its clean zero-asset procedural ES-module architecture.

## Execution Topology (Parallel-Safe Design)

Features **01 through 05** have **100% disjoint file ownership** and explicit inter-module data contracts so they can be executed **in parallel** by independent worker agents (`pi --model alibaba-plan/deepseek-v4.1-flash-1017`) with zero merge conflicts.

Feature **06** runs sequentially once 01–05 pass their unit tests, wiring all modules into `main.js`, `hud.js`, `menu.js`, `terrainview.js`, `config.js`, and `index.html`.

| # | Feature | Parallel Group | Owned Files (Disjoint) | Verification |
| --- | --- | --- | --- | --- |
| 01 | [Weapons, Ballistics, CCIP & Flares](./01-weapons-and-ballistics.md) | Wave 1 (Parallel) | `src/combat/weapons.js`, `tests/weapons_test.mjs` | `node tests/weapons_test.mjs` |
| 02 | [Targets, SAM Sites & Bandit Patrols](./02-targets-sam-and-bandits.md) | Wave 1 (Parallel) | `src/combat/targets.js`, `tests/targets_test.mjs` | `node tests/targets_test.mjs` |
| 03 | [Missions, Steerpoints & AWACS Comms](./03-missions-and-awacs.md) | Wave 1 (Parallel) | `src/combat/missions.js`, `tests/missions_test.mjs` | `node tests/missions_test.mjs` |
| 04 | [Combat VFX, Explosions & Mach Vapor](./04-combat-vfx-and-vapor.md) | Wave 1 (Parallel) | `src/sim/vfx.js`, `tests/vfx_test.mjs` | `node tests/vfx_test.mjs` |
| 05 | [Tactical HUD/RWR, NVG, G-LOC & Combat Audio](./05-tactical-displays-and-nvg.md) | Wave 1 (Parallel) | `src/ui/tactical.js`, `src/core/combat_audio.js`, `tests/tactical_test.mjs` | `node tests/tactical_test.mjs` |
| 06 | [Desert Strike Theater & Full Integration](./06-theater-and-integration.md) | Wave 2 (Sequential) | `src/main.js`, `src/config.js`, `src/ui/hud.js`, `src/ui/menu.js`, `src/world/terrainview.js`, `index.html` | `npm test && npm run build` |

## Shared Conventions (All Workers)
- 1 world unit = 1 metre, `Y` up, sea level `y = 0`, North `-Z`, East `+X`.
- Aircraft forward = `(0, 0, -1).applyQuaternion(flight.quaternion)`.
- Pure ES modules (`"type": "module"`), Three.js (`import * as THREE from 'three'`), **no external image/audio/model assets**.
- Deterministic randomness for world/mission generation (`mulberry32` from `../world/noise.js`).
- Keep Node unit tests headless-safe (no `document`/`window` required for logic/math verification).
