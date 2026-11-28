// Detailed procedural F-16C Block 50 exterior. Nose points -Z, up +Y, right +X.
// Lengths in metres: ~15.1m long, ~10.0m wingspan, ~4.9m tall (gear down).
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

  // Two-tone USAF Compass Ghost Grey base (uv.x wraps around fuselage circumference:
  // t=0 is right flank, t=0.25 is top spine, t=0.5 is left flank, t=0.75 is belly)
  const baseGrad = ctx.createLinearGradient(0, 0, W, 0);
  baseGrad.addColorStop(0.0, '#99a3ab');   // right flank (light ghost grey)
  baseGrad.addColorStop(0.14, '#768089');  // upper right transition
  baseGrad.addColorStop(0.25, '#6b757e');  // dorsal spine (dark ghost grey)
  baseGrad.addColorStop(0.36, '#768089');  // upper left transition
  baseGrad.addColorStop(0.50, '#99a3ab');  // left flank
  baseGrad.addColorStop(0.75, '#adb6be');  // belly (lightest ghost grey)
  baseGrad.addColorStop(1.0, '#99a3ab');   // wrap back to right flank
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, W, H);

  // Subtle weathered tonal panels
  for (let i = 0; i < 420; i++) {
    const shade = 110 + Math.floor(rng() * 55);
    const alpha = 0.03 + rng() * 0.045;
    ctx.fillStyle = `rgba(${shade},${shade + 4},${shade + 9},${alpha})`;
    const x = rng() * W;
    const y = rng() * H;
    const w = 18 + rng() * 90;
    const h = 10 + rng() * 34;
    ctx.fillRect(x, y, w, h);
  }

  // Longitudinal & circumferential panel seams
  ctx.strokeStyle = 'rgba(42,48,54,0.48)';
  ctx.lineWidth = 1.25;
  for (let y = 24; y < H; y += 38) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let x = 0; x < W; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  // Subtle highlight edge beside panel lines
  ctx.strokeStyle = 'rgba(220,230,238,0.16)';
  ctx.lineWidth = 0.8;
  for (let y = 25.5; y < H; y += 38) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Access hatches & inspection panels
  ctx.strokeStyle = 'rgba(38,44,50,0.52)';
  ctx.lineWidth = 1.1;
  for (let i = 0; i < 36; i++) {
    const x = rng() * (W - 60);
    const y = 30 + rng() * (H - 60);
    const w = 18 + rng() * 44;
    const h = 12 + rng() * 24;
    ctx.fillStyle = `rgba(92,102,110,${0.08 + rng() * 0.1})`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }

  // Rivet rows
  ctx.fillStyle = 'rgba(40,46,52,0.34)';
  for (let y = 28; y < H; y += 38) {
    for (let x = 8; x < W; x += 14) {
      ctx.fillRect(x, y, 1.4, 1.4);
    }
  }

  // Subtle tactical low-vis walkway & refueling markings near dorsal spine (x ≈ W*0.25)
  ctx.strokeStyle = 'rgba(56,62,68,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(W * 0.23, H * 0.52, W * 0.04, H * 0.12);
  // Subtle red/amber rescue/intake warning chevrons on forward flanks
  ctx.fillStyle = 'rgba(186,58,48,0.68)';
  for (const fx of [W * 0.04, W * 0.46]) {
    ctx.beginPath();
    ctx.moveTo(fx, H * 0.28);
    ctx.lineTo(fx + 14, H * 0.25);
    ctx.lineTo(fx + 14, H * 0.31);
    ctx.closePath();
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createWingTexture() {
  const W = 512;
  const H = 512;
  const c = createCanvas(W, H);
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const rng = mulberry32(160088);

  ctx.fillStyle = '#929ca4';
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < 180; i++) {
    const v = 132 + Math.floor(rng() * 32);
    ctx.fillStyle = `rgba(${v},${v + 4},${v + 8},0.06)`;
    ctx.fillRect(rng() * W, rng() * H, 24 + rng() * 80, 14 + rng() * 50);
  }

  ctx.strokeStyle = 'rgba(46,52,58,0.42)';
  ctx.lineWidth = 1.2;
  for (let y = 32; y < H; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let x = 40; x < W; x += 72) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  // Low-vis no-step stencil lines
  ctx.strokeStyle = 'rgba(60,66,72,0.35)';
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(48, 96, W - 96, H - 192);
  ctx.setLineDash([]);

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
 * Ring options: { z, rx, ry, y, flatBottom?, chine?, topFlat? }
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

    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const t = u * Math.PI * 2;
      const ct = Math.cos(t);
      const st = Math.sin(t);

      // Subtle blended wing-body chine flare near horizontal midline (st ≈ 0)
      const chineBoost = chine > 0 ? chine * Math.pow(Math.max(0, 1 - Math.abs(st) * 2.1), 2) : 0;
      const x = ct * (ring.rx + chineBoost);
      const ryScale = st < 0 ? flatB : topFlat;
      const y = ring.y + st * ring.ry * ryScale;

      pos.push(x, y, ring.z);
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
 * Build a solid tapered airfoil-section surface (wing, stabilator, LERX, or fin).
 * Root and tip are defined by 3D leading-edge and trailing-edge points plus thickness.
 * `normalAxis` is 'y' for horizontal surfaces (wings/stabs) or 'x' for vertical fins.
 */
function createAirfoilSurface({
  rootLE, rootTE, tipLE, tipTE,
  rootThick, tipThick,
  normalAxis = 'y',
  camber = 0.08,
}) {
  // 8-point airfoil loop around chord (0 = LE, upper surface -> TE -> lower surface -> LE)
  // Ordered CCW when viewed from tip looking toward root, or flipped automatically below.
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

  // Determine signed volume / orientation so triangles ALWAYS face outward
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
  // cross(chord, up) dot span tells us which side is outward
  const cx = chord[1] * up[2] - chord[2] * up[1];
  const cy = chord[2] * up[0] - chord[0] * up[2];
  const cz = chord[0] * up[1] - chord[1] * up[0];
  const flip = (cx * span[0] + cy * span[1] + cz * span[2]) < 0;

  const pos = [];
  const uv = [];
  const idx = [];

  // Push root ring (0..n-1) and tip ring (n..2n-1)
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

  // Cap root and tip cleanly
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

  // Reclined torso (F-16 ACES II seat has 30° recline, seated cleanly inside canopy)
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.40, 0.22), suitMat);
  torso.position.set(0, 0.58, -1.62);
  torso.rotation.x = 0.34;
  pilot.add(torso);

  // Shoulders / harness vest
  const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.22, 6, 10), vestMat);
  shoulders.rotation.z = Math.PI / 2;
  shoulders.position.set(0, 0.74, -1.56);
  pilot.add(shoulders);

  // HGU-55/P Flight Helmet
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), helmetMat);
  helmet.scale.set(0.95, 1.04, 1.08);
  helmet.position.set(0, 0.98, -1.53);
  pilot.add(helmet);

  // Tinted visor
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.143, 14, 10, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.26, Math.PI * 0.34),
    visorMat,
  );
  visor.rotation.y = Math.PI; // face -Z
  visor.position.set(0, 0.98, -1.535);
  pilot.add(visor);

  // Oxygen mask
  const mask = new THREE.Mesh(new THREE.ConeGeometry(0.052, 0.10, 8), maskMat);
  mask.rotation.x = -Math.PI * 0.42;
  mask.position.set(0, 0.90, -1.66);
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
  const wingTex = createWingTexture();

  const bodyMat = new THREE.MeshStandardMaterial({
    map: bodyTex, color: 0xe6ecf0, roughness: 0.54, metalness: 0.22,
  });
  const upperGreyMat = new THREE.MeshStandardMaterial({
    map: wingTex, color: 0xb6c0c8, roughness: 0.54, metalness: 0.22,
  });
  const wingMat = new THREE.MeshStandardMaterial({
    map: wingTex, color: 0xd8e0e6, roughness: 0.54, metalness: 0.22,
  });
  const darkTrimMat = new THREE.MeshStandardMaterial({
    color: 0x3b4147, roughness: 0.52, metalness: 0.42,
  });
  const radomeMat = new THREE.MeshStandardMaterial({
    color: 0x4b5258, roughness: 0.72, metalness: 0.10,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x9aa2a8, roughness: 0.32, metalness: 0.82,
  });
  const titaniumMat = new THREE.MeshStandardMaterial({
    color: 0x44494e, roughness: 0.36, metalness: 0.78,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x1b1d1f, roughness: 0.92, metalness: 0.05,
  });
  const intakeInnerMat = new THREE.MeshBasicMaterial({ color: 0x090b0d });

  // Gold-tinted polycarbonate canopy (adjusted dynamically for cockpit vs external)
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

  // --- 1. Radome (nose cone, z = -7.65 to -5.35) --------------------------
  const radomeRings = [
    { z: -7.65, rx: 0.012, ry: 0.012, y: 0.04 },
    { z: -7.35, rx: 0.11,  ry: 0.095, y: 0.045 },
    { z: -6.95, rx: 0.22,  ry: 0.185, y: 0.055 },
    { z: -6.45, rx: 0.34,  ry: 0.285, y: 0.075 },
    { z: -5.90, rx: 0.45,  ry: 0.38,  y: 0.10 },
    { z: -5.35, rx: 0.55,  ry: 0.47,  y: 0.12 },
  ];
  const radome = new THREE.Mesh(loftRings(radomeRings, 28, { capStart: true }), radomeMat);
  group.add(radome);

  // Pitot tube & AoA probes
  const pitot = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.72, 8), metalMat);
  pitot.rotation.x = Math.PI / 2;
  pitot.position.set(0, 0.04, -7.96);
  group.add(pitot);
  for (const side of [-1, 1]) {
    const probe = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.22, 6), metalMat);
    probe.rotation.z = Math.PI / 2;
    probe.position.set(side * 0.49, 0.08, -5.65);
    group.add(probe);
  }

  // --- 2. Blended Wing-Body Fuselage (z = -5.35 to +6.55) -----------------
  const fuselageRings = [
    { z: -5.35, rx: 0.55, ry: 0.47, y: 0.12, flatBottom: 0.88, chine: 0.02 },
    { z: -4.75, rx: 0.64, ry: 0.54, y: 0.15, flatBottom: 0.85, chine: 0.06 },
    { z: -4.15, rx: 0.72, ry: 0.60, y: 0.18, flatBottom: 0.82, chine: 0.12 },
    { z: -3.45, rx: 0.78, ry: 0.64, y: 0.20, flatBottom: 0.80, chine: 0.20 },
    { z: -2.65, rx: 0.82, ry: 0.66, y: 0.20, flatBottom: 0.78, chine: 0.26 },
    { z: -1.80, rx: 0.85, ry: 0.67, y: 0.19, flatBottom: 0.78, chine: 0.30 },
    { z: -0.95, rx: 0.88, ry: 0.66, y: 0.17, flatBottom: 0.78, chine: 0.32 },
    { z:  0.00, rx: 0.90, ry: 0.64, y: 0.15, flatBottom: 0.78, chine: 0.30 },
    { z:  1.10, rx: 0.89, ry: 0.62, y: 0.14, flatBottom: 0.80, chine: 0.26 },
    { z:  2.20, rx: 0.86, ry: 0.60, y: 0.14, flatBottom: 0.82, chine: 0.22 },
    { z:  3.30, rx: 0.81, ry: 0.57, y: 0.14, flatBottom: 0.84, chine: 0.18 },
    { z:  4.35, rx: 0.74, ry: 0.54, y: 0.14, flatBottom: 0.86, chine: 0.14 },
    { z:  5.30, rx: 0.66, ry: 0.50, y: 0.14, flatBottom: 0.90, chine: 0.08 },
    { z:  6.05, rx: 0.58, ry: 0.47, y: 0.14, flatBottom: 0.94, chine: 0.02 },
    { z:  6.55, rx: 0.52, ry: 0.46, y: 0.14, flatBottom: 0.98, chine: 0.00 },
  ];
  const fuselageGeo = loftRings(fuselageRings, 32, { capEnd: true });
  // Open only the top cockpit cutout cleanly so the cockpit interior is visible
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
  group.add(fuselage);

  // --- 3. Sculpted Dorsal Spine / Avionics Fairing ------------------------
  const spineRings = [
    { z: -0.96, rx: 0.56, ry: 0.34, y: 0.72 },
    { z: -0.30, rx: 0.52, ry: 0.30, y: 0.70 },
    { z:  0.80, rx: 0.46, ry: 0.26, y: 0.66 },
    { z:  2.20, rx: 0.40, ry: 0.22, y: 0.62 },
    { z:  3.80, rx: 0.34, ry: 0.18, y: 0.58 },
    { z:  5.40, rx: 0.26, ry: 0.14, y: 0.54 },
    { z:  6.35, rx: 0.18, ry: 0.08, y: 0.50 },
  ];
  const spine = new THREE.Mesh(loftArch(spineRings, 14, 0, Math.PI), upperGreyMat);
  group.add(spine);

  // Aft cockpit deck bulkhead closing spine front
  const spineCap = new THREE.Mesh(new THREE.CircleGeometry(0.56, 16, 0, Math.PI), darkTrimMat);
  spineCap.scale.set(1, 0.62, 1);
  spineCap.rotation.y = Math.PI; // face forward (-Z)
  spineCap.position.set(0, 0.72, -0.96);
  group.add(spineCap);

  // Dorsal UHF blade antenna
  const uhfBlade = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.24, 0.32), darkTrimMat);
  uhfBlade.position.set(0, 1.02, 0.35);
  uhfBlade.rotation.x = -0.35;
  group.add(uhfBlade);

  // --- 4. Iconic Smiling Chin Intake (z = -3.72 to +0.8) ------------------
  const intakeRings = [
    { z: -3.72, rx: 0.54, ry: 0.34, y: -0.58, flatBottom: 0.92, topFlat: 0.68 },
    { z: -3.35, rx: 0.58, ry: 0.38, y: -0.57, flatBottom: 0.92, topFlat: 0.72 },
    { z: -2.40, rx: 0.62, ry: 0.41, y: -0.54, flatBottom: 0.92, topFlat: 0.75 },
    { z: -1.10, rx: 0.60, ry: 0.39, y: -0.49, flatBottom: 0.92, topFlat: 0.78 },
    { z:  0.20, rx: 0.54, ry: 0.32, y: -0.40, flatBottom: 0.90, topFlat: 0.80 },
    { z:  1.15, rx: 0.42, ry: 0.22, y: -0.28, flatBottom: 0.90, topFlat: 0.80 },
  ];
  const intakeBody = new THREE.Mesh(loftRings(intakeRings, 24), bodyMat);
  group.add(intakeBody);

  // Intake metallic lip ring
  const intakeLip = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.036, 8, 26), darkTrimMat);
  intakeLip.position.set(0, -0.58, -3.71);
  intakeLip.scale.set(1.20, 0.74, 1);
  group.add(intakeLip);

  // Deep dark intake throat facing -Z (rotated Math.PI so FrontSide faces forward!)
  const intakeThroat = new THREE.Mesh(new THREE.CircleGeometry(0.44, 24), intakeInnerMat);
  intakeThroat.rotation.y = Math.PI;
  intakeThroat.position.set(0, -0.58, -3.70);
  intakeThroat.scale.set(1.18, 0.72, 1);
  group.add(intakeThroat);

  // Subtle metallic compressor spinner inside intake
  const intakeCone = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.24, 12), metalMat);
  intakeCone.rotation.x = -Math.PI / 2;
  intakeCone.position.set(0, -0.58, -3.52);
  group.add(intakeCone);

  // Boundary-layer splitter wedge between fuselage belly and intake top
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.72), darkTrimMat);
  splitter.position.set(0, -0.32, -3.42);
  group.add(splitter);

  // --- 5. Blended LERX (Strakes) + Tapered Airfoil Cropped-Delta Wings ----
  const flaperons = [];
  for (const side of [-1, 1]) {
    // Swept Leading-Edge Root Extension (LERX / cobra hood strake)
    const lerxGeo = createAirfoilSurface({
      rootLE: [side * 0.56, 0.15, -4.55],
      rootTE: [side * 0.86, 0.13, -0.75],
      tipLE:  [side * 1.18, 0.11, -1.65],
      tipTE:  [side * 1.24, 0.11, -0.75],
      rootThick: 0.12,
      tipThick: 0.07,
      normalAxis: 'y',
      camber: 0.05,
    });
    group.add(new THREE.Mesh(lerxGeo, upperGreyMat));

    // Main cropped-delta wing (40° LE sweep, tapered airfoil)
    const wingGeo = createAirfoilSurface({
      rootLE: [side * 0.82, 0.10, -1.10],
      rootTE: [side * 0.88, 0.08,  3.15],
      tipLE:  [side * 4.94, 0.04,  1.88],
      tipTE:  [side * 4.94, 0.04,  3.06],
      rootThick: 0.22,
      tipThick: 0.065,
      normalAxis: 'y',
      camber: 0.09,
    });
    group.add(new THREE.Mesh(wingGeo, wingMat));

    // Leading-edge maneuver flap accent strip
    const leFlapGeo = createAirfoilSurface({
      rootLE: [side * 1.15, 0.10, -0.82],
      rootTE: [side * 1.25, 0.10, -0.38],
      tipLE:  [side * 4.88, 0.04,  1.86],
      tipTE:  [side * 4.88, 0.04,  2.14],
      rootThick: 0.10,
      tipThick: 0.055,
      normalAxis: 'y',
      camber: 0.04,
    });
    group.add(new THREE.Mesh(leFlapGeo, upperGreyMat));

    // Animated trailing-edge flaperon blended cleanly into wing trailing edge
    const flapPivot = new THREE.Group();
    flapPivot.position.set(side * 2.85, 0.06, 2.82);
    const flapMesh = new THREE.Mesh(new THREE.BoxGeometry(2.68, 0.052, 0.34), upperGreyMat);
    flapMesh.position.set(0, 0, 0.16);
    flapPivot.add(flapMesh);
    group.add(flapPivot);
    flaperons.push({ side, pivot: flapPivot });

    // Clean wingtip rail (no missiles/weapons) + nav light
    const tipRail = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 2.05), darkTrimMat);
    tipRail.position.set(side * 4.98, 0.04, 2.48);
    group.add(tipRail);
    const tipCap = new THREE.Mesh(new THREE.ConeGeometry(0.042, 0.22, 8), metalMat);
    tipCap.rotation.x = -Math.PI / 2;
    tipCap.position.set(side * 4.98, 0.04, 1.36);
    group.add(tipCap);

    // Wingtip navigation light & soft halo
    const lightColor = side < 0 ? 0xff2b2b : 0x2bff6a;
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.052, 8, 6),
      new THREE.MeshBasicMaterial({ color: lightColor, toneMapped: false }),
    );
    bulb.position.set(side * 5.03, 0.055, 2.22);
    group.add(bulb);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: lightColor, transparent: true, opacity: 0.72,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    halo.scale.set(0.75, 0.75, 1);
    halo.position.copy(bulb.position);
    group.add(halo);
  }

  // --- 6. Vertical Stabilizer (Tail Fin), Parabrake Pod & Rudder ----------
  const finGeo = createAirfoilSurface({
    rootLE: [0, 0.56, 2.45],
    rootTE: [0, 0.56, 6.20],
    tipLE:  [0, 3.30, 4.45],
    tipTE:  [0, 3.30, 5.68],
    rootThick: 0.18,
    tipThick: 0.06,
    normalAxis: 'x',
    camber: 0,
  });
  const tailFin = new THREE.Mesh(finGeo, upperGreyMat);
  group.add(tailFin);

  // Fin tip RWR / ECM cap
  const finCap = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 1.24), darkTrimMat);
  finCap.position.set(0, 3.34, 5.07);
  group.add(finCap);

  // Iconic F-16 parabrake / tail-base fairing housing
  const parabrake = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.45, 12), upperGreyMat);
  parabrake.rotation.x = Math.PI / 2;
  parabrake.scale.set(0.85, 1, 1.15);
  parabrake.position.set(0, 0.74, 6.25);
  group.add(parabrake);
  const tailBulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.042, 6, 5),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
  );
  tailBulb.position.set(0, 0.74, 6.98);
  group.add(tailBulb);

  // Pivoting rudder flush along the fin's forward-swept trailing edge
  const rudderPivot = new THREE.Group();
  rudderPivot.position.set(0, 1.92, 5.88);
  rudderPivot.rotation.x = -0.19; // matches fin trailing-edge slope (dz/dy = -0.52 / 2.74)
  const rudderMesh = new THREE.Mesh(new THREE.BoxGeometry(0.085, 2.22, 0.36), upperGreyMat);
  rudderMesh.position.set(0, 0, 0.06);
  rudderPivot.add(rudderMesh);
  group.add(rudderPivot);

  // --- 7. All-Moving Horizontal Stabilators (properly hinged!) ------------
  const stabPivotL = new THREE.Group();
  const stabPivotR = new THREE.Group();
  stabPivotL.position.set(-0.56, 0.04, 5.80);
  stabPivotR.position.set( 0.56, 0.04, 5.80);

  for (const side of [-1, 1]) {
    const stabGeo = createAirfoilSurface({
      rootLE: [0, 0, -0.78],
      rootTE: [0, 0,  0.92],
      tipLE:  [side * 2.52, -0.06,  0.30],
      tipTE:  [side * 2.52, -0.06,  0.96],
      rootThick: 0.12,
      tipThick: 0.045,
      normalAxis: 'y',
      camber: 0,
    });
    const stabMesh = new THREE.Mesh(stabGeo, wingMat);
    (side < 0 ? stabPivotL : stabPivotR).add(stabMesh);
  }
  group.add(stabPivotL, stabPivotR);

  // --- 8. Dual Canted Ventral Fins (iconic F-16 under-tail strakes) -------
  for (const side of [-1, 1]) {
    const vfPivot = new THREE.Group();
    vfPivot.position.set(side * 0.46, -0.32, 5.25);
    vfPivot.rotation.z = side * 0.28; // canted outward ~16°
    const vfGeo = createAirfoilSurface({
      rootLE: [0,  0.00, -0.95],
      rootTE: [0,  0.00,  0.75],
      tipLE:  [0, -0.52, -0.42],
      tipTE:  [0, -0.48,  0.65],
      rootThick: 0.055,
      tipThick: 0.025,
      normalAxis: 'x',
      camber: 0,
    });
    vfPivot.add(new THREE.Mesh(vfGeo, upperGreyMat));
    group.add(vfPivot);
  }

  // --- 9. Split Tail Speedbrakes (animated with flight.brake) -------------
  const speedbrakes = [];
  for (const side of [-1, 1]) {
    for (const vert of [-1, 1]) {
      const sbPivot = new THREE.Group();
      sbPivot.position.set(side * 0.56, 0.14 + vert * 0.08, 5.95);
      const petal = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.72), darkTrimMat);
      petal.position.set(side * 0.02, vert * 0.04, 0.34);
      sbPivot.add(petal);
      group.add(sbPivot);
      speedbrakes.push({ side, vert, pivot: sbPivot });
    }
  }

  // --- 10. F110-GE-129 Exhaust Nozzle & Afterburner Plume -----------------
  const nozzleGroup = new THREE.Group();
  nozzleGroup.position.set(0, 0.14, 6.55);
  group.add(nozzleGroup);

  // Metallic shroud collar
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.51, 0.53, 0.28, 24), metalMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.z = 0.12;
  nozzleGroup.add(collar);

  // Convergent-divergent nozzle cone
  const nozzleOuter = new THREE.Mesh(new THREE.CylinderGeometry(0.41, 0.50, 0.88, 24), titaniumMat);
  nozzleOuter.rotation.x = Math.PI / 2;
  nozzleOuter.position.z = 0.66;
  nozzleGroup.add(nozzleOuter);

  // 16 turkey-feather petals around the nozzle
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const petal = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.11, 0.72), i % 2 === 0 ? titaniumMat : metalMat);
    petal.position.set(Math.cos(a) * 0.455, Math.sin(a) * 0.455, 0.66);
    petal.rotation.z = a;
    nozzleGroup.add(petal);
  }

  // Dark inner exhaust recess & glowing flameholder ring
  const exhaustRecess = new THREE.Mesh(new THREE.CircleGeometry(0.39, 20), intakeInnerMat);
  exhaustRecess.position.z = 1.08;
  nozzleGroup.add(exhaustRecess);

  const flameHolder = new THREE.Mesh(
    new THREE.TorusGeometry(0.24, 0.032, 6, 18),
    new THREE.MeshBasicMaterial({ color: 0xff6a24, transparent: true, opacity: 0.08, toneMapped: false }),
  );
  flameHolder.position.z = 1.06;
  nozzleGroup.add(flameHolder);

  // Afterburner plume: outer orange sheath + inner blue-white core + shock diamonds
  const burnerGroup = new THREE.Group();
  burnerGroup.position.set(0, 0.14, 7.62);
  group.add(burnerGroup);

  const burnerGlow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.38, 2.6, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xff7b29, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }),
  );
  burnerGlow.rotation.x = Math.PI / 2;
  burnerGlow.position.z = 1.3;
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

  // --- 11. Frameless Teardrop Bubble Canopy + Sill Framing ----------------
  // Lofted teardrop dome smoothly clearing the HUD combiner (y=1.35 at z=-3.48)
  // and flowing into the dorsal spine at z=-0.95.
  const canopyRings = [
    { z: -4.18, rx: 0.28, ry: 0.03, y: 0.67 },
    { z: -3.90, rx: 0.48, ry: 0.28, y: 0.70 },
    { z: -3.55, rx: 0.58, ry: 0.54, y: 0.73 },
    { z: -3.10, rx: 0.61, ry: 0.68, y: 0.75 },
    { z: -2.50, rx: 0.62, ry: 0.71, y: 0.75 },
    { z: -1.90, rx: 0.60, ry: 0.64, y: 0.74 },
    { z: -1.38, rx: 0.58, ry: 0.50, y: 0.72 },
    { z: -0.96, rx: 0.56, ry: 0.35, y: 0.70 },
  ];
  const canopy = new THREE.Mesh(loftArch(canopyRings, 26, 0, Math.PI), glassMat);
  canopy.renderOrder = 4;
  group.add(canopy);

  // Clean canopy sill rails & single rear canopy hoop (authentic frameless windscreen)
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.055, 3.05), frameMat);
    rail.position.set(side * 0.59, 0.74, -2.48);
    group.add(rail);
  }
  const aftArch = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.028, 8, 22, Math.PI), frameMat);
  aftArch.scale.set(1, 0.66, 1);
  aftArch.position.set(0, 0.71, -0.98);
  group.add(aftArch);

  // External pilot figure (hidden in cockpit view)
  const pilotGroup = createExternalPilot();
  group.add(pilotGroup);

  // --- 12. Sleek 370-Gal Underwing External Fuel Tanks (no weapons) -------
  for (const side of [-1, 1]) {
    const pylon = new THREE.Mesh(
      createAirfoilSurface({
        rootLE: [0,  0.08, -0.95],
        rootTE: [0,  0.08,  0.85],
        tipLE:  [0, -0.44, -0.78],
        tipTE:  [0, -0.44,  0.76],
        rootThick: 0.11,
        tipThick: 0.08,
        normalAxis: 'x',
        camber: 0,
      }),
      upperGreyMat,
    );
    pylon.position.set(side * 2.42, 0.0, 1.35);
    group.add(pylon);

    const tank = new THREE.Group();
    const tankRings = [
      { z: -2.25, rx: 0.015, ry: 0.015, y: 0 },
      { z: -1.85, rx: 0.15,  ry: 0.15,  y: 0 },
      { z: -1.25, rx: 0.26,  ry: 0.26,  y: 0 },
      { z:  0.85, rx: 0.26,  ry: 0.26,  y: 0 },
      { z:  1.65, rx: 0.16,  ry: 0.16,  y: 0 },
      { z:  2.05, rx: 0.02,  ry: 0.02,  y: 0 },
    ];
    tank.add(new THREE.Mesh(loftRings(tankRings, 16, { capStart: true, capEnd: true }), wingMat));
    // Horizontal stabilizer fins on tank tail
    const tankFin = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.025, 0.36), upperGreyMat);
    tankFin.position.set(0, 0, 1.55);
    tank.add(tankFin);
    tank.position.set(side * 2.42, -0.64, 1.25);
    group.add(tank);
  }

  // --- 13. Retractable Landing Gear (folds cleanly into belly bays!) ------
  // Wheel bottoms at y = -1.56 when gearPos = 1 (matches CONFIG.aircraft.gearHeight = 1.58).
  const gearGroup = new THREE.Group();
  gearGroup.name = 'gear';
  group.add(gearGroup);

  const wheels = [];

  // Nose gear assembly
  const noseGearPivot = new THREE.Group();
  noseGearPivot.position.set(0, -0.62, -3.15);
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
    // Taxi light on nose strut
    const taxiLamp = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff3d4, toneMapped: false }),
    );
    taxiLamp.rotation.x = Math.PI / 2;
    taxiLamp.position.set(0, -0.45, -0.08);
    noseGearPivot.add(taxiLamp);
    // Nose wheel (radius 0.23 -> bottom at -0.62 - 0.71 - 0.23 = -1.56)
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.16, 16), tireMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(0, -0.71, 0);
    noseGearPivot.add(wheel);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.175, 12), metalMat);
    rim.rotation.z = Math.PI / 2;
    rim.position.copy(wheel.position);
    noseGearPivot.add(rim);
    wheels.push(wheel);
  }
  gearGroup.add(noseGearPivot);

  const noseDoorPivot = new THREE.Group();
  noseDoorPivot.position.set(0.24, -0.78, -3.15);
  const noseDoor = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.42, 0.92), bodyMat);
  noseDoor.position.set(0, -0.21, 0);
  noseDoorPivot.add(noseDoor);
  gearGroup.add(noseDoorPivot);

  // Main gear assemblies (splayed slightly outward like the real F-16)
  const mainGearPivots = [];
  const mainDoorPivots = [];
  for (const side of [-1, 1]) {
    const mgPivot = new THREE.Group();
    mgPivot.position.set(side * 0.68, -0.34, 1.15);

    const upperStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.98, 10), metalMat);
    upperStrut.position.set(side * 0.26, -0.44, 0);
    upperStrut.rotation.z = side * 0.52;
    mgPivot.add(upperStrut);

    const lowerStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.062, 0.36, 10), metalMat);
    lowerStrut.position.set(side * 0.52, -0.84, 0);
    mgPivot.add(lowerStrut);

    const dragBrace = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.85, 8), darkTrimMat);
    dragBrace.position.set(side * 0.25, -0.45, -0.25);
    dragBrace.rotation.x = -0.48;
    dragBrace.rotation.z = side * 0.45;
    mgPivot.add(dragBrace);

    // Main wheel (radius 0.31 -> bottom at -0.34 - 0.91 - 0.31 = -1.56)
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.21, 18), tireMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * 0.62, -0.91, 0);
    mgPivot.add(wheel);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.225, 12), metalMat);
    rim.rotation.z = Math.PI / 2;
    rim.position.copy(wheel.position);
    mgPivot.add(rim);
    wheels.push(wheel);

    gearGroup.add(mgPivot);
    mainGearPivots.push({ side, pivot: mgPivot });

    const doorPivot = new THREE.Group();
    doorPivot.position.set(side * 0.72, -0.40, 1.15);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.56, 1.15), bodyMat);
    door.position.set(0, -0.28, 0);
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
    navLights: { bulbs: [], halos: [] },
    stabPivotL,
    stabPivotR,
    flaperons,
    rudderPivot,
    speedbrakes,
    _time: 0,
  };
  group.traverse((o) => {
    if (o.isSprite) group.userData.navLights.halos.push(o);
  });

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
  const gp = flight.gearPos;
  const retract = 1 - gp;
  ud.gearGroup.visible = gp > 0.02;
  if (ud.gearGroup.visible) {
    // Nose gear folds aft into fuselage bay
    ud.noseGearPivot.rotation.x = retract * 1.48;
    ud.noseGearPivot.scale.setScalar(0.35 + 0.65 * gp);
    ud.noseDoorPivot.rotation.z = -retract * 1.45;
    // Main gear folds inward/upward beneath belly
    for (const mg of ud.mainGearPivots) {
      mg.pivot.rotation.z = -mg.side * retract * 1.35;
      mg.pivot.rotation.x = retract * 0.45;
      mg.pivot.scale.setScalar(0.3 + 0.7 * gp);
    }
    for (const md of ud.mainDoorPivots) {
      md.pivot.rotation.z = -md.side * retract * 1.48;
    }
    if (flight.onGround) {
      for (const w of ud.wheels) w.rotation.x += flight.speed * 0.045 * dt * 60;
    }
  }

  // Afterburner & nozzle glow
  const ab = flight.afterburner ? 1 : 0;
  const glow = Math.max(0, (flight.throttle - 0.50) / 0.50);
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

  // Control surfaces: all-moving stabilators, flaperons, rudder, speedbrakes
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
