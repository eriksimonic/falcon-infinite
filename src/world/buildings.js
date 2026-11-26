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

const RUIN_FIRE_LIFE = 75; // seconds a collapsed building keeps smouldering
const RUIN_FIRE_CAP = 24; // active ember plumes keep the VFX pool bounded

// Real-world (baked OSM) city: one virtual settlement carries every baked
// building so the same grounding / damage / ruin pipeline applies unchanged.
const CUSTOM_SETTLEMENT_ID = 'vipava-osm';
const CUSTOM_SETTLEMENT_RADIUS = 52000; // reachable everywhere inside the 100 km region
const LARGE_SETTLEMENT_RADIUS = 24000; // per-building stream radius for the OSM city
const LARGE_SETTLEMENT_MIN_SIZE = 3000; // settlements larger than this stream per building
const DEM_HALF = 50000; // the baked DEM owns +-50 km; procedural cities outside it stay
const CUSTOM_KINDS = ['house', 'apartment', 'industrial', 'tower'];
// LJAJ (Ajdovscina) is a true East-West strip at the DEM centre: RWY 09/27 runs
// along +-X. Nothing built by OSM may sit on the pavement or the graded strip.
const LJAJ_RUNWAY_HALF_LENGTH_M = 960; // 1800 m runway + 60 m overrun either end
const LJAJ_RUNWAY_HALF_WIDTH_M = 95;   // 36 m runway + shoulders/apron clearance

// Roof/wall palettes matching settlements.js, so baked buildings read as the
// same architecture as their procedural neighbours.
const CUSTOM_PALETTE = {
  house: [0xd9cdb6, 0xcfc0a6, 0xe3d9c8, 0xc4b49a, 0xb9a88c, 0xd6c1a3],
  apartment: [0xa9a49a, 0xb8b2a6, 0x9b9a93, 0xc0b6a8, 0x8f9095],
  industrial: [0x8e918c, 0x9c978b, 0x82857f, 0xa39a86],
  tower: [0x8fa6ba, 0x7d93a8, 0xa6b8c6, 0x93a3b3, 0x8298a8, 0xb3c2cc],
};

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
      varying vec3 vLocalN;
      varying vec3 vLocal;
      varying vec3 vScale;
      varying vec3 vCol;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(instanceMatrix) * normal);
        vLocalN = normal;
        vLocal = position;
        // Instance scale in metres, extracted from the matrix columns, lets the
        // fragment shader recover true wall metres per facade axis.
        vScale = vec3(
          length(instanceMatrix[0].xyz),
          length(instanceMatrix[1].xyz),
          length(instanceMatrix[2].xyz)
        );
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
      varying vec3 vLocalN;
      varying vec3 vLocal;
      varying vec3 vScale;
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
        vec3 ln = normalize(vLocalN);
        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);
        vec3 col = vCol * (uAmbient + uSunColor * (ndl * 0.9 + wrap * 0.14)) + vCol * 0.06;

        // Wall-aligned facade coordinates. The axis that runs *across* each
        // wall (local z for the ±X walls, local x for the ±Z walls) is taken in
        // real metres via the instance scale, so window columns stay crisp and
        // vertical on rotated buildings instead of smearing diagonally.
        float xFace = step(0.5, abs(ln.x));
        float wallSpan = mix(vLocal.x * vScale.x, vLocal.z * vScale.z, xFace);
        float u = wallSpan / 3.8;              // ~3.8 m wide window bays
        float v = (vLocal.y * vScale.y) / 3.4; // ~3.4 m floor pitch
        vec2 g = fract(vec2(u, v));
        float win = step(0.18, g.x) * step(g.x, 0.82) * step(0.30, g.y) * step(g.y, 0.86);
        vec2 cell = floor(vec2(u, v));
        float rnd = h21(cell + floor(vCol.xy * 97.0));
        float wall = 1.0 - smoothstep(0.55, 0.85, abs(ln.y));
        float glass = win * wall;

        // Crisp horizontal floor spandrel band under every row of windows.
        float spandrel = wall * step(0.04, g.y) * step(g.y, 0.19);
        col *= 1.0 - spandrel * 0.22;

        float day = 1.0 - uNight;

        // Daylight: dark, sky-tinted reflective glass with a subtle sheen.
        vec3 skyGlass = mix(vec3(0.14, 0.20, 0.28), vec3(0.46, 0.58, 0.73),
                            clamp(wrap, 0.0, 1.0));
        col = mix(col, skyGlass, glass * 0.62 * day);

        // Night: unlit glass reads as a dark hole, lit rooms glow. Occupancy is
        // hashed per building so whole blocks wake up together (an office tower
        // burns bright, a row of houses lights three windows); every window
        // then picks tungsten / amber / cool office white and its own
        // brightness, which keeps Ajdovscina, Nova Gorica, Gorizia, Trieste and
        // Koper looking organic from 3-15 km instead of uniformly tiled.
        col *= 1.0 - glass * 0.55 * uNight;
        float buildingSeed = h21(floor(vCol.xy * 97.0) + 3.7);
        float occupancy = 0.45 + 0.20 * buildingSeed; // 45..65% of windows lit
        float roomSeed = h21(cell * 1.37 + floor(vCol.yz * 71.0) + 11.3);
        float lit = step(1.0 - occupancy, roomSeed) * glass;
        float tone = h21(cell * 2.71 + floor(vCol.yz * 131.0) + 5.9);
        vec3 winColor = mix(vec3(1.0, 0.78, 0.42), vec3(1.0, 0.62, 0.25), step(0.68, tone));
        winColor = mix(winColor, vec3(0.78, 0.90, 1.0), step(0.92, tone));
        float brightness = 0.72 + 0.28 * h21(cell * 3.17 + 7.1) + 0.28 * rnd;
        // 1.45x warm boost at full night so selective bloom picks up the
        // towns as bright clusters at altitude.
        col += winColor * lit * uNight * 2.6 * 1.45 * brightness;

        // Subtle base ambient occlusion over the bottom 15% of each block.
        col *= mix(0.72, 1.0, smoothstep(0.0, 0.15, vLocal.y));

        // Textured, darker rooftops with a mottled gravel/tar tone.
        float roof = smoothstep(0.65, 0.95, abs(ln.y));
        vec2 rp = vec2(vLocal.x * vScale.x, vLocal.z * vScale.z) * 0.4;
        float mottle = h21(floor(rp) + floor(vCol.yz * 131.0));
        vec3 roofCol = col * mix(vec3(0.62, 0.60, 0.56), vec3(0.86, 0.84, 0.80), mottle);
        col = mix(col, roofCol, roof);

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
  // Fade the edge broadly so the patch melts into the terrain instead of
  // stamping a hard grey circle on the landscape.
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.12, S / 2, S / 2, S * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0.96)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.82)');
  g.addColorStop(0.74, 'rgba(255,255,255,0.42)');
  g.addColorStop(0.9, 'rgba(255,255,255,0.16)');
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

// Charred crater decal: crisp dark bowl, radial blast rays, a raised dusty
// earth rim and a cooling ember ring. Drawn once; the crater mesh maps it onto
// every disc (UVs are radial, so one texture serves 4 m scorches and 160 m
// wastelands alike).
function makeCraterTexture() {
  if (!HAS_DOM) return null;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const cx = S * 0.5;
  const cy = S * 0.5;
  const R = S * 0.5;
  const rng = (() => {
    let a = 0x9e3779b9 >>> 0;
    return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  })();

  ctx.clearRect(0, 0, S, S);

  // Scorched bowl: opaque charred centre fading into thrown-up dust at the lip.
  const bowl = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  bowl.addColorStop(0.0, 'rgba(6,5,4,0.98)');
  bowl.addColorStop(0.32, 'rgba(14,12,10,0.96)');
  bowl.addColorStop(0.54, 'rgba(32,26,20,0.90)');
  bowl.addColorStop(0.7, 'rgba(66,52,38,0.60)');
  bowl.addColorStop(0.86, 'rgba(108,90,66,0.30)');
  bowl.addColorStop(1.0, 'rgba(124,106,78,0.0)');
  ctx.fillStyle = bowl;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();

  // Radial blast rays: dark char streaks driven out from ground zero.
  for (let i = 0; i < 72; i++) {
    const ang = rng() * Math.PI * 2;
    const inner = R * (0.10 + rng() * 0.16);
    const outer = R * (0.46 + rng() * 0.44);
    const wob = (rng() - 0.5) * 0.16;
    const shade = 10 + ((rng() * 16) | 0);
    ctx.strokeStyle = `rgba(${shade},9,8,${0.14 + rng() * 0.34})`;
    ctx.lineWidth = 0.6 + rng() * 3.2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * inner, cy + Math.sin(ang) * inner);
    ctx.lineTo(cx + Math.cos(ang + wob) * outer, cy + Math.sin(ang + wob) * outer);
    ctx.stroke();
  }

  // Raised dusty earth rim around the lip of the bowl.
  ctx.strokeStyle = 'rgba(152,134,102,0.42)';
  ctx.lineWidth = S * 0.036;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(78,64,46,0.30)';
  ctx.lineWidth = S * 0.018;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.73, 0, Math.PI * 2);
  ctx.stroke();

  // Subtle ember glow ring still cooling inside the bowl (also used as the
  // emissive map so the ring glows while the char itself stays black).
  const ember = ctx.createRadialGradient(cx, cy, R * 0.26, cx, cy, R * 0.6);
  ember.addColorStop(0.0, 'rgba(255,96,24,0)');
  ember.addColorStop(0.55, 'rgba(255,104,32,0.2)');
  ember.addColorStop(1.0, 'rgba(210,52,10,0)');
  ctx.fillStyle = ember;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.62, 0, Math.PI * 2);
  ctx.fill();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
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
    // Cumulative structural HP per building key: light ordnance (20 mm GUN)
    // chips it down instead of levelling the block in one hit.
    this.buildingHp = new Map();
    // Buildings that have finished collapsing and are still smouldering:
    // [{ key, x, y, z, t, life, seed }], oldest first, capped at RUIN_FIRE_CAP.
    this.ruinFires = [];
    // Buildings that are burning and falling right now: key -> collapse entry
    // ({ key, b, s, minY, topY, height, t, duration, tiltX, tiltZ, seed }).
    // They only join `destroyed` once the animation has played out, which is
    // what makes the collapse smooth instead of an instant snap to rubble.
    this.collapsing = new Map();
    this.craters = [];
    this._cratersDirty = true;
    this._groundCache = new WeakMap();
    this._needsRebuild = true;
    // Baked real-world settlement (OSM). null = pure procedural cities.
    this.customSettlement = null;
    this.stats = {
      buildings: 0, roads: 0, settlements: 0, lights: 0,
      destroyed: 0, craters: 0, ruins: 0, ruinFires: 0,
    };

    // Everything below needs a scene; in Node we stop here (headless-safe).
    this.mesh = null;
    this.roadMesh = null;
    this.craterMesh = null;
    this.lightMesh = null;
    this.ruinMesh = null;
    this.craterTexture = null;
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

    // Ruined footprints live in their own instanced mesh: a bombed block is
    // drawn as a multi-piece debris field (wall stubs, slabs, core) without
    // inflating the standing-building instance budget.
    const ruinGeo = new THREE.BoxGeometry(1, 1, 1);
    ruinGeo.translate(0, 0.5, 0);
    this.ruinMesh = new THREE.InstancedMesh(
      ruinGeo,
      this.material,
      Math.max(2000, this.preset.ruinLimit || this.preset.buildingLimit || 16000),
    );
    this.ruinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ruinMesh.frustumCulled = false;
    this.ruinMesh.count = 0;
    this.ruinMesh.name = 'ruin-pieces';
    this.scene.add(this.ruinMesh);

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
      opacity: 0.38,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.craterTexture = makeCraterTexture();
    this.craterMaterial = new THREE.MeshLambertMaterial({
      color: this.craterTexture ? 0xffffff : 0x26211e,
      map: this.craterTexture || null,
      transparent: true,
      depthWrite: false,
      emissive: this.craterTexture ? 0xff4a12 : 0x000000,
      emissiveMap: this.craterTexture || null,
      emissiveIntensity: 0.45,
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
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;

    // Smouldering ruins age first, so a building that finishes collapsing in
    // this very step starts its 75 s burn at t = 0 instead of being aged away.
    if (this.ruinFires.length > 0) {
      for (const f of this.ruinFires) f.t += step;
      while (this.ruinFires.length > 0 && this.ruinFires[0].t >= RUIN_FIRE_LIFE) {
        this.ruinFires.shift();
      }
    }

    // Collapse timers are pure data, so they advance headlessly too and a
    // finished building only then becomes permanent rubble (and a new ember).
    if (this.collapsing.size > 0) {
      for (const [key, c] of this.collapsing) {
        c.t += step;
        if (c.t >= c.duration) {
          this.collapsing.delete(key);
          this.destroyed.add(key);
          this._registerRuinFire(c);
        }
      }
      this._needsRebuild = true;
      this.stats.destroyed = this.destroyed.size + this.collapsing.size;
    }
    this.stats.ruinFires = this.ruinFires.length;

    if (!this.scene) return;
    // Fresh scorch marks arrive every few frames while strafing: rebuild the
    // (cheap) crater mesh on its own instead of re-instancing every building.
    if (this._cratersDirty && !this._needsRebuild) this._rebuildCraters();
    if (!camera) return;
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
  // Baked real-world city (OSM)
  // -------------------------------------------------------------------------
  /**
   * Swap the procedural city for a baked real-world building set.
   *
   * Each `rawList` item is `[x, z, w, d, h, rot, kindCode]` in world metres,
   * with `kindCode` 0 = house, 1 = apartment, 2 = industrial, 3 = tower. The
   * whole list becomes one virtual settlement (`id: 'vipava-osm'`, type
   * `metro`, radius 22 km) so grounding, side-wall hits, cumulative damage,
   * burn/collapse and permanent ruins all run through the existing pipeline.
   * Procedural settlements inside the 100 km DEM box are dropped while baked
   * buildings are active; those outside it survive.
   *
   * Passing `null` (or an empty list) reverts cleanly to procedural cities.
   *
   * @returns {object|null} the virtual settlement, or null when reverting
   */
  setCustomBuildings(rawList) {
    if (!Array.isArray(rawList) || rawList.length === 0) {
      this.customSettlement = null;
      this._needsRebuild = true;
      return null;
    }

    const buildings = [];
    for (const item of rawList) {
      if (!Array.isArray(item) || item.length < 7) continue;
      const x = Number(item[0]);
      const z = Number(item[1]);
      const w = Number(item[2]);
      const d = Number(item[3]);
      const h = Number(item[4]);
      const rot = Number(item[5]);
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(rot)) continue;
      if (!(w > 0) || !(d > 0) || !(h > 0)) continue;
      // Never drop an OSM building on the real Ajdovscina runway (RWY 09/27).
      if (Math.abs(x) < LJAJ_RUNWAY_HALF_LENGTH_M && Math.abs(z) < LJAJ_RUNWAY_HALF_WIDTH_M) continue;
      const kind = CUSTOM_KINDS[Math.floor(Number(item[6])) | 0] || 'house';
      const palette = CUSTOM_PALETTE[kind];
      buildings.push({
        x,
        z,
        w,
        d,
        h,
        rot,
        kind,
        color: palette[Math.floor(hash2(Math.round(x), Math.round(z), 0x51ed270b) * palette.length)],
      });
    }

    this.customSettlement = {
      id: CUSTOM_SETTLEMENT_ID,
      type: 'metro',
      name: 'Vipava Valley',
      x: 0,
      z: 0,
      radius: CUSTOM_SETTLEMENT_RADIUS,
      population: buildings.length * 3,
      buildings,
      roads: [],
    };
    this._needsRebuild = true;
    return this.customSettlement;
  }

  /**
   * Settlements visible in the query circle, with the baked OSM city swapped in.
   * While it is active, procedural cities inside the DEM box are hidden so the
   * real valley is not covered by an invented grid; everything outside survives.
   */
  _settlementsNear(x, z, radius) {
    const near = settlementsNear(x, z, radius);
    const custom = this.customSettlement;
    if (!custom) return near;

    const out = [];
    for (const s of near) {
      if (Math.abs(s.x) <= DEM_HALF && Math.abs(s.z) <= DEM_HALF) continue;
      out.push(s);
    }
    const dx = custom.x - x;
    const dz = custom.z - z;
    const reach = radius + custom.radius;
    if (dx * dx + dz * dz <= reach * reach) out.unshift(custom);
    return out;
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------
  /** Effective structural HP of one building: tall blocks soak more punishment. */
  _hpFor(b) {
    const h = Number.isFinite(b.h) ? b.h : 0;
    return Math.max(40, Math.min(180, h * 2.2));
  }

  /**
   * Apply a blast at a world position.
   *
   * `splashRadius` is the lethal radius in metres; buildings whose centre is
   * within `splashRadius + max(w, d) * 0.4` take distance-falloff damage.
   * Heavy ordnance (`damage >= 40`: AIM-9, Mk-82, BFFG) levels everything in
   * that radius outright; light ordnance (20 mm GUN, 18) chips each building's
   * cumulative `buildingHp` until the block ignites and collapses. A permanent
   * scorch crater is added for `damage >= 15`, scaled by weapon class.
   *
   * Returns `{ destroyedCount, damagedCount, positions }` so callers can spawn
   * fires, smoke and toasts; the positions are the burning centre of each
   * building that started collapsing.
   */
  applyBlast(position, splashRadius = 30, damage = 100) {
    const px = Number.isFinite(position?.x) ? position.x : 0;
    const pz = Number.isFinite(position?.z) ? position.z : 0;
    const splash = Math.max(1, Number.isFinite(splashRadius) ? splashRadius : 30);
    const power = Number.isFinite(damage) ? Math.max(0, damage) : 100;
    const heavy = power >= 40; // AIM-9 / Mk-82 / BFFG level structures outright
    const result = { destroyedCount: 0, damagedCount: 0, positions: [] };

    // Weapon-scaled permanent craters: 20 mm scorch -> 160 m BFFG wasteland.
    if (power >= 15) {
      const r = craterRadiusFor(power, splash);
      this.craters.push({ x: px, y: terrainHeight(px, pz), z: pz, r, damage: power });
      while (this.craters.length > MAX_CRATERS) this.craters.shift();
      this._cratersDirty = true;
    }

    const near = this._settlementsNear(px, pz, splash + 1600);
    for (const s of near) {
      for (const b of s.buildings) {
        const key = buildingKey(s, b);
        if (this.destroyed.has(key) || this.collapsing.has(key)) continue;
        const reach = splash + Math.max(b.w, b.d) * 0.4;
        const dx = b.x - px;
        const dz = b.z - pz;
        const dist2 = dx * dx + dz * dz;
        if (dist2 > reach * reach) continue;

        // Distance falloff, floored so the blast edge still hurts.
        const dist = Math.sqrt(dist2);
        const falloff = clamp(1 - dist / (reach + 1), 0.25, 1);
        const dmg = power * falloff;

        const hpMax = this._hpFor(b);
        const prevHp = this.buildingHp.has(key) ? this.buildingHp.get(key) : hpMax;
        if (!heavy && prevHp - dmg > 0) {
          // Small arms: accumulate structural damage and char the block a bit.
          const hp = prevHp - dmg;
          this.buildingHp.set(key, hp);
          result.damagedCount++;
          // Only re-instance when the scorch tier visibly changes.
          if (Math.ceil((hp / hpMax) * 3) !== Math.ceil((prevHp / hpMax) * 3)) {
            this._needsRebuild = true;
          }
          continue;
        }
        this.buildingHp.delete(key);

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
    if (result.destroyedCount > 0 || heavy) this._needsRebuild = true;
    return result;
  }

  /** Register a finished collapse as a smouldering ruin emitter (capped). */
  _registerRuinFire(c) {
    this.ruinFires.push({
      key: c.key,
      x: c.b.x,
      y: c.minY + 1.4 + Math.min(6, c.height * 0.08),
      z: c.b.z,
      t: 0,
      life: RUIN_FIRE_LIFE,
      seed: c.seed,
    });
    while (this.ruinFires.length > RUIN_FIRE_CAP) this.ruinFires.shift();
  }

  /**
   * World-space ember/smoke emitters for collapsed buildings that are still
   * smouldering. Each entry lives RUIN_FIRE_LIFE seconds (75 s) after its
   * collapse finished; the rubble itself is permanent.
   */
  getRuinFirePoints() {
    const out = [];
    for (const f of this.ruinFires) {
      const life = f.life || RUIN_FIRE_LIFE;
      const progress = clamp(life > 0 ? f.t / life : 1, 0, 1);
      out.push({
        x: f.x,
        y: f.y,
        z: f.z,
        age: f.t,
        life,
        progress,
        intensity: 1 - progress,
      });
    }
    return out;
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
    const near = this._settlementsNear(mx, mz, halfLen + 1600);

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

  /** Clear every destroyed building, in-flight collapse, partial damage and crater (mission reset / respawn). */
  resetDamage() {
    this.destroyed.clear();
    this.collapsing.clear();
    this.buildingHp.clear();
    this.ruinFires.length = 0;
    this.craters.length = 0;
    this._cratersDirty = true;
    this._needsRebuild = true;
    this.stats.destroyed = 0;
    this.stats.craters = 0;
    this.stats.ruinFires = 0;
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
  // Per-building distance streaming for the big baked OSM city
  // -------------------------------------------------------------------------
  /**
   * Buildings of `s` that should be drawn from the current camera position.
   *
   * Small procedural settlements return their list untouched. The large baked
   * OSM settlement streams per building: everything outside
   * `clamp(buildingRadius + alt * 5, buildingRadius, 24 km)` is skipped, so
   * flying into any of the ten valley towns always draws that town first, and
   * when more buildings are in range than the instance budget allows the
   * nearest ones win.
   *
   * @param {object} s settlement
   * @param {number} camX
   * @param {number} camZ
   * @param {number} radius stream radius in metres
   * @param {number} budget remaining instance slots
   * @returns {Array} buildings to instance
   */
  _streamBuildings(s, camX, camZ, radius, budget) {
    if (s.id !== CUSTOM_SETTLEMENT_ID && !(s.radius > LARGE_SETTLEMENT_MIN_SIZE)) {
      return s.buildings;
    }
    if (!(budget > 0)) return [];

    const r2 = radius * radius;
    const picks = [];
    for (const b of s.buildings) {
      const dx = b.x - camX;
      const dz = b.z - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      picks.push({ b, d2 });
    }
    if (picks.length > budget) {
      picks.sort((a, b) => a.d2 - b.d2);
      picks.length = budget;
    }
    const out = new Array(picks.length);
    for (let i = 0; i < picks.length; i++) out[i] = picks[i].b;
    return out;
  }

  // -------------------------------------------------------------------------
  // Rebuild the visible set around the camera
  // -------------------------------------------------------------------------
  rebuild(camera) {
    if (!this.scene || !camera) return;
    const alt = Math.max(0, camera.position.y);
    const baseRadius = this.preset.buildingRadius || 8000;
    const radius = clamp(baseRadius + alt * 5, baseRadius, LARGE_SETTLEMENT_RADIUS);
    const settlements = this._settlementsNear(camera.position.x, camera.position.z, radius);
    this._groundUse.clear();
    for (const s of settlements) {
      if (s.id === CUSTOM_SETTLEMENT_ID) continue; // real OSM city: no giant ground decal
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
    let rn = 0;
    let ln = 0;
    let colorDirty = false;
    let ruinColorDirty = false;

    const limit = this.preset.buildingLimit || 16000;
    const ruinLimit = this.ruinMesh ? this.ruinMesh.instanceMatrix.count : 0;
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

    // Ruin pieces go to their own instanced mesh (matrix + colour buffers are
    // independent, so they never disturb the standing-building instancing).
    const addRuinBox = (x, baseY, z, w, h, d, rot, color, tiltX = 0, tiltZ = 0) => {
      if (rn >= ruinLimit || !(h > 0) || !(w > 0) || !(d > 0)) return false;
      _p.set(x, baseY, z);
      _e.set(tiltX, rot || 0, tiltZ);
      _q.setFromEuler(_e);
      _s.set(w, h, d);
      _m.compose(_p, _q, _s);
      this.ruinMesh.setMatrixAt(rn, _m);
      _c.setHex(color).convertSRGBToLinear();
      this.ruinMesh.setColorAt(rn, _c);
      rn++;
      ruinColorDirty = true;
      return true;
    };

    for (const s of settlements) {
      const stream = this._streamBuildings(s, camera.position.x, camera.position.z, radius, limit - n);
      for (const b of stream) {
        if (n >= limit) break;
        const g = this._ground(b);
        const key = buildingKey(s, b);
        if (this.destroyed.has(key)) {
          // Permanent multi-piece ruin: jagged wall stubs, tilted slabs and a
          // scorched debris core where the tower used to be.
          this._addRuin(addRuinBox, b, g);
          continue;
        }
        const c = this.collapsing.get(key);
        if (c) {
          this._addCollapse(addBox, b, g, c);
          continue;
        }
        // Partially strafed blocks darken toward char as their HP drains.
        let tint = 1;
        const hp = this.buildingHp.get(key);
        if (hp !== undefined) {
          const ratio = clamp(hp / this._hpFor(b), 0, 1);
          tint = 0.58 + 0.42 * ratio;
        }
        this._addSilhouette(addBox, b, g.base, g.top, tint);
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.ruinMesh.count = rn;
    this.ruinMesh.instanceMatrix.needsUpdate = true;
    if (ruinColorDirty && this.ruinMesh.instanceColor) this.ruinMesh.instanceColor.needsUpdate = true;

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
    this.stats.ruins = rn;
  }

  // Ground floor `base` -> `top` boxes for one building, per kind.
  // `tint` (1 = pristine) darkens a block that has taken structural damage.
  _addSilhouette(addBox, b, base, top, tint = 1) {
    const h = top - base;
    const body = tint >= 0.999 ? b.color : shade(b.color, tint);
    const dark = shade(body, 0.72);
    switch (b.kind) {
      case 'tower': {
        // Wide podium, main shaft, stepped crown, plant room, spire.
        const podiumH = Math.min(h * 0.16, h - 2);
        addBox(b.x, base, b.z, b.w * 1.12, podiumH, b.d * 1.12, b.rot, body);
        addBox(b.x, base + podiumH, b.z, b.w, h - podiumH, b.d, b.rot, body);
        const crownH = Math.min(12, Math.max(2.5, h * 0.12));
        const cw = b.w * 0.72;
        const cd = b.d * 0.72;
        addBox(b.x, top, b.z, cw, crownH, cd, b.rot, body);
        addBox(b.x, top + crownH, b.z, cw * 0.34, 2.6, cd * 0.34, b.rot + 0.2, 0x545a5c);
        if (b.h > 75) {
          addBox(b.x, top + crownH + 2.6, b.z, 0.8, Math.min(14, b.h * 0.1), 0.8, b.rot, 0x6b7072);
        }
        break;
      }
      case 'apartment': {
        addBox(b.x, base, b.z, b.w, h, b.d, b.rot, body);
        // Rooftop parapet / utility penthouse.
        addBox(b.x, top, b.z, b.w * 0.82, Math.min(2.2, Math.max(1, h * 0.05)), b.d * 0.82, b.rot, shade(body, 0.85));
        break;
      }
      case 'industrial': {
        addBox(b.x, base, b.z, b.w, h, b.d, b.rot, body);
        // Clerestory roof monitor running the length of the hall.
        addBox(b.x, top, b.z, b.w * 0.42, 1.6, b.d * 0.88, b.rot, 0x6f736e);
        break;
      }
      case 'shed': {
        addBox(b.x, base, b.z, b.w, h, b.d, b.rot, body);
        addBox(b.x, top, b.z, b.w * 0.94, 0.7, b.d * 0.94, b.rot, dark);
        break;
      }
      default: {
        // house / shop: main block plus a darker stepped roof cap.
        addBox(b.x, base, b.z, b.w, h, b.d, b.rot, body);
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

  // Permanent ruin of one levelled building: a scorched debris core, 3-4
  // jagged broken wall stubs along the old footprint edge and two tilted
  // concrete slabs. Fully deterministic from the building position.
  _addRuin(addBox, b, g) {
    const base = g.base;
    const rx = Math.round(b.x);
    const rz = Math.round(b.z);
    const h1 = hash2(rx, rz, 0x9e3779b1);
    const h2 = hash2(rz, rx, 0x85ebca6b);
    const h3 = hash2(rx + 17, rz - 31, 0xc2b2ae35);
    const h4 = hash2(rx - 53, rz + 11, 0x27d4eb2f);
    const hw = b.w * 0.5;
    const hd = b.d * 0.5;
    const cos = Math.cos(b.rot);
    const sin = Math.sin(b.rot);

    // Dark scorched debris core: low, wide and slightly skewed off-axis.
    addBox(
      b.x, base, b.z,
      b.w * (0.84 + h1 * 0.14),
      0.8 + h2 * 1.3,
      b.d * (0.84 + h3 * 0.14),
      b.rot + (h4 - 0.5) * 0.22,
      0x1a1817,
    );

    // Broken perimeter walls: 3-4 chars of the old facade, each a tall stub
    // plus a smaller jagged chunk sheared off its top.
    const pieces = 3 + (h1 > 0.5 ? 1 : 0);
    for (let i = 0; i < pieces; i++) {
      const a = hash2(rx + i * 131, rz - i * 71, 0x5bd1e995);
      const c = hash2(rx - i * 37, rz + i * 113, 0x1b56c4e9);
      const alongX = (i & 1) === 0; // stub runs along a ±Z wall
      const sign = (i & 2) ? 1 : -1;
      let lx;
      let lz;
      if (alongX) {
        lx = (a - 0.5) * b.w * 0.84;
        lz = sign * hd;
      } else {
        lx = sign * hw;
        lz = (c - 0.5) * b.d * 0.84;
      }
      const wx = b.x + lx * cos - lz * sin;
      const wz = b.z + lx * sin + lz * cos;

      const span = alongX ? b.w : b.d;
      const len = span * (0.2 + a * 0.24);
      const thick = 0.9 + c * 0.9;
      const stubH = 2.2 + c * 4.6;
      const wallRot = b.rot + (a - 0.5) * 0.16;

      addBox(
        wx, base, wz,
        alongX ? len : thick,
        stubH,
        alongX ? thick : len,
        wallRot,
        i & 1 ? 0x33302b : 0x2a2724,
        (a - 0.5) * 0.16, (c - 0.5) * 0.16,
      );
      // Jagged break: a narrower, lower chunk hanging off the top.
      addBox(
        wx + (c - 0.5) * 1.4, base, wz + (a - 0.5) * 1.4,
        alongX ? len * (0.32 + c * 0.22) : thick * 0.85,
        stubH * (0.32 + a * 0.3),
        alongX ? thick * 0.85 : len * (0.32 + c * 0.22),
        wallRot + (c - 0.5) * 0.5,
        0x3b342d,
        (c - 0.5) * 0.42, (a - 0.5) * 0.42,
      );
    }

    // Two tilted concrete slabs lying in the debris field.
    for (let i = 0; i < 2; i++) {
      const t = hash2(rx + 300 + i * 91, rz - 200 + i * 53, 0x2545f491);
      const s = hash2(rz + 400 - i * 61, rx - 100 + i * 79, 0x7f4a7c15);
      addBox(
        b.x + (t - 0.5) * b.w * 0.55,
        base + 0.2,
        b.z + (s - 0.5) * b.d * 0.55,
        b.w * (0.22 + t * 0.18),
        0.5 + s * 0.4,
        b.d * (0.16 + s * 0.16),
        b.rot + (t - 0.5) * 1.6,
        i === 0 ? 0x4a443d : 0x3c3732,
        0.22 + t * 0.26, (s - 0.5) * 0.34,
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
    const RINGS = 18;
    const INNER = 12;
    const pos = [];
    const uv = [];
    const idx = [];
    for (const c of this.craters) {
      const base = pos.length / 3;
      const ground = Number.isFinite(c.y) ? c.y : terrainHeight(c.x, c.z);
      pos.push(c.x, ground - 0.55, c.z); // 0: bowl centre
      uv.push(0.5, 0.5);
      for (let i = 0; i < INNER; i++) {
        const a = (i / INNER) * Math.PI * 2;
        const rr = c.r * 0.55;
        const x = c.x + Math.cos(a) * rr;
        const z = c.z + Math.sin(a) * rr;
        pos.push(x, terrainHeight(x, z) - 0.25, z);
        uv.push(0.5 + Math.cos(a) * 0.275, 0.5 + Math.sin(a) * 0.275);
      }
      for (let i = 0; i < RINGS; i++) {
        const a = (i / RINGS) * Math.PI * 2;
        const x = c.x + Math.cos(a) * c.r;
        const z = c.z + Math.sin(a) * c.r;
        pos.push(x, terrainHeight(x, z) + 0.06, z);
        uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
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
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
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
    this.ruinMesh.geometry.dispose();
    this.roadMesh.geometry.dispose();
    this.roadMaterial.dispose();
    this.streetTexture?.dispose();
    this.lightMesh.geometry.dispose();
    this.lightMaterial.dispose();
    this.craterMesh.geometry.dispose();
    this.craterMaterial.dispose();
    this.craterTexture?.dispose();
    this.groundMaterial.map?.dispose();
    this.groundMaterial.dispose();
    this.mesh.removeFromParent();
    this.ruinMesh.removeFromParent();
    this.roadMesh.removeFromParent();
    this.lightMesh.removeFromParent();
    this.craterMesh.removeFromParent();
  }
}

// Permanent crater size per weapon class (metres of visible scorched ground).
function craterRadiusFor(damage, splash) {
  if (splash >= 200 || damage >= 2000) return 160; // BFFG ground zero
  if (damage >= 160) return 38; // Mk-82
  if (damage >= 100) return 18; // AIM-9
  if (damage >= 40) return 10; // heavy fragments
  // 20 mm strafing: a 4..6 m bullet scorch, ramping with impact energy.
  return 4 + clamp((damage - 15) / 25, 0, 1) * 2;
}

// Multiply an sRGB hex towards black for roof caps.
function shade(hex, k) {
  const r = clamp(Math.round(((hex >> 16) & 0xff) * k), 0, 255);
  const g = clamp(Math.round(((hex >> 8) & 0xff) * k), 0, 255);
  const b = clamp(Math.round((hex & 0xff) * k), 0, 255);
  return (r << 16) | (g << 8) | b;
}