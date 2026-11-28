// Detailed procedural F-16C Block 50 exterior. Nose points -Z, up +Y, right +X.
//
// Published Lockheed Martin F-16C Block 50 3-view dimensions reproduced here:
//   • overall length incl. pitot probe          15.06 m  (z = -7.86 .. +7.20)
//   • structural length (radome tip .. nozzle)  14.56 m  (z = -7.36 .. +7.20)
//   • bare cropped-delta wing span               9.45 m  (x = ±4.725)
//   • span over wingtip LAU-129 rails            9.96 m  (x = ±4.98)
//   • overall height, gear down                  5.09 m  (y = -1.56 .. +3.53)
//   • horizontal stabilator span                 5.57 m  (x = ±2.785)
//   • main landing gear track                    2.36 m  (x = ±1.18)
//
// Cockpit interior contract (src/aircraft/cockpit.js): HUD combiner at
// y = 1.13 / z = -3.38, canopy rails at x = ±0.56 / y = 0.80 / z = -2.35, rear
// bow z = -1.00. The bubble therefore stays at y >= 1.38 over z = -3.48..-2.00
// so the combiner is never clipped, and the fuselage top is cut away for
// y > 0.62, z ∈ (-3.68, -1.00), |x| < 0.59.
import * as THREE from 'three';
import { mulberry32 } from '../world/noise.js';

// Headless-safe canvas factory: Node (tests) has no DOM, so texture builders
// return null and materials fall back to their plain base colours.
const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

function createCanvas(w, h) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Leading-edge flap hinge: the swept hinge line (parallel to the 40° wing LE)
// crosses the centreline at z = -1.458 and runs aft at dz/dx = 0.8455.
const LEF_HINGE_Z0 = -1.458;
const LEF_HINGE_SLOPE = 0.8455;

// ---------------------------------------------------------------------------
// Livery stencils
// ---------------------------------------------------------------------------

/** Low-visibility USAF star-and-bar (grey, no blue field) for Block 50 jets. */
function drawStarAndBar(ctx, cx, cy, r, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  // Star
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.40;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  // Star-and-bar: the bar sweeps aft of the star, with a thin inset gap.
  const bh = r * 0.52;
  const bw = r * 1.95;
  ctx.beginPath();
  ctx.rect(cx + r * 0.42, cy - bh / 2, bw, bh);
  ctx.rect(cx - r * 0.42 - bw, cy - bh / 2, bw, bh);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.restore();
}

function drawDangerTriangle(ctx, x, y, s, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s * 0.92, y + s * 0.72);
  ctx.lineTo(x - s * 0.92, y + s * 0.72);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(30,30,32,0.92)';
  ctx.beginPath();
  ctx.moveTo(x, y - s * 0.48);
  ctx.lineTo(x + s * 0.48, y + s * 0.44);
  ctx.lineTo(x - s * 0.48, y + s * 0.44);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Deterministic procedural textures (no Math.random)
// ---------------------------------------------------------------------------

function createAirframeTexture() {
  const W = 1024;
  const H = 512;
  const c = createCanvas(W, H);
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const rng = mulberry32(160050);

  // USAF Compass Ghost / Have Glass 2-tone wrap. uv.x runs around the
  // circumference: 0 = right flank, 0.25 = dorsal spine, 0.5 = left flank,
  // 0.75 = belly.
  const baseGrad = ctx.createLinearGradient(0, 0, W, 0);
  baseGrad.addColorStop(0.00, '#848e96');  // FS 36270 neutral grey flanks
  baseGrad.addColorStop(0.13, '#6f7982');
  baseGrad.addColorStop(0.25, '#5b646d');  // FS 36118 gunship grey spine
  baseGrad.addColorStop(0.37, '#6f7982');
  baseGrad.addColorStop(0.50, '#848e96');  // FS 36270 left flank
  baseGrad.addColorStop(0.63, '#9aa4ac');
  baseGrad.addColorStop(0.75, '#adb6be');  // FS 36375 light ghost grey belly
  baseGrad.addColorStop(0.88, '#9aa4ac');
  baseGrad.addColorStop(1.00, '#848e96');
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, W, H);

  // Operational weathering: exhaust soot aft, sun fade forward.
  const soot = ctx.createLinearGradient(W * 0.58, 0, W, 0);
  soot.addColorStop(0, 'rgba(40,44,48,0)');
  soot.addColorStop(1, 'rgba(34,38,42,0.20)');
  ctx.fillStyle = soot;
  ctx.fillRect(W * 0.58, 0, W * 0.42, H);

  for (let i = 0; i < 460; i++) {
    const shade = 108 + Math.floor(rng() * 60);
    const alpha = 0.02 + rng() * 0.045;
    ctx.fillStyle = `rgba(${shade},${shade + 4},${shade + 9},${alpha})`;
    const x = rng() * W;
    const y = rng() * H;
    const w = 16 + rng() * 92;
    const h = 8 + rng() * 30;
    ctx.fillRect(x, y, w, h);
  }

  // Longitudinal & circumferential panel seams.
  ctx.strokeStyle = 'rgba(42,48,54,0.42)';
  ctx.lineWidth = 1.15;
  for (let y = 22; y < H; y += 34) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let x = 0; x < W; x += 52) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  // Panel-line highlight edge (reads as a riveted lap joint in the sun).
  ctx.strokeStyle = 'rgba(222,232,240,0.13)';
  ctx.lineWidth = 0.8;
  for (let y = 23.5; y < H; y += 34) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Access hatches and inspection doors.
  ctx.strokeStyle = 'rgba(38,44,50,0.5)';
  ctx.lineWidth = 1.05;
  for (let i = 0; i < 44; i++) {
    const x = rng() * (W - 60);
    const y = 24 + rng() * (H - 54);
    const w = 16 + rng() * 46;
    const h = 10 + rng() * 22;
    ctx.fillStyle = `rgba(92,102,110,${0.06 + rng() * 0.09})`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    // Dzus fasteners on two corners.
    ctx.fillStyle = 'rgba(52,58,64,0.55)';
    ctx.fillRect(x + 2, y + 2, 2, 2);
    ctx.fillRect(x + w - 4, y + h - 4, 2, 2);
  }

  // Rivet rows.
  ctx.fillStyle = 'rgba(40,46,52,0.26)';
  for (let y = 26; y < H; y += 34) {
    for (let x = 6; x < W; x += 13) ctx.fillRect(x, y, 1.2, 1.2);
  }

  // Aerial-refuelling slipway box on the dorsal spine (u ≈ 0.25).
  ctx.strokeStyle = 'rgba(38,44,50,0.85)';
  ctx.lineWidth = 2.2;
  ctx.strokeRect(W * 0.215, H * 0.44, W * 0.07, H * 0.14);
  ctx.fillStyle = 'rgba(70,78,86,0.55)';
  ctx.fillRect(W * 0.222, H * 0.452, W * 0.056, H * 0.116);
  // "REFUEL" tick marks inside the slipway.
  ctx.fillStyle = 'rgba(210,218,226,0.35)';
  for (let i = 0; i < 4; i++) ctx.fillRect(W * 0.23, H * (0.47 + i * 0.026), W * 0.04, 2);

  // Low-vis USAF star-and-bar on both flanks, aft of the wing root.
  drawStarAndBar(ctx, W * 0.055, H * 0.55, 30, 'rgba(58,64,70,0.72)');
  drawStarAndBar(ctx, W * 0.475, H * 0.55, 30, 'rgba(58,64,70,0.72)');

  // Intake danger triangles with jet-blast chevrons on the forward lower flanks.
  drawDangerTriangle(ctx, W * 0.035, H * 0.30, 15, 'rgba(178,48,40,0.9)');
  drawDangerTriangle(ctx, W * 0.452, H * 0.30, 15, 'rgba(178,48,40,0.9)');
  ctx.strokeStyle = 'rgba(60,66,72,0.55)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    const y0 = H * 0.80 + i * 0.030 * H;
    for (const bx of [W * 0.06, W * 0.46]) {
      ctx.beginPath();
      ctx.moveTo(bx, y0);
      ctx.lineTo(bx + 26, y0 + 12);
      ctx.lineTo(bx, y0 + 24);
      ctx.stroke();
    }
  }

  // Low-vis "walkway / no step" dashed borders along the dorsal spine.
  ctx.strokeStyle = 'rgba(58,64,70,0.5)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(W * 0.19, H * 0.30);
  ctx.lineTo(W * 0.19, H * 0.86);
  ctx.moveTo(W * 0.31, H * 0.30);
  ctx.lineTo(W * 0.31, H * 0.86);
  ctx.stroke();
  ctx.setLineDash([]);

  // Serial / stencil blocks (low-vis, just readable).
  ctx.fillStyle = 'rgba(46,52,58,0.55)';
  for (let i = 0; i < 10; i++) {
    ctx.fillRect(W * 0.505, H * (0.36 + i * 0.012), 22 + (i % 3) * 8, 2.2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createWingTexture(withInsignia = false) {
  const W = 512;
  const H = 512;
  const c = createCanvas(W, H);
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const rng = mulberry32(160088 + (withInsignia ? 7 : 0));

  ctx.fillStyle = '#6d767f';  // FS 36118/36270 wing upper surface
  ctx.fillRect(0, 0, W, H);

  // Spanwise grey variation (upper wing is FS 36118 over FS 36270).
  for (let i = 0; i < 220; i++) {
    const v = 100 + Math.floor(rng() * 30);
    ctx.fillStyle = `rgba(${v},${v + 4},${v + 8},0.05)`;
    ctx.fillRect(rng() * W, rng() * H, 22 + rng() * 90, 10 + rng() * 46);
  }

  // Chordwise panel seams and spanwise spars.
  ctx.strokeStyle = 'rgba(44,50,56,0.40)';
  ctx.lineWidth = 1.15;
  for (let y = 30; y < H; y += 58) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let x = 38; x < W; x += 66) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  // Walkway boundary near the root; no-step dashes over the flaperon bay.
  ctx.strokeStyle = 'rgba(56,62,68,0.42)';
  ctx.lineWidth = 1.3;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(40, 90, W - 80, H - 180);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(40,46,52,0.28)';
  for (let x = 10; x < W; x += 15) ctx.fillRect(x, H - 34, 1.3, 26);

  // Fuel/tank filler caps and access panels.
  ctx.strokeStyle = 'rgba(40,46,52,0.55)';
  ctx.lineWidth = 1.1;
  for (let i = 0; i < 12; i++) {
    const x = 40 + rng() * (W - 90);
    const y = 50 + rng() * (H - 120);
    const s = 12 + rng() * 26;
    ctx.strokeRect(x, y, s, s * 0.7);
  }

  // Upper-left wing carries the low-vis star-and-bar (Block 50 tactical jet).
  if (withInsignia) {
    drawStarAndBar(ctx, W * 0.56, H * 0.60, 46, 'rgba(52,58,64,0.78)');
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function glowTexture() {
  const s = 64;
  const c = createCanvas(s, s);
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// Solid, properly outward-wound geometry builders
// ---------------------------------------------------------------------------

/**
 * Loft closed rings along Z (ordered from -Z nose toward +Z tail).
 * Produces OUTWARD-facing triangles (CCW from outside) with clean seam UVs.
 * Ring options: { z, rx, ry, y, flatBottom?, chine?, topFlat?, rake? }
 * `rake` pulls the UPPER half of the ring forward (-Z), which builds the swept
 * "smiling" MCID inlet lip and the raked intake splitter.
 */
function loftRings(rings, segments = 28, opts = {}) {
  const { capStart = false, capEnd = false } = opts;
  const cols = segments + 1; // duplicate seam vertex for crisp UVs
  const pos = [];
  const uv = [];
  const idx = [];

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const flatB = ring.flatBottom ?? 0.85;
    const chine = ring.chine ?? 0;
    const topFlat = ring.topFlat ?? 1.0;
    const rake = ring.rake ?? 0;

    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const t = u * Math.PI * 2;
      const ct = Math.cos(t);
      const st = Math.sin(t);

      // Blended wing-body chine flare near the horizontal midline (st ≈ 0).
      const chineBoost = chine > 0 ? chine * Math.pow(Math.max(0, 1 - Math.abs(st) * 2.1), 2) : 0;
      const x = ct * (ring.rx + chineBoost);
      const ryScale = st < 0 ? flatB : topFlat;
      const y = ring.y + st * ring.ry * ryScale;
      const z = ring.z - rake * Math.max(0, st);

      pos.push(x, y, z);
      uv.push(u, r / (rings.length - 1));
    }
  }

  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < segments; i++) {
      const a = r * cols + i;
      const b = r * cols + i + 1;
      const c = a + cols;
      const d = b + cols;
      // Outward winding: (b - a) x (c - a) = (+tangent) x (+Z) = outward radial!
      idx.push(a, b, c, b, d, c);
    }
  }

  if (capStart) {
    const ring = rings[0];
    const centerIdx = pos.length / 3;
    pos.push(0, ring.y, ring.z);
    uv.push(0.5, 0);
    for (let i = 0; i < segments; i++) {
      // Faces -Z
      idx.push(centerIdx, i + 1, i);
    }
  }

  if (capEnd) {
    const rLast = rings.length - 1;
    const ring = rings[rLast];
    const centerIdx = pos.length / 3;
    pos.push(0, ring.y, ring.z);
    uv.push(0.5, 1);
    const base = rLast * cols;
    for (let i = 0; i < segments; i++) {
      // Faces +Z
      idx.push(centerIdx, base + i, base + i + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Loft an open arch (e.g., bubble canopy or dorsal spine) along Z.
 * Angle runs from startAng to endAng in XY plane. Outward normals guaranteed.
 */
function loftArch(rings, segments = 20, startAng = 0, endAng = Math.PI) {
  const cols = segments + 1;
  const pos = [];
  const uv = [];
  const idx = [];

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    for (let i = 0; i <= segments; i++) {
      const f = i / segments;
      const t = startAng + f * (endAng - startAng);
      const x = Math.cos(t) * ring.rx;
      const y = ring.y + Math.sin(t) * ring.ry;
      pos.push(x, y, ring.z);
      uv.push(f, r / (rings.length - 1));
    }
  }

  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < segments; i++) {
      const a = r * cols + i;
      const b = r * cols + i + 1;
      const c = a + cols;
      const d = b + cols;
      idx.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build a solid tapered airfoil-section surface (wing, stabilator, LERX, or
 * fin). Root and tip are defined by 3D leading-edge and trailing-edge points
 * plus thickness. `normalAxis` is 'y' for horizontal surfaces or 'x' for fins.
 */
function createAirfoilSurface({
  rootLE, rootTE, tipLE, tipTE,
  rootThick, tipThick,
  normalAxis = 'y',
  camber = 0.05,
}) {
  // 8-point airfoil loop around chord (0 = LE, upper surface -> TE -> lower).
  const profile = [
    [0.00,  0.00],
    [0.10,  0.38 + camber],
    [0.32,  0.54 + camber],
    [0.65,  0.38 + camber * 0.5],
    [1.00,  0.00],
    [0.65, -0.32 + camber * 0.2],
    [0.30, -0.44 + camber * 0.1],
    [0.10, -0.32],
  ];
  const n = profile.length;

  function sectionPoints(le, te, thick) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const [c, h] = profile[i];
      const px = le[0] + (te[0] - le[0]) * c;
      const py = le[1] + (te[1] - le[1]) * c;
      const pz = le[2] + (te[2] - le[2]) * c;
      const off = h * thick;
      if (normalAxis === 'y') pts.push([px, py + off, pz]);
      else pts.push([px + off, py, pz]);
    }
    return pts;
  }

  const rootPts = sectionPoints(rootLE, rootTE, rootThick);
  const tipPts = sectionPoints(tipLE, tipTE, tipThick);

  const rMid = [
    (rootLE[0] + rootTE[0]) * 0.5,
    (rootLE[1] + rootTE[1]) * 0.5,
    (rootLE[2] + rootTE[2]) * 0.5,
  ];
  const tMid = [
    (tipLE[0] + tipTE[0]) * 0.5,
    (tipLE[1] + tipTE[1]) * 0.5,
    (tipLE[2] + tipTE[2]) * 0.5,
  ];
  const span = [tMid[0] - rMid[0], tMid[1] - rMid[1], tMid[2] - rMid[2]];
  const chord = [rootTE[0] - rootLE[0], rootTE[1] - rootLE[1], rootTE[2] - rootLE[2]];
  const up = normalAxis === 'y' ? [0, 1, 0] : [1, 0, 0];
  const cx = chord[1] * up[2] - chord[2] * up[1];
  const cy = chord[2] * up[0] - chord[0] * up[2];
  const cz = chord[0] * up[1] - chord[1] * up[0];
  const flip = (cx * span[0] + cy * span[1] + cz * span[2]) < 0;

  const pos = [];
  const uv = [];
  const idx = [];

  for (let i = 0; i < n; i++) {
    pos.push(...rootPts[i]);
    uv.push(profile[i][0], 0);
  }
  for (let i = 0; i < n; i++) {
    pos.push(...tipPts[i]);
    uv.push(profile[i][0], 1);
  }

  for (let i = 0; i < n; i++) {
    const ni = (i + 1) % n;
    const a = i;
    const b = ni;
    const c = n + i;
    const d = n + ni;
    if (!flip) idx.push(a, c, b, b, c, d);
    else idx.push(a, b, c, b, d, c);
  }

  const rootCenter = pos.length / 3;
  pos.push(...rMid);
  uv.push(0.5, 0);
  for (let i = 0; i < n; i++) {
    const ni = (i + 1) % n;
    if (!flip) idx.push(rootCenter, i, ni);
    else idx.push(rootCenter, ni, i);
  }

  const tipCenter = pos.length / 3;
  pos.push(...tMid);
  uv.push(0.5, 1);
  for (let i = 0; i < n; i++) {
    const ni = (i + 1) % n;
    if (!flip) idx.push(tipCenter, n + ni, n + i);
    else idx.push(tipCenter, n + i, n + ni);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * One merged ring of overlapping nozzle petals (a single draw call per ring).
 * Supports a multi-station convergent-divergent profile and an alternating
 * radial feather so the individual carbon-composite flaps read in silhouette.
 * Built around the local origin so scaling the mesh radially constricts / flares
 * the iris.
 */
function nozzleRingGeometry({ stations, count = 16, feather = 0.012, overlap = 1.16 }) {
  const pos = [];
  const idx = [];
  const step = (Math.PI * 2) / count;
  const half = (step * overlap) * 0.5;
  for (let i = 0; i < count; i++) {
    const a = i * step;
    const rf = 1 + (i % 2 === 0 ? feather : -feather);
    for (let s = 0; s < stations.length - 1; s++) {
      const [z0, r0] = stations[s];
      const [z1, r1] = stations[s + 1];
      const base = pos.length / 3;
      pos.push(Math.cos(a - half) * r0 * rf, Math.sin(a - half) * r0 * rf, z0);
      pos.push(Math.cos(a + half) * r0 * rf, Math.sin(a + half) * r0 * rf, z0);
      pos.push(Math.cos(a + half) * r1 * rf, Math.sin(a + half) * r1 * rf, z1);
      pos.push(Math.cos(a - half) * r1 * rf, Math.sin(a - half) * r1 * rf, z1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// External Pilot Figure (shown in external camera views, hidden in cockpit)
// ---------------------------------------------------------------------------
function createExternalPilot() {
  const pilot = new THREE.Group();
  pilot.name = 'externalPilot';

  const suitMat = new THREE.MeshStandardMaterial({ color: 0x4b5643, roughness: 0.85, metalness: 0.05 });
  const vestMat = new THREE.MeshStandardMaterial({ color: 0x383e36, roughness: 0.8, metalness: 0.1 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0x767e82, roughness: 0.32, metalness: 0.25 });
  const visorMat = new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.12, metalness: 0.85 });
  const maskMat = new THREE.MeshStandardMaterial({ color: 0x262a2c, roughness: 0.7, metalness: 0.1 });

  // Reclined torso (ACES II seat has ~30° recline, seated under the bubble).
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.40, 0.22), suitMat);
  torso.position.set(0, 0.56, -2.32);
  torso.rotation.x = 0.34;
  pilot.add(torso);

  const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.22, 6, 10), vestMat);
  shoulders.rotation.z = Math.PI / 2;
  shoulders.position.set(0, 0.72, -2.26);
  pilot.add(shoulders);

  // HGU-55/P Flight Helmet.
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), helmetMat);
  helmet.scale.set(0.95, 1.04, 1.08);
  helmet.position.set(0, 0.95, -2.24);
  pilot.add(helmet);

  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.143, 14, 10, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.26, Math.PI * 0.34),
    visorMat,
  );
  visor.rotation.y = Math.PI; // face -Z
  visor.position.set(0, 0.95, -2.245);
  pilot.add(visor);

  const mask = new THREE.Mesh(new THREE.ConeGeometry(0.052, 0.10, 8), maskMat);
  mask.rotation.x = -Math.PI * 0.42;
  mask.position.set(0, 0.87, -2.36);
  pilot.add(mask);

  return pilot;
}

// ---------------------------------------------------------------------------
// Main F-16C Block 50 Builder
// ---------------------------------------------------------------------------
export function createF16() {
  const group = new THREE.Group();
  group.name = 'F-16C';

  const bodyTex = createAirframeTexture();
  const wingTexR = createWingTexture(false);
  const wingTexL = createWingTexture(true);

  const bodyMat = new THREE.MeshStandardMaterial({
    map: bodyTex, color: 0xffffff, roughness: 0.56, metalness: 0.18,
  });
  const wingMatR = new THREE.MeshStandardMaterial({
    map: wingTexR, color: 0xffffff, roughness: 0.58, metalness: 0.18,
  });
  const wingMatL = new THREE.MeshStandardMaterial({
    map: wingTexL, color: 0xffffff, roughness: 0.58, metalness: 0.18,
  });
  const spineMat = new THREE.MeshStandardMaterial({
    color: 0x646e77, roughness: 0.55, metalness: 0.2,
  });
  const darkTrimMat = new THREE.MeshStandardMaterial({
    color: 0x3b4147, roughness: 0.52, metalness: 0.42,
  });
  const radomeMat = new THREE.MeshStandardMaterial({
    color: 0x565d63, roughness: 0.74, metalness: 0.08,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x9aa2a8, roughness: 0.32, metalness: 0.82,
  });
  const titaniumMat = new THREE.MeshStandardMaterial({
    color: 0x7d848c, roughness: 0.38, metalness: 0.78,
  });
  const carbonMat = new THREE.MeshStandardMaterial({
    color: 0x2a2d33, roughness: 0.64, metalness: 0.35,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x1b1d1f, roughness: 0.92, metalness: 0.05,
  });
  // Dark S-duct interior: rendered from the inside of the throat.
  const intakeInnerMat = new THREE.MeshBasicMaterial({
    color: 0x090b0d, side: THREE.BackSide,
  });
  const intakeThroatMat = new THREE.MeshBasicMaterial({ color: 0x090b0d });

  // Gold-tinted ITO polycarbonate canopy (adjusted for cockpit vs external).
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xc29e58,
    emissive: 0x1b1508,
    emissiveIntensity: 0.35,
    roughness: 0.08,
    metalness: 0.35,
    transparent: true,
    opacity: 0.52,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x2f3539, roughness: 0.48, metalness: 0.45,
  });

  const navLights = { bulbs: [], halos: [] };

  // -------------------------------------------------------------------------
  // 1. Tangent-ogive radome, pitot probe, AoA vanes & TAT probes
  //    Structural tip z = -7.36, base z = -5.15, slightly downturned axis.
  // -------------------------------------------------------------------------
  const radomeRings = [
    { z: -7.36, rx: 0.018, ry: 0.016, y: 0.055 },
    { z: -7.20, rx: 0.085, ry: 0.074, y: 0.058 },
    { z: -6.98, rx: 0.155, ry: 0.136, y: 0.062 },
    { z: -6.70, rx: 0.235, ry: 0.205, y: 0.070 },
    { z: -6.36, rx: 0.315, ry: 0.275, y: 0.080 },
    { z: -6.00, rx: 0.380, ry: 0.332, y: 0.092 },
    { z: -5.62, rx: 0.424, ry: 0.382, y: 0.104 },
    { z: -5.35, rx: 0.445, ry: 0.408, y: 0.112 },
    { z: -5.15, rx: 0.452, ry: 0.422, y: 0.118 },
  ];
  const radome = new THREE.Mesh(loftRings(radomeRings, 28, { capStart: true }), radomeMat);
  radome.name = 'radome';
  group.add(radome);

  // Four metallic lightning-diverter strips laid along the radome ogive.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Follow a cone generator from the nose (r 0.135) to the radome base.
    const p0 = new THREE.Vector3(ca * 0.150, 0.066 + sa * 0.130, -7.02);
    const p1 = new THREE.Vector3(ca * 0.372, 0.106 + sa * 0.322, -5.52);
    const fixed = new THREE.Vector3(ca * 0.020, sa * 0.020, 0);
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(0.024, 0.012, p0.distanceTo(p1) + 0.02),
      metalMat,
    );
    strip.position.copy(p0).add(p1).multiplyScalar(0.5).addScaledVector(fixed, 0.55);
    strip.lookAt(p1.clone().addScaledVector(fixed, 0.55));
    group.add(strip);
  }

  // Needle pitot probe: 0.50 m ahead of the radome tip (z = -7.86).
  const pitot = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.016, 0.50, 8), metalMat);
  pitot.rotation.x = Math.PI / 2;
  pitot.position.set(0, 0.055, -7.61);
  group.add(pitot);

  // Twin side AoA vanes and dual TAT probes on the forward fuselage.
  for (const side of [-1, 1]) {
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.016, 0.075), darkTrimMat);
    vane.position.set(side * 0.415, 0.085, -5.90);
    group.add(vane);
    const tat = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.16, 6), metalMat);
    tat.rotation.z = Math.PI / 2;
    tat.position.set(side * 0.395, -0.06, -6.35);
    group.add(tat);
  }

  // -------------------------------------------------------------------------
  // 2. Slender wasp-waisted blended wing-body fuselage with LERX chines
  //    z = -5.15 .. +6.55, ry ≈ 0.54..0.58, flat belly, subtle gun bulge.
  // -------------------------------------------------------------------------
  const fuselageRings = [
    { z: -5.15, rx: 0.452, ry: 0.422, y: 0.118, flatBottom: 0.94, chine: 0.00 },
    { z: -4.70, rx: 0.500, ry: 0.480, y: 0.150, flatBottom: 0.90, chine: 0.05 },
    { z: -4.20, rx: 0.540, ry: 0.510, y: 0.170, flatBottom: 0.88, chine: 0.12 },
    { z: -3.60, rx: 0.570, ry: 0.530, y: 0.185, flatBottom: 0.87, chine: 0.19 },
    { z: -3.00, rx: 0.592, ry: 0.545, y: 0.195, flatBottom: 0.87, chine: 0.26 },
    { z: -2.40, rx: 0.605, ry: 0.552, y: 0.200, flatBottom: 0.88, chine: 0.32 },
    { z: -1.80, rx: 0.612, ry: 0.558, y: 0.200, flatBottom: 0.88, chine: 0.34 },
    { z: -1.20, rx: 0.612, ry: 0.560, y: 0.198, flatBottom: 0.88, chine: 0.31 },
    { z: -0.60, rx: 0.618, ry: 0.556, y: 0.192, flatBottom: 0.89, chine: 0.24 },
    { z:  0.20, rx: 0.625, ry: 0.548, y: 0.185, flatBottom: 0.90, chine: 0.16 },
    { z:  1.20, rx: 0.622, ry: 0.548, y: 0.178, flatBottom: 0.92, chine: 0.10 },
    { z:  2.20, rx: 0.615, ry: 0.552, y: 0.172, flatBottom: 0.94, chine: 0.06 },
    { z:  3.20, rx: 0.600, ry: 0.552, y: 0.166, flatBottom: 0.96, chine: 0.03 },
    { z:  4.20, rx: 0.572, ry: 0.540, y: 0.160, flatBottom: 0.98, chine: 0.01 },
    { z:  5.10, rx: 0.535, ry: 0.515, y: 0.156, flatBottom: 1.00, chine: 0.00 },
    { z:  5.85, rx: 0.500, ry: 0.490, y: 0.152, flatBottom: 1.00, chine: 0.00 },
    { z:  6.55, rx: 0.470, ry: 0.462, y: 0.148, flatBottom: 1.00, chine: 0.00 },
  ];
  const fuselageGeo = loftRings(fuselageRings, 32, { capEnd: true });
  // Open only the cockpit cutout so cockpit.js's interior stays unobstructed.
  {
    const pos = fuselageGeo.attributes.position;
    const idx = fuselageGeo.index.array;
    const keep = [];
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i];
      const b = idx[i + 1];
      const c = idx[i + 2];
      const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
      const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
      const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
      const inCockpit = cy > 0.62 && cz > -3.68 && cz < -1.00 && Math.abs(cx) < 0.59;
      if (!inCockpit) keep.push(a, b, c);
    }
    fuselageGeo.setIndex(keep);
    fuselageGeo.computeVertexNormals();
  }
  const fuselage = new THREE.Mesh(fuselageGeo, bodyMat);
  fuselage.name = 'fuselage';
  group.add(fuselage);

  // M61A1 Vulcan gun fairing bulge on the port (left) upper LERX root, with a
  // dark recessed muzzle louver — an unmistakable F-16 signature.
  {
    const bulge = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), bodyMat);
    bulge.scale.set(0.90, 1.15, 6.4);
    bulge.position.set(-0.615, 0.315, -2.95);
    group.add(bulge);
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.062, 0.34, 12), darkTrimMat);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(-0.675, 0.275, -2.42);
    group.add(muzzle);
    const muzzleFace = new THREE.Mesh(new THREE.CircleGeometry(0.048, 12), intakeThroatMat);
    muzzleFace.rotation.y = Math.PI;
    muzzleFace.position.set(-0.675, 0.275, -2.60);
    group.add(muzzleFace);
  }

  // External canopy sill fairings close the gap between the skin and the bubble.
  for (const side of [-1, 1]) {
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.15, 3.10), bodyMat);
    sill.position.set(side * 0.548, 0.690, -2.42);
    sill.rotation.z = -side * 0.13;
    group.add(sill);
  }

  // Anti-glare shield shelf: the raised frost panel the forward windscreen
  // seats on (the slim forebody deck is narrower than the canopy base).
  {
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.02, 0.44), darkTrimMat);
    deck.position.set(0, 0.697, -3.89);
    group.add(deck);
  }

  // -------------------------------------------------------------------------
  // 3. Sloping dorsal spine (rear canopy bow -> fin root) + refuelling slipway
  // -------------------------------------------------------------------------
  const spineRings = [
    { z: -0.96, rx: 0.440, ry: 0.220, y: 0.730 },
    { z: -0.20, rx: 0.410, ry: 0.200, y: 0.710 },
    { z:  0.70, rx: 0.370, ry: 0.170, y: 0.690 },
    { z:  1.70, rx: 0.320, ry: 0.145, y: 0.660 },
    { z:  2.70, rx: 0.270, ry: 0.115, y: 0.630 },
    { z:  3.70, rx: 0.210, ry: 0.080, y: 0.600 },
    { z:  4.70, rx: 0.140, ry: 0.050, y: 0.575 },
    { z:  5.60, rx: 0.080, ry: 0.025, y: 0.560 },
  ];
  const spine = new THREE.Mesh(loftArch(spineRings, 14, 0, Math.PI), spineMat);
  group.add(spine);

  // Forward bulkhead closing the spine arch.
  const spineCap = new THREE.Mesh(new THREE.CircleGeometry(0.44, 16, 0, Math.PI), darkTrimMat);
  spineCap.scale.set(1, 0.5, 1);
  spineCap.rotation.y = Math.PI; // face forward (-Z)
  spineCap.position.set(0, 0.730, -0.96);
  group.add(spineCap);

  // Aerial-refuelling slipway door behind the cockpit.
  {
    const slipway = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.014, 0.50), darkTrimMat);
    slipway.position.set(0, 0.890, 0.42);
    slipway.rotation.x = 0.055;
    group.add(slipway);
    const slipFrame = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.008, 0.54), metalMat);
    slipFrame.position.set(0, 0.884, 0.42);
    slipFrame.rotation.x = 0.055;
    group.add(slipFrame);
  }

  // Swept IFF/UHF blade antennas + dorsal anti-collision strobe.
  {
    const uhf = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.24, 0.30), darkTrimMat);
    uhf.position.set(0, 0.905, 1.55);
    uhf.rotation.x = -0.42;
    group.add(uhf);
    const iff = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.16, 0.22), darkTrimMat);
    iff.position.set(0, 0.760, 3.05);
    iff.rotation.x = -0.36;
    group.add(iff);
    const strobe = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3326, toneMapped: false }),
    );
    strobe.position.set(0, 0.955, -0.80);
    group.add(strobe);
  }

  // -------------------------------------------------------------------------
  // 4. MCID "Big Mouth" raked chin intake
  //    Upper splitter lip z = -3.65, lower lip z = -3.30 (35 cm side rake).
  // -------------------------------------------------------------------------
  const intakeRings = [
    { z: -3.30, rx: 0.470, ry: 0.310, y: -0.640, flatBottom: 0.95, rake: 0.35 },
    { z: -3.18, rx: 0.472, ry: 0.312, y: -0.640, flatBottom: 0.95, rake: 0.28 },
    { z: -2.80, rx: 0.474, ry: 0.318, y: -0.632, flatBottom: 0.94, rake: 0.14 },
    { z: -2.10, rx: 0.470, ry: 0.318, y: -0.614, flatBottom: 0.93, rake: 0.05 },
    { z: -1.30, rx: 0.452, ry: 0.300, y: -0.585, flatBottom: 0.92 },
    { z: -0.30, rx: 0.418, ry: 0.262, y: -0.530, flatBottom: 0.92 },
    { z:  0.70, rx: 0.360, ry: 0.210, y: -0.450, flatBottom: 0.92 },
    { z:  1.30, rx: 0.300, ry: 0.158, y: -0.372, flatBottom: 0.92 },
  ];
  const intakeBody = new THREE.Mesh(loftRings(intakeRings, 26), bodyMat);
  group.add(intakeBody);

  // Dark raked lip band following the mouth.
  const intakeLipRings = [
    { z: -3.302, rx: 0.478, ry: 0.318, y: -0.640, flatBottom: 0.95, rake: 0.352 },
    { z: -3.212, rx: 0.478, ry: 0.318, y: -0.640, flatBottom: 0.95, rake: 0.322 },
  ];
  const intakeLip = new THREE.Mesh(loftRings(intakeLipRings, 26), darkTrimMat);
  group.add(intakeLip);

  // Deep dark S-duct throat (seen from the front as a receding duct).
  const throatRings = [
    { z: -3.285, rx: 0.452, ry: 0.296, y: -0.640, flatBottom: 0.95, rake: 0.345 },
    { z: -2.72, rx: 0.432, ry: 0.280, y: -0.626, flatBottom: 0.94 },
    { z: -2.10, rx: 0.392, ry: 0.252, y: -0.606, flatBottom: 0.94 },
  ];
  const intakeThroat = new THREE.Mesh(loftRings(throatRings, 22), intakeInnerMat);
  group.add(intakeThroat);

  // Dark cap closing the far end of the S-duct (no see-through intake).
  const throatCap = new THREE.Mesh(new THREE.CircleGeometry(1, 20), intakeThroatMat);
  throatCap.rotation.y = Math.PI; // faces forward, into the duct
  throatCap.scale.set(0.392, 0.252, 1);
  throatCap.position.set(0, -0.606, -2.105);
  group.add(throatCap);

  // Boundary-layer diverter duct fairing: closes the slot between the belly and
  // the intake roof aft of the splitter lip.
  {
    const diverter = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.07, 3.80), darkTrimMat);
    diverter.position.set(0, -0.315, -1.80);
    group.add(diverter);
  }

  // Iconic single vertical intake structural strut just inside the upper mouth.
  {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.26, 0.12), titaniumMat);
    strut.position.set(0, -0.400, -3.235);
    group.add(strut);
    const strutFoot = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.045, 0.10, 8), titaniumMat);
    strutFoot.position.set(0, -0.520, -3.235);
    group.add(strutFoot);
  }

  // Boundary-layer diverter wedge between the fuselage belly and the intake top.
  // Wide enough to show its dark side lips outboard of the intake mouth.
  {
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.06, 0.62), darkTrimMat);
    splitter.position.set(0, -0.325, -3.42);
    splitter.rotation.x = 0.04;
    group.add(splitter);
  }

  // ECS / chin light housings and slim navigation formation lights.
  for (const side of [-1, 1]) {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.13, 0.30), darkTrimMat);
    housing.position.set(side * 0.478, -0.640, -3.10);
    group.add(housing);
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.075, 0.10),
      new THREE.MeshBasicMaterial({ color: 0xfff2cc, toneMapped: false }),
    );
    lamp.position.set(side * 0.530, -0.640, -3.14);
    group.add(lamp);
    const form = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, 0.05, 0.30),
      new THREE.MeshBasicMaterial({ color: 0x6fe6a0, toneMapped: false }),
    );
    form.position.set(side * 0.505, -0.145, -0.10);
    group.add(form);
  }

  // -------------------------------------------------------------------------
  // 5. Razor-thin cropped-delta wings (40° LE, 0° TE, 4% t/c) + LERX blend
  // -------------------------------------------------------------------------
  // Geometry: root LE z = -1.27 at x = ±0.85, TE dead straight at z = +3.10.
  // root chord 4.37 m, tip chord 1.12 m at ±4.725 -> LE sweep exactly 40.0°.
  const flaperons = [];
  const leFlaps = [];

  for (const side of [-1, 1]) {
    const wingMat = side < 0 ? wingMatL : wingMatR;

    // Wing-root blended fillet fairing.
    const fillet = new THREE.Mesh(
      createAirfoilSurface({
        rootLE: [side * 0.60, 0.02, -1.05],
        rootTE: [side * 0.60, 0.02, 2.45],
        tipLE:  [side * 1.22, 0.02, -1.24],
        tipTE:  [side * 1.22, 0.02, 2.92],
        rootThick: 0.10,
        tipThick: 0.10,
        normalAxis: 'y',
        camber: 0.02,
      }),
      bodyMat,
    );
    group.add(fillet);

    // Main wing: root chord 4.37, tip chord 1.12, 4% thickness.
    const wing = new THREE.Mesh(
      createAirfoilSurface({
        rootLE: [side * 0.85, 0.02, -1.27],
        rootTE: [side * 0.85, 0.02,  3.10],
        tipLE:  [side * 4.725, 0.02,  1.98],
        tipTE:  [side * 4.725, 0.02,  3.10],
        rootThick: 0.170,
        tipThick: 0.050,
        normalAxis: 'y',
        camber: 0.02,
      }),
      wingMat,
    );
    wing.name = side < 0 ? 'wingL' : 'wingR';
    group.add(wing);

    // Articulated leading-edge flap, built in wing coordinates and hinged about
    // the swept (40°) hinge line so it droops without opening a gap.
    const lefPivot = new THREE.Group();
    lefPivot.name = side < 0 ? 'lefL' : 'lefR';
    lefPivot.position.set(0, 0.02, LEF_HINGE_Z0);
    const lef = new THREE.Mesh(
      createAirfoilSurface({
        // Local Z is shifted so the hinge line passes through the pivot origin.
        rootLE: [side * 0.88, 0, -1.24 - LEF_HINGE_Z0],
        rootTE: [side * 0.88, 0, -0.72 - LEF_HINGE_Z0],
        tipLE:  [side * 4.70, 0,  1.99 - LEF_HINGE_Z0],
        tipTE:  [side * 4.70, 0,  2.51 - LEF_HINGE_Z0],
        rootThick: 0.055,
        tipThick: 0.026,
        normalAxis: 'y',
        camber: 0.01,
      }),
      wingMat,
    );
    lefPivot.add(lef);
    group.add(lefPivot);
    leFlaps.push({ side, pivot: lefPivot, mesh: lef });

    // Flush single-piece trailing-edge flaperon on the dead-straight TE.
    const flapPivot = new THREE.Group();
    flapPivot.position.set(side * 2.85, 0.02, 2.74);
    const flapMesh = new THREE.Mesh(new THREE.BoxGeometry(2.55, 0.048, 0.36), wingMat);
    flapMesh.position.set(0, 0, 0.18);
    flapPivot.add(flapMesh);
    group.add(flapPivot);
    flaperons.push({ side, pivot: flapPivot });

    // Wingtip LAU-129 launch rail: x = ±4.72 .. ±4.98 -> 9.96 m span. The
    // inboard 0.26 m flange mounts flush on the wingtip (bare wing ±4.725).
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.095, 1.76), darkTrimMat);
    rail.position.set(side * 4.85, 0.035, 2.52);
    group.add(rail);
    const railNose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.20, 8), metalMat);
    railNose.rotation.x = -Math.PI / 2;
    railNose.position.set(side * 4.93, 0.035, 1.54);
    group.add(railNose);
    const railTail = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 8), darkTrimMat);
    railTail.rotation.x = Math.PI / 2;
    railTail.position.set(side * 4.93, 0.035, 3.40);
    group.add(railTail);

    // Wingtip navigation light: port red, starboard green.
    const lightColor = side < 0 ? 0xff2b2b : 0x2bff6a;
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 6),
      new THREE.MeshBasicMaterial({ color: lightColor, toneMapped: false }),
    );
    bulb.position.set(side * 4.93, 0.04, 1.72);
    group.add(bulb);
    navLights.bulbs.push(bulb);

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: lightColor, transparent: true, opacity: 0.72,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    halo.scale.set(0.22, 0.22, 1);
    halo.position.set(side * 4.870, 0.04, 1.72);
    group.add(halo);
    navLights.halos.push(halo);
  }

  // -------------------------------------------------------------------------
  // 6. Vertical tail fin (5.09 m total height), dorsal fillet, parabrake
  //    Both fin LE (~47°) and TE (~10°) sweep AFT.
  // -------------------------------------------------------------------------
  const fin = new THREE.Mesh(
    createAirfoilSurface({
      rootLE: [0, 0.56, 2.05],
      rootTE: [0, 0.56, 5.95],
      tipLE:  [0, 3.50, 4.85],
      tipTE:  [0, 3.50, 6.15],
      rootThick: 0.18,
      tipThick: 0.06,
      normalAxis: 'x',
      camber: 0,
    }),
    bodyMat,
  );
  fin.name = 'tailFin';
  group.add(fin);

  // RWR / ECM tip cap reaching the published 5.09 m height (y = +3.53).
  const finCap = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.06, 1.10), darkTrimMat);
  finCap.position.set(0, 3.50, 5.50);
  group.add(finCap);
  const finCapTip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.028, 0.42), metalMat);
  finCapTip.position.set(0, 3.516, 5.02);
  group.add(finCapTip);

  // Iconic extended dorsal fin-root fillet blending into the spine.
  const dorsalFillet = new THREE.Mesh(
    createAirfoilSurface({
      rootLE: [0, 0.585, 1.42],
      rootTE: [0, 0.585, 3.55],
      tipLE:  [0, 0.985, 2.42],
      tipTE:  [0, 0.985, 3.55],
      rootThick: 0.16,
      tipThick: 0.04,
      normalAxis: 'x',
      camber: 0,
    }),
    bodyMat,
  );
  group.add(dorsalFillet);

  // Block 50 tail-base / parabrake fairing with aft white nav light.
  const parabrake = new THREE.Mesh(
    loftRings([
      { z: 5.75, rx: 0.115, ry: 0.150, y: 0.700 },
      { z: 6.15, rx: 0.122, ry: 0.155, y: 0.700 },
      { z: 6.55, rx: 0.104, ry: 0.132, y: 0.700 },
      { z: 6.85, rx: 0.070, ry: 0.090, y: 0.700 },
    ], 14, { capStart: true, capEnd: true }),
    bodyMat,
  );
  group.add(parabrake);

  const tailBulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 6, 5),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
  );
  tailBulb.position.set(0, 0.700, 6.86);
  group.add(tailBulb);
  navLights.bulbs.push(tailBulb);

  // Top red anti-collision beacon on the tail base.
  const tailBeacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.036, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff2418, toneMapped: false }),
  );
  tailBeacon.position.set(0, 0.858, 6.30);
  group.add(tailBeacon);
  navLights.bulbs.push(tailBeacon);

  // Aft-swept pivoting rudder, flush with the fin's +10° TE slope.
  const rudderPivot = new THREE.Group();
  rudderPivot.position.set(0, 0, 5.66);
  const rudderMesh = new THREE.Mesh(
    createAirfoilSurface({
      rootLE: [0, 0.86, -0.20],
      rootTE: [0, 0.86,  0.30],
      tipLE:  [0, 3.32, -0.10],
      tipTE:  [0, 3.32,  0.46],
      rootThick: 0.075,
      tipThick: 0.045,
      normalAxis: 'x',
      camber: 0,
    }),
    bodyMat,
  );
  rudderPivot.add(rudderMesh);
  group.add(rudderPivot);

  // -------------------------------------------------------------------------
  // 7. Big-tail all-moving horizontal stabilators (5.57 m span, 10° anhedral)
  // -------------------------------------------------------------------------
  const stabPivotL = new THREE.Group();
  const stabPivotR = new THREE.Group();
  stabPivotL.position.set(-0.64, 0.02, 5.45);
  stabPivotR.position.set( 0.64, 0.02, 5.45);

  for (const side of [-1, 1]) {
    // Half-span 2.145 m, LE 40° sweep, tip drops 0.38 m (10° anhedral).
    const stab = new THREE.Mesh(
      createAirfoilSurface({
        rootLE: [0, 0, -1.05],
        rootTE: [0, 0,  0.95],
        tipLE:  [side * 2.145, -0.38,  0.75],
        tipTE:  [side * 2.145, -0.38,  1.35],
        rootThick: 0.115,
        tipThick: 0.045,
        normalAxis: 'y',
        camber: 0,
      }),
      side < 0 ? wingMatL : wingMatR,
    );
    stab.name = side < 0 ? 'stabL' : 'stabR';
    (side < 0 ? stabPivotL : stabPivotR).add(stab);
  }
  group.add(stabPivotL, stabPivotR);

  // Twin sculpted aft tail-boom fairings flanking the engine bay.
  for (const side of [-1, 1]) {
    const boom = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), bodyMat);
    boom.scale.set(0.165, 0.300, 1.38);
    boom.position.set(side * 0.640, 0.120, 4.85);
    group.add(boom);
  }

  // -------------------------------------------------------------------------
  // 8. Canted ventral fins, split clam-shell speedbrakes and arrestor hook
  // -------------------------------------------------------------------------
  for (const side of [-1, 1]) {
    const vfPivot = new THREE.Group();
    vfPivot.position.set(side * 0.500, -0.340, 5.15);
    vfPivot.rotation.z = side * 0.279; // 16° outward cant
    const vf = new THREE.Mesh(
      createAirfoilSurface({
        rootLE: [0,  0.00, -0.86],
        rootTE: [0,  0.00,  0.72],
        tipLE:  [0, -0.50, -0.34],
        tipTE:  [0, -0.46,  0.62],
        rootThick: 0.055,
        tipThick: 0.025,
        normalAxis: 'x',
        camber: 0,
      }),
      bodyMat,
    );
    vfPivot.add(vf);
    group.add(vfPivot);
  }

  // Tucked centerline arrestor hook between the ventral fins.
  {
    const hookShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.62, 8), metalMat);
    hookShaft.rotation.x = Math.PI / 2 - 0.30;
    hookShaft.position.set(0, -0.430, 5.72);
    group.add(hookShaft);
    const hookClaw = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.020, 6, 10, Math.PI), darkTrimMat);
    hookClaw.rotation.x = Math.PI / 2;
    hookClaw.position.set(0, -0.500, 6.03);
    group.add(hookClaw);
  }

  // Split clam-shell speedbrakes on the aft tail booms (top & bottom paddles).
  const speedbrakes = [];
  for (const side of [-1, 1]) {
    for (const vert of [-1, 1]) {
      const sbPivot = new THREE.Group();
      sbPivot.position.set(side * 0.600, 0.120 + vert * 0.18, 5.72);
      const petal = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.30, 0.78), darkTrimMat);
      petal.position.set(side * 0.03, vert * 0.10, 0.24);
      sbPivot.add(petal);
      group.add(sbPivot);
      speedbrakes.push({ side, vert, pivot: sbPivot });
    }
  }

  // -------------------------------------------------------------------------
  // 9. GE F110-GE-129 convergent-divergent nozzle (exit plane z = +7.20)
  // -------------------------------------------------------------------------
  const nozzleGroup = new THREE.Group();
  nozzleGroup.position.set(0, 0.120, 6.55);
  group.add(nozzleGroup);

  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.505, 0.525, 0.30, 24), metalMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.z = 0.14;
  nozzleGroup.add(collar);

  // 16 dark carbon-composite outer primary flaps: convergent-divergent ring.
  const outerPetals = new THREE.Mesh(
    nozzleRingGeometry({
      stations: [[0.24, 0.500], [0.52, 0.405], [0.65, 0.435]],
      count: 16,
      feather: 0.014,
    }),
    carbonMat,
  );
  outerPetals.name = 'nozzlePetalsOuter';
  nozzleGroup.add(outerPetals);

  // Lighter titanium-alloy inner divergent leaves.
  const innerPetals = new THREE.Mesh(
    nozzleRingGeometry({
      stations: [[0.34, 0.438], [0.56, 0.372], [0.65, 0.400]],
      count: 16,
      feather: 0.010,
    }),
    titaniumMat,
  );
  innerPetals.name = 'nozzlePetalsInner';
  nozzleGroup.add(innerPetals);
  const nozzlePetals = [outerPetals, innerPetals];

  // Dark inner exhaust recess & glowing flameholder ring, aligned to the exit.
  const exhaustRecess = new THREE.Mesh(new THREE.CircleGeometry(0.345, 20), intakeThroatMat);
  exhaustRecess.position.z = 0.60;
  nozzleGroup.add(exhaustRecess);

  const flameHolder = new THREE.Mesh(
    new THREE.TorusGeometry(0.235, 0.030, 6, 18),
    new THREE.MeshBasicMaterial({ color: 0xff6a24, transparent: true, opacity: 0.08, toneMapped: false }),
  );
  flameHolder.position.z = 0.585;
  nozzleGroup.add(flameHolder);

  // Afterburner plume. The group is pinned to the nozzle exit and squashed to
  // zero length while the burner is off so the airframe measures 15.06 m.
  const burnerGroup = new THREE.Group();
  burnerGroup.position.set(0, 0.120, 7.20);
  burnerGroup.scale.set(1, 1, 0.001);
  group.add(burnerGroup);

  const burnerGlow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.40, 2.60, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xff7b29, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }),
  );
  burnerGlow.rotation.x = Math.PI / 2;
  burnerGlow.position.z = 1.30;
  burnerGroup.add(burnerGlow);

  const burnerCore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.24, 1.85, 14, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xb6e0ff, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }),
  );
  burnerCore.rotation.x = Math.PI / 2;
  burnerCore.position.z = 0.92;
  burnerGroup.add(burnerCore);

  const shockDiamonds = [];
  for (let i = 0; i < 3; i++) {
    const d = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.16 - i * 0.03, 0),
      new THREE.MeshBasicMaterial({
        color: 0xffe4b8, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      }),
    );
    d.scale.set(0.85, 0.85, 2.2);
    d.position.z = 0.45 + i * 0.62;
    burnerGroup.add(d);
    shockDiamonds.push(d);
  }

  // -------------------------------------------------------------------------
  // 10. Frameless teardrop ITO bubble canopy (clears the HUD at y = 1.38+)
  // -------------------------------------------------------------------------
  const canopyRings = [
    { z: -4.30, rx: 0.180, ry: 0.010, y: 0.700 },
    { z: -4.15, rx: 0.320, ry: 0.200, y: 0.705 },
    { z: -3.95, rx: 0.440, ry: 0.420, y: 0.712 },
    { z: -3.72, rx: 0.510, ry: 0.600, y: 0.722 },
    { z: -3.50, rx: 0.545, ry: 0.660, y: 0.728 },
    { z: -3.20, rx: 0.570, ry: 0.675, y: 0.732 },
    { z: -2.70, rx: 0.585, ry: 0.675, y: 0.735 },
    { z: -2.20, rx: 0.580, ry: 0.660, y: 0.732 },
    { z: -2.00, rx: 0.578, ry: 0.655, y: 0.732 },
    { z: -1.80, rx: 0.565, ry: 0.600, y: 0.728 },
    { z: -1.40, rx: 0.545, ry: 0.460, y: 0.722 },
    { z: -1.10, rx: 0.520, ry: 0.330, y: 0.716 },
    { z: -0.96, rx: 0.500, ry: 0.240, y: 0.712 },
  ];
  const canopy = new THREE.Mesh(loftArch(canopyRings, 28, 0, Math.PI), glassMat);
  canopy.name = 'canopy';
  canopy.renderOrder = 4;
  group.add(canopy);

  // Crisp dark sill rails (no forward bow: the F-16 windscreen is frameless).
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.05, 2.72), frameMat);
    rail.position.set(side * 0.552, 0.726, -2.42);
    group.add(rail);
  }
  // Single sculpted rear canopy hinge bow.
  const aftArch = new THREE.Mesh(new THREE.TorusGeometry(0.505, 0.026, 8, 22, Math.PI), frameMat);
  aftArch.scale.set(1, 0.48, 1);
  aftArch.position.set(0, 0.712, -0.98);
  group.add(aftArch);

  // External pilot figure (hidden in cockpit view).
  const pilotGroup = createExternalPilot();
  group.add(pilotGroup);

  // -------------------------------------------------------------------------
  // 11. 370-gal underwing drop tanks on sculpted swept pylons
  // -------------------------------------------------------------------------
  for (const side of [-1, 1]) {
    const pylon = new THREE.Mesh(
      createAirfoilSurface({
        rootLE: [0,  0.03, -0.90],
        rootTE: [0,  0.03,  0.92],
        tipLE:  [0, -0.46, -0.74],
        tipTE:  [0, -0.46,  0.80],
        rootThick: 0.105,
        tipThick: 0.075,
        normalAxis: 'x',
        camber: 0,
      }),
      bodyMat,
    );
    pylon.position.set(side * 2.28, 0.0, 1.30);
    group.add(pylon);

    const tank = new THREE.Group();
    const tankRings = [
      { z: -2.15, rx: 0.015, ry: 0.015, y: 0 },
      { z: -1.86, rx: 0.120, ry: 0.120, y: 0 },
      { z: -1.45, rx: 0.215, ry: 0.215, y: 0 },
      { z: -1.00, rx: 0.258, ry: 0.258, y: 0 },
      { z:  1.55, rx: 0.258, ry: 0.258, y: 0 },
      { z:  2.10, rx: 0.196, ry: 0.196, y: 0 },
      { z:  2.38, rx: 0.070, ry: 0.070, y: 0 },
      { z:  2.50, rx: 0.016, ry: 0.016, y: 0 },
    ];
    tank.add(new THREE.Mesh(loftRings(tankRings, 16, { capStart: true, capEnd: true }), wingMatR));
    // Cruciform tail fins.
    const finH = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.022, 0.34), wingMatR);
    finH.position.set(0, 0, 2.02);
    tank.add(finH);
    const finV = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.30, 0.34), wingMatR);
    finV.position.set(0, 0, 2.02);
    tank.add(finV);
    tank.position.set(side * 2.28, -0.700, 0.95);
    group.add(tank);
  }

  // -------------------------------------------------------------------------
  // 12. Narrow-track landing gear (wheel bottoms y = -1.56, track 2.36 m)
  // -------------------------------------------------------------------------
  const gearGroup = new THREE.Group();
  gearGroup.name = 'gear';
  group.add(gearGroup);

  const wheels = [];

  // Forward-raked nose gear tucked under the MCID intake.
  const noseGearPivot = new THREE.Group();
  noseGearPivot.position.set(0, -0.62, -3.10);
  {
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.068, 0.72, 10), metalMat);
    strut.position.y = -0.36;
    noseGearPivot.add(strut);
    const fork = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.08), metalMat);
    fork.position.set(0, -0.68, 0.02);
    noseGearPivot.add(fork);
    const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.62, 8), darkTrimMat);
    brace.position.set(0, -0.32, 0.22);
    brace.rotation.x = 0.56;
    noseGearPivot.add(brace);
    const taxiLamp = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff3d4, toneMapped: false }),
    );
    taxiLamp.rotation.x = Math.PI / 2;
    taxiLamp.position.set(0, -0.45, -0.08);
    noseGearPivot.add(taxiLamp);
    // Nose wheel: radius 0.23, bottom at -0.62 - 0.71 - 0.23 = -1.56.
    // The spin axis lives on a parent group so the tyre never tumbles.
    const wheelSpin = new THREE.Group();
    wheelSpin.position.set(0, -0.71, 0);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.16, 16), tireMat);
    wheel.rotation.z = Math.PI / 2;
    wheelSpin.add(wheel);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.175, 12), metalMat);
    rim.rotation.z = Math.PI / 2;
    wheelSpin.add(rim);
    noseGearPivot.add(wheelSpin);
    wheels.push(wheelSpin);
  }
  gearGroup.add(noseGearPivot);

  const noseDoorPivot = new THREE.Group();
  noseDoorPivot.position.set(0.24, -0.92, -3.10);
  const noseDoor = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.40, 0.94), bodyMat);
  noseDoor.position.set(0, -0.20, 0);
  noseDoorPivot.add(noseDoor);
  gearGroup.add(noseDoorPivot);

  // Main gear: aft-raked struts folding into belly bays, narrow 2.36 m track.
  const mainGearPivots = [];
  const mainDoorPivots = [];
  for (const side of [-1, 1]) {
    const mgPivot = new THREE.Group();
    mgPivot.position.set(side * 0.70, -0.36, 1.15);

    const upperStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.078, 0.98, 10), metalMat);
    upperStrut.position.set(side * 0.20, -0.40, 0);
    upperStrut.rotation.z = side * 0.45;
    mgPivot.add(upperStrut);

    const lowerStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.062, 0.40, 10), metalMat);
    lowerStrut.position.set(side * 0.42, -0.80, 0);
    mgPivot.add(lowerStrut);

    const dragBrace = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.88, 8), darkTrimMat);
    dragBrace.position.set(side * 0.22, -0.44, -0.26);
    dragBrace.rotation.x = -0.48;
    dragBrace.rotation.z = side * 0.40;
    mgPivot.add(dragBrace);

    // Main wheel: centre (±1.18, -1.25, 1.15), radius 0.31 -> bottom -1.56.
    const wheelSpin = new THREE.Group();
    wheelSpin.position.set(side * 0.48, -0.89, 0);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.21, 18), tireMat);
    wheel.rotation.z = Math.PI / 2;
    wheelSpin.add(wheel);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.225, 12), metalMat);
    rim.rotation.z = Math.PI / 2;
    wheelSpin.add(rim);
    mgPivot.add(wheelSpin);
    wheels.push(wheelSpin);

    gearGroup.add(mgPivot);
    mainGearPivots.push({ side, pivot: mgPivot });

    const doorPivot = new THREE.Group();
    doorPivot.position.set(side * 0.74, -0.30, 1.15);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.52, 1.18), bodyMat);
    door.position.set(0, -0.26, 0);
    doorPivot.add(door);
    gearGroup.add(doorPivot);
    mainDoorPivots.push({ side, pivot: doorPivot });
  }

  group.userData = {
    gearGroup,
    noseGearPivot,
    noseDoorPivot,
    mainGearPivots,
    mainDoorPivots,
    wheels,
    burnerGroup,
    burnerGlow,
    burnerCore,
    shockDiamonds,
    flameHolder,
    canopy,
    glassMat,
    pilotGroup,
    navLights,
    stabPivotL,
    stabPivotR,
    flaperons,
    leFlaps,
    rudderPivot,
    speedbrakes,
    nozzlePetals,
    _time: 0,
    _sb: 0,
    _lef: 0,
  };

  // Real-time shadows: the opaque airframe casts onto terrain and itself, while
  // glass, additive afterburner glow and the nav-light sprites are skipped (a
  // transparent shadow would blacken the terrain under the canopy).
  group.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => !m || m.transparent || m.blending === THREE.AdditiveBlending)) return;
    o.castShadow = true;
    o.receiveShadow = true;
  });

  return group;
}

/** Animate the exterior details from flight telemetry and camera mode. */
export function updateF16Visual(model, flight, dt, mode = 'chase', started = true) {
  const ud = model.userData;
  ud._time = (ud._time || 0) + dt;

  // Toggle cockpit vs external appearance (canopy tint & pilot visibility)
  const inCockpit = started && mode === 'cockpit';
  if (ud.pilotGroup) ud.pilotGroup.visible = !inCockpit;
  if (ud.glassMat) {
    const targetOpacity = inCockpit ? 0.08 : 0.54;
    if (Math.abs(ud.glassMat.opacity - targetOpacity) > 0.005) {
      ud.glassMat.opacity = targetOpacity;
      ud.glassMat.color.setHex(inCockpit ? 0x9ab8b4 : 0xc6a055);
      ud.glassMat.roughness = inCockpit ? 0.14 : 0.07;
      ud.glassMat.needsUpdate = true;
    }
  }

  // Landing gear: fold cleanly into belly bays (never poke through wings!)
  const gp = flight.gearPos ?? 1;
  const retract = 1 - gp;
  ud.gearGroup.visible = gp > 0.02;
  if (ud.gearGroup.visible) {
    // Nose gear folds aft into the fuselage bay.
    ud.noseGearPivot.rotation.x = retract * 1.48;
    ud.noseGearPivot.scale.setScalar(0.35 + 0.65 * gp);
    ud.noseDoorPivot.rotation.z = -retract * 1.45;
    // Main gear folds inward/upward beneath the belly.
    for (const mg of ud.mainGearPivots) {
      mg.pivot.rotation.z = -mg.side * retract * 1.35;
      mg.pivot.rotation.x = retract * 0.45;
      mg.pivot.scale.setScalar(0.3 + 0.7 * gp);
    }
    for (const md of ud.mainDoorPivots) {
      md.pivot.rotation.z = -md.side * retract * 1.48;
    }
    // NOTE: the procedural tyres are smooth (treadless) cylinders, so a spin
    // about their axle produces no visible motion; skipping it also keeps every
    // conservative geometry AABB tight for culling and the 3-view dimension
    // measurement.
  }

  // Afterburner, nozzle iris and plume glow.
  const ab = flight.afterburner ? 1 : 0;
  const glow = clamp(((flight.throttle ?? 0) - 0.50) / 0.50, 0, 1);
  const flicker = 0.92 + 0.08 * Math.sin(ud._time * 65);
  ud.flameHolder.material.opacity = 0.08 + glow * 0.55 + ab * 0.35;
  ud.burnerGlow.material.opacity = (glow * 0.38 + ab * 0.52) * flicker;
  ud.burnerGlow.scale.set(0.85 + ab * 0.22, 0.85 + ab * 0.22, 0.55 + glow * 0.45 + ab * 0.55 * flicker);
  ud.burnerCore.material.opacity = ab * 0.82 * flicker;
  ud.burnerCore.scale.set(0.85 + ab * 0.2, 0.85 + ab * 0.2, 0.65 + ab * 0.5 * flicker);
  for (let i = 0; i < ud.shockDiamonds.length; i++) {
    const d = ud.shockDiamonds[i];
    d.material.opacity = ab * (0.72 - i * 0.18) * flicker;
    d.position.z = 0.42 + i * (0.58 + 0.06 * flicker);
  }
  // Collapse the additive plume while the burner is off so it never inflates
  // the airframe's measured length (and never renders needlessly).
  ud.burnerGroup.scale.z = 0.001 + ab * 0.999;

  // GE F110-GE-129 iris: constricted in dry cruise, flared wide in afterburner.
  const nozzleScale = 0.90 + glow * 0.04 + ab * 0.16;
  for (const petal of ud.nozzlePetals) petal.scale.set(nozzleScale, nozzleScale, 1);

  // Leading-edge flaps: flight.lefDeg when the sim provides it, else AoA-driven.
  const aoaDeg = Number.isFinite(flight.aoa) ? flight.aoa * (180 / Math.PI) : 0;
  const lefTargetDeg = Number.isFinite(flight.lefDeg)
    ? clamp(flight.lefDeg, 0, 25)
    : clamp(aoaDeg * 1.2, 0, 22);
  const lefRate = Math.min(1, dt * 6);
  ud._lef += (lefTargetDeg - ud._lef) * lefRate;
  const lefRad = (ud._lef * Math.PI) / 180;
  // Rotate each LEF about its own swept hinge line (root -> tip along the 40°
  // leading edge) so the panel droops without opening a hinge gap.
  const tiltAxis = new THREE.Vector3(1, 0, LEF_HINGE_SLOPE);
  for (const lef of ud.leFlaps) {
    tiltAxis.set(lef.side, 0, LEF_HINGE_SLOPE).normalize();
    lef.pivot.quaternion.setFromAxisAngle(tiltAxis, -lef.side * lefRad);
  }

  // Control surfaces: stabilators, flaperons, rudder, speedbrakes.
  const pitch = flight.controls?.pitch || 0;
  const roll = flight.controls?.roll || 0;
  const yaw = flight.controls?.yaw || 0;
  const flap = flight.flapPos || 0;

  ud.stabPivotL.rotation.x = -pitch * 0.32 + roll * 0.09;
  ud.stabPivotR.rotation.x = -pitch * 0.32 - roll * 0.09;
  for (const fl of ud.flaperons) {
    fl.pivot.rotation.x = flap * 0.28 + fl.side * roll * 0.22;
  }
  ud.rudderPivot.rotation.y = -yaw * 0.32;

  const sbTarget = flight.brake && !flight.onGround ? 1 : 0;
  ud._sb = (ud._sb || 0) + (sbTarget - (ud._sb || 0)) * Math.min(1, dt * 8);
  for (const sb of ud.speedbrakes) {
    sb.pivot.rotation.y = sb.side * ud._sb * 0.58;
    sb.pivot.rotation.x = sb.vert * ud._sb * 0.24;
  }
}