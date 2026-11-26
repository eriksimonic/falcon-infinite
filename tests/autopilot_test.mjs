// Autopilot & ILS acceptance tests (headless, no browser required).
//
// Control sign conventions under test (verified against flight.js / main.js):
//   cmd.pitch > 0  -> nose up.
//   cmd.roll  > 0  -> bank LEFT; flight.rollDeg is positive for a right bank.
import * as THREE from 'three';
import { FlightModel } from '../src/aircraft/flight.js';
import { AutopilotSystem, ILSComputer } from '../src/aircraft/autopilot.js';
import { events, on, off } from '../src/core/events.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// Flight stand-in matching the surface AutopilotSystem / ILSComputer consume.
function makeJet({
  x = 0, y = 3000, z = 0, heading = 0, pitch = 0, roll = 0,
  vs = 0, speed = 250, aoa = 0.05, onGround = false, stall = false, crashed = false, agl,
} = {}) {
  return {
    position: { x, y, z },
    heading,
    pitchDeg: pitch,
    rollDeg: roll,
    rates: { x: 0, y: 0, z: 0 },
    verticalSpeed: vs,
    speed,
    aoa,
    onGround,
    stall,
    crashed,
    agl,
  };
}

const neutral = () => ({ pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 });

// ------------------------------------------------------------------ 1. modes
{
  const ap = new AutopilotSystem();
  ok(ap.mode === 'OFF', 'autopilot starts OFF');
  ok(ap.targetAlt === 0 && ap.targetHeading === 0 && ap.targetPitch === 0 && ap.targetRoll === 0,
    'targets start at zero');

  const jet = makeJet({ y: 3200, heading: 75, pitch: 3.5, roll: -4 });
  ok(ap.cycleMode(jet) === 'ALT_HDG', 'OFF -> ALT_HDG');
  ok(ap.targetAlt === 3200, 'latches current altitude', String(ap.targetAlt));
  ok(Math.abs(ap.targetHeading - 75) < 1e-9, 'latches current heading', String(ap.targetHeading));
  ok(Math.abs(ap.targetPitch - 3.5) < 1e-9, 'latches current pitch', String(ap.targetPitch));
  ok(Math.abs(ap.targetRoll + 4) < 1e-9, 'latches current bank', String(ap.targetRoll));

  ok(ap.cycleMode(jet) === 'ATT', 'ALT_HDG -> ATT');
  ok(ap.cycleMode(jet) === 'OFF', 'ATT -> OFF');

  ap.disengage();
  ok(ap.mode === 'OFF', 'disengage leaves OFF');

  // Engagement is refused on the ground and in a stall / crash.
  ok(ap.cycleMode(makeJet({ onGround: true })) === 'OFF', 'refuses engagement on ground');
  ok(ap.cycleMode(makeJet({ stall: true })) === 'OFF', 'refuses engagement in a stall');
  ok(ap.cycleMode(makeJet({ crashed: true })) === 'OFF', 'refuses engagement after a crash');
  ok(ap.mode === 'OFF', 'refused engagement keeps mode OFF');
}

// ------------------------------------------- 2. command laws (stub airframe)
{
  const ap = new AutopilotSystem();
  const jet = makeJet({ y: 3000, heading: 0, pitch: 0, roll: 0 });
  ap.cycleMode(jet);

  // Climb command with altitude 200 m below target.
  ap.targetAlt = 3200;
  ap.targetHeading = 0;
  const base = neutral();
  const climb = ap.computeCommand(jet, base);
  ok(climb !== base, 'computeCommand returns a new object');
  ok(base.pitch === 0 && base.roll === 0, 'baseCmd is not mutated');
  ok(climb.pitch > 0, 'pitch command climbs toward target altitude', climb.pitch.toFixed(3));
  ok(climb.yaw === base.yaw && climb.throttleDelta === base.throttleDelta,
    'unrelated command channels pass through');

  // Repeated calls ramp the smoothed command up (FBW feel, no step jump).
  const climb2 = ap.computeCommand(jet, base);
  ok(climb2.pitch > climb.pitch && climb2.pitch <= 1, 'pitch command is smoothed/ramped',
    `${climb.pitch.toFixed(3)} -> ${climb2.pitch.toFixed(3)}`);

  // Descend command from above target (stub is trimmed at a realistic attitude).
  const apDown = new AutopilotSystem();
  apDown.cycleMode(makeJet({ y: 3000, pitch: 3 }));
  apDown.targetAlt = 2600;
  const down = apDown.computeCommand(makeJet({ y: 3000, pitch: 3 }), neutral());
  ok(down.pitch < 0, 'pitch command descends toward a lower altitude', down.pitch.toFixed(3));

  // Roll toward a target heading to the right: bank right = negative stick roll.
  const apRight = new AutopilotSystem();
  apRight.cycleMode(makeJet({ heading: 0 }));
  apRight.targetHeading = 30;
  const right = apRight.computeCommand(makeJet({ heading: 0, roll: 0 }), neutral());
  ok(right.roll < -0.05, 'banks right toward a heading to the right', right.roll.toFixed(3));

  // ... and to the left for a target heading to the left.
  const apLeft = new AutopilotSystem();
  apLeft.cycleMode(makeJet({ heading: 0 }));
  apLeft.targetHeading = 330;
  const left = apLeft.computeCommand(makeJet({ heading: 0, roll: 0 }), neutral());
  ok(left.roll > 0.05, 'banks left toward a heading to the left', left.roll.toFixed(3));

  // Commands always stay inside [-1, 1].
  const extreme = makeJet({ y: 20000, heading: 180, pitch: -30, roll: 60 });
  const apX = new AutopilotSystem();
  apX.cycleMode(extreme);
  apX.targetAlt = 100;
  apX.targetHeading = 0;
  const ex = apX.computeCommand(extreme, neutral());
  ok(Math.abs(ex.pitch) <= 1 && Math.abs(ex.roll) <= 1, 'commands clamped to [-1, 1]',
    `p=${ex.pitch.toFixed(2)} r=${ex.roll.toFixed(2)}`);

  // ATT holds latched-ish attitudes directly.
  const apAtt = new AutopilotSystem();
  const attJet = makeJet({ y: 4000, heading: 10, pitch: 1, roll: 0 });
  apAtt.cycleMode(attJet); // ALT_HDG
  apAtt.cycleMode(attJet); // ATT, re-latches current attitude
  apAtt.targetPitch = 6;
  apAtt.targetRoll = 12;
  const attOut = apAtt.computeCommand(attJet, neutral());
  ok(attOut.pitch > 0, 'ATT commands nose-up pitch', attOut.pitch.toFixed(3));
  ok(attOut.roll < 0, 'ATT commands a right bank (negative stick roll)', attOut.roll.toFixed(3));
  apAtt.targetPitch = -6;
  apAtt.targetRoll = -12;
  const attOut2 = apAtt.computeCommand(attJet, neutral());
  ok(attOut2.pitch < 0 && attOut2.roll > 0, 'ATT follows opposite targets',
    `p=${attOut2.pitch.toFixed(3)} r=${attOut2.roll.toFixed(3)}`);
}

// ------------------------------- 3. manual override, stall, abnormal states
{
  // Strong manual stick input clicks the autopilot off and returns baseCmd as-is.
  for (const key of ['pitch', 'roll']) {
    const ap = new AutopilotSystem();
    const jet = makeJet({ heading: 0 });
    ap.cycleMode(jet);
    const base = neutral();
    base[key] = 0.6;
    const out = ap.computeCommand(jet, base);
    ok(out === base, `strong manual ${key} returns baseCmd unchanged`);
    ok(ap.mode === 'OFF', `strong manual ${key} disengages`);
    const after = ap.computeCommand(jet, neutral());
    ok(after === undefined || after, 'manual input path is safe');
  }

  // Gentle stick input (below 0.35) is still overridden by the autopilot.
  const apG = new AutopilotSystem();
  apG.cycleMode(makeJet({ heading: 0 }));
  const gentle = neutral();
  gentle.pitch = 0.2;
  const gOut = apG.computeCommand(makeJet({ heading: 0 }), gentle);
  ok(apG.mode === 'ALT_HDG', 'gentle stick input does not disengage');
  ok(gOut.pitch !== 0.2, 'autopilot overrides gentle stick input');

  // Stall in flight auto-disengages and passes the pilot's command through.
  const apS = new AutopilotSystem();
  apS.cycleMode(makeJet({ heading: 0 }));
  const stallJet = makeJet({ heading: 0, stall: true });
  const sb = neutral();
  const sOut = apS.computeCommand(stallJet, sb);
  ok(sOut === sb, 'stall returns baseCmd unchanged');
  ok(apS.mode === 'OFF', 'stall auto-disengages');

  // Ground contact / crash auto-disengage too.
  const apGr = new AutopilotSystem();
  apGr.cycleMode(makeJet({ heading: 0 }));
  apGr.computeCommand(makeJet({ onGround: true }), neutral());
  ok(apGr.mode === 'OFF', 'ground contact auto-disengages');
  const apC = new AutopilotSystem();
  apC.cycleMode(makeJet({ heading: 0 }));
  apC.computeCommand(makeJet({ crashed: true }), neutral());
  ok(apC.mode === 'OFF', 'crash auto-disengages');

  // Already OFF: the pilot command passes straight through.
  const apOff = new AutopilotSystem();
  const b = neutral();
  ok(apOff.computeCommand(makeJet(), b) === b, 'OFF passes baseCmd through');
}

// --------------------------- 4. closed-loop flight with the real FlightModel
{
  const world = { heightAt: () => 0, slopeAt: () => 0 };
  const weather = {
    windAt: (x, z, a, out) => { out.set(0, 0, 0); return out; },
    state: { turbulence: 0 },
  };
  const base = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0, gearToggle: false, flapsToggle: false, brake: false };

  const f = new FlightModel();
  f.reset({ x: 0, y: 2000, z: 0, heading: 0 });
  f.onGround = false;
  f.throttle = 0.7;
  f.targetThrottle = 0.7;
  f.velocity.set(0, 0, -250);

  const ap = new AutopilotSystem();
  ok(ap.cycleMode(f) === 'ALT_HDG', 'engages ALT_HDG in flight with FlightModel');
  ap.targetAlt = 2200;
  ap.targetHeading = 30;

  let maxCmd = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 90; i++) {
    const cmd = ap.computeCommand(f, base);
    maxCmd = Math.max(maxCmd, Math.abs(cmd.pitch), Math.abs(cmd.roll));
    f.update(dt, cmd, world, weather);
  }
  ok(Math.abs(wrap180(30 - f.heading)) < 5, 'holds the commanded heading in flight',
    `err ${wrap180(30 - f.heading).toFixed(2)}°`);
  ok(Math.abs(f.position.y - 2200) < 80, 'holds the commanded altitude in flight',
    `${f.position.y.toFixed(0)} m vs 2200 m`);
  ok(!f.stall && !f.crashed, 'autopilot flight stays inside the envelope');
  ok(ap.mode === 'ALT_HDG', 'stays engaged while flying normally');
  ok(maxCmd <= 1, 'closed-loop commands stay within [-1, 1]', maxCmd.toFixed(3));

  const override = { ...base, pitch: 0.8 };
  ok(ap.computeCommand(f, override) === override, 'pilot override in flight returns baseCmd');
  ok(ap.mode === 'OFF', 'pilot override in flight disengages');
}

// ------------------------------------------------------ 5. ILS geometry
const ap = {
  id: 'test:0', x: 0, z: 0, elevation: 100, heading: 90,
  length: 3000, width: 45, code: 'TEST', name: 'Test Regional',
};
const gsAlt = (d) => 100 + d * Math.tan(3 * Math.PI / 180);

function ilsFlight(x, z, y, heading = 90, onGround = false, agl) {
  return { position: { x, y, z }, heading, onGround, crashed: false, agl };
}

{
  const ils = new ILSComputer();
  ok(ils.active === false && ils.locDev === 0 && ils.gsDev === 0, 'ILS starts inactive');

  // Threshold for a RWY 09 approach sits 1500 m west of the runway centre.
  ils.update(1 / 60, ilsFlight(-4000, 0, 300), ap);
  ok(ils.active === true, 'ILS active on a 4 km final');
  ok(Math.abs(ils.threshold.x + 1500) < 0.01 && Math.abs(ils.threshold.z) < 0.01,
    'threshold lies at the near runway end', `${ils.threshold.x}, ${ils.threshold.z}`);
  ok(ils.runwayLabel === 'RWY 09', 'runway label derived from heading', ils.runwayLabel);
  ok(Math.abs(ils.distNm - 2500 / 1852) < 1e-6, 'distance to threshold in NM', ils.distNm.toFixed(3));
  ok(Math.abs(ils.locDev) < 1e-6, 'on-centreline localizer is zero', ils.locDev.toFixed(4));

  // Left of the RWY 09 centreline (north is -Z, so -Z is left here) -> fly right.
  ils.update(1 / 60, ilsFlight(-4000, -200, 300), ap);
  ok(ils.locDev > 0.5, 'aircraft left of centreline -> fly right (+locDev)', ils.locDev.toFixed(3));
  ils.update(1 / 60, ilsFlight(-4000, 200, 300), ap);
  ok(ils.locDev < -0.5, 'aircraft right of centreline -> fly left (-locDev)', ils.locDev.toFixed(3));

  // Full-scale deflection clamps at ±1.
  ils.update(1 / 60, ilsFlight(-3000, -900, 300), ap);
  ok(ils.locDev === 1, 'localizer saturates at +1', ils.locDev.toFixed(3));
  ils.update(1 / 60, ilsFlight(-3000, 900, 300), ap);
  ok(ils.locDev === -1, 'localizer saturates at -1', ils.locDev.toFixed(3));

  // Glideslope: exact 3° path is zero; above gives fly-down, below gives fly-up.
  ils.update(1 / 60, ilsFlight(-4500, 0, gsAlt(3000)), ap);
  ok(Math.abs(ils.gsDev) < 0.01, 'on the 3° glideslope -> zero deviation', ils.gsDev.toFixed(4));
  ils.update(1 / 60, ilsFlight(-4500, 0, gsAlt(3000) + 40), ap);
  ok(ils.gsDev < -0.5, 'above glideslope -> fly down (-gsDev)', ils.gsDev.toFixed(3));
  ils.update(1 / 60, ilsFlight(-4500, 0, gsAlt(3000) - 40), ap);
  ok(ils.gsDev > 0.5, 'below glideslope -> fly up (+gsDev)', ils.gsDev.toFixed(3));

  // Reciprocal end selection: landing to the west uses RWY 27 and the east threshold.
  ils.update(1 / 60, ilsFlight(4500, 0, gsAlt(3000), 270), ap);
  ok(ils.active === true, 'ILS active for the reciprocal runway');
  ok(ils.runwayLabel === 'RWY 27', 'reciprocal runway label', ils.runwayLabel);
  ok(Math.abs(ils.threshold.x - 1500) < 0.01, 'reciprocal threshold at the far end',
    String(ils.threshold.x));
  ok(Math.abs(ils.distNm - 3000 / 1852) < 1e-6, 'reciprocal distance in NM', ils.distNm.toFixed(3));

  // Inactive conditions: too far, off the approach side, on the ground.
  ils.update(1 / 60, ilsFlight(-20000, 0, 300), ap);
  ok(ils.active === false, 'inactive beyond 18 km');
  ils.update(1 / 60, ilsFlight(-3000, -3000, 300), ap);
  ok(ils.active === false, 'inactive more than 45° off centreline');
  ils.update(1 / 60, ilsFlight(2000, 0, 300), ap);
  ok(ils.active === false, 'inactive past the threshold');
  ils.update(1 / 60, ilsFlight(-4000, 0, 300, 90, true), ap);
  ok(ils.active === false, 'inactive on the ground');

  // Null airport clears the computer.
  ils.update(1 / 60, ilsFlight(-4000, 0, 300), null);
  ok(ils.active === false && ils.airport === null && ils.runwayLabel === '',
    'null airport clears the ILS');
}

// ------------------------------------------- 6. radar-altitude callouts
{
  const ils = new ILSComputer();
  const seen = [];
  const listener = (e) => seen.push(e);
  on('ils:callout', listener);

  const descend = (fromM, toM, step = 1, xPos = -4000) => {
    for (let agl = fromM; agl >= toM; agl -= step) {
      const fl = ilsFlight(xPos, 0, 100 + agl, 90, false, agl);
      ils.update(1 / 60, fl, ap);
    }
  };

  // Start high (re-arms), then fly a normal approach to touchdown.
  ils.update(1 / 60, ilsFlight(-4000, 0, 400, 90, false, 300), ap);
  descend(250, 0, 1);
  const labels = seen.map((e) => e.callout);
  ok(labels.join(',') === '500,200,MINIMUMS,100,50',
    'callouts fire in descending order', labels.join(','));
  ok(new Set(labels).size === labels.length, 'each callout fires exactly once');

  const first = seen[0];
  ok(first.text === 'Five hundred' && first.callout === '500'
     && first.aglFt >= 495 && first.aglFt <= 500,
    '500 ft callout payload', `${first.text} @ ${first.aglFt}`);
  ok(first.runwayLabel === 'RWY 09' && first.airportCode === 'TEST',
    'callout carries runway/airport context');
  const min = seen.find((e) => e.callout === 'MINIMUMS');
  ok(!!min && min.text === 'Minimums', 'minimums callout speaks "Minimums"');

  const before = seen.length;
  descend(0, 0, 1);
  ok(seen.length === before, 'no duplicate callouts at the same altitude');

  // Climbing above 220 m AGL re-arms the sequence for another approach.
  ils.update(1 / 60, ilsFlight(-4000, 0, 400, 90, false, 250), ap);
  descend(250, 0, 1);
  ok(seen.length === before + 5, 'go-around above 220 m AGL re-arms all callouts',
    `${seen.length - before} new callouts`);

  // Touchdown, then a departure climb outside the approach cone, re-arms too.
  const landed = seen.length;
  ils.update(1 / 60, ilsFlight(-1000, 0, 100, 90, true, 0), ap);
  ok(ils.active === false, 'ILS inactive after touchdown');
  const climbOut = seen.length;
  ils.update(1 / 60, ilsFlight(2000, 0, 350, 90, false, 250), ap);
  ok(ils.active === false, 'climb-out past the threshold is not an approach');
  descend(250, 0, 1);
  ok(seen.length === climbOut + 5, 'landing + climb-out re-arms a fresh callout sequence',
    `${seen.length - climbOut} new callouts (${landed} before landing)`);

  off('ils:callout', listener);
  events.clear();
}

// ---------------------------------------------------- 7. touchdown grading
{
  const ils = new ILSComputer();

  const butter = ils.gradeTouchdown(1.0, 2);
  ok(butter.grade === 'BUTTER' && butter.color === 'green', 'gentle touchdown is BUTTER');
  ok(butter.fpm === 197, 'impact converted to ft/min', String(butter.fpm));

  const butterEdge = ils.gradeTouchdown(1.0, 8);
  ok(butterEdge.grade === 'SMOOTH', 'excess bank downgrades BUTTER to SMOOTH');

  const smooth = ils.gradeTouchdown(1.4, 0);
  ok(smooth.grade === 'SMOOTH' && smooth.color === 'green', '1.4 m/s is SMOOTH', smooth.fpm + ' fpm');

  const firm = ils.gradeTouchdown(2.0, 1);
  ok(firm.grade === 'SMOOTH', '2.0 m/s still SMOOTH');
  const firm2 = ils.gradeTouchdown(3.0, 0);
  ok(firm2.grade === 'FIRM' && firm2.color === 'amber', '3.0 m/s is FIRM', firm2.fpm + ' fpm');
  ok(firm2.fpm === 591, 'FIRM fpm conversion', String(firm2.fpm));

  const hard = ils.gradeTouchdown(4.8, 0);
  ok(hard.grade === 'HARD' && hard.color === 'red', '4.8 m/s is HARD');
  const harder = ils.gradeTouchdown(7.5, 12);
  ok(harder.grade === 'HARD' && harder.fpm === 1476, 'heavy arrival is HARD', String(harder.fpm));

  // Negative / malformed inputs are handled like zero.
  const zero = ils.gradeTouchdown(-1, NaN);
  ok(zero.grade === 'BUTTER' && zero.fpm === 0, 'non-finite / negative impact treated as zero');
}

// ---------------------------------------------------------------- summary
console.log(`autopilot checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL AUTOPILOT CHECKS PASSED');