// Inter-settlement road network: deterministic links from villages to towns,
// towns to cities, rendered as terrain-following instanced road segments.
import * as THREE from 'three';
import { settlementsNear } from './settlements.js';
import { terrainHeight, airportsNear } from './terrain.js';
import { hash2 } from './noise.js';

const RANK = { metro: 4, town: 3, village: 2, hamlet: 1 };

function makeRoadTexture() {
  const W = 64, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#333633';
  ctx.fillRect(0, 0, W, H);
  const rng = (() => { let a = 1234567; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
  for (let i = 0; i < 900; i++) {
    const v = 40 + Math.floor(rng() * 35);
    ctx.fillStyle = `rgba(${v},${v},${v},${0.15 + rng() * 0.3})`;
    ctx.fillRect(rng() * W, rng() * H, 1 + rng() * 4, 1 + rng() * 2);
  }
  // dashed centre line
  ctx.fillStyle = 'rgba(224,214,160,0.75)';
  for (let y = 4; y < H; y += 34) ctx.fillRect(W / 2 - 1.5, y, 3, 16);
  // edge lines
  ctx.fillStyle = 'rgba(220,220,210,0.35)';
  ctx.fillRect(3, 0, 1.5, H);
  ctx.fillRect(W - 4.5, 0, 1.5, H);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class RoadNetwork {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset;
    this.capacity = preset.name === 'low' ? 7000 : preset.name === 'high' ? 16000 : 11000;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.material = new THREE.MeshLambertMaterial({
      map: makeRoadTexture(),
      polygonOffset: true,
      polygonOffsetFactor: -1.5,
      polygonOffsetUnits: -1.5,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = 'highways';
    scene.add(this.mesh);
    this._lastX = Infinity;
    this._lastZ = Infinity;
    this.stats = { roads: 0, segments: 0 };
    this._dummy = new THREE.Object3D();
  }

  _linkTarget(s, all) {
    const rank = RANK[s.type] || 0;
    if (s.type === 'metro') return null;
    let best = null;
    let bestD = Infinity;
    for (const t of all) {
      if (t === s || (RANK[t.type] || 0) <= rank) continue;
      const d = Math.hypot(t.x - s.x, t.z - s.z);
      if (d < 80) continue;
      const maxD = s.type === 'town' ? 26000 : 13000;
      if (d > maxD) continue;
      const penalty = s.type === 'village' && t.type === 'metro' ? 1000 : 0;
      if (d + penalty < bestD) { bestD = d + penalty; best = t; }
    }
    if (best) return best;
    // Fallback: a town with no city nearby still gets a trunk road to the
    // nearest town; a village links to the nearest village.
    const same = s.type === 'town' ? 'town' : s.type === 'village' ? 'village' : null;
    if (!same) return null;
    const maxD = s.type === 'town' ? 18000 : 9000;
    for (const t of all) {
      if (t === s || t.type !== same) continue;
      const d = Math.hypot(t.x - s.x, t.z - s.z);
      if (d < 120 || d > maxD) continue;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  _rebuild(camera) {
    const all = settlementsNear(camera.position.x, camera.position.z, 30000);
    const near = all.filter((s) => {
      const d = Math.hypot(s.x - camera.position.x, s.z - camera.position.z);
      return d < 23000 && s.type !== 'hamlet';
    });
    // airports near the active disc: roads must not run across a runway
    const aps = airportsNear(camera.position.x, camera.position.z, 3);

    const seen = new Set();
    const links = [];
    for (const s of near) {
      const t = this._linkTarget(s, all);
      if (!t) continue;
      const key = s.id < t.id ? s.id + '|' + t.id : t.id + '|' + s.id;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push([s, t]);
    }

    const dummy = this._dummy;
    let n = 0;
    for (const [a, b] of links) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 100) continue;
      const width = a.type === 'town' && b.type === 'metro' ? 16
        : a.type === 'metro' || b.type === 'metro' ? 13
          : a.type === 'town' && b.type === 'town' ? 11 : 9;
      // gentle bend, deterministic per pair
      const bend = (hash2(Math.round((a.x + b.x) / 100), Math.round((a.z + b.z) / 100), 611) - 0.5) * len * 0.22;
      const px = -dz / len, pz = dx / len;
      const mx = (a.x + b.x) * 0.5 + px * bend;
      const mz = (a.z + b.z) * 0.5 + pz * bend;

      const pieces = Math.max(2, Math.ceil(len / 70));
      let lastX = a.x, lastZ = a.z;
      for (let i = 1; i <= pieces; i++) {
        const t = i / pieces;
        const it = 1 - t;
        const x = it * it * a.x + 2 * it * t * mx + t * t * b.x;
        const z = it * it * a.z + 2 * it * t * mz + t * t * b.z;
        if (n >= this.capacity) break;
        const sx = x - lastX;
        const sz = z - lastZ;
        const segLen = Math.hypot(sx, sz);
        if (segLen < 1) { lastX = x; lastZ = z; continue; }
        const cx = (x + lastX) * 0.5;
        const cz = (z + lastZ) * 0.5;
        // skip runway / apron areas
        let blocked = false;
        for (const ap of aps) {
          if (Math.hypot(ap.x - cx, ap.z - cz) < ap.padRadius + 60) { blocked = true; break; }
        }
        if (blocked) { lastX = x; lastZ = z; continue; }

        const y = terrainHeight(cx, cz) + 0.9;
        dummy.position.set(cx, y, cz);
        dummy.rotation.set(0, Math.atan2(sx, sz), 0);
        dummy.scale.set(width, 1, segLen + 1.2);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(n++, dummy.matrix);
        lastX = x; lastZ = z;
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this._lastX = camera.position.x;
    this._lastZ = camera.position.z;
    this.stats.roads = links.length;
    this.stats.segments = n;
  }

  update(camera) {
    if (!this.preset.roadDetail) {
      if (this.mesh.count) { this.mesh.count = 0; }
      return;
    }
    const dx = camera.position.x - this._lastX;
    const dz = camera.position.z - this._lastZ;
    if (this._lastX === Infinity || dx * dx + dz * dz > 2000 * 2000) {
      this._rebuild(camera);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}