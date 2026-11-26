# Feature 26 — Architectural City Facades, Permanent Multi-Piece Ruins, Scaled Craters & Cumulative Ordnance Damage

## Goal
1. **Fix "Weird-Looking" Cities (`src/world/buildings.js`)**:
   - **Wall-Aligned Reflective Window Shader (`makeBuildingMaterial`)**:
     - Pass local unit-box position (`vLocal = position`, where `x,z ∈ [-0.5, 0.5]`, `y ∈ [0, 1]`) and extracted instance scale (`vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz))`) from vertex shader!
     - Compute true wall-aligned facade coordinates (`u = (abs(nLocal.x) > 0.5 ? vLocal.z * vScale.z : vLocal.x * vScale.x) / 3.8`, `v = (vLocal.y * vScale.y) / 3.4`) so windows are **100% crisp, vertical, and never diagonally smeared** on rotated buildings!
     - In daylight, render windows as **dark reflective sky-tinted glass** (`mix(col, skyGlass, win * 0.62)`) with crisp horizontal floor spandrels, subtle base ambient occlusion (`0.72 -> 1.0` over bottom `15%`), and textured darker rooftops — giving cities instant realistic architectural depth!
     - At night, keep warm glowing office/residential windows (`uNight * lit`).
   - **Subtle Blended Urban Ground (`_ensureGround`)**:
     - Lower urban ground decal opacity from `0.82` to `0.38` with a softer radial falloff so cities sit naturally on the terrain instead of a harsh grey circle stain!
2. **Permanent Dynamic Destruction for ALL Ordnance (`GUN`, `AIM9`, `MK82`, `BFFG`)**:
   - **Cumulative Building Damage (`this.buildingHp`)**:
     - Every building has effective HP `Math.max(40, Math.min(180, b.h * 2.2))`.
     - In `applyBlast(position, splashRadius, damage = 100)`:
       - Apply distance-falloff damage (`dmg = damage * clamp(1 - dist / (reach + 1), 0.25, 1)`).
       - `MK82` (`180`), `AIM9` (`120`), `BFFG` (`5000`) immediately collapse buildings in their lethal radius; even repeated `GUN` (`18`) bursts chip down a building's HP until it ignites and collapses!
   - **Permanent Multi-Piece Jagged Ruins**:
     - Once a building finishes collapsing into `this.destroyed`, render it as a **multi-part ruined footprint** (3–4 broken jagged charred wall stubs, tilted concrete slabs, and a dark scorched debris core) instead of a single flat box, so bombed cities look genuinely devastated permanently!
   - **Weapon-Scaled Permanent Craters**:
     - Scale crater radius by blast size: `GUN` (`damage < 40`) -> small `4–6 m` dark bullet scorch mark (allow `damage >= 15` to leave a crater/scorch!); `AIM9` -> `18 m` crater; `MK82` -> `38 m` crater; `BFFG` (`splashRadius >= 200`) -> colossal `160 m` blackened ground-zero wasteland crater!
     - Upgrade crater visual texture (`makeCraterTexture`): crisp dark charred center, scorched radial blast rays, raised dusty earth rim, and subtle ember glow ring.
   - **Persistent Smoldering Ruin Fires (`getRuinFirePoints()`)**:
     - Track `this.ruinFires` (recently collapsed buildings that keep smoldering for `75 s`, capped at `24` active embers), stepped in `update(dt)` and returned by `getRuinFirePoints()` so bombed districts visibly burn and smoke long after the explosion!

## File Ownership (STRICT)
Modify ONLY:
- `src/world/buildings.js`
- `tests/cities_destruction_test.mjs`

Do NOT modify any other files.

## Verification (`tests/cities_destruction_test.mjs`)
Keep all existing 198 checks passing AND add checks verifying:
1. Small-arms `GUN` blast (`splashRadius: 6, damage: 18`) chips building HP and leaves a small scorch crater (`radius <= 8 m`), and repeated hits eventually ignite and collapse the building!
2. `BFFG` blast (`splashRadius: 420, damage: 5000`) creates a massive permanent crater (`radius >= 120 m`) and collapses buildings across the district.
3. Once collapsing buildings finish in `update()`, they register in `getRuinFirePoints()` (smoldering ruins!) and decay cleanly after `80 s`.
4. `node tests/cities_destruction_test.mjs` exits `0` and prints `ALL CITIES & DESTRUCTION CHECKS PASSED`.
