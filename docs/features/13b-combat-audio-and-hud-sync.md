# Feature 13B — Audible Weapon/Explosion Audio, Un-Ducked SFX Bus & 60 FPS HUD Sync

## Problems to Fix
1. **Weapon / bomb / explosion sounds are barely audible or silent**:
   - In `src/core/audio.js`, `sfxBus` was routed into the SAME `DynamicsCompressorNode` as the roaring F-16 jet engine (`simBus`), so the loud continuous jet engine ducks all weapon SFX, bomb releases, flare pops, and explosions!
   - `SimAudio.start()` did not call `ctx.resume()` on first creation if the `AudioContext` started `'suspended'`.
   - In `src/core/combat_audio.js`, `explosion(distanceM)` used `1 / (1 + d / 240)` — so a Mk-82 bomb hitting 3,500 m behind the jet played at `0.05` gain (completely inaudible!). Also `flare_pop.wav` (RMS 0.045) and `bomb_release.wav` (RMS 0.167) need higher playback gain.
2. **HUD was throttled to 30 FPS** (`if (!modeChanged && this._acc < 1 / 30) return;` in `src/ui/hud.js`), causing 1–2 frames of visual lag between the 60+ FPS WebGL scene and the 2D CCIP/gun pippers during maneuvers!
3. **CCIP pipper vanished in level flight** when the impact point projected below the bottom of the screen (`p.y >= h` in `src/ui/tactical.js`), instead of showing a clamped Delayed-CCIP Bomb Fall Line cue.

## File Ownership (STRICT)
Modify ONLY:
- `src/core/audio.js`
- `src/core/combat_audio.js`
- `src/ui/hud.js`
- `src/ui/tactical.js`
- `tests/tactical_test.mjs`

Do NOT touch any other files.

## Required Changes
1. **`src/core/audio.js`**:
   - In `start()`, after creating `ctx`, call `if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }`.
   - Give `sfxBus` its own dedicated soft limiter (`sfxCompressor`: threshold `-6`, knee `12`, ratio `4`, attack `0.003`, release `0.15`) connected directly to `this.master`, completely separate from the `simBus` jet-engine compressor so weapon SFX are NEVER ducked by the jet engine!
2. **`src/core/combat_audio.js`**:
   - In `_ready()` / one-shots: if `this.ctx.state === 'suspended'` and `typeof this.ctx.resume === 'function'`, call `this.ctx.resume().catch(() => {})` so a suspended context wakes immediately on trigger press.
   - Boost sample playback gains for clear punch over the jet:
     - `cannonShot`: `gain: 0.68`
     - `missileLaunch`: `missile_launch` `gain: 0.92`, `aim_launch_pop` `gain: 0.72`
     - `bombRelease`: `gain: 1.05`
     - `flarePop`: `gain: 1.15`
     - `sonicBoom`: `gain: 0.95`
   - Fix `explosion(distanceM)` attenuation:
     - `att = clamp(1 / (1 + d / 1400), 0.20, 1.0)`
     - `lpHz = clamp(12000 / (1 + d / 750), 340, 12000)`
     - Play sample at `gain: 1.05 * att` AND layer a subtle low-frequency sub-thump (`52 -> 24 Hz`, `0.30 * att`) so bomb detonations 3–4 km away are clearly felt and heard as a deep rolling boom!
3. **`src/ui/hud.js`**:
   - Remove the `1 / 30` frame-skip throttle in `HUD.update(dt, t, tactical)` so the 2D HUD redraws every animation frame, locked 1:1 to the WebGL camera!
4. **`src/ui/tactical.js`**:
   - In `_drawWeapons` for `MK82` when `ccip && ccip.valid`:
     - If `p && !p.behind` and `p.y >= h - 18 * s` (below HUD bottom), clamp the pipper onto the bottom edge along the `ox,oy -> p.x,p.y` line and draw a horizontal **Delayed-CCIP bar** across the dashed fall line with `MK-82  X.Xs` so the pilot always sees where the bomb line is even in level flight!

## Verification (`tests/tactical_test.mjs`)
Add checks verifying:
1. `CombatAudio.explosion(3500)` produces a clearly audible peak (`> 0.15`, while still quieter than `explosion(50)`).
2. `TacticalOverlay.draw()` renders a clamped Delayed-CCIP cue when `ccip` projects below the bottom of the screen (`p.y > h`).
3. All existing checks continue to pass (`node tests/tactical_test.mjs` exits 0).
