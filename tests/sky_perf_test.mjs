// Headless acceptance test for PKT-04 — sky allocations, dome order,
// altitude shadow cut-off and the shadow-camera layer 1 prerequisite.
// Run: node tests/sky_perf_test.mjs
//
// No DOM or WebGL: the SkySystem is built with a stub scene and a stub
// renderer, exactly like the other headless suite.

import * as THREE from 'three';
import { SkySystem } from '../src/sim/sky.js';

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}

const scene = { add() {}, fog: null };
const renderer = { toneMappingExposure: 1, shadowMap: { autoUpdate: true } };
const sky = new SkySystem(scene, renderer);

const camera = { position: new THREE.Vector3(0, 300, 0) };
const time = { hour: 12 };
const weather = { state: { overcast: 0.1, fog: 0.0002 } };

// 1. 100 frames do not throw (stub renderer/scene, no camera swaps).
let threw = null;
try {
  for (let i = 0; i < 100; i++) {
    time.hour = 6 + (i % 18);
    sky.update(1 / 60, time, weather, camera, 0);
  }
} catch (err) {
  threw = err;
}
check(threw === null, `100 update() calls must not throw (threw: ${threw && threw.message})`);

// 2. The returned result object is reused; sunColor is the same reference.
time.hour = 12;
const r1 = sky.update(1 / 60, time, weather, camera, 0);
const r2 = sky.update(1 / 60, time, weather, camera, 0);
check(r1.sunColor === r2.sunColor, 'two update() calls must return the same sunColor object reference');
check(r1 === r2, 'update() must reuse one result object');

// 3. Sky dome depth state and draw order (PERF-14).
const dome = sky.dome;
const mat = dome.material;
check(mat.depthTest === true, 'dome material.depthTest must be true');
check(mat.depthWrite === false, 'dome material.depthWrite must be false');
check(mat.depthFunc === THREE.LessEqualDepth, 'dome material.depthFunc must be THREE.LessEqualDepth');
check(dome.renderOrder > 0, `dome.renderOrder must be > 0 (got ${dome.renderOrder})`);
check(
  typeof mat.vertexShader === 'string' && mat.vertexShader.includes('gl_Position.z = gl_Position.w'),
  'dome vertex shader must pin the dome to the far plane',
);

// 4. Shadow camera draws layer 0 and layer 1 (PERF-11 prerequisite).
const camLayers = sky.sun.shadow.camera.layers;
check(camLayers.isEnabled(0) === true, 'shadow camera must keep layer 0 enabled');
check(camLayers.isEnabled(1) === true, 'shadow camera must enable layer 1');

// 5. Altitude cut-off with hysteresis (PERF-12).
camera.position.set(0, 5000, 0);
sky.update(1 / 60, time, weather, camera, 0);
check(sky.sun.shadow.intensity === 0, `at 5000 m shadow.intensity must be 0 (got ${sky.sun.shadow.intensity})`);
check(renderer.shadowMap.autoUpdate === false, 'at 5000 m shadowMap.autoUpdate must be false');
check(sky.sun.castShadow === true, 'altitude cut-off must not toggle castShadow');

// Inside the hysteresis band: still off.
camera.position.set(0, 3700, 0);
sky.update(1 / 60, time, weather, camera, 0);
check(sky.sun.shadow.intensity === 0, `at 3700 m shadow.intensity must stay 0 (got ${sky.sun.shadow.intensity})`);
check(renderer.shadowMap.autoUpdate === false, 'at 3700 m shadowMap.autoUpdate must stay false');

// Back below the lower threshold: restored.
camera.position.set(0, 300, 0);
sky.update(1 / 60, time, weather, camera, 0);
check(sky.sun.shadow.intensity === 1, `at 300 m shadow.intensity must be 1 (got ${sky.sun.shadow.intensity})`);
check(renderer.shadowMap.autoUpdate === true, 'at 300 m shadowMap.autoUpdate must be true');

// Result.
if (failures.length) {
  console.error(`sky_perf_test: ${failures.length} of ${checks} checks failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`sky_perf_test: all ${checks} checks passed`);