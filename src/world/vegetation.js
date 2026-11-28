// Dense, organic instanced forests for the Primorska / Vipava valley.
//
// Three draw calls total:
//   1. trunks   — tapered bark cylinders (shared by every tree)
//   2. leaves   — merged 4-lobe broadleaf canopy (oak / olive / beech)
//   3. conifers — merged 3-tier conifer canopy (Mediterranean pine / spruce)
//
// Canopy geometries bake a soft bottom-to-top ambient-occlusion gradient into
// their vertex colours; per-tree instance colours tint the whole crown. The
// renderer runs ACESFilmic + sRGB output, so palette hexes are converted to
// linear before upload (linear ~0.04..0.14 => realistic dark forest greens).
//
// Headless-safe: no document/window access, `scene` may be null or a plain
// { add, remove } stub, and every emitted index is clamped to its pool.
import * as THREE from 'three';
import { terrainHeight, slopeAt, airportNear } from './terrain.js';
import { hash2, mulberry32, clamp, smoothstep, fbm01 } from './noise.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

// ---------------------------------------------------------------------------
// Geometry helpers (pure, headless)
// ---------------------------------------------------------------------------

/**
 * Merge geometries that carry `position` / `normal` (and optional `color`)
 * into one indexed BufferGeometry. Only the attributes the vegetation shaders
 * need are copied, so no extra imports are required.
 */
export function mergeSimpleGeometries(geos) {
  const pos = [];
  const nor = [];
  const col = [];
  const idx = [];
  let base = 0;

  for (const g of geos) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const c = g.getAttribute('color');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      if (n) nor.push(n.getX(i), n.getY(i), n.getZ(i));
      else nor.push(0, 1, 0);
      if (c) col.push(c.getX(i), c.getY(i), c.getZ(i));
      else col.push(1, 1, 1);
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    } else {
      for (let i = 0; i < p.count; i++) idx.push(base + i);
    }
    base += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (idx.length) out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

/** Paint a bottom-to-top baked AO gradient into a merged geometry's colours. */
function paintCanopyAO(geo, shadeLow, shadeHigh, lift = 0) {
  const p = geo.getAttribute('position');
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(1e-4, maxY - minY);
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = clamp((p.getY(i) - minY) / span + lift, 0, 1);
    const shade = shadeLow + (shadeHigh - shadeLow) * t;
    col[i * 3] = shade;
    col[i * 3 + 1] = shade;
    col[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Irregular icosahedron lobe: displacement is a function of position, so no
 *  duplicated (non-indexed) vertex can tear away from its neighbours. */
function makeBroadleafLobe(radius, seed, ox, oy, oz) {
  const g = new THREE.IcosahedronGeometry(radius, 1);
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const d = 1 + 0.14 * Math.sin(x * 5.3 + seed) * Math.cos(z * 4.7 - y * 3.9 + seed);
    p.setXYZ(i, x * d, y * d, z * d);
    // Smooth blob shading: sphere normal from the displaced direction.
    n.setXYZ(i, x, y, z);
  }
  const nrm = g.getAttribute('normal');
  const v = new THREE.Vector3();
  for (let i = 0; i < nrm.count; i++) {
    v.fromBufferAttribute(nrm, i);
    if (v.lengthSq() > 0) v.normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  g.translate(ox, oy, oz);
  return g;
}

/** Broadleaf crown: central lobe + 3 offset side/upper lobes. Unit height,
 *  base at y = 0, then crown width comes from instance scale. */
function makeBroadleafCanopy() {
  const parts = [
    makeBroadleafLobe(0.72, 0.7, 0.00, 0.66, 0.00), // central crown
    makeBroadleafLobe(0.56, 2.1, 0.52, 0.48, 0.18), // right shoulder
    makeBroadleafLobe(0.54, 3.7, -0.44, 0.52, -0.30), // left shoulder
    makeBroadleafLobe(0.46, 5.3, 0.06, 0.86, 0.40), // sunlit upper lobe
  ];
  const geo = mergeSimpleGeometries(parts);
  for (const p of parts) p.dispose();

  // Normalise: unit height, base sitting on y = 0.
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const height = Math.max(1e-4, bb.max.y - bb.min.y);
  geo.scale(1 / height, 1 / height, 1 / height);
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  geo.computeBoundingSphere();
  return paintCanopyAO(geo, 0.58, 1.08);
}

/** Conifer crown: three stacked irregular tapered bough tiers. */
function makeConiferCanopy() {
  const tiers = [
    { r: 0.62, h: 0.68, y: 0.00, seg: 8, seed: 1.3 }, // wide lower boughs
    { r: 0.48, h: 0.62, y: 0.42, seg: 7, seed: 3.1 }, // mid boughs
    { r: 0.33, h: 0.58, y: 0.82, seg: 6, seed: 5.9 }, // crisp crown
  ];
  const parts = [];
  for (const t of tiers) {
    const g = new THREE.ConeGeometry(t.r, t.h, t.seg, 1);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const radial = Math.hypot(x, z);
      if (radial < 1e-5) continue; // apex / cap centre stays crisp
      const ang = Math.atan2(z, x);
      const d = 1 + 0.16 * Math.sin(ang * 3 + t.seed) * Math.cos(ang * 2.1 - t.seed);
      p.setXYZ(i, x * d, p.getY(i), z * d);
    }
    g.computeVertexNormals();
    g.translate(0, t.y + t.h * 0.5, 0);
    parts.push(g);
  }
  const geo = mergeSimpleGeometries(parts);
  for (const p of parts) p.dispose();

  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const height = Math.max(1e-4, bb.max.y - bb.min.y);
  geo.scale(1 / height, 1 / height, 1 / height);
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  geo.computeBoundingSphere();
  return paintCanopyAO(geo, 0.55, 1.05);
}

// sRGB hexes, linearised at placement time. Muted Mediterranean olive / oak /
// dark beech with occasional warm sage and autumn olive; deep Alpine spruce and
// dark Mediterranean pine for the higher conifer belt.
const BROADLEAF_COLORS = [0x55652f, 0x4a5f2c, 0x3d5230, 0x6b6b40, 0x746a44];
const CONIFER_COLORS = [0x2c4433, 0x334d3a, 0x24382c, 0x2f4a3a];

function gcd(a, b) {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** Odd stride coprime with `total` => a cheap full-cycle spatial shuffle. */
function coprimeStride(total) {
  let s = 7919;
  while (gcd(s, total) !== 1) s += 2;
  return s;
}

export class VegetationSystem {
  constructor(scene, preset) {
    this.scene = scene || null;
    this.preset = preset || null;

    // Pools are sized once from the largest preset so a live quality switch
    // (medium -> high) can never write past the allocated instance buffers.
    const presetLimit = this.preset && this.preset.treeLimit ? this.preset.treeLimit : 9000;
    const poolCap = Math.max(18000, presetLimit);
    this._poolCap = poolCap;
    // Broadleaf needs headroom to dominate the valley floor, conifers to
    // dominate the Alpine belt; both pools together exceed the largest
    // treeLimit so every emitted tree finds a slot at any mix ratio.
    this.broadCap = Math.ceil(poolCap * 0.8);
    this.coniferCap = Math.ceil(poolCap * 0.7);
    this.trunkCap = poolCap;

    this.trunkGeo = new THREE.CylinderGeometry(0.28, 0.42, 1, 5);
    this.trunkGeo.translate(0, 0.5, 0);
    this.trunkMat = new THREE.MeshLambertMaterial({ color: 0x4b3b2c });

    this.leafGeo = makeBroadleafCanopy();
    this.leafMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });

    this.coniferGeo = makeConiferCanopy();
    this.coniferMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });

    this.trunks = new THREE.InstancedMesh(this.trunkGeo, this.trunkMat, this.trunkCap);
    this.leaves = new THREE.InstancedMesh(this.leafGeo, this.leafMat, this.broadCap);
    this.conifers = new THREE.InstancedMesh(this.coniferGeo, this.coniferMat, this.coniferCap);

    for (const mesh of [this.trunks, this.leaves, this.conifers]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
    }
    this.trunks.castShadow = false;
    this.trunks.receiveShadow = false;
    this.leaves.castShadow = true;
    this.leaves.receiveShadow = true;
    this.conifers.castShadow = true;
    this.conifers.receiveShadow = true;

    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this.group.add(this.trunks, this.leaves, this.conifers);
    if (this.scene && typeof this.scene.add === 'function') this.scene.add(this.group);

    this._lastX = Infinity;
    this._lastZ = Infinity;
    this._trees = 0;
    this._broad = 0;
    this._conifer = 0;
  }

  update(dt, camera, sky) {
    if (!camera || !camera.position) return;
    const dx = camera.position.x - this._lastX;
    const dz = camera.position.z - this._lastZ;
    if (this._lastX === Infinity || dx * dx + dz * dz > 360 * 360) {
      this.rebuild(camera);
    }
  }

  rebuild(camera) {
    const camX = camera && camera.position ? camera.position.x : 0;
    const camZ = camera && camera.position ? camera.position.z : 0;
    const radius = (this.preset && this.preset.treeRadius) || 5000;
    const limit = Math.max(0, Math.floor((this.preset && this.preset.treeLimit) || 9000));
    const cell = 95;

    const x0 = Math.floor((camX - radius) / cell);
    const x1 = Math.floor((camX + radius) / cell);
    const z0 = Math.floor((camZ - radius) / cell);
    const z1 = Math.floor((camZ + radius) / cell);
    const nx = x1 - x0 + 1;
    const nz = z1 - z0 + 1;
    const total = nx * nz;

    let n = 0;
    let nb = 0;
    let nc = 0;

    if (total > 0) {
      const stride = coprimeStride(total);
      const broadFull0 = this.broadCap <= 0;
      const coniferFull0 = this.coniferCap <= 0;
      const parked = broadFull0 && coniferFull0;

      outer: for (let i = 0; i < total && n < limit && !parked; i++) {
        const j = (i * stride) % total;
        const cx = x0 + (j % nx);
        const cz = z0 + Math.floor(j / nx);
        const baseX = cx * cell + cell * 0.5;
        const baseZ = cz * cell + cell * 0.5;

        // Organic groves: primary forest mask + secondary grove noise, so the
        // valley floor and Karst slopes break into irregular stands.
        const forest = fbm01(baseX * 0.0009, baseZ * 0.0009, 3, 1201);
        const grove = fbm01(baseX * 0.0027 + 31.7, baseZ * 0.0027 - 17.3, 2, 7717);
        const density = smoothstep(0.44, 0.76, forest) * (0.55 + 0.9 * grove);
        if (hash2(cx, cz, 5521) > density) continue;

        const hCell = terrainHeight(baseX, baseZ);
        if (hCell < 3.0) continue; // sea, rivers, low wetlands
        const cellSlope = slopeAt(baseX, baseZ);
        if (cellSlope > 0.65) continue; // cliffs / scree

        const ap = airportNear(baseX, baseZ, 2400);
        if (ap) {
          const d = Math.hypot(ap.x - baseX, ap.z - baseZ);
          if (d < ap.padRadius + 160 + cell) continue;
        }

        const rng = mulberry32(((cx * 73856093) ^ (cz * 19349663) ^ 0x51ed) >>> 0);
        const count = 3 + Math.floor(rng() * 7); // 3..9 stems per wooded cell

        for (let k = 0; k < count; k++) {
          if (n >= limit) break outer;
          const x = baseX + (rng() - 0.5) * cell;
          const z = baseZ + (rng() - 0.5) * cell;
          const y = terrainHeight(x, z);
          if (y < 3.0) continue;
          // Fine-grained cliff rejection only where the cell is already steep.
          if (cellSlope > 0.3 && slopeAt(x, z) > 0.65) continue;
          if (ap) {
            const d = Math.hypot(ap.x - x, ap.z - z);
            if (d < ap.padRadius + 160) continue;
          }

          // Broadleaf owns the 30-500 m valley/Karst belt; conifers take over
          // above ~450 m, with a sparse planted-pine fraction down low.
          const coniferProb = 0.04 + 0.96 * smoothstep(420, 700, y);
          let isConifer = rng() < coniferProb;
          const broadFull = nb >= this.broadCap;
          const coniferFull = nc >= this.coniferCap;
          if (broadFull && coniferFull) break outer;
          if (isConifer && coniferFull) isConifer = false;
          else if (!isConifer && broadFull) isConifer = true;

          const rot = rng() * Math.PI * 2;
          _e.set(0, rot, 0);
          _q.setFromEuler(_e);

          if (isConifer) {
            const hgt = 9 + rng() * 13;
            const trunkH = hgt * 0.22;
            const thick = 0.5 + hgt * 0.03;
            const crownW = hgt * (0.36 + rng() * 0.14);

            _p.set(x, y - 0.25, z);
            _s.set(thick, trunkH, thick);
            _m.compose(_p, _q, _s);
            this.trunks.setMatrixAt(n, _m);

            _p.set(x, y - 0.2, z);
            _s.set(crownW, hgt, crownW);
            _m.compose(_p, _q, _s);
            this.conifers.setMatrixAt(nc, _m);

            _c.setHex(CONIFER_COLORS[(rng() * CONIFER_COLORS.length) | 0]).convertSRGBToLinear();
            // Higher altitudes read darker and cooler.
            _c.multiplyScalar(clamp(1.06 - (y - 450) * 0.00035, 0.78, 1.06) * (0.9 + rng() * 0.16));
            this.conifers.setColorAt(nc, _c);
            nc++;
          } else {
            const hgt = 6.5 + rng() * 10.5;
            const trunkH = hgt * (0.34 + rng() * 0.08);
            const crownH = hgt * (0.62 + rng() * 0.12);
            const thick = 0.55 + hgt * 0.045;
            const crownW = hgt * (0.30 + rng() * 0.14);

            _p.set(x, y - 0.3, z);
            _s.set(thick, trunkH, thick);
            _m.compose(_p, _q, _s);
            this.trunks.setMatrixAt(n, _m);

            _p.set(x, y + trunkH * 0.95, z);
            _s.set(crownW, crownH, crownW);
            _m.compose(_p, _q, _s);
            this.leaves.setMatrixAt(nb, _m);

            _c.setHex(BROADLEAF_COLORS[(rng() * BROADLEAF_COLORS.length) | 0]).convertSRGBToLinear();
            _c.multiplyScalar(0.86 + rng() * 0.26);
            this.leaves.setColorAt(nb, _c);
            nb++;
          }
          n++;
        }
      }
    }

    // Hard clamp to the allocated pools (quality switches may shrink presets).
    const nbOut = Math.min(nb, this.leaves.instanceMatrix.count);
    const ncOut = Math.min(nc, this.conifers.instanceMatrix.count);
    const nOut = Math.min(n, this.trunks.instanceMatrix.count);

    this.trunks.count = nOut;
    this.leaves.count = nbOut;
    this.conifers.count = ncOut;

    this.trunks.instanceMatrix.needsUpdate = true;
    this.leaves.instanceMatrix.needsUpdate = true;
    this.conifers.instanceMatrix.needsUpdate = true;
    if (this.leaves.instanceColor) this.leaves.instanceColor.needsUpdate = true;
    if (this.conifers.instanceColor) this.conifers.instanceColor.needsUpdate = true;

    this._trees = nOut;
    this._broad = nbOut;
    this._conifer = ncOut;
    this._lastX = camX;
    this._lastZ = camZ;
  }

  dispose() {
    this.trunkGeo.dispose();
    this.trunkMat.dispose();
    this.leafGeo.dispose();
    this.leafMat.dispose();
    this.coniferGeo.dispose();
    this.coniferMat.dispose();
    this.trunks.dispose();
    this.leaves.dispose();
    this.conifers.dispose();
    this.group.removeFromParent();
    if (this.scene && typeof this.scene.remove === 'function') {
      this.scene.remove(this.group);
    }
    this.group.clear();
  }
}