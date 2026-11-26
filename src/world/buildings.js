// Instanced buildings, terrain-hugging street ribbons, street lamps, urban
// ground patches and destructible-building state for every nearby settlement.
//
// Two things matter for the look:
//   - every building is grounded on its four footprint corners (no floating
//     downhill corners on hills),
//   - every street is one continuous ribbon mesh that follows terrainHeight
//     every ~20 m instead of a chain of flat planes.
//
// The class is headless-safe: `new BuildingSystem(null, preset)` skips every
// DOM/WebGL call, so `tests/cities_destruction_test.mjs` can drive applyBlast,
// craters and rubble collapse directly under Node.
import * as THREE from 'three';
import { settlementsNear } from './settlements.js';
import { terrainHeight } from './terrain.js';
import { hash2, clamp } from './noise.js';

const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

const MAX_CRATERS = 64;
const ROAD_SAMPLE_STEP = 20; // metres between terrain samples along a street
const STREET_RANGE = 15000; // ribbons are only built this close to the camera
const STREET_REBUILD_DIST = 1200; // rebuild the ribbon mesh after this much travel

const COLLAPSE_MIN = 2.4; // seconds
const COLLAPSE_SPAN = 1.4; // extra seconds, hashed per building (2.4..3.8 s)

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

const buildingKey = (s, b) => `${s.id}:${Math.round(b.x)}:${Math.round(b.z)}`;

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
function makeBuildingMaterial() {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
        uSunColor: { value: new THREE.Color(0xfff2d8) },
        uAmbient: { value: new THREE.Color(0x334455) },
        uNight: { value: 0 },
      },
    ]),
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec3 vCol;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(instanceMatrix) * normal);
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(0.7);
        #endif
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunColor, uAmbient;
      uniform float uNight;
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec3 vCol;
      #include <common>
      #include <fog_pars_fragment>

      float h21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        vec3 n = normalize(vN);
        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);
        vec3 col = vCol * (uAmbient + uSunColor * (ndl * 0.9 + wrap * 0.14)) + vCol * 0.06;

        float vertical = 1.0 - smoothstep(0.55, 0.85, abs(n.y));
        vec2 wuv = vec2((vWorld.x + vWorld.z) * 0.30, vWorld.y / 3.4);
        vec2 g = fract(wuv);
        float win = step(0.22, g.x) * step(g.x, 0.80) * step(0.30, g.y) * step(g.y, 0.82);
        vec2 cell = floor(wuv);
        float rnd = h21(cell + floor(vCol.xy * 97.0));
        float lit = step(0.55, rnd) * win * vertical;

        vec3 warm = vec3(1.0, 0.66, 0.30);
        col += warm * lit * uNight * 2.6;
        col += vec3(0.10, 0.13, 0.16) * win * vertical * (1.0 - uNight) * 0.7;

        // roofs get a dusty tone
        float roof = smoothstep(0.65, 0.95, abs(n.y));
        col = mix(col, col * vec3(0.72, 0.70, 0.66), roof);

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }
    `,
  });
}

// Asphalt with a dashed centre line and crisp shoulders. RepeatWrapping lets
// one ribbon carry the pattern for its whole length.
function makeStreetTexture() {
  if (!HAS_DOM) return null;
  const W = 64;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#333633';
  ctx.fillRect(0, 0, W, H);
  let a = 987654321;
  const rng = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  for (let i = 0; i < 900; i++) {
    const v = 40 + Math.floor(rng() * 34);
    ctx.fillStyle = `rgba(${v},${v},${v},${0.12 + rng() * 0.3})`;
    ctx.fillRect(rng() * W, rng() * H, 1 + rng() * 5, 1 + rng() * 3);
  }
  ctx.fillStyle = 'rgba(226,216,164,0.7)';
  for (let y = 4; y < H; y += 32) ctx.fillRect(W / 2 - 1.5, y, 3, 15);
  ctx.fillStyle = 'rgba(222,222,212,0.34)';
  ctx.fillRect(3, 0, 1.5, H);
  ctx.fillRect(W - 4.5, 0, 1.5, H);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Mottled urban ground patch with a soft radial edge.
function makeUrbanTexture() {
  if (!HAS_DOM) return null;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#5a5d56';
  ctx.fillRect(0, 0, S, S);
  const rng = (() => { let a = 987654321; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; })();
  for (let i = 0; i < 2600; i++) {
    const v = 62 + Math.floor(rng() * 44);
    ctx.fillStyle = `rgba(${v},${v + 2},${v - 2},${0.1 + rng() * 0.35})`;
    ctx.fillRect(rng() * S, rng() * S, 2 + rng() * 14, 2 + rng() * 10);
  }
  // fade the edge so the patch blends into terrain
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.18, S / 2, S / 2, S * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------------------
// Street ribbons (pure geometry builder, no DOM, no renderer)
// ---------------------------------------------------------------------------
/**
 * Build one continuous terrain-hugging ribbon for every street.
 *
 * `streets` is `[{ x1, z1, x2, z2, width }]` (the Road shape from
 * settlements.js); `heightAt(x, z)` is the ground height sampler.
 *
 * Each street is sampled every `step` metres. Per sample four vertices are
 * emitted: left/right road edges at `heightAt + lift` and the two curb skirts
 * `skirt` metres below them, so no gap can open under the asphalt on a
 * cross-slope. Returns typed arrays ready for a THREE.BufferGeometry plus the
 * number of segments generated.
 */
export function buildStreetRibbonData(streets, heightAt, options = {}) {
  const step = options.step ?? ROAD_SAMPLE_STEP;
  const lane = options.lane ?? 12; // texture repeats per 12 m of road
  const lift = options.lift ?? 0.32;
  const skirt = options.skirt ?? 1.2;

  const prep = [];
  let quads = 0;
  for (const r of streets) {
    if (!r) continue;
    const dx = r.x2 - r.x1;
    const dz = r.z2 - r.z1;
    const l = Math.hypot(dx, dz);
    if (!(l > 0.5) || !(r.width > 0)) continue;
    const n = Math.max(1, Math.ceil(l / step));
    prep.push({ r, dx, dz, l, n, tx: dx / l, tz: dz / l });
    quads += n;
  }

  const vertexCount = (quads + prep.length) * 4;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(quads * 18);

  let vp = 0; // vertex cursor
  let ip = 0; // index cursor
  let segments = 0;

  for (const p of prep) {
    const { r, dx, dz, l, n, tx, tz } = p;
    const rx = -tz; // right-hand perpendicular
    const rz = tx;
    const half = r.width * 0.5;
    const base = vp;

    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const cx = r.x1 + dx * t;
      const cz = r.z1 + dz * t;
      const lx = cx + rx * half;
      const lz = cz + rz * half;
      const qx = cx - rx * half;
      const qz = cz - rz * half;
      const ly = heightAt(lx, lz) + lift;
      const qy = heightAt(qx, qz) + lift;
      const v = (t * l) / lane;

      // 0 top-left, 1 top-right, 2 skirt-left, 3 skirt-right
      positions[vp * 3 + 0] = lx;
      positions[vp * 3 + 1] = ly;
      positions[vp * 3 + 2] = lz;
      positions[vp * 3 + 3] = qx;
      positions[vp * 3 + 4] = qy;
      positions[vp * 3 + 5] = qz;
      positions[vp * 3 + 6] = lx;
      positions[vp * 3 + 7] = ly - skirt;
      positions[vp * 3 + 8] = lz;
      positions[vp * 3 + 9] = qx;
      positions[vp * 3 + 10] = qy - skirt;
      positions[vp * 3 + 11] = qz;
      uvs[vp * 2 + 0] = 0;
      uvs[vp * 2 + 1] = v;
      uvs[vp * 2 + 2] = 1;
      uvs[vp * 2 + 3] = v;
      uvs[vp * 2 + 4] = 0;
      uvs[vp * 2 + 5] = v;
      uvs[vp * 2 + 6] = 1;
      uvs[vp * 2 + 7] = v;
      vp += 4;
    }

    // Normals are analytic: central difference of the sampled edge heights for
    // the asphalt, the plain outward horizontal for each curb skirt. This is
    // far cheaper than a full computeVertexNormals pass on ~100k vertices.
    for (let i = 0; i <= n; i++) {
      const i0 = i > 0 ? i - 1 : 0;
      const i1 = i < n ? i + 1 : n;
      const al = (base + i0 * 4) * 3;
      const ar = (base + i1 * 4) * 3;
      const cl = (base + i * 4) * 3;
      const cr = cl + 3;
      // tangent of the centre line between the neighbouring samples
      const tX = (positions[ar] - positions[al]) * 0.5;
      const tY = (positions[ar + 1] - positions[al + 1]) * 0.5;
      const tZ = (positions[ar + 2] - positions[al + 2]) * 0.5;
      // full width vector, left edge -> right edge
      const wX = positions[cr] - positions[cl];
      const wY = positions[cr + 1] - positions[cl + 1];
      const wZ = positions[cr + 2] - positions[cl + 2];
      // cross(tangent, width) points up for this winding order
      let nX = tY * wZ - tZ * wY;
      let nY = tZ * wX - tX * wZ;
      let nZ = tX * wY - tY * wX;
      if (nY < 0) {
        nX = -nX;
        nY = -nY;
        nZ = -nZ;
      }
      let inv = 1 / (Math.hypot(nX, nY, nZ) || 1);
      normals[cl] = nX * inv;
      normals[cl + 1] = nY * inv;
      normals[cl + 2] = nZ * inv;
      normals[cl + 3] = nX * inv;
      normals[cl + 4] = nY * inv;
      normals[cl + 5] = nZ * inv;
      // curb skirts face straight out of the road
      normals[cl + 6] = rx;
      normals[cl + 7] = 0;
      normals[cl + 8] = rz;
      normals[cl + 9] = -rx;
      normals[cl + 10] = 0;
      normals[cl + 11] = -rz;
    }

    for (let i = 0; i < n; i++) {
      const a = base + i * 4;
      const b = a + 4;
      // asphalt surface (+Y)
      indices[ip++] = a;
      indices[ip++] = b + 1;
      indices[ip++] = a + 1;
      indices[ip++] = a;
      indices[ip++] = b;
      indices[ip++] = b + 1;
      // left curb skirt, facing out of the road
      indices[ip++] = a;
      indices[ip++] = b + 2;
      indices[ip++] = b;
      indices[ip++] = a;
      indices[ip++] = a + 2;
      indices[ip++] = b + 2;
      // right curb skirt
      indices[ip++] = a + 1;
      indices[ip++] = b + 1;
      indices[ip++] = b + 3;
      indices[ip++] = a + 1;
      indices[ip++] = b + 3;
      indices[ip++] = a + 3;
      segments++;
    }
  }

  return {
    positions,
    normals,
    uvs,
    indices,
    segmentCount: segments,
    roadCount: prep.length,
    vertexCount,
  };
}

// ---------------------------------------------------------------------------
// Building system
// ---------------------------------------------------------------------------
export class BuildingSystem {
  constructor(scene, preset) {
    this.scene = scene || null;
    this.preset = preset || {};

    // Destruction state is pure data, so it exists headlessly too.
    this.destroyed = new Set();
    // Buildings that are burning and falling right now: key -> collapse entry
    // ({ key, b, s, minY, topY, height, t, duration, tiltX, tiltZ, seed }).
    // They only join `destroyed` once the animation has played out, which is
    // what makes the collapse smooth instead of an instant snap to rubble.
    this.collapsing = new Map();
    this.craters = [];
    this._cratersDirty = true;
    this._groundCache = new WeakMap();
    this._needsRebuild = true;
    this.stats = { buildings: 0, roads: 0, settlements: 0, lights: 0, destroyed: 0, craters: 0 };

    // Everything below needs a scene; in Node we stop here (headless-safe).
    this.mesh = null;
    this.roadMesh = null;
    this.craterMesh = null;
    this.lightMesh = null;
    this.groundMaterial = null;
    this.grounds = new Map();
    this._groundUse = new Set();
    if (!this.scene) {
      this._lastX = Infinity;
      this._lastZ = Infinity;
      this._lastAlt = Infinity;
      this._colorInit = false;
      return;
    }

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    this.material = makeBuildingMaterial();
    this.mesh = new THREE.InstancedMesh(geo, this.material, this.preset.buildingLimit || 16000);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = 'buildings';
    this.scene.add(this.mesh);

    this.streetTexture = makeStreetTexture();
    this.roadMaterial = new THREE.MeshLambertMaterial({
      color: this.streetTexture ? 0xffffff : 0x30322f,
      map: this.streetTexture || null,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.roadMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.roadMaterial);
    this.roadMesh.frustumCulled = false;
    this.roadMesh.name = 'roads';
    this.roadMesh.visible = false;
    this.scene.add(this.roadMesh);

    const bulbGeo = new THREE.SphereGeometry(0.9, 5, 4);
    this.lightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc46b, toneMapped: false, transparent: true, opacity: 0,
      depthWrite: false,
    });
    this.lightMesh = new THREE.InstancedMesh(bulbGeo, this.lightMaterial, 5000);
    this.lightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lightMesh.frustumCulled = false;
    this.lightMesh.count = 0;
    this.lightMesh.name = 'streetlights';
    this.lightMesh.visible = false;
    this.scene.add(this.lightMesh);

    this.groundMaterial = new THREE.MeshLambertMaterial({
      map: makeUrbanTexture(),
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.craterMaterial = new THREE.MeshLambertMaterial({
      color: 0x26211e,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.craterMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.craterMaterial);
    this.craterMesh.frustumCulled = false;
    this.craterMesh.name = 'craters';
    this.craterMesh.renderOrder = 2;
    this.craterMesh.visible = false;
    this.scene.add(this.craterMesh);

    this._lastX = Infinity;
    this._lastZ = Infinity;
    this._lastAlt = Infinity;
    this._colorInit = false;
  }

  update(dt, camera, sky) {
    // Collapse timers are pure data, so they advance headlessly too and a
    // finished building only then becomes permanent rubble.
    if (this.collapsing.size > 0) {
      const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
      for (const [key, c] of this.collapsing) {
        c.t += step;
        if (c.t >= c.duration) {
          this.collapsing.delete(key);
          this.destroyed.add(key);
        }
      }
      this._needsRebuild = true;
      this.stats.destroyed = this.destroyed.size + this.collapsing.size;
    }

    if (!this.scene || !camera) return;
    if (sky) {
      this.material.uniforms.uSunDir.value.copy(sky.sunDir);
      this.material.uniforms.uSunColor.value.copy(sky.sunColor);
      this.material.uniforms.uAmbient.value.copy(sky.skyColor).multiplyScalar(0.55).addScalar(0.12);
      this.material.uniforms.uNight.value = sky.night;
      this.lightMaterial.opacity = clamp(sky.night * 1.3, 0, 0.95);
      this.lightMesh.visible = sky.night > 0.12 && this.lightMesh.count > 0;
    }

    const dx = camera.position.x - this._lastX;
    const dz = camera.position.z - this._lastZ;
    const dAlt = Math.abs(camera.position.y - this._lastAlt);
    if (dx * dx + dz * dz > 500 * 500 || dAlt > 900 || this._needsRebuild) {
      this.rebuild(camera);
    }
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------
  /**
   * Apply a blast at a world position.
   *
   * `splashRadius` is the lethal radius in metres; buildings whose centre is
   * within `splashRadius + max(w, d) * 0.4` start to burn and collapse. A
   * charred crater is added when `damage >= 40`. Returns the newly hit
   * buildings (`{ destroyedCount, positions }`) so callers can spawn fires,
   * smoke and toasts; the positions are the burning centre of each building.
   */
  applyBlast(position, splashRadius = 30, damage = 100) {
    const px = Number.isFinite(position?.x) ? position.x : 0;
    const pz = Number.isFinite(position?.z) ? position.z : 0;
    const splash = Math.max(1, Number.isFinite(splashRadius) ? splashRadius : 30);
    const result = { destroyedCount: 0, positions: [] };

    if (damage >= 40) {
      const r = clamp(splash * 0.32, 4, 34);
      this.craters.push({ x: px, y: terrainHeight(px, pz), z: pz, r });
      while (this.craters.length > MAX_CRATERS) this.craters.shift();
      this._cratersDirty = true;
    }

    const near = settlementsNear(px, pz, splash + 1600);
    for (const s of near) {
      for (const b of s.buildings) {
        const key = buildingKey(s, b);
        if (this.destroyed.has(key) || this.collapsing.has(key)) continue;
        const reach = splash + Math.max(b.w, b.d) * 0.4;
        const dx = b.x - px;
        const dz = b.z - pz;
        if (dx * dx + dz * dz > reach * reach) continue;

        const g = this._ground(b);
        const minY = g.base;
        const topY = g.top;
        const seed = hash2(Math.round(b.x), Math.round(b.z), 0x2c1b3c6d);
        const h2 = hash2(Math.round(b.z), Math.round(b.x), 0x7f4a7c15);
        const lean = 0.14 + h2 * 0.18; // 0.14..0.32 rad
        // Burning and falling: the building stays standing (and shootable)
        // until the collapse timer runs out in update().
        this.collapsing.set(key, {
          key,
          b,
          s,
          minY,
          topY,
          height: Math.max(1, topY - minY),
          t: 0,
          duration: COLLAPSE_MIN + seed * COLLAPSE_SPAN,
          tiltX: lean * (seed < 0.5 ? -1 : 1),
          tiltZ: lean * (h2 < 0.5 ? -1 : 1),
          seed,
        });

        const baseY = Number.isFinite(b.y) ? b.y : terrainHeight(b.x, b.z);
        result.positions.push({ x: b.x, y: baseY + b.h * 0.45, z: b.z });
      }
    }

    result.destroyedCount = result.positions.length;
    this.stats.destroyed = this.destroyed.size + this.collapsing.size;
    this.stats.craters = this.craters.length;
    if (result.destroyedCount > 0 || damage >= 40) this._needsRebuild = true;
    return result;
  }

  /**
   * First standing building hit by the world-space segment `p0 -> p1`.
   *
   * Exact slab ray/AABB test against each building's rotated footprint and its
   * full height, so ordnance aimed at a tower facade detonates on the wall
   * instead of falling through to the street. Buildings that are already flat
   * rubble are ignored; buildings mid-collapse use their current height.
   * Headless-safe: it only reads deterministic settlement data.
   *
   * Returns `{ x, y, z, t, key, building, settlement }` or `null`.
   */
  hitBuilding(p0, p1) {
    if (!p0 || !p1) return null;
    const ax = p0.x;
    const ay = p0.y;
    const az = p0.z;
    const ex = p1.x - ax;
    const ey = p1.y - ay;
    const ez = p1.z - az;
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
        !Number.isFinite(ex) || !Number.isFinite(ey) || !Number.isFinite(ez)) {
      return null;
    }
    const len2 = ex * ex + ey * ey + ez * ez;
    if (len2 < 1e-9) return null;

    const mx = ax + ex * 0.5;
    const mz = az + ez * 0.5;
    const halfLen = 0.5 * Math.hypot(ex, ez);
    const near = settlementsNear(mx, mz, halfLen + 1600);

    let bestT = 1;
    let best = null;

    for (const s of near) {
      const sdx = s.x - mx;
      const sdz = s.z - mz;
      const sReach = s.radius + halfLen + 60;
      if (sdx * sdx + sdz * sdz > sReach * sReach) continue;

      for (const b of s.buildings) {
        const key = buildingKey(s, b);
        if (this.destroyed.has(key)) continue;

        const g = this._ground(b);
        const minY = g.base;
        let topY = g.top;
        const c = this.collapsing.get(key);
        if (c) {
          const remain = 1 - clamp(c.t / c.duration, 0, 1);
          topY = minY + Math.max(0.5, g.top - minY) * remain;
        }

        // Bounding circle around the segment midpoint rejects most buildings
        // with two multiplies, before the exact slab test.
        const br = Math.hypot(b.w, b.d) * 0.5;
        const bdx = b.x - mx;
        const bdz = b.z - mz;
        const bReach = br + halfLen;
        if (bdx * bdx + bdz * bdz > bReach * bReach) continue;

        // World -> building-local (inverse of rotation.y = rot as addBox uses).
        const cos = Math.cos(b.rot);
        const sin = Math.sin(b.rot);
        const dx0 = ax - b.x;
        const dz0 = az - b.z;
        const oX = dx0 * cos - dz0 * sin;
        const oZ = dx0 * sin + dz0 * cos;
        const dX = ex * cos - ez * sin;
        const dZ = ex * sin + ez * cos;

        const hw = b.w * 0.5;
        const hd = b.d * 0.5;
        let tMin = 0;
        let tMax = 1;

        // X slab
        if (Math.abs(dX) < 1e-9) {
          if (oX < -hw || oX > hw) continue;
        } else {
          let t1 = (-hw - oX) / dX;
          let t2 = (hw - oX) / dX;
          if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
          if (t1 > tMin) tMin = t1;
          if (t2 < tMax) tMax = t2;
          if (tMin > tMax) continue;
        }
        // Y slab
        if (Math.abs(ey) < 1e-9) {
          if (ay < minY || ay > topY) continue;
        } else {
          const inv = 1 / ey;
          let t1 = (minY - ay) * inv;
          let t2 = (topY - ay) * inv;
          if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
          if (t1 > tMin) tMin = t1;
          if (t2 < tMax) tMax = t2;
          if (tMin > tMax) continue;
        }
        // Z slab
        if (Math.abs(dZ) < 1e-9) {
          if (oZ < -hd || oZ > hd) continue;
        } else {
          let t1 = (-hd - oZ) / dZ;
          let t2 = (hd - oZ) / dZ;
          if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
          if (t1 > tMin) tMin = t1;
          if (t2 < tMax) tMax = t2;
          if (tMin > tMax) continue;
        }

        if (tMin < bestT) {
          bestT = tMin;
          best = { key, building: b, settlement: s };
        }
      }
    }

    if (!best) return null;
    return {
      x: ax + ex * bestT,
      y: ay + ey * bestT,
      z: az + ez * bestT,
      t: bestT,
      key: best.key,
      building: best.building,
      settlement: best.settlement,
    };
  }

  /**
   * World-space fire/smoke emitters for every burning, still-falling building.
   * `progress` runs 0 -> 1 across the collapse so VFX can scale the plume.
   */
  getCollapsingFirePoints() {
    const out = [];
    for (const c of this.collapsing.values()) {
      const progress = clamp(c.duration > 0 ? c.t / c.duration : 1, 0, 1);
      out.push({
        x: c.b.x,
        y: c.minY + c.height * 0.45 * (1 - progress),
        z: c.b.z,
        progress,
      });
    }
    return out;
  }

  /** Clear every destroyed building, in-flight collapse and crater (mission reset / respawn). */
  resetDamage() {
    this.destroyed.clear();
    this.collapsing.clear();
    this.craters.length = 0;
    this._cratersDirty = true;
    this._needsRebuild = true;
    this.stats.destroyed = 0;
    this.stats.craters = 0;
  }

  // -------------------------------------------------------------------------
  // Grounding cache: footprint corners never move, so sample them once.
  // -------------------------------------------------------------------------
  _ground(b) {
    let g = this._groundCache.get(b);
    if (g) return g;
    const c = Math.cos(b.rot);
    const s = Math.sin(b.rot);
    const hw = b.w * 0.5;
    const hd = b.d * 0.5;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 4; i++) {
      const su = (i & 1) ? hw : -hw;
      const sv = (i & 2) ? hd : -hd;
      const h = terrainHeight(b.x + su * c - sv * s, b.z + su * s + sv * c);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    g = { base: lo - 1.2, top: hi + b.h, ground: lo };
    this._groundCache.set(b, g);
    return g;
  }

  // -------------------------------------------------------------------------
  // Rebuild the visible set around the camera
  // -------------------------------------------------------------------------
  rebuild(camera) {
    if (!this.scene || !camera) return;
    const alt = Math.max(0, camera.position.y);
    const radius = clamp((this.preset.buildingRadius || 8000) + alt * 5, this.preset.buildingRadius || 8000, 30000);
    const settlements = settlementsNear(camera.position.x, camera.position.z, radius);
    this._groundUse.clear();
    for (const s of settlements) {
      if (s.type === 'metro' || s.type === 'town') {
        this._ensureGround(s);
        this._groundUse.add(s.id);
      }
    }
    for (const [id, mesh] of this.grounds) {
      if (this._groundUse.has(id)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.grounds.delete(id);
    }

    let n = 0;
    let ln = 0;
    let colorDirty = false;

    const limit = this.preset.buildingLimit || 16000;
    const lightLimit = this.lightMesh.instanceMatrix.count;

    const addBox = (x, baseY, z, w, h, d, rot, color, tiltX = 0, tiltZ = 0) => {
      if (n >= limit || !(h > 0) || !(w > 0) || !(d > 0)) return false;
      _p.set(x, baseY, z);
      _e.set(tiltX, rot || 0, tiltZ);
      _q.setFromEuler(_e);
      _s.set(w, h, d);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(n, _m);
      _c.setHex(color).convertSRGBToLinear();
      this.mesh.setColorAt(n, _c);
      n++;
      colorDirty = true;
      return true;
    };

    for (const s of settlements) {
      for (const b of s.buildings) {
        if (n >= limit) break;
        const g = this._ground(b);
        const key = buildingKey(s, b);
        if (this.destroyed.has(key)) {
          // Collapsed shell: low charred rubble instead of a tower.
          const rubble = 1.6 + hash2(Math.round(b.x), Math.round(b.z), 0x5bd1e995) * 1.6;
          addBox(b.x, g.base, b.z, b.w * 0.82, rubble, b.d * 0.82, b.rot + 0.12, 0x22201e);
          addBox(
            b.x + (hash2(Math.round(b.x), Math.round(b.z), 0x1b56c4e9) - 0.5) * b.w * 0.5,
            g.base,
            b.z + (hash2(Math.round(b.z), Math.round(b.x), 0x2545f491) - 0.5) * b.d * 0.5,
            b.w * 0.42, rubble * 0.55, b.d * 0.42, b.rot - 0.3, 0x2c2724,
          );
          continue;
        }
        const c = this.collapsing.get(key);
        if (c) {
          this._addCollapse(addBox, b, g, c);
          continue;
        }
        this._addSilhouette(addBox, b, g.base, g.top);
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    // Streets: one ribbon mesh for every settlement road in range. Distant
    // roads are sub-pixel, so they are culled, and the ribbon is only rebuilt
    // when the camera has moved far enough to matter (it is expensive).
    let roadCount = 0;
    if (this.preset.roadDetail) {
      const streets = [];
      for (const s of settlements) {
        const sdx = s.x - camera.position.x;
        const sdz = s.z - camera.position.z;
        const reach = STREET_RANGE + s.radius;
        if (sdx * sdx + sdz * sdz > reach * reach) continue;
        for (const r of s.roads) streets.push(r);
      }
      roadCount = streets.length;
      const hasRibbon = !!this.roadMesh.geometry.attributes.position;
      const mdx = camera.position.x - (this._streetX ?? Infinity);
      const mdz = camera.position.z - (this._streetZ ?? Infinity);
      if (!hasRibbon || mdx * mdx + mdz * mdz > STREET_REBUILD_DIST * STREET_REBUILD_DIST) {
        this._rebuildStreetRibbons(streets);
        this._streetX = camera.position.x;
        this._streetZ = camera.position.z;
      }
      for (const r of streets) {
        const dx = r.x2 - r.x1;
        const dz = r.z2 - r.z1;
        const len = Math.hypot(dx, dz);
        if (len < 40) continue;
        const count = Math.floor(len / 170);
        for (let k = 0; k < count && ln < lightLimit; k++) {
          const t = (k + 0.5) / count;
          const mx = r.x1 + dx * t;
          const mz = r.z1 + dz * t;
          const side = (k % 2 === 0) ? 1 : -1;
          const nx = -dz / len;
          const nz = dx / len;
          const lx = mx + nx * (r.width * 0.5 + 4.5) * side;
          const lz = mz + nz * (r.width * 0.5 + 4.5) * side;
          _p.set(lx, terrainHeight(lx, lz) + 6.2, lz);
          _e.set(0, 0, 0);
          _q.setFromEuler(_e);
          _s.set(1.4, 1.4, 1.4);
          _m.compose(_p, _q, _s);
          this.lightMesh.setMatrixAt(ln++, _m);
        }
      }
    } else {
      this.roadMesh.visible = false;
    }

    this.lightMesh.count = ln;
    this.lightMesh.instanceMatrix.needsUpdate = true;

    if (this._cratersDirty) this._rebuildCraters();

    this._lastX = camera.position.x;
    this._lastZ = camera.position.z;
    this._lastAlt = camera.position.y;
    this._needsRebuild = false;
    this.stats.buildings = n;
    this.stats.roads = roadCount;
    this.stats.settlements = settlements.length;
    this.stats.lights = ln;
    this.stats.destroyed = this.destroyed.size + this.collapsing.size;
    this.stats.craters = this.craters.length;
  }

  // Ground floor `base` -> `top` boxes for one building, per kind.
  _addSilhouette(addBox, b, base, top) {
    const h = top - base;
    const dark = shade(b.color, 0.72);
    switch (b.kind) {
      case 'tower': {
        // Wide podium, main shaft, stepped crown, plant room, spire.
        const podiumH = Math.min(h * 0.16, h - 2);
        addBox(b.x, base, b.z, b.w * 1.12, podiumH, b.d * 1.12, b.rot, b.color);
        addBox(b.x, base + podiumH, b.z, b.w, h - podiumH, b.d, b.rot, b.color);
        const crownH = Math.min(12, Math.max(2.5, h * 0.12));
        const cw = b.w * 0.72;
        const cd = b.d * 0.72;
        addBox(b.x, top, b.z, cw, crownH, cd, b.rot, b.color);
        addBox(b.x, top + crownH, b.z, cw * 0.34, 2.6, cd * 0.34, b.rot + 0.2, 0x545a5c);
        if (b.h > 75) {
          addBox(b.x, top + crownH + 2.6, b.z, 0.8, Math.min(14, b.h * 0.1), 0.8, b.rot, 0x6b7072);
        }
        break;
      }
      case 'apartment': {
        addBox(b.x, base, b.z, b.w, h, b.d, b.rot, b.color);
        // Rooftop parapet / utility penthouse.
        addBox(b.x, top, b.z, b.w * 0.82, Math.min(2.2, Math.max(1, h * 0.05)), b.d * 0.82, b.rot, shade(b.color, 0.85));
        break;
      }
      case 'industrial': {
        addBox(b.x, base, b.z, b.w, h, b.d, b.rot, b.color);
        // Clerestory roof monitor running the length of the hall.
        addBox(b.x, top, b.z, b.w * 0.42, 1.6, b.d * 0.88, b.rot, 0x6f736e);
        break;
      }
      case 'shed': {
        addBox(b.x, base, b.z, b.w, h, b.d, b.rot, b.color);
        addBox(b.x, top, b.z, b.w * 0.94, 0.7, b.d * 0.94, b.rot, dark);
        break;
      }
      default: {
        // house / shop: main block plus a darker stepped roof cap.
        addBox(b.x, base, b.z, b.w, h, b.d, b.rot, b.color);
        addBox(b.x, top, b.z, b.w * 0.88, 1.1, b.d * 0.88, b.rot, dark);
      }
    }
  }

  // Live burn & collapse: the same footprint leans, shakes, shrinks and turns
  // from fire orange through ember red into charred black as `c.t` advances.
  _addCollapse(addBox, b, g, c) {
    const p = clamp(c.duration > 0 ? c.t / c.duration : 1, 0, 1);
    const eased = p * p * (3 - 2 * p);
    const h = (g.top - g.base) * (1 - eased);
    if (h < 0.6) return;
    const wobble = Math.sin(p * Math.PI) * (1 - p * 0.55);
    const shakeX = Math.sin(c.t * 9.5 + c.seed * 31.4) * 0.9 * wobble;
    const shakeZ = Math.cos(c.t * 11.7 + c.seed * 17.9) * 0.9 * wobble;
    const lean = Math.min(1, p * 1.5);
    const color = p < 0.35 ? 0xff6a1a : p < 0.75 ? 0xb8350c : 0x22201e;

    addBox(
      b.x + shakeX, g.base, b.z + shakeZ,
      b.w, h, b.d, b.rot, color,
      c.tiltX * lean, c.tiltZ * lean,
    );

    // Once it is properly coming down, a second broken slab shears off and
    // slides outwards so the silhouette is not just a shrinking prism.
    if (p > 0.35) {
      const fall = (p - 0.35) / 0.65;
      addBox(
        b.x + shakeX - c.tiltX * b.w * 1.6 * fall,
        g.base,
        b.z + shakeZ + c.tiltZ * b.d * 1.6 * fall,
        b.w * 0.55, h * 0.5, b.d * 0.55,
        b.rot + 0.45 * fall,
        p < 0.75 ? 0x6d2a10 : 0x2c2724,
        c.tiltX * lean * 1.5, c.tiltZ * lean * 1.5,
      );
    }
  }

  _rebuildStreetRibbons(streets) {
    const data = buildStreetRibbonData(streets, terrainHeight);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.computeBoundingSphere();
    this.roadMesh.geometry.dispose();
    this.roadMesh.geometry = geo;
    this.roadMesh.visible = data.segmentCount > 0;
    this.stats.streetSegments = data.segmentCount;
  }

  // Charred crater discs, draped on the terrain in one merged mesh.
  _rebuildCraters() {
    this._cratersDirty = false;
    if (!this.craterMesh) return;
    const RINGS = 16;
    const INNER = 10;
    const pos = [];
    const idx = [];
    for (const c of this.craters) {
      const base = pos.length / 3;
      const ground = Number.isFinite(c.y) ? c.y : terrainHeight(c.x, c.z);
      pos.push(c.x, ground - 0.55, c.z); // 0: bowl centre
      for (let i = 0; i < INNER; i++) {
        const a = (i / INNER) * Math.PI * 2;
        const rr = c.r * 0.55;
        const x = c.x + Math.cos(a) * rr;
        const z = c.z + Math.sin(a) * rr;
        pos.push(x, terrainHeight(x, z) - 0.25, z);
      }
      for (let i = 0; i < RINGS; i++) {
        const a = (i / RINGS) * Math.PI * 2;
        const x = c.x + Math.cos(a) * c.r;
        const z = c.z + Math.sin(a) * c.r;
        pos.push(x, terrainHeight(x, z) + 0.06, z);
      }
      const inner0 = base + 1;
      const outer0 = base + 1 + INNER;
      for (let i = 0; i < INNER; i++) {
        const i0 = inner0 + i;
        const i1 = inner0 + ((i + 1) % INNER);
        idx.push(base, i0, i1);
      }
      for (let i = 0; i < RINGS; i++) {
        const o0 = outer0 + i;
        const o1 = outer0 + ((i + 1) % RINGS);
        const i0 = inner0 + (i % INNER);
        const i1 = inner0 + ((i + 1) % INNER);
        idx.push(i0, o0, o1);
        idx.push(i0, o1, i1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.craterMesh.geometry.dispose();
    this.craterMesh.geometry = geo;
    this.craterMesh.visible = this.craters.length > 0;
    this.stats.craters = this.craters.length;
  }

  _ensureGround(s) {
    if (this.grounds.has(s.id)) return this.grounds.get(s.id);
    const geo = new THREE.CircleGeometry(s.radius * 1.14, 36);
    geo.rotateX(-Math.PI / 2);
    const baseY = terrainHeight(s.x, s.z);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = s.x + pos.getX(i);
      const wz = s.z + pos.getZ(i);
      pos.setY(i, terrainHeight(wx, wz) - baseY + 0.16);
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.groundMaterial);
    mesh.position.set(s.x, baseY, s.z);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.grounds.set(s.id, mesh);
    return mesh;
  }

  dispose() {
    for (const g of this.grounds.values()) {
      this.scene.remove(g);
      g.geometry.dispose();
    }
    this.grounds.clear();
    if (!this.scene) return;
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.roadMesh.geometry.dispose();
    this.roadMaterial.dispose();
    this.streetTexture?.dispose();
    this.lightMesh.geometry.dispose();
    this.lightMaterial.dispose();
    this.craterMesh.geometry.dispose();
    this.craterMaterial.dispose();
    this.groundMaterial.map?.dispose();
    this.groundMaterial.dispose();
    this.mesh.removeFromParent();
    this.roadMesh.removeFromParent();
    this.lightMesh.removeFromParent();
    this.craterMesh.removeFromParent();
  }
}

// Multiply an sRGB hex towards black for roof caps.
function shade(hex, k) {
  const r = clamp(Math.round(((hex >> 16) & 0xff) * k), 0, 255);
  const g = clamp(Math.round(((hex >> 8) & 0xff) * k), 0, 255);
  const b = clamp(Math.round((hex & 0xff) * k), 0, 255);
  return (r << 16) | (g << 8) | b;
}