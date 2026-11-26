// Quadtree LOD terrain renderer + ocean surface.
import * as THREE from 'three';
import { terrainHeight, SEA_LEVEL } from './terrain.js';
import { fbm01, smoothstep, hash2, clamp } from './noise.js';
import { CONFIG } from '../config.js';

const _cam = new THREE.Vector3();

const PALETTES = {
  temperate: {
    sand: new THREE.Color(0xd9c69c).convertSRGBToLinear(),
    grassLow: new THREE.Color(0x86a05e).convertSRGBToLinear(),
    grassHigh: new THREE.Color(0xa7b874).convertSRGBToLinear(),
    forest: new THREE.Color(0x4a6b3d).convertSRGBToLinear(),
    rock: new THREE.Color(0x8a8377).convertSRGBToLinear(),
    rockDark: new THREE.Color(0x67625a).convertSRGBToLinear(),
    snow: new THREE.Color(0xf2f5f6).convertSRGBToLinear(),
    dirt: new THREE.Color(0xa18b64).convertSRGBToLinear(),
    seabed: new THREE.Color(0x30473f).convertSRGBToLinear(),
    snowLineBase: 1280,
  },
  desert: {
    sand: new THREE.Color(0xd8b989).convertSRGBToLinear(),
    grassLow: new THREE.Color(0xc9a36f).convertSRGBToLinear(),
    grassHigh: new THREE.Color(0xb88b58).convertSRGBToLinear(),
    forest: new THREE.Color(0x6e7346).convertSRGBToLinear(), // dry scrub / river oases
    rock: new THREE.Color(0x9a7756).convertSRGBToLinear(),
    rockDark: new THREE.Color(0x745842).convertSRGBToLinear(),
    snow: new THREE.Color(0xd9c3a5).convertSRGBToLinear(),   // pale arid limestone peaks
    dirt: new THREE.Color(0xa87c4f).convertSRGBToLinear(),
    seabed: new THREE.Color(0x3a524a).convertSRGBToLinear(),
    snowLineBase: 1650,
  },
  // Vipava Valley / Slovenian Karst: vineyard greens, pale limestone cliffs,
  // alpine spruce on the high plateaus, deep Adriatic blue water.
  vipava: {
    sand: new THREE.Color(0xd7c49b).convertSRGBToLinear(),
    grassLow: new THREE.Color(0x7f9b52).convertSRGBToLinear(),  // vineyard valley floor
    grassHigh: new THREE.Color(0x9db56b).convertSRGBToLinear(),
    forest: new THREE.Color(0x3c5a35).convertSRGBToLinear(),    // alpine spruce
    rock: new THREE.Color(0xbdb6a4).convertSRGBToLinear(),      // pale Karst limestone
    rockDark: new THREE.Color(0x8d8778).convertSRGBToLinear(),
    snow: new THREE.Color(0xeef2ee).convertSRGBToLinear(),
    dirt: new THREE.Color(0xa8956e).convertSRGBToLinear(),
    seabed: new THREE.Color(0x24475b).convertSRGBToLinear(),
    snowLineBase: 1550,
    forestMix: 0.85,
    dryMix: 0.28,
    waterDeep: 0x0d3a5f,
    waterShallow: 0x2f7f9c,
  },
};

function distanceToRect(px, pz, x, z, size) {
  const dx = Math.max(x - px, 0, px - (x + size));
  const dz = Math.max(z - pz, 0, pz - (z + size));
  return Math.hypot(dx, dz);
}

function vertexColor(h, slope, x, z, out, pal = PALETTES.temperate) {
  const n = fbm01(x * 0.00042, z * 0.00042, 3, 881);
  const fine = hash2(Math.floor(x * 0.05), Math.floor(z * 0.05), 71);
  const snowLine = pal.snowLineBase + fbm01(x * 0.0006, z * 0.0009, 2, 991) * 260;

  if (h < -1) {
    out.copy(pal.seabed);
  } else if (h < 2.4) {
    out.copy(pal.sand);
  } else {
    out.copy(pal.grassLow).lerp(pal.grassHigh, n);
    // forest / irrigated oasis patches
    const forest = smoothstep(0.52, 0.74, fbm01(x * 0.0011, z * 0.0011, 3, 1201));
    const forestMix = pal.forestMix ?? (pal === PALETTES.desert ? 0.35 : 0.8);
    if (slope < 0.55) out.lerp(pal.forest, forest * forestMix);
    // dry / dirt in low flat basins
    const dry = smoothstep(0.62, 0.84, fbm01(x * 0.00022, z * 0.00022, 2, 1311));
    const dryMix = pal.dryMix ?? (pal === PALETTES.desert ? 0.55 : 0.35);
    out.lerp(pal.dirt, dry * dryMix);
  }

  // rock on steep slopes
  const rockT = smoothstep(0.38, 0.72, slope);
  if (h > 1) out.lerp(pal.rock, rockT * 0.92);
  // high altitude rock then snow/limestone
  if (h > 700) {
    out.lerp(pal.rockDark, smoothstep(700, 1150, h) * 0.65);
    out.lerp(pal.snow, smoothstep(snowLine, snowLine + 320, h) * (1 - clamp((slope - 0.7) * 1.6, 0, 1)));
  }
  // subtle per-vertex tonal noise
  const v = 0.9 + fine * 0.2;
  out.multiplyScalar(v);
  return out;
}

export class TerrainView {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.scene.add(this.group);

    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      emissive: 0x0a1008,
      emissiveIntensity: 0.45,
    });

    this.tiles = new Map();       // key -> mesh
    this._stale = new Set();      // keys kept alive until LOD replacements build
    this.pending = [];            // nodes waiting for geometry
    this.leaves = [];
    this.lastBuildX = Infinity;
    this.lastBuildZ = Infinity;
    this.timeSinceRebuild = 0;
    this.tilesBuilt = 0;
    this.water = new WaterSurface(this.scene);
    this._lastUpdate = 0;

    this._leafPool = [];
    this.theater = 'temperate';
  }

  setTheater(name) {
    const next = PALETTES[name] ? name : 'temperate';
    if (next === this.theater) return;
    this.theater = next;
    this.water.setPalette(PALETTES[next]);
    // Drop every cached tile so terrain repaints cleanly in the new palette:
    // no old-LOD geometry survives to overlap the rebuilt quadtree.
    this._clearTiles();
    this.lastBuildX = Infinity;
    this.lastBuildZ = Infinity;
  }

  /** Force a rebuild of the visible quadtree (used at boot and on teleport). */
  refresh(center, immediate = 0) {
    // A refresh means the height field under us changed; stale LODs kept for
    // streaming continuity would now overlap the new tiles, so clear first.
    this._clearTiles();
    this._rebuild(center);
    if (immediate > 0) this._buildPending(immediate);
  }

  /** Remove every tile mesh and its GPU geometry, resetting streaming state. */
  _clearTiles() {
    for (const mesh of this.tiles.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.tiles.clear();
    this._stale.clear();
    this.pending.length = 0;
  }

  _rebuild(center) {
    const camX = center.x;
    const camZ = center.z;
    const ROOT = CONFIG.world.terrainRootSize;
    const half = ROOT * 0.5;
    const baseX = Math.floor((camX - half) / ROOT) * ROOT;
    const baseZ = Math.floor((camZ - half) / ROOT) * ROOT;
    const leaves = [];
    const maxLevel = CONFIG.world.terrainMaxLevel;
    const minSize = CONFIG.world.terrainMinSize;
    const factor = CONFIG.world.terrainDetailDistance;

    const visit = (x, z, size, level) => {
      const d = distanceToRect(camX, camZ, x, z, size);
      if (level < maxLevel && size > minSize && d < size * factor) {
        const h = size * 0.5;
        visit(x, z, h, level + 1);
        visit(x + h, z, h, level + 1);
        visit(x, z + h, h, level + 1);
        visit(x + h, z + h, h, level + 1);
        return;
      }
      // cull very distant corners
      if (d > 52000) return;
      leaves.push({ x, z, size, level });
    };

    visit(baseX, baseZ, ROOT, 0);
    visit(baseX + ROOT, baseZ, ROOT, 0);
    visit(baseX, baseZ + ROOT, ROOT, 0);
    visit(baseX + ROOT, baseZ + ROOT, ROOT, 0);

    this.leaves = leaves;
    const activeKeys = new Set(leaves.map((l) => l.level + ':' + l.x + ':' + l.z));

    // Keep meshes that are no longer visible until their LOD replacements are
    // built, otherwise fast flight shows rectangular holes at tile boundaries.
    for (const key of activeKeys) this._stale.delete(key);
    for (const [key] of this.tiles) {
      if (!activeKeys.has(key)) this._stale.add(key);
    }

    // queue missing leaves, nearest first
    this.pending.length = 0;
    for (const leaf of leaves) {
      const key = leaf.level + ':' + leaf.x + ':' + leaf.z;
      if (this.tiles.has(key)) continue;
      leaf.key = key;
      leaf.dist = distanceToRect(camX, camZ, leaf.x, leaf.z, leaf.size);
      this.pending.push(leaf);
    }
    this.pending.sort((a, b) => a.dist - b.dist);
    this.lastBuildX = camX;
    this.lastBuildZ = camZ;
  }

  _buildPending(budgetTiles = 4) {
    let built = 0;
    while (this.pending.length && built < budgetTiles) {
      const node = this.pending.shift();
      if (this.tiles.has(node.key)) continue;
      const mesh = this._buildTile(node);
      this.tiles.set(node.key, mesh);
      this.group.add(mesh);
      built++;
    }
    return built;
  }

  _buildTile(node) {
    const { x, z, size, level } = node;
    const segs = level >= 6 ? this.preset.segmentsNear
      : level >= 3 ? 28 : this.preset.segmentsFar;
    const N = segs + 1;
    const step = size / segs;

    // heights including one sample border for normals
    const H = new Float32Array((N + 2) * (N + 2));
    for (let j = -1; j <= segs + 1; j++) {
      for (let i = -1; i <= segs + 1; i++) {
        H[(j + 1) * (N + 2) + (i + 1)] = terrainHeight(x + i * step, z + j * step);
      }
    }
    const hAt = (i, j) => H[(j + 1) * (N + 2) + (i + 1)];

    const skirtDepth = Math.max(40, Math.min(size * 0.12, 900));
    const mainCount = N * N;
    const skirtCount = 4 * N;
    const total = mainCount + skirtCount;

    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    const color = new THREE.Color();

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const wx = x + i * step;
        const wz = z + j * step;
        const h = hAt(i, j);
        positions[idx * 3] = wx;
        positions[idx * 3 + 1] = h;
        positions[idx * 3 + 2] = wz;

        const dx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * step);
        const dz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * step);
        const inv = 1 / Math.hypot(dx, 1, dz);
        normals[idx * 3] = -dx * inv;
        normals[idx * 3 + 1] = inv;
        normals[idx * 3 + 2] = -dz * inv;

        const slope = Math.hypot(dx, dz);
        vertexColor(h, slope, wx, wz, color, PALETTES[this.theater] || PALETTES.temperate);
        colors[idx * 3] = color.r;
        colors[idx * 3 + 1] = color.g;
        colors[idx * 3 + 2] = color.b;
      }
    }

    // skirts around the four edges
    let vi = mainCount;
    const addSkirt = (getI, getJ, outward) => {
      for (let k = 0; k < N; k++) {
        const i = getI(k);
        const j = getJ(k);
        const src = j * N + i;
        positions[vi * 3] = positions[src * 3];
        positions[vi * 3 + 1] = positions[src * 3 + 1] - skirtDepth;
        positions[vi * 3 + 2] = positions[src * 3 + 2];
        normals[vi * 3] = normals[src * 3];
        normals[vi * 3 + 1] = normals[src * 3 + 1];
        normals[vi * 3 + 2] = normals[src * 3 + 2];
        colors[vi * 3] = colors[src * 3] * 0.55;
        colors[vi * 3 + 1] = colors[src * 3 + 1] * 0.55;
        colors[vi * 3 + 2] = colors[src * 3 + 2] * 0.55;
        vi++;
      }
    };
    addSkirt((k) => k, () => 0, 0);
    addSkirt((k) => k, () => N - 1, 0);
    addSkirt(() => 0, (k) => k, 0);
    addSkirt(() => N - 1, (k) => k, 0);

    const indices = [];
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * N + i;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    // skirt faces
    const edgeStart = [0, (N - 1) * N, 0, N - 1]; // top row, bottom row, left col, right col
    for (let e = 0; e < 4; e++) {
      const s = mainCount + e * N;
      for (let k = 0; k < N - 1; k++) {
        // find main-grid partners for skirt index k
        let m0, m1;
        if (e === 0) { m0 = k; m1 = k + 1; }
        else if (e === 1) { m0 = (N - 1) * N + k; m1 = m0 + 1; }
        else if (e === 2) { m0 = k * N; m1 = (k + 1) * N; }
        else { m0 = k * N + N - 1; m1 = (k + 1) * N + N - 1; }
        indices.push(m0, s + k, m1, m1, s + k, s + k + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += skirtDepth;

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'tile-' + node.key;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData = { level, size };
    this.tilesBuilt++;
    return mesh;
  }

  update(dt, camera) {
    _cam.copy(camera.position);
    this.timeSinceRebuild += dt;
    const moved = Math.hypot(_cam.x - this.lastBuildX, _cam.z - this.lastBuildZ);

    if (moved > 96 || this.lastBuildX === Infinity) {
      this._rebuild(_cam);
    }
    if (this.pending.length) {
      // more budget while at altitude or during boot
      const budget = this.lastBuildX === Infinity ? 20 : (_cam.y > 3000 ? 8 : 4);
      this._buildPending(budget);
    }
    if (!this.pending.length && this._stale.size) {
      for (const key of this._stale) {
        const mesh = this.tiles.get(key);
        if (!mesh) continue;
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.tiles.delete(key);
      }
      this._stale.clear();
    }
    this.water.update(dt, camera);
  }

  setAtmosphere(sunDir, sunColor, skyColor) {
    this.water.setAtmosphere(sunDir, sunColor, skyColor);
  }

  dispose() {
    for (const mesh of this.tiles.values()) mesh.geometry.dispose();
    this.tiles.clear();
    this.group.removeFromParent();
    this.material.dispose();
    this.water.dispose();
  }
}

// ---------------------------------------------------------------------------
// Ocean
// ---------------------------------------------------------------------------
class WaterSurface {
  constructor(scene) {
    this.scene = scene;
    const geo = new THREE.PlaneGeometry(CONFIG.world.waterSize, CONFIG.world.waterSize, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.2) },
        uSunColor: { value: new THREE.Color(0xfff2d0) },
        uSkyColor: { value: new THREE.Color(0x8fb4c8) },
        uDeep: { value: new THREE.Color(0x143c4a).convertSRGBToLinear() },
        uShallow: { value: new THREE.Color(0x2f7383).convertSRGBToLinear() },
        fogColor: { value: new THREE.Color(0x9fb9c9) },
        fogDensity: { value: 0.00002 },
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uSunDir, uSunColor, uSkyColor, uDeep, uShallow;
        varying vec3 vWorld;
        #include <common>
        #include <fog_pars_fragment>
        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float t = uTime;
          vec2 p = vWorld.xz;
          // Kill wave/specular detail with distance so the far Adriatic reads as
          // a smooth plate: no sub-pixel normal jitter, hence no horizon shimmer.
          float distFade = 1.0 - smoothstep(3500.0, 24000.0, length(vWorld.xz - cameraPosition.xz));
          float w1 = sin(p.x * 0.045 + t * 0.7) * cos(p.y * 0.052 - t * 0.55);
          float w2 = sin(p.x * 0.011 - t * 0.23 + p.y * 0.017) * 0.8;
          float w3 = sin((p.x + p.y) * 0.19 + t * 1.4) * 0.25;
          vec3 n = normalize(vec3((w1 * 0.16 + w3 * 0.05) * distFade, 1.0, (w2 * 0.16 + w3 * 0.05) * distFade));
          float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.2);
          vec3 col = mix(uDeep, uShallow, 0.35 + 0.25 * w2);
          col = mix(col, uSkyColor, clamp(fres * 0.7, 0.0, 0.75));
          vec3 r = reflect(-uSunDir, n);
          float spec = pow(max(dot(r, viewDir), 0.0), 120.0);
          float sparkle = pow(max(dot(r, viewDir), 0.0), 18.0) * 0.12;
          col += uSunColor * (spec * 1.4 + sparkle) * distFade;
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }
      `,
      fog: true,
      // Push the sea plane behind any low-lying coastal terrain sharing y=0.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = SEA_LEVEL;
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  setAtmosphere(sunDir, sunColor, skyColor) {
    this.material.uniforms.uSunDir.value.copy(sunDir);
    this.material.uniforms.uSunColor.value.copy(sunColor);
    this.material.uniforms.uSkyColor.value.copy(skyColor);
  }

  /** Theater water tint; falls back to the temperate defaults. */
  setPalette(pal = null) {
    const u = this.material.uniforms;
    u.uDeep.value.copy(new THREE.Color(pal?.waterDeep ?? 0x143c4a).convertSRGBToLinear());
    u.uShallow.value.copy(new THREE.Color(pal?.waterShallow ?? 0x2f7383).convertSRGBToLinear());
  }

  update(dt, camera) {
    this.material.uniforms.uTime.value += dt;
    const snap = 4000;
    this.mesh.position.x = Math.round(camera.position.x / snap) * snap;
    this.mesh.position.z = Math.round(camera.position.z / snap) * snap;
    const fog = this.mesh.material.uniforms;
    if (this.scene?.fog) {
      fog.fogColor.value.copy(this.scene.fog.color);
      fog.fogDensity.value = this.scene.fog.density;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}