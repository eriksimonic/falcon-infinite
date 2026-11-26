// Flight model acceptance tests (no browser required).
import { FlightModel } from '../src/aircraft/flight.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const world = { heightAt: () => 0, slopeAt: () => 0 };
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

console.log(`flight checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL FLIGHT CHECKS PASSED');