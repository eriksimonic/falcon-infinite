// Headless end-to-end grounding & fidelity audit against the REAL baked
// Vipava Valley assets in `public/media/`:
//   - vipava_dem.png + vipava_dem_hd.png + vipava_meta.json (nested HD DEM)
//   - vipava_buildings.bin (FBLD v1 binary, 53k+ buildings)
//   - vipava_osm.json (12 iconic landmarks, 400+ bridged roads, 800 urbanZones)
//
// Run: node tests/grounding_audit_test.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';

import { HeightmapDEM, parseBuildingsBinary } from '../src/world/dem.js';
import { terrainHeight, setActiveDEM, setCustomAirports } from '../src/world/terrain.js';
import { BuildingSystem } from '../src/world/buildings.js';
import { LandmarkSystem } from '../src/world/landmarks.js';
import { buildRoadRibbonData } from '../src/world/roadnet.js';
import { QUALITY } from '../src/config.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MEDIA = path.join(ROOT, 'public', 'media');

const failures = [];
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

// ---------------------------------------------------------------------------
// Minimal pure-Node PNG decoder (8-bit RGB/RGBA, all 5 PNG filter modes)
// ---------------------------------------------------------------------------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRGBA(filePath) {
  const buf = fs.readFileSync(filePath);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error(`Invalid PNG signature: ${filePath}`);
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + len + 4;
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const raw = new Uint8Array(height * stride);
  const prev = new Uint8Array(stride);

  let inOff = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[inOff++];
    const rowOff = y * stride;
    for (let x = 0; x < stride; x++) {
      const f = inflated[inOff++];
      const a = x >= bpp ? raw[rowOff + x - bpp] : 0;
      const b = y > 0 ? prev[x] : 0;
      const c = (y > 0 && x >= bpp) ? prev[x - bpp] : 0;
      let v;
      if (filter === 0) v = f;
      else if (filter === 1) v = (f + a) & 0xff;
      else if (filter === 2) v = (f + b) & 0xff;
      else if (filter === 3) v = (f + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (f + paeth(a, b, c)) & 0xff;
      else throw new Error(`Unknown PNG filter ${filter}`);
      raw[rowOff + x] = v;
    }
    prev.set(raw.subarray(rowOff, rowOff + stride));
  }

  if (bpp === 4) return { width, height, pixels: raw };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 3, q += 4) {
    rgba[q] = raw[p];
    rgba[q + 1] = raw[p + 1];
    rgba[q + 2] = raw[p + 2];
    rgba[q + 3] = 255;
  }
  return { width, height, pixels: rgba };
}

function makeStubScene() {
  return {
    children: [],
    add(obj) { this.children.push(obj); obj.parent = this; },
    remove(obj) {
      const i = this.children.indexOf(obj);
      if (i >= 0) this.children.splice(i, 1);
      obj.parent = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Load real baked Vipava assets
// ---------------------------------------------------------------------------
const meta = JSON.parse(fs.readFileSync(path.join(MEDIA, 'vipava_meta.json'), 'utf8'));
const osm = JSON.parse(fs.readFileSync(path.join(MEDIA, 'vipava_osm.json'), 'utf8'));
const binBuf = fs.readFileSync(path.join(MEDIA, 'vipava_buildings.bin'));
const parsedBin = parseBuildingsBinary(binBuf);

check(!!parsedBin && parsedBin.count >= 25000,
  `vipava_buildings.bin failed parse or too small (${parsedBin?.count})`);

const basePng = decodePngRGBA(path.join(MEDIA, 'vipava_dem.png'));
const hdPng = decodePngRGBA(path.join(MEDIA, 'vipava_dem_hd.png'));

const dem = new HeightmapDEM({
  width: basePng.width,
  height: basePng.height,
  sizeM: meta.sizeM,
  offset: meta.offset,
  scale: meta.scale,
  pixels: basePng.pixels,
});
dem.meta = meta;

const hdDem = new HeightmapDEM({
  width: hdPng.width,
  height: hdPng.height,
  xMin: meta.hd.xMin,
  xMax: meta.hd.xMax,
  zMin: meta.hd.zMin,
  zMax: meta.hd.zMax,
  blendM: meta.hd.blendM,
  offset: meta.hd.offset,
  scale: meta.hd.scale,
  pixels: hdPng.pixels,
});
dem.setDetailDEM(hdDem);

let bSys = null;
let lmSys = null;
let buildingsAudited = 0;
let rebuildMsMax = 0;
let bridgedChecked = 0;
let bridgedPiersChecked = 0;

try {
  setActiveDEM(dem);
  setCustomAirports(meta.airports);

  // -------------------------------------------------------------------------
  // 1. HD Terrain Fidelity
  // -------------------------------------------------------------------------
  const lat0 = meta.lat0;
  const lon0 = meta.lon0;
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const toWorld = (lat, lon) => ({
    x: (lon - lon0) * mPerLon,
    z: -(lat - lat0) * mPerLat,
  });

  const svetaGoraLm = (osm.landmarks || []).find((l) => l && l.id === 'sveta-gora');
  const svetaGora = svetaGoraLm || toWorld(45.9993, 13.6557);
  const hSvetaGora = terrainHeight(svetaGora.x, svetaGora.z);
  check(hSvetaGora >= 640, `Sveta Gora summit too low (${fmt(hSvetaGora)} m, want >= 640 m)`);

  const hNanos = terrainHeight(12904.4, 12902.5);
  check(hNanos >= 1220, `Nanos plateau too low (${fmt(hNanos)} m, want >= 1220 m)`);

  const hLjaj = terrainHeight(0, 0);
  check(hLjaj >= 100 && hLjaj <= 130, `LJAJ elevation out of 100..130 m (got ${fmt(hLjaj)} m)`);

  const hSea = terrainHeight(-25000, 28000);
  check(hSea <= 2.0, `Adriatic sea elevation too high (${fmt(hSea)} m, want <= 2 m)`);

  // Smooth zero-jump seam check across all 4 boundaries of the HD inset.
  let maxSeamJump = 0;
  const seamProbes = [
    // East & West edges
    ...Array.from({ length: 20 }, (_, i) => {
      const z = -12000 + i * 1200;
      return [
        [meta.hd.xMin - 15, z, meta.hd.xMin + 15, z],
        [meta.hd.xMax - 15, z, meta.hd.xMax + 15, z],
      ];
    }).flat(),
    // North & South edges
    ...Array.from({ length: 20 }, (_, i) => {
      const x = -22000 + i * 1800;
      return [
        [x, meta.hd.zMin - 15, x, meta.hd.zMin + 15],
        [x, meta.hd.zMax - 15, x, meta.hd.zMax + 15],
      ];
    }).flat(),
  ];
  for (const [x1, z1, x2, z2] of seamProbes) {
    const jump = Math.abs(terrainHeight(x1, z1) - terrainHeight(x2, z2));
    if (jump > maxSeamJump) maxSeamJump = jump;
  }
  check(maxSeamJump < 25, `HD inset border has a cliff jump (${fmt(maxSeamJump)} m over 30 m)`);

  // -------------------------------------------------------------------------
  // 2. Zero Floating / Buried Buildings across ALL real baked buildings
  // -------------------------------------------------------------------------
  const bScene = makeStubScene();
  bSys = new BuildingSystem(bScene, QUALITY.medium);
  const custom = bSys.setCustomBuildings(parsedBin.records, osm.urbanZones);
  check(!!custom && custom.buildings.length >= 25000,
    `setCustomBuildings loaded only ${custom?.buildings?.length || 0} buildings`);

  let floatingCount = 0;
  let buriedCount = 0;
  let worstFloat = 0;
  let worstBuried = 0;

  for (let i = 0; i < custom.buildings.length; i++) {
    const b = custom.buildings[i];
    const g = bSys._ground(b);
    const c = Math.cos(b.rot);
    const s = Math.sin(b.rot);
    const hw = b.w * 0.5;
    const hd = b.d * 0.5;
    const h0 = terrainHeight(b.x - hw * c - hd * s, b.z + hw * s - hd * c);
    const h1 = terrainHeight(b.x + hw * c - hd * s, b.z - hw * s - hd * c);
    const h2 = terrainHeight(b.x - hw * c + hd * s, b.z + hw * s + hd * c);
    const h3 = terrainHeight(b.x + hw * c + hd * s, b.z - hw * s + hd * c);
    const minCornerY = Math.min(h0, h1, h2, h3);
    const maxCornerY = Math.max(h0, h1, h2, h3);

    const baseClear = minCornerY - g.base;
    if (baseClear < 2.5) {
      floatingCount++;
      worstFloat = Math.max(worstFloat, 2.5 - baseClear);
    }
    const roofClear = g.top - maxCornerY;
    if (roofClear < 1.5) {
      buriedCount++;
      worstBuried = Math.max(worstBuried, 1.5 - roofClear);
    }
    buildingsAudited++;
  }
  check(floatingCount === 0,
    `${floatingCount}/${buildingsAudited} baked buildings had shallow/floating corners (worst deficit ${fmt(worstFloat)} m)`);
  check(buriedCount === 0,
    `${buriedCount}/${buildingsAudited} baked buildings had buried roofs (worst deficit ${fmt(worstBuried)} m)`);

  // Verify hitBuilding() agrees with rendered bounding box on rotated buildings.
  let hitChecked = 0;
  let hitMissed = 0;
  for (let i = 0; i < custom.buildings.length && hitChecked < 25; i += 97) {
    const b = custom.buildings[i];
    if (Math.abs(b.rot) < 0.15 || b.h < 6 || b.w < 8 || b.d < 8) continue;
    const g = bSys._ground(b);
    const midY = (g.floorY + g.top) * 0.5;
    const c = Math.cos(b.rot);
    const s = Math.sin(b.rot);
    const off = b.w * 0.5 + 3;
    // Shoot straight into the +X local facade of `b` from just outside it.
    const from = { x: b.x + c * off, y: midY, z: b.z - s * off };
    const to = { x: b.x, y: midY, z: b.z };
    const hit = bSys.hitBuilding(from, to);
    hitChecked++;
    if (!hit) hitMissed++;
  }
  check(hitChecked >= 15, `too few rotated buildings sampled for hitBuilding (${hitChecked})`);
  check(hitMissed === 0, `hitBuilding missed ${hitMissed}/${hitChecked} rotated real buildings`);

  // -------------------------------------------------------------------------
  // 3. Procedural Distance Show/Hide LOD & Spatial-Grid Performance
  // -------------------------------------------------------------------------
  const towns = [
    { name: 'Ajdovscina', x: 0, y: 260, z: 0 },
    { name: 'Vipava', x: 5380, y: 300, z: 4150 },
    { name: 'Nova Gorica / Solkan', x: -18500, y: 300, z: -8500 },
  ];
  // Warm up JIT once.
  bSys.rebuild({ position: { x: 0, y: 260, z: 0 } });
  for (const tw of towns) {
    const t0 = performance.now();
    bSys.rebuild({ position: { x: tw.x, y: tw.y, z: tw.z } });
    const ms = performance.now() - t0;
    if (ms > rebuildMsMax) rebuildMsMax = ms;
    check(ms < 30, `${tw.name} rebuild took ${fmt(ms)} ms (want < 30 ms)`);
    check(bSys.stats.lod.close > 0, `${tw.name} had 0 close-LOD buildings`);
    check(bSys.stats.lod.far > 0, `${tw.name} had 0 far-LOD prominent buildings`);
    check(bSys.stats.lod.roofs > 0, `${tw.name} emitted 0 3D roofs`);
    check(bSys.stats.lod.plinths > 0, `${tw.name} emitted 0 stone plinths`);
  }

  // Verify distant town hides Tier 0 sheds while retaining Tier 2 structures.
  // Camera at (0, 200, 0): Nova Gorica is ~20 km away (Tier 2 only).
  bSys.rebuild({ position: { x: 0, y: 200, z: 0 } });
  const lodStream = bSys._streamBuildingsLOD(custom, 0, 0, 3600, 10500, 22000, 20000);
  let distantSheds = 0;
  let distantTier2 = 0;
  for (const item of lodStream) {
    const dist = Math.sqrt(item.d2);
    if (dist > 5000 && item.b.tier === 0) distantSheds++;
    if (dist > 12000 && item.b.tier === 2) distantTier2++;
  }
  check(distantSheds === 0, `${distantSheds} Tier 0 sheds leaked past 5 km`);
  check(distantTier2 > 0, 'no Tier 2 prominent skyline buildings kept past 12 km');

  // -------------------------------------------------------------------------
  // 4. Zero Floating / Buried Landmarks & Bridges (all 12 real landmarks)
  // -------------------------------------------------------------------------
  const lmScene = makeStubScene();
  lmSys = new LandmarkSystem(lmScene);
  const placed = lmSys.setLandmarks(osm.landmarks, terrainHeight);
  check(placed === 12, `expected 12 real landmarks placed, got ${placed}`);

  for (const lm of lmSys.landmarks) {
    lm.object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(lm.object);
    check(Number.isFinite(box.min.y) && Number.isFinite(box.max.y), `${lm.id} box not finite`);

    // Sample the real footprint span of this landmark on the HD DEM.
    const c = Math.cos(lm.rot || 0);
    const s = Math.sin(lm.rot || 0);
    const sc = lm.scale || 1;
    const halfX = lm.kind === 'bridge' || lm.kind === 'dam'
      ? (lm.length || 180) * 0.5
      : lm.kind === 'castle' ? 21 * sc : lm.kind === 'church' ? 10 * sc : 6;
    const halfZ = lm.kind === 'church' ? 22 * sc
      : lm.kind === 'castle' ? 21 * sc : 6;

    let minFootY = Infinity;
    let maxFootY = -Infinity;
    for (const fx of [-halfX, 0, halfX]) {
      for (const fz of [-halfZ, 0, halfZ]) {
        const wx = lm.x + fx * c + fz * s;
        const wz = lm.z - fx * s + fz * c;
        const h = terrainHeight(wx, wz);
        if (h < minFootY) minFootY = h;
        if (h > maxFootY) maxFootY = h;
      }
    }
    check(box.min.y <= minFootY - 3.5,
      `landmark ${lm.id} floats (box.min.y=${fmt(box.min.y)}, minFootY=${fmt(minFootY)})`);
    check(box.max.y >= maxFootY + 5.0,
      `landmark ${lm.id} buried/flat (box.max.y=${fmt(box.max.y)}, maxFootY=${fmt(maxFootY)})`);

    if (lm.id === 'solkan-bridge' || lm.id === 'vipava-bridge') {
      const metaB = lm._groundMeta;
      check(!!metaB && Array.isArray(metaB.pierGrounds) && metaB.pierGrounds.length >= 4,
        `${lm.id} missing grounded piers metadata`);
      if (metaB && metaB.pierGrounds) {
        for (const pg of metaB.pierGrounds) {
          check(pg.pierBot <= pg.gPier - 4.0,
            `${lm.id} pier at px=${fmt(pg.px)} floats (bot=${fmt(pg.pierBot)}, g=${fmt(pg.gPier)})`);
          check(pg.deckY > pg.gPier + 0.5,
            `${lm.id} deck buried at px=${fmt(pg.px)} (deck=${fmt(pg.deckY)}, g=${fmt(pg.gPier)})`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Real OSM Road Bridges on HD DEM
  // -------------------------------------------------------------------------
  const bridgedRaw = (osm.roads || []).filter((r) => r && r.b === 1 && Array.isArray(r.pts) && r.pts.length >= 2);
  check(bridgedRaw.length >= 15, `expected >= 15 bridged OSM roads, got ${bridgedRaw.length}`);
  const bridgedPolys = bridgedRaw.map((r) => ({
    width: Math.min(r.w || 9, 10.5),
    bridge: true,
    points: r.pts.map((p) => ({ x: p[0], z: p[1] })),
  }));
  const roadData = buildRoadRibbonData(bridgedPolys, terrainHeight);
  bridgedChecked = roadData.bridgeCount;
  bridgedPiersChecked = roadData.piers.length;
  check(roadData.bridgeCount > 0, 'bridged OSM roads produced bridgeCount === 0');
  check(roadData.piers.length > 0, 'bridged OSM roads produced 0 piers');

  let buriedRoadVerts = 0;
  for (let i = 0; i < roadData.positions.length / 3; i++) {
    if (i % 4 >= 2) continue;
    const x = roadData.positions[i * 3];
    const y = roadData.positions[i * 3 + 1];
    const z = roadData.positions[i * 3 + 2];
    const h = terrainHeight(x, z);
    if (y < h + 0.2) buriedRoadVerts++;
  }
  check(buriedRoadVerts === 0, `${buriedRoadVerts} bridged OSM road deck vertices dipped below terrain`);

  let floatingPiers = 0;
  for (const pr of roadData.piers) {
    const h = terrainHeight(pr.x, pr.z);
    if (pr.bottomY > h - 3.0) floatingPiers++;
  }
  check(floatingPiers === 0, `${floatingPiers}/${roadData.piers.length} OSM road bridge piers floated above ground`);

  console.log('Feature 41 — Vipava real-asset grounding & fidelity audit');
  console.log('=========================================================');
  console.log(`HD terrain      : Sveta Gora ${fmt(hSvetaGora)} m, Nanos ${fmt(hNanos)} m, LJAJ ${fmt(hLjaj)} m, Sea ${fmt(hSea)} m, max seam ${fmt(maxSeamJump)} m`);
  console.log(`buildings       : ${buildingsAudited} audited (0 floating, 0 buried), hitBuilding ${hitChecked}/${hitChecked}`);
  console.log(`spatial LOD     : max rebuild ${fmt(rebuildMsMax)} ms, close/mid/far active, 0 distant sheds`);
  console.log(`landmarks       : ${placed}/12 grounded (Solkan & Vipava H4 piers verified)`);
  console.log(`OSM bridges     : ${bridgedChecked} bridged spans, ${bridgedPiersChecked} grounded piers`);
  console.log(`checks: ${checks}, failures: ${failures.length}`);
} finally {
  bSys?.dispose();
  lmSys?.dispose();
  setActiveDEM(null);
  setCustomAirports(null);
}

if (failures.length) {
  console.error('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.error('  - ' + f);
  if (failures.length > 30) console.error(`  ... and ${failures.length - 30} more`);
  process.exit(1);
}
console.log('\nALL VIPAVA GROUNDING & FIDELITY CHECKS PASSED');
process.exit(0);
