# Handoff — FALCON / INFINITE

Date: 2026-11-25
Project: `/home/erik/Documents/testflight`
State: playable prototype; production build and automated tests pass. Not yet
validated end-to-end on the target desktop; visual polish and city detail are
the main open work.

See `README.md` for user-facing features/controls and `ARCHITECTURE.md` for the
module contract. This document covers what is done, what is missing, and the
decisions the next session should make. Do not duplicate those files.

## Run / verify

```bash
cd /home/erik/Documents/testflight
npm install
npm run dev        # http://127.0.0.1:5173
npm run build
npm run preview    # http://127.0.0.1:4173
npm test           # settlement generator + flight model
```

No git repository exists in this directory. Consider `git init` before the next
large edit pass.

## Verified state

- `npm run build` succeeds (Vite, ~696 kB JS / 184 kB gzip).
- `npm test` passes:
  - settlements: 159,993 checks, 0 failures; ~20 ms cold 20 km query (~10 ms warm).
  - flight: 13 checks, 0 failures.
- Headless Chrome (1600×900) loads the menu, starts a flight, and renders
  cockpit, chase (runway + airborne afterburner), front-3/4 orbit, and wing
  camera views with zero JS console errors.
- Visual verification confirmed:
  - F-16C exterior is completely solid (inverted-winding semi-transparent
    fuselage/radome bug fixed) with clean cockpit/canopy fit, flush rudder,
    working afterburner plume, and cleanly retracting landing gear.
  - External camera UI (`chase`/`wing`/`orbit`) leaves the center viewport
    completely clear, anchoring telemetry to a top compass strip, top-right
    camera badge, bottom flight dock, and bottom-left ATC card.
  - Cockpit HUD retains green F-16 symbology without overlapping the MFDs.
- Synchronous in-app physics test at 500 kt, full aft stick:
  `stall=false`, max AoA 14.9°, max G 9.4, no crash.
- Takeoff works in the deterministic physics test: full throttle → 225 kt →
  rotate → airborne and climbing.
- Low-speed high-AoA pull still stalls, as intended.
- Terrain holes seen during LOD changes were addressed by retaining old tiles
  until replacements are built; no obvious holes in the later screenshots.

### Headless caveat (important)

The browser harness throttles requestAnimationFrame badly when the tab is not
focused. Live key-driven takeoff tests advanced only a fraction of a second of
sim time over many wall-clock seconds. Do **not** trust headless FPS numbers or
live keyboard timing; use the deterministic synchronous physics loop for logic
tests and a real visible browser for feel/FPS.

## What changed in this session

- **F-16C exterior rebuilt & semi-transparent bug fixed** (`src/aircraft/f16.js`,
  `src/aircraft/cockpit.js`, `src/aircraft/aircraft.js`):
  - Fixed inverted triangle winding in the loft builder (radome & fuselage had
    inward normals, causing front-face culling and a semi-transparent/inside-out
    appearance) and flipped the intake throat circle to face forward.
  - Rebuilt airframe with blended wing-body chines, deterministic seeded
    two-tone USAF Compass Ghost Grey panel/rivet textures (no `Math.random()`),
    tapered airfoil cropped-delta wings and LERX strakes, dorsal spine,
    parabrake fairing, dual canted ventral fins, sculpted chin intake with
    splitter and compressor spinner, turkey-feather exhaust nozzle with
    afterburner shock diamonds, and sleek 370-gal external fuel tanks (no weapons).
  - Replaced stretched hemisphere canopy with a frameless lofted teardrop bubble
    canopy (gold-tinted glossy exterior in external views, crystal-clear low
    opacity in cockpit view) plus an external pilot figure hidden in cockpit mode.
  - Aligned cockpit tub, seat headrest, and HUD combiner cleanly inside the
    fuselage/canopy so nothing protrudes externally.
  - Fixed stabilator hinges (now pivot around mid-chord instead of aircraft CG),
    added animated flaperons, flush-raked rudder, split tail speedbrakes, and
    belly-folding landing gear retraction (no longer slides up through wings).
  - Improved `orbit`, `chase`, and `wing` camera framing so the jet stays
    cleanly centered during external inspection.
- **External camera UI redesigned** (`src/ui/hud.js`, `src/ui/style.css`):
  - Split HUD rendering into `drawCockpitHUD` (green F-16 symbology, cleaned up
    so text no longer overlaps the cockpit MFDs) and `drawExternalHUD` for
    `chase`/`wing`/`orbit` views.
  - External views now leave the entire center screen unobstructed, with a slim
    top-center magnetic compass bar (with airport bearing caret), top-right
    camera mode badge (`EXT · CHASE/WING/ORBIT` + key hints), compact
    bottom-center dark-glass flight dock (IAS/Mach, throttle/AB bar, live mini
    attitude ball, ALT/AGL/VSI, G/AoA, GEAR/FLP/BRK status pills), top warning
    banner when triggered, and matching dark-glass `#atc` card on the bottom-left.
- **Previous session changes (retained)**:
  - **Clouds rewritten** (`src/sim/clouds.js`): deterministic clusters of
    instanced camera-facing puffs with weather-driven opacity, rain, lightning.
  - **Physics** (`src/aircraft/flight.js`): low-speed stall gate (<195 m/s),
    FBW AoA/G limiter, tuned pitch/roll/yaw rates.
  - **Road network & cities** (`src/world/roadnet.js`, `src/world/buildings.js`):
    inter-settlement highways, urban ground patches, stepped towers, street lamps.
  - **Terrain** (`src/world/terrainview.js`): stale-tile bridge prevents transient
    LOD holes.

## Missing / known issues (ordered by user impact)

1. **No real-window validation of takeoff, landing, gear cycle, or FPS.** The
   most important next step. Headless tests do not cover feel, flare, ground
   effect, camera comfort, or actual frame rate on the Ryzen 5 5500U / Vega 7.
2. **City detail is still basic.** Buildings are repetitive boxes with a
   procedural window grid. Urban ground patches are visibly circular and the
   road grid is thin from altitude. No cars, landmarks, interchanges,
   roundabouts, bridges, parks, or street trees. Highways are visible but not
   strongly readable at 2–3 km.
3. **Clouds are billboard clusters, not volumetric.** They can look repetitive
   and may sort incorrectly when overlapping. Storm lightning is occasional and
   may not appear in short sessions. Overcast is many puffs rather than a solid
   deck.
4. **Cockpit interior fidelity is still stylized.** The F-16C exterior is now
   solid and well-proportioned, while the cockpit panel/consoles remain
   simplified. Cockpit HUD is still a screen-space overlay, not clipped to the
   3D combiner. No canopy reflections/dirt/rain.
5. **LOD/stale-tile tradeoff.** Stale ancestor tiles may overlap new children
   until pending tiles finish, which can create temporary overdraw/z-fighting.
   At very high speed, holes or hitching are still possible.
6. **Terrain has no shadows or AO.** Lighting is flat; fake AO/shadow blobs
   would improve the ground/city look but cost performance.
7. **Quality presets are only partly live.** Changing quality after boot updates
   pixel ratio and some radii, but cloud instance capacity, terrain tile
   resolution and renderer antialias are fixed at construction. A reload prompt
   or full rebuild path is needed for real quality switching.
8. **Flight model simplifications.** No trim, autopilot, fuel/weight, or
   realistic landing gear dynamics. Ground pitch/roll limits and crash
   thresholds are approximate. Turbojet spool is simplified.
9. **UI/telemetry details.** Airport/ATC data updates on a ~1 s timer and can
   briefly say "no airport" after start. Weather HUD label can appear one frame
   stale in captures. Storm label/state has been confirmed in-game but screenshots
   sometimes lag by a frame.
10. **Audio is synthetic and untested for balance.** Engine/wind/rain/gear/
    warning levels may need mixing on real speakers.
11. **Spawn choice is arbitrary.** `chooseSpawn()` picks the airport/city pair
    with the best metro proximity, which can be ~68 km from world origin
    (currently Nyxport Regional / Yarwick City). That is fine functionally but
    means the "origin" airport/city from the settlement test is not the start.
12. **No git history, no CI, no E2E browser test.** Only Node physics/world
    tests.

## Decisions to make later

- **Visual target:** stay stylized/low-poly for performance, or push toward
  study-level F-16/cockpit/city fidelity at the cost of frame rate?
- **City approach:** procedural detail (cars, landmarks, interchanges, street
  trees) vs a more systemic urban ground/block texture. Also decide whether to
  hide the circular urban patch edge with irregular alpha or replace it with a
  terrain-based urban tint.
- **Clouds:** keep billboard clusters (cheap, decent) or implement raymarched
  volumetric clouds (expensive on Vega 7). If keeping billboards, decide whether
  to add a soft high overcast layer without reintroducing visible sheet edges.
- **HUD:** keep the usable full-screen overlay or clip symbology to the 3D
  combiner for authenticity. If clipping, enlarge/reshape the combiner and add
  speed/alt tapes inside it.
- **FOV:** 52° cockpit / 50° external was chosen from feedback; decide by
  actually flying it. Some testers still called it telephoto. Consider a
  user-adjustable FOV slider.
- **Spawn:** start at the best city-adjacent airport (current) vs the origin
  airport (settlement test fixture) vs a menu airport list. Long-term, a small
  airport selector would be useful.
- **Physics depth:** arcade-stable (current limiter) vs study-level AoA/G/trim.
  Decide whether to add autopilot/trim and how forgiving landings should be.
- **Quality switching:** live rebuild vs reload prompt vs fixed quality per
  session. Clouds/terrain resolution currently require reconstruction.
- **Performance budget:** target FPS/resolution on the Vega 7 (e.g. 60 fps at
  1080p medium). Use that to decide shadows, cloud count, road density and city
  building limits.
- **Terrain artifacts:** decide whether to invest in a proper clipmap/worker
  terrain build or accept the current stale-tile bridge during fast flight.

## Suggested next-session plan

1. Run `npm run dev` in a real visible browser on the target PC. Use F3; record
   FPS at low/medium/high, takeoff, climb, turn, stall recovery, approach,
   landing, gear/flaps, camera modes, weather presets, night.
2. Fix any real-window flight/landing or camera bugs first.
3. Make one focused visual pass (pick one): city detail/roads, cloud quality, or
   cockpit/F-16 shape. Do not mix all three in one change set.
4. Re-run `npm test` and `npm run build` after each pass. Add a manual test note
   in this handoff or README.
5. Initialize git and commit the baseline before further edits.

## Key files

- `src/main.js` — boot, input actions, frame loop, spawning, ATC UI.
- `src/config.js` — FOV, quality presets, weather presets, aircraft constants.
- `src/aircraft/flight.js` — flight model, stall gate, FBW limiters, ground logic.
- `src/aircraft/f16.js`, `src/aircraft/cockpit.js` — exterior/interior models.
- `src/world/terrain.js` — analytic height + airport flattening.
- `src/world/terrainview.js` — quadtree LOD terrain, water, stale-tile handling.
- `src/world/settlements.js` — deterministic settlements (subagent-built; tests).
- `src/world/buildings.js` — buildings, city roads, streetlights, urban ground.
- `src/world/roadnet.js` — inter-settlement highways.
- `src/sim/clouds.js` — cloud puff field + rain.
- `src/sim/sky.js`, `src/sim/weather.js`, `src/sim/time.js` — atmosphere.
- `src/ui/hud.js` — F-16-style HUD.
- `tests/flight_test.mjs`, `tests/settlements_test.mjs`.

## Suggested skills for the next agent

- `dogfood` — exploratory browser QA: fly the sim, capture visual/UX bugs with
  evidence.
- `systematic-debugging` — if terrain holes, camera glitches, or flight-model
  regressions appear.
- `test-driven-development` — for any new flight-model or streaming logic.
- `requesting-code-review` — before committing a larger visual/physics pass.
- `handoff` — when ending the next session.
- `github` — if initializing/committing the repo.

## Constraints / cautions

- No weapons by explicit user request.
- Do not trust headless FPS or live key timing (RAF throttling).
- Do not modify `src/world/settlements.js` without running its test.
- Keep the module contracts in `ARCHITECTURE.md` in sync if exports change.
- Avoid introducing `Math.random()` into terrain/settlement/road generation;
  world content must stay deterministic.