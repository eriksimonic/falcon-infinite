// Headless acceptance tests for src/aircraft/cockpit.js — Feature 17.
// Run: node tests/cockpit_test.mjs
//
// Verifies the pure computeCockpitIndicators contract: AoA indexer state,
// master caution triggers, night backlight scaling and canopy rain opacity /
// scroll speed. Importing cockpit.js must not require a DOM.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeCockpitIndicators, createCockpit } from '../src/aircraft/cockpit.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const D2R = Math.PI / 180;
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function flight(over = {}) {
  return { aoa: 0, gearPos: 0, stall: false, speed: 0, onGround: false, ...over };
}

// ---------------------------------------------------------------------------
// 1. AoA indexer is dark with gear up or weight-on-wheels
// ---------------------------------------------------------------------------
{
  const gearUp = computeCockpitIndicators(flight({ aoa: 11.5 * D2R, gearPos: 0 }), {});
  ok(gearUp.aoaState === 'off', 'aoaState off when gear up', gearUp.aoaState);

  const onGround = computeCockpitIndicators(flight({ aoa: 2 * D2R, gearPos: 1, onGround: true }), {});
  ok(onGround.aoaState === 'off', 'aoaState off on ground even with gear down', onGround.aoaState);
}

// ---------------------------------------------------------------------------
// 2. AoA indexer fast / on-speed / slow bands (airborne, gear down)
// ---------------------------------------------------------------------------
{
  const aoaCase = (deg) => computeCockpitIndicators(
    flight({ aoa: deg * D2R, gearPos: 1, speed: 120 }), {},
  ).aoaState;
  ok(aoaCase(7) === 'fast', 'aoaState fast at 7 deg', aoaCase(7));
  ok(aoaCase(11.5) === 'onspeed', 'aoaState onspeed at 11.5 deg', aoaCase(11.5));
  ok(aoaCase(15) === 'slow', 'aoaState slow at 15 deg', aoaCase(15));
}

// ---------------------------------------------------------------------------
// 3. Master caution triggers and quiet cruise
// ---------------------------------------------------------------------------
{
  const base = flight({ gearPos: 1, speed: 200 });
  ok(computeCockpitIndicators({ ...base, stall: true }, {}).cautionActive === true, 'caution on stall');

  // 620 kts ≈ 318.96 m/s; 322 m/s ≈ 625.9 kts.
  const over = computeCockpitIndicators(flight({ gearPos: 1, speed: 322 }), {});
  ok(over.cautionActive === true, 'caution on overspeed > 620 kts', String(322 * 1.94384));

  ok(computeCockpitIndicators(base, { lowFuel: true }).cautionActive === true, 'caution on lowFuel');
  ok(computeCockpitIndicators(base, { rwrThreat: true }).cautionActive === true, 'caution on rwrThreat');
  ok(computeCockpitIndicators(base, { flameout: true }).cautionActive === true, 'caution on flameout');

  const cruise = computeCockpitIndicators(base, { night: 0.4, rain: 0.2 });
  ok(cruise.cautionActive === false, 'caution silent in normal cruise');
  ok(cruise.cautionFlash === false, 'cautionFlash false when inactive', String(cruise.cautionFlash));

  const flashing = computeCockpitIndicators({ ...base, stall: true }, { time: 0.4 });
  ok(typeof flashing.cautionFlash === 'boolean', 'cautionFlash boolean when active');
  ok(flashing.cautionFlash === (Math.sin(0.4 * 10) > -0.25), 'cautionFlash follows sin(time*10)');
}

// ---------------------------------------------------------------------------
// 4. Night backlighting increases monotonically with env.night
// ---------------------------------------------------------------------------
{
  let prevPanel = -Infinity;
  let prevFlood = -Infinity;
  let monotonicPanel = true;
  let monotonicFlood = true;
  const sample = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  for (const night of sample) {
    const ind = computeCockpitIndicators(flight({ gearPos: 1, speed: 120 }), { night });
    if (!(ind.panelEmissive > prevPanel)) monotonicPanel = false;
    if (!(ind.floodIntensity > prevFlood)) monotonicFlood = false;
    prevPanel = ind.panelEmissive;
    prevFlood = ind.floodIntensity;
  }
  ok(monotonicPanel, 'panelEmissive increases with night');
  ok(monotonicFlood, 'floodIntensity increases with night');

  const day = computeCockpitIndicators(flight(), { night: 0 });
  ok(close(day.panelEmissive, 0.7), 'panelEmissive base 0.7', String(day.panelEmissive));
  ok(close(day.floodIntensity, 1.6), 'floodIntensity base 1.6', String(day.floodIntensity));

  const full = computeCockpitIndicators(flight(), { night: 1 });
  ok(close(full.panelEmissive, 2.1), 'panelEmissive 2.1 at full night', String(full.panelEmissive));
  ok(close(full.floodIntensity, 4.0), 'floodIntensity 4.0 at full night', String(full.floodIntensity));

  const clamped = computeCockpitIndicators(flight(), { night: 3.5 });
  ok(close(clamped.panelEmissive, 2.1), 'panelEmissive clamps night above 1', String(clamped.panelEmissive));
  const negative = computeCockpitIndicators(flight(), { night: -2 });
  ok(close(negative.panelEmissive, 0.7), 'panelEmissive clamps night below 0', String(negative.panelEmissive));
}

// ---------------------------------------------------------------------------
// 5. Canopy rain opacity threshold and speed-dependent scroll
// ---------------------------------------------------------------------------
{
  ok(computeCockpitIndicators(flight({ speed: 150 }), { rain: 0 }).rainOpacity === 0, 'rainOpacity 0 when clear');
  ok(computeCockpitIndicators(flight({ speed: 150 }), { rain: 0.05 }).rainOpacity === 0, 'rainOpacity 0 at threshold 0.05');
  ok(computeCockpitIndicators(flight({ speed: 150 }), { rain: 0.4 }).rainOpacity > 0, 'rainOpacity positive in rain');
  ok(close(computeCockpitIndicators(flight(), { rain: 1 }).rainOpacity, 0.65), 'rainOpacity caps at 0.65');
  ok(computeCockpitIndicators(flight(), { rain: 1 }).rainOpacity <= 0.65, 'rainOpacity never above cap');

  const still = computeCockpitIndicators(flight({ speed: 0 }), {}).rainScrollSpeed;
  const slow = computeCockpitIndicators(flight({ speed: 100 }), {}).rainScrollSpeed;
  const fast = computeCockpitIndicators(flight({ speed: 300 }), {}).rainScrollSpeed;
  ok(close(still, 0.6), 'rainScrollSpeed baseline 0.6', String(still));
  ok(slow > still && fast > slow, 'rainScrollSpeed increases with airspeed', `${still}/${slow}/${fast}`);
  ok(computeCockpitIndicators(flight({ speed: 4000 }), {}).rainScrollSpeed === 4.1, 'rainScrollSpeed caps at 4.1');
}

// ---------------------------------------------------------------------------
// 6. Contract shape / headless safety
// ---------------------------------------------------------------------------
{
  const ind = computeCockpitIndicators(flight(), {});
  const keys = ['aoaState', 'cautionActive', 'cautionFlash', 'panelEmissive', 'floodIntensity', 'rainOpacity', 'rainScrollSpeed'];
  ok(keys.every((k) => k in ind), 'indicator object has all contract fields', Object.keys(ind).join(','));
  ok(typeof createCockpit === 'function', 'createCockpit still exported');

  const source = readFileSync(fileURLToPath(new URL('../src/aircraft/cockpit.js', import.meta.url)), 'utf8');
  for (const token of ['aoaUp', 'aoaMid', 'aoaDown', 'masterCaution', 'canopyRain', 'depthWrite: false']) {
    ok(source.includes(token), `cockpit.js wires ${token}`);
  }
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n${failures.length} cockpit check(s) FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error(`\n${checks - failures.length}/${checks} passed`);
  process.exit(1);
}

console.log(`ALL COCKPIT CHECKS PASSED (${checks} checks)`);
process.exit(0);