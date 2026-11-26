# Feature 18 — Wave 6 Integration: ILS Needles, Kneeboard Diversion, Flyby+Doppler, Carrier, Replay, Mist/Tire VFX & Code-Splitting

## Goal
Wire all Wave 5 modules (`CarrierGroup`, `ReplaySystem`, upgraded `createCockpit`, `WSOCopilot`) and remaining handoff polish items into the live simulator cleanly, preserving all existing tests and keeping the external follow-camera HUD minimal and unobstructed.

## File Ownership (STRICT)
Create / modify ONLY:
- `src/ui/hud.js`
- `src/aircraft/aircraft.js`
- `src/core/audio.js`
- `src/sim/vfx.js`
- `src/sim/clouds.js`
- `src/world/world.js`
- `src/main.js`
- `src/ui/menu.js`
- `vite.config.js` (new)
- `package.json`

Do NOT modify Wave 5 module implementations (`mcp/wso_copilot.mjs`, `src/world/carrier.js`, `src/aircraft/replay.js`, `src/aircraft/cockpit.js`) or any other unrelated files.

## Required Changes

### 1. `src/ui/hud.js` — ILS Needles, FLOLS Meatball, Replay Banner & Cloud Mist
- **Cockpit HUD (`drawCockpitHUD`)**:
  - When `t.ils && t.ils.active`:
    - Draw authentic green F-16 ILS localizer vertical needle (horizontal offset `t.ils.locDev * 84 * s`) and glideslope horizontal needle (vertical offset `-t.ils.gsDev * 72 * s`, where `gsDev > 0` means fly up / above center, or standard fly-to needle direction matching `autopilot.js`: `gsDev = -(actualAngle - 3) / 1.2`, so `gsDev > 0` means aircraft is low -> needle above center -> `y = cy - t.ils.gsDev * 72 * s`; `locDev > 0` means aircraft is left -> needle right of center -> `x = cx + t.ils.locDev * 84 * s`).
    - Draw 4 subtle localizer/glideslope reference dots and compact `ILS ${t.ils.runwayLabel} · ${t.ils.distNm.toFixed(1)} NM` label below the pitch ladder.
- **External HUD (`drawExternalHUD`)**:
  - Preserve the unobstructed center viewport!
  - When `t.ils && t.ils.active`, draw a compact non-intrusive ILS mini-indicator pill tucked below the top-center compass (or top-left below wind/mode area) showing localizer/glideslope bars + `ILS ${t.ils.runwayLabel} · ${t.ils.distNm.toFixed(1)} NM`.
- **Both Cockpit & External HUD**:
  - **Carrier FLOLS Meatball**: when `t.meatball && t.meatball.active`, draw a compact vertical optical landing indicator on the left edge (green horizontal datum line + amber/red meatball dot shifted vertically by `clamp(t.meatball.ballOffset, -1, 1)` and label `CVN-71 ${t.meatball.distNm.toFixed(1)}NM`).
  - **Instant Replay Pill**: when `t.replaying`, draw a sleek top-center amber/green badge `REPLAY · ${t.replayRate}× · ${t.replayTime.toFixed(1)}/${t.replayDuration.toFixed(1)}s  [F2 EXIT · F4 SPEED]`.
  - **Cloud-Entry Mist Wash**: when `t.cloudMist > 0.02`, draw a soft radial white/mist vignette (`rgba(225,236,245, alpha)` with `alpha <= 0.36`, transparent center, misty edges) before HUD symbology so instruments stay crisp.

### 2. `src/aircraft/aircraft.js` — Flyby Camera, Doppler Ratio & Cockpit Env
- Add `'flyby'` to `nextMode()` order: `['cockpit', 'chase', 'wing', 'orbit', 'flyby']`.
- Maintain `this.dopplerRatio = 1.0`, `this._flybyAnchor = new THREE.Vector3()`, `this._flybyAnchored = false`.
- In `setMode(mode)`: reset `this._flybyAnchored = false` and `this.dopplerRatio = 1.0`.
- In `_updateCamera(dt, input, started)` when `this.mode === 'flyby'`:
  - Anchor camera ahead of the jet (`pos + forward * clamp(flight.speed * 2.1, 110, 340) + right * 26 + up * 10`, clamped above `world.heightAt(x, z) + 6`) when `!this._flybyAnchored` or when jet has passed `> 320 m` behind anchor (dot product `(pos - anchor) · forward > 320` or distance `> 900 m`).
  - Position camera at `this._flybyAnchor`, `cam.up.set(0, 1, 0)`, `cam.lookAt(pos)`, zoom FOV slightly (`38°`) for dramatic telephoto flyby feel.
  - Compute radial velocity toward camera: `vToward = (anchor - pos).normalize().dot(flight.velocity)` and set `this.dopplerRatio = clamp(340 / Math.max(120, 340 - vToward), 0.74, 1.36)`.
  - For all non-flyby modes, set `this.dopplerRatio = 1.0`.
- Accept optional `cockpitAlerts = null` in `update(dt, cmd, weather, input, started, cockpitAlerts = null)` (or read `this._cockpitAlerts`) and populate `env.night`, `env.rain`, `env.lowFuel`, `env.rwrThreat`, `env.flameout`, `env.time` before calling `this.cockpit.update(dt, flight, env)`.

### 3. `src/core/audio.js` — Doppler Pitch Shift
- In `update(dt, t)`, read `const doppler = clamp(t.doppler ?? 1.0, 0.72, 1.38)`.
- Multiply the turbine N1/N2 oscillator frequencies and intake/exhaust resonant bandpass frequencies by `doppler` so the `'flyby'` camera produces an authentic jet Doppler pass! (When `doppler === 1.0`, behavior is 100% identical to before.)

### 4. `src/sim/vfx.js` — Tire Touchdown Smoke Puffs
- Add `spawnTireSmoke(position, intensity = 1)` to `CombatVFX`:
  - Emits `6` to `10` light-gray/off-white expanding puffs (`0xd8dde2`) into the existing preallocated `this.puffs` pool around `position` with gentle upward/outward spread and `0.9–1.5 s` lifetime. Zero per-call allocations; headless-safe (`scene === null`).

### 5. `src/sim/clouds.js` — Cloud-Entry Mist Density
- Add `getCloudDensity(pos, weather)` to `CloudSystem`:
  - Uses current `weather?.state?.clouds ?? 0` and cloud altitude band (`base` ~ `1150..2100 m`, thickness `~750 m`) plus smooth deterministic horizontal noise (`hash2`) so flying through the cloud deck returns a smooth `0..1` mist density (`0` in clear sky or outside the cloud band).

### 6. `src/world/world.js` — Carrier Deck Elevation Support
- Add `this.carrier = null;` in constructor.
- In `heightAt(x, z)`: compute terrain height `h = terrainHeight(x, z)`; if `this.carrier`, check `const deck = this.carrier.getDeckElevation(x, z); if (deck !== null && deck > h) return deck;`; return `h`.

### 7. `src/main.js` — Full Wiring
- Import `CarrierGroup` from `./world/carrier.js` and `ReplaySystem` from `./aircraft/replay.js`.
- Instantiate `this.carrier = new CarrierGroup(this.scene)`, `this.carrier.placeNear(this.spawn.x, this.spawn.z)`, and attach `this.world.carrier = this.carrier`.
- Instantiate `this.replay = new ReplaySystem()`.
- Track `this._divertAirport = null`, `this._meatballState = null`, `this._cloudMist = 0`.
- **Kneeboard Diversion**:
  - Include `this.carrier.getDeckPoint()` in the airports array passed to both `pickAirportAt(...)` and `kneeboardState.airports`.
  - When `pickAirportAt` returns `picked`, set `this._divertAirport = picked`.
  - Reset `this._divertAirport = null` in `_startActiveMission`.
  - Compute active steerpoint: if `this._divertAirport` is set and (`!this._missionSnap?.steerpoint` || `this._missionSnap.status === 'FREE'`), use `{ x: this._divertAirport.x, z: this._divertAirport.z, label: 'DIV ' + this._divertAirport.code, kind: 'DIVERT' }` for both `kneeboardState.steerpoint` and a shallow copy of `mission` passed to `hud.update`.
  - Feed `this._divertAirport || t.airport` to `this.ils.update(simDt, f, ilsTarget)`.
- **Carrier Update**:
  - In `update(dt)` during live flight, call `const cRes = this.carrier.update(simDt, f, this.weather)`.
  - Store `this._meatballState = cRes.meatball`.
  - If `cRes.newlyCaughtWire > 0`, toast `CARRIER · OK ${cRes.newlyCaughtWire}-WIRE!` and play `this.audio.thump(0.75)`.
  - If `cRes.catapultLaunched`, toast `CATAPULT · LAUNCH!` and emit steam puffs via `this.vfx.spawnTireSmoke(f.position, 1.4)`.
- **Touchdown Tire Smoke**:
  - When `f.touchdown > 0.2`, emit `this.vfx.spawnTireSmoke({ x: f.position.x, y: f.position.y - 1.4, z: f.position.z }, clamp(f.touchdown / 3, 0.5, 1.4))`.
- **Cloud Mist**:
  - Smoothly approach `this._cloudMist` toward `this.clouds.getCloudDensity(this.camera.position, this.weather)` and pass `t.cloudMist = this._cloudMist`.
- **Cockpit Alerts**:
  - Pass `{ night: this.sky.night, rain: this.weather.state.rain, lowFuel: !!this._fuelState?.bingo, rwrThreat: rwrHighest === 'LOCK' || rwrHighest === 'LAUNCH', flameout: !!this._fuelState?.empty }` to `this.aircraft.update(...)`.
- **Instant Replay (`F2` toggle, `F4` speed)**:
  - In `onKey(e)` (or `handleFlightKeys`):
    - `F2`: if `this.replay.playing`, call `const snap = this.replay.stopPlayback(); if (snap) this.replay.applyToFlight(this.aircraft.flight, snap); this.ui.toast('REPLAY · LIVE');` else if `this.replay.startPlayback(30, this.aircraft.flight)`, switch to `'flyby'` or `'chase'` if in cockpit (optional, keep current or chase) and toast `'REPLAY · 30s (F2 EXIT · F4 SPEED)'`.
    - `F4`: if `this.replay.playing`, `const r = this.replay.cycleSpeed(); this.ui.toast('REPLAY SPEED · ' + r + '×');`.
  - In `update(dt)` during `fly`:
    - If `this.replay.playing`, step `const sample = this.replay.stepPlayback(simDt)` and apply pose to `this.aircraft.flight` + `this.aircraft.model` + camera update (without running live flight physics/weapons/damage); if `sample?.done`, auto-loop or pause at end with `F2 EXIT`.
    - If not replaying, call `this.replay.record(simDt, this.aircraft.flight)`.
  - Pass `t.replaying`, `t.replayRate`, `t.replayTime`, `t.replayDuration`, `t.meatball = this._meatballState` to `HUD`, and `doppler: this.aircraft.dopplerRatio` to `this.audio.update`.

### 8. `src/ui/menu.js` — Control Map Update
- Add `F2` (`Replay`) and `C` (`Cam / Flyby`) notes in `CONTROL_GROUPS` cleanly without bloating the layout.

### 9. `vite.config.js` & `package.json`
- Create `vite.config.js` with `build.rollupOptions.output.manualChunks` separating `three` into `'vendor-three'` so `npm run build` has no chunk-size warnings.
- Update `package.json`:
  - Add `"wso": "node mcp/wso_copilot.mjs"` to `scripts`.
  - Append `&& node tests/wso_test.mjs && node tests/carrier_test.mjs && node tests/replay_test.mjs && node tests/cockpit_test.mjs` to `scripts.test`.

## Verification
Run `npm test && npm run build`. All **16** test suites must pass with exit code `0`, and `npm run build` must succeed cleanly with `vendor-three` split out and zero chunk-size warnings.
