# Feature 09 — Pilot Kneeboard Map & Bitching Betty Voice Callouts

## Inspiration
A quick-glance translucent kneeboard map (`K` key) lets you navigate across the infinite procedural world, spot coastlines, mountains, cities, airports, wind barbs, and mission targets — and click any airport to set a diversion steerpoint. Meanwhile, classic F-16 **Bitching Betty** voice warnings keep your eyes outside the cockpit during intense maneuvers.

## File Ownership (STRICT)
Create ONLY:
- `src/ui/kneeboard.js`
- `src/core/betty.js`
- `tests/kneeboard_test.mjs`

Do NOT modify any existing files.

## Module 1 Contract (`src/ui/kneeboard.js`)
Export `export class KneeboardMap`:
- `new KneeboardMap()` — Headless safe (creates/manages an offscreen or attached `<canvas>` only when `document` exists or via `draw(ctx, x, y, size, state)` so it can render directly onto the HUD canvas!).
- Let's make `KneeboardMap` render directly via `draw(ctx, w, h, state)` onto the main 2D HUD canvas (zero extra DOM clutter, silky crisp retina rendering!).
- State:
  - `this.visible = false`
  - `this.rangeM = 32000` (zoom levels: `16000`, `32000`, `64000`)
  - `this.track = []` (rolling breadcrumb history of `{ x, z }`, sampled every `150 m`, capped at `240` points)
  - `this.selectedAirport = null`
- Methods:
  - `toggle()` — flips `visible`, returns boolean.
  - `cycleZoom()` — cycles `16000 -> 32000 -> 64000 -> 16000`, returns `rangeM`.
  - `recordPosition(x, z)` — appends breadcrumb if moved `>= 150 m` from last sample.
  - `clearTrack()` — clears breadcrumb trail & selection.
  - `pickAirportAt(screenX, screenY, w, h, flight, airports)` — if visible and user clicks near an airport icon on the kneeboard, sets & returns `this.selectedAirport` (or `null`).
  - `draw(ctx, w, h, state)`:
    - Draws a sleek military tactical kneeboard panel anchored on the left/center-left (`size ~min(w,h)*0.48`, dark translucent olive/emerald tactical glass, border, range rings, compass N/E/S/W).
    - Renders coarse terrain relief grid sampled from `state.heightAt(x, z)` (cached/re-sampled only when aircraft moves `> rangeM * 0.08` so frame cost is near zero!): deep navy for ocean (`<= 0`), dark green/sand contours for land/mountains.
    - Plots nearby `airports` (runway ticks + ICAO codes), `targets` (red/amber tactical symbols), `tanker` (cyan `TKR`), `steerpoint` dashed course line, `track` breadcrumb line, wind barb corner indicator, and player F-16 icon at center rotated to heading!

## Module 2 Contract (`src/core/betty.js`)
Export `export class BitchingBetty`:
- Synthesizes classic F-16 cockpit voice warnings using `window.speechSynthesis` when available (pitch ~1.05, rate ~1.12, concise sharp phrasing) AND/OR emits a clean fallback double-chime callback so it works seamlessly even if browser TTS is disabled or headless!
- `this.enabled = true`, `this.muted = false`, `this.lastCallout = null`
- `setMuted(muted)`
- `update(dt, state)`:
  - `state`: `{ onGround, crashed, aglFt, vsFpm, stall, kts, bingoFuel, missileLaunch, pullUpOverride }`
  - Evaluates priority alerts with per-alert cooldowns (`4–12s` so Betty never spams):
    1. `PULL_UP`: `!onGround && aglFt < 700 && vsFpm < -900` → `"Pull up. Pull up."` (cooldown `3.5s`)
    2. `MISSILE`: `missileLaunch === true` → `"Chaff. Flare."` (cooldown `4.5s`)
    3. `STALL`: `stall && !onGround` → `"Warning. Stall."` (cooldown `4.0s`)
    4. `OVERSPEED`: `kts > 620` → `"Warning. Overspeed."` (cooldown `6.0s`)
    5. `BINGO`: `bingoFuel === true` → `"Bingo fuel."` (cooldown `18.0s`)
    6. `ALTITUDE`: `!onGround && aglFt < 300 && vsFpm < -250` → `"Altitude. Altitude."` (cooldown `5.0s`)
  - Returns `{ spoke: string | null, alertId: string | null }`.
- `announce(text)` — Immediate one-shot callout (e.g. ILS `"Five hundred"`, `"Minimums"`).

## Verification (`tests/kneeboard_test.mjs`)
Write a standalone headless Node test verifying:
1. `KneeboardMap`: toggle, zoom cycle, breadcrumb sampling (`>= 150 m` threshold, max 240 points), airport click-picking math, and `draw()` against a mock 2D canvas context with elevation grid, airports, targets, and steerpoint.
2. `BitchingBetty`: triggers highest-priority warning (`PULL_UP` over `BINGO`), enforces per-alert cooldowns, stays silent on ground/crashed/muted, and handles `announce()`.
