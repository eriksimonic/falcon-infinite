# Feature 23 — The BFFG Mega-Ordnance Weapon & 3D Building Side-Impact

## Goal
1. Add the **BFFG** ("Big Falcon Gun" — tactical plasma-thermobaric mega-ordnance, `"really really woops"` superweapon) to `WeaponSystem`:
   - Added to `WEAPON_TYPES = ['GUN', 'AIM9', 'MK82', 'BFFG']`.
   - `DEFAULT_AMMO.BFFG = 2` (reloads on `reset()`).
   - `WEAPONS.BFFG`:
     - `name: 'BFFG-9000 Mega-Ordnance'`
     - `cooldown: 2.5`
     - `launchSpeed: 240`
     - `accel: 95`
     - `burnTime: 1.8`
     - `maxSpeed: 560`
     - `drag: 4e-5`
     - `damage: 5000`
     - `splashRadius: 420` (levels an entire city district!)
     - `ttl: 35`
   - Procedural 3D mesh in `_makeMesh('BFFG')`: glowing cyan-white-gold plasma warhead core (`0x66f7ff`) surrounded by bright golden-amber stabilizer rings (`0xffc857`), clearly visible in flight!
   - Rocket-boosted flight with gentle gravity arc (`0.35 * G` during burn, `1.0 * G` after burn) and bright cyan/gold plasma trail (`color: 0x66f7ff, size: 2.8`).
   - When `this.selected === 'BFFG'`, compute a live ballistic impact solution stored in `this.ccip` (same `{ valid, x, y, z, timeToImpact }` contract) so the HUD projects a live BFFG impact reticle!
2. **3D Building Side-Wall Impact for ALL Weapons (`GUN`, `AIM9`, `MK82`, `BFFG`)**:
   - In `_stepProjectile(p, h, world, targets, events)`, before the terrain check:
     - If `world && world.buildings && typeof world.buildings.hitBuilding === 'function'`:
       - Call `const bHit = world.buildings.hitBuilding(_prevPos, p.position)`.
       - If `bHit` is non-null:
         - Snap `p.position.set(bHit.x, bHit.y, bHit.z)`.
         - Call `this._impact(p, events, this._splashTargetId(p, targets))` (and include `hitBuilding: true` on the impact event!).
         - Set `p.dead = true` and `return`.

## File Ownership (STRICT)
Modify ONLY:
- `src/combat/weapons.js`
- `tests/weapons_test.mjs`

Do NOT modify any other files.

## Verification (`tests/weapons_test.mjs`)
Keep all existing checks passing (note: update any `cycleWeapon()` wrap test if it assumed 3 weapons instead of 4!) AND add checks verifying:
1. `WEAPON_TYPES` includes `'BFFG'`, `DEFAULT_AMMO.BFFG === 2`, `WEAPONS.BFFG.damage >= 4000`, `WEAPONS.BFFG.splashRadius >= 400`.
2. Selecting & firing `'BFFG'` decrements ammo, spawns a `'BFFG'` projectile, emits cyan trail events (`0x66f7ff`), and produces an impact event with `weapon: 'BFFG'`, `damage: 5000`, `splashRadius: 420`.
3. Building side-impact: when `world.buildings.hitBuilding` returns a mid-air wall hit (`y = 45 m` above flat `y = 0` terrain), `GUN`, `AIM9`, `MK82`, and `BFFG` all detonate at `y = 45 m` with `hitBuilding: true` instead of passing through to `y = 0`.
4. `node tests/weapons_test.mjs` exits `0` and prints `ALL WEAPONS CHECKS PASSED`.
