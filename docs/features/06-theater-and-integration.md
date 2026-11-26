# Feature 06 — Desert Strike Theater & Full Combat Integration (Sequential Phase 2)

## Prerequisite
Run ONLY after Features **01 through 05** are implemented and all their unit tests pass.

## Inspiration
Completes the *F-16: Back to Baghdad* experience by uniting all 5 parallel modules into the live game loop and adding a selectable **Desert Strike (Baghdad)** arid desert/river-valley terrain & warm haze theme alongside the classic Temperate theater.

## File Ownership (Shared Files — Sequential Integration Only)
- `src/config.js` — Add `THEATERS` (`temperate`, `desert`) palette/haze presets.
- `src/world/terrainview.js` — Support switching terrain shader/color palette between Temperate and Desert Strike (sun-baked sandstone, arid plains, dark irrigated river corridors, warm dust-haze horizon).
- `src/ui/menu.js` & `index.html` — Add **MISSION** (`FREE FLIGHT`, `WILD WEASEL`, `BAGHDAD STRIKE`, `BARCAP SWEEP`) and **THEATER** (`TEMPERATE`, `DESERT STRIKE`) pill selectors + updated combat controls in menu/help.
- `src/main.js` — Instantiate and wire:
  - `WeaponSystem`, `TargetSystem`, `MissionDirector`, `CombatVFX`, `TacticalOverlay`, `CombatAudio`
  - Controls:
    - `Space` or Left Mouse (in cockpit pointer-lock): Fire selected weapon (move wheel brake to `KeyB` only so `Space` is dedicated combat trigger!)
    - `Tab` or `Digit1`/`Digit2`/`Digit3`: Cycle / select `GUN`, `AIM-9`, `MK-82`
    - `KeyX`: Deploy countermeasure flares
    - `KeyN`: Toggle NVG night vision goggles
  - Hook explosions, smoke plumes, missile/flare trails, sonic boom, AWACS radio squelch, SAM hits (damage/crash or airframe shake), and mission lifecycle (`startFlight`, `respawn`, `returnToMenu`, `pause`).
- `src/ui/hud.js` — Invoke `tacticalOverlay.draw(ctx, w, h, tacticalState)` cleanly after base HUD rendering.
- `package.json` — Add all new `tests/*_test.mjs` scripts to `npm test`.

## Verification
1. `npm test` passes all existing + 5 new feature test suites (`settlements`, `flight`, `weapons`, `targets`, `missions`, `vfx`, `tactical`).
2. `npm run build` succeeds with zero warnings/errors in module resolution.
3. Headless integration smoke test confirms mission start -> weapon fire -> target destruction -> RTB -> audio & VFX lifecycle runs without errors.
