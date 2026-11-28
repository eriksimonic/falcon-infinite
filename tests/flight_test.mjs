// Flight model acceptance tests (no browser required).
import { FlightModel, isaAtmosphere } from '../src/aircraft/flight.js';
import { FlightJuiceSystem } from '../src/sim/juice.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const world = { heightAt: () => 0, slopeAt: () => 0 };
// Open-air world used for envelope runs (no ground / ground-effect interaction).
const openWorld = { heightAt: () => -20000, slopeAt: () => 0 };
const weather = {
  windAt: (x, z, a, out) => { out.set(0, 0, 0); return out; },
  state: { turbulence: 0 },
};
const base = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0, gearToggle: false, flapsToggle: false, brake: false };

// ---------------------------------------------------------------- takeoff
{
  const f = new FlightModel();
  f.reset({ x: 0, y: 1.58, z: 0, heading: 90 });
  for (let i = 0; i < 720; i++) f.update(1 / 60, { ...base, throttleDelta: 1 }, world, weather);
  ok(f.throttle > 0.99, 'throttle reaches full');
  ok(f.speed * 1.944 > 180, 'accelerates on runway', (f.speed * 1.944).toFixed(0) + ' kt');
  for (let i = 0; i < 180; i++) f.update(1 / 60, { ...base, pitch: 1 }, world, weather);
  ok(!f.onGround, 'rotates and lifts off');
  ok(f.agl > 15, 'climbs after takeoff', f.agl.toFixed(1) + ' m');
  ok(!f.crashed, 'no false terrain impact on liftoff');
  ok(f.gearPos > 0.9, 'gear starts down');
}

// ------------------------------------------------- 500 kt pull: no stall
{
  const f = new FlightModel();
  f.reset({ x: 0, y: 3000, z: 0, heading: 0 });
  f.onGround = false;
  f.velocity.set(0, 0, -257); // 500 kt
  f.throttle = 0.9;
  f.targetThrottle = 0.9;
  let maxAoa = 0;
  let maxG = 0;
  let stalled = false;
  for (let i = 0; i < 600; i++) {
    f.update(1 / 60, { ...base, pitch: 1 }, world, weather);
    maxAoa = Math.max(maxAoa, f.aoa);
    maxG = Math.max(maxG, f.gForce);
    if (f.stall) stalled = true;
  }
  ok(!stalled, 'no stall at 500 kt full aft stick');
  ok(maxAoa < 0.34, 'AoA limiter holds', (maxAoa * 57.3).toFixed(1) + '°');
  ok(maxG < 12, 'G limiter holds', maxG.toFixed(1) + ' g');
  ok(!f.crashed, 'airframe survives high-speed pull');
}

// ------------------------------------------------- low speed still stalls
{
  const f = new FlightModel();
  f.reset({ x: 0, y: 500, z: 0, heading: 0 });
  f.onGround = false;
  f.velocity.set(0, 0, -45);
  f.throttle = 0.2;
  f.targetThrottle = 0.2;
  let stalled = false;
  for (let i = 0; i < 300; i++) {
    f.update(1 / 60, { ...base, pitch: 1 }, world, weather);
    if (f.stall) stalled = true;
  }
  ok(stalled, 'low-speed high-AoA pull still stalls');
}

// ------------------------------------------------- ground steering/gear
{
  const f = new FlightModel();
  f.reset({ x: 0, y: 1.58, z: 0, heading: 0 });
  const h0 = f.heading;
  for (let i = 0; i < 120; i++) f.update(1 / 60, { ...base, yaw: 1 }, world, weather);
  ok(Math.abs(f.heading - h0) > 0.5, 'nosewheel steering turns on the ground');
  f.update(1 / 60, { ...base, gearToggle: true }, world, weather);
  ok(!f.gearDown, 'gear lever commands retraction');
}

// ---------------------------------------- TP-1538: gear drag sign is fixed
{
  function coast(gear) {
    const f = new FlightModel();
    f.reset({ x: 0, y: 3000, z: 0, heading: 0 });
    f.onGround = false;
    f.gearPos = gear;
    f.gearTarget = gear;
    f.gearDown = gear > 0.5;
    f.flapsIndex = 0;
    f.flapPos = 0;
    f.velocity.set(0, 0, -200);
    f.throttle = 0.4;
    f.targetThrottle = 0.4;
    for (let i = 0; i < 900; i++) f.update(1 / 60, base, world, weather);
    return f.speed;
  }
  const up = coast(0);
  const down = coast(1);
  ok(down < up, 'gear DOWN decelerates faster than gear UP',
    `${(down * 1.944).toFixed(0)} kt vs ${(up * 1.944).toFixed(0)} kt`);
  ok(up - down > 5, 'gear drag difference is substantial', (up - down).toFixed(1) + ' m/s');
}

// --------------------------------------------- ISA atmosphere & air data
{
  const sea = isaAtmosphere(0);
  const hi = isaAtmosphere(11000);
  ok(Math.abs(sea.a - 340.3) < 0.5, 'ISA sea-level speed of sound ≈ 340.3 m/s', sea.a.toFixed(2));
  ok(Math.abs(hi.a - 295.1) < 0.5, 'ISA 11 km speed of sound ≈ 295.1 m/s', hi.a.toFixed(2));
  ok(Math.abs(hi.rho - 0.364) < 0.002, 'ISA 11 km density ≈ 0.364 kg/m³', hi.rho.toFixed(4));
  ok(Math.abs(hi.T - 216.65) < 1e-6, 'ISA tropopause temperature is 216.65 K', String(hi.T));

  // Exposed air data must agree with the ISA solution for the same frame.
  const f = new FlightModel();
  f.reset({ x: 0, y: 5000, z: 0, heading: 0 });
  f.onGround = false;
  f.gearPos = 0;
  f.gearTarget = 0;
  f.flapsIndex = 0;
  f.flapPos = 0;
  f.velocity.set(0, 0, -200);
  f.update(1 / 60, base, openWorld, weather);
  const at5k = isaAtmosphere(5000);
  ok(Math.abs(f.mach - 200 / at5k.a) < 0.01, 'Mach derives from local speed of sound',
    `${f.mach.toFixed(3)} vs ${(200 / at5k.a).toFixed(3)}`);
  ok(Math.abs(f.qBar - 0.5 * at5k.rho * 200 * 200) < 200, 'qBar uses ISA density', f.qBar.toFixed(0));
  ok(Math.abs(f.ias - 200 * Math.sqrt(at5k.rho / 1.225)) < 0.5, 'IAS is density-corrected',
    f.ias.toFixed(1));
  ok(f.massKg === 10800, 'massKg defaults to CONFIG.aircraft.mass', String(f.massKg));
  ok(Number.isFinite(f.lefDeg) && Number.isFinite(f.buffet) && Number.isFinite(f.gLoc),
    'TP-1538 telemetry fields are exposed');
}

// ------------------------------- transonic drag barrier / supersonic envelope
function envelope({ y, speed, throttle, seconds }) {
  const f = new FlightModel();
  f.reset({ x: 0, y, z: 0, heading: 0 });
  f.onGround = false;
  f.gearPos = 0;
  f.gearTarget = 0;
  f.gearDown = false;
  f.flapsIndex = 0;
  f.flapPos = 0;
  f.velocity.set(0, 0, -speed);
  f.throttle = throttle;
  f.targetThrottle = throttle;
  for (let i = 0; i < seconds * 60; i++) f.update(1 / 60, base, openWorld, weather);
  return f;
}
{
  const dry = envelope({ y: 100, speed: 200, throttle: 0.85, seconds: 150 });
  ok(dry.mach < 1.05, 'dry military power stays subsonic at low altitude', 'M ' + dry.mach.toFixed(3));

  const abSea = envelope({ y: 100, speed: 200, throttle: 1, seconds: 150 });
  ok(abSea.mach > 1.05, 'afterburner breaks Mach 1 at low altitude', 'M ' + abSea.mach.toFixed(3));
  ok(abSea.mach < 1.45, 'sea-level afterburner dash stays below M 1.45', 'M ' + abSea.mach.toFixed(3));

  const abHigh = envelope({ y: 11000, speed: 340, throttle: 1, seconds: 300 });
  ok(abHigh.mach > 1.6, 'afterburner reaches high supersonic at 11 km', 'M ' + abHigh.mach.toFixed(3));
}

// ---------------------------------------------- automatic LEF schedule
{
  // Low speed / high AoA droops the leading-edge flaps.
  const f = new FlightModel();
  f.reset({ x: 0, y: 3000, z: 0, heading: 0 });
  f.onGround = false;
  f.gearPos = 0;
  f.gearTarget = 0;
  f.flapsIndex = 0;
  f.flapPos = 0;
  const pitch = (15 * Math.PI) / 180 / 2;
  f.quaternion.set(Math.sin(pitch), 0, 0, Math.cos(pitch));
  f.velocity.set(0, 0, -80);
  f.throttle = 0.4;
  f.targetThrottle = 0.4;
  for (let i = 0; i < 120; i++) f.update(1 / 60, base, world, weather);
  ok(f.aoa > 0.18, 'test point is at high AoA', (f.aoa * 57.3).toFixed(1) + '°');
  ok(f.lefDeg > 8, 'LEF droops at low speed / high AoA', f.lefDeg.toFixed(1) + '°');
  ok(f.lefDeg <= 25.0001, 'LEF schedule clamps at 25°', f.lefDeg.toFixed(1) + '°');

  // Above Mach 1.05 it locks to the supersonic -2° minimum-wave-drag setting.
  const s = new FlightModel();
  s.reset({ x: 0, y: 8000, z: 0, heading: 0 });
  s.onGround = false;
  s.gearPos = 0;
  s.gearTarget = 0;
  s.flapsIndex = 0;
  s.flapPos = 0;
  s.velocity.set(0, 0, -400);
  s.throttle = 0.8;
  s.targetThrottle = 0.8;
  for (let i = 0; i < 120; i++) s.update(1 / 60, base, world, weather);
  ok(s.mach > 1.05, 'supersonic LEF test point is above M 1.05', 'M ' + s.mach.toFixed(2));
  ok(Math.abs(s.lefDeg + 2) < 0.5, 'LEF locks near -2° above M 1.05', s.lefDeg.toFixed(2) + '°');
}

// ------------------------------------------------- 1G auto-trim in cruise
{
  const f = new FlightModel();
  f.reset({ x: 0, y: 3000, z: 0, heading: 0 });
  f.onGround = false;
  f.gearPos = 0;
  f.gearTarget = 0;
  f.gearDown = false;
  f.flapsIndex = 0;
  f.flapPos = 0;
  f.velocity.set(0, 0, -180); // 350 kt
  f.throttle = 0.5;
  f.targetThrottle = 0.5;
  const y0 = f.position.y;
  for (let i = 0; i < 600; i++) f.update(1 / 60, base, world, weather);
  ok(Math.abs(f.gForce - 1.0) < 0.08, '1G auto-trim holds gForce ≈ 1.0', f.gForce.toFixed(3));
  ok(Math.abs(f.position.y - y0) < 25, '1G auto-trim holds altitude with minimal drift',
    (f.position.y - y0).toFixed(1) + ' m');
  ok(!f.stall && !f.crashed, 'neutral-stick cruise stays inside the envelope');
}

// --------------------------------------------------- 9G FLCS G-limiter
{
  for (const kt of [450, 500]) {
    const f = new FlightModel();
    f.reset({ x: 0, y: 3000, z: 0, heading: 0 });
    f.onGround = false;
    f.gearPos = 0;
    f.gearTarget = 0;
    f.flapsIndex = 0;
    f.flapPos = 0;
    f.velocity.set(0, 0, -kt * 0.514444);
    f.throttle = 0.9;
    f.targetThrottle = 0.9;
    let maxG = 0;
    let maxAoa = 0;
    let stalled = false;
    for (let i = 0; i < 480; i++) {
      f.update(1 / 60, { ...base, pitch: 1 }, world, weather);
      maxG = Math.max(maxG, f.gForce);
      maxAoa = Math.max(maxAoa, f.aoa);
      if (f.stall) stalled = true;
    }
    ok(maxG > 8.2, `${kt} kt full aft pull reaches the 9G region`, maxG.toFixed(2) + ' g');
    ok(maxG < 10.5, `${kt} kt pull never exceeds 10.5G`, maxG.toFixed(2) + ' g');
    ok(maxAoa < 0.34, `${kt} kt pull stays inside the AoA limiter`,
      (maxAoa * 57.3).toFixed(1) + '°');
    ok(!stalled, `${kt} kt full aft pull does not depart`);
    ok(!f.crashed, `${kt} kt pull is survivable`);
  }
}

// ------------------------------------------------------ ground effect (IGE)
{
  function atAgl(y) {
    const f = new FlightModel();
    f.reset({ x: 0, y, z: 0, heading: 0 });
    f.onGround = false;
    f.gearPos = 1;
    f.gearTarget = 1;
    f.flapsIndex = 0;
    f.flapPos = 0;
    const pitch = (8 * Math.PI) / 180 / 2;
    f.quaternion.set(Math.sin(pitch), 0, 0, Math.cos(pitch));
    f.velocity.set(0, 0, -90);
    f.throttle = 0.6;
    f.targetThrottle = 0.6;
    for (let i = 0; i < 24; i++) f.update(1 / 60, base, world, weather);
    return f;
  }
  const low = atAgl(3);
  const high = atAgl(500);
  ok(Math.abs(low.aoa - high.aoa) < 0.02, 'ground-effect comparison uses the same AoA',
    `${(low.aoa * 57.3).toFixed(1)}° vs ${(high.aoa * 57.3).toFixed(1)}°`);
  ok(Math.abs(low.speed - high.speed) < 1.0, 'ground-effect comparison uses the same airspeed',
    `${low.speed.toFixed(1)} vs ${high.speed.toFixed(1)} m/s`);
  ok(low.gForce > high.gForce * 1.05, 'ground effect increases lift near the runway',
    `${low.gForce.toFixed(3)} vs ${high.gForce.toFixed(3)}`);
}

// ================================================== AERO-1 stores & braking
// Heavy A/G loadout used by the rollout / G-limit cases below.
const HEAVY = { fuelLb: 4916, aim9: 2, mk82: 6, bffg: 2 };

// --------------------------------------- live loadout mass & CAT I / CAT III
{
  const heavy = new FlightModel();
  heavy.reset({ x: 0, y: 1.58, z: 0, heading: 0 });
  heavy.setLoadout(HEAVY);

  const light = new FlightModel();
  light.reset({ x: 0, y: 1.58, z: 0, heading: 0 });
  light.setLoadout({ fuelLb: 700, aim9: 2 });

  ok(heavy.massKg > light.massKg + 3500, 'full fuel + heavy stores weighs far more than a light jet',
    `${heavy.massKg.toFixed(0)} vs ${light.massKg.toFixed(0)} kg`);
  ok(heavy.catMode === 'CAT III', 'A/G stores select CAT III', heavy.catMode);
  ok(light.catMode === 'CAT I', 'clean jet stays CAT I', light.catMode);
  ok(Math.abs(heavy.massKg - (8570 + 4916 * 0.45359237 + 6 * 241 + 2 * 650 + 2 * 85)) < 1e-6,
    'mass = empty + fuel + stores', heavy.massKg.toFixed(2) + ' kg');
  ok(Math.abs(heavy.storesDragCd - (2 * 0.0008 + 6 * 0.0022 + 2 * 0.0042)) < 1e-12,
    'store drag is summed per pylon', String(heavy.storesDragCd));
  ok(heavy.storesDragCd > light.storesDragCd * 3, 'heavy stores add real parasite drag');

  heavy.setLoadout({ fuelLb: 4916, aim9: 2, mk82: 0, bffg: 0 });
  ok(heavy.catMode === 'CAT I', 'dropping all A/G stores returns CAT I', heavy.catMode);
  ok(heavy.storesMassKg === 170, 'remaining AIM-9s still weigh 170 kg', String(heavy.storesMassKg));

  const dflt = new FlightModel();
  dflt.reset({ x: 0, y: 1.58, z: 0, heading: 0 });
  dflt.setLoadout({});
  ok(Math.abs(dflt.massKg - 10800) < 0.5, 'default loadout reproduces the 10800 kg baseline',
    dflt.massKg.toFixed(2) + ' kg');

  // reset() drops back to the verified baseline airframe.
  heavy.reset({ x: 0, y: 1.58, z: 0, heading: 0 });
  ok(heavy.massKg === 10800 && heavy.catMode === 'CAT I' && heavy.storesDragCd === 0,
    'reset() restores the baseline clean airframe');
}

// -------------------------- light jet accelerates / climbs better (same throttle)
{
  function groundRun(loadout) {
    const f = new FlightModel();
    f.reset({ x: 0, y: 1.58, z: 0, heading: 0 });
    f.setLoadout(loadout);
    for (let i = 0; i < 1200; i++) f.update(1 / 60, { ...base, throttleDelta: 1 }, world, weather);
    return f;
  }
  const lightRun = groundRun({ fuelLb: 900, aim9: 0 });
  const heavyRun = groundRun(HEAVY);
  ok(lightRun.speed > heavyRun.speed + 20, 'light jet accelerates much faster at identical throttle',
    `${(lightRun.speed * 1.944).toFixed(0)} vs ${(heavyRun.speed * 1.944).toFixed(0)} kt`);

  function climbRun(loadout) {
    const f = new FlightModel();
    f.reset({ x: 0, y: 3000, z: 0, heading: 0 });
    f.setLoadout(loadout);
    f.onGround = false;
    f.gearPos = 1;
    f.gearTarget = 1;
    f.flapsIndex = 0;
    f.flapPos = 0;
    const p = (12 * Math.PI) / 180 / 2;
    f.quaternion.set(Math.sin(p), 0, 0, Math.cos(p));
    const cl = Math.cos(12 * Math.PI / 180);
    f.velocity.set(0, 210 * Math.sin(12 * Math.PI / 180), -210 * cl);
    f.throttle = 0.85;
    f.targetThrottle = 0.85;
    const y0 = f.position.y;
    let dy = 0;
    for (let i = 0; i < 480; i++) {
      f.update(1 / 60, base, world, weather);
      dy = f.position.y - y0;
    }
    return { f, dy };
  }
  const lightClimb = climbRun({ fuelLb: 900, aim9: 0 });
  const heavyClimb = climbRun(HEAVY);
  ok(lightClimb.dy > heavyClimb.dy + 15, 'light jet climbs better at identical throttle',
    `${lightClimb.dy.toFixed(0)} vs ${heavyClimb.dy.toFixed(0)} m`);
  ok(lightClimb.f.speed > heavyClimb.f.speed + 5, 'light jet also accelerates better in the climb',
    `${lightClimb.f.speed.toFixed(0)} vs ${heavyClimb.f.speed.toFixed(0)} m/s`);
}

// ------------------------------------ CAT III 6.5 G cap vs CAT I 9 G pull
{
  function pull(loadout) {
    const f = new FlightModel();
    f.reset({ x: 0, y: 3000, z: 0, heading: 0 });
    f.setLoadout(loadout);
    f.onGround = false;
    f.gearPos = 0;
    f.gearTarget = 0;
    f.gearDown = false;
    f.flapsIndex = 0;
    f.flapPos = 0;
    f.velocity.set(0, 0, -480 * 0.514444);
    f.throttle = 0.9;
    f.targetThrottle = 0.9;
    let maxG = 0;
    let maxAoa = 0;
    let stalled = false;
    for (let i = 0; i < 480; i++) {
      f.update(1 / 60, { ...base, pitch: 1 }, world, weather);
      maxG = Math.max(maxG, f.gForce);
      maxAoa = Math.max(maxAoa, f.aoa);
      if (f.stall) stalled = true;
    }
    return { maxG, maxAoa, stalled, crashed: f.crashed, catMode: f.catMode };
  }
  const cat1 = pull({ fuelLb: 4916 });
  const cat3 = pull({ fuelLb: 4916, aim9: 2, mk82: 2 });

  ok(cat1.catMode === 'CAT I' && cat3.catMode === 'CAT III', 'G-limit comparison uses both stores modes');
  ok(cat1.maxG > 8.2, 'CAT I still pulls to the 9 G limiter', cat1.maxG.toFixed(2) + ' g');
  ok(cat1.maxAoa > 0.28, 'CAT I keeps the full AoA envelope', (cat1.maxAoa * 57.3).toFixed(1) + '°');
  ok(cat3.maxG > 6.0, 'CAT III still pulls the stores-limited load', cat3.maxG.toFixed(2) + ' g');
  ok(cat3.maxG < 7.5, 'CAT III caps the pull near 6.5 G', cat3.maxG.toFixed(2) + ' g');
  ok(cat3.maxG < cat1.maxG - 1.5, 'CAT III is a materially lower G limit than CAT I',
    `${cat3.maxG.toFixed(2)} vs ${cat1.maxG.toFixed(2)} g`);
  ok(cat3.maxAoa < 0.30, 'CAT III AoA limiter is tighter (~16°)',
    (cat3.maxAoa * 57.3).toFixed(1) + '°');
  ok(!cat3.stalled && !cat3.crashed, 'CAT III full-aft pull is clean');
}

// ------------------------------- runway aerobraking (high alpha ground roll)
{
  function rollout(pitchDeg) {
    const f = new FlightModel();
    f.reset({ x: 0, y: 1.58, z: 0, heading: 0 });
    f.setLoadout(HEAVY);
    const p = (pitchDeg * Math.PI) / 180 / 2;
    f.quaternion.set(Math.sin(p), 0, 0, Math.cos(p));
    f.velocity.set(0, 0, -80); // ~155 kt
    f.throttle = 0;
    f.targetThrottle = 0;
    let sawAero = false;
    let airborneFrames = 0;
    for (let i = 0; i < 180; i++) {
      f.update(1 / 60, base, world, weather);
      if (f.aerobraking) sawAero = true;
      if (!f.onGround) airborneFrames++;
    }
    return { f, sawAero, airborneFrames };
  }
  const aero = rollout(11);
  const flat = rollout(0);

  ok(aero.airborneFrames === 0, 'aerobraking run stays planted on the runway',
    String(aero.airborneFrames) + ' airborne frames');
  ok(aero.sawAero && aero.f.aerobraking, 'pitch > 8° at 80 m/s flags aerobraking');
  ok(flat.f.aerobraking === false, 'level rollout does not aerobrake');
  ok(aero.f.speed < flat.f.speed - 1.5, 'aerobraking decelerates faster than a level rollout',
    `${aero.f.speed.toFixed(1)} vs ${flat.f.speed.toFixed(1)} m/s`);
  ok(!aero.f.crashed, 'aerobraking holds the tail clear of the runway');

  // Below ~93 kt the jet settles its nose and stops aerobraking.
  const slow = new FlightModel();
  slow.reset({ x: 0, y: 1.58, z: 0, heading: 0 });
  slow.setLoadout(HEAVY);
  const ps = (11 * Math.PI) / 180 / 2;
  slow.quaternion.set(Math.sin(ps), 0, 0, Math.cos(ps));
  slow.velocity.set(0, 0, -38);
  for (let i = 0; i < 120; i++) slow.update(1 / 60, base, world, weather);
  ok(slow.aerobraking === false, 'slow rollout is outside the aerobrake band');
  ok(slow.pitchDeg < 8, 'nose settles back toward level below 93 kt',
    slow.pitchDeg.toFixed(1) + '°');
}

// ---------------------------------- brake heat, anti-skid and wet runway grip
{
  const f = new FlightModel();
  f.reset({ x: 0, y: 1.58, z: 0, heading: 0 });
  f.velocity.set(0, 0, -70);
  f.throttle = 0;
  f.targetThrottle = 0;
  for (let i = 0; i < 60; i++) f.update(1 / 60, { ...base, brake: true }, world, weather);
  const warm = f.brakeTemp;
  ok(warm > 0, 'hard braking heats the carbon brakes', warm.toFixed(3));
  ok(f.antiSkid === true, 'high-speed braking engages anti-skid');
  ok(f.speed < 70, 'anti-skid braking still decelerates the jet', f.speed.toFixed(1) + ' m/s');

  for (let i = 0; i < 60; i++) f.update(1 / 60, base, world, weather);
  ok(f.antiSkid === false, 'releasing the brakes clears anti-skid');
  ok(f.brakeTemp < warm, 'released brakes cool down', `${warm.toFixed(3)} -> ${f.brakeTemp.toFixed(3)}`);

  // Wet runway widens the anti-skid envelope down to taxi speeds.
  const wetWeather = { ...weather, state: { turbulence: 0, rain: 0.8 } };
  function taxiRoll(spd, wx) {
    const t = new FlightModel();
    t.reset({ x: 0, y: 1.58, z: 0, heading: 0 });
    t.velocity.set(0, 0, -spd);
    t.update(1 / 60, { ...base, brake: true }, world, wx);
    return t;
  }
  ok(taxiRoll(20, weather).antiSkid === false, 'dry low-speed braking runs without anti-skid');
  ok(taxiRoll(20, wetWeather).antiSkid === true, 'wet runway engages anti-skid at low speed');
}

// ------------------------------------------- aerodynamic buffet camera rumble
{
  const plain = new FlightJuiceSystem();
  const buffeted = new FlightJuiceSystem();
  const state = { gLoad: 1, mach: 0.6, speed: 120, afterburner: true };
  let ampPlain = 0;
  let ampBuffet = 0;
  for (let i = 0; i < 60; i++) {
    const a = plain.update(1 / 60, state);
    const b = buffeted.update(1 / 60, { ...state, buffet: 0.8 });
    ampPlain += Math.abs(a.shakeX) + Math.abs(a.shakeY) + Math.abs(a.shakeRoll);
    ampBuffet += Math.abs(b.shakeX) + Math.abs(b.shakeY) + Math.abs(b.shakeRoll);
  }
  ok(ampBuffet > ampPlain * 1.5, 'buffet 0.8 increases shake amplitude over buffet 0',
    `${ampBuffet.toFixed(4)} vs ${ampPlain.toFixed(4)}`);

  // Omitting buffet (or passing 0) must be bit-identical to the old behaviour.
  const omitted = new FlightJuiceSystem();
  const zeroed = new FlightJuiceSystem();
  let identical = true;
  for (let i = 0; i < 120; i++) {
    const a = omitted.update(1 / 60, { gLoad: 6.2, mach: 1.02, speed: 300, afterburner: true });
    const b = zeroed.update(1 / 60, { gLoad: 6.2, mach: 1.02, speed: 300, afterburner: true, buffet: 0 });
    if (a.shakeX !== b.shakeX || a.shakeY !== b.shakeY || a.shakeRoll !== b.shakeRoll
        || a.blackout !== b.blackout || a.gStrain !== b.gStrain || a.machPulse !== b.machPulse
        || a.shockwaveCrossed !== b.shockwaveCrossed) identical = false;
  }
  ok(identical, 'buffet 0 / omitted leaves the juice output bit-identical');
}

console.log(`flight checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL FLIGHT CHECKS PASSED');