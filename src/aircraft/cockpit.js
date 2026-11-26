// F-16C cockpit interior: panel, MFDs, HUD combiner, consoles, seat, controls.
import * as THREE from 'three';

const C = {
  panel: 0x454b45,
  panelDark: 0x303532,
  panelLight: 0x555c54,
  seat: 0x5f6a4f,
  harness: 0x8a8568,
  metal: 0x9aa1a5,
  hudGreen: '#7dff9f',
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

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { canvas: c, ctx, tex: t };
}

function panelMaterial(color = C.panel) {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.72, metalness: 0.16,
    emissive: 0x18201a, emissiveIntensity: 1.0,
  });
}

function rbox(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
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

function drawICP(ctx, W, H) {
  ctx.fillStyle = '#191c1a';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#3a413c';
  ctx.strokeRect(1, 1, W - 2, H - 2);
  ctx.fillStyle = '#0a0d0b';
  ctx.fillRect(8, 8, W - 16, 26);
  ctx.fillStyle = '#8dffb4';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('UFC  >', 13, 26);
  ctx.font = '9px monospace';
  ctx.fillStyle = '#9fb3a6';
  const rows = ['A', 'B', 'C', 'D', 'E'];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const x = 10 + c * ((W - 20) / 5);
      const y = 44 + r * 18;
      ctx.fillStyle = '#262b27';
      ctx.fillRect(x, y, (W - 30) / 5, 14);
      ctx.fillStyle = '#94a89b';
      ctx.fillText(rows[r] + (c + 1), x + 6, y + 11);
    }
  }
}

function drawConsoles(ctx, W, H) {
  ctx.fillStyle = '#232724';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = i % 7 === 0 ? '#3b463c' : '#1b1e1c';
    ctx.fillRect((i * 37) % W, (i * 53) % H, 6, 3);
  }
  ctx.fillStyle = '#d9b45b';
  for (let i = 0; i < 8; i++) ctx.fillRect(8 + i * 22, 20, 10, 4);
  ctx.fillStyle = '#c94b3a';
  for (let i = 0; i < 5; i++) ctx.fillRect(8 + i * 28, 34, 8, 4);
  ctx.strokeStyle = '#3f463f';
  for (let r = 0; r < 6; r++) {
    ctx.beginPath();
    ctx.moveTo(6, 50 + r * 14);
    ctx.lineTo(W - 6, 50 + r * 14);
    ctx.stroke();
  }
}

function drawGauge(ctx, W, H, label, value, max, unit) {
  ctx.fillStyle = '#0b0f0c';
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, W * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#333c35';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = '#8dffb4';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * 0.75 + (i / 10) * Math.PI * 1.5;
    const r0 = W * 0.36;
    const r1 = W * 0.44;
    ctx.beginPath();
    ctx.moveTo(W / 2 + Math.cos(a) * r0, H / 2 + Math.sin(a) * r0);
    ctx.lineTo(W / 2 + Math.cos(a) * r1, H / 2 + Math.sin(a) * r1);
    ctx.stroke();
  }
  const frac = Math.min(1, Math.max(0, value / max));
  const a = Math.PI * 0.75 + frac * Math.PI * 1.5;
  ctx.strokeStyle = '#e8fff0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2, H / 2);
  ctx.lineTo(W / 2 + Math.cos(a) * W * 0.32, H / 2 + Math.sin(a) * W * 0.32);
  ctx.stroke();
  ctx.fillStyle = '#8dffb4';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, W / 2, H * 0.7);
  ctx.fillText(Math.round(value) + unit, W / 2, H * 0.84);
}

// ---------------------------------------------------------------------------
// Canopy rain streak texture (deterministic procedural streaks + droplets)
// ---------------------------------------------------------------------------
function drawRainStreaks(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
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

  const matPanel = panelMaterial(C.panel);
  const matDark = panelMaterial(C.panelDark);
  const matLight = panelMaterial(C.panelLight);
  const matSeat = panelMaterial(C.seat);
  const matHarness = new THREE.MeshStandardMaterial({ color: C.harness, roughness: 0.9 });
  const matMetal = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.35, metalness: 0.75 });
  const matScreenEdge = new THREE.MeshStandardMaterial({ color: 0x141715, roughness: 0.6 });

  // ---- tub / floor (tucked cleanly inside sculpted fuselage shell) --------
  group.add(rbox(0.98, 0.05, 2.55, matDark, 0, 0.24, -2.25));
  for (const side of [-1, 1]) {
    const wall = rbox(0.05, 0.50, 2.48, matPanel, side * 0.52, 0.51, -2.25);
    group.add(wall);
    // canopy sill
    const sill = rbox(0.06, 0.055, 2.38, matMetal, side * 0.555, 0.77, -2.26);
    group.add(sill);
  }
  // aft bulkhead
  group.add(rbox(1.02, 0.72, 0.07, matDark, 0, 0.58, -0.96));

  // ---- cockpit framing / coaming (closes the shell around the pilot) ------
  const coamingMat = new THREE.MeshStandardMaterial({
    color: 0x353a36, roughness: 0.6, metalness: 0.3,
    emissive: 0x10140f, emissiveIntensity: 0.7,
  });
  // front lower dash shelf under the windshield
  group.add(rbox(0.96, 0.08, 0.36, matDark, 0, 0.44, -3.56));
  group.add(rbox(0.98, 0.14, 0.08, coamingMat, 0, 0.52, -3.72));
  for (const side of [-1, 1]) {
    // angled side coamings from console to canopy sill
    const coaming = rbox(0.055, 0.24, 2.15, coamingMat, side * 0.535, 0.69, -2.45);
    coaming.rotation.z = side * -0.06;
    group.add(coaming);
    // kick panels closing the forward corners
    group.add(rbox(0.05, 0.42, 0.55, matDark, side * 0.51, 0.51, -3.45));
    // canopy rail inside
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 2.55, 6), coamingMat);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(side * 0.56, 0.80, -2.35);
    group.add(rail);
  }
  // rear canopy bow only; the windshield frame is the HUD combiner itself
  {
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.54, 0.02, 6, 22, Math.PI), coamingMat);
    bow.scale.set(1, 0.66, 1);
    bow.position.set(0, 0.76, -1.00);
    group.add(bow);
  }

  // ---- main instrument panel ---------------------------------------------
  const panel = new THREE.Group();
  panel.position.set(0, 0.73, -3.38);
  panel.rotation.x = -0.18;
  group.add(panel);

  panel.add(rbox(1.02, 0.56, 0.07, matPanel, 0, 0, 0));
  panel.add(rbox(0.98, 0.05, 0.09, matDark, 0, 0.28, 0.01));
  // glare shield
  const glare = rbox(1.12, 0.04, 0.34, matDark, 0, 0.305, 0.12);
  panel.add(glare);

  // master caution lamp on the right glare shield
  const cautionMat = new THREE.MeshStandardMaterial({
    color: 0x3a2606, roughness: 0.45, metalness: 0.12,
    emissive: 0xffb020, emissiveIntensity: 0.05,
  });
  const masterCaution = new THREE.Group();
  masterCaution.position.set(0.26, 0.33, 0.24);
  panel.add(masterCaution);
  masterCaution.add(rbox(0.078, 0.052, 0.02, matScreenEdge, 0, 0, 0));
  const cautionLamp = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.032, 0.014), cautionMat);
  cautionLamp.name = 'masterCaution';
  cautionLamp.position.set(0, 0, 0.013);
  masterCaution.add(cautionLamp);

  // HUD control panel
  const hudPanel = rbox(0.34, 0.12, 0.03, matLight, 0, 0.22, 0.05);
  panel.add(hudPanel);

  // MFDs
  const mfdGeo = new THREE.PlaneGeometry(0.245, 0.245);
  const mfdL = canvasTex(256, 256, (ctx, w, h) => drawADI(ctx, w, h, { roll: 0, pitch: 0, kts: 0, altFt: 0, g: 1, aoa: 0, vs: 0, gear: true, stall: false }));
  const mfdR = canvasTex(256, 256, (ctx, w, h) => drawHSI(ctx, w, h, { heading: 0 }));
  const mfdMatL = new THREE.MeshBasicMaterial({ map: mfdL.tex, toneMapped: false });
  const mfdMatR = new THREE.MeshBasicMaterial({ map: mfdR.tex, toneMapped: false });
  const screenL = new THREE.Mesh(mfdGeo, mfdMatL);
  screenL.position.set(-0.235, 0.01, 0.05);
  const screenR = new THREE.Mesh(mfdGeo, mfdMatR);
  screenR.position.set(0.235, 0.01, 0.05);
  panel.add(screenL, screenR);
  for (const x of [-0.235, 0.235]) {
    panel.add(rbox(0.29, 0.29, 0.03, matScreenEdge, x, 0.01, 0.018));
    // bezel buttons
    for (let i = 0; i < 5; i++) {
      panel.add(rbox(0.035, 0.02, 0.012, matLight, x - 0.12 + i * 0.06, 0.155, 0.045));
      panel.add(rbox(0.035, 0.02, 0.012, matLight, x - 0.12 + i * 0.06, -0.14, 0.045));
    }
  }

  // standby instruments
  const gaugeConfigs = [
    { x: -0.07, y: -0.18, label: 'SPD', value: 0, max: 600, unit: '' },
    { x: 0.07, y: -0.18, label: 'ALT', value: 0, max: 50000, unit: '' },
  ];
  const gauges = [];
  for (const g of gaugeConfigs) {
    const gt = canvasTex(128, 128, (ctx, w, h) => drawGauge(ctx, w, h, g.label, 0, g.max, g.unit));
    const gm = new THREE.MeshBasicMaterial({ map: gt.tex, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.048, 20), gm);
    mesh.position.set(g.x, g.y, 0.045);
    panel.add(mesh);
    gauges.push({ ...g, tex: gt });
  }

  // ICP keypad below the MFDs
  const icp = canvasTex(256, 128, drawICP);
  const icpMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.15),
    new THREE.MeshBasicMaterial({ map: icp.tex, toneMapped: false }),
  );
  icpMesh.position.set(0, -0.27, 0.05);
  icpMesh.rotation.x = -0.35;
  panel.add(icpMesh);
  // warning panel
  const warn = canvasTex(256, 64, (ctx, w, h) => {
    ctx.fillStyle = '#171a18';
    ctx.fillRect(0, 0, w, h);
    const cols = ['#d94a3a', '#d9b23a', '#3ad96a', '#d94a3a', '#3a7ad9', '#d9b23a'];
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = cols[i % cols.length];
      ctx.globalAlpha = 0.55;
      ctx.fillRect(6 + (i % 8) * 31, 8 + Math.floor(i / 8) * 16, 24, 9);
    }
    ctx.globalAlpha = 1;
  });
  const warnMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 0.085),
    new THREE.MeshBasicMaterial({ map: warn.tex, toneMapped: false }),
  );
  warnMesh.position.set(0, 0.19, 0.058);
  panel.add(warnMesh);

  // HUD combiner (positioned cleanly inside the bubble canopy above the glare shield)
  const hudFrameMat = new THREE.MeshStandardMaterial({ color: 0x2a2d2b, roughness: 0.4, metalness: 0.6 });
  const hud = new THREE.Group();
  hud.position.set(0, 1.13, -3.38);
  group.add(hud);
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.30, 0.25),
    new THREE.MeshBasicMaterial({
      color: 0x54ff86, transparent: true, opacity: 0.05,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
  );
  glass.position.set(0, 0, 0);
  glass.rotation.x = 0.08;
  hud.add(glass);
  const frameParts = [
    [0.33, 0.014, 0.014, 0, 0.14, 0.018],
    [0.33, 0.014, 0.014, 0, -0.14, 0.018],
    [0.014, 0.30, 0.014, -0.16, 0, 0.018],
    [0.014, 0.30, 0.014, 0.16, 0, 0.018],
  ];
  for (const [w, h, d, x, y, z] of frameParts) {
    hud.add(rbox(w, h, d, hudFrameMat, x, y, z));
  }
  // combiner support struts
  hud.add(rbox(0.018, 0.16, 0.018, hudFrameMat, -0.15, -0.21, 0.018));
  hud.add(rbox(0.018, 0.16, 0.018, hudFrameMat, 0.15, -0.21, 0.018));

  // ---- AoA indexer (beside the left HUD combiner strut) ------------------
  const aoaIndexer = new THREE.Group();
  aoaIndexer.position.set(-0.19, 1.13, -3.35);
  group.add(aoaIndexer);
  aoaIndexer.add(rbox(0.075, 0.17, 0.026, matScreenEdge, 0, 0, 0));

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
  aoaUp.position.set(0, 0.053, 0.021);

  const aoaMid = new THREE.Mesh(new THREE.TorusGeometry(0.015, 0.0055, 6, 16), aoaLampMat(0x33ff77));
  aoaMid.name = 'aoaMid';
  aoaMid.position.set(0, 0, 0.021);

  const aoaDown = new THREE.Mesh(chevronGeo, aoaLampMat(0xff3322));
  aoaDown.name = 'aoaDown';
  aoaDown.rotation.z = Math.PI;
  aoaDown.position.set(0, -0.053, 0.021);

  aoaIndexer.add(aoaUp, aoaMid, aoaDown);

  // ---- canopy rain overlay ---------------------------------------------
  const rainTex = canvasTex(256, 256, drawRainStreaks);
  rainTex.tex.wrapS = THREE.RepeatWrapping;
  rainTex.tex.wrapT = THREE.RepeatWrapping;
  const rainMat = new THREE.MeshBasicMaterial({
    map: rainTex.tex, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  const canopyRain = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 0.54), rainMat);
  canopyRain.name = 'canopyRain';
  canopyRain.position.set(0, 0.97, -3.02);
  canopyRain.rotation.x = -0.34;
  canopyRain.visible = false;
  canopyRain.renderOrder = 4;
  group.add(canopyRain);

  // ---- consoles ----------------------------------------------------------
  const consoleTexture = canvasTex(512, 256, drawConsoles);
  const consoleMat = new THREE.MeshBasicMaterial({ map: consoleTexture.tex, toneMapped: false });
  for (const side of [-1, 1]) {
    const body = rbox(0.24, 0.16, 1.7, matPanel, side * 0.45, 0.48, -2.55);
    body.rotation.z = side * -0.05;
    group.add(body);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 1.5), consoleMat);
    face.rotation.x = -Math.PI / 2;
    face.position.set(side * 0.45, 0.565, -2.55);
    group.add(face);
  }

  // throttle
  const throttle = new THREE.Group();
  throttle.position.set(-0.44, 0.56, -2.9);
  const tHandle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.24), matDark);
  tHandle.position.set(0, 0.05, 0.0);
  throttle.add(tHandle);
  const tGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.12, 8), matHarness);
  tGrip.rotation.x = Math.PI / 2;
  tGrip.position.set(0, 0.11, -0.02);
  throttle.add(tGrip);
  group.add(throttle);

  // sidestick
  const stick = new THREE.Group();
  stick.position.set(0.18, 0.34, -1.95);
  const sBase = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.10, 10), matDark);
  stick.add(sBase);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.34, 8), matMetal);
  shaft.position.y = 0.18;
  stick.add(shaft);
  const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.14, 4, 8), matDark);
  grip.position.y = 0.38;
  grip.rotation.z = 0.12;
  stick.add(grip);
  group.add(stick);

  // rudder pedals
  const pedals = [];
  for (const side of [-1, 1]) {
    const pedal = new THREE.Group();
    pedal.position.set(side * 0.16, 0.22, -3.05);
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.2), matMetal);
    p.rotation.x = -0.5;
    pedal.add(p);
    group.add(pedal);
    pedals.push(pedal);
  }

  // ---- ejection seat (tucked cleanly inside rear bubble canopy) ----------
  const seat = new THREE.Group();
  seat.position.set(0, 0.26, -1.62);
  const pan = rbox(0.48, 0.11, 0.56, matSeat, 0, 0, 0.05);
  seat.add(pan);
  const back = rbox(0.46, 0.86, 0.11, matSeat, 0, 0.40, 0.24);
  back.rotation.x = 0.32;
  seat.add(back);
  const head = rbox(0.24, 0.22, 0.12, matSeat, 0, 0.84, 0.38);
  head.rotation.x = 0.32;
  seat.add(head);
  // harness
  for (const side of [-1, 1]) {
    const strap = rbox(0.055, 0.55, 0.025, matHarness, side * 0.13, 0.5, 0.16);
    strap.rotation.x = 0.3;
    seat.add(strap);
  }
  // ejection handle
  const ejHandle = new THREE.Mesh(
    new THREE.TorusGeometry(0.055, 0.012, 6, 12, Math.PI),
    new THREE.MeshStandardMaterial({ color: 0xd8c24a, roughness: 0.6 }),
  );
  ejHandle.rotation.x = Math.PI / 2;
  ejHandle.position.set(0, 0.16, -0.35);
  seat.add(ejHandle);
  group.add(seat);

  // ---- interior light ----------------------------------------------------
  const light = new THREE.PointLight(0xcfffe0, 2.2, 5.0, 2);
  light.position.set(0, 1.02, -2.55);
  group.add(light);
  const fill = new THREE.PointLight(0x9fc9ff, 0.9, 3.4, 2);
  fill.position.set(0, 0.85, -3.15);
  group.add(fill);

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
    light.intensity = ind.floodIntensity;

    // canopy raindrop streaks
    canopyRain.visible = ind.rainOpacity > 0.01;
    if (canopyRain.visible) {
      rainMat.opacity = ind.rainOpacity;
      rainTex.tex.offset.y = (((rainTex.tex.offset.y - ind.rainScrollSpeed * dt) % 1) + 1) % 1;
    }

    screenAcc += dt;
    if (screenAcc < 0.1) return;
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

    drawADI(mfdL.ctx, 256, 256, tmpTelemetry);
    mfdL.tex.needsUpdate = true;
    drawHSI(mfdR.ctx, 256, 256, tmpTelemetry);
    mfdR.tex.needsUpdate = true;

    for (const g of gauges) {
      drawGauge(g.tex.ctx, 128, 128, g.label, g.label === 'SPD' ? tmpTelemetry.kts : tmpTelemetry.altFt, g.max, '');
      g.tex.tex.needsUpdate = true;
    }
  }

  return {
    group, update, hudGlass: glass, mfdL, mfdR, screenL, screenR,
    aoaIndexer, aoaUp, aoaMid, aoaDown,
    masterCaution: cautionLamp, canopyRain,
  };
}