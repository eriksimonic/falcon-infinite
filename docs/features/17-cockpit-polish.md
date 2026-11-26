# Feature 17 — Cockpit Polish: AoA Indexer, Master Caution, Night Backlighting & Canopy Rain

## Goal
Upgrade the F-16C 3D cockpit (`src/aircraft/cockpit.js`) with authentic pilot feedback:
1. **AoA Indexer Lights** mounted beside the left HUD combiner strut (amber chevron-up = slow/high AoA, green donut = on-speed approach, red chevron-down = fast/low AoA) active when landing gear is down.
2. **Master Caution Lamp** on the right glare shield that illuminates and flashes amber on stall, low fuel, radar lock/launch, overspeed, or flameout.
3. **Night Cockpit Backlighting** that smoothly boosts panel emissive glow and green NVG-friendly interior flood lighting as `env.night` rises (`0..1`).
4. **Canopy Raindrop Streaks** rendered on a subtle transparent windshield overlay plane when `env.rain > 0.05`, animating upward/aft proportionally to airspeed.

## File Ownership (STRICT)
Modify / create ONLY:
- `src/aircraft/cockpit.js`
- `tests/cockpit_test.mjs`

Do NOT modify any other files.

## Module Contract (`src/aircraft/cockpit.js`)
Keep existing `export function createCockpit()` return shape backward-compatible (`{ group, update, hudGlass, mfdL, mfdR, screenL, screenR, ... }`).

### 1. Pure Exported Helper: `export function computeCockpitIndicators(flight, env = {})`
Must be 100% headless-safe (no DOM/WebGL required):
- Inputs:
  - `flight`: `{ aoa, gearPos, stall, speed, onGround }` (where `aoa` is radians, `speed` is m/s)
  - `env`: `{ night = 0, rain = 0, lowFuel = false, rwrThreat = false, flameout = false, time = 0 }`
- Logic:
  - `aoaDeg = (flight?.aoa || 0) * (180 / Math.PI)`
  - `gearDown = (flight?.gearPos ?? 0) > 0.5`
  - **AoA Indexer** (only lit when `gearDown && !flight?.onGround`):
    - `'slow'` (amber up-chevron): `aoaDeg > 13.0`
    - `'onspeed'` (green donut): `aoaDeg >= 10.0 && aoaDeg <= 13.0`
    - `'fast'` (red down-chevron): `aoaDeg < 10.0`
    - `'off'` when gear up or on ground.
  - **Master Caution**:
    - `kts = (flight?.speed || 0) * 1.94384`
    - `cautionActive = !!(flight?.stall || kts > 620 || env.lowFuel || env.rwrThreat || env.flameout)`
    - `cautionFlash = cautionActive ? (Math.sin((env.time || 0) * 10) > -0.25) : false`
  - **Night Backlighting**:
    - `night = Math.max(0, Math.min(1, env.night || 0))`
    - `panelEmissive = 0.7 + night * 1.4`
    - `floodIntensity = 1.6 + night * 2.4`
  - **Canopy Rain**:
    - `rain = Math.max(0, Math.min(1, env.rain || 0))`
    - `rainOpacity = rain > 0.05 ? Math.min(0.65, rain * 0.65) : 0`
    - `rainScrollSpeed = 0.6 + Math.min(3.5, (flight?.speed || 0) / 70)`
- Returns `{ aoaState, cautionActive, cautionFlash, panelEmissive, floodIntensity, rainOpacity, rainScrollSpeed }`.

### 2. 3D Cockpit Visuals in `createCockpit()`
- **AoA Indexer Housing**: small dark bezel at `(-0.19, 1.13, -3.35)` next to the left HUD combiner strut with 3 emissive indicator meshes (`aoaUp`, `aoaMid`, `aoaDown`) whose emissive intensity lights up according to `aoaState`.
- **Master Caution Lamp**: amber indicator box on the right glare shield `(0.26, 0.33, 0.24)` inside `panel`, lighting bright amber when `cautionFlash` is true.
- **Night Backlighting**: dynamically updates `matPanel.emissiveIntensity`, `matDark.emissiveIntensity`, and interior `light.intensity` from `panelEmissive` and `floodIntensity`.
- **Canopy Raindrop Streaks**: procedural `CanvasTexture` with diagonal translucent rain streaks mapped onto a subtle curved/angled plane inside the forward canopy (`depthWrite: false`, `transparent: true`); scrolls `tex.offset.y` every frame at `rainScrollSpeed * dt` and sets `material.opacity = rainOpacity` (`visible = rainOpacity > 0.01`).

## Verification (`tests/cockpit_test.mjs`)
Standalone headless Node test importing `computeCockpitIndicators` from `../src/aircraft/cockpit.js` (note: importing `cockpit.js` must NOT touch `document` at top-level!) verifying:
1. `aoaState` is `'off'` when gear up or on ground.
2. `aoaState` is `'fast'` at `7°`, `'onspeed'` at `11.5°`, and `'slow'` at `15°` when airborne with gear down.
3. `cautionActive` triggers on stall, overspeed (`> 620 kts`), `lowFuel`, `rwrThreat`, or `flameout`, and is `false` in normal cruise.
4. `panelEmissive` and `floodIntensity` increase monotonically with `env.night`.
5. `rainOpacity` is `0` in clear weather and positive in rain, and `rainScrollSpeed` increases with airspeed.
6. Exits with code `0` and prints `ALL COCKPIT CHECKS PASSED`.
