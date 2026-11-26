# Feature 25 — Dynamic Multi-Lobe Explosions, Tumbling 3D Debris & Flash Lighting

## Goal
Replace the single smooth geometric sphere explosions in `src/sim/vfx.js` with visceral, dynamic, physically-grounded blasts for **every** ordnance type (`GUN`, `AIM9`, `MK82`, `BFFG`):
1. **Multi-Lobe Billowing Fireball Cluster**: Each explosion slot owns `5` offset churning fireball lobes (arranged around the blast center with independent expansion, rise, and turbulence) + bright incandescent core + ground shockwave ring, eliminating the artificial "single smooth ball" look.
2. **Dynamic Blast Flash `PointLight`**: A shared preallocated warm-orange `THREE.PointLight` pulses intensely on detonation and decays over `0.6–1.4 s`, dynamically illuminating nearby skyscrapers, streets, and terrain!
3. **Tumbling 3D Flying Debris Chunks**: A preallocated `THREE.InstancedMesh` pool (`DEBRIS_CAPACITY = 160`) of irregular dark concrete/steel blocks launched ballistically outward from every explosion (`GUN` -> 4 concrete chips, `AIM9` -> 12 shrapnel/masonry chunks, `MK82` -> 22 heavy rubble chunks, `BFFG` -> 44 massive tumbling slabs!), rotating in 3D, arcing under gravity, and bouncing/settling onto the ground!

## File Ownership (STRICT)
Modify ONLY:
- `src/sim/vfx.js`
- `tests/vfx_test.mjs`

Do NOT modify any other files.

## Module Contract (`src/sim/vfx.js`)
Keep **100% backward compatibility** with all existing methods, fields, and `tests/vfx_test.mjs` checks (including headless safety when `scene === null`, zero per-frame allocations, and preallocated pools!).

1. **Multi-Lobe Fireball**:
   - Keep `slot.core`, `slot.coreMat`, `slot.fireball`, `slot.fireballMat`, `slot.ring`, `slot.ringMat` intact (so all existing tests pass!).
   - Add `slot.lobes` (4 extra `THREE.Mesh` fireball lobes sharing `this._coreGeo` and per-lobe `MeshBasicMaterial` in fiery shades `0xff6e1a`, `0xff4410`, `0xff9926`, `0x3a241a`), preallocated inside `_buildExplosions()`.
   - In `update()`, animate each lobe rising, churning outward with deterministic phase offsets, and scaling organically before fading into the smoke column.
2. **Dynamic Flash Light**:
   - Preallocate `this._blastLight = new THREE.PointLight(0xff9b42, 0, 450, 1.5)` added to `this.group`.
   - On `spawnExplosion(pos, scale)`, move `_blastLight` to `(pos.x, pos.y + Math.max(4, scale * 2), pos.z)`, set peak intensity proportional to `scale` (`clamp(scale * 18, 12, 260)`) and range (`clamp(scale * 45, 90, 900)`), and decay smoothly over `0.7..1.4 s` in `update()`.
3. **3D Tumbling Debris Pool (`this.debris`)**:
   - Preallocate flat typed arrays for `DEBRIS_CAPACITY = 160`: `px, py, pz, vx, vy, vz, rx, ry, rz, avx, avy, avz, sx, sy, sz, life, maxLife, floorY, active`.
   - Preallocate `THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.7, 0.85), debrisMat, DEBRIS_CAPACITY)` attached to `this.group` (`frustumCulled = false`, `count = 0`).
   - On `spawnExplosion(pos, scale)`:
     - Launch `debrisCount = scale >= 10 ? 44 : scale >= 3.5 ? 22 : scale >= 1.5 ? 12 : 4` tumbling chunks with radial/upward velocity, random angular velocity, and size scaled by `scale`.
     - In `update(dt, ...)`: step gravity (`-9.81 m/s²`), spin angles, bounce once when `py <= floorY` (dampening `vy` by `-0.35`, `vx/vz` by `0.55`), write instance matrices for active chunks, and expose `this.activeDebris` in `update()` return stats!
   - Reset clears all active debris and zeros `_blastLight.intensity`.

## Verification (`tests/vfx_test.mjs`)
Keep all existing 123 checks passing AND add checks verifying:
1. `spawnExplosion(pos, 4.5)` activates multi-lobe fireball meshes (`slot.lobes.length === 4`) and spawns `>= 18` tumbling debris chunks (`activeDebris >= 18`).
2. `spawnExplosion(pos, 14)` (`BFFG`) spawns `>= 36` debris chunks and boosts `_blastLight.intensity > 0`.
3. Stepping `update()` advances debris ballistically, bounces/settles chunks, and expires them cleanly; `reset()` zeroes `activeDebris` and `_blastLight.intensity`.
4. `node tests/vfx_test.mjs` exits `0` and prints `ALL VFX CHECKS PASSED`.
