# Feature 24 — Mega-Blast VFX, Building Fire Puffs, BFFG HUD & Mega-Detonation Audio

## Goal
Make the **BFFG** mega-ordnance and burning/collapsing buildings look, read, and sound unforgettable!

## File Ownership (STRICT)
Modify ONLY:
- `src/sim/vfx.js`
- `src/ui/tactical.js`
- `src/core/combat_audio.js`
- `tests/vfx_test.mjs`
- `tests/tactical_test.mjs`

Do NOT modify any other files.

## Required Changes

### 1. `src/sim/vfx.js` — Mega-Blast Scaling & Building Fire Puffs
- In `spawnExplosion(pos, scale = 1)`:
  - When `s >= 10` (i.e. `BFFG` mega-blast at `scale = 14`):
    - Set `slot.duration = 8.5` (lingering apocalyptic mushroom cloud!).
    - Emit `32`–`40` high-velocity hot sparks and `26` dense initial fireball/mushroom smoke puffs (including bright fiery orange-gold and cyan-white plasma flash puffs!).
    - Keep `core` and `fireball` visible for `2.8 s` and `ring` expanding for `2.2 s` (`scale * 24` -> **~336 m** shockwave ring!).
    - Normal-sized blasts (`s < 10`) keep exact Feature 21 timing (`5.5 s`, `1.8 s`, `1.35 s`).
- Add `spawnFirePuff(pos, scale = 1)` on `CombatVFX`:
  - Headless-safe, zero allocations (writes into existing `this.puffs` pool).
  - Emits 1 bright flickering flame puff (`0xff6e1a` / `0xffb43a`, short life `0.6–1.1 s`, rising fast) + 1 thick dark smoke puff (`0x1e1d1c`, longer life `2.8–4.5 s`, rising & drifting with wind).

### 2. `src/ui/tactical.js` — BFFG HUD Reticle & Weapon Strip
- In `_drawWeaponStrip`: include `'BFFG'` alongside `GUN`, `AIM9`, `MK82` (showing `BFFG` with remaining count, highlighted in bright cyan `#5cf6ff` / amber when selected!).
- In `_drawWeapons`: when `selected === 'BFFG'` and `ccip && ccip.valid`:
  - Project `ccip` (and clamp with Delayed-CCIP cue if below screen bottom, just like `MK82`), drawing a bold double-ring cyan/amber **BFFG BLAST RETICLE** with crosshairs and `BFFG-9000 · DANGER` label!

### 3. `src/core/combat_audio.js` — BFFG Launch & Mega-Detonation Audio
- Add `bffgFire()`:
  - Plays a dramatic low-end plasma/thermobaric launch thump (`140 -> 38 Hz` sine/saw drop + filtered broadband whoosh + high-energy crackle burst, plus layered `missile_launch` sample if loaded at lower pitch `rate: 0.65`).
- Add `megaExplosion(distanceM = 150)`:
  - Colossal thermobaric bass-drop detonation: `att = clamp(1 / (1 + d / 3200), 0.35, 1.0)` so even from 5+ km away it hits with chest-rattling weight!
  - Plays `explosion_lg` sample at deep pitch (`rate: 0.62`, `gain: 1.15 * att`) + layered sub-bass shockwave oscillator (`44 -> 16 Hz` over `2.6 s`, `gain: 0.55 * att`) + rolling filtered rumble noise (`2.8 s`).

## Verification
- `tests/vfx_test.mjs`: add checks for `spawnExplosion(pos, 14)` (`duration >= 8`, active past `2.4 s`, rich particle burst `>= 50`) and `spawnFirePuff(pos, 1.2)` (adds puffs cleanly, zero errors headless).
- `tests/tactical_test.mjs`: add checks for `TacticalOverlay.draw()` with `weapons.selected = 'BFFG'` (renders without error), and `CombatAudio.bffgFire()` + `CombatAudio.megaExplosion(3000)` (audible peak `> 0.25`).
- Both `node tests/vfx_test.mjs` and `node tests/tactical_test.mjs` must exit `0`.
