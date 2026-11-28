// Dense, organic instanced forests for the Primorska / Vipava valley.
//
// Five draw calls total, split into a near ring and a far ring so only the
// trees inside the sun shadow box pay for the shadow pass:
//   1. trunks       — tapered bark cylinders, near trees only
//   2. leavesNear   — merged/welded 4-lobe broadleaf canopy (320 tris, <=168 verts)
//   3. leavesFar    — welded low-poly 4-lobe broadleaf canopy (80 tris)
//   4. conifersNear — merged 3-tier conifer canopy (Mediterranean pine / spruce)
//   5. conifersFar  — same conifer geometry, no shadows
//
// Canopy geometries bake a soft bottom-to-top ambient-occlusion gradient into
// their vertex colours; per-tree instance colours tint the whole crown. The
// renderer runs ACESFilmic + sRGB output, so palette hexes are converted to
// linear before upload (linear ~0.04..0.14 => realistic dark forest greens).
//
// Headless-safe: no document/window access, `scene` may be null or a plain
// { add, remove } stub, and every emitted index is clamped to its pool.
//
// Stability: `rebuild()` walks cells nearest-first on a smooth score (distance,
// plus an out-of-FOV penalty behind the camera) and cuts off at `treeLimit`
// inside a single 75 m bucket, so the emitted forest is a stable disc/teardrop
// around the camera. Moving the camera adds trees at the leading rim and drops
// them at the trailing rim instead of re-shuffling the whole neighborhood.
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { terrainHeight, slopeAt, airportNear, getActiveDEM, getCustomAirports } from './terrain.js';
import { hash2, mulberry32, clamp, smoothstep, fbm01 } from './noise.js';

// Trees within this horizontal distance of the camera land in a near pool and
// keep their shadow + trunk; everything further away gets the far LOD. 2,400 m
// covers the sun shadow box corner (1,980 m) plus most of the 360 m rebuild
// step (PERF-01).
export const VEG_NEAR_R = 2400;

// Per-cell sampling grid (PKT-11). Cell content is a pure function of `(cx, cz)`
// on this spacing, which is what makes the cache in `_cellCache` exact.
export const VEG_CELL = 95;

// Hard bound on the deterministic per-cell cache. A walk covers about 20,500
// cells, and the radius prune below keeps the steady-state set near the streamed
// neighborhood, so this only bites on very long teleports.
export const MAX_CELL_CACHE = 40000;

// Per-tree cache payload, packed into one Float32Array:
//   [0] dx (cell-relative)   [1] dz (cell-relative)   [2] y
//   [3] crownY               [4] trunkH               [5] trunk thickness
//   [6] crownH               [7] crownW               [8] rotation
//   [9] species (1 conifer)  [10..12] linear rgb
// Positions are stored relative to the cell centre so Float32 keeps sub-mm
// precision; the instance matrices themselves are Float32 anyway.
const TREE_STRIDE = 13;

// Collision-free signed cell key: `(cx, cz)` are biased into [0, 2^21) and
// packed into one safe integer (exact while |cx|, |cz| < 2^20 cells ~ 99,600 km).
const CELL_KEY_BIAS = 1 << 20;
const CELL_KEY_SPAN = 1 << 21;

function cellKey(cx, cz) {
  return (cx + CELL_KEY_BIAS) * CELL_KEY_SPAN + (cz + CELL_KEY_BIAS);
}

function cellKeyX(key) {
  return Math.floor(key / CELL_KEY_SPAN) - CELL_KEY_BIAS;
}

function cellKeyZ(key) {
  const cx = Math.floor(key / CELL_KEY_SPAN);
  return key - cx * CELL_KEY_SPAN - CELL_KEY_BIAS;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _fwd = new THREE.Vector3();

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
function makeBroadleafLobe(radius, seed, ox, oy, oz, detail = 1) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
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

/** Normalise a merged crown: unit height, base sitting on y = 0. */
function normaliseCrown(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const height = Math.max(1e-4, bb.max.y - bb.min.y);
  geo.scale(1 / height, 1 / height, 1 / height);
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  return geo;
}

/** Weld duplicate (non-indexed) vertices. PolyhedronGeometry emits 3 vertices
 *  per triangle with only position/normal/colour depending on the vertex
 *  itself, so welding is lossless and lets the post-transform cache reuse
 *  vertices (PERF-02). */
function weldCrown(geo) {
  const welded = mergeVertices(geo);
  geo.dispose();
  welded.computeBoundingSphere();
  return welded;
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

  normaliseCrown(geo);
  paintCanopyAO(geo, 0.58, 1.08);
  // 4 x 240 non-indexed vertices -> 4 x 42 unique ones (<= 168), 320 tris.
  return weldCrown(geo);
}

/** Far broadleaf crown: the same 4 lobes at detail 0 (20 triangles each, 80 per
 *  crown). At 2.4 km a 12 m crown is only a few pixels wide, so the near
 *  silhouette detail is invisible (PERF-05). */
function makeBroadleafCanopyFar() {
  const parts = [
    makeBroadleafLobe(0.72, 0.7, 0.00, 0.66, 0.00, 0), // central crown
    makeBroadleafLobe(0.56, 2.1, 0.52, 0.48, 0.18, 0), // right shoulder
    makeBroadleafLobe(0.54, 3.7, -0.44, 0.52, -0.30, 0), // left shoulder
    makeBroadleafLobe(0.46, 5.3, 0.06, 0.86, 0.40, 0), // sunlit upper lobe
  ];
  const geo = mergeSimpleGeometries(parts);
  for (const p of parts) p.dispose();

  normaliseCrown(geo);
  paintCanopyAO(geo, 0.58, 1.08);
  // 4 x 60 non-indexed vertices -> 4 x 12 unique ones (48), 80 tris.
  return weldCrown(geo);
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

// sRGB hexes, linearised at placement time. Sun-baked Mediterranean yellow-olive
// / dry oak / golden sage / dusty olive-brown: dry-summer canopies read warm and
// low-saturation up close instead of cartoon mid-green; deep Alpine spruce and
// dark Mediterranean pine stay dark and slightly warm for the conifer belt.
const BROADLEAF_COLORS = [0x6b6a37, 0x5c6032, 0x4f5634, 0x7a7040, 0x826f44];
const CONIFER_COLORS = [0x354430, 0x3e4b34, 0x2c392a, 0x444b33];

// ---------------------------------------------------------------------------
// Radial walk buckets
// ---------------------------------------------------------------------------
// The rebuild walk sorts cells by a *score* (horizontal distance, plus an
// out-of-FOV penalty behind the camera) and emits them nearest-first. The score
// is quantised into VEG_BUCKET_M buckets so the cut-off at `treeLimit` can only
// ever land inside the single outermost bucket; every cell in an earlier bucket
// is emitted before any cell in a later one, which is what makes the forest
// stable under camera movement (no popping). Width matches
// (treeRadius 6,800 + cell + 2,600 max penalty) / 128 ~= 75 m, so the outermost
// bucket never overflows.
const VEG_BUCKETS = 128;
const VEG_BUCKET_M = 75;

// Ordering pack: `bucket * CELL_KEY_AREA + cellKey(cx, cz)` is a single exact
// float64 (bucket < 128 => value < 128 * 2^42 = 2^49 < 2^53) that sorts
// bucket-major and, inside a bucket, by the camera-independent world cell key.
const CELL_KEY_AREA = CELL_KEY_SPAN * CELL_KEY_SPAN;

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
    this.leafFarGeo = makeBroadleafCanopyFar();
    this.leafMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });

    this.coniferGeo = makeConiferCanopy();
    this.coniferMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });

    // Aerial perspective (VI PER-ATMOS parity): the same height-aware Rayleigh
    // + Mie air the terrain heightfield and OSM highways fade into, injected
    // into the stock Lambert program so the diffuse/vertex-colour/shadow/fog
    // chain stays exactly as Three.js builds it. A distant crown therefore
    // dissolves into the valley haze on the same physical curve as the hills
    // instead of staying a dark dot on a bright slope. One shared uniform
    // table: update() only copies values into it, so retinting the atmosphere
    // every frame allocates nothing and never recompiles the program.
    this._atmosUniforms = {
      uVegSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.2) },
      uVegSunColor: { value: new THREE.Color(0xfff2d0) },
      uVegSkyColor: { value: new THREE.Color(0x8fb4c8) },
    };
    this._attachAerialHaze(this.trunkMat, 'veg-trunk-aerial-v1', false);
    this._attachAerialHaze(this.leafMat, 'veg-leaf-aerial-v2', true);
    this._attachAerialHaze(this.coniferMat, 'veg-conifer-aerial-v2', true);

    // Near ring: full-detail crowns plus trunks, cast and receive shadows.
    // Far ring: welded low-poly broadleaf / shared conifer crown, no shadows
    // and no trunks (PERF-01, PERF-05). Each pool is sized to its species cap
    // so a live quality switch (or an all-one-species camera position) can
    // never write past the allocated instance buffers; both near and far
    // pools of a species share one mesh material.
    this.trunks = new THREE.InstancedMesh(this.trunkGeo, this.trunkMat, this.trunkCap);
    this.leavesNear = new THREE.InstancedMesh(this.leafGeo, this.leafMat, this.broadCap);
    this.leavesFar = new THREE.InstancedMesh(this.leafFarGeo, this.leafMat, this.broadCap);
    this.conifersNear = new THREE.InstancedMesh(this.coniferGeo, this.coniferMat, this.coniferCap);
    this.conifersFar = new THREE.InstancedMesh(this.coniferGeo, this.coniferMat, this.coniferCap);

    this.trunks.name = 'vegetation-trunks';
    this.leavesNear.name = 'vegetation-leaves-near';
    this.leavesFar.name = 'vegetation-leaves-far';
    this.conifersNear.name = 'vegetation-conifers-near';
    this.conifersFar.name = 'vegetation-conifers-far';

    for (const mesh of [this.trunks, this.leavesNear, this.leavesFar, this.conifersNear, this.conifersFar]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
    }
    this.trunks.castShadow = false;
    this.trunks.receiveShadow = false;
    this.leavesNear.castShadow = true;
    this.leavesNear.receiveShadow = true;
    this.conifersNear.castShadow = true;
    this.conifersNear.receiveShadow = true;
    this.leavesFar.castShadow = false;
    this.leavesFar.receiveShadow = false;
    this.conifersFar.castShadow = false;
    this.conifersFar.receiveShadow = false;

    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this.group.add(
      this.trunks,
      this.leavesNear,
      this.leavesFar,
      this.conifersNear,
      this.conifersFar,
    );
    if (this.scene && typeof this.scene.add === 'function') this.scene.add(this.group);

    this._lastX = Infinity;
    this._lastZ = Infinity;
    this._trees = 0;
    this._broad = 0;
    this._conifer = 0;
    // Previous live count per mesh, so an idle pool skips its upload entirely
    // (PERF-06) and a shrunk pool still uploads its new (shorter) live range.
    this._lastCounts = {
      trunks: 0,
      leavesNear: 0,
      leavesFar: 0,
      conifersNear: 0,
      conifersFar: 0,
    };

    // Deterministic per-cell forest cache (PKT-11 / PERF-10): cell => packed
    // Float32Array of accepted trees, or null for a cell with no trees. The
    // payload depends only on `(cx, cz)` and the active terrain / airport set,
    // so it survives preset changes (treeRadius / treeLimit only change how far
    // the walk goes and where it stops) and must only be dropped when the DEM or
    // the baked airports change, on dispose(), or via clearCellCache().
    this._cellCache = new Map();
    this._cachePruneX = Infinity;
    this._cachePruneZ = Infinity;
    // Scratch order buffer for the radial walk (bucket-major keys). Reused
    // across rebuilds so a rebuild allocates nothing in steady flight.
    this._orderBuf = null;
    this._epochDEM = null;
    this._epochAirports = null;
    this._cellHits = 0;
    this._cellMisses = 0;
    // Read-only observability for tests: terrainHeight calls made by the last
    // rebuild. Cached cells cost zero samples, which is the whole point.
    this._heightSamples = 0;
  }

  /**
   * Inject the terrain's Rayleigh + Mie aerial perspective into a stock Lambert
   * material (VI PER-ATMOS parity). Trees are InstancedMesh, so the object-space
   * `transformed` position must go through `instanceMatrix` before `modelMatrix`
   * — the chunk's own `worldPosition` is only emitted for shadow/envmap paths
   * and cannot be relied on here. The block runs on the linear `outgoingLight`
   * before `<opaque_fragment>`, exactly where terrainview.js hazes the terrain,
   * so crowns and hills share one atmosphere.
   *
   * `isFoliage` additionally injects a distance-gated leaf-cluster /
   * needle-tuft stipple ahead of that grade, so a close 3D crown reads as
   * ruffled dappled foliage instead of smooth low-poly facets. Bark keeps a
   * separate, stipple-free program (hence the distinct cache key).
   */
  _attachAerialHaze(mat, key, isFoliage = false) {
    mat.customProgramCacheKey = () => key;
    mat.onBeforeCompile = (shader) => {
      // Bind the shared table by reference: the uniform objects (and their
      // .value) are the ones update() mutates, so nothing is re-uploaded by
      // rebuilding a table per compile.
      shader.uniforms.uVegSunDir = this._atmosUniforms.uVegSunDir;
      shader.uniforms.uVegSunColor = this._atmosUniforms.uVegSunColor;
      shader.uniforms.uVegSkyColor = this._atmosUniforms.uVegSkyColor;

      shader.vertexShader = 'varying vec3 vVegWorld;\n' + shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        /* glsl */`#include <worldpos_vertex>
        vec4 vegWp = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          vegWp = instanceMatrix * vegWp;
        #endif
        vVegWorld = ( modelMatrix * vegWp ).xyz;`,
      );

      // High-frequency procedural foliage micro-detail. Injected BEFORE the
      // warm grade and the aerial haze so the stipple is itself graded and
      // hazed by the same chain (and therefore never reads as a decal). Bark
      // gets nothing: a trunk should stay a smooth, clean cylinder.
      const leafStipple = isFoliage ? /* glsl */`
        // 3D world-space leaf-cluster / needle-tuft stipple. Two cheap
        // wave-warped octaves over vVegWorld: ~0.85 m leaf tufts riding a
        // ~2.3 m branch sub-cluster field. Deliberately continuous (no cell
        // hash, floor or fract), so the field has zero voxel-grid seams and no
        // unused temporaries. Gated by leafFade: crowns past 250 m contour
        // down and everything past 1400 m is untouched, keeping the far ring
        // clean and alias-free.
        float leafFade = 1.0 - smoothstep( 250.0, 1400.0, vegDist );
        if ( leafFade > 0.005 ) {
          float c1 = sin( vVegWorld.x * 2.7 + sin( vVegWorld.z * 2.3 + vVegWorld.y * 1.9 ) * 1.7 )
                   * cos( vVegWorld.z * 2.9 + sin( vVegWorld.y * 2.5 - vVegWorld.x * 1.6 ) * 1.6 );
          float c2 = sin( vVegWorld.x * 6.8 - vVegWorld.y * 5.4 + c1 * 2.2 )
                   * cos( vVegWorld.z * 7.1 + vVegWorld.x * 4.9 - c1 * 1.8 );
          float leafMottle = clamp( 0.5 + 0.30 * c1 + 0.24 * c2, 0.0, 1.0 );
          float leafShade = mix( 0.68, 1.24, leafMottle );
          vec3 leafTint = mix( vec3( 0.86, 0.94, 0.84 ), vec3( 1.14, 1.08, 0.78 ),
            smoothstep( 0.35, 0.85, leafMottle ) );
          outgoingLight *= mix( vec3( 1.0 ), leafTint * leafShade, 0.75 * leafFade );
        }
      ` : '';

      shader.fragmentShader = 'uniform vec3 uVegSunDir, uVegSunColor, uVegSkyColor;\n'
        + 'varying vec3 vVegWorld;\n' + shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          /* glsl */`
        float vegDist = length( vVegWorld - cameraPosition );
${leafStipple}
        // Identical Rayleigh + Mie aerial perspective to terrainview.js
        // (VI PER-ATMOS), driven by the same sun/sky colours. Applied to the
        // linear outgoingLight BEFORE tonemapping and color-space encoding, so
        // a distant canopy hazes on the same physical curve as the heightfield.
        {
          vec3 vegViewDir = normalize( vVegWorld - cameraPosition );
          float dayVis = smoothstep( -0.05, 0.25, uVegSunDir.y );
          float lowAir = 1.0 - smoothstep( 100.0, 2600.0, 0.5 * ( cameraPosition.y + vVegWorld.y ) );
          float aerialT = 1.0 - exp( -vegDist * ( 0.000024 + lowAir * 0.000020 ) );
          aerialT = clamp( aerialT * smoothstep( 2500.0, 9000.0, vegDist ), 0.0, 0.72 );
          vec3 rayleighBlue = mix( vec3( 0.42, 0.58, 0.80 ), vec3( 0.54, 0.68, 0.86 ),
            smoothstep( 0.0, 0.5, uVegSunDir.y ) );
          rayleighBlue = mix( rayleighBlue, uVegSkyColor, 0.16 * dayVis );
          float sunAlign = max( dot( vegViewDir, uVegSunDir ), 0.0 );
          float miePhase = pow( sunAlign, 4.0 ) * 0.65 + pow( sunAlign, 18.0 ) * 0.35;
          vec3 dustGlow = mix( vec3( 0.92, 0.76, 0.56 ), uVegSunColor, 0.55 );
          vec3 atmosCol = mix( rayleighBlue, dustGlow,
            clamp( miePhase * ( 0.45 + lowAir * 0.40 ), 0.0, 0.72 ) );
          float distDesat = aerialT * 0.35 * dayVis;
          float vegLum = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
          // Close-range sun-baked warmth (0 .. ~4.5 km): a gentle golden-olive
          // grade that only lives while the air is still clear, so it fades out
          // exactly where the blue Rayleigh haze takes over and leaves distance
          // and night (dayVis = 0) untouched.
          float nearWarm = ( 1.0 - smoothstep( 1200.0, 5200.0, vegDist ) ) * dayVis;
          outgoingLight = mix( outgoingLight, vec3( vegLum ), 0.16 * nearWarm );
          outgoingLight *= mix( vec3( 1.0 ), vec3( 1.08, 1.02, 0.86 ), 0.45 * nearWarm );
          vegLum = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
          outgoingLight = mix( outgoingLight, vec3( vegLum ), distDesat );
          outgoingLight = mix( outgoingLight, atmosCol, aerialT * 0.62 * dayVis );
          outgoingLight += dustGlow * miePhase * aerialT * 0.14 * dayVis * ( 0.5 + 0.5 * lowAir );
        }
        #include <opaque_fragment>`,
        );
    };
  }

  /** Backwards-compatible aliases: the near pool is the full-detail forest. */
  get leaves() {
    return this.leavesNear;
  }

  get conifers() {
    return this.conifersNear;
  }

  update(dt, camera, sky) {
    if (!camera || !camera.position) return;
    // Keep the forest haze inside the same atmosphere as the sky dome: copy the
    // live sun/sky colours into the shared uniform table (no allocation, no
    // recompile). `sky` is optional so headless callers and tests that pass
    // only (dt, camera) behave exactly as before.
    if (sky) {
      const a = this._atmosUniforms;
      if (sky.sunDir) a.uVegSunDir.value.copy(sky.sunDir);
      if (sky.sunColor) a.uVegSunColor.value.copy(sky.sunColor);
      if (sky.skyColor) a.uVegSkyColor.value.copy(sky.skyColor);
    }
    // Translation only: a rebuild re-runs the radial walk, which is stable
    // under movement, but re-running it because the player *looked* around
    // would still re-walk (and re-upload) an unchanged forest. Rotating the
    // camera in cockpit / chase / free cam therefore never rebuilds.
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
    const cell = VEG_CELL;

    // A theater switch swaps the DEM or the baked airport set, which changes
    // every terrainHeight / slopeAt / airportNear answer for the same cell key.
    this._syncTerrainEpoch();
    this._heightSamples = 0;
    this._pruneCellCache(camX, camZ, radius);

    const x0 = Math.floor((camX - radius) / cell);
    const x1 = Math.floor((camX + radius) / cell);
    const z0 = Math.floor((camZ - radius) / cell);
    const z1 = Math.floor((camZ + radius) / cell);
    const nx = x1 - x0 + 1;
    const nz = z1 - z0 + 1;
    const total = nx * nz;

    const acc = {
      n: 0, // every emitted tree (baseline total)
      nb: 0, // broadleaf total, drives the species cap clamp
      nc: 0, // conifer total, drives the species cap clamp
      nbN: 0, // leavesNear slots written
      nbF: 0, // leavesFar slots written
      ncN: 0, // conifersNear slots written
      ncF: 0, // conifersFar slots written
      tn: 0, // trunk slots written (near trees only)
      camX,
      camZ,
      nearR2: VEG_NEAR_R * VEG_NEAR_R,
      limit,
    };

    if (total > 0) {
      // Horizontal camera heading. A stub camera without `getWorldDirection`
      // (headless tests), or one pointing straight up / down, has no usable
      // heading: the walk then falls back to pure isotropic radial distance.
      let fwdX = 0;
      let fwdZ = 0;
      let hasFwd = false;
      if (camera && typeof camera.getWorldDirection === 'function') {
        camera.getWorldDirection(_fwd);
        const len = Math.hypot(_fwd.x, _fwd.z);
        if (len > 1e-6) {
          fwdX = _fwd.x / len;
          fwdZ = _fwd.z / len;
          hasFwd = true;
        }
      }

      // Pass 1 — score the circular footprint. Nearest-first, with an
      // out-of-FOV penalty only for far cells behind the camera, so a tight
      // `treeLimit` trims the tail behind the aircraft and never the forest
      // the pilot is actually looking at.
      let buf = this._orderBuf;
      if (!buf || buf.length < total) {
        buf = new Float64Array(total);
        this._orderBuf = buf;
      }
      const reach = radius + cell;
      const reach2 = reach * reach;
      const nearR = VEG_NEAR_R;
      const invBucket = 1 / VEG_BUCKET_M;
      const lastBucket = VEG_BUCKETS - 1;
      let n = 0;

      for (let cz = z0; cz <= z1; cz++) {
        const dz = cz * cell + cell * 0.5 - camZ;
        const dz2 = dz * dz;
        for (let cx = x0; cx <= x1; cx++) {
          const dx = cx * cell + cell * 0.5 - camX;
          const d2 = dx * dx + dz2;
          if (d2 > reach2) continue; // outside the circular footprint
          const d = Math.sqrt(d2);

          // Inside the near 360° protection zone the score is the plain
          // distance: every tree around the jet is emitted first, so looking
          // around can never reveal a hole. Beyond it, cells behind the camera
          // ramp up to a +2,600 m penalty.
          let score = d;
          if (hasFwd && d > nearR) {
            const cosAng = (dx * fwdX + dz * fwdZ) / d;
            if (cosAng < 0) {
              score = d + -cosAng * Math.min(1, (d - nearR) * 0.001) * 2600;
            }
          }

          let bucket = (score * invBucket) | 0;
          if (bucket > lastBucket) bucket = lastBucket;
          buf[n++] = bucket * CELL_KEY_AREA + cellKey(cx, cz);
        }
      }

      // Pass 2 — bucket-major, then world cell key inside the bucket. Only the
      // outermost bucket that meets `treeLimit` can be partially emitted, and
      // its order is a pure function of world coordinates, so moving the
      // camera never re-shuffles the trees already inside the emitted disc.
      const parked = this.broadCap <= 0 && this.coniferCap <= 0;
      const emitting = !parked && limit > 0;

      if (emitting) {
        const order = buf.subarray(0, n);
        order.sort();

        // Stopping at `treeLimit` leaves the emitted region a compact disc (or
        // a forward-biased teardrop) around the camera, so a 400 m step only
        // has to sample the newly entered outer rim: the cache-warmth property
        // of PKT-11 survives without walking the whole square.
        for (let i = 0; i < n; i++) {
          const packed = order[i];
          const bucket = Math.floor(packed / CELL_KEY_AREA);
          const key = packed - bucket * CELL_KEY_AREA;
          const cx = cellKeyX(key);
          const cz = cellKeyZ(key);
          const baseX = cx * cell + cell * 0.5;
          const baseZ = cz * cell + cell * 0.5;

          let trees = this._cellCache.get(key);
          if (trees === undefined) {
            trees = this._sampleCell(cx, cz);
            this._storeCell(key, trees);
            this._cellMisses++;
          } else {
            this._cellHits++;
          }
          // A cached empty cell (`null`) costs nothing at all.
          if (trees === null) continue;
          if (!this._emitCell(trees, baseX, baseZ, acc)) break;
        }
      }
    }

    // Hard clamp to the allocated pools (quality switches may shrink presets).
    const trunkOut = Math.min(acc.tn, this.trunks.instanceMatrix.count);
    const nbNOut = Math.min(acc.nbN, this.leavesNear.instanceMatrix.count);
    const nbFOut = Math.min(acc.nbF, this.leavesFar.instanceMatrix.count);
    const ncNOut = Math.min(acc.ncN, this.conifersNear.instanceMatrix.count);
    const ncFOut = Math.min(acc.ncF, this.conifersFar.instanceMatrix.count);

    this.trunks.count = trunkOut;
    this.leavesNear.count = nbNOut;
    this.leavesFar.count = nbFOut;
    this.conifersNear.count = ncNOut;
    this.conifersFar.count = ncFOut;

    this._uploadPool('trunks', this.trunks);
    this._uploadPool('leavesNear', this.leavesNear);
    this._uploadPool('leavesFar', this.leavesFar);
    this._uploadPool('conifersNear', this.conifersNear);
    this._uploadPool('conifersFar', this.conifersFar);

    this._trees = nbNOut + nbFOut + ncNOut + ncFOut;
    this._broad = nbNOut + nbFOut;
    this._conifer = ncNOut + ncFOut;
    this._lastX = camX;
    this._lastZ = camZ;
  }

  /**
   * Drop every cached cell. Cell payloads depend on the active DEM and on the
   * baked airport set (pad radii modify `terrainHeight`, `airportNear` gates the
   * cell), so a theater switch must invalidate them; `rebuild()` also detects a
   * swapped DEM / airport object by identity and calls this automatically.
   */
  clearCellCache() {
    this._cellCache.clear();
    this._cachePruneX = Infinity;
    this._cachePruneZ = Infinity;
    this._cellHits = 0;
    this._cellMisses = 0;
  }

  /** Invalidate the cache when the DEM or the baked airport set is swapped. */
  _syncTerrainEpoch() {
    const dem = getActiveDEM();
    const airports = getCustomAirports();
    if (dem === this._epochDEM && airports === this._epochAirports) return;
    this._epochDEM = dem;
    this._epochAirports = airports;
    this.clearCellCache();
  }

  /**
   * Bound the cache to the streamed neighborhood: cells more than
   * `1.5 * treeRadius` from the camera are dropped. Runs at most every
   * `0.25 * treeRadius` of travel, so the scan is amortized over several
   * rebuilds and costs nothing while hovering.
   */
  _pruneCellCache(camX, camZ, radius) {
    if (this._cellCache.size === 0) {
      this._cachePruneX = camX;
      this._cachePruneZ = camZ;
      return;
    }
    const px = camX - this._cachePruneX;
    const pz = camZ - this._cachePruneZ;
    const step = radius * 0.25;
    if (px * px + pz * pz < step * step) return;
    this._cachePruneX = camX;
    this._cachePruneZ = camZ;

    const keep = radius * 1.5;
    const keep2 = keep * keep;
    for (const key of this._cellCache.keys()) {
      const dx = (cellKeyX(key) + 0.5) * VEG_CELL - camX;
      if (dx > keep || dx < -keep) {
        this._cellCache.delete(key);
        continue;
      }
      const dz = (cellKeyZ(key) + 0.5) * VEG_CELL - camZ;
      if (dz > keep || dz < -keep) {
        this._cellCache.delete(key);
        continue;
      }
      if (dx * dx + dz * dz > keep2) this._cellCache.delete(key);
    }
  }

  /** Insert a cell result, evicting the oldest entry at the hard bound. */
  _storeCell(key, trees) {
    if (this._cellCache.size >= MAX_CELL_CACHE) {
      // Map iterates in insertion order, so this is FIFO: on a straight flight
      // the entry dropped first is the cell visited longest ago, i.e. the one
      // furthest behind the camera.
      const oldest = this._cellCache.keys().next();
      if (!oldest.done) this._cellCache.delete(oldest.value);
    }
    this._cellCache.set(key, trees);
  }

  /**
   * Evaluate one cell from scratch. Deterministic on `(cx, cz)` alone: the
   * grove masks, the cell hash and the stem rng are all seeded from the cell
   * indices, and terrain / slope / airport queries are pure functions of the
   * cell centre. That is what makes caching the result exact.
   *
   * Returns a packed Float32Array of accepted trees, or `null` for an empty
   * cell. The per-species pool caps are applied at emission time rather than
   * here: the uncached walk let a saturated cap steer the stem rng stream
   * mid-cell, which cannot be cached, so the cache samples the cap-free stream.
   */
  _sampleCell(cx, cz) {
    const cell = VEG_CELL;
    const baseX = cx * cell + cell * 0.5;
    const baseZ = cz * cell + cell * 0.5;

    // Organic groves: primary forest mask + secondary grove noise, so the
    // valley floor and Karst slopes break into irregular stands.
    const forest = fbm01(baseX * 0.0009, baseZ * 0.0009, 3, 1201);
    const grove = fbm01(baseX * 0.0027 + 31.7, baseZ * 0.0027 - 17.3, 2, 7717);
    const density = smoothstep(0.44, 0.76, forest) * (0.55 + 0.9 * grove);
    if (hash2(cx, cz, 5521) > density) return null;

    const hCell = terrainHeight(baseX, baseZ);
    this._heightSamples++;
    if (hCell < 3.0) return null; // sea, rivers, low wetlands
    const cellSlope = slopeAt(baseX, baseZ);
    if (cellSlope > 0.65) return null; // cliffs / scree

    const ap = airportNear(baseX, baseZ, 2400);
    if (ap) {
      const d = Math.hypot(ap.x - baseX, ap.z - baseZ);
      if (d < ap.padRadius + 160 + cell) return null;
    }

    const rng = mulberry32(((cx * 73856093) ^ (cz * 19349663) ^ 0x51ed) >>> 0);
    const count = 3 + Math.floor(rng() * 7); // 3..9 stems per wooded cell

    const out = [];
    for (let k = 0; k < count; k++) {
      const x = baseX + (rng() - 0.5) * cell;
      const z = baseZ + (rng() - 0.5) * cell;
      const y = terrainHeight(x, z);
      this._heightSamples++;
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
      const isConifer = rng() < coniferProb;
      const rot = rng() * Math.PI * 2;

      // The rng draw order below is exactly the pre-cache order (species
      // decision, rotation, then that species' size / colour draws), so the
      // accepted trees stay identical to a cold walk.
      let trunkH;
      let thick;
      let crownY;
      let crownH;
      let crownW;
      if (isConifer) {
        const hgt = 9 + rng() * 13;
        trunkH = hgt * 0.22;
        thick = 0.5 + hgt * 0.03;
        crownW = hgt * (0.36 + rng() * 0.14);
        crownY = y - 0.2;
        crownH = hgt;
        _c.setHex(CONIFER_COLORS[(rng() * CONIFER_COLORS.length) | 0]).convertSRGBToLinear();
        // Higher altitudes read darker and cooler.
        _c.multiplyScalar(clamp(1.06 - (y - 450) * 0.00035, 0.78, 1.06) * (0.9 + rng() * 0.16));
      } else {
        const hgt = 6.5 + rng() * 10.5;
        trunkH = hgt * (0.34 + rng() * 0.08);
        crownH = hgt * (0.62 + rng() * 0.12);
        thick = 0.55 + hgt * 0.045;
        crownW = hgt * (0.30 + rng() * 0.14);
        crownY = y + trunkH * 0.95;
        _c.setHex(BROADLEAF_COLORS[(rng() * BROADLEAF_COLORS.length) | 0]).convertSRGBToLinear();
        _c.multiplyScalar(0.86 + rng() * 0.26);
      }

      out.push(
        x - baseX,
        z - baseZ,
        y,
        crownY,
        trunkH,
        thick,
        crownH,
        crownW,
        rot,
        isConifer ? 1 : 0,
        _c.r,
        _c.g,
        _c.b,
      );
    }

    return out.length ? new Float32Array(out) : null;
  }

  /**
   * Emit the cached trees of one cell. Near/far routing is a pure distance test
   * (no rng), and the species caps are applied here, so this reproduces the
   * uncached walk instance for instance. Returns false when the walk must stop
   * (`n >= limit`, or both species pools saturated).
   */
  _emitCell(trees, baseX, baseZ, acc) {
    const nearR2 = acc.nearR2;
    const limit = acc.limit;

    for (let t = 0; t < trees.length; t += TREE_STRIDE) {
      if (acc.n >= limit) return false;

      const x = baseX + trees[t];
      const z = baseZ + trees[t + 1];
      const y = trees[t + 2];
      const crownY = trees[t + 3];
      const trunkH = trees[t + 4];
      const thick = trees[t + 5];
      const crownH = trees[t + 6];
      const crownW = trees[t + 7];

      const ddx = x - acc.camX;
      const ddz = z - acc.camZ;
      const near = ddx * ddx + ddz * ddz <= nearR2;

      // A saturated species pool reroutes the stem to the other species so the
      // tree budget is still spent. The cached size / colour fields are reused
      // as-is: the cap only picks which crown geometry draws them. Caps are only
      // reachable on broadleaf-heavy low ground, and keeping the sampling
      // independent of walk order is what makes the cache exact.
      let conifer = trees[t + 9] > 0.5;
      const broadFull = acc.nb >= this.broadCap;
      const coniferFull = acc.nc >= this.coniferCap;
      if (broadFull && coniferFull) return false;
      if (conifer && coniferFull) conifer = false;
      else if (!conifer && broadFull) conifer = true;

      _e.set(0, trees[t + 8], 0);
      _q.setFromEuler(_e);
      _c.r = trees[t + 10];
      _c.g = trees[t + 11];
      _c.b = trees[t + 12];

      if (conifer) {
        const crown = near ? this.conifersNear : this.conifersFar;
        const ci = near ? acc.ncN : acc.ncF;

        // Trunks only under near crowns: past 2.4 km a trunk is under a pixel
        // tall (PERF-05).
        if (near) {
          _p.set(x, y - 0.25, z);
          _s.set(thick, trunkH, thick);
          _m.compose(_p, _q, _s);
          this.trunks.setMatrixAt(acc.tn++, _m);
        }

        _p.set(x, crownY, z);
        _s.set(crownW, crownH, crownW);
        _m.compose(_p, _q, _s);
        crown.setMatrixAt(ci, _m);
        crown.setColorAt(ci, _c);
        if (near) acc.ncN++;
        else acc.ncF++;
        acc.nc++;
      } else {
        const crown = near ? this.leavesNear : this.leavesFar;
        const bi = near ? acc.nbN : acc.nbF;

        if (near) {
          _p.set(x, y - 0.3, z);
          _s.set(thick, trunkH, thick);
          _m.compose(_p, _q, _s);
          this.trunks.setMatrixAt(acc.tn++, _m);
        }

        _p.set(x, crownY, z);
        _s.set(crownW, crownH, crownW);
        _m.compose(_p, _q, _s);
        crown.setMatrixAt(bi, _m);
        crown.setColorAt(bi, _c);
        if (near) acc.nbN++;
        else acc.nbF++;
        acc.nb++;
      }
      acc.n++;
    }
    return true;
  }

  /**
   * Upload only the live prefix of an instance pool (PERF-06). The full pool
   * is 14,400 or 18,000 instances, so uploading `count` instead of the whole
   * buffer cuts the streaming rebuild spike to the actual tree count.
   */
  _uploadPool(key, mesh) {
    const count = mesh.count;
    const prev = this._lastCounts[key] || 0;
    // An idle pool (empty now and empty before) has nothing to upload.
    if (count === 0 && prev === 0) return;
    const matrix = mesh.instanceMatrix;
    matrix.clearUpdateRanges();
    if (count > 0) matrix.addUpdateRange(0, count * 16); // 16 floats per instance
    matrix.needsUpdate = true;
    const color = mesh.instanceColor;
    if (color) {
      color.clearUpdateRanges();
      if (count > 0) color.addUpdateRange(0, count * 3); // 3 floats per instance
      color.needsUpdate = true;
    }
    this._lastCounts[key] = count;
  }

  dispose() {
    this.clearCellCache();
    this.trunkGeo.dispose();
    this.trunkMat.dispose();
    this.leafGeo.dispose();
    this.leafFarGeo.dispose();
    this.leafMat.dispose();
    this.coniferGeo.dispose();
    this.coniferMat.dispose();
    for (const mesh of [this.trunks, this.leavesNear, this.leavesFar, this.conifersNear, this.conifersFar]) {
      mesh.dispose();
    }
    this.group.removeFromParent();
    if (this.scene && typeof this.scene.remove === 'function') {
      this.scene.remove(this.group);
    }
    this.group.clear();
  }
}