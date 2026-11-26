# Feature 32 — Cinematic Pop: Selective Bloom, G-Force / Recoil Juice, Weapon Follow-Cam (`F5`) & Photo Mode (`F6`)

## Goal
Deliver AAA-grade visual & visceral flight "juice" using zero new npm dependencies:
1. **Selective Bloom (`src/sim/postfx.js`)** via Three.js's built-in `EffectComposer` + `UnrealBloomPass` + `OutputPass`.
2. **Flight & Combat Juice (`src/sim/juice.js`)** — sustained G-LOC blackout/redout, G-strain intensity, camera shake impulses (Vulcan recoil, Mach 1.0 shockwave, nearby explosions, afterburner rumble).
3. **Weapon Follow-Cam & Freeze-Frame Photo Mode (`src/aircraft/weapon_cam.js`)** — track live `BFFG` / `MK82` / `AIM9` warheads all the way to impact (with post-impact linger), plus freeze-frame orbit/zoom/FOV Photo Mode with 1-click PNG snapshot export.

## Owned Files (DO NOT modify files outside this list)
- `src/sim/postfx.js` (new)
- `src/sim/juice.js` (new)
- `src/aircraft/weapon_cam.js` (new)
- `tests/cinematic_juice_test.mjs` (new)

## Detailed Specification

### 1. Selective Post-Processing Bloom (`src/sim/postfx.js`)
Export `class PostFXSystem`:
- Imports `EffectComposer` from `'three/examples/jsm/postprocessing/EffectComposer.js'`, `RenderPass` from `'three/examples/jsm/postprocessing/RenderPass.js'`, `UnrealBloomPass` from `'three/examples/jsm/postprocessing/UnrealBloomPass.js'`, and `OutputPass` from `'three/examples/jsm/postprocessing/OutputPass.js'`.
- **Headless-safe**: `new PostFXSystem(renderer, scene, camera, { enabled })` gracefully becomes a no-op passthrough if `renderer` is null or lacks WebGL context, or if `enabled === false`.
- **Tuned Selective Threshold**:
  - `threshold = 0.88` (day) tapering to `0.72` (night) so daylight sky/clouds do NOT wash out, while HDR/un-tonemapped emissives (afterburner Mach diamonds, BFFG plasma, fireballs, city night windows, H4 traffic streaks, runway strobes, landmark beacons) bloom cleanly!
  - `strength = 0.36` (day) tapering to `0.58` (night), `radius = 0.45`.
- **API**:
  - `setEnabled(bool)` — toggles composer vs direct `renderer.render(scene, camera)` (Low quality disables bloom for max FPS).
  - `setNight(night)` — smoothly adjusts bloom threshold/strength for dusk/night pop.
  - `pulseBloom(amount = 0.55)` — temporary bloom spike (decays over ~0.6 s) triggered by BFFG/Mk-82 detonations or Mach 1.0 shockwave.
  - `update(dt)` — decays bloom pulse.
  - `resize(width, height, dpr)` — resizes composer & passes cleanly.
  - `render(scene, camera)` — updates `RenderPass.scene`/`camera` and renders via composer (when enabled) or falls back to `renderer.render(scene, camera)`.
  - `dispose()` — disposes composer/passes.

### 2. Flight & Combat Juice (`src/sim/juice.js`)
Export `class FlightJuiceSystem`:
- **100% headless-safe** pure simulation module.
- Tracks:
  - **G-LOC Blackout (`0..1`)**: Builds when `gLoad > 5.8` (faster above `7.5 G`), recovers when `gLoad < 4.5`. Also computes `gStrain` (`0..1`) for pilot G-breathing audio intensity.
  - **Negative-G Redout (`0..1`)**: Builds when `gLoad < -2.2`, recovers when `gLoad > -1.0`.
  - **Mach 1.0 Transonic Shockwave**: Detects crossing `mach` from `< 0.99` to `>= 1.0` (with cooldown) and fires a camera shake punch + `machPulse` (`1 -> 0` over `0.8 s`).
  - **Camera Shake Impulses**:
    - `addImpulse(intensity, duration = 0.25)` — called on Vulcan shots (`0.18`), missile launch (`0.35`), nearby explosions (`0.4..1.0` scaled by distance), carrier catapult (`0.45`).
    - Outputs smooth procedural high-frequency + low-frequency offsets `{ shakeX, shakeY, shakeRoll }` (in metres / radians) ready to apply to the camera.
- **API**:
  - `reset()`
  - `addImpulse(intensity, duration)`
  - `update(dt, { gLoad, mach, afterburner, onGround, speed })` — returns `{ blackout, redout, gStrain, machPulse, shakeX, shakeY, shakeRoll, shockwaveCrossed }`.

### 3. Weapon Follow-Cam & Photo Mode (`src/aircraft/weapon_cam.js`)
Export `class WeaponCamSystem` and `class PhotoModeController`:
- **`WeaponCamSystem`**:
  - `active` (bool), `toggle()` / `setActive(bool)`.
  - `update(dt, camera, weapons, aircraftPos)`:
    - Inspects active ordnance from `weapons` (`weapons.missiles`, `weapons.bombs` — or `weapons.getActiveOrdnance?.()`). Prioritizes `BFFG` > `MK82` > `AIM9`.
    - Tracks the chosen live projectile with a dramatic slightly-offset trailing camera (`14–22 m` behind & `4 m` above the warhead velocity vector, looking ahead toward the warhead/target).
    - When the tracked projectile detonates/disappears, locks onto its last impact position for **`2.2 s`** (`lingerTimer`) from a dramatic pulled-back angle (`~65 m` away, `28 m` up) so the player watches the multi-lobe fireball, 3D debris, and 160 m crater unfold, then auto-deactivates (or switches to the next live projectile).
    - Returns `{ active, tracking: bool, lingering: bool, label: string, speedKts: number, altFt: number }`.
- **`PhotoModeController`**:
  - `active` (bool), `fov` (`50`, adjustable `20..90`), `yaw`, `pitch`, `dist` (`28`, adjustable `8..180`).
  - `enter(aircraftPos, currentYaw, currentPitch)` — locks onto `aircraftPos` and freezes simulation.
  - `exit()` — restores normal flight.
  - `orbit(dx, dy)` & `zoom(delta)` & `adjustFov(delta)`.
  - `updateCamera(camera)` — positions `camera` smoothly around target anchor without touching aircraft physics.
  - `captureSnapshot(canvas, filename)` — browser-safe helper that composites a subtle corner `FALCON / INFINITE · VIPAVA VALLEY` stamp onto an offscreen canvas (if `document` exists) and triggers a clean `.png` download.

### 4. Tests (`tests/cinematic_juice_test.mjs`)
- Verify `FlightJuiceSystem`: sustained `8.5 G` builds `blackout > 0.5` and recovers at `1 G`; sustained `-3.5 G` builds `redout > 0.3`; crossing `mach` `0.95 -> 1.05` triggers `shockwaveCrossed` and `machPulse > 0`; `addImpulse` produces non-zero shake that decays to 0.
- Verify `WeaponCamSystem`: prioritizes `BFFG` over `AIM9`, positions camera behind moving projectile, and enters `2.2 s` impact linger when projectile vanishes.
- Verify `PhotoModeController`: `enter`, `orbit`, `zoom`, `updateCamera`, `exit` work cleanly headlessly.
- Verify `PostFXSystem` headless passthrough works without throwing.
- Run `npm test` and confirm all tests pass.
