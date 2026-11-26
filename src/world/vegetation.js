// Instanced low-poly forest near the aircraft.
import * as THREE from 'three';
import { terrainHeight, slopeAt, airportNear } from './terrain.js';
import { hash2, mulberry32, clamp, smoothstep } from './noise.js';
import { fbm01 } from './noise.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

export class VegetationSystem {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset;

    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.42, 1, 5);
    trunkGeo.translate(0, 0.5, 0);
    this.trunkMat = new THREE.MeshLambertMaterial({ color: 0x4a3a2a });
    this.trunks = new THREE.InstancedMesh(trunkGeo, this.trunkMat, preset.treeLimit);
    this.trunks.frustumCulled = false;
    this.trunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const leafGeo = new THREE.ConeGeometry(1, 1, 7);
    leafGeo.translate(0, 0.5, 0);
    this.leafMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.leaves = new THREE.InstancedMesh(leafGeo, this.leafMat, preset.treeLimit);
    this.leaves.frustumCulled = false;
    this.leaves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    scene.add(this.trunks, this.leaves);
    this.trunks.count = 0;
    this.leaves.count = 0;

    this._lastX = Infinity;
    this._lastZ = Infinity;
    this._trees = 0;
  }

  update(dt, camera, sky) {
    const dx = camera.position.x - this._lastX;
    const dz = camera.position.z - this._lastZ;
    if (dx * dx + dz * dz > 360 * 360 || this._lastX === Infinity) {
      this.rebuild(camera);
    }
  }

  rebuild(camera) {
    const radius = this.preset.treeRadius;
    const cell = 190;
    const x0 = Math.floor((camera.position.x - radius) / cell);
    const x1 = Math.floor((camera.position.x + radius) / cell);
    const z0 = Math.floor((camera.position.z - radius) / cell);
    const z1 = Math.floor((camera.position.z + radius) / cell);
    const limit = this.preset.treeLimit;
    let n = 0;

    for (let cz = z0; cz <= z1 && n < limit; cz++) {
      for (let cx = x0; cx <= x1 && n < limit; cx++) {
        const rnd = hash2(cx, cz, 5521);
        if (rnd > 0.62) continue;
        const baseX = cx * cell;
        const baseZ = cz * cell;
        const forest = fbm01(baseX * 0.0012, baseZ * 0.0012, 3, 1201);
        if (forest < 0.47) continue;
        const h = terrainHeight(baseX + cell * 0.5, baseZ + cell * 0.5);
        if (h < 2.2) continue;
        if (smoothstep(0.35, 0.8, forest) < rnd * 0.9) continue;
        const ap = airportNear(baseX, baseZ, 2400);
        if (ap) {
          const d = Math.hypot(ap.x - baseX, ap.z - baseZ);
          if (d < ap.padRadius + 150) continue;
        }
        const rng = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x51ed);
        const count = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < count && n < limit; k++) {
          const x = baseX + rng() * cell;
          const z = baseZ + rng() * cell;
          const y = terrainHeight(x, z);
          if (y < 2.2) continue;
          const slope = slopeAt(x, z);
          if (slope > 0.55) continue;
          const hgt = 7 + rng() * 11;
          const width = hgt * (0.22 + rng() * 0.1);
          const rot = rng() * Math.PI * 2;

          _p.set(x, y - 0.2, z);
          _e.set(0, rot, 0);
          _q.setFromEuler(_e);

          _s.set(1, hgt * 0.42, 1);
          _m.compose(_p, _q, _s);
          this.trunks.setMatrixAt(n, _m);

          _p.set(x, y + hgt * 0.18, z);
          _s.set(width, hgt * 0.9, width);
          _m.compose(_p, _q, _s);
          this.leaves.setMatrixAt(n, _m);

          const tint = 0.75 + rng() * 0.35;
          _c.setRGB(0.16 * tint, 0.30 * tint, 0.14 * tint);
          this.leaves.setColorAt(n, _c);
          n++;
        }
      }
    }

    this.trunks.count = n;
    this.leaves.count = n;
    this.trunks.instanceMatrix.needsUpdate = true;
    this.leaves.instanceMatrix.needsUpdate = true;
    if (this.leaves.instanceColor) this.leaves.instanceColor.needsUpdate = true;
    this._trees = n;
    this._lastX = camera.position.x;
    this._lastZ = camera.position.z;
  }

  dispose() {
    this.trunks.geometry.dispose();
    this.trunkMat.dispose();
    this.leaves.geometry.dispose();
    this.leafMat.dispose();
    this.trunks.removeFromParent();
    this.leaves.removeFromParent();
  }
}