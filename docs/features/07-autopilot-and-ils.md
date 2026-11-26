# Feature 07 — F-16 Autopilot & ILS Landing Approach Computer

## Inspiration
Long-range desert transits and night/storm recoveries back to home plate feel authentic when you can hand off cruise to the F-16 autopilot and fly a precision ILS glideslope with altitude callouts and landing grade feedback.

## File Ownership (STRICT)
Create ONLY:
- `src/aircraft/autopilot.js`
- `tests/autopilot_test.mjs`

Do NOT modify any existing files.

## Module Contract (`src/aircraft/autopilot.js`)
Export `export class AutopilotSystem` and `export class ILSComputer`:

### `AutopilotSystem`
- `this.mode = 'OFF'` (`'OFF' | 'ATT' | 'ALT_HDG'`)
- `this.targetAlt = 0` (metres)
- `this.targetHeading = 0` (degrees `0..360`)
- `this.targetPitch = 0` (degrees)
- `this.targetRoll = 0` (degrees)
- `cycleMode(flight)` — Cycles `OFF -> ALT_HDG -> ATT -> OFF`, latching current altitude/heading/attitude on engagement (refuses engagement while `flight.onGround` or `flight.stall`). Returns new mode string.
- `disengage()` — Sets `mode = 'OFF'`.
- `computeCommand(flight, baseCmd)`:
  - If `mode === 'OFF'` or `flight.onGround` or `flight.crashed` or `flight.stall`: auto-disengages and returns `baseCmd` unchanged.
  - If pilot gives strong manual pitch or roll (`Math.abs(baseCmd.pitch) > 0.35 || Math.abs(baseCmd.roll) > 0.35`): auto-disengages cleanly and returns `baseCmd`.
  - Otherwise computes smooth, damped FBW pitch & roll commands (`[-1, 1]`):
    - `ALT_HDG`: holds `targetAlt` (via target climb/descent pitch clamped to `±12°`) and steers toward `targetHeading` (bank clamped to `±28°`).
    - `ATT`: holds `targetPitch` and `targetRoll`.
  - Returns a new command object `{ ...baseCmd, pitch, roll }` without mutating `baseCmd`.

### `ILSComputer`
- `update(dt, flight, airport)` — Given nearest `airport` (`{ x, z, elevation, heading, length, code, name }`) or `null`:
  - Picks the runway end aligned closest to aircraft heading (`ap.heading` or `(ap.heading + 180) % 360`), calculates threshold point.
  - Computes:
    - `active`: `true` when within `18000 m` of threshold, roughly on approach side (`<= 45°` off extended centerline), and `!flight.onGround`.
    - `locDev`: normalized localizer needle deviation (`-1..+1`, `+1` = fly right, `-1` = fly left; full scale `±5°`).
    - `gsDev`: normalized 3° glideslope needle deviation (`-1..+1`, `+1` = fly up, `-1` = fly down; full scale `±1.2°`).
    - `distNm`: distance to threshold in nautical miles.
    - `runwayLabel`: e.g. `'RWY 09'`.
  - Emits descending radar-altitude callout events (`500`, `200`, `100`, `50`, `MINIMUMS`) once per approach (resets when climbing above `220 m AGL`).
  - `gradeTouchdown(impactMs, bankDeg)` — Evaluates touchdown vertical speed (`impactMs` m/s downward) and bank angle:
    - `< 1.4 m/s` (`< 275 fpm`) & `|bank| < 4°`: `{ grade: 'BUTTER', fpm, color: 'green' }`
    - `< 2.8 m/s`: `{ grade: 'SMOOTH', fpm, color: 'green' }`
    - `< 4.8 m/s`: `{ grade: 'FIRM', fpm, color: 'amber' }`
    - else: `{ grade: 'HARD', fpm, color: 'red' }`

## Verification (`tests/autopilot_test.mjs`)
Write a standalone headless Node test verifying:
1. `AutopilotSystem.cycleMode` latches altitude/heading, outputs corrective roll toward heading and pitch toward altitude, and disengages automatically on manual stick input or stall.
2. `ILSComputer` computes accurate `locDev` (left vs right of centerline) and `gsDev` (above vs below 3° glideslope), fires altitude callouts descending through 500/200/100 ft once, and grades touchdowns accurately.
