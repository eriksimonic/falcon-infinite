# Feature 05 — Tactical HUD/RWR, NVG, G-LOC & Procedural Combat Audio

## Inspiration
*F-16: Back to Baghdad* was iconic for its cockpit situational awareness: the glowing green **RWR threat scope** screaming when an SA-6 locks on, the **AIM-9 Sidewinder growl** rising in pitch when it acquires heat, the **CCIP bomb-fall line** dancing across the HUD, **NVG night strikes**, and fighting **G-LOC blackout** in a 9G defensive break!

## File Ownership (STRICT)
Create ONLY:
- `src/ui/tactical.js`
- `src/core/combat_audio.js`
- `tests/tactical_test.mjs`

Do NOT modify any existing files.

## Module 1 Contract (`src/ui/tactical.js`)
Export `export class TacticalOverlay`:

### State & API
- `this.nvg = false` — toggleable Night Vision Goggles state
- `this.gloc = 0` (`-1` full redout .. `0` clear .. `+1` full blackout)
- `toggleNVG()` — toggles `this.nvg`, returns new boolean.
- `update(dt, flight)` — integrates realistic physiological G-LOC model:
  - Sustained `gForce > 5.8` builds `gloc` smoothly toward `+1` (faster above `7.5G`); recovering below `4.5G` clears it smoothly.
  - Sustained `gForce < -1.8` builds `gloc` toward `-1` (redout).
  - Returns `{ gloc: this.gloc, blackout: Math.max(0, this.gloc), redout: Math.max(0, -this.gloc), gStrain: number }`.
- `draw(ctx, w, h, state)` — Draws tactical layers onto the existing 2D HUD canvas (called after base HUD draw):
  `state` provides:
  `{ telemetry, camera, weapons, lockedTarget, targets, rwrContacts, mission }`
  1. **NVG Phosphor Mode** (when `this.nvg === true`):
     - Soft circular binocular vignette + subtle translucent emerald phosphor wash + ultra-fine scanlines + `NVG ON` indicator (never obscures HUD legibility).
  2. **3D-to-2D Projected Target Diamond & Steerpoint Box** (using `THREE.Vector3.project(camera)` when `camera` is provided):
     - Green/amber target box around `lockedTarget` with target label & slant range (`NM` / `M`), plus off-screen edge arrow if locked target is outside FOV.
     - **CCIP Bomb Fall Line & Impact Pipper** when `weapons.selected === 'MK82' && weapons.ccip.valid`: dashed green line from flight path to projected ground impact circle with center dot!
     - **M61A1 Gun Funnel / Lead Pipper** when `weapons.selected === 'GUN'`: crisp F-16 EEGS reticle at boresight (plus lead pipper if `lockedTarget` is airborne & moving).
     - **Steerpoint Caret** on screen / HUD edge showing active mission objective label & distance (`STPT 1 · 5.4 NM`).
  3. **F-16 RWR (Threat Warning Azimuth Scope)**:
     - Compact circular scope tucked cleanly in the **bottom-right** corner (`radius ~54px`, never overlapping center viewport or bottom-center dock).
     - Plots `rwrContacts` relative to aircraft heading (`R` radar, `S` SAM, `29` MiG-29, flashing `M` + ring for incoming missile launch!).
  4. **Weapon / Flare Status Strip & AWACS Radio Feed**:
     - Compact tactical weapon badge (`GUN 510 | AIM-9 4 | MK-82 6 | FLR 30`, highlighting selected weapon) and top-left **AWACS / Wingman Radio Feed** (last 3 messages from `mission.radio` with subtle fade).
  5. **G-LOC Blackout / Redout Tunnel-Vision Vignette**:
     - Progressive radial dark tunnel vision (`gloc > 0.15`) or crimson wash (`gloc < -0.15`).

## Module 2 Contract (`src/core/combat_audio.js`)
Export `export class CombatAudio`:
Shares an existing `AudioContext` and destination node (`attach(ctx, destNode)`) so it plugs seamlessly into `SimAudio`'s master compressor & mute control!

### Methods
- `attach(ctx, dest)` — Connects to `SimAudio`'s `ctx` and `sfxBus` (safe no-op if `!ctx`).
- `update(dt, state)` — Continuous tactical cues:
  - `state`: `{ weapon, hasLock, rwrHighest: 'NONE'|'SEARCH'|'LOCK'|'LAUNCH', gStrain, paused }`
  - **AIM-9 Sidewinder Growl**: Iconic raspy low-pitched IR seeker growl (`~220 Hz` when `weapon === 'AIM9'`, jumping to high steady `~880 Hz` lock tone when `hasLock === true`!).
  - **RWR Threat Audio**: Subtle ping on `SEARCH`, rapid triple-chirp on `LOCK`, urgent high-low warble on `LAUNCH`!
  - **Pilot G-Strain Breathing**: Subtle low-passed breath/exhale cue when `gStrain > 0.35`.
- One-shot SFX:
  - `cannonShot()` — Punchy mechanical 20mm Vulcan *BRRRRT* transient pulse (short low-mid bark + crisp transient snap, designed to layer smoothly at ~14 Hz fire rate without clipping).
  - `missileLaunch()` — Dramatic rocket ignition crack + pressurized whoosh tail (`0.9s`).
  - `bombRelease()` — Mechanical ejector rack metallic *CLUNK-THUMP* (`0.22s`).
  - `flarePop()` — Crisp pyrotechnic *POP-HISS* (`0.3s`).
  - `explosion(distanceM)` — Distance-attenuated deep rolling boom + low-passed rumble (`1.6s`).
  - `sonicBoom()` — Sharp double N-wave pressure crack + sub-bass shock thump (`0.7s`).
  - `radioBeep()` — Authentic short UHF tactical squelch click/beep when AWACS transmits.

## Verification (`tests/tactical_test.mjs`)
Write a standalone headless Node test verifying:
1. `TacticalOverlay`: G-LOC rises under sustained `8.5G`, recovers at `1G`, goes negative (redout) at `-3G`, and `toggleNVG()` flips cleanly.
2. `TacticalOverlay.draw()` executes cleanly against a minimal mocked 2D canvas context across cockpit & external modes with targets, CCIP, RWR launch alerts, radio messages, and NVG enabled.
3. `CombatAudio`: attaches to a mocked `AudioContext`, updates AIM-9 growl/lock, RWR states (`NONE`, `SEARCH`, `LOCK`, `LAUNCH`), and fires all one-shot SFX (`cannonShot`, `missileLaunch`, `bombRelease`, `flarePop`, `explosion`, `sonicBoom`, `radioBeep`) with finite AudioParams and zero errors.
