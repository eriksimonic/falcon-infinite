// Autopilot & ILS acceptance tests (headless, no browser required).
//
// Control sign conventions under test (verified against flight.js / main.js):
//   cmd.pitch > 0  -> nose up.
//   cmd.roll  > 0  -> bank LEFT; flight.rollDeg is positive for a right bank.
import * as THREE from 'three';
import { FlightModel } from '../src/aircraft/flight.js';
import { AutopilotSystem, ILSComputer } from '../src/aircraft/autopilot.js';
import { events, on, off } from '../src/core/events.js';
import { TankerSystem, FuelSystem } from '../src/sim/fuel.js';

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

// ------------------------------------- 8. smart auto-land (press-and-hold H)
{
  const landAp = {
    x: 0, z: 0, elevation: 100, heading: 90, length: 3000, width: 45,
    code: 'LJAJ', name: 'Ajdovščina',
  };
  const ground = () => 0;
  const apClamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const apNorm = (d) => ((d % 360) + 360) % 360;

  // Simple rate-command airframe, just enough to close the loops in Node.
  function kinematicJet({ x, y, z, heading, speed = 170 }) {
    return {
      position: { x, y, z },
      heading,
      speed,
      pitchDeg: 0,
      rollDeg: 0,
      rates: { x: 0, y: 0, z: 0 },
      verticalSpeed: 0,
      aoa: 0.05,
      throttle: 0.5,
      targetThrottle: 0.5,
      onGround: false,
      stall: false,
      crashed: false,
      gearDown: false,
      flapsIndex: 0,
      brake: false,
      agl: y,
      step(dt, cmd) {
        const rad = Math.PI / 180;
        const pitchRate = (cmd.pitch || 0) * 45;    // deg/s, + nose up
        const rollRate = -(cmd.roll || 0) * 120;    // deg/s, + right bank
        this.rates.x = pitchRate * rad;
        this.rates.z = rollRate * rad;
        this.pitchDeg = apClamp(this.pitchDeg + pitchRate * dt, -30, 30);
        this.rollDeg = apClamp(this.rollDeg + rollRate * dt, -70, 70);
        const turn = (9.81 / Math.max(60, this.speed)) * Math.tan(this.rollDeg * rad) * (180 / Math.PI);
        this.heading = apNorm(this.heading + turn * dt);
        this.verticalSpeed = this.speed * Math.sin((this.pitchDeg - this.aoa * (180 / Math.PI)) * rad);
        this.position.y += this.verticalSpeed * dt;
        this.position.x += Math.sin(this.heading * rad) * this.speed * dt;
        this.position.z += -Math.cos(this.heading * rad) * this.speed * dt;
        this.throttle += ((this.targetThrottle ?? this.throttle) - this.throttle) * Math.min(1, dt * 3);
        this.speed = Math.max(0, this.speed + apClamp((this.throttle - 0.45) * 30, -12, 12) * dt);
      },
    };
  }

  // Engagement guards.
  const guard = new AutopilotSystem();
  ok(guard.engageAutoLand(null, landAp) === false, 'auto-land refuses a null jet');
  ok(guard.engageAutoLand(makeJet({ crashed: true }), landAp) === false,
    'auto-land refuses a crashed jet');
  ok(guard.engageAutoLand(makeJet(), null) === false, 'auto-land refuses without an airport');
  ok(guard.mode === 'OFF' && guard.phase === '', 'refused auto-land changes nothing');
  ok(guard.consumeNotice() === null, 'no completion notice before a flight');

  const air = makeJet({ x: -14000, y: 1200, z: 0, heading: 90, speed: 180 });
  const apLand = new AutopilotSystem();
  ok(apLand.engageAutoLand(air, landAp) === true, 'auto-land engages in the air');
  ok(apLand.mode === 'AUTO_LAND', 'auto-land sets the AUTO_LAND mode');
  ok(apLand.phase === 'INTERCEPT', 'auto-land starts in INTERCEPT');
  ok(apLand.targetLabel === 'LJAJ', 'auto-land latches the airport code');

  const desc = apLand.computeCommand(air, neutral(), { airport: landAp, terrainHeight: ground });
  ok(desc !== undefined && desc.pitch < 0, 'INTERCEPT descends toward the approach gate',
    desc && desc.pitch.toFixed(3));

  // Terrain clearance: a 1500 m ridge must push the gate (and the jet) up.
  const ridgeJet = makeJet({ x: -14000, y: 1600, z: 0, heading: 90, speed: 180 });
  const ridgeAp = new AutopilotSystem();
  ridgeAp.engageAutoLand(ridgeJet, landAp);
  const ridge = ridgeAp.computeCommand(ridgeJet, neutral(), {
    airport: landAp,
    terrainHeight: () => 1500,
  });
  ok(ridge.pitch > 0, 'INTERCEPT climbs above a 1500 m terrain ridge', ridge.pitch.toFixed(3));

  // Stable final: gear and flaps deploy, throttle targets 78 m/s on-speed.
  const finalJet = makeJet({ x: -7500, y: 600, z: 0, heading: 90, speed: 130 });
  finalJet.gearDown = false;
  finalJet.flapsIndex = 0;
  finalJet.targetThrottle = 0.5;
  const apFinal = new AutopilotSystem();
  apFinal.engageAutoLand(finalJet, landAp);
  const fin = apFinal.computeCommand(finalJet, neutral(), { airport: landAp, terrainHeight: ground });
  ok(apFinal.phase === 'FINAL', '6 km final is recognised', apFinal.phase);
  ok(finalJet.gearDown === true, 'final deploys the gear inside 6.5 km');
  ok(finalJet.flapsIndex === 2, 'final selects flaps 2 inside 6.5 km');
  ok(fin.pitch < 0, 'final commands a descent on the 3.2° path', fin.pitch.toFixed(3));
  ok(finalJet.targetThrottle >= 0.04 && finalJet.targetThrottle <= 0.92,
    'final autothrottle stays in range', finalJet.targetThrottle.toFixed(2));

  // Lateral intercept: right of centreline steers left (positive stick roll).
  const latJet = makeJet({ x: -7500, y: 600, z: 800, heading: 90, speed: 130 });
  const apLat = new AutopilotSystem();
  apLat.engageAutoLand(latJet, landAp);
  const lat = apLat.computeCommand(latJet, neutral(), { airport: landAp, terrainHeight: ground });
  ok(apLat.phase === 'FINAL', 'lateral offset still inside the final gate', apLat.phase);
  ok(lat.roll > 0, 'right of centreline commands a left bank', lat.roll.toFixed(3));

  // Flare: below 18 m AGL inside 1.6 km, nose up and idle.
  const flareJet = makeJet({ x: -1800, y: 115, z: 0, heading: 90, speed: 78, agl: 15 });
  flareJet.gearDown = false;
  flareJet.flapsIndex = 0;
  flareJet.targetThrottle = 0.5;
  const apFlare = new AutopilotSystem();
  apFlare.engageAutoLand(flareJet, landAp);
  const flare = apFlare.computeCommand(flareJet, neutral(), { airport: landAp, terrainHeight: ground });
  ok(apFlare.phase === 'FLARE', 'low AGL on short final enters FLARE', apFlare.phase);
  ok(flare.pitch > 0, 'flare raises the nose', flare.pitch.toFixed(3));
  ok(flareJet.targetThrottle === 0.03, 'flare pulls the throttle to idle');
  ok(flareJet.gearDown === true && flareJet.flapsIndex === 2,
    'flare keeps gear down and flaps 2');

  // Rollout: aerobrake above 72 m/s, wheel brakes below, rudder-align.
  const rollJet = makeJet({ x: -1000, y: 100, z: 0, heading: 80, speed: 80, onGround: true });
  rollJet.brake = false;
  rollJet.targetThrottle = 0.8;
  rollJet.gearDown = false;
  const apRoll = new AutopilotSystem();
  ok(apRoll.engageAutoLand(rollJet, landAp) === true, 'auto-land engages on the ground');
  ok(apRoll.phase === 'ROLLOUT', 'ground engagement starts at ROLLOUT');
  let rollOut;
  for (let i = 0; i < 40; i++) {
    rollOut = apRoll.computeCommand(rollJet, neutral(), { airport: landAp, terrainHeight: ground });
  }
  ok(apRoll.mode === 'AUTO_LAND', 'rollout does not disengage on ground contact');
  ok(rollJet.targetThrottle === 0, 'rollout closes the throttle');
  ok(rollJet.gearDown === true, 'rollout forces the gear down');
  ok(rollJet.brake === false, 'aerobrake above 72 m/s (no wheel brakes)');
  ok(rollOut.yaw < 0, 'rollout rudder aligns left toward runway heading', rollOut.yaw.toFixed(3));
  ok(rollOut.pitch > 0, 'rollout holds a slight nose-up attitude', rollOut.pitch.toFixed(3));

  rollJet.speed = 70;
  apRoll.computeCommand(rollJet, neutral(), { airport: landAp, terrainHeight: ground });
  ok(rollJet.brake === true, 'wheel brakes below 72 m/s');

  rollJet.speed = 2.5;
  const done = apRoll.computeCommand(rollJet, neutral(), { airport: landAp, terrainHeight: ground });
  ok(apRoll.mode === 'OFF', 'rollout completes and disengages');
  const notice = apRoll.consumeNotice();
  ok(notice === 'AUTO-LAND COMPLETE · LJAJ', 'auto-land posts a clean completion notice',
    String(notice));
  ok(apRoll.consumeNotice() === null, 'completion notice is consumed once');
  ok(done !== undefined, 'completion frame returns safely');

  // Manual stick always wins, even in AUTO_LAND.
  const ovJet = makeJet({ x: -14000, y: 1200, z: 0, heading: 90, speed: 180 });
  const apOv = new AutopilotSystem();
  apOv.engageAutoLand(ovJet, landAp);
  const ovBase = neutral();
  ovBase.pitch = 0.6;
  ok(apOv.computeCommand(ovJet, ovBase, { airport: landAp }) === ovBase,
    'stick override in AUTO_LAND returns baseCmd');
  ok(apOv.mode === 'OFF', 'stick override disengages AUTO_LAND');

  // Closed-loop approach: INTERCEPT -> FINAL -> FLARE -> rollout.
  const sim = kinematicJet({ x: -14000, y: 1200, z: 0, heading: 90, speed: 180 });
  const apSim = new AutopilotSystem();
  apSim.engageAutoLand(sim, landAp);
  const seen = new Set();
  let gearSeen = false;
  let flapsSeen = false;
  const ctx = { airport: landAp, terrainHeight: ground };
  for (let i = 0; i < 60 * 130; i++) {
    sim.agl = sim.position.y - landAp.elevation;
    const cmd = apSim.computeCommand(sim, neutral(), ctx);
    seen.add(apSim.phase);
    gearSeen = gearSeen || sim.gearDown;
    flapsSeen = flapsSeen || sim.flapsIndex === 2;
    sim.step(1 / 60, cmd);
    if (Math.hypot(sim.position.x + 1500, sim.position.z) < 120) {
      sim.onGround = true;
      sim.position.y = landAp.elevation;
      sim.speed = 75;
      break;
    }
  }
  ok(seen.has('INTERCEPT'), 'closed-loop approach starts in INTERCEPT');
  ok(seen.has('FINAL'), 'closed-loop approach captures FINAL');
  ok(seen.has('FLARE'), 'closed-loop approach flares before touchdown');
  ok(gearSeen && flapsSeen, 'closed-loop approach auto-configures gear and flaps');
  ok(Math.abs(sim.position.z) < 300, 'closed-loop approach tracks the centreline',
    sim.position.z.toFixed(0) + ' m');

  let landed = false;
  for (let i = 0; i < 60 * 120; i++) {
    apSim.computeCommand(sim, neutral(), ctx);
    sim.speed = Math.max(0, sim.speed - 1.0);
    if (apSim.mode === 'OFF') { landed = true; break; }
  }
  ok(landed, 'closed-loop rollout brings the jet to a stop and disengages');
  ok(String(apSim.consumeNotice()).startsWith('AUTO-LAND COMPLETE'),
    'closed-loop rollout posts a completion notice');
}

// ---------------------------------- 9. smart auto-refuel (press-and-hold H)
{
  const apClamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const apNorm = (d) => ((d % 360) + 360) % 360;

  function kinematicJet({ x, y, z, heading, speed = 170 }) {
    return {
      position: { x, y, z },
      heading,
      speed,
      pitchDeg: 0,
      rollDeg: 0,
      rates: { x: 0, y: 0, z: 0 },
      verticalSpeed: 0,
      aoa: 0.05,
      throttle: 0.5,
      targetThrottle: 0.5,
      onGround: false,
      stall: false,
      crashed: false,
      gearDown: false,
      flapsIndex: 0,
      brake: false,
      agl: y,
      step(dt, cmd) {
        const rad = Math.PI / 180;
        const pitchRate = (cmd.pitch || 0) * 45;
        const rollRate = -(cmd.roll || 0) * 120;
        this.rates.x = pitchRate * rad;
        this.rates.z = rollRate * rad;
        this.pitchDeg = apClamp(this.pitchDeg + pitchRate * dt, -30, 30);
        this.rollDeg = apClamp(this.rollDeg + rollRate * dt, -70, 70);
        const turn = (9.81 / Math.max(60, this.speed)) * Math.tan(this.rollDeg * rad) * (180 / Math.PI);
        this.heading = apNorm(this.heading + turn * dt);
        this.verticalSpeed = this.speed * Math.sin((this.pitchDeg - this.aoa * (180 / Math.PI)) * rad);
        this.position.y += this.verticalSpeed * dt;
        this.position.x += Math.sin(this.heading * rad) * this.speed * dt;
        this.position.z += -Math.cos(this.heading * rad) * this.speed * dt;
        this.throttle += ((this.targetThrottle ?? this.throttle) - this.throttle) * Math.min(1, dt * 3);
        this.speed = Math.max(0, this.speed + apClamp((this.throttle - 0.45) * 30, -12, 12) * dt);
      },
    };
  }

  const tanker = () => ({
    position: { x: 0, y: 3000, z: 0 },
    velocity: { x: 0, y: 0, z: -165 },
    heading: 0,
    speed: 165,
  });
  const tankCtx = (t, fuel) => ({ tanker: t, fuel, terrainHeight: () => 0 });

  // Engagement guards.
  const guard = new AutopilotSystem();
  ok(guard.engageAutoRefuel(null, tanker()) === false, 'auto-refuel refuses a null jet');
  ok(guard.engageAutoRefuel(makeJet({ onGround: true }), tanker()) === false,
    'auto-refuel refuses an aircraft on the ground');
  ok(guard.engageAutoRefuel(makeJet({ crashed: true }), tanker()) === false,
    'auto-refuel refuses a crashed jet');
  ok(guard.engageAutoRefuel(makeJet(), null) === false, 'auto-refuel refuses without a tanker');
  ok(guard.mode === 'OFF', 'refused auto-refuel leaves the autopilot OFF');

  const joinJet = makeJet({ x: 0, y: 3000, z: 3000, heading: 0, speed: 220 });
  const apJoin = new AutopilotSystem();
  ok(apJoin.engageAutoRefuel(joinJet, tanker()) === true, 'auto-refuel engages in the air');
  ok(apJoin.mode === 'AUTO_REFUEL' && apJoin.phase === 'RENDEZVOUS',
    'auto-refuel starts in RENDEZVOUS');
  ok(apJoin.targetLabel === 'KC-135', 'auto-refuel labels the tanker');

  // Rendezvous: fast closure speed and gear/flaps clean.
  const rv = apJoin.computeCommand(joinJet, neutral(), tankCtx(tanker(), { fraction: 0.5 }));
  ok(apJoin.phase === 'RENDEZVOUS', '3 km behind the tanker is a rendezvous');
  ok(joinJet.targetThrottle > 0.6, 'rendezvous commands a high closure throttle',
    joinJet.targetThrottle.toFixed(2));
  ok(joinJet.gearDown === false && joinJet.flapsIndex === 0, 'auto-refuel keeps the jet clean');

  // Join: inside 750 m, closing gently on the boom.
  const jJet = makeJet({ x: 0, y: 3000, z: 400, heading: 0, speed: 200 });
  const apJo = new AutopilotSystem();
  apJo.engageAutoRefuel(jJet, tanker());
  apJo.computeCommand(jJet, neutral(), tankCtx(tanker(), { fraction: 0.5 }));
  ok(apJo.phase === 'JOIN', '400 m behind the tanker is JOIN', apJo.phase);
  ok(jJet.targetThrottle < 0.5, 'join eases the throttle toward tanker speed',
    jJet.targetThrottle.toFixed(2));

  // Contact: exactly on the boom target, lateral correction right -> stick left.
  const cJet = makeJet({ x: 5, y: 2991, z: 22, heading: 0, speed: 165 });
  const apC = new AutopilotSystem();
  apC.engageAutoRefuel(cJet, tanker());
  const contactCmd = apC.computeCommand(cJet, neutral(), tankCtx(tanker(), { fraction: 0.5 }));
  ok(apC.phase === 'CONTACT', 'inside 90 m the autopilot holds CONTACT', apC.phase);
  ok(Math.abs(cJet.targetThrottle - 0.45) < 0.02, 'contact matches tanker speed at zero error',
    cJet.targetThrottle.toFixed(3));
  ok(contactCmd.roll > 0, 'right of the boom commands a left bank', contactCmd.roll.toFixed(3));

  // Full fuel: break away to ALT_HDG with a one-shot notice.
  const fullJet = makeJet({ x: 0, y: 2991, z: 22, heading: 0, speed: 165 });
  const apFull = new AutopilotSystem();
  apFull.engageAutoRefuel(fullJet, tanker());
  const baseFull = neutral();
  const fullCmd = apFull.computeCommand(fullJet, baseFull, tankCtx(tanker(), { fraction: 1.0 }));
  ok(fullCmd === baseFull, 'full fuel hands the frame back untouched');
  ok(apFull.mode === 'ALT_HDG', 'full fuel transitions AUTO_REFUEL to ALT_HDG');
  ok(apFull.phase === '', 'completion clears the sub-phase');
  const fullNotice = apFull.consumeNotice();
  ok(fullNotice === 'REFUEL COMPLETE · BREAKING AWAY', 'refuel posts a clean completion notice',
    String(fullNotice));

  // Manual stick always wins, even in AUTO_REFUEL.
  const ovJet = makeJet({ x: 0, y: 3000, z: 3000, heading: 0, speed: 220 });
  const apOv = new AutopilotSystem();
  apOv.engageAutoRefuel(ovJet, tanker());
  const ovBase = neutral();
  ovBase.roll = -0.6;
  ok(apOv.computeCommand(ovJet, ovBase, tankCtx(tanker(), { fraction: 0.5 })) === ovBase,
    'stick override in AUTO_REFUEL returns baseCmd');
  ok(apOv.mode === 'OFF', 'stick override disengages AUTO_REFUEL');

  // Closed-loop: rendezvous -> join -> contact, settling inside the boom box.
  const t = tanker();
  const fuel = { fraction: 0.5 };
  const sim = kinematicJet({ x: 0, y: 3000, z: 3000, heading: 0, speed: 220 });
  const apSim = new AutopilotSystem();
  apSim.engageAutoRefuel(sim, t);
  const seen = new Set();
  let inside = null;
  let contactRun = 0;
  for (let i = 0; i < 60 * 180; i++) {
    const cmd = apSim.computeCommand(sim, neutral(), tankCtx(t, fuel));
    seen.add(apSim.phase);
    sim.step(1 / 60, cmd);
    t.position.z -= 165 / 60;

    const dx = sim.position.x - t.position.x;
    const dy = sim.position.y - t.position.y;
    const dz = sim.position.z - t.position.z;
    const aft = -(dx * 0 + dz * -1);
    const below = -dy;
    const lateral = Math.abs(dx * 1 + dz * 0);
    const relSpeed = Math.abs(sim.speed - t.speed);
    if (apSim.phase === 'CONTACT') {
      contactRun++;
      if (aft >= 12 && aft <= 34 && below >= 2 && below <= 12 && lateral <= 10 && relSpeed < 22) {
        inside = { aft, below, lateral, relSpeed };
      }
      if (inside && contactRun > 120) break;
    }
  }
  ok(seen.has('RENDEZVOUS'), 'closed-loop refuel starts in RENDEZVOUS');
  ok(seen.has('JOIN'), 'closed-loop refuel passes through JOIN');
  ok(seen.has('CONTACT'), 'closed-loop refuel reaches CONTACT');
  ok(!!inside, 'closed-loop refuel settles inside the KC-135 boom contact box',
    inside ? `aft ${inside.aft.toFixed(1)}, below ${inside.below.toFixed(1)}, lat ${inside.lateral.toFixed(1)}` : 'never inside');
  if (inside) {
    ok(inside.aft >= 12 && inside.aft <= 34, 'contact box aft envelope', inside.aft.toFixed(1));
    ok(inside.below >= 2 && inside.below <= 12, 'contact box vertical envelope', inside.below.toFixed(1));
    ok(inside.lateral <= 10, 'contact box lateral envelope', inside.lateral.toFixed(1));
    ok(inside.relSpeed < 22, 'contact closure is gentle', inside.relSpeed.toFixed(1));
  }
  ok(Math.abs(sim.position.y - (t.position.y - 9)) < 6,
    'closed-loop refuel holds 9 m below the tanker',
    (sim.position.y - t.position.y).toFixed(1));
  ok(Math.abs(sim.heading - t.heading) < 8, 'closed-loop refuel holds the tanker heading',
    (sim.heading - t.heading).toFixed(1));

  // Reaching 100% posts the break-away notice and leaves ALT_HDG latched.
  fuel.fraction = 1.0;
  apSim.computeCommand(sim, neutral(), tankCtx(t, fuel));
  ok(apSim.mode === 'ALT_HDG', 'closed-loop refuel ends in ALT_HDG');
  ok(apSim.consumeNotice() === 'REFUEL COMPLETE · BREAKING AWAY',
    'closed-loop refuel posts REFUEL COMPLETE');
}

// -------------- 10. real FlightModel closed-loop off-axis auto-land
{
  const RAD = Math.PI / 180;

  const landAp = {
    x: 0, z: 0, elevation: 100, heading: 90, length: 3000, width: 45,
    code: 'LJAJ', name: 'Ajdovščina',
  };
  const world = { heightAt: () => 100, slopeAt: () => 0 };
  const weather = {
    windAt: (x, z, alt, out) => { out.set(0, 0, 0); return out; },
    state: { turbulence: 0, gust: 0 },
  };
  const base = () => ({
    pitch: 0, roll: 0, yaw: 0, throttleDelta: 0,
    gearToggle: false, flapsToggle: false, brake: false,
  });

  // 2.5 km east / 7.5 km north of the field, 1100 m above it and pointed
  // away from the approach: a genuine off-axis engagement, gear up.
  const f = new FlightModel();
  f.reset({ x: 2500, y: 1200, z: -7500, heading: 200 });
  f.onGround = false;
  f.gearDown = false;
  f.gearTarget = 0;
  f.gearPos = 0;
  f.speed = 195;
  f.velocity.set(Math.sin(200 * RAD) * 195, 0, -Math.cos(200 * RAD) * 195);
  f.throttle = 0.55;
  f.targetThrottle = 0.55;
  ok(!f.gearDown && f.gearPos === 0, 'auto-land starts with the gear up');

  const ap = new AutopilotSystem();
  ok(ap.engageAutoLand(f, landAp) === true, 'auto-land engages on a real FlightModel');

  const plan0 = ap.getPlanSummary();
  ok(Array.isArray(plan0.steps) && plan0.steps.length === 5,
    'auto-land plan exposes 5 steps', plan0.steps && plan0.steps.length);
  ok(plan0.steps.map((s) => s.id).join(',') === 'PATTERN,INTERCEPT,FINAL,FLARE,ROLLOUT',
    'auto-land plan is the full approach sequence', plan0.steps.map((s) => s.id).join(','));
  ok(plan0.steps.every((s) => typeof s.label === 'string' && s.label.length > 0
    && ['done', 'active', 'pending'].includes(s.status)),
    'every plan step carries a label and a status');
  ok(plan0.steps.some((s) => s.status === 'active'), 'plan marks the active leg',
    plan0.steps.map((s) => s.status).join(','));

  const ctx = { airport: landAp, terrainHeight: () => 100 };
  const dt = 1 / 60;
  const phases = new Set();
  let touchdown = null;
  let frames = 0;

  for (let i = 0; i < 60 * 240; i++) {
    frames = i + 1;
    const cmd = ap.computeCommand(f, base(), ctx);
    phases.add(ap.phase);
    const wasAir = !f.onGround;
    f.update(dt, cmd, world, weather);
    if (wasAir && f.onGround && !touchdown) {
      // RWY 09/27 lies along z = 0, so |z| is the cross-track error and the
      // 3 km pavement spans |x| <= 1500.
      touchdown = {
        t: frames / 60,
        lateral: f.position.z,
        x: f.position.x,
        gearPos: f.gearPos,
        sink: -f.verticalSpeed,
        speed: f.speed,
      };
    }
    if (ap.mode === 'OFF') break;
  }

  ok(phases.has('PATTERN') && phases.has('INTERCEPT') && phases.has('FINAL')
    && phases.has('FLARE') && phases.has('ROLLOUT'),
    'real-airframe auto-land flies the whole pattern', [...phases].join(','));
  ok(!!touchdown, 'real-airframe auto-land reaches the runway');
  if (touchdown) {
    ok(touchdown.gearPos > 0.9, 'gear is down and locked at touchdown',
      touchdown.gearPos.toFixed(2));
    ok(Math.abs(touchdown.lateral) < 80, 'touchdown is on the runway centreline',
      `${touchdown.lateral.toFixed(1)} m lateral`);
    ok(Math.abs(touchdown.x) < 1500, 'touchdown is on the pavement',
      `${touchdown.x.toFixed(0)} m along`);
    ok(touchdown.sink < 3.5, 'touchdown sink rate is inside the gear limit',
      `${touchdown.sink.toFixed(2)} m/s`);
    ok(touchdown.speed < 100, 'touchdown speed is near on-speed',
      `${touchdown.speed.toFixed(0)} m/s`);
  }
  ok(!f.crashed, 'real-airframe auto-land never crashes', f.crashReason);
  ok(ap.mode === 'OFF', 'real-airframe auto-land rolls to a stop and disengages', ap.mode);
  ok(f.speed < 5, 'jet is stopped after the rollout', f.speed.toFixed(2));
  const notice = ap.consumeNotice();
  ok(String(notice).startsWith('AUTO-LAND COMPLETE'),
    'real-airframe auto-land posts its completion notice', String(notice));
  ok(ap.getPlanSummary().steps.every((s) => s.status === 'done'),
    'completed plan marks every leg done');
  ok(frames < 60 * 240, 'auto-land finishes inside the 240 s budget',
    `${(frames / 60).toFixed(1)} s`);
}

// ---- 11. real FlightModel + real orbiting TankerSystem auto-refuel
{
  const RAD = Math.PI / 180;

  const world = { heightAt: () => 100, slopeAt: () => 0 };
  const weather = {
    windAt: (x, z, alt, out) => { out.set(0, 0, 0); return out; },
    state: { turbulence: 0, gust: 0 },
  };
  const base = () => ({
    pitch: 0, roll: 0, yaw: 0, throttleDelta: 0,
    gearToggle: false, flapsToggle: false, brake: false,
  });

  const tanker = new TankerSystem(null);
  const fuel = new FuelSystem();
  fuel.fuelLb = 3500;
  fuel.fraction = 0.5;
  tanker.update(0, null); // prime the orbit pose before engaging
  ok(Math.abs(tanker.radius - 7500) < 1e-9 && tanker._omega > 0,
    'live tanker flies a clockwise 7.5 km orbit', `${tanker.radius} m / ${tanker._omega} rad/s`);
  ok(Math.abs(Math.hypot(tanker.position.x - tanker.anchor.x, tanker.position.z - tanker.anchor.z)
    - tanker.radius) < 1, 'primed tanker sits on its orbit');

  // Spawn 3.2 km astern and 1.4 km inside the circle, 45° off the tanker's
  // heading, 400 m low and 35 m/s fast: a full off-axis rejoin.
  const fwd = new THREE.Vector3(tanker.velocity.x, 0, tanker.velocity.z).normalize();
  const inward = new THREE.Vector3(-fwd.z, 0, fwd.x); // orbit-centre side
  const spawn = tanker.position.clone().addScaledVector(fwd, -3200).addScaledVector(inward, 1400);
  const spawnHdg = ((tanker.heading + 45) % 360 + 360) % 360;

  const f = new FlightModel();
  f.reset({ x: spawn.x, y: 2600, z: spawn.z, heading: spawnHdg });
  f.onGround = false;
  f.gearDown = false;
  f.gearTarget = 0;
  f.gearPos = 0;
  f.speed = 200;
  f.throttle = 0.6;
  f.targetThrottle = 0.6;
  f.velocity.set(Math.sin(spawnHdg * RAD) * 200, 0, -Math.cos(spawnHdg * RAD) * 200);

  // A custom orbiting tanker that exposes no `anchor` must produce identical
  // commands: the law reconstructs the centre from position/velocity/radius.
  const mockTanker = {
    position: tanker.position.clone(),
    velocity: tanker.velocity.clone(),
    heading: tanker.heading,
    speed: tanker.speed,
    radius: tanker.radius,
    _omega: tanker._omega,
  };
  const probe = makeJet({ x: spawn.x, y: spawn.y, z: spawn.z, heading: spawnHdg, speed: 200 });
  const apReal = new AutopilotSystem();
  apReal.engageAutoRefuel(probe, tanker);
  const realCmd = apReal.computeCommand(probe, neutral(),
    { tanker, fuel: { fraction: 0.5 }, terrainHeight: () => 100 });
  const apMock = new AutopilotSystem();
  apMock.engageAutoRefuel(probe, mockTanker);
  const mockCmd = apMock.computeCommand(probe, neutral(),
    { tanker: mockTanker, fuel: { fraction: 0.5 }, terrainHeight: () => 100 });
  ok(apMock.phase === 'RENDEZVOUS', 'anchor-less orbit mock starts in RENDEZVOUS', apMock.phase);
  ok(Math.abs(realCmd.roll - mockCmd.roll) < 1e-9 && Math.abs(realCmd.pitch - mockCmd.pitch) < 1e-9,
    'orbit centre is recovered from position/velocity without an anchor',
    `roll ${realCmd.roll.toFixed(6)} vs ${mockCmd.roll.toFixed(6)}`);

  const ap = new AutopilotSystem();
  ok(ap.engageAutoRefuel(f, tanker) === true, 'auto-refuel engages on a real FlightModel');
  ok(ap.mode === 'AUTO_REFUEL' && ap.phase === 'RENDEZVOUS',
    'real-airframe auto-refuel starts in RENDEZVOUS', ap.phase);

  const ctx = { tanker, fuel, terrainHeight: () => 100 };
  const dt = 1 / 60;
  const phases = new Set();
  let contactTicks = 0;
  let firstContact = null;
  let bestRange = Infinity;
  let ended = '';
  let secs = 0;

  for (let i = 0; i < 60 * 220; i++) {
    secs = (i + 1) / 60;
    const cmd = ap.computeCommand(f, base(), ctx);
    phases.add(ap.phase);
    tanker.update(dt, f);
    fuel.update(dt, f, tanker.contact);
    f.update(dt, cmd, world, weather);
    if (f.crashed) { ended = 'crash · ' + f.crashReason; break; }
    if (tanker.contact) {
      contactTicks++;
      if (firstContact === null) firstContact = secs;
    }
    bestRange = Math.min(bestRange, Math.hypot(
      f.position.x - tanker.position.x,
      f.position.y - tanker.position.y,
      f.position.z - tanker.position.z));
    if (ap.mode !== 'AUTO_REFUEL') { ended = ap.mode; break; }
  }

  ok(phases.has('RENDEZVOUS'), 'real refuel rejoins from the far side of the orbit',
    [...phases].join(','));
  ok(phases.has('JOIN'), 'real refuel passes through JOIN', [...phases].join(','));
  ok(phases.has('CONTACT'), 'real refuel reaches boom CONTACT', [...phases].join(','));
  ok(!f.crashed, 'real-airframe auto-refuel never crashes', f.crashReason);
  ok(contactTicks >= 60, 'boom contact is sustained for at least a second',
    `${contactTicks} ticks, first at ${firstContact === null ? 'never' : firstContact.toFixed(1)} s (${secs.toFixed(0)} s flown, ended ${ended || 'still flying'})`);
  ok(bestRange < 45, 'the jet closes onto the boom', `${bestRange.toFixed(1)} m`);
  ok(Math.abs(f.position.y - tanker.position.y) < 40,
    'real refuel holds station below the tanker',
    `${(f.position.y - tanker.position.y).toFixed(1)} m`);
  const fullBreakaway = fuel.fraction >= 0.995 && ap.mode === 'ALT_HDG';
  ok(fuel.fraction > 0.70 || fullBreakaway,
    'the boom actually transfers fuel', `fraction ${fuel.fraction.toFixed(3)} (${ended || 'still flying'})`);
  if (fullBreakaway) {
    const breakaway = ap.consumeNotice();
    ok(breakaway === 'REFUEL COMPLETE · BREAKING AWAY',
      'a full tank breaks away cleanly with a notice', String(breakaway));
  }
}

// ---------------------------------------------------------------- summary
console.log(`autopilot checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL AUTOPILOT CHECKS PASSED');