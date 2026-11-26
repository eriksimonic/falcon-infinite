// Detailed airports: runway, markings, taxiways, apron, hangars, tower, lights.
import * as THREE from 'three';
import { airportNear, airportsNear, terrainHeight } from './terrain.js';
import { mulberry32, hashU32, smoothstep } from './noise.js';

const _tmp = new THREE.Vector3();

function makeRunwayTexture(length, width, heading) {
  const W = 2048;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

  // asphalt
  ctx.fillStyle = '#3b3e41';
  ctx.fillRect(0, 0, W, H);
  const rng = mulberry32((hashU32(Math.round(length), Math.round(width), 71) ^ 0x55aa) >>> 0);
  for (let i = 0; i < 9000; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const v = 42 + Math.floor(rng() * 34);
    ctx.fillStyle = `rgba(${v},${v + 2},${v + 3},${0.12 + rng() * 0.25})`;
    ctx.fillRect(x, y, 1 + rng() * 5, 1 + rng() * 2);
  }
  // faint longitudinal joints
  ctx.strokeStyle = 'rgba(20,22,24,0.35)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (H / 6) * i);
    ctx.lineTo(W, (H / 6) * i);
    ctx.stroke();
  }

  const cw = 5; // centre line width in px
  ctx.fillStyle = 'rgba(238,240,236,0.92)';

  // edge lines
  ctx.fillRect(0, 10, W, 4);
  ctx.fillRect(0, H - 14, W, 4);

  // centreline dashes
  const dash = 64;
  const gap = 46;
  for (let x = 140; x < W - 140; x += dash + gap) {
    const end = Math.min(x + dash, W - 140);
    ctx.fillRect(x, H / 2 - cw / 2, end - x, cw);
  }

  // threshold piano keys + aiming point blocks at both ends
  const drawThreshold = (x0, mirrored) => {
    const dir = mirrored ? -1 : 1;
    for (let i = 0; i < 8; i++) {
      const y = 26 + i * 26;
      ctx.fillRect(x0 + (mirrored ? -38 : 0), y, 38, 14);
    }
    // aiming point
    ctx.fillRect(x0 + dir * 150, H / 2 - 55, 52, 34);
    ctx.fillRect(x0 + dir * 150, H / 2 + 21, 52, 34);
    // touchdown zone
    for (let k = 0; k < 3; k++) {
      const bx = x0 + dir * (230 + k * 74);
      ctx.fillRect(bx, H / 2 - 72, 34, 22);
      ctx.fillRect(bx, H / 2 + 50, 34, 22);
    }
  };
  drawThreshold(30, false);
  drawThreshold(W - 30 - 38, true);

  // runway numbers, perpendicular to the runway
  ctx.save();
  ctx.translate(108, H / 2);
  ctx.rotate(Math.PI / 2);
  ctx.font = 'bold 92px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(238,240,236,0.95)';
  const n1 = Math.round(heading / 10) % 36;
  const num = String(n1 === 0 ? 36 : n1).padStart(2, '0');
  ctx.fillText(num, 0, 0);
  ctx.restore();

  ctx.save();
  ctx.translate(W - 108, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 92px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(238,240,236,0.95)';
  const n2 = (n1 + 18) % 36;
  const recip = String(n2 === 0 ? 36 : n2).padStart(2, '0');
  ctx.fillText(recip, 0, 0);
  ctx.restore();

  // weathered centre wear
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(10,10,10,0.35)');
  grad.addColorStop(0.12, 'rgba(10,10,10,0.0)');
  grad.addColorStop(0.5, 'rgba(10,10,10,0.12)');
  grad.addColorStop(0.88, 'rgba(10,10,10,0.0)');
  grad.addColorStop(1, 'rgba(10,10,10,0.35)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeAsphaltTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3f4244';
  ctx.fillRect(0, 0, S, S);
  const rng = mulberry32(8841);
  for (let i = 0; i < 4000; i++) {
    const v = 45 + Math.floor(rng() * 40);
    ctx.fillStyle = `rgba(${v},${v},${v},${0.1 + rng() * 0.3})`;
    ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 2, 1 + rng() * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function box(w, h, d, color, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x, y, z);
  return mesh;
}

export function buildAirport(ap, weatherRef) {
  const group = new THREE.Group();
  group.name = 'airport:' + ap.id;
  group.position.set(ap.x, ap.elevation, ap.z);
  group.rotation.y = Math.PI / 2 - (ap.heading * Math.PI) / 180;

  const L = ap.length;
  const Wd = ap.width;
  const runwayTex = makeRunwayTexture(L, Wd, ap.heading);
  const runway = new THREE.Mesh(
    new THREE.PlaneGeometry(L, Wd),
    new THREE.MeshLambertMaterial({
      map: runwayTex,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  runway.rotation.x = -Math.PI / 2;
  runway.position.y = 0.08;
  group.add(runway);

  // shoulders
  const shoulderMat = new THREE.MeshLambertMaterial({ color: 0x50544f });
  const shoulder = new THREE.Mesh(new THREE.PlaneGeometry(L + 40, Wd + 24), shoulderMat);
  shoulder.rotation.x = -Math.PI / 2;
  shoulder.position.y = 0.04;
  shoulder.receiveShadow = false;
  group.add(shoulder);

  const asphaltTex = makeAsphaltTexture();
  asphaltTex.repeat.set(9, 2);
  const asphaltMat = new THREE.MeshLambertMaterial({ map: asphaltTex });

  // taxiway parallel to the runway
  const taxiZ = Wd * 0.5 + 110;
  const taxi = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.72, 24), asphaltMat);
  taxi.rotation.x = -Math.PI / 2;
  taxi.position.set(0, 0.07, taxiZ);
  taxi.material = asphaltMat;
  group.add(taxi);

  // links to runway
  for (const sx of [-0.28, 0.1, 0.34]) {
    const link = new THREE.Mesh(new THREE.PlaneGeometry(28, 116), asphaltMat);
    link.rotation.x = -Math.PI / 2;
    link.position.set(L * sx, 0.071, taxiZ - 60);
    group.add(link);
  }

  // apron
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(320, 190), asphaltMat);
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(L * 0.09, 0.065, taxiZ + 150);
  group.add(apron);

  // taxi/apron markings
  const markMat = new THREE.MeshBasicMaterial({ color: 0xd7d19a, transparent: true, opacity: 0.75 });
  const line = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.7, 0.9), markMat);
  line.rotation.x = -Math.PI / 2;
  line.position.set(0, 0.09, taxiZ);
  group.add(line);
  for (let i = -2; i <= 2; i++) {
    const stand = new THREE.Mesh(new THREE.PlaneGeometry(16, 0.75), markMat);
    stand.rotation.x = -Math.PI / 2;
    stand.position.set(L * 0.09 + i * 34, 0.09, taxiZ + 80);
    group.add(stand);
  }

  // hangars with curved roofs
  const hangarColors = [0xb9b6ad, 0xa6a8a3, 0xc3bda9, 0x9fa3a0];
  const isIntl = ap.kind === 'international' || ap.kind === 'intl';
  const nHangars = isIntl ? 5 : ap.kind === 'regional' ? 3 : 2;
  for (let i = 0; i < nHangars; i++) {
    const hx = L * 0.02 + i * 78 - (nHangars - 1) * 34;
    const hz = taxiZ + 250;
    const body = box(64, 16, 54, hangarColors[i % hangarColors.length], hx, 8, hz);
    group.add(body);
    const roof = new THREE.Mesh(
      new THREE.CylinderGeometry(34, 34, 64, 18, 1, false, 0, Math.PI),
      new THREE.MeshLambertMaterial({ color: 0x8f938f }),
    );
    roof.rotation.z = Math.PI / 2;
    roof.rotation.y = Math.PI / 2;
    roof.position.set(hx, 16, hz);
    roof.scale.set(1, 0.5, 0.82);
    group.add(roof);
    // door
    const door = new THREE.Mesh(
      new THREE.PlaneGeometry(34, 13),
      new THREE.MeshLambertMaterial({ color: 0x2b2f2e }),
    );
    door.position.set(hx, 6.8, hz - 27.2);
    group.add(door);
  }

  // terminal
  if (ap.kind !== 'airfield') {
    const tw = isIntl ? 160 : 90;
    const term = box(tw, 14, 42, 0xc9c6bc, L * 0.03, 7, taxiZ + 380);
    group.add(term);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(tw - 6, 7),
      new THREE.MeshLambertMaterial({ color: 0x223a44, emissive: 0x102028, emissiveIntensity: 0.7 }),
    );
    glass.position.set(L * 0.03, 8.4, taxiZ + 358.9);
    group.add(glass);
    // roof lip
    group.add(box(tw + 10, 1.4, 48, 0x8d918c, L * 0.03, 14.6, taxiZ + 380));
  }

  // control tower
  const tz = taxiZ + 430;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(4.2, 5.4, 30, 10),
    new THREE.MeshLambertMaterial({ color: 0xbdbcb4 }),
  );
  shaft.position.set(-L * 0.28, 15, tz);
  group.add(shaft);
  const cab = new THREE.Mesh(
    new THREE.CylinderGeometry(8.4, 7.2, 6.5, 12),
    new THREE.MeshLambertMaterial({ color: 0x27414a, emissive: 0x14303a, emissiveIntensity: 0.4 }),
  );
  cab.position.set(-L * 0.28, 33, tz);
  group.add(cab);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(9.2, 9.2, 1.0, 12),
    new THREE.MeshLambertMaterial({ color: 0x777c78 }),
  );
  cap.position.set(-L * 0.28, 37, tz);
  group.add(cap);
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 12, 4),
    new THREE.MeshLambertMaterial({ color: 0x9a9a92 }),
  );
  mast.position.set(-L * 0.28, 43, tz);
  group.add(mast);

  // fuel tanks
  for (let i = 0; i < 2; i++) {
    const tank = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 9, 18, 14),
      new THREE.MeshLambertMaterial({ color: 0xd8d8ce }),
    );
    tank.position.set(L * 0.3 + i * 24, 9, taxiZ + 300);
    group.add(tank);
  }

  // windsock
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.25, 9, 6),
    new THREE.MeshLambertMaterial({ color: 0x8d928d }),
  );
  pole.position.set(-L * 0.5 + 60, 4.5, taxiZ - 30);
  group.add(pole);
  const sockPivot = new THREE.Group();
  sockPivot.position.set(-L * 0.5 + 60, 8.7, taxiZ - 30);
  group.add(sockPivot);
  const sock = new THREE.Mesh(
    new THREE.ConeGeometry(1.4, 5.8, 8, 1, true),
    new THREE.MeshLambertMaterial({ color: 0xff7a2a, side: THREE.DoubleSide }),
  );
  // Cone points from base (-Y) toward tip (+Y); shift so wide opening sits at pivot.
  sock.position.set(0, 2.9, 0);
  sockPivot.add(sock);

  // runway edge lights
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xffe2a8, toneMapped: false, transparent: true, opacity: 0.9 });
  const redMat = new THREE.MeshBasicMaterial({ color: 0xff4b3a, toneMapped: false, transparent: true, opacity: 0.9 });
  const greenMat = new THREE.MeshBasicMaterial({ color: 0x60ff9a, toneMapped: false, transparent: true, opacity: 0.9 });
  const lightGeo = new THREE.BoxGeometry(1.1, 0.5, 1.1);
  const count = Math.floor(L / 55) * 2;
  const lights = new THREE.InstancedMesh(lightGeo, lightMat, count);
  const dummy = new THREE.Object3D();
  let li = 0;
  for (let s = 0; s < 2; s++) {
    const z = s === 0 ? -Wd / 2 - 3 : Wd / 2 + 3;
    for (let i = 0; i < count / 2; i++) {
      dummy.position.set(-L / 2 + 18 + i * (L - 36) / (count / 2 - 1), 0.4, z);
      dummy.updateMatrix();
      lights.setMatrixAt(li++, dummy.matrix);
    }
  }
  lights.instanceMatrix.needsUpdate = true;
  group.add(lights);

  // threshold lights (green approach, red departure)
  const tGeo = new THREE.BoxGeometry(1.4, 0.6, 1.4);
  const tGroup = new THREE.Group();
  for (const end of [-1, 1]) {
    const mat = end === -1 ? greenMat : redMat;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(tGeo, mat);
      m.position.set(end * (L / 2 + 2), 0.4, -Wd / 2 + 4 + i * (Wd - 8) / (n - 1));
      tGroup.add(m);
    }
  }
  group.add(tGroup);

  // PAPI
  const papiColors = [0xffffff, 0xffffff, 0xff3322, 0xff3322];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.1, 3),
      new THREE.MeshBasicMaterial({ color: papiColors[i], toneMapped: false }),
    );
    m.position.set(L * 0.28, 0.7, -Wd / 2 - 16 - i * 8);
    group.add(m);
  }

  // approach light bars
  for (let i = 0; i < 8; i++) {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(18, 0.4, 1.2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.7 }),
    );
    bar.position.set(-L / 2 - 60 - i * 45, 0.5, 0);
    group.add(bar);
  }

  const _sockUp = new THREE.Vector3(0, 1, 0);
  const _sockDir = new THREE.Vector3();
  const groupRotY = group.rotation.y;

  group.userData.animate = (windX, windZ, windSpeed, night, time = 0, gust = 0) => {
    // Rotate world wind vector into airport local space so the sock points true downwind.
    const c = Math.cos(groupRotY);
    const s = Math.sin(groupRotY);
    const lx = windX * c - windZ * s;
    const lz = windX * s + windZ * c;
    const spd = Math.hypot(lx, lz);
    const horiz = Math.min(1, Math.max(windSpeed, spd) / 10);
    const flutter = (0.06 + gust * 0.22) * horiz;
    const flapH = Math.sin(time * (5.5 + spd * 0.45)) * flutter;
    const flapV = Math.cos(time * (7.2 + spd * 0.55)) * flutter * 0.65;
    const nx = spd > 0.05 ? lx / spd : 1;
    const nz = spd > 0.05 ? lz / spd : 0;
    _sockDir.set(
      (nx - nz * flapH) * horiz + 0.12 * (1 - horiz),
      -0.88 * (1 - horiz) + flapV,
      (nz + nx * flapH) * horiz + 0.04 * (1 - horiz),
    ).normalize();
    sockPivot.quaternion.setFromUnitVectors(_sockUp, _sockDir);
    const op = 0.25 + night * 0.75;
    lightMat.opacity = op;
    redMat.opacity = op;
    greenMat.opacity = op;
  };

  group.userData.airport = ap;
  return group;
}

export class AirportSystem {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.built = new Map();
    this.windX = 0;
    this.windZ = 0;
    this.windSpeed = 0;
    this.night = 0;
  }

  update(dt, camera, weather, sky) {
    this.windX = weather.state.windX;
    this.windZ = weather.state.windZ;
    this.windSpeed = weather.state.windSpeed;
    this.windTime = weather.state.time || 0;
    this.windGust = weather.state.gust || 0;
    this.night = sky.night;

    const near = airportsNear(camera.position.x, camera.position.z, 2)
      .filter((ap) => {
        const dx = ap.x - camera.position.x;
        const dz = ap.z - camera.position.z;
        return Math.hypot(dx, dz) < this.preset.airportRadius;
      })
      .sort((a, b) => {
        const da = (a.x - camera.position.x) ** 2 + (a.z - camera.position.z) ** 2;
        const db = (b.x - camera.position.x) ** 2 + (b.z - camera.position.z) ** 2;
        return da - db;
      })
      .slice(0, 3);

    const wanted = new Set(near.map((a) => a.id));
    for (const [id, group] of this.built) {
      if (!wanted.has(id)) {
        this.group.remove(group);
        disposeGroup(group);
        this.built.delete(id);
      }
    }
    for (const ap of near) {
      if (!this.built.has(ap.id)) {
        const g = buildAirport(ap);
        this.built.set(ap.id, g);
        this.group.add(g);
      }
      const g = this.built.get(ap.id);
      g.userData.animate?.(this.windX, this.windZ, this.windSpeed, this.night, this.windTime, this.windGust);
    }
  }

  nearest(x, z, maxDist = 30000) {
    return airportNear(x, z, maxDist);
  }

  /**
   * Remove and dispose every built airport mesh.
   *
   * Keeps `this.group` (and the scene) intact so the next `update()` can build
   * the new theater's runways — procedural fields or the baked real ones.
   */
  clear() {
    for (const [id, g] of this.built) {
      this.group.remove(g);
      disposeGroup(g);
    }
    this.built.clear();
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
  }
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}