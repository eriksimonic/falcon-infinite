// Node-only acceptance test for Feature 19: terrain-conforming road ribbons.
// Run: node tests/roadnet_test.mjs
//
// 1. Imports src/world/roadnet.js headlessly (no DOM).
// 2. Steep hill: every deck vertex sits DECK_LIFT (0.38 m) above heightAt.
// 3. Water: deck is bridged to >= 2.5 m and bridgeCount > 0.
// 4. Finite attributes, in-bounds indices, skirts below the deck.
// 5. Exits 0 and prints ALL ROADNET CHECKS PASSED.

import { Vector3 } from 'three';
import { RoadNetwork, buildRoadRibbonData } from '../src/world/roadnet.js';

const DECK_LIFT = 0.38;
const SKIRT_DEPTH = 1.6;
const failures = [];
let checks = 0;

function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}

const fmt = (n) => (Math.round(n * 1000) / 1000).toFixed(3);

// ---------------------------------------------------------------- 1. import
check(typeof buildRoadRibbonData === 'function', 'buildRoadRibbonData must be exported as a function');
check(typeof RoadNetwork === 'function', 'RoadNetwork must be exported as a class');
check(typeof globalThis.document === 'undefined', 'test must run without a DOM');

// Shared helpers ------------------------------------------------------------
function topVertexCount(positions) {
  return positions.length / 3;
}

function polyline(points, width) {
  return { width, points };
}

// A deterministic winding road over a steep slope.
function hillPoints(count, ox = 0, oz = 0) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    pts.push({
      x: ox + t * 900 + Math.sin(t * Math.PI * 2.2) * 60,
      z: oz + Math.sin(t * Math.PI * 1.7) * 140 + t * 260,
    });
  }
  return pts;
}

const hillHeight = (x, z) => 10 + 0.25 * x + 0.1 * z;

// ---------------------------------------------------- 2. hill conformance
{
  const data = buildRoadRibbonData(
    [polyline(hillPoints(24), 12), polyline(hillPoints(18, 200, 400), 9)],
    hillHeight,
  );
  check(data.segmentCount > 0, 'hill: segmentCount must be > 0');
  check(data.positions.length > 0, 'hill: positions must not be empty');
  check(data.positions.length === data.normals.length, 'hill: normals must match positions');
  check(data.positions.length / 3 * 2 === data.uvs.length, 'hill: one uv per vertex');

  let worst = 0;
  let minH = Infinity;
  const verts = data.positions.length / 3;
  for (let i = 0; i < verts; i++) {
    const kind = i % 4;
    if (kind >= 2) continue; // skirts are below the deck by design
    const x = data.positions[i * 3];
    const y = data.positions[i * 3 + 1];
    const z = data.positions[i * 3 + 2];
    const h = hillHeight(x, z);
    minH = Math.min(minH, h);
    worst = Math.max(worst, Math.abs(y - (h + DECK_LIFT)));
  }
  check(minH > 0.8, `hill: fixture heights must stay above water (min ${fmt(minH)} m)`);
  check(worst <= 0.05, `hill: deck must hug terrain within 0.05 m (worst ${fmt(worst)} m)`);
  check(data.bridgeCount === 0, `hill: dry hill must not create bridges (got ${data.bridgeCount})`);
  // Sampling density: no segment may exceed ~22 m horizontally.
  const single = buildRoadRibbonData([polyline(hillPoints(24), 12)], hillHeight);
  let maxStep = 0;
  for (let i = 4; i < single.positions.length / 3; i += 4) {
    const dx = single.positions[i * 3] - single.positions[(i - 4) * 3];
    const dz = single.positions[i * 3 + 2] - single.positions[(i - 4) * 3 + 2];
    maxStep = Math.max(maxStep, Math.hypot(dx, dz));
  }
  check(maxStep <= 22.5, `hill: sample spacing must stay <= ~22 m (max ${fmt(maxStep)} m)`);
  check(maxStep >= 10, `hill: samples must not be denser than needed (min spacing ${fmt(maxStep)} m)`);
}

// ---------------------------------------------------------- 3. water bridges
{
  const water = () => -5;
  const data = buildRoadRibbonData([polyline(hillPoints(12, -400, -300), 15)], water);
  check(data.segmentCount > 0, 'water: segmentCount must be > 0');
  check(data.bridgeCount > 0, `water: bridgeCount must be > 0 (got ${data.bridgeCount})`);
  let minDeck = Infinity;
  for (let i = 0; i < data.positions.length / 3; i++) {
    if (i % 4 >= 2) continue;
    minDeck = Math.min(minDeck, data.positions[i * 3 + 1]);
  }
  check(minDeck >= 2.5, `water: bridge deck must be >= 2.5 m (min ${fmt(minDeck)} m)`);
  check(data.bridgeCount === 1, `water: one contiguous crossing must count once (got ${data.bridgeCount})`);
}

// ------------------------------------------- 4. finiteness / structure / skirts
{
  const datasets = [
    buildRoadRibbonData([polyline(hillPoints(20), 11)], hillHeight),
    buildRoadRibbonData([polyline(hillPoints(10, 50, 50), 9)], () => -5),
    buildRoadRibbonData([polyline([{ x: 0, z: 0 }, { x: 0.4, z: 0.1 }], 3)], () => 4),
    buildRoadRibbonData([], hillHeight),
    buildRoadRibbonData([polyline([{ x: NaN, z: 1 }, { x: 2, z: 2 }, { x: Infinity, z: 3 }], 6)], () => 5),
  ];
  for (let d = 0; d < datasets.length; d++) {
    const data = datasets[d];
    const verts = data.positions.length / 3;
    check(data.indices.length % 3 === 0, `data ${d}: indices length must be a multiple of 3`);
    check(data.indices.length / 3 === data.segmentCount * 6, `data ${d}: 6 triangles per segment`);
    let finite = true;
    for (let i = 0; i < data.positions.length; i++) if (!Number.isFinite(data.positions[i])) { finite = false; break; }
    check(finite, `data ${d}: positions must all be finite`);
    finite = true;
    for (let i = 0; i < data.normals.length; i++) if (!Number.isFinite(data.normals[i])) { finite = false; break; }
    check(finite, `data ${d}: normals must all be finite`);
    finite = true;
    for (let i = 0; i < data.uvs.length; i++) if (!Number.isFinite(data.uvs[i])) { finite = false; break; }
    check(finite, `data ${d}: uvs must all be finite`);
    let inBounds = true;
    for (let i = 0; i < data.indices.length; i++) {
      const v = data.indices[i];
      if (!Number.isInteger(v) || v < 0 || v >= verts) { inBounds = false; break; }
    }
    check(inBounds, `data ${d}: indices must be integers inside the vertex buffer`);
    // skirts sit exactly SKIRT_DEPTH below their deck edge, normals are unit-ish
    let skirtOk = true;
    let normalsOk = true;
    let deckNormalsUp = true;
    for (let i = 0; i < verts; i += 4) {
      if (i + 3 >= verts) { skirtOk = false; break; }
      const deckL = data.positions[i * 3 + 1];
      const deckR = data.positions[(i + 1) * 3 + 1];
      const skirtL = data.positions[(i + 2) * 3 + 1];
      const skirtR = data.positions[(i + 3) * 3 + 1];
      if (Math.abs((deckL - SKIRT_DEPTH) - skirtL) > 1e-3) skirtOk = false;
      if (Math.abs((deckR - SKIRT_DEPTH) - skirtR) > 1e-3) skirtOk = false;
      for (const vi of [i, i + 1]) {
        const nx = data.normals[vi * 3], ny = data.normals[vi * 3 + 1], nz = data.normals[vi * 3 + 2];
        const l = Math.hypot(nx, ny, nz);
        if (Math.abs(l - 1) > 2e-3) normalsOk = false;
        if (ny <= 0) deckNormalsUp = false;
      }
    }
    check(skirtOk, `data ${d}: skirt vertices must extend ${SKIRT_DEPTH} m below the deck`);
    check(normalsOk, `data ${d}: normals must be unit length`);
    check(deckNormalsUp, `data ${d}: deck normals must point up`);
    // u spans the road, v advances along it
    let uvOk = true;
    for (let i = 0; i < verts; i += 4) {
      if (data.uvs[i * 2] !== 0 || data.uvs[(i + 1) * 2] !== 1) uvOk = false;
      if (data.uvs[i * 2 + 1] !== data.uvs[(i + 1) * 2 + 1]) uvOk = false;
      if (i > 0 && data.uvs[i * 2 + 1] < data.uvs[(i - 4) * 2 + 1] - 1e-6) uvOk = false;
    }
    check(uvOk, `data ${d}: uvs must span the road and advance monotonically`);
  }
  // road width is honoured
  const line = polyline(hillPoints(8), 13);
  const data = buildRoadRibbonData([line], hillHeight);
  let widthOk = true;
  for (let i = 0; i < data.positions.length / 3; i += 4) {
    const dx = data.positions[(i + 1) * 3] - data.positions[i * 3];
    const dz = data.positions[(i + 1) * 3 + 2] - data.positions[i * 3 + 2];
    if (Math.abs(Math.hypot(dx, dz) - 13) > 1e-2) widthOk = false;
  }
  check(widthOk, 'ribbon: deck width must equal the polyline width');
}

// --------------------------------------------- 5. headless RoadNetwork rebuild
{
  const added = [];
  const scene = { add: (o) => added.push(o), remove: (o) => { const i = added.indexOf(o); if (i >= 0) added.splice(i, 1); } };
  const preset = { name: 'medium', roadDetail: true };
  const net = new RoadNetwork(scene, preset);
  check(net.mesh && net.mesh.name === 'highways', 'RoadNetwork mesh must be named highways');
  check(net.mesh.isMesh === true && net.mesh.isInstancedMesh !== true, 'highways must be a merged Mesh, not an InstancedMesh');
  check(added.length === 1 && added[0] === net.mesh, 'RoadNetwork must add its mesh to the scene');
  check(net.stats && typeof net.stats.roads === 'number', 'stats must expose roads');
  check(net.preset === preset, 'preset must be retained');

  const camera = { position: new Vector3(0, 300, 0) };
  net.update(camera);
  check(net.stats.segments > 0, `headless rebuild must create segments (got ${net.stats.segments})`);
  check(net.stats.roads > 0, `headless rebuild must create links (got ${net.stats.roads})`);
  const geo = net.mesh.geometry;
  const posAttr = geo.getAttribute('position');
  check(!!posAttr && posAttr.count > 0, 'rebuilt geometry must have a position attribute');
  check(geo.getAttribute('normal')?.count === posAttr.count, 'geometry normals must match vertex count');
  check(geo.getAttribute('uv')?.count === posAttr.count, 'geometry uvs must match vertex count');
  check((geo.getIndex()?.count ?? 0) % 3 === 0, 'geometry index count must be a multiple of 3');
  let finite = true;
  for (let i = 0; i < posAttr.array.length; i++) if (!Number.isFinite(posAttr.array[i])) { finite = false; break; }
  check(finite, 'rebuilt geometry positions must all be finite');
  check(!Number.isNaN(net.mesh.geometry.boundingSphere?.radius ?? 1), 'geometry bounds must be finite');

  const builtCount = net.stats.segments;
  const firstGeo = net.mesh.geometry;
  net.update(camera); // no camera movement -> no rebuild
  check(net.mesh.geometry === firstGeo && net.stats.segments === builtCount, 'no rebuild within 2000 m');

  const far = { position: new Vector3(2400, 300, 0) };
  net.update(far);
  check(net.mesh.geometry !== firstGeo, 'rebuild must replace the geometry after moving > 2000 m');
  check(net.stats.segments > 0, 'rebuild far away must still create segments');

  net.preset = { name: 'medium', roadDetail: false };
  net.update(far);
  check(net.mesh.visible === false, 'roads must be hidden when roadDetail is off');
  check(net.stats.segments === 0, 'roads must clear when roadDetail is off');

  net.preset = preset;
  net.update(far);
  check(net.stats.segments > 0, 'roads must rebuild when roadDetail is re-enabled');

  net.dispose();
  check(added.length === 0, 'dispose must remove the mesh from the scene');
}

// -------------------------------------------------------------------- report
if (failures.length) {
  console.error(`ROADNET CHECKS FAILED (${failures.length}/${checks}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`roadnet: ${checks} checks passed`);
console.log('ALL ROADNET CHECKS PASSED');
process.exit(0);