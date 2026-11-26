# Feature 33 — Vipava Valley Showcase Integration (Wiring Features 30, 31 & 32)

## Goal
Wire Features 30 (`canyon_run.js`, `WIND.burja`, `soca_run`/`nanos_sead`/`adriatic_cap`), 31 (`traffic_roads.js`, landmark night uplighting, airport PAPI/rabbit strobes), and 32 (`postfx.js`, `juice.js`, `weapon_cam.js`) seamlessly into the live game (`main.js`, `world.js`, `hud.js`, `menu.js`, `input.js`, `index.html`, `style.css`, `package.json`), making **Vipava Valley** the default showcase experience on launch!

## Files to Update
- `src/world/world.js`
- `src/core/input.js`
- `src/main.js`
- `src/ui/hud.js`
- `src/ui/menu.js`
- `index.html`
- `src/ui/style.css`
- `package.json` (add the 3 new test suites to `npm test`)

## Detailed Integration Checklist

### 1. World Integration (`src/world/world.js`)
- Import and instantiate `RoadTrafficSystem` (`this.roadTraffic = new RoadTrafficSystem(scene, preset)`).
- Pass `sky.night` into `this.landmarks.update(dt, sky.night)` and `this.roadTraffic.update(dt, camera.position, sky.night)` inside `World.update(dt, camera, sky, weather)`.
- Propagate `setPreset(preset)` if needed (recreate or update `roadTraffic.maxVehicles` if desired).

### 2. Input Prevention (`src/core/input.js`)
- Add `'F5'` and `'F6'` to `PREVENT` so `F5` (Weapon Follow-Cam) does not reload the browser tab and `F6` (Photo Mode) does not focus the browser URL bar.

### 3. Main Menu & Default Vipava Showcase (`index.html`, `src/ui/menu.js`, `src/ui/style.css`)
- **Default Theater**: Set default theater to **`vipava`** (`this.theater = 'vipava'` in `UI` constructor, and `class="on"` on `<button data-v="vipava" data-theater="vipava" class="on">VIPAVA VALLEY</button>` in `index.html`).
- **Default Time**: Set default time to **Golden Hour (`17.6`)** (`GOLDEN HR` pill selected by default alongside Dawn / Morning / Afternoon / Golden Hr / Dusk / Night) so Vipava Valley's Karst cliffs, vineyards, and glowing valleys immediately look breathtaking!
- **Menu Mission Pills**: Add the 3 bespoke Vipava missions to `#opt-mission`:
  - `soca_run` → `SOČA CANYON`
  - `nanos_sead` → `NANOS SEAD`
  - `adriatic_cap` → `ADRIATIC CAP`
  (Keep `free`, `sead`, `strike`, `cap` as well.)
- **Menu Wind Pills**: Add `<button data-v="burja">BURJA NE</button>` to `#opt-wind`.
- **Control Map & Help Overlay**: Add `F5` (Weapon Cam) and `F6` (Photo Mode / Snapshot) to `CONTROL_GROUPS` in `src/ui/menu.js` and `#help` in `index.html`.
- **Photo Mode Overlay Bar** (small sleek floating bar at bottom of screen, hidden unless Photo Mode is active): shows `PHOTO MODE · DRAG ORBIT · SCROLL ZOOM · [ ] FOV` + a clickable `SAVE PNG (S)` button and `EXIT (F6 / ESC)` button.

### 4. Main App Wiring (`src/main.js`)
- **Default Vipava Startup**: On boot (`init()`), if `this.ui.theater === 'vipava'`, automatically call `await this.setTheater('vipava')` so the real 100×100 km Vipava Valley DEM, 7,770 buildings, 2,933 roads, 1,124 rivers, 351 lakes, 12 landmarks, and `RoadTrafficSystem` load right away!
- **Road Traffic Loading**: When `loadVipavaOSM()` finishes in `setTheater('vipava')`, call `this.world.roadTraffic.setCustomRoads(osm.roads, (x, z) => this.world.heightAt(x, z))`. When switching away from `vipava`, call `this.world.roadTraffic.clear()`.
- **Canyon Run (`CanyonRunSystem`)**:
  - Instantiate `this.canyonRun = new CanyonRunSystem(this.scene)`.
  - When starting flight (`startFlight()` / `respawn()`): if `mission === 'soca_run'`, start `this.canyonRun.start(this.world)` and position the aircraft for an exhilarating flying start (or lined up on `LJAJ` RWY 27 facing West toward Gate 1 — let's spawn airborne at `x: 200, z: 0, alt: 230, heading: 270, speed: 185` for `soca_run` so you immediately roar into Gate 1!). For all other missions, call `this.canyonRun.stop()`.
  - Each frame in `fly` mode when `this.canyonRun.active`: update `this.canyonRun.update(dt, f.position, f.speed)`; when a gate is passed, play `this.audio.click()` + toast `GATE X/8 · <NAME>` + pulse bloom subtly; when `finished`, trigger a celebratory toast + Betty callout (`"COURSE COMPLETE — GOLD MEDAL"` etc.).
  - Feed `canyonState = this.canyonRun.getState()` into HUD and steerpoint indicator so the HUD compass & waypoint box guide the pilot straight through each gate!
- **PostFX Selective Bloom (`PostFXSystem`)**:
  - Instantiate `this.postfx = new PostFXSystem(this.renderer, this.scene, this.aircraft.camera, { enabled: this.preset.name !== 'low' })`.
  - In `setQuality(q)`: call `this.postfx.setEnabled(this.preset.name !== 'low')` and `this.postfx.resize(window.innerWidth, window.innerHeight, pixelRatio)`.
  - On window resize: call `this.postfx.resize(...)`.
  - In main loop: `this.postfx.setNight(this.sky.night)`, `this.postfx.update(dt)`, and render with `this.postfx.render(this.scene, this.aircraft.camera)` instead of raw `this.renderer.render(...)`.
  - On `BFFG` / `MK82` explosions or Mach 1.0 crossing: call `this.postfx.pulseBloom(...)`.
- **Flight Juice (`FlightJuiceSystem`)**:
  - Instantiate `this.juice = new FlightJuiceSystem()`.
  - Trigger `this.juice.addImpulse(...)` on Vulcan fire (`0.16`), missile/bomb release (`0.28`), BFFG launch (`0.48`), explosions (scaled by distance), and carrier catapult (`0.42`).
  - Update each frame: `this._juiceState = this.juice.update(dt, { gLoad: f.gLoad, mach: f.mach, afterburner: f.afterburner, onGround: f.onGround, speed: f.speed })`.
  - When `shockwaveCrossed`: trigger `this.postfx.pulseBloom(0.45)` + `this.combatAudio.playSonicBoom?.()`.
  - Apply subtle camera shake offsets (`shakeX, shakeY, shakeRoll`) to `this.aircraft.camera` (only when not in Photo Mode).
- **Weapon Follow-Cam (`F5`) & Photo Mode (`F6`)**:
  - Instantiate `this.weaponCam = new WeaponCamSystem()` and `this.photoMode = new PhotoModeController()`.
  - `F5` key toggles `this.weaponCam.toggle()` (toast `WEAPON CAM ON/OFF`). When active in `fly` mode, call `this._weaponCamState = this.weaponCam.update(dt, this.aircraft.camera, this.weapons, f.position)` after aircraft camera update so it overrides camera position while tracking/lingering.
  - `F6` key toggles `this.photoMode`: entering freezes physics/sim updates, hides HUD (`this.hud.setVisible(false)`), shows `#photo-bar`, unlocks pointer lock, and lets mouse drag orbit / wheel zoom / `[`/`]` adjust FOV via `this.photoMode.updateCamera(this.aircraft.camera)`. Pressing `S` or clicking Save PNG button calls `this.photoMode.captureSnapshot(this.canvas)` (ensure `preserveDrawingBuffer` or render a fresh frame right before `toDataURL` so the WebGL canvas is never blank!). Exiting `F6` or `ESC` restores HUD & resumes flight.
- **Menu Live Golden-Hour Flyover Camera**:
  - While `this.mode === 'menu'`, smoothly orbit the camera over the F-16 on the Vipava Valley / Ajdovščina backdrop with slow cinematic drift (already has menu camera update — make sure it showcases the aircraft + Vipava mountains cleanly).

### 5. HUD Overlays (`src/ui/hud.js`)
- **G-LOC Blackout / Redout Vignette**: Draw radial black vignette when `t.juice?.blackout > 0.02` and radial crimson vignette when `t.juice?.redout > 0.02`.
- **Mach 1.0 Flash Ring**: Subtle brief translucent radial shock ring at screen edges when `t.juice?.machPulse > 0.05`.
- **Soča Canyon Run HUD Strip**: When `t.canyon?.active`, draw a crisp top-center racing telemetry strip:
  - `GATE 3 / 8 · VOGRŠČEK DAM`
  - Live `MM:SS.d` timer, distance to next gate (`2.4 KM`), and when finished: bold `COURSE COMPLETE · GOLD MEDAL · 01:28.4` badge!
- **Weapon Cam Banner**: When `t.weaponCam?.active && (t.weaponCam.tracking || t.weaponCam.lingering)`, draw a sleek military optical-pod banner (`WPN CAM · BFFG-9000 · 480 KT · 1,240 FT` or `IMPACT · LINGER`).

### 6. Test Runner (`package.json`)
- Add `node tests/vipava_scenarios_test.mjs`, `node tests/living_vipava_test.mjs`, and `node tests/cinematic_juice_test.mjs` to the `"test"` script in `package.json` (total **24 headless test suites**).
- Run `npm test` and `npm run build` and verify zero errors/warnings.
