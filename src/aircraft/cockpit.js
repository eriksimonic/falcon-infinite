// F-16C Block 50 (Viper) cockpit interior.
//
// Architecture notes:
//  - Every static detail is merged into a handful of per-material BufferGeometry
//    batches (GeoBatch) and every repeated part (OSB buttons, console switches,
//    ICP keys, rivets) is a single InstancedMesh, so the whole 10x-detail
//    interior stays well under the 75-mesh cockpit budget.
//  - A cockpit-only SpotLight (cockpitSun) rakes a 1024^2 shadow map across a
//    ~2.5 m cone (≈2.4 mm per shadow texel) and is hidden outside the cockpit
//    view / at night / in heavy overcast, so it costs nothing in external views.
//  - Everything DOM-dependent is behind HAS_DOM: importing this module in
//    headless Node is completely safe.
import * as THREE from 'three';

const HAS_DOM = typeof document !== 'undefined';

const C = {
  panel: 0x424844,
  panelDark: 0x2c312d,
  panelLight: 0x4f554d,
  seat: 0x556248,
  harness: 0x8a8568,
  metal: 0x9aa1a5,
  anodized: 0x25292c,
  suit: 0x4b5340,
  glove: 0x2c3229,
  hudGreen: '#7dff9f',
};

const _sunLocal = new THREE.Vector3();
const _sunWorld = new THREE.Vector3();
const _invQ = new THREE.Quaternion();
const _sunTarget = new THREE.Vector3(0, 0.72, -2.78);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Pure cockpit indicator logic (headless-safe: no DOM / WebGL touched)
// ---------------------------------------------------------------------------
export function computeCockpitIndicators(flight, env = {}) {
  const f = flight || {};
  const e = env || {};

  const aoaDeg = (f.aoa || 0) * (180 / Math.PI);
  const gearDown = (f.gearPos ?? 0) > 0.5;

  // AoA indexer: amber up-chevron = slow/high AoA, green donut = on-speed,
  // red down-chevron = fast/low AoA. Only lit airborne with gear down.
  let aoaState = 'off';
  if (gearDown && !f.onGround) {
    if (aoaDeg > 13.0) aoaState = 'slow';
    else if (aoaDeg >= 10.0) aoaState = 'onspeed';
    else aoaState = 'fast';
  }

  // Master caution: stall, overspeed, low fuel, RWR threat or flameout.
  const kts = (f.speed || 0) * 1.94384;
  const cautionActive = !!(f.stall || kts > 620 || e.lowFuel || e.rwrThreat || e.flameout);
  const cautionFlash = cautionActive ? (Math.sin((e.time || 0) * 10) > -0.25) : false;

  // Night backlighting / NVG-friendly flood.
  const night = Math.max(0, Math.min(1, e.night || 0));
  const panelEmissive = 0.7 + night * 1.4;
  const floodIntensity = 1.6 + night * 2.4;

  // Canopy rain streaks.
  const rain = Math.max(0, Math.min(1, e.rain || 0));
  const rainOpacity = rain > 0.05 ? Math.min(0.65, rain * 0.65) : 0;
  const rainScrollSpeed = 0.6 + Math.min(3.5, (f.speed || 0) / 70);

  return {
    aoaState,
    cautionActive,
    cautionFlash,
    panelEmissive,
    floodIntensity,
    rainOpacity,
    rainScrollSpeed,
  };
}

// ---------------------------------------------------------------------------
// Screen / decal canvases
// ---------------------------------------------------------------------------
function canvasTex(w, h, draw) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  // Panel screens are read at about 1:1 from the seat: a mip chain costs a
  // full generateMipmaps() pass per 10 Hz redraw and buys nothing.
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return { canvas: c, ctx, tex: t };
}

function repaint(tex, draw) {
  if (!tex) return;
  draw(tex.ctx);
  tex.tex.needsUpdate = true;
}

function screenMaterial(tex, fallback = 0x061009) {
  return tex
    ? new THREE.MeshBasicMaterial({ map: tex.tex, toneMapped: false })
    : new THREE.MeshBasicMaterial({ color: fallback, toneMapped: false });
}

function seeded(seedIn) {
  let seed = seedIn >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// Deterministic matte pebble/wrinkle finish for the glare shield and sill
// rails. Returns null in headless Node (no DOM, no canvas).
function createGlareTexture() {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c6cac3';
  ctx.fillRect(0, 0, 256, 256);
  const rnd = seeded(0x1f123bb5);
  for (let i = 0; i < 5400; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const r = 0.4 + rnd() * 1.9;
    const v = 150 + Math.floor(rnd() * 92);
    ctx.fillStyle = `rgba(${v},${v + 4},${v - 3},${(0.08 + rnd() * 0.24).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Weathered machined edge scuffs.
  ctx.lineWidth = 0.9;
  for (let i = 0; i < 110; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    ctx.strokeStyle = `rgba(214,218,210,${(0.04 + rnd() * 0.10).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 30, y + (rnd() - 0.5) * 7);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  t.anisotropy = 4;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}

// ---------------------------------------------------------------------------
// Geometry batching (keeps the draw-call budget tiny without addons)
// ---------------------------------------------------------------------------
const _bm4 = new THREE.Matrix4();
const _bq = new THREE.Quaternion();
const _be = new THREE.Euler();
const _bp = new THREE.Vector3();
const _bs = new THREE.Vector3();

function mergeGeoms(parts) {
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let off = 0;
  for (const g of parts) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;
    pos.set(p.array, off * 3);
    if (n) nor.set(n.array, off * 3);
    if (t) uv.set(t.array, off * 2);
    off += p.count;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

class GeoBatch {
  constructor(material) {
    this.material = material;
    this.parts = [];
  }

  add(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    _bq.setFromEuler(_be.set(rx, ry, rz));
    _bm4.compose(_bp.set(x, y, z), _bq, _bs.set(sx, sy, sz));
    g.applyMatrix4(_bm4);
    this.parts.push(g);
    return this;
  }

  box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
    return this.add(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  }

  cyl(rTop, rBot, h, seg, x, y, z, rx = 0, ry = 0, rz = 0) {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), x, y, z, rx, ry, rz);
  }

  sphere(r, x, y, z, wSeg = 8, hSeg = 6) {
    return this.add(new THREE.SphereGeometry(r, wSeg, hSeg), x, y, z);
  }

  torus(r, tube, rSeg, tSeg, x, y, z, rx = 0, ry = 0, rz = 0) {
    return this.add(new THREE.TorusGeometry(r, tube, rSeg, tSeg), x, y, z, rx, ry, rz);
  }

  build(parent, name) {
    if (!this.parts.length) return null;
    const mesh = new THREE.Mesh(mergeGeoms(this.parts), this.material);
    if (name) mesh.name = name;
    this.parts = [];
    parent.add(mesh);
    return mesh;
  }
}

const _im4 = new THREE.Matrix4();
const _imq = new THREE.Quaternion();
const _ime = new THREE.Euler();
const _imv = new THREE.Vector3();
const _ims = new THREE.Vector3();

function setInstance(im, i, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _imq.setFromEuler(_ime.set(rx, ry, rz));
  _im4.compose(_imv.set(x, y, z), _imq, _ims.set(sx, sy, sz));
  im.setMatrixAt(i, _im4);
}

// ---------------------------------------------------------------------------
// Screen drawing
// ---------------------------------------------------------------------------
function drawADI(ctx, W, H, t) {
  ctx.fillStyle = '#04100a';
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-t.roll * Math.PI) / 180);
  const pitchPx = (t.pitch * Math.PI) / 180 * 2.1;
  ctx.translate(0, pitchPx);

  // sky / ground
  ctx.fillStyle = '#0d3f2a';
  ctx.fillRect(-W, -H * 2, W * 2, H * 2);
  ctx.fillStyle = '#3d2a13';
  ctx.fillRect(-W, 0, W * 2, H * 2);
  ctx.strokeStyle = '#8dffb4';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-W, 0);
  ctx.lineTo(W, 0);
  ctx.stroke();

  // pitch ladder
  ctx.font = '11px monospace';
  ctx.fillStyle = '#8dffb4';
  ctx.textAlign = 'center';
  for (let d = -30; d <= 30; d += 10) {
    if (d === 0) continue;
    const y = -d * 2.1;
    const w = d % 20 === 0 ? 46 : 28;
    ctx.beginPath();
    ctx.moveTo(-w, y);
    ctx.lineTo(-14, y);
    ctx.moveTo(14, y);
    ctx.lineTo(w, y);
    ctx.strokeStyle = '#5fae76';
    ctx.stroke();
    ctx.fillText(String(Math.abs(d)), -w - 14, y + 4);
  }
  ctx.restore();

  // aircraft reference
  ctx.strokeStyle = '#c8ffd8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 34, cy);
  ctx.lineTo(cx - 12, cy);
  ctx.lineTo(cx - 5, cy + 7);
  ctx.moveTo(cx + 34, cy);
  ctx.lineTo(cx + 12, cy);
  ctx.lineTo(cx + 5, cy + 7);
  ctx.stroke();

  // data blocks
  ctx.font = 'bold 12px monospace';
  ctx.fillStyle = '#8dffb4';
  ctx.textAlign = 'left';
  ctx.fillText('SPD', 10, 20);
  ctx.font = 'bold 17px monospace';
  ctx.fillText(String(Math.round(t.kts)).padStart(3, '0'), 10, 38);
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('ALT', W - 10, 20);
  ctx.font = 'bold 17px monospace';
  ctx.fillText((Math.round(t.altFt / 10) * 10).toString(), W - 10, 38);
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('G ' + t.g.toFixed(1), 10, H - 26);
  ctx.fillText('AOA ' + (t.aoa * 57.3).toFixed(1), 10, H - 14);
  ctx.textAlign = 'right';
  ctx.fillText('VS ' + Math.round(t.vs / 100) * 100, W - 10, H - 26);
  ctx.fillText(t.gear ? 'GEAR DN' : 'GEAR UP', W - 10, H - 14);
  if (t.stall) {
    ctx.fillStyle = '#ff5b4a';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('STALL', W / 2, H - 16);
  }
}

function drawHSI(ctx, W, H, t) {
  ctx.fillStyle = '#04100a';
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2 + 8;
  const R = W * 0.34;

  ctx.strokeStyle = '#3f8a5a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();

  // compass rose
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-t.heading * Math.PI) / 180);
  ctx.font = '10px monospace';
  ctx.fillStyle = '#8dffb4';
  ctx.textAlign = 'center';
  for (let a = 0; a < 360; a += 10) {
    const rad = (a * Math.PI) / 180;
    const big = a % 30 === 0;
    const r1 = R - (big ? 12 : 6);
    ctx.beginPath();
    ctx.moveTo(Math.sin(rad) * r1, -Math.cos(rad) * r1);
    ctx.lineTo(Math.sin(rad) * R, -Math.cos(rad) * R);
    ctx.strokeStyle = big ? '#8dffb4' : '#3f8a5a';
    ctx.stroke();
    if (a % 90 === 0) {
      const lbl = ['N', 'E', 'S', 'W'][a / 90];
      ctx.fillText(lbl, Math.sin(rad) * (R - 24), -Math.cos(rad) * (R - 24) + 4);
    }
  }
  // waypoint
  if (t.airport) {
    const brg = ((t.airport.bearing - t.heading) * Math.PI) / 180;
    ctx.strokeStyle = '#ffd479';
    ctx.fillStyle = '#ffd479';
    ctx.beginPath();
    ctx.moveTo(cx + Math.sin(brg) * R * 0.86, cy - Math.cos(brg) * R * 0.86);
    ctx.lineTo(cx + Math.sin(brg + 0.05) * R * 0.72, cy - Math.cos(brg + 0.05) * R * 0.72);
    ctx.lineTo(cx + Math.sin(brg - 0.05) * R * 0.72, cy - Math.cos(brg - 0.05) * R * 0.72);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // aircraft symbol
  ctx.strokeStyle = '#e7fff0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 14);
  ctx.lineTo(cx, cy + 14);
  ctx.moveTo(cx - 10, cy);
  ctx.lineTo(cx + 10, cy);
  ctx.stroke();

  // heading readout
  ctx.fillStyle = '#8dffb4';
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(String(Math.round(t.heading)).padStart(3, '0') + '°', cx, 26);

  if (t.airport) {
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(t.airport.code || '----', 10, H - 28);
    ctx.fillText((t.airport.name || '').slice(0, 20), 10, H - 16);
    ctx.textAlign = 'right';
    ctx.fillText((t.airport.dist / 1000).toFixed(1) + ' NM', W - 10, H - 16);
  }
  // wind
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#7fbf94';
  ctx.fillText('WIND ' + String(Math.round(t.windDir)).padStart(3, '0') + '/' + Math.round(t.windKts), cx, H - 6);
}

// Center pedestal EHSI / ADI: sky-ground, pitch ladder, bank scale, compass
// rose, course pointer and glide-slope deviation bars.
function drawEHSI(ctx, W, H, t) {
  ctx.fillStyle = '#04100a';
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H * 0.33;

  // attitude area
  ctx.save();
  ctx.beginPath();
  ctx.rect(6, 26, W - 12, H * 0.42);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate((-t.roll * Math.PI) / 180);
  ctx.translate(0, ((t.pitch * Math.PI) / 180) * 2.0);
  ctx.fillStyle = '#0d4a30';
  ctx.fillRect(-W, -H, W * 2, H);
  ctx.fillStyle = '#4a3418';
  ctx.fillRect(-W, 0, W * 2, H);
  ctx.strokeStyle = '#9dffc0';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-W, 0);
  ctx.lineTo(W, 0);
  ctx.stroke();
  ctx.strokeStyle = '#6fc48b';
  ctx.lineWidth = 1;
  for (let d = -25; d <= 25; d += 5) {
    if (d === 0) continue;
    const y = -d * 1.9;
    const w = d % 10 === 0 ? 28 : 17;
    ctx.beginPath();
    ctx.moveTo(-w, y);
    ctx.lineTo(-8, y);
    ctx.moveTo(8, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();

  // bank scale
  ctx.save();
  ctx.translate(cx, cy + 8);
  ctx.strokeStyle = '#8dffb4';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, W * 0.36, Math.PI * 1.18, Math.PI * 1.82);
  ctx.stroke();
  for (let a = -60; a <= 60; a += 15) {
    const rad = (a * Math.PI) / 180 - Math.PI / 2;
    const r0 = W * 0.34;
    const r1 = W * 0.36 + (a % 30 === 0 ? 4 : 2);
    ctx.beginPath();
    ctx.moveTo(Math.cos(rad) * r0, Math.sin(rad) * r0);
    ctx.lineTo(Math.cos(rad) * r1, Math.sin(rad) * r1);
    ctx.stroke();
  }
  const bank = (-t.roll * Math.PI) / 180 - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(Math.cos(bank) * W * 0.33, Math.sin(bank) * W * 0.33);
  ctx.lineTo(Math.cos(bank - 0.04) * W * 0.37, Math.sin(bank - 0.04) * W * 0.37);
  ctx.lineTo(Math.cos(bank + 0.04) * W * 0.37, Math.sin(bank + 0.04) * W * 0.37);
  ctx.closePath();
  ctx.fillStyle = '#e7fff0';
  ctx.fill();
  ctx.restore();

  // aircraft reference
  ctx.strokeStyle = '#e7fff0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 26, cy);
  ctx.lineTo(cx - 8, cy);
  ctx.lineTo(cx - 3, cy + 5);
  ctx.moveTo(cx + 26, cy);
  ctx.lineTo(cx + 8, cy);
  ctx.lineTo(cx + 3, cy + 5);
  ctx.stroke();

  // compass rose (lower half)
  const ry = H * 0.80;
  const R = W * 0.30;
  ctx.strokeStyle = '#3f8a5a';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, ry, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.save();
  ctx.translate(cx, ry);
  ctx.rotate((-t.heading * Math.PI) / 180);
  for (let a = 0; a < 360; a += 15) {
    const rad = (a * Math.PI) / 180;
    const r0 = R - (a % 45 === 0 ? 10 : 5);
    ctx.beginPath();
    ctx.moveTo(Math.sin(rad) * r0, -Math.cos(rad) * r0);
    ctx.lineTo(Math.sin(rad) * R, -Math.cos(rad) * R);
    ctx.strokeStyle = a % 45 === 0 ? '#8dffb4' : '#3f8a5a';
    ctx.stroke();
  }
  ctx.restore();
  // course pointer
  ctx.strokeStyle = '#ffd479';
  ctx.lineWidth = 2;
  const course = ((t.heading + 12) * Math.PI) / 180;
  ctx.beginPath();
  ctx.moveTo(cx, ry);
  ctx.lineTo(cx + Math.sin(course) * R * 0.92, ry - Math.cos(course) * R * 0.92);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, ry, 4, 0, Math.PI * 2);
  ctx.stroke();

  // glide slope / speed deviation bars
  ctx.strokeStyle = '#8dffb4';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(10, H * 0.48, 10, H * 0.28);
  ctx.strokeRect(W - 20, H * 0.48, 10, H * 0.28);
  const gs = clamp01(0.5 + Math.sin(t.heading * 0.02) * 0.3);
  ctx.fillStyle = '#ffd479';
  ctx.fillRect(11, H * 0.48 + gs * (H * 0.28 - 6), 8, 4);

  // heading + range data
  ctx.fillStyle = '#8dffb4';
  ctx.font = 'bold 15px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(String(Math.round(t.heading)).padStart(3, '0') + '°', cx, H * 0.62);
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('CRS ' + String(Math.round(((t.heading + 12) % 360))).padStart(3, '0'), 8, 18);
  ctx.textAlign = 'right';
  ctx.fillText('GS ' + Math.round(t.kts) + 'KT', W - 8, 18);
  ctx.textAlign = 'center';
  ctx.fillText((t.gear ? 'GEAR DN' : 'GEAR UP'), cx, H - 6);
}

function drawICP(ctx, W, H) {
  ctx.fillStyle = '#0a1a10';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#1f3a2a';
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  ctx.fillStyle = '#8dffb4';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('STEER 04', 7, 18);
  ctx.font = '11px monospace';
  ctx.fillStyle = '#c8ffd8';
  ctx.fillText('142.300', 7, 34);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#8dffb4';
  ctx.fillText('CAT I', W - 7, 18);
  ctx.fillText('ILS 21', W - 7, 34);
}

function drawDED(ctx, W, H) {
  ctx.fillStyle = '#06130b';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#8dffb4';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  const lines = [
    'VIPER  1.03',
    'UHF  251.000',
    'TACAN 098X',
    'STPT 04  142.3',
    'CAT III',
    'WIND 210/12',
  ];
  for (let i = 0; i < lines.length; i++) {
    ctx.fillStyle = i === 0 ? '#c8ffd8' : '#8dffb4';
    ctx.fillText(lines[i], 6, 13 + i * 9);
  }
}

function drawRWR(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#04100a';
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2;
  const R = W * 0.42;
  ctx.strokeStyle = '#2f7a4a';
  ctx.lineWidth = 1.5;
  for (const k of [0.34, 0.68, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * k, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = '#1f5232';
  ctx.lineWidth = 1;
  for (let a = 0; a < 360; a += 30) {
    const rad = (a * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx + Math.sin(rad) * R * 0.3, cy - Math.cos(rad) * R * 0.3);
    ctx.lineTo(cx + Math.sin(rad) * R, cy - Math.cos(rad) * R);
    ctx.stroke();
  }
  // deterministic threat blips
  const blips = [[42, 0.55, '#ffd479'], [128, 0.35, '#ff7a5c'], [256, 0.78, '#ffd479'], [318, 0.45, '#8dffb4']];
  for (const [az, rad, col] of blips) {
    const a = (az * Math.PI) / 180;
    const x = cx + Math.sin(a) * R * rad;
    const y = cy - Math.cos(a) * R * rad;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 4, y + 4);
    ctx.lineTo(x - 4, y + 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = '#8dffb4';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('ALR-56M', cx, H - 6);
  ctx.fillStyle = '#c8ffd8';
  ctx.font = '8px monospace';
  ctx.fillText('SEARCH', cx, 12);
}

function drawAnnunciator(ctx, W, H) {
  ctx.fillStyle = '#131614';
  ctx.fillRect(0, 0, W, H);
  const labels = [['FIRE', '#ff5b3a'], ['HYD', '#ffcf5a'], ['OIL', '#ff5b3a']];
  const w = W / 3;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = '#0a0c0b';
    ctx.fillRect(4 + i * w, 4, w - 8, H - 8);
    ctx.fillStyle = labels[i][1];
    ctx.globalAlpha = 0.35;
    ctx.fillRect(6 + i * w, 6, w - 12, H - 12);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0c0e0d';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(labels[i][0], 4 + i * w + w / 2, H / 2 + 4);
  }
}

function drawCautionPanel(ctx, W, H) {
  ctx.fillStyle = '#151816';
  ctx.fillRect(0, 0, W, H);
  const cells = [
    ['ENG', '#3ad96a'], ['FUEL', '#d9b23a'], ['HYD', '#3a7ad9'],
    ['ELEC', '#d9b23a'], ['GEAR', '#3ad96a'], ['FLCS', '#d94a3a'],
    ['OXY', '#3a7ad9'], ['CANOPY', '#d9b23a'],
  ];
  const cw = W / 4;
  const ch = H / 2;
  for (let i = 0; i < cells.length; i++) {
    const x = (i % 4) * cw;
    const y = Math.floor(i / 4) * ch;
    ctx.fillStyle = '#0b0d0c';
    ctx.fillRect(x + 3, y + 3, cw - 6, ch - 6);
    ctx.fillStyle = cells[i][1];
    ctx.globalAlpha = 0.32;
    ctx.fillRect(x + 4, y + 4, cw - 8, ch - 8);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#cfe6d6';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(cells[i][0], x + cw / 2, y + ch / 2 + 3);
  }
}

function drawJettison(ctx, W, H) {
  ctx.fillStyle = '#1b1d1a';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(2, 2, W - 4, H - 4);
  ctx.clip();
  for (let i = -H; i < W + H; i += 14) {
    ctx.strokeStyle = '#d9b23a';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + H, H);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = '#141512';
  ctx.fillRect(W * 0.16, H * 0.22, W * 0.68, H * 0.56);
  ctx.fillStyle = '#ffd479';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('EMER JETT', W / 2, H * 0.62);
}

function drawConsoles(ctx, W, H) {
  ctx.fillStyle = '#1c211d';
  ctx.fillRect(0, 0, W, H);
  const panels = ['COMM', 'NAV', 'IFF', 'ECM', 'LIGHT', 'FUEL'];
  const cw = (W - 16) / 2;
  const ch = (H - 20) / 3;
  for (let i = 0; i < 6; i++) {
    const x = 6 + (i % 2) * (cw + 4);
    const y = 6 + Math.floor(i / 2) * (ch + 4);
    ctx.fillStyle = '#262c27';
    ctx.fillRect(x, y, cw, ch);
    ctx.strokeStyle = '#3b443c';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    ctx.fillStyle = '#93b096';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(panels[i], x + 4, y + 11);
    // sub-panel legends + screw heads
    ctx.fillStyle = '#71876f';
    ctx.font = '7px monospace';
    for (let r = 0; r < 3; r++) ctx.fillText(['A', 'B', 'C'][r] + '  ON', x + 4, y + 24 + r * 11);
    ctx.fillStyle = '#4a534b';
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.arc(x + 6 + (k % 2) * (cw - 12), y + 6 + Math.floor(k / 2) * (ch - 12), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Small 64x64 standby-gauge face for the center pedestal cluster.
function drawMiniGauge(ctx, W, H, label, value, max, unit) {
  ctx.fillStyle = '#0b0f0c';
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2 + 2;
  const R = W * 0.44;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = '#090c0a';
  ctx.fill();
  ctx.strokeStyle = '#3d4a40';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.strokeStyle = '#8dffb4';
  ctx.lineWidth = 0.8;
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI * 0.78 + (i / 8) * Math.PI * 1.44;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * 0.78, cy + Math.sin(a) * R * 0.78);
    ctx.lineTo(cx + Math.cos(a) * R * 0.94, cy + Math.sin(a) * R * 0.94);
    ctx.stroke();
  }
  const frac = Math.min(1, Math.max(0, value / max));
  const a = Math.PI * 0.78 + frac * Math.PI * 1.44;
  ctx.strokeStyle = '#e8fff0';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * R * 0.7, cy + Math.sin(a) * R * 0.7);
  ctx.stroke();
  ctx.fillStyle = '#8dffb4';
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, cx, 10);
  ctx.fillText(Math.round(value) + unit, cx, H - 4);
}

// ---------------------------------------------------------------------------
// Canopy rain streak texture (deterministic procedural streaks + droplets)
// ---------------------------------------------------------------------------
function drawRainStreaks(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  const rnd = seeded(0x9e3779b9);
  ctx.lineCap = 'round';
  for (let i = 0; i < 110; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const len = 16 + rnd() * 96;
    const lean = 0.10 + rnd() * 0.16;
    const alpha = 0.05 + rnd() * 0.20;
    ctx.strokeStyle = `rgba(198, 226, 240, ${alpha.toFixed(3)})`;
    ctx.lineWidth = 0.6 + rnd() * 1.9;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len * lean, y + len);
    ctx.stroke();
  }
  for (let i = 0; i < 46; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const r = 0.6 + rnd() * 2.4;
    ctx.fillStyle = `rgba(210, 235, 246, ${(0.05 + rnd() * 0.16).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 1.7, 0.15, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
export function createCockpit() {
  const group = new THREE.Group();
  group.name = 'cockpit';

  // ---- shared materials (every detail reuses these instances) ------------
  const matPanel = new THREE.MeshStandardMaterial({
    color: C.panel, roughness: 0.82, metalness: 0.14,
    emissive: 0x18201a, emissiveIntensity: 1.0,
  });
  const matDark = new THREE.MeshStandardMaterial({
    color: C.panelDark, roughness: 0.78, metalness: 0.18,
    emissive: 0x111713, emissiveIntensity: 1.0,
  });
  const matLight = new THREE.MeshStandardMaterial({
    color: C.panelLight, roughness: 0.74, metalness: 0.16,
    emissive: 0x171d18, emissiveIntensity: 1.0,
  });
  const matMetal = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.32, metalness: 0.85 });
  const matSwitch = new THREE.MeshStandardMaterial({ color: 0xe8ece6, roughness: 0.42, metalness: 0.55 });
  const matAnod = new THREE.MeshStandardMaterial({ color: C.anodized, roughness: 0.46, metalness: 0.72 });
  const matBlack = new THREE.MeshStandardMaterial({ color: 0x141716, roughness: 0.62, metalness: 0.2 });
  const matSeat = new THREE.MeshStandardMaterial({
    color: C.seat, roughness: 0.9, metalness: 0.04, emissive: 0x0c100a, emissiveIntensity: 0.8,
  });
  const matHarness = new THREE.MeshStandardMaterial({ color: C.harness, roughness: 0.9 });
  const matSuit = new THREE.MeshStandardMaterial({ color: C.suit, roughness: 0.88, metalness: 0.03 });
  const matGlove = new THREE.MeshStandardMaterial({ color: C.glove, roughness: 0.76, metalness: 0.08 });
  const matWhite = new THREE.MeshStandardMaterial({ color: 0xe6e8e2, roughness: 0.55, metalness: 0.1 });

  // Matte pebble coaming: the canvas texture doubles as a bump map so the
  // low sun rakes real texture across the glare shield.
  const glareTex = createGlareTexture();
  const matGlare = new THREE.MeshStandardMaterial({
    color: 0x3a403a, map: glareTex || null, bumpMap: glareTex || null, bumpScale: 0.0022,
    roughness: 0.94, metalness: 0.06, emissive: 0x0d110d, emissiveIntensity: 0.7,
  });
  const matStripe = new THREE.MeshBasicMaterial({
    map: (HAS_DOM ? canvasTex(128, 32, drawJettison) : null)?.tex || null,
    color: 0xffffff, toneMapped: false,
  });
  const consoleTex = canvasTex(192, 288, drawConsoles);
  const matConsole = screenMaterial(consoleTex, 0x232824);

  // ---- static geometry batches -------------------------------------------
  const bGlare = new GeoBatch(matGlare);
  const bPanel = new GeoBatch(matPanel);
  const bDark = new GeoBatch(matDark);
  const bLight = new GeoBatch(matLight);
  const bMetal = new GeoBatch(matMetal);
  const bAnod = new GeoBatch(matAnod);
  const bBlack = new GeoBatch(matBlack);
  const bSeat = new GeoBatch(matSeat);
  const bHarness = new GeoBatch(matHarness);
  const bWhite = new GeoBatch(matWhite);

  // ---- tub / floor -------------------------------------------------------
  bDark.box(0.98, 0.05, 2.62, 0, 0.24, -2.30);
  // non-slip floor treads
  for (let i = 0; i < 7; i++) {
    bPanel.box(0.86, 0.012, 0.035, 0, 0.268, -3.42 + i * 0.30);
  }
  for (const side of [-1, 1]) {
    bPanel.box(0.05, 0.50, 2.48, side * 0.52, 0.51, -2.25);
    // angled side coamings from console to canopy sill
    bPanel.box(0.055, 0.24, 2.15, side * 0.535, 0.69, -2.45, 0, 0, side * -0.06);
    // kick panels closing the forward corners
    bDark.box(0.05, 0.42, 0.55, side * 0.51, 0.51, -3.45);
  }
  // aft bulkhead
  bDark.box(1.02, 0.72, 0.07, 0, 0.58, -0.96);
  // front lower dash shelf closing the tub under the windshield
  bDark.box(0.96, 0.08, 0.36, 0, 0.44, -3.56);
  bAnod.box(0.98, 0.14, 0.08, 0, 0.52, -3.72);
  // rear canopy bow behind the seat
  bPanel.add(new THREE.TorusGeometry(0.54, 0.02, 6, 22, Math.PI), 0, 0.76, -1.00, 0, 0, 0, 1, 0.66, 1);

  // ---- heavy machined canopy sill rails ----------------------------------
  for (const side of [-1, 1]) {
    const x = side * 0.545;
    bAnod.box(0.08, 0.062, 2.44, x, 0.792, -2.28);
    bMetal.box(0.092, 0.016, 2.44, x, 0.826, -2.28);
    bAnod.box(0.06, 0.03, 2.44, x, 0.758, -2.28);
    // rail tube
    bMetal.cyl(0.021, 0.021, 2.44, 8, x, 0.742, -2.28, Math.PI / 2, 0, 0);
    // canopy locking hooks
    for (let i = 0; i < 4; i++) {
      bMetal.box(0.028, 0.05, 0.045, x - side * 0.03, 0.762, -3.16 + i * 0.62);
    }
    // grab handle
    bMetal.torus(0.042, 0.008, 5, 10, side * 0.50, 0.845, -2.02, 0, Math.PI / 2, 0);
    // yellow/black jettison striping on the outer sill face
    bMetal.box(0.006, 0.04, 0.17, side * 0.588, 0.79, -1.62);
  }
  {
    const stripes = new GeoBatch(matStripe);
    for (const side of [-1, 1]) {
      stripes.add(new THREE.PlaneGeometry(0.165, 0.036), side * 0.5905, 0.79, -1.62, 0, side * Math.PI / 2, 0);
    }
    stripes.build(group, 'sillJettisonStripes');
  }

  // ---- 3-tier sculpted glare shield --------------------------------------
  // Tier 1 (front bevel lip), tier 2 (main shelf), tier 3 (aft eyebrow
  // shelves either side of the ICP gap).
  bGlare.box(1.24, 0.042, 0.19, 0, 0.982, -3.567, 0.12, 0, 0);
  bGlare.box(1.26, 0.018, 0.075, 0, 1.002, -3.652, 0.34, 0, 0);
  bGlare.box(1.30, 0.05, 0.27, 0, 1.004, -3.412);
  for (const side of [-1, 1]) {
    bGlare.box(0.50, 0.045, 0.20, side * 0.375, 0.9925, -3.268, 0, 0, side * 0.02);
    bGlare.box(0.075, 0.05, 0.30, side * 0.615, 0.994, -3.42, 0, 0, side * 0.14);
  }
  // recessed instrument bay under the overhang (shadow anchor)
  bDark.box(1.16, 0.055, 0.28, 0, 0.962, -3.415);
  // HUD mounting plinth
  bAnod.box(0.26, 0.05, 0.22, 0, 0.985, -3.40);

  // ---- main instrument panel ---------------------------------------------
  const panel = new THREE.Group();
  panel.position.set(0, 0.72, -3.40);
  panel.rotation.x = -0.20;
  group.add(panel);

  const pDark = new GeoBatch(matDark);
  const pBlack = new GeoBatch(matBlack);
  const pMetal = new GeoBatch(matMetal);

  pDark.box(1.04, 0.58, 0.06, 0, 0, 0);
  pDark.box(1.06, 0.05, 0.09, 0, 0.285, 0.01);
  pDark.box(1.06, 0.045, 0.08, 0, -0.285, 0.01);
  pDark.build(panel);

  // ---- MFD screens + bezels ----------------------------------------------
  const mfdGeo = new THREE.PlaneGeometry(0.245, 0.245);
  const mfdL = canvasTex(256, 256, (ctx, w, h) => drawADI(ctx, w, h, {
    roll: 0, pitch: 0, kts: 0, altFt: 0, g: 1, aoa: 0, vs: 0, gear: true, stall: false,
  }));
  const mfdR = canvasTex(256, 256, (ctx, w, h) => drawHSI(ctx, w, h, { heading: 0 }));
  const mfdMatL = screenMaterial(mfdL);
  const mfdMatR = screenMaterial(mfdR);
  const screenL = new THREE.Mesh(mfdGeo, mfdMatL);
  screenL.position.set(-0.238, 0.045, 0.0457);
  const screenR = new THREE.Mesh(mfdGeo, mfdMatR);
  screenR.position.set(0.238, 0.045, 0.0457);
  panel.add(screenL, screenR);

  const mfdCenters = [-0.238, 0.238];
  for (const x of mfdCenters) {
    // recessed bezel plate, screen sits 4 mm proud, raised frame + rockers
    pBlack.box(0.30, 0.30, 0.014, x, 0.045, 0.036);
    pBlack.box(0.268, 0.012, 0.020, x, 0.045 + 0.133, 0.046);
    pBlack.box(0.268, 0.012, 0.020, x, 0.045 - 0.133, 0.046);
    pBlack.box(0.012, 0.268, 0.020, x - 0.133, 0.045, 0.046);
    pBlack.box(0.012, 0.268, 0.020, x + 0.133, 0.045, 0.046);
    // corner rocker switches
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        pMetal.box(0.024, 0.03, 0.014, x + sx * 0.132, 0.045 + sy * 0.132, 0.048, 0, 0, sx * sy * 0.35);
      }
    }
  }
  pBlack.build(panel);
  pMetal.build(panel);

  // 20 physical OSB pushbuttons per MFD, one InstancedMesh for both screens.
  const osbGeo = new THREE.BoxGeometry(0.032, 0.017, 0.016);
  const osb = new THREE.InstancedMesh(osbGeo, matLight, 40);
  osb.name = 'mfdOsb';
  osb.frustumCulled = false;
  panel.add(osb);
  let oi = 0;
  for (const cx0 of mfdCenters) {
    for (let i = 0; i < 5; i++) {
      const off = (i - 2) * 0.050;
      setInstance(osb, oi++, cx0 + off, 0.045 + 0.146, 0.050);
      setInstance(osb, oi++, cx0 + off, 0.045 - 0.146, 0.050);
      setInstance(osb, oi++, cx0 - 0.146, 0.045 + off, 0.050, 0, 0, Math.PI / 2);
      setInstance(osb, oi++, cx0 + 0.146, 0.045 + off, 0.050, 0, 0, Math.PI / 2);
    }
  }
  osb.instanceMatrix.needsUpdate = true;

  // panel lower caution panel + HUD control head
  const cautionPanelTex = canvasTex(256, 64, drawCautionPanel);
  const cautionPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 0.085),
    screenMaterial(cautionPanelTex),
  );
  cautionPanel.position.set(0, -0.195, 0.034);
  panel.add(cautionPanel);
  // HUD control head on the panel top with five rotary knobs
  {
    const pHead = new GeoBatch(matLight);
    pHead.box(0.32, 0.10, 0.03, 0, 0.245, 0.05);
    pHead.build(panel, 'hudControlHead');
    const pKnob = new GeoBatch(matMetal);
    for (let i = 0; i < 5; i++) {
      pKnob.cyl(0.010, 0.010, 0.016, 10, -0.10 + i * 0.05, 0.245, 0.072, Math.PI / 2, 0, 0);
    }
    pKnob.build(panel, 'hudControlKnobs');
  }

  // ---- 3D raised ICP beneath the HUD -------------------------------------
  const icp = new THREE.Group();
  icp.position.set(0, 0.858, -3.318);
  icp.rotation.x = -0.55;
  group.add(icp);
  const icpAnod = new GeoBatch(matAnod);
  const icpBlack = new GeoBatch(matBlack);
  const icpMetal = new GeoBatch(matMetal);
  icpAnod.box(0.176, 0.132, 0.045, 0, 0, 0, 0.06);
  icpAnod.box(0.19, 0.018, 0.055, 0, 0.072, -0.004);
  // mounting bracket tying the raised ICP back into the instrument panel
  icpAnod.box(0.15, 0.10, 0.085, 0, -0.028, -0.05);
  icpAnod.box(0.19, 0.02, 0.06, 0, -0.074, -0.045);
  icpBlack.box(0.146, 0.026, 0.012, 0, 0.043, 0.026);
  // 4 knurled vertical thumbwheels (SYM / BRT / CONT / GAIN)
  for (let i = 0; i < 4; i++) {
    icpMetal.cyl(0.008, 0.008, 0.030, 8, -0.048 + i * 0.032, -0.044, 0.024, Math.PI / 2, 0, 0);
    icpMetal.box(0.003, 0.004, 0.006, -0.048 + i * 0.032, -0.036, 0.024);
  }
  // central 4-way DCS dobber
  icpMetal.box(0.012, 0.012, 0.020, 0, -0.004, 0.026);
  icpMetal.box(0.028, 0.008, 0.010, 0, -0.004, 0.026);
  icpMetal.box(0.008, 0.028, 0.010, 0, -0.004, 0.026);
  icpAnod.build(icp, 'icpHousing');
  icpBlack.build(icp);
  icpMetal.build(icp);

  const icpTex = canvasTex(192, 48, drawICP);
  if (icpTex) {
    const icpDisplay = new THREE.Mesh(new THREE.PlaneGeometry(0.132, 0.026), screenMaterial(icpTex));
    icpDisplay.position.set(0, 0.043, 0.033);
    icp.add(icpDisplay);
  }

  const icpKeyGeo = new THREE.BoxGeometry(0.027, 0.011, 0.018);
  const icpKeys = new THREE.InstancedMesh(icpKeyGeo, matBlack, 12);
  icpKeys.name = 'icpKeys';
  icpKeys.frustumCulled = false;
  icp.add(icpKeys);
  let ki = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      setInstance(icpKeys, ki++, -0.051 + c * 0.034, -0.014 - r * 0.024, 0.028);
    }
  }
  icpKeys.instanceMatrix.needsUpdate = true;

  // ---- eyebrow pods ------------------------------------------------------
  // Left pod: AoA indexer + master caution + Fire/Hyd/Oil annunciators.
  const eyebrowL = new THREE.Group();
  eyebrowL.position.set(-0.352, 1.010, -3.262);
  eyebrowL.rotation.x = -0.46;
  group.add(eyebrowL);
  const eLBatch = new GeoBatch(matAnod);
  eLBatch.box(0.33, 0.072, 0.085, 0, 0, 0);
  eLBatch.box(0.35, 0.012, 0.095, 0, 0.044, 0);
  eLBatch.build(eyebrowL, 'eyebrowL');

  const aoaIndexer = new THREE.Group();
  aoaIndexer.position.set(-0.095, 0, 0.048);
  eyebrowL.add(aoaIndexer);
  aoaIndexer.add(new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.17, 0.022), matBlack));

  const aoaLampMat = (hex) => new THREE.MeshStandardMaterial({
    color: 0x111310, roughness: 0.42, metalness: 0.08,
    emissive: hex, emissiveIntensity: 0.05,
  });
  const chevronShape = new THREE.Shape();
  chevronShape.moveTo(0, 0.018);
  chevronShape.lineTo(0.02, -0.013);
  chevronShape.lineTo(-0.02, -0.013);
  chevronShape.closePath();
  const chevronGeo = new THREE.ShapeGeometry(chevronShape);

  const aoaUp = new THREE.Mesh(chevronGeo, aoaLampMat(0xffaa22));
  aoaUp.name = 'aoaUp';
  aoaUp.position.set(0, 0.053, 0.013);

  const aoaMid = new THREE.Mesh(new THREE.TorusGeometry(0.015, 0.0055, 6, 16), aoaLampMat(0x33ff77));
  aoaMid.name = 'aoaMid';
  aoaMid.position.set(0, 0, 0.013);

  const aoaDown = new THREE.Mesh(chevronGeo, aoaLampMat(0xff3322));
  aoaDown.name = 'aoaDown';
  aoaDown.rotation.z = Math.PI;
  aoaDown.position.set(0, -0.053, 0.013);

  aoaIndexer.add(aoaUp, aoaMid, aoaDown);

  const cautionMat = new THREE.MeshStandardMaterial({
    color: 0x3a2606, roughness: 0.45, metalness: 0.12,
    emissive: 0xffb020, emissiveIntensity: 0.05,
  });
  const masterCaution = new THREE.Group();
  masterCaution.position.set(0.012, 0, 0.048);
  eyebrowL.add(masterCaution);
  masterCaution.add(new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.058, 0.018), matBlack));
  const cautionLamp = new THREE.Mesh(new THREE.BoxGeometry(0.064, 0.038, 0.014), cautionMat);
  cautionLamp.name = 'masterCaution';
  cautionLamp.position.set(0, 0, 0.012);
  masterCaution.add(cautionLamp);

  const annunTex = canvasTex(160, 42, drawAnnunciator);
  const annun = new THREE.Mesh(new THREE.PlaneGeometry(0.092, 0.030), screenMaterial(annunTex));
  annun.position.set(0.116, -0.004, 0.046);
  eyebrowL.add(annun);

  // Right pod: ALR-56M RWR scope + DED.
  const eyebrowR = new THREE.Group();
  eyebrowR.position.set(0.352, 1.010, -3.262);
  eyebrowR.rotation.x = -0.46;
  group.add(eyebrowR);
  const eRBatch = new GeoBatch(matAnod);
  eRBatch.box(0.33, 0.072, 0.085, 0, 0, 0);
  eRBatch.box(0.35, 0.012, 0.095, 0, 0.044, 0);
  eRBatch.cyl(0.047, 0.047, 0.02, 20, -0.080, 0, 0.044, Math.PI / 2, 0, 0);
  eRBatch.box(0.17, 0.05, 0.02, 0.082, -0.006, 0.040);
  eRBatch.build(eyebrowR, 'eyebrowR');

  const rwrTex = canvasTex(128, 128, drawRWR);
  const rwr = new THREE.Mesh(new THREE.CircleGeometry(0.040, 24), screenMaterial(rwrTex));
  rwr.position.set(-0.080, 0, 0.056);
  eyebrowR.add(rwr);

  const dedTex = canvasTex(160, 64, drawDED);
  const ded = new THREE.Mesh(new THREE.PlaneGeometry(0.148, 0.040), screenMaterial(dedTex));
  ded.position.set(0.082, -0.004, 0.052);
  eyebrowR.add(ded);

  // ---- WAR HUD -----------------------------------------------------------
  const hud = new THREE.Group();
  hud.position.set(0, 1.13, -3.38);
  group.add(hud);

  // thick bevelled polycarbonate combiner
  {
    const hw = 0.15;
    const hh = 0.125;
    const r = 0.018;
    const shape = new THREE.Shape();
    shape.moveTo(-hw + r, -hh);
    shape.lineTo(hw - r, -hh);
    shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
    shape.lineTo(hw, hh - r);
    shape.quadraticCurveTo(hw, hh, hw - r, hh);
    shape.lineTo(-hw + r, hh);
    shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
    shape.lineTo(-hw, -hh + r);
    shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
    const glassGeo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.006, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.003, bevelSegments: 2,
    });
    glassGeo.translate(0, 0, -0.003);
    const glass = new THREE.Mesh(
      glassGeo,
      new THREE.MeshBasicMaterial({
        color: 0x54ff86, transparent: true, opacity: 0.055,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      }),
    );
    glass.name = 'hudGlass';
    glass.position.set(0, 0, 0);
    glass.rotation.x = 0.08;
    hud.add(glass);
    // frame + twin sculpted struts with chamfered bases and bolt heads
    const bStrut = new GeoBatch(matAnod);
    for (const side of [-1, 1]) {
      const x = side * 0.166;
      bStrut.box(0.019, 0.30, 0.019, x, 0, 0.016);
      bStrut.box(0.030, 0.045, 0.034, x, -0.152, 0.016);
      bStrut.box(0.038, 0.020, 0.050, x, -0.178, 0.010);
      bStrut.cyl(0.0045, 0.0045, 0.008, 6, x - side * 0.015, -0.160, 0.034, Math.PI / 2, 0, 0);
      bStrut.cyl(0.0045, 0.0045, 0.008, 6, x + side * 0.015, -0.160, 0.034, Math.PI / 2, 0, 0);
    }
    bStrut.box(0.335, 0.015, 0.016, 0, 0.136, 0.016);
    bStrut.box(0.335, 0.015, 0.016, 0, -0.136, 0.016);
    bStrut.build(hud, 'hudFrame');
  }

  // recessed optical collimator lens dish in the glare-shield top
  {
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0x0b2a18, roughness: 0.25, metalness: 0.2,
      emissive: 0x2f7a4a, emissiveIntensity: 0.75,
    });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.026, 20), lensMat);
    lens.position.set(0, 1.033, -3.47);
    lens.rotation.x = -Math.PI / 2;
    group.add(lens);
    bMetal.torus(0.03, 0.004, 4, 14, 0, 1.029, -3.47, -Math.PI / 2, 0, 0);
  }

  // ---- center pedestal: EHSI + 7 standby gauges --------------------------
  const pedestal = new THREE.Group();
  pedestal.position.set(0, 0.545, -3.10);
  pedestal.rotation.x = -1.02;
  group.add(pedestal);
  const pEDark = new GeoBatch(matDark);
  const pEMetal = new GeoBatch(matMetal);
  pEDark.box(0.40, 0.34, 0.075, 0, 0, 0);
  pEDark.box(0.42, 0.02, 0.085, 0, 0.166, 0.002);
  pEDark.box(0.06, 0.34, 0.10, -0.21, 0, 0);
  pEDark.box(0.06, 0.34, 0.10, 0.21, 0, 0);

  const ehsiTex = canvasTex(192, 256, (ctx, w, h) => drawEHSI(ctx, w, h, {
    roll: 0, pitch: 0, heading: 0, kts: 0, gear: true,
  }));
  const ehsi = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.20), screenMaterial(ehsiTex));
  ehsi.position.set(0, 0.045, 0.041);
  pedestal.add(ehsi);
  // EHSI bezel
  pEDark.box(0.172, 0.222, 0.014, 0, 0.045, 0.033);
  pEMetal.box(0.18, 0.014, 0.02, 0, 0.162, 0.033);
  pEMetal.box(0.18, 0.014, 0.02, 0, -0.072, 0.033);
  for (let i = 0; i < 5; i++) {
    pEMetal.box(0.012, 0.02, 0.012, -0.066 + i * 0.033, -0.09, 0.036);
  }

  const gaugeDefs = [
    { label: 'ASI', max: 600, unit: '', x: -0.143, y: 0.100 },
    { label: 'ALT', max: 50000, unit: '', x: 0.143, y: 0.100 },
    { label: 'VVI', max: 6000, unit: '', x: -0.143, y: 0.026 },
    { label: 'RPM', max: 110, unit: '', x: 0.143, y: 0.026 },
    { label: 'FTIT', max: 1000, unit: '', x: -0.143, y: -0.048 },
    { label: 'NOZ', max: 100, unit: '', x: 0.143, y: -0.048 },
    { label: 'FF', max: 10000, unit: '', x: 0, y: -0.126 },
  ];
  const gaugeGeo = new THREE.CircleGeometry(0.026, 20);
  const gauges = [];
  for (const g of gaugeDefs) {
    const gt = canvasTex(64, 64, (ctx, w, h) => drawMiniGauge(ctx, w, h, g.label, 0, g.max, g.unit));
    const mesh = new THREE.Mesh(gaugeGeo, screenMaterial(gt, 0x070a08));
    mesh.position.set(g.x, g.y, 0.042);
    pedestal.add(mesh);
    pEMetal.cyl(0.030, 0.030, 0.014, 16, g.x, g.y, 0.036, Math.PI / 2, 0, 0);
    gauges.push({ ...g, tex: gt });
  }
  pEDark.build(pedestal, 'pedestalHousing');
  pEMetal.build(pedestal, 'pedestalBezels');

  // ---- landing gear handle + emergency jettison panel --------------------
  {
    const gh = new THREE.Group();
    gh.position.set(-0.402, 0.572, -3.02);
    group.add(gh);
    const bGH = new GeoBatch(matMetal);
    bGH.box(0.05, 0.02, 0.07, 0, 0, 0);
    bGH.cyl(0.009, 0.009, 0.13, 8, 0, 0.065, 0.0, 0, 0, 0);
    bGH.build(gh, 'gearHandle');
    bWhite.cyl(0.034, 0.034, 0.018, 12, -0.402, 0.700, -3.02, 0, 0, Math.PI / 2);
    bWhite.box(0.024, 0.07, 0.012, -0.402, 0.700, -3.02);
    bWhite.box(0.024, 0.012, 0.062, -0.402, 0.700, -3.02);
    const jettTex = canvasTex(128, 48, drawJettison);
    const jett = new THREE.Mesh(new THREE.PlaneGeometry(0.145, 0.06), screenMaterial(jettTex));
    jett.position.set(-0.40, 0.581, -2.60);
    jett.rotation.x = -Math.PI / 2;
    group.add(jett);
  }

  // ---- side consoles -----------------------------------------------------
  for (const side of [-1, 1]) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 1.70), matPanel);
    body.position.set(side * 0.45, 0.48, -2.55);
    body.rotation.z = side * -0.05;
    group.add(body);
  }
  {
    // eight bolted sub-panels, all sharing one texture and one draw call
    const panelBatches = new GeoBatch(matConsole);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const z = -3.08 + i * 0.36;
        panelBatches.add(new THREE.PlaneGeometry(0.22, 0.34), side * 0.452, 0.572, z, -Math.PI / 2, 0, 0);
        bMetal.box(0.232, 0.008, 0.012, side * 0.452, 0.5745, z - 0.172);
        bMetal.box(0.232, 0.008, 0.012, side * 0.452, 0.5745, z + 0.172);
      }
    }
    panelBatches.build(group, 'consolePanels');
  }

  // ---- ~80 console switches / knobs / guarded switches -------------------
  {
    const swParts = new GeoBatch(matSwitch);
    swParts.cyl(0.010, 0.012, 0.012, 6, 0, 0, 0);
    swParts.cyl(0.0032, 0.0032, 0.026, 5, 0, 0.017, 0);
    swParts.sphere(0.006, 0, 0.031, 0, 6, 4);
    const swGeo = mergeGeoms(swParts.parts);
    swParts.parts = [];

    const spots = [];
    for (const side of [-1, 1]) {
      const cols = [0.545, 0.478, 0.408, 0.345];
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 12; r++) {
          const x = side * cols[c];
          const z = -3.24 + r * 0.125;
          // clear the throttle (left) and sidestick (right) quadrants
          if (Math.abs(z + 2.85) < 0.134 && Math.abs(x + 0.44) < 0.17) continue;
          if (Math.abs(z + 2.68) < 0.134 && Math.abs(x - 0.44) < 0.17) continue;
          spots.push([x, z, side, c, r]);
        }
      }
    }
    const swMesh = new THREE.InstancedMesh(swGeo, matSwitch, spots.length);
    swMesh.name = 'consoleSwitches';
    swMesh.frustumCulled = false;
    group.add(swMesh);
    const col = new THREE.Color();
    for (let i = 0; i < spots.length; i++) {
      const [x, z, side, c, r] = spots[i];
      const yaw = side * -0.05 + (r % 3) * 0.12;
      const tilt = (r % 2 === 0 ? 0.28 : -0.28);
      const guarded = (i % 9) === 4;
      setInstance(swMesh, i, x, 0.580, z, tilt, yaw, 0, guarded ? 1.35 : 1, guarded ? 1.2 : 1, guarded ? 1.35 : 1);
      if (guarded) col.setRGB(0.85, 0.22, 0.16);
      else if (i % 5 === 0) col.setRGB(0.85, 0.72, 0.32);
      else if (i % 3 === 0) col.setRGB(0.42, 0.47, 0.43);
      else col.setRGB(0.72, 0.75, 0.70);
      swMesh.setColorAt(i, col);
    }
    swMesh.instanceMatrix.needsUpdate = true;
    if (swMesh.instanceColor) swMesh.instanceColor.needsUpdate = true;
  }

  // ---- rivets / bolt heads ----------------------------------------------
  {
    const rivetGeo = new THREE.SphereGeometry(0.0036, 5, 4);
    const rivets = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 26; i++) {
        rivets.push([side * 0.585, 0.826, -3.38 + i * 0.092]);
        rivets.push([side * 0.33, 0.566, -3.32 + i * 0.092]);
      }
      for (let i = 0; i < 6; i++) rivets.push([side * 0.16, 0.985, -3.50 + i * 0.055]);
    }
    const rivetMesh = new THREE.InstancedMesh(rivetGeo, matMetal, rivets.length);
    rivetMesh.name = 'cockpitRivets';
    rivetMesh.frustumCulled = false;
    group.add(rivetMesh);
    for (let i = 0; i < rivets.length; i++) {
      const [x, y, z] = rivets[i];
      setInstance(rivetMesh, i, x, y, z, 0, 0, 0, 1, 0.6, 1);
    }
    rivetMesh.instanceMatrix.needsUpdate = true;
  }

  // ---- throttle, sidestick, rudder pedals --------------------------------
  const throttle = new THREE.Group();
  throttle.position.set(-0.44, 0.56, -2.85);
  group.add(throttle);
  {
    const bT = new GeoBatch(matDark);
    bT.box(0.085, 0.075, 0.22, 0, 0.045, 0);
    bT.box(0.05, 0.03, 0.06, 0, 0.03, 0.10);
    bT.build(throttle, 'throttleBase');
    const bM = new GeoBatch(matHarness);
    bM.cyl(0.032, 0.042, 0.11, 8, 0, 0.105, -0.012, Math.PI / 2, 0, 0);
    bM.build(throttle, 'throttleGrip');
    const bTM = new GeoBatch(matMetal);
    bTM.cyl(0.014, 0.014, 0.018, 10, 0.048, 0.105, -0.03, 0, 0, Math.PI / 2);
    bTM.box(0.018, 0.03, 0.045, -0.040, 0.095, 0.02, 0, 0, 0.3);
    bTM.build(throttle, 'throttleSwitches');
  }

  const stick = new THREE.Group();
  stick.position.set(0.44, 0.56, -2.68);
  group.add(stick);
  {
    const bS = new GeoBatch(matBlack);
    bS.cyl(0.075, 0.10, 0.05, 12, 0, 0.005, 0);
    bS.build(stick, 'stickBase');
    const bSM = new GeoBatch(matMetal);
    bSM.cyl(0.02, 0.024, 0.13, 8, 0, 0.09, 0);
    bSM.build(stick, 'stickShaft');
    const bSG = new GeoBatch(matBlack);
    bSG.add(new THREE.CapsuleGeometry(0.038, 0.09, 4, 8), 0, 0.155, 0, 0, 0, 0.1);
    bSG.box(0.05, 0.018, 0.035, 0, 0.20, -0.02);
    bSG.build(stick, 'stickGrip');
    const pickle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.010, 0.010, 0.008, 10),
      new THREE.MeshStandardMaterial({ color: 0xc0342a, roughness: 0.5, metalness: 0.2 }),
    );
    pickle.position.set(0, 0.172, -0.045);
    pickle.rotation.x = Math.PI / 2;
    stick.add(pickle);
    const bSH = new GeoBatch(matMetal);
    bSH.box(0.042, 0.008, 0.022, 0, 0.202, 0.028, 0.5);
    bSH.build(stick, 'stickTrimHat');
  }

  const pedals = [];
  for (const side of [-1, 1]) {
    const pedal = new THREE.Group();
    pedal.position.set(side * 0.16, 0.30, -2.97);
    const bP = new GeoBatch(matMetal);
    bP.box(0.115, 0.032, 0.20, 0, 0, 0, -0.5);
    bP.box(0.10, 0.02, 0.09, 0, -0.03, 0.06);
    bP.build(pedal, 'rudderPedal');
    group.add(pedal);
    pedals.push(pedal);
  }

  // ---- ACES II ejection seat (anchored to the pilot) ---------------------
  const seat = new THREE.Group();
  seat.position.set(0, 0.26, -2.38);
  group.add(seat);
  bSeat.box(0.48, 0.11, 0.56, 0, 0, 0.05);
  bSeat.box(0.46, 0.86, 0.11, 0, 0.40, 0.24, 0.32);
  bSeat.box(0.24, 0.22, 0.12, 0, 0.84, 0.38, 0.32);
  for (const side of [-1, 1]) {
    bSeat.box(0.06, 0.46, 0.15, side * 0.205, 0.30, 0.16, 0.30, 0, side * -0.05);
  }
  bSeat.box(0.40, 0.07, 0.36, 0, 0.095, 0.08);
  bHarness.box(0.055, 0.55, 0.025, -0.13, 0.50, 0.16, 0.30);
  bHarness.box(0.055, 0.55, 0.025, 0.13, 0.50, 0.16, 0.30);
  bHarness.box(0.30, 0.045, 0.03, 0, 0.17, -0.06, 0.1);
  bHarness.box(0.34, 0.06, 0.055, 0, 0.86, 0.29, 0.32);
  // ejection handle (yellow loop)
  {
    const ejHandle = new THREE.Mesh(
      new THREE.TorusGeometry(0.055, 0.012, 6, 12, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0xd8c24a, roughness: 0.6 }),
    );
    ejHandle.rotation.x = Math.PI / 2;
    ejHandle.position.set(0, 0.16, -0.35);
    seat.add(ejHandle);
    const ejBase = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.10, 0.03), matBlack);
    ejBase.position.set(0, 0.19, 0.02);
    seat.add(ejBase);
  }
  bSeat.build(seat, 'seatShell');
  bHarness.build(seat, 'seatHarness');

  // ---- first-person pilot legs, kneeboard, forearms ----------------------
  const firstPersonBody = new THREE.Group();
  firstPersonBody.name = 'firstPersonBody';
  firstPersonBody.visible = false;
  group.add(firstPersonBody);

  const bLegs = new GeoBatch(matSuit);
  for (const side of [-1, 1]) {
    const x = side * 0.16;
    // thigh (hip -> knee), slightly splayed
    bLegs.box(0.155, 0.135, 0.42, x, 0.452, -2.45, -0.16, side * -0.03, 0);
    // knee + shin down to the rudder pedals
    bLegs.box(0.145, 0.145, 0.16, x, 0.42, -2.66, -0.3);
    bLegs.box(0.13, 0.24, 0.15, x, 0.31, -2.76, -0.18);
    bLegs.box(0.14, 0.09, 0.24, x, 0.255, -2.90, -0.05);
    // G-suit compression bladders + straps
    bLegs.box(0.165, 0.055, 0.10, x, 0.405, -2.58, -0.2);
    bLegs.box(0.035, 0.14, 0.30, x + side * 0.085, 0.46, -2.45, -0.16);
    bLegs.box(0.16, 0.02, 0.045, x, 0.522, -2.36, -0.16);
    bLegs.box(0.16, 0.02, 0.045, x, 0.512, -2.58, -0.16);
  }
  bLegs.build(firstPersonBody, 'pilotLegs');

  const bKB = new GeoBatch(matBlack);
  bKB.box(0.115, 0.012, 0.155, -0.165, 0.523, -2.42, -0.16, 0, -0.06);
  bKB.build(firstPersonBody, 'kneeboard');

  // left forearm reaches the TQS throttle; right forearm reaches the stick
  const Y_UP = new THREE.Vector3(0, 1, 0);
  const leftArm = new THREE.Group();
  leftArm.position.set(-0.335, 0.415, -2.30);
  {
    const geo = new THREE.CylinderGeometry(0.042, 0.052, 0.60, 8);
    const m = new THREE.Mesh(geo, matSuit);
    m.position.set(0, 0.30, 0);
    leftArm.add(m);
    leftArm.quaternion.setFromUnitVectors(Y_UP, new THREE.Vector3(-0.105, 0.263, -0.562).normalize());
  }
  firstPersonBody.add(leftArm);

  const rightArm = new THREE.Group();
  rightArm.position.set(0.335, 0.415, -2.30);
  {
    const geo = new THREE.CylinderGeometry(0.042, 0.052, 0.50, 8);
    const m = new THREE.Mesh(geo, matSuit);
    m.position.set(0, 0.25, 0);
    rightArm.add(m);
    rightArm.quaternion.setFromUnitVectors(Y_UP, new THREE.Vector3(0.105, 0.31, -0.38).normalize());
  }
  firstPersonBody.add(rightArm);

  // Nomex gloved hands: children of the control groups so they ride the
  // throttle and the force-sensing stick exactly.
  function makeGlove(gripX, gripY, gripZ, yaw) {
    const b = new GeoBatch(matGlove);
    b.box(0.072, 0.075, 0.085, 0, 0, 0);
    for (let i = 0; i < 4; i++) {
      b.box(0.016, 0.056, 0.020, -0.027 + i * 0.018, -0.012, -0.046, -0.25);
    }
    b.box(0.022, 0.040, 0.055, 0.036, -0.012, -0.012, 0, 0, 0.5);
    const glove = new THREE.Mesh(mergeGeoms(b.parts), matGlove);
    b.parts = [];
    glove.position.set(gripX, gripY, gripZ);
    glove.rotation.y = yaw;
    return glove;
  }
  const leftGlove = makeGlove(0.0, 0.118, -0.012, 0.15);
  throttle.add(leftGlove);
  const rightGlove = makeGlove(0.0, 0.165, 0.008, -0.1);
  stick.add(rightGlove);
  leftGlove.visible = false;
  rightGlove.visible = false;

  // ---- canopy rain overlay ---------------------------------------------
  const rainTex = canvasTex(256, 256, drawRainStreaks);
  const rainMat = new THREE.MeshBasicMaterial({
    map: rainTex ? rainTex.tex : null, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    color: rainTex ? 0xffffff : 0x9fc9d8,
  });
  if (rainTex) {
    rainTex.tex.wrapS = THREE.RepeatWrapping;
    rainTex.tex.wrapT = THREE.RepeatWrapping;
  }
  const canopyRain = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 0.54), rainMat);
  canopyRain.name = 'canopyRain';
  canopyRain.position.set(0, 0.97, -3.02);
  canopyRain.rotation.x = -0.34;
  canopyRain.visible = false;
  canopyRain.renderOrder = 4;
  group.add(canopyRain);

  // ---- interior flood lights --------------------------------------------
  const light = new THREE.PointLight(0xcfffe0, 2.2, 5.0, 2);
  light.position.set(0, 1.02, -2.55);
  group.add(light);
  const fill = new THREE.PointLight(0x9fc9ff, 0.9, 3.4, 2);
  fill.position.set(0, 0.85, -3.15);
  group.add(fill);

  // ---- cockpit-only high-res sun shadow ---------------------------------
  // 1024^2 over the ~2.5 m cockpit cone ≈ 2.4 mm per shadow texel: the glare
  // shield overhang, HUD pylons, sills, ICP, switches, sticks and the pilot's
  // knees all throw razor-sharp moving shadows across the interior.
  const cockpitSun = new THREE.SpotLight(0xfff3de, 0, 7.5, 0.68, 0.22, 1.4);
  cockpitSun.name = 'cockpitSun';
  cockpitSun.castShadow = true;
  cockpitSun.shadow.mapSize.set(1024, 1024);
  // Focus the shadow camera on the ~2.4 m cockpit cone (instead of the full
  // 78° light cone) so 1024² really lands at ≈2.4 mm per shadow texel.
  cockpitSun.shadow.focus = 0.5;
  cockpitSun.shadow.camera.near = 1.2;
  cockpitSun.shadow.camera.far = 7.5;
  cockpitSun.shadow.bias = -0.0006;
  cockpitSun.shadow.normalBias = 0.009;
  cockpitSun.shadow.camera.updateProjectionMatrix();
  cockpitSun.target.position.copy(_sunTarget);
  cockpitSun.position.copy(_sunTarget).add(new THREE.Vector3(0, 3.4, 0));
  cockpitSun.visible = false;
  group.add(cockpitSun, cockpitSun.target);

  // ---- build the static geometry batches --------------------------------
  bGlare.build(group, 'glareShield');
  bPanel.build(group, 'cockpitPanels');
  bDark.build(group, 'cockpitDark');
  bLight.build(group, 'cockpitLit');
  bMetal.build(group, 'cockpitMetal');
  bAnod.build(group, 'cockpitAnodised');
  bBlack.build(group, 'cockpitBlack');
  bWhite.build(group, 'gearHandleGrip');

  // ---- shadow flags: opaque, lit geometry casts and receives -------------
  group.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === 'canopyRain') return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (!mats.length) return;
    const skip = mats.some((m) => !m
      || m.transparent
      || m.blending === THREE.AdditiveBlending
      || m.isMeshBasicMaterial);
    if (skip) return;
    o.castShadow = true;
    o.receiveShadow = true;
  });

  // ---------------------------------------------------------------------
  let acc = 0;
  let screenAcc = 0;
  const tmpAirport = { name: '', code: '', bearing: 0, dist: 0 };
  const tmpTelemetry = {
    roll: 0, pitch: 0, kts: 0, altFt: 0, g: 1, aoa: 0, vs: 0, gear: true,
    stall: false, heading: 0, airport: null, windDir: 0, windKts: 0,
  };

  const indEnv = {
    night: 0, rain: 0, lowFuel: false, rwrThreat: false, flameout: false, time: 0,
  };

  function update(dt, flight, env) {
    acc += dt;
    const f = flight || {};
    // animate throttle / stick / pedals every frame
    throttle.rotation.x = -0.45 + (f.throttle || 0) * 0.55;
    stick.rotation.x = (f.controls?.pitch || 0) * 0.18;
    stick.rotation.z = -(f.controls?.roll || 0) * 0.14;
    pedals[0].rotation.y = (f.controls?.yaw || 0) * 0.12;
    pedals[1].rotation.y = (f.controls?.yaw || 0) * 0.12;

    // ---- live pilot feedback (per frame, never throttled) -----------------
    const e = env || {};
    indEnv.night = e.night ?? 0;
    indEnv.rain = e.rain ?? 0;
    indEnv.lowFuel = !!(e.lowFuel ?? f.lowFuel);
    indEnv.rwrThreat = !!(e.rwrThreat ?? f.rwrThreat);
    indEnv.flameout = !!(e.flameout ?? f.flameout);
    indEnv.time = e.time ?? acc;
    const ind = computeCockpitIndicators(f, indEnv);

    // AoA indexer lamps (amber up / green donut / red down)
    const lampOn = 2.6;
    const lampOff = 0.05;
    aoaUp.material.emissiveIntensity = ind.aoaState === 'slow' ? lampOn : lampOff;
    aoaMid.material.emissiveIntensity = ind.aoaState === 'onspeed' ? lampOn : lampOff;
    aoaDown.material.emissiveIntensity = ind.aoaState === 'fast' ? lampOn : lampOff;

    // master caution (bright amber while flashing, dim glow when active)
    cautionMat.emissiveIntensity = ind.cautionFlash ? 3.2 : (ind.cautionActive ? 0.4 : 0.05);

    // night backlighting + NVG-friendly interior flood
    matPanel.emissiveIntensity = ind.panelEmissive;
    matDark.emissiveIntensity = ind.panelEmissive * 0.85;
    matLight.emissiveIntensity = ind.panelEmissive * 0.9;
    matGlare.emissiveIntensity = ind.panelEmissive * 0.55;
    light.intensity = ind.floodIntensity;
    // Intensity 0 is not free: three.js keeps both PointLights in the lit
    // shader loops (NUM_POINT_LIGHTS stays 3). Hide them outside the cockpit.
    light.visible = fill.visible = !!e.cockpitView;

    // The first-person body never doubles up with the external pilot figure.
    const fpVisible = !!e.cockpitView;
    firstPersonBody.visible = fpVisible;
    leftGlove.visible = fpVisible;
    rightGlove.visible = fpVisible;

    // ---- cockpit sun: 2.4 mm/texel dynamic self-shadowing ----------------
    const dayT = clamp01(1 - (e.night || 0));
    const ov = clamp01(e.overcast || 0);
    cockpitSun.visible = !!e.cockpitView && dayT > 0.08 && ov < 0.88;
    if (cockpitSun.visible) {
      // World sun direction -> aircraft local space (zero allocations).
      const sd = e.sunDir;
      if (sd && typeof sd.x === 'number' && typeof sd.y === 'number' && typeof sd.z === 'number') {
        _sunWorld.set(sd.x, sd.y, sd.z);
      } else {
        _sunWorld.set(0.45, 0.78, 0.42);
      }
      if (_sunWorld.lengthSq() < 1e-6) _sunWorld.set(0.45, 0.78, 0.42);
      _sunWorld.normalize();
      const q = f.quaternion;
      if (q && typeof q.x === 'number' && typeof q.y === 'number') _invQ.copy(q).invert();
      else _invQ.identity();
      _sunLocal.copy(_sunWorld).applyQuaternion(_invQ).normalize();
      // Keep a shallow rake even when the jet is inverted so the glare shield,
      // HUD struts, sills, ICP and the pilot's knees all catch a hard edge:
      // clamp the *elevation* (not just the raw y) to -0.15 while preserving
      // the azimuth, so the spot is never placed under the cockpit floor.
      if (_sunLocal.y < -0.15) {
        const h = Math.hypot(_sunLocal.x, _sunLocal.z) || 1;
        const horiz = Math.sqrt(1 - 0.15 * 0.15);
        _sunLocal.x = (_sunLocal.x / h) * horiz;
        _sunLocal.z = (_sunLocal.z / h) * horiz;
        _sunLocal.y = -0.15;
      }
      cockpitSun.position.copy(_sunTarget).addScaledVector(_sunLocal, 3.4);
      cockpitSun.intensity = 3.6 * dayT * (1 - ov * 0.62) * smoothstep(-0.15, 0.25, _sunLocal.y);
      const sc = e.sunColor;
      if (sc && sc.isColor) cockpitSun.color.copy(sc);
      else if (typeof sc === 'string') cockpitSun.color.set(sc);
    } else {
      cockpitSun.intensity = 0;
    }

    // canopy raindrop streaks
    canopyRain.visible = ind.rainOpacity > 0.01;
    if (canopyRain.visible) {
      rainMat.opacity = ind.rainOpacity;
      if (rainTex) {
        rainTex.tex.offset.y = (((rainTex.tex.offset.y - ind.rainScrollSpeed * dt) % 1) + 1) % 1;
      }
    }

    screenAcc += dt;
    // The MFDs and standby gauges (655 KB per redraw, plus a mip chain) are
    // unreadable through the canopy in external views: only redraw them in the
    // cockpit, and force one redraw on the frame the view switches back so
    // the screens are never stale. Lamps/stick above stay per-frame.
    const cockpitView = !!e.cockpitView;
    const enteredCockpit = cockpitView && !cockpit._wasCockpitView;
    cockpit._wasCockpitView = cockpitView;
    if (!cockpitView) {
      screenAcc = Math.min(screenAcc, 0.1);
      return;
    }
    if (screenAcc < 0.1 && !enteredCockpit) return;
    screenAcc = 0;
    if (!env || !flight) return;

    tmpTelemetry.roll = flight.rollDeg;
    tmpTelemetry.pitch = flight.pitchDeg;
    tmpTelemetry.kts = flight.speed * 1.94384;
    tmpTelemetry.altFt = (flight.position.y) * 3.28084;
    tmpTelemetry.g = flight.gForce;
    tmpTelemetry.aoa = flight.aoa;
    tmpTelemetry.vs = flight.verticalSpeed * 196.85;
    tmpTelemetry.gear = flight.gearPos > 0.5;
    tmpTelemetry.stall = flight.stall;
    tmpTelemetry.heading = flight.heading;
    tmpTelemetry.airport = env.airport ? env.airport : null;
    tmpTelemetry.windDir = env.windDir != null ? env.windDir : ((Math.atan2(-env.windX, env.windZ) * 180) / Math.PI + 360) % 360;
    tmpTelemetry.windKts = env.windKts != null ? env.windKts : Math.hypot(env.windX, env.windZ) * 1.94384;

    repaint(mfdL, (ctx) => drawADI(ctx, 256, 256, tmpTelemetry));
    repaint(mfdR, (ctx) => drawHSI(ctx, 256, 256, tmpTelemetry));
    repaint(ehsiTex, (ctx) => drawEHSI(ctx, 192, 256, tmpTelemetry));

    const thr = flight.throttle ?? 0.5;
    const gaugeVals = [
      tmpTelemetry.kts, tmpTelemetry.altFt, tmpTelemetry.vs,
      thr * 100, 420 + thr * 520, thr * 100, thr * 9000,
    ];
    for (let i = 0; i < gauges.length; i++) {
      const g = gauges[i];
      repaint(g.tex, (ctx) => drawMiniGauge(ctx, 64, 64, g.label, gaugeVals[i], g.max, g.unit));
    }
  }

  // Returned as one object so update() can remember the previous view mode
  // (`cockpit._wasCockpitView`) without a `this` binding.
  const cockpit = {
    group, update, hudGlass: group.getObjectByName('hudGlass'), mfdL, mfdR, screenL, screenR,
    aoaIndexer, aoaUp, aoaMid, aoaDown,
    masterCaution: cautionLamp, canopyRain, cockpitSun,
    _wasCockpitView: false,
  };
  return cockpit;
}