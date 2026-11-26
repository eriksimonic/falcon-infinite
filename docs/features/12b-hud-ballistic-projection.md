# Feature 12B — True 3D Projected HUD Weapon Pippers, CCIP Fall Line & Camera Sync

## Problem
In `src/ui/tactical.js`, `_drawWeapons` currently draws the GUN reticle at hardcoded screen coordinates `(w * 0.5, h * 0.46)` and starts the CCIP bomb fall line at `(w * 0.5, h * 0.46)`. In chase/follow camera (which sits above and behind the jet looking downward, and can orbit) and in cockpit view with head-look or AoA, fixed screen coordinates do NOT match where bullets, bombs, or missiles actually go. Additionally, `camera.updateMatrixWorld()` was not called before `Vector3.project(camera)`, causing 1-frame projection lag during maneuvers.

## File Ownership (STRICT)
Modify ONLY:
- `src/ui/tactical.js`
- `tests/tactical_test.mjs`

Do NOT modify any other files.

## Required Changes in `TacticalOverlay` (`src/ui/tactical.js`)

1. **Eliminate 1-frame camera projection lag**:
   - At the start of `draw(ctx, w, h, state)`, if `state.camera && typeof state.camera.updateMatrixWorld === 'function'`, call `state.camera.updateMatrixWorld()` before projecting any 3D points!

2. **GUN Reticle Projected to True 3D Ballistic Trajectory**:
   - Read `weapons.gunSolution` (from Feature 12A) and `weapons.boresightPoint`.
   - Project `gunSolution.aimPoint` (when `gunSolution && gunSolution.valid`) through `camera` to get `(gx, gy)`.
   - Also project `weapons.boresightPoint` to `(bx, by)` if available.
   - Only fall back to `(w * 0.5, h * 0.46)` when no `camera` or valid 3D solution is provided (preserving headless mock tests!).
   - **Follow/External view (`isExternal`) — Minimal Micro-HUD**:
     - Draw the subtle segmented level-horizon micro-wings centered around the projected boresight (or `(w*0.5, h*0.47)` if boresight is off-screen), keeping it ultra-light (`alpha ~0.30`).
     - Draw the crisp, compact **ballistic gun pipper** directly at the projected `(gx, gy)` (tiny ring + center dot + 4 short ticks; turns slightly brighter/ticks when `gunSolution.impactValid` shows ground impact!).
     - If `gunSolution.leadValid` and `gunSolution.leadPoint` projects on-screen, draw the amber **ballistic lead pipper** at the projected `leadPoint` with a faint dashed cue line connecting `(bx, by)` → lead pipper so the pilot knows to put their boresight on the lead ring!
   - **Cockpit view**:
     - Center the F-16 EEGS gun reticle/pipper directly on the projected `(gx, gy)` ballistic point (so rounds go straight through the reticle dot even during high-G turns, AoA, and head-look!).
     - Use `gunSolution.leadPoint` when `gunSolution.leadValid` (falling back to the existing simple velocity lead only if `gunSolution` is absent).

3. **CCIP Bomb Fall Line Anchored to True 3D Flight Path**:
   - When `selected === 'MK82' && ccip && ccip.valid`:
     - Project `weapons.ccip` -> `(px, py)` (exact impact circle).
     - Project `weapons.ccipOrigin` (if valid) -> `(ox, oy)` for the start of the dashed Bomb Fall Line (BFL). If `ccipOrigin` is missing/off-screen, fall back to projected `boresightPoint` or `(w*0.5, h*0.46)`.
     - Keep the pipper crisp and unobtrusive in follow camera too, showing `MK-82  X.Xs`.

4. **AIM-9 Seeker Ring Projected on True 3D Boresight**:
   - When `selected === 'AIM9'`:
     - Project `weapons.boresightPoint` (if valid) -> `(bx, by)` (fallback `(w*0.5, h*0.46)`).
     - Draw a sleek minimal circular seeker FOV cue (small dashed ring, subtle green when searching, solid amber when `lockedTarget` is locked) centered on the true 3D nose boresight — so in follow/chase camera you see exactly where the AIM-9 seeker is looking!

## Verification (`tests/tactical_test.mjs`)
Add checks verifying:
1. `TacticalOverlay.draw()` calls `camera.updateMatrixWorld()` when present.
2. With an offset follow-style camera (e.g., positioned behind and above the aircraft looking slightly down, so projected 3D `gunSolution.aimPoint` maps to a non-center pixel like `(540, 610)` instead of `(w*0.5, h*0.46)`), the GUN pipper strokes/arcs are drawn at the projected `(540, 610)` coordinate!
3. With `MK82` + `ccipOrigin` + `ccip`, the dashed BFL starts at the projected `ccipOrigin` and ends at projected `ccip`.
4. With `AIM9` + `boresightPoint`, the seeker ring renders at projected `boresightPoint`.
5. All existing 84 checks continue to pass (`node tests/tactical_test.mjs` exits 0).
