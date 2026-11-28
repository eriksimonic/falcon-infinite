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
import { terrainHeight, getCustomAirports } from './terrain.js';
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
const SPATIAL_CELL_SIZE = 1000; // 1 km spatial hash cells for O(visible) queries
// PERF-11 / PKT-09: only buildings this close to the camera are allowed into
// the sun shadow map, through layer-1 proxy meshes that share the main
// instance buffers. Everything further out is drawn but casts no shadow, which
// the +-1,400 m shadow box cannot show anyway.
export const SHADOW_NEAR_R = 2400;
const CUSTOM_KINDS = ['house', 'apartment', 'industrial', 'tower', 'church', 'shed'];
// LJAJ (Ajdovscina) is a true East-West strip at the DEM centre: RWY 09/27 runs
// along +-X. Nothing built by OSM may sit on the pavement or the graded strip.
const LJAJ_RUNWAY_HALF_LENGTH_M = 960; // 1800 m runway + 60 m overrun either end
const LJAJ_RUNWAY_HALF_WIDTH_M = 95;   // 36 m runway + shoulders/apron clearance

// 4-tier procedural display/hide LOD thresholds (metres) per quality preset.
const LOD_THRESHOLDS = {
  low: { close: 2200, mid: 6500, far: 14000 },
  medium: { close: 3600, mid: 10500, far: 22000 },
  high: { close: 5000, mid: 14500, far: 28000 },
};

// Warm Vipava / Primorska / Adriatic regional wall palettes.
const CUSTOM_PALETTE = {
  house: [0xe0d1b5, 0xd6c3a1, 0xe4d5bf, 0xd0b28e, 0xc7b59a, 0xdbbe9e, 0xd1c5b2, 0xc5a687],
  apartment: [0xcec5b8, 0xc0bab0, 0xb6b0a4, 0xd4c9b4, 0xa5a39e, 0xc5b9aa],
  industrial: [0x9da09a, 0xa8a397, 0x8d918b, 0xb0a796, 0x94989a],
  tower: [0x8fa6ba, 0x7d93a8, 0xa6b8c6, 0x93a3b3, 0x8298a8, 0xb3c2cc],
  church: [0xdfd7c6, 0xd6cdb9, 0xe5ddcc, 0xcfc5b0],
  shed: [0xb9ae99, 0xa89d8a, 0xc2b59f, 0x9d9382],
};

// Weathered Primorska / Vipava roof palettes (sun-baked muted clay, dusty
// terracotta, aged taupe-grey tiles, slate & industrial metal — no candy red).
const ROOF_TERRACOTTA = [0x9a735c, 0x8f6652, 0xa37c62, 0x84604e, 0x916e59, 0x7d5d4e];
const ROOF_TAUPE = [0x7e7468, 0x72695f, 0x8a8073, 0x696259];
const ROOF_SLATE = [0x585b5e, 0x66686a, 0x4e5256, 0x6e6f6c];
const ROOF_INDUSTRIAL = [0x7c7f7e, 0x6c7072, 0x8a8b87, 0x5f6468];
const PLINTH_STONE = [0xa8a193, 0x9c9688, 0xb2aa9c, 0x928c7f];

const cellKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);

const _c = new THREE.Color();
// Scratch light colours for the per-frame sky uniforms: night ambient is a
// dark cool slate-blue and the moon fill is cool blue. Module-level so the
// update loop allocates nothing.
const _nightAmb = new THREE.Color(0.010, 0.014, 0.024);
const _moonCol = new THREE.Color(0.020, 0.030, 0.048);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

const buildingKey = (s, b) => `${s.id}:${Math.round(b.x)}:${Math.round(b.z)}`;

// ---------------------------------------------------------------------------
// Materials & procedural roof geometries
// ---------------------------------------------------------------------------
const BAYER_GLSL = /* glsl */`
  float bayer4(vec2 p) {
    vec2 f = floor(mod(p, 4.0));
    float m0 = mod(f.x, 2.0);
    float m1 = mod(f.y, 2.0);
    float m2 = floor(f.x * 0.5);
    float m3 = floor(f.y * 0.5);
    float v = mod(m0 + m1, 2.0) * 8.0 + m1 * 4.0 + mod(m2 + m3, 2.0) * 2.0 + m3;
    return (v + 0.5) / 16.0;
  }
`;

// Same Rayleigh + Mie aerial perspective as terrainview.js (VIPER-ATMOS) and
// water.js, so distant towns dissolve into the exact hazy blue valley air the
// hills sit in instead of reading as dark high-contrast blocks. `col` must
// still be linear HDR when this runs (immediately before gl_FragColor and the
// fog / tonemapping / colorspace includes).
// NOTE: at night `update()` copies the moon direction into uSunDir, so the
// daylight gate is `(1.0 - uNight)` rather than the sun elevation alone.
const AERIAL_HAZE_GLSL = /* glsl */`
  {
    float bDist = length(vWorld - cameraPosition);
    vec3 bViewDir = normalize(vWorld - cameraPosition);
    float dayVis = (1.0 - uNight) * smoothstep(-0.05, 0.25, uSunDir.y);
    float lowAir = 1.0 - smoothstep(100.0, 2600.0, 0.5 * (cameraPosition.y + vWorld.y));
    float aerialT = 1.0 - exp(-bDist * (0.000024 + lowAir * 0.000020));
    aerialT = clamp(aerialT * smoothstep(2500.0, 9000.0, bDist), 0.0, 0.72);
    vec3 rayleighBlue = mix(vec3(0.42, 0.58, 0.80), vec3(0.54, 0.68, 0.86),
      smoothstep(0.0, 0.5, uSunDir.y));
    rayleighBlue = mix(rayleighBlue, uSkyColor, 0.16 * dayVis);
    float sunAlign = max(dot(bViewDir, uSunDir), 0.0);
    float miePhase = pow(sunAlign, 4.0) * 0.65 + pow(sunAlign, 18.0) * 0.35;
    vec3 dustGlow = mix(vec3(0.92, 0.76, 0.56), uSunColor, 0.55);
    vec3 atmosCol = mix(rayleighBlue, dustGlow,
      clamp(miePhase * (0.45 + lowAir * 0.40), 0.0, 0.72));
    float distDesat = aerialT * 0.35 * dayVis;
    float bLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(bLum), distDesat);
    col = mix(col, atmosCol, aerialT * 0.62 * dayVis);
    col += dustGlow * miePhase * aerialT * 0.14 * dayVis * (0.5 + 0.5 * lowAir);
  }
`;

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
        uTime: { value: 0 },
        uCullDist: { value: 24000 },
        uSkyColor: { value: new THREE.Color(0x8fb4c8) },
      },
    ]),
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec3 vLocalN;
      varying vec3 vLocal;
      varying vec3 vScale;
      varying vec3 vCol;
      // Exact per-building identity straight off the instance translation: two
      // identical-looking houses in a row never share a window pattern.
      varying vec2 vInstXZ;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(instanceMatrix) * normal);
        vLocalN = normal;
        vLocal = position;
        vInstXZ = instanceMatrix[3].xz;
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
      uniform vec3 uSkyColor;
      uniform float uNight, uCullDist, uTime;
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec3 vLocalN;
      varying vec3 vLocal;
      varying vec3 vScale;
      varying vec3 vCol;
      varying vec2 vInstXZ;
      #include <common>
      #include <fog_pars_fragment>

      ${BAYER_GLSL}

      float h21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        float distXZ = length(vWorld.xz - cameraPosition.xz);
        float fade = smoothstep(uCullDist * 0.86, uCullDist, distXZ);
        if (fade > 0.001 && fade >= bayer4(gl_FragCoord.xy)) discard;

        vec3 n = normalize(vN);
        vec3 ln = normalize(vLocalN);
        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);
        // Balanced diffuse + sky fill prevents crushed shadows and ACES highlight clipping.
        vec3 col = vCol * (uAmbient * 1.15 + uSunColor * (ndl * 0.72 + wrap * 0.22));

        // Wall-aligned facade coordinates. The axis that runs *across* each
        // wall (local z for the ±X walls, local x for the ±Z walls) is taken in
        // real metres via the instance scale, so window columns stay crisp and
        // vertical on rotated buildings instead of smearing diagonally.
        float xFace = step(0.5, abs(ln.x));
        float wallSpan = mix(vLocal.x * vScale.x, vLocal.z * vScale.z, xFace);
        float u = wallSpan / 3.8;              // ~3.8 m wide window bays
        float v = (vLocal.y * vScale.y) / 3.4; // ~3.4 m floor pitch
        vec2 g = fract(vec2(u, v));
        // Screen-space derivative anti-aliasing. fwidth() gives the facade cell
        // size in pixels: it widens the cutouts into analytic smoothstep edges
        // up close, and drives an analytical Nyquist box filter that fades the
        // pattern to its average coverage once a bay shrinks below a pixel —
        // which is what stops distant facades from shimmering and sparkling.
        vec2 uvCell = vec2(u, v);
        vec2 fw = max(fwidth(uvCell), vec2(0.003));
        vec2 aa = clamp(fw * 0.75, vec2(0.004), vec2(0.24));
        float winX = smoothstep(0.21 - aa.x, 0.21 + aa.x, g.x) *
                     (1.0 - smoothstep(0.79 - aa.x, 0.79 + aa.x, g.x));
        float winY = smoothstep(0.32 - aa.y, 0.32 + aa.y, g.y) *
                     (1.0 - smoothstep(0.84 - aa.y, 0.84 + aa.y, g.y));
        float nyqX = smoothstep(0.30, 0.85, fw.x);
        float nyqY = smoothstep(0.30, 0.85, fw.y);
        float win = mix(winX, 0.58, nyqX) * mix(winY, 0.52, nyqY);
        vec2 cell = floor(vec2(u, v));
        float rnd = h21(cell + floor(vCol.xy * 97.0));
        float wall = 1.0 - smoothstep(0.55, 0.85, abs(ln.y));
        float glass = win * wall;

        // Crisp horizontal floor spandrel band under every row of windows, with the
        // same derivative anti-aliasing so it never aliases into a dashed ridge.
        float spandrelRaw = smoothstep(0.04 - aa.y, 0.04 + aa.y, g.y) *
                            (1.0 - smoothstep(0.19 - aa.y, 0.19 + aa.y, g.y));
        float spandrel = wall * mix(spandrelRaw, 0.15, nyqY);
        col *= 1.0 - spandrel * 0.22;

        float day = 1.0 - uNight;

        // Daylight: restrained, warm-neutral glass so Primorska stucco and
        // limestone read as masonry with subtle windows instead of bright blue
        // office glazing.
        vec3 skyGlass = mix(vec3(0.16, 0.20, 0.25), vec3(0.42, 0.50, 0.60),
                            clamp(wrap, 0.0, 1.0));
        col = mix(col, skyGlass, glass * 0.42 * day);

        // Sun-behind-pilot glint: only when the sun is behind the camera and
        // shining straight onto the facade in front do sun-facing windows
        // return a crisp specular flare (the only daytime building bloom).
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float sunBehind = smoothstep(0.45, 0.94, dot(viewDir, uSunDir));
        // Sub-pixel windows would otherwise fire a single-pixel specular flare
        // that reads as a shimmering firefly wall across a distant facade.
        float glintAA = 1.0 - max(nyqX, nyqY) * 0.80;
        col += uSunColor * glass * ndl * sunBehind * day * 0.95 * glintAA;

        // Night: unlit glass reads as a dark hole, lit rooms glow. Each building
        // hashes a stable seed off its own world translation, so neighbouring
        // houses with identical wall colours still light completely independent
        // rooms. Occupancy is realistic instead of decorative: a small Primorska
        // house shows one or two warm windows (and ~18% of houses are asleep
        // entirely), while a downtown apartment block lights ~25% of its bays.
        // Rooms also switch on and off slowly over uTime, with a sliver of rooms
        // lit by flickering television blue.
        col *= 1.0 - glass * 0.55 * uNight;
        // PERF-13: the per-building identity is declared before the night
        // branch because the roof shading below hashes buildingSeed too.
        // Everything that only feeds the lit-window emission sits inside the
        // branch and costs nothing by day (uNight == 0), where the previous
        // code still ran 9 h21 calls and 2 sin per facade pixel.
        vec2 instCell = floor(vInstXZ * 0.25);
        float buildingSeed = h21(instCell + floor(vCol.xy * 97.0) + 3.7);
        if (uNight > 0.001) {
          float isBig = clamp(smoothstep(10.0, 14.5, vScale.y) +
                              smoothstep(16.0, 24.0, max(vScale.x, vScale.z)), 0.0, 1.0);
          // Residential: 10..18% of bays lit, and roughly one house in five is
          // dark all night, which keeps village rows from glowing like a lantern.
          float resOcc = (0.10 + 0.08 * buildingSeed) *
                         step(0.18, h21(instCell + 19.3));
          // Larger blocks: 20..30% of bays lit, ~25% on average.
          float bigOcc = 0.20 + 0.10 * buildingSeed;
          float occupancy = mix(resOcc, bigOcc, isBig);

          float roomSeed = h21(cell * 1.37 + instCell + 11.3);
          // Every room rolls a fresh on/off state every 45-140 s and cross-fades
          // over the first ~1.5% of that period, so lights fade in and out over a
          // minute or two instead of popping or strobing.
          float swPeriod = 45.0 + 95.0 * h21(cell * 1.9 + instCell + 23.1);
          float swT = uTime / swPeriod + roomSeed * 17.0;
          float swRoll = floor(swT);
          float swFade = smoothstep(0.0, 0.015, fract(swT));
          float rollA = step(1.0 - occupancy,
                             h21(cell * 2.13 + instCell + swRoll * 7.7 + 31.7));
          float rollB = step(1.0 - occupancy,
                             h21(cell * 2.13 + instCell + (swRoll + 1.0) * 7.7 + 31.7));
          float lit = mix(rollA, rollB, swFade) * glass;
          // Palette in shares: ~46% tungsten, ~28% amber, ~14% cool LED/office and
          // ~12% television blue.
          float tone = h21(cell * 2.71 + instCell + 5.9);
          vec3 winColor = mix(vec3(1.0, 0.78, 0.42), vec3(1.0, 0.62, 0.25), step(0.46, tone));
          winColor = mix(winColor, vec3(0.78, 0.90, 1.0), step(0.74, tone));
          float isTV = step(0.88, tone);
          float rndTv = h21(cell * 3.83 + instCell + 47.9);
          // Two incommensurate sines give an organic living-room screen flicker
          // (never a hard strobe), and the glow drifts to cool cyan as it brightens.
          float tvWave = 0.70 + 0.30 * (0.5 + 0.5 * sin(uTime * (2.6 + rndTv * 2.8) + roomSeed * 41.0) * sin(uTime * 5.9 + rndTv * 17.0));
          vec3 tvColor = mix(vec3(0.34, 0.60, 1.0), vec3(0.36, 0.64, 1.0), tvWave);
          tvColor = mix(tvColor, vec3(0.68, 0.84, 1.0), tvWave * 0.45);
          winColor = mix(winColor, tvColor, isTV);
          // Wide per-room intensity spread: a dim bedside lamp (0.38) up to a
          // bright kitchen/living room (1.05). Overall emission sits ~20% below the
          // old 1.45x so facades read as lived-in, not floodlit.
          float brightness = 0.38 + 0.60 * h21(cell * 3.17 + instCell + 7.1) + 0.07 * rnd;
          col += winColor * lit * uNight * 1.15 * brightness;
        }

        // Ground contact ambient occlusion over the bottom of each block so every
        // building sits firmly anchored on the satellite imagery instead of
        // hovering, while still never crushing the wall to black.
        col *= mix(0.56, 1.0, smoothstep(0.0, 0.24, vLocal.y));

        // Vipava/Adriatic roofs: mostly weathered terracotta tiles with a
        // minority of dark slate, hashed per building, mottled per tile and lit
        // by the same sun so towns separate unmistakably from the muted ground.
        float roof = smoothstep(0.65, 0.95, abs(ln.y));
        vec2 rp = vec2(vLocal.x * vScale.x, vLocal.z * vScale.z) * 0.4;
        float mottle = h21(floor(rp) + floor(vCol.yz * 131.0));
        float tileGrain = h21(floor(rp * 5.0) + floor(vCol.yz * 57.0) + 2.3);
        // Roof island texels (tile grain, corrugation ribs) are far below a pixel
        // at distance: fade them to their mean instead of letting the hash noise
        // sparkle. roofDetailAA = 1 on screen, -> 0 once detail is sub-pixel.
        float roofDetailAA = 1.0 - smoothstep(0.12, 0.50, length(fwidth(rp)));
        float roofPick = h21(vec2(buildingSeed * 131.7 + 0.5, 7.3));

        // Small flat / terrace roofs: warm weathered terracotta and paler
        // weathered slate, never candy red and never crushed to black.
        vec3 terrace = mix(vec3(0.36, 0.21, 0.14), vec3(0.27, 0.16, 0.11), mottle);
        vec3 slate = mix(vec3(0.24, 0.25, 0.26), vec3(0.32, 0.31, 0.30), mottle);
        vec3 flatRoof = mix(terrace, slate, step(0.58, roofPick));
        flatRoof *= mix(1.0, 0.94 + 0.12 * tileGrain, roofDetailAA);

        // Large commercial / warehouse footprints read as weathered light-grey
        // corrugated steel or concrete gravel with rib lines and a darker
        // parapet rim, instead of the pitch-black industrial slabs a single
        // roof albedo produced.
        float isLarge = smoothstep(14.0, 22.0, max(vScale.x, vScale.z));
        float edgeDist = min((0.5 - abs(vLocal.x)) * vScale.x,
                             (0.5 - abs(vLocal.z)) * vScale.z);
        float parapet = 1.0 - smoothstep(0.30, 1.40, edgeDist);
        vec3 industrial = mix(vec3(0.36, 0.37, 0.36), vec3(0.48, 0.47, 0.45), mottle);
        industrial *= 1.0 + sin(rp.x * 14.0) * 0.03 * roofDetailAA;
        industrial *= 1.0 - parapet * 0.18;

        vec3 roofBase = mix(flatRoof, industrial, isLarge);
        vec3 roofCol = roofBase * (uAmbient * 1.12 + uSunColor * (ndl * 0.72 + wrap * 0.22));
        // Lift the big slabs slightly so the corrugation and gravel stay
        // legible in oblique views under ACES tone mapping.
        roofCol *= mix(1.0, 1.08, isLarge);
        col = mix(col, roofCol, roof);

        ${AERIAL_HAZE_GLSL}

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

// Weathered Karst limestone / retaining-wall foundation plinths (no windows).
function makePlinthMaterial() {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
        uSunColor: { value: new THREE.Color(0xfff2d8) },
        uAmbient: { value: new THREE.Color(0x334455) },
        uNight: { value: 0 },
        uCullDist: { value: 24000 },
        uSkyColor: { value: new THREE.Color(0x8fb4c8) },
      },
    ]),
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec3 vLocal;
      varying vec3 vScale;
      varying vec3 vCol;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(instanceMatrix) * normal);
        vLocal = position;
        vScale = vec3(
          length(instanceMatrix[0].xyz),
          length(instanceMatrix[1].xyz),
          length(instanceMatrix[2].xyz)
        );
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(0.55, 0.52, 0.46);
        #endif
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunColor, uAmbient;
      uniform vec3 uSkyColor;
      uniform float uNight, uCullDist;
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec3 vLocal;
      varying vec3 vScale;
      varying vec3 vCol;
      #include <common>
      #include <fog_pars_fragment>

      ${BAYER_GLSL}

      float h21(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 34.5);
        return fract(p.x * p.y);
      }

      void main() {
        float distXZ = length(vWorld.xz - cameraPosition.xz);
        float fade = smoothstep(uCullDist * 0.86, uCullDist, distXZ);
        if (fade > 0.001 && fade >= bayer4(gl_FragCoord.xy)) discard;

        vec3 n = normalize(vN);
        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);

        // Dressed Karst stone courses (subtle horizontal beds + block variation).
        float courseY = floor(vWorld.y / 0.85);
        float blockX = floor((vWorld.x + vWorld.z) / 1.6 + mod(courseY, 2.0) * 0.5);
        float stoneVar = 0.86 + 0.24 * h21(vec2(blockX, courseY));
        float mortarY = smoothstep(0.0, 0.12, fract(vWorld.y / 0.85));
        vec3 base = vCol * stoneVar * (0.86 + 0.14 * mortarY);

        vec3 col = base * (uAmbient * 1.10 + uSunColor * (ndl * 0.68 + wrap * 0.22));
        // Ground contact darkening along the base of the retaining wall.
        col *= mix(0.76, 1.0, smoothstep(0.0, 0.35, vLocal.y));
        col *= 1.0 - uNight * 0.25;

        ${AERIAL_HAZE_GLSL}

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

// 3D pitched terracotta / dark slate / industrial metal roof shader.
function makeRoofMaterial() {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
        uSunColor: { value: new THREE.Color(0xfff2d8) },
        uAmbient: { value: new THREE.Color(0x334455) },
        uNight: { value: 0 },
        uCullDist: { value: 24000 },
        uSkyColor: { value: new THREE.Color(0x8fb4c8) },
      },
    ]),
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec3 vLocal;
      varying vec3 vScale;
      varying vec3 vCol;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        // Correct normal transform under non-uniform instance scale (pitch rise).
        vec3 sx = vec3(
          length(instanceMatrix[0].xyz),
          length(instanceMatrix[1].xyz),
          length(instanceMatrix[2].xyz)
        );
        vScale = sx;
        vec3 invS = vec3(1.0 / max(sx.x, 0.01), 1.0 / max(sx.y, 0.01), 1.0 / max(sx.z, 0.01));
        vec3 rotN = mat3(
          instanceMatrix[0].xyz * invS.x,
          instanceMatrix[1].xyz * invS.y,
          instanceMatrix[2].xyz * invS.z
        ) * (normal * invS);
        vN = normalize(rotN);
        vLocal = position;
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(0.52, 0.24, 0.16);
        #endif
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunColor, uAmbient;
      uniform vec3 uSkyColor;
      uniform float uNight, uCullDist;
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec3 vLocal;
      varying vec3 vScale;
      varying vec3 vCol;
      #include <common>
      #include <fog_pars_fragment>

      ${BAYER_GLSL}

      float h21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        float distXZ = length(vWorld.xz - cameraPosition.xz);
        float fade = smoothstep(uCullDist * 0.86, uCullDist, distXZ);
        if (fade > 0.001 && fade >= bayer4(gl_FragCoord.xy)) discard;

        vec3 n = normalize(vN);
        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);

        // Tile courses, fine tile grain and a soft ridge-to-eave AO so pitched
        // roofs read as modelled clay tiles instead of flat planes. The lift
        // keeps weathered terracotta/taupe/slate bright in oblique views under
        // ACES tone mapping instead of crushing towards black.
        vec2 rp = vec2(vLocal.x * vScale.x, vLocal.z * vScale.z);
        float course = 0.93 + 0.07 * sin(vLocal.y * vScale.y * 14.0);
        float mottle = 0.90 + 0.18 * h21(floor(rp * 0.8) + floor(vCol.rg * 83.0));
        float grain = 0.94 + 0.12 * h21(floor(rp * 6.0) + floor(vCol.gb * 57.0) + 1.7);
        float ridgeAO = mix(0.84, 1.06, clamp(vLocal.y, 0.0, 1.0));
        vec3 base = vCol * course * mottle * grain * ridgeAO * 1.05;
        float lum = dot(base, vec3(0.299, 0.587, 0.114));
        base = mix(base, vec3(lum), 0.12);

        vec3 col = base * (uAmbient * 1.14 + uSunColor * (ndl * 0.72 + wrap * 0.22));
        // Warm-neutral sky bounce on the roof plane: without it the shaded
        // slate/industrial slopes crush to near-black once ACES tone mapping
        // compresses them, and a cool fill would grey out the clay tiles.
        vec3 skyFill = vec3(0.74, 0.70, 0.64) * (0.05 + 0.05 * wrap);
        col += skyFill * (1.0 - uNight);
        col *= 1.04;
        col *= 1.0 - uNight * 0.20;

        ${AERIAL_HAZE_GLSL}

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

// Pure procedural triangular prism: width 1 (X), height 1 (Y in [0..1]),
// depth 1 (Z), ridge along Z. Used for Primorska gable roofs & industrial halls.
function makeGableRoofGeometry() {
  const sn = 1 / Math.hypot(1, 0.5);
  const nx = 1 * sn;
  const ny = 0.5 * sn;
  const positions = new Float32Array([
    // Left slope (-X facing)
    -0.5, 0, -0.5,  -0.5, 0,  0.5,   0.0, 1,  0.5,
    -0.5, 0, -0.5,   0.0, 1,  0.5,   0.0, 1, -0.5,
    // Right slope (+X facing)
     0.5, 0, -0.5,   0.0, 1, -0.5,   0.0, 1,  0.5,
     0.5, 0, -0.5,   0.0, 1,  0.5,   0.5, 0,  0.5,
    // Front gable (+Z)
    -0.5, 0,  0.5,   0.5, 0,  0.5,   0.0, 1,  0.5,
    // Back gable (-Z)
     0.5, 0, -0.5,  -0.5, 0, -0.5,   0.0, 1, -0.5,
    // Bottom cap (-Y)
    -0.5, 0, -0.5,   0.5, 0, -0.5,   0.5, 0,  0.5,
    -0.5, 0, -0.5,   0.5, 0,  0.5,  -0.5, 0,  0.5,
  ]);
  const normals = new Float32Array([
    -nx, ny, 0,  -nx, ny, 0,  -nx, ny, 0,
    -nx, ny, 0,  -nx, ny, 0,  -nx, ny, 0,
     nx, ny, 0,   nx, ny, 0,   nx, ny, 0,
     nx, ny, 0,   nx, ny, 0,   nx, ny, 0,
      0,  0, 1,    0,  0, 1,    0,  0, 1,
      0,  0, -1,   0,  0, -1,   0,  0, -1,
      0, -1, 0,    0, -1, 0,    0, -1, 0,
      0, -1, 0,    0, -1, 0,    0, -1, 0,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.computeBoundingSphere();
  return geo;
}

// Pure procedural 4-sided pyramid / hipped roof: width 1, height 1 [0..1], depth 1.
function makeHipRoofGeometry() {
  const sn = 1 / Math.hypot(1, 0.5);
  const nh = 1 * sn;
  const ny = 0.5 * sn;
  const positions = new Float32Array([
    // Front (+Z)
    -0.5, 0,  0.5,   0.5, 0,  0.5,   0.0, 1,  0.0,
    // Right (+X)
     0.5, 0,  0.5,   0.5, 0, -0.5,   0.0, 1,  0.0,
    // Back (-Z)
     0.5, 0, -0.5,  -0.5, 0, -0.5,   0.0, 1,  0.0,
    // Left (-X)
    -0.5, 0, -0.5,  -0.5, 0,  0.5,   0.0, 1,  0.0,
    // Bottom (-Y)
    -0.5, 0, -0.5,   0.5, 0, -0.5,   0.5, 0,  0.5,
    -0.5, 0, -0.5,   0.5, 0,  0.5,  -0.5, 0,  0.5,
  ]);
  const normals = new Float32Array([
      0, ny,  nh,    0, ny,  nh,    0, ny,  nh,
     nh, ny,   0,   nh, ny,   0,   nh, ny,   0,
      0, ny, -nh,    0, ny, -nh,    0, ny, -nh,
    -nh, ny,   0,  -nh, ny,   0,  -nh, ny,   0,
      0, -1,   0,    0, -1,   0,    0, -1,   0,
      0, -1,   0,    0, -1,   0,    0, -1,   0,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.computeBoundingSphere();
  return geo;
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
  ctx.fillStyle = '#8a8679';
  ctx.fillRect(0, 0, S, S);
  const rng = (() => { let a = 987654321; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; })();
  for (let i = 0; i < 2600; i++) {
    const v = 104 + Math.floor(rng() * 44);
    ctx.fillStyle = `rgba(${v + 4},${v + 2},${v - 6},${0.08 + rng() * 0.26})`;
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
      lod: { close: 0, mid: 0, far: 0, roofs: 0, plinths: 0 },
    };

    // Everything below needs a scene; in Node we stop here (headless-safe).
    this.mesh = null;
    this.plinthMesh = null;
    this.gableRoofMesh = null;
    this.hipRoofMesh = null;
    // Layer-1 shadow proxies (PERF-11): identical draws of the four pools that
    // only the sun's shadow camera sees, capped to the near ring.
    this.shadowMesh = null;
    this.plinthShadowMesh = null;
    this.gableRoofShadowMesh = null;
    this.hipRoofShadowMesh = null;
    this.plinthMaterial = null;
    this.roofMaterial = null;
    this.roadMesh = null;
    this.craterMesh = null;
    this.lightMesh = null;
    this.ruinMesh = null;
    this.collapseMesh = null;
    this.craterTexture = null;
    this.groundMaterial = null;
    this.grounds = new Map();
    this._groundUse = new Set();
    // Upload bookkeeping: how many instances each pool drew on its last
    // upload, so an empty pool does not re-upload its whole allocation.
    this._prevCounts = { mesh: 0, plinth: 0, gable: 0, hip: 0, ruin: 0, light: 0, collapse: 0 };
    if (!this.scene) {
      this._lastX = Infinity;
      this._lastZ = Infinity;
      this._lastAlt = Infinity;
      this._colorInit = false;
      return;
    }

    // Allocate the instanced pools to hold at least High quality (26k) so
    // runtime quality switches never exceed the allocated WebGL buffers.
    const poolCap = Math.max(26000, this.preset.buildingLimit || 16000);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    this.material = makeBuildingMaterial();
    this.mesh = new THREE.InstancedMesh(geo, this.material, poolCap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = 'buildings';
    // Instanced depth material means every block casts a real-time shadow onto
    // the satellite-draped terrain; the custom shader never samples the shadow
    // map itself, so receiving is explicitly off. The mesh itself no longer
    // casts (PERF-11): the layer-1 `shadowMesh` proxy below does, capped to the
    // buildings near enough to land inside the sun shadow box.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.scene.add(this.mesh);

    // Batched weathered Karst stone foundation plinths (windowless, grounding
    // hillside buildings naturally without stretching window facades).
    const plinthGeo = new THREE.BoxGeometry(1, 1, 1);
    plinthGeo.translate(0, 0.5, 0);
    this.plinthMaterial = makePlinthMaterial();
    this.plinthMesh = new THREE.InstancedMesh(plinthGeo, this.plinthMaterial, poolCap);
    this.plinthMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.plinthMesh.frustumCulled = false;
    this.plinthMesh.count = 0;
    this.plinthMesh.name = 'building-plinths';
    this.plinthMesh.castShadow = false;
    this.plinthMesh.receiveShadow = false;
    this.scene.add(this.plinthMesh);

    // Batched 3D pitched gable roofs & hipped roofs / church spires.
    this.roofMaterial = makeRoofMaterial();
    this.gableRoofMesh = new THREE.InstancedMesh(makeGableRoofGeometry(), this.roofMaterial, poolCap);
    this.gableRoofMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.gableRoofMesh.frustumCulled = false;
    this.gableRoofMesh.count = 0;
    this.gableRoofMesh.name = 'building-gable-roofs';
    this.gableRoofMesh.castShadow = false;
    this.gableRoofMesh.receiveShadow = false;
    this.scene.add(this.gableRoofMesh);

    this.hipRoofMesh = new THREE.InstancedMesh(makeHipRoofGeometry(), this.roofMaterial, Math.max(8000, Math.floor(poolCap * 0.5)));
    this.hipRoofMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.hipRoofMesh.frustumCulled = false;
    this.hipRoofMesh.count = 0;
    this.hipRoofMesh.name = 'building-hip-roofs';
    this.hipRoofMesh.castShadow = false;
    this.hipRoofMesh.receiveShadow = false;
    this.scene.add(this.hipRoofMesh);

    // Layer-1 shadow proxies (PERF-11 / PKT-09). Each proxy is the same
    // geometry, material and capacity as its main pool, and it *shares* the
    // main `instanceMatrix` buffer instead of owning one, so the shadow pass
    // costs no extra upload. `layers.set(1)` puts a proxy on layer 1 only: the
    // main camera (layer 0) never draws it, while the sun's shadow camera
    // enables layer 1 (PKT-04 in sky.js) and does. `count` covers only the near
    // ring written first in rebuild(), which is all that can land inside the
    // +-1,400 m shadow box; the remaining ~90 % of building triangles leave the
    // shadow pass entirely.
    const makeShadowProxy = (main, name) => {
      const proxy = new THREE.InstancedMesh(main.geometry, main.material, main.instanceMatrix.count);
      proxy.instanceMatrix = main.instanceMatrix;
      proxy.layers.set(1);
      proxy.castShadow = true;
      proxy.receiveShadow = false;
      proxy.frustumCulled = false;
      proxy.count = 0;
      proxy.name = name;
      this.scene.add(proxy);
      return proxy;
    };
    this.shadowMesh = makeShadowProxy(this.mesh, 'buildings-shadow');
    this.plinthShadowMesh = makeShadowProxy(this.plinthMesh, 'building-plinths-shadow');
    this.gableRoofShadowMesh = makeShadowProxy(this.gableRoofMesh, 'building-gable-roofs-shadow');
    this.hipRoofShadowMesh = makeShadowProxy(this.hipRoofMesh, 'building-hip-roofs-shadow');

    // Ruined footprints live in their own instanced mesh: a bombed block is
    // drawn as a multi-piece debris field (wall stubs, slabs, core) without
    // inflating the standing-building instance budget.
    const ruinGeo = new THREE.BoxGeometry(1, 1, 1);
    ruinGeo.translate(0, 0.5, 0);
    this.ruinMesh = new THREE.InstancedMesh(
      ruinGeo,
      this.material,
      Math.max(2000, this.preset.ruinLimit || poolCap),
    );
    this.ruinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ruinMesh.frustumCulled = false;
    this.ruinMesh.count = 0;
    this.ruinMesh.name = 'ruin-pieces';
    // Rubble keeps casting (PERF-11 leaves collapseMesh and ruinMesh on the
    // main layer 0, both small pools).
    this.ruinMesh.castShadow = true;
    this.scene.add(this.ruinMesh);

    // Dedicated pool for the handful of buildings that are mid-collapse. They
    // used to be re-instanced into the main city mesh, which forced a full city
    // rebuild on every frame of a 2.4-3.8 s collapse (PERF-03): the city mesh is
    // now rebuilt once when the collapse starts and once when it ends, while the
    // burning block animates inside this small pool.
    const collapseCap = 512;
    this.collapseMesh = new THREE.InstancedMesh(geo, this.material, collapseCap);
    this.collapseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.collapseMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(collapseCap * 3).fill(1), 3,
    );
    this.collapseMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.collapseMesh.frustumCulled = false;
    this.collapseMesh.count = 0;
    this.collapseMesh.name = 'building-collapse';
    this.collapseMesh.castShadow = true;
    this.collapseMesh.receiveShadow = false;
    this.scene.add(this.collapseMesh);

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
      opacity: 0.18,
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

    // Night windows switch rooms on and off over real time, so the shader needs
    // a clock that advances even headlessly (no camera, no sky, no scene).
    if (this.material && this.material.uniforms.uTime) {
      this.material.uniforms.uTime.value += step;
    }

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
      let finished = false;
      for (const [key, c] of this.collapsing) {
        c.t += step;
        if (c.t >= c.duration) {
          this.collapsing.delete(key);
          this.destroyed.add(key);
          this._registerRuinFire(c);
          finished = true;
        }
      }
      // The burn/fall animation lives in its own small pool, so it can advance
      // without re-streaming the city. Only a finished collapse changes the
      // standing set (intact block out, permanent ruin in) and needs a rebuild.
      this._updateCollapseMesh();
      if (finished) this._needsRebuild = true;
      this.stats.destroyed = this.destroyed.size + this.collapsing.size;
    }
    this.stats.ruinFires = this.ruinFires.length;

    if (!this.scene) return;
    // Fresh scorch marks arrive every few frames while strafing: rebuild the
    // (cheap) crater mesh on its own instead of re-instancing every building.
    if (this._cratersDirty && !this._needsRebuild) this._rebuildCraters();
    if (!camera) return;
    if (sky) {
      // The sunlight colour in sky.js stays saturated orange-red even after the
      // sun drops below the horizon (only the DirectionalLight intensity dies),
      // so attenuate it ourselves — otherwise the underground sun lights every
      // wall, plinth and roof bright red in pitch darkness.
      const night = clamp(sky.night || 0, 0, 1);
      const sunElev = Number.isFinite(sky.sunElevation) ? sky.sunElevation : (sky.sunDir?.y ?? 0.5);
      const tSun = clamp((sunElev + 0.02) / 0.22, 0, 1);
      const sunVis = tSun * tSun * (3 - 2 * tSun);
      const moonElev = sky.moonDir ? sky.moonDir.y : 0.4;
      const tMoon = clamp((moonElev + 0.05) / 0.30, 0, 1);
      const moonVis = night * (1 - sunVis) * (tMoon * tMoon * (3 - 2 * tMoon));
      for (const mat of [this.material, this.plinthMaterial, this.roofMaterial]) {
        if (!mat) continue;
        if (sunVis > 0.005) {
          mat.uniforms.uSunDir.value.copy(sky.sunDir);
          mat.uniforms.uSunColor.value.copy(sky.sunColor).multiplyScalar(sunVis);
        } else {
          if (sky.moonDir) mat.uniforms.uSunDir.value.copy(sky.moonDir);
          mat.uniforms.uSunColor.value.copy(_moonCol).multiplyScalar(moonVis);
        }
        // Daytime ambient is untouched; at night it fades to dark cool slate
        // blue instead of warm bright neutral grey.
        mat.uniforms.uAmbient.value
          .copy(sky.skyColor)
          .multiplyScalar(0.65)
          .addScalar(0.18)
          .lerp(_nightAmb, night);
        mat.uniforms.uNight.value = night;
        if (mat.uniforms.uSkyColor && sky.skyColor) mat.uniforms.uSkyColor.value.copy(sky.skyColor);
      }
      this.lightMaterial.opacity = clamp(sky.night * 1.08, 0, 0.80);
      this.lightMesh.visible = sky.night > 0.12 && this.lightMesh.count > 0;
    }

    const dx = camera.position.x - this._lastX;
    const dz = camera.position.z - this._lastZ;
    const dAlt = Math.abs(camera.position.y - this._lastAlt);
    if (dx * dx + dz * dz > 250 * 250 || dAlt > 650 || this._needsRebuild) {
      this.rebuild(camera);
    }
  }

  // -------------------------------------------------------------------------
  // Baked real-world city (OSM)
  // -------------------------------------------------------------------------
  /**
   * Swap the procedural city for a baked real-world building set.
   *
   * Accepts both legacy 7-element tuples `[x, z, w, d, h, rot, kindCode]` and
   * compact binary 10-element tuples
   * `[x, z, w, d, h, rot, kindCode, roofCode, tier, colorSeed]`.
   * Builds a 1 km spatial chunk index so 50k+ buildings stream in O(visible).
   *
   * Passing `null` (or an empty list) reverts cleanly to procedural cities.
   *
   * @param {Array<number[]>|null} rawList
   * @param {Array|null} urbanZones optional town/village ground footprints
   * @returns {object|null} the virtual settlement, or null when reverting
   */
  setCustomBuildings(rawList, urbanZones = null) {
    if (!Array.isArray(rawList) || rawList.length === 0) {
      this.customSettlement = null;
      this._needsRebuild = true;
      return null;
    }

    // Prepare runway exclusion strips for every active custom airport (in
    // addition to the fixed LJAJ strip at the DEM centre).
    const customAps = getCustomAirports();
    const apStrips = [];
    if (Array.isArray(customAps)) {
      for (const ap of customAps) {
        if (!ap || !Number.isFinite(ap.x) || !Number.isFinite(ap.z)) continue;
        const rad = ((Number(ap.heading) || 0) * Math.PI) / 180;
        const halfLen = (Number(ap.length) || 1600) * 0.5 + 80;
        const halfWid = Math.max((Number(ap.width) || 36) * 1.5, 65);
        apStrips.push({
          x: ap.x,
          z: ap.z,
          dirX: Math.sin(rad),
          dirZ: -Math.cos(rad),
          halfLen,
          halfWid,
        });
      }
    }

    const buildings = [];
    const cells = new Map();
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
      // When no custom airport list is installed (headless unit tests), keep
      // the fallback LJAJ runway-strip exclusion at the DEM centre; when real
      // custom airports ARE active, exclude along each airport's exact runway
      // and apron footprint so downtown Ajdovščina is never clipped.
      if (apStrips.length === 0) {
        if (Math.abs(x) < LJAJ_RUNWAY_HALF_LENGTH_M && Math.abs(z) < LJAJ_RUNWAY_HALF_WIDTH_M) continue;
      } else {
        let onRunway = false;
        for (let ai = 0; ai < apStrips.length; ai++) {
          const st = apStrips[ai];
          const dx = x - st.x;
          const dz = z - st.z;
          const along = dx * st.dirX + dz * st.dirZ;
          const across = -dx * st.dirZ + dz * st.dirX;
          if (Math.abs(along) < st.halfLen && Math.abs(across) < st.halfWid) {
            onRunway = true;
            break;
          }
        }
        if (onRunway) continue;
      }

      const kindCode = Math.floor(Number(item[6])) | 0;
      const kind = CUSTOM_KINDS[kindCode] || 'house';
      const palette = CUSTOM_PALETTE[kind] || CUSTOM_PALETTE.house;

      const area = w * d;
      let roofCode;
      if (item.length >= 8 && Number.isFinite(Number(item[7]))) {
        roofCode = Math.floor(Number(item[7])) | 0;
      } else if (kind === 'church') roofCode = 4;
      else if (kind === 'industrial') roofCode = 3;
      else if (kind === 'tower' || (kind === 'apartment' && h >= 14)) roofCode = 2;
      else roofCode = 0;

      let tier;
      if (item.length >= 9 && Number.isFinite(Number(item[8]))) {
        tier = clamp(Math.floor(Number(item[8])) | 0, 0, 2);
      } else if (kind === 'church' || kind === 'tower' || h >= 12 || area >= 320) {
        tier = 2;
      } else if (kind === 'shed' || area < 55) {
        tier = 0;
      } else {
        tier = 1;
      }

      const colorSeed = item.length >= 10 && Number.isFinite(Number(item[9]))
        ? (Math.floor(Number(item[9])) & 255)
        : Math.floor(hash2(Math.round(x), Math.round(z), 0x51ed270b) * 256);

      const b = {
        x,
        z,
        w,
        d,
        h,
        rot,
        kind,
        roofCode,
        tier,
        colorSeed,
        color: palette[colorSeed % palette.length],
      };
      buildings.push(b);

      const cx = Math.floor(x / SPATIAL_CELL_SIZE);
      const cz = Math.floor(z / SPATIAL_CELL_SIZE);
      const ck = cellKey(cx, cz);
      let bucket = cells.get(ck);
      if (!bucket) {
        bucket = [];
        cells.set(ck, bucket);
      }
      bucket.push(b);
    }

    const zones = [];
    if (Array.isArray(urbanZones)) {
      for (let i = 0; i < urbanZones.length; i++) {
        const zItem = urbanZones[i];
        if (!zItem) continue;
        const zx = Array.isArray(zItem) ? Number(zItem[0]) : Number(zItem.x);
        const zz = Array.isArray(zItem) ? Number(zItem[1]) : Number(zItem.z);
        const zr = Array.isArray(zItem) ? Number(zItem[2]) : Number(zItem.radius ?? zItem.r);
        const zd = Array.isArray(zItem) ? Number(zItem[3] ?? 1) : Number(zItem.density ?? 1);
        if (!Number.isFinite(zx) || !Number.isFinite(zz) || !(zr > 20)) continue;
        zones.push({
          id: `uz:${i}`,
          x: zx,
          z: zz,
          radius: Math.min(zr * 0.72, 280),
          density: Number.isFinite(zd) ? zd : 1,
        });
      }
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
      cells,
      urbanZones: zones,
      roads: [],
    };
    this._needsRebuild = true;
    return this.customSettlement;
  }

  /** Iterate buildings of `s` overlapping the square `(cx ± r, cz ± r)`. */
  _buildingsInBox(s, cx, cz, r) {
    if (!s.cells) return s.buildings;
    const x0 = Math.floor((cx - r) / SPATIAL_CELL_SIZE);
    const x1 = Math.floor((cx + r) / SPATIAL_CELL_SIZE);
    const z0 = Math.floor((cz - r) / SPATIAL_CELL_SIZE);
    const z1 = Math.floor((cz + r) / SPATIAL_CELL_SIZE);
    const out = [];
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const bucket = s.cells.get(cellKey(ix, iz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }

  /**
   * Settlements visible in the query circle, with the baked OSM city swapped in.
   * While it is active the real-world theater owns the whole map: no invented
   * procedural grid is returned at any distance, because the baked DEM/ortho
   * (and the live Terrarium stream) now covers coasts, sea and far terrain that
   * the procedural site cache once treated as dry land.
   */
  _settlementsNear(x, z, radius) {
    const custom = this.customSettlement;
    if (!custom) return settlementsNear(x, z, radius);

    const dx = custom.x - x;
    const dz = custom.z - z;
    const reach = radius + custom.radius;
    return dx * dx + dz * dz <= reach * reach ? [custom] : [];
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
      const candidates = s.cells ? this._buildingsInBox(s, px, pz, splash + 140) : s.buildings;
      for (const b of candidates) {
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

      const candidates = s.cells ? this._buildingsInBox(s, mx, mz, halfLen + 140) : s.buildings;
      for (const b of candidates) {
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
    this._updateCollapseMesh(); // drops the collapse pool back to 0 instances
    this.buildingHp.clear();
    this.ruinFires.length = 0;
    this.craters.length = 0;
    this._cratersDirty = true;
    this._needsRebuild = true;
    this.stats.destroyed = 0;
    this.stats.craters = 0;
    this.stats.ruinFires = 0;
  }

  /**
   * Drop cached building ground elevations so rebuild() re-samples edited
   * terrain. Called after a height stroke, undo, import or reset.
   */
  invalidateGroundCache() {
    this._groundCache = new WeakMap();
    this._lastX = Infinity;
    this._lastZ = Infinity;
  }

  // -------------------------------------------------------------------------
  // Grounding cache: 5-point rotated corners + center + terrain-LOD sag margin.
  // -------------------------------------------------------------------------
  _ground(b) {
    let g = this._groundCache.get(b);
    if (g) return g;
    const c = Math.cos(b.rot);
    const s = Math.sin(b.rot);
    const hw = b.w * 0.5;
    const hd = b.d * 0.5;
    // Exact Three.js Euler(0, rot, 0) world transform:
    //   wx = x + su * cos(rot) + sv * sin(rot)
    //   wz = z - su * sin(rot) + sv * cos(rot)
    const h0 = terrainHeight(b.x - hw * c - hd * s, b.z + hw * s - hd * c);
    const h1 = terrainHeight(b.x + hw * c - hd * s, b.z - hw * s - hd * c);
    const h2 = terrainHeight(b.x - hw * c + hd * s, b.z + hw * s + hd * c);
    const h3 = terrainHeight(b.x + hw * c + hd * s, b.z - hw * s + hd * c);
    const centerH = terrainHeight(b.x, b.z);

    let lo = h0;
    if (h1 < lo) lo = h1;
    if (h2 < lo) lo = h2;
    if (h3 < lo) lo = h3;
    if (centerH < lo) lo = centerH;

    let hi = h0;
    if (h1 > hi) hi = h1;
    if (h2 > hi) hi = h2;
    if (h3 > hi) hi = h3;
    if (centerH > hi) hi = centerH;

    const avgCorner = (h0 + h1 + h2 + h3) * 0.25;
    const curvMargin = Math.abs(centerH - avgCorner) * 1.5;
    const slopeRelief = hi - lo;
    const plinthDepth = Math.max(6.0, Math.min(36.0, 4.5 + slopeRelief * 0.55 + curvMargin * 2.0));

    let floorY;
    if (slopeRelief <= 3.0) {
      floorY = lo + slopeRelief * 0.35;
    } else {
      floorY = Math.max(centerH, hi - Math.min(b.h * 0.45, 3.2));
    }
    // Guarantee the roof is never buried below the uphill corner (even for
    // short sheds on steep terrain) while keeping habitable walls proportional.
    const minRoofClear = Math.min(b.h * 0.72, 1.8);
    if (floorY + b.h < hi + minRoofClear) {
      floorY = hi + minRoofClear - b.h;
    }
    if (floorY < lo) floorY = lo;

    const plinthBase = lo - plinthDepth;
    g = {
      base: plinthBase,
      floorY,
      top: floorY + b.h,
      ground: lo,
      hi,
      relief: slopeRelief,
    };
    this._groundCache.set(b, g);
    return g;
  }

  // -------------------------------------------------------------------------
  // Per-building distance streaming for the big baked OSM city
  // -------------------------------------------------------------------------
  /**
   * Buildings of `s` that should be drawn from the current camera position.
   *
   * Uses the 1 km spatial cell index when present (`O(visible cells)` instead
   * of scanning 50k+ buildings). Returns buildings within `radius` capped to
   * the nearest `budget`.
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
    if (s.cells) {
      const x0 = Math.floor((camX - radius) / SPATIAL_CELL_SIZE);
      const x1 = Math.floor((camX + radius) / SPATIAL_CELL_SIZE);
      const z0 = Math.floor((camZ - radius) / SPATIAL_CELL_SIZE);
      const z1 = Math.floor((camZ + radius) / SPATIAL_CELL_SIZE);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const bucket = s.cells.get(cellKey(ix, iz));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const b = bucket[i];
            const dx = b.x - camX;
            const dz = b.z - camZ;
            const d2 = dx * dx + dz * dz;
            if (d2 > r2) continue;
            picks.push({ b, d2 });
          }
        }
      }
    } else {
      for (const b of s.buildings) {
        const dx = b.x - camX;
        const dz = b.z - camZ;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        picks.push({ b, d2 });
      }
    }
    if (picks.length > budget) {
      picks.sort((a, b) => a.d2 - b.d2);
      picks.length = budget;
    }
    const out = new Array(picks.length);
    for (let i = 0; i < picks.length; i++) out[i] = picks[i].b;
    return out;
  }

  /**
   * 4-tier LOD-filtered spatial streaming for rebuild().
   * Filters buildings by `(dist, b.tier)` right inside the spatial cell loop so
   * hidden distant sheds/houses never consume budget or sort time.
   */
  _streamBuildingsLOD(s, camX, camZ, rClose, rMid, rFar, budget) {
    if (!(budget > 0)) return [];
    const rClose2 = rClose * rClose;
    const rMid2 = rMid * rMid;
    const rFar2 = rFar * rFar;

    const nearPicks = [];
    const farPicks = [];
    const visit = (b) => {
      const dx = b.x - camX;
      const dz = b.z - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > rFar2) return;
      const bTier = b.tier !== undefined ? b.tier
        : (b.kind === 'tower' || b.kind === 'church' || b.h >= 12 || b.w * b.d >= 320
          ? 2 : (b.kind === 'shed' || b.w * b.d < 55 ? 0 : 1));
      if (d2 <= rClose2) {
        nearPicks.push({ b, d2, lodLevel: 0 });
      } else if (d2 <= rMid2) {
        if (bTier < 1) return;
        nearPicks.push({ b, d2, lodLevel: 1 });
      } else {
        if (bTier < 2) return;
        farPicks.push({ b, d2, lodLevel: 2 });
      }
    };

    if (s.cells) {
      const x0 = Math.floor((camX - rFar) / SPATIAL_CELL_SIZE);
      const x1 = Math.floor((camX + rFar) / SPATIAL_CELL_SIZE);
      const z0 = Math.floor((camZ - rFar) / SPATIAL_CELL_SIZE);
      const z1 = Math.floor((camZ + rFar) / SPATIAL_CELL_SIZE);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const bucket = s.cells.get(cellKey(ix, iz));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) visit(bucket[i]);
        }
      }
    } else {
      for (let i = 0; i < s.buildings.length; i++) visit(s.buildings[i]);
    }

    // Always reserve a skyline slice (up to 10% of budget) for Tier 2 far
    // prominent buildings so distant towns/churches never vanish when flying
    // over a dense valley city like Nova Gorica / Gorizia.
    const farReserve = farPicks.length > 0
      ? Math.min(farPicks.length, Math.max(200, Math.floor(budget * 0.10)))
      : 0;
    if (farPicks.length > farReserve) {
      farPicks.sort((a, b) => a.d2 - b.d2);
      farPicks.length = farReserve;
    }
    // Account for multi-box close silhouettes (~1.55 boxes/building on average)
    // so the far skyline entries always fit inside the remaining instance slots.
    // Always sort nearPicks nearest-first so close buildings next to the camera
    // are emitted before distant ones and never dropped when approaching limit.
    const nearBudget = Math.max(0, Math.floor((budget - farReserve) * 0.68));
    if (nearPicks.length > 1) nearPicks.sort((a, b) => a.d2 - b.d2);
    if (nearPicks.length > nearBudget) nearPicks.length = nearBudget;
    // Emit far skyline landmarks first so close chimneys never starve them.
    if (farPicks.length === 0) return nearPicks;
    if (nearPicks.length === 0) return farPicks;
    return farPicks.concat(nearPicks);
  }

  // -------------------------------------------------------------------------
  // Rebuild the visible set around the camera
  // -------------------------------------------------------------------------
  rebuild(camera) {
    if (!this.scene || !camera) return;
    const camX = camera.position.x;
    const camZ = camera.position.z;
    const alt = Math.max(0, camera.position.y);

    const lodCfg = LOD_THRESHOLDS[this.preset.name] || LOD_THRESHOLDS.medium;
    const altBoost = Math.min(alt * 0.3, 600);
    const rClose = lodCfg.close + altBoost * 0.5;
    const rMid = lodCfg.mid + altBoost;
    const rFar = clamp(lodCfg.far + alt * 2.5, lodCfg.far, Math.max(lodCfg.far + 4000, 28000));

    // Synchronize smooth shader dissolve radius across walls, plinths and roofs.
    for (const mat of [this.material, this.plinthMaterial, this.roofMaterial]) {
      if (mat && mat.uniforms && mat.uniforms.uCullDist) {
        mat.uniforms.uCullDist.value = rFar;
      }
    }

    const baseRadius = this.preset.buildingRadius || 8000;
    const queryRadius = this.customSettlement
      ? rFar
      : clamp(baseRadius + alt * 5, baseRadius, LARGE_SETTLEMENT_RADIUS);
    const settlements = this._settlementsNear(camX, camZ, queryRadius);
    this._groundUse.clear();
    for (const s of settlements) {
      if (s.id === CUSTOM_SETTLEMENT_ID) {
        // Real OSM towns: drape subtle urban ground patches for the nearest
        // clustered urban zones so mid/far towns stay legible from cruise alt.
        const uzList = s.urbanZones;
        if (Array.isArray(uzList) && uzList.length > 0) {
          const uzRange2 = (rFar + 1200) * (rFar + 1200);
          const nearZones = [];
          for (let i = 0; i < uzList.length; i++) {
            const uz = uzList[i];
            const dx = uz.x - camX;
            const dz = uz.z - camZ;
            const d2 = dx * dx + dz * dz;
            if (d2 <= uzRange2) nearZones.push({ uz, d2 });
          }
          if (nearZones.length > 42) {
            nearZones.sort((a, b) => a.d2 - b.d2);
            nearZones.length = 42;
          }
          for (let i = 0; i < nearZones.length; i++) {
            const uz = nearZones[i].uz;
            this._ensureGround(uz);
            this._groundUse.add(uz.id);
          }
        }
        continue;
      }
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
    let pn = 0;
    let gn = 0;
    let hn = 0;
    let rn = 0;
    let ln = 0;
    let lodClose = 0;
    let lodMid = 0;
    let lodFar = 0;
    let colorDirty = false;
    let plinthColorDirty = false;
    let gableColorDirty = false;
    let hipColorDirty = false;
    let ruinColorDirty = false;

    const meshCap = this.mesh ? this.mesh.instanceMatrix.count : 0;
    const limit = Math.min(this.preset.buildingLimit || 16000, meshCap);
    const plinthLimit = this.plinthMesh ? this.plinthMesh.instanceMatrix.count : 0;
    const gableLimit = this.gableRoofMesh ? this.gableRoofMesh.instanceMatrix.count : 0;
    const hipLimit = this.hipRoofMesh ? this.hipRoofMesh.instanceMatrix.count : 0;
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

    const addPlinth = (x, baseY, z, w, h, d, rot, color) => {
      if (pn >= plinthLimit || !(h > 0) || !(w > 0) || !(d > 0)) return false;
      _p.set(x, baseY, z);
      _e.set(0, rot || 0, 0);
      _q.setFromEuler(_e);
      _s.set(w, h, d);
      _m.compose(_p, _q, _s);
      this.plinthMesh.setMatrixAt(pn, _m);
      _c.setHex(color).convertSRGBToLinear();
      this.plinthMesh.setColorAt(pn, _c);
      pn++;
      plinthColorDirty = true;
      return true;
    };

    const addGableRoof = (x, baseY, z, w, rise, d, rot, color) => {
      if (gn >= gableLimit || !(rise > 0) || !(w > 0) || !(d > 0)) return false;
      // Orient ridge along the longer horizontal footprint axis.
      const wide = w > d;
      const rw = (wide ? d : w) * 1.06;
      const rd = (wide ? w : d) * 1.06;
      const rRot = (rot || 0) + (wide ? Math.PI * 0.5 : 0);
      _p.set(x, baseY, z);
      _e.set(0, rRot, 0);
      _q.setFromEuler(_e);
      _s.set(rw, rise, rd);
      _m.compose(_p, _q, _s);
      this.gableRoofMesh.setMatrixAt(gn, _m);
      _c.setHex(color).convertSRGBToLinear();
      this.gableRoofMesh.setColorAt(gn, _c);
      gn++;
      gableColorDirty = true;
      return true;
    };

    const addHipRoof = (x, baseY, z, w, rise, d, rot, color, overhang = 1.06) => {
      if (hn >= hipLimit || !(rise > 0) || !(w > 0) || !(d > 0)) return false;
      _p.set(x, baseY, z);
      _e.set(0, rot || 0, 0);
      _q.setFromEuler(_e);
      _s.set(w * overhang, rise, d * overhang);
      _m.compose(_p, _q, _s);
      this.hipRoofMesh.setMatrixAt(hn, _m);
      _c.setHex(color).convertSRGBToLinear();
      this.hipRoofMesh.setColorAt(hn, _c);
      hn++;
      hipColorDirty = true;
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

    const builders = { addBox, addPlinth, addGableRoof, addHipRoof };

    // Stream every candidate once, keeping the per-settlement chunk so the
    // buildings can be written in two passes: the near ring first, then the
    // rest (PERF-11). The near ring is exactly the set the layer-1 shadow
    // proxies draw, and they read it as a prefix of the shared buffer.
    const chunks = [];
    let streamed = 0;
    for (const s of settlements) {
      if (streamed >= limit) break;
      const stream = this._streamBuildingsLOD(s, camX, camZ, rClose, rMid, rFar, limit - streamed);
      if (stream.length === 0) continue;
      chunks.push({ s, stream });
      streamed += stream.length;
    }

    const writeBuilding = (s, b, lodLevel) => {
      if (n >= limit) return;
      const g = this._ground(b);
      // g.ground is the minimum elevation across the center and all four
      // rotated footprint corners. Anything truly stranded in deep open water
      // is rejected outright (no warehouse standing in the middle of the bay).
      if (!Number.isFinite(g.ground) || g.ground < -2.2) return;

      // Shallow waterfront (Monfalcone shipyard/port piers, Trieste docks,
      // Marina Julia boathouses right on the coast): keep the real OSM
      // building instead of deleting it, and raise it onto an explicit stone/
      // concrete harbour quay that rises out of the sea to a dry deck.
      // `g` itself is never mutated: `_groundCache` stays canonical for the
      // grounding audit, so all placement overrides live in a local copy.
      let placeG = g;
      if (g.ground < 0.35) {
        const quayY = Math.max(g.floorY, 0.85);
        addPlinth(b.x, -5.5, b.z, b.w + 4.0, quayY - (-5.5), b.d + 4.0, b.rot, 0x8a877d);
        placeG = { ...g, floorY: quayY, top: quayY + b.h, base: -5.5 };
      }

      const key = buildingKey(s, b);
      if (this.destroyed.has(key)) {
        // Permanent multi-piece ruin: jagged wall stubs, tilted slabs and a
        // scorched debris core where the tower used to be. Rubble rests on the
        // quay deck, not on the seabed, so waterfront ruins stay visible.
        this._addRuin(addRuinBox, b, { ...placeG, base: placeG.floorY });
        return;
      }
      // Mid-collapse blocks are drawn by the dedicated collapse pool, so the
      // city rebuild neither re-instances them nor touches their animation.
      if (this.collapsing.has(key)) return;
      if (lodLevel === 0) lodClose++;
      else if (lodLevel === 1) lodMid++;
      else lodFar++;

      // Partially strafed blocks darken toward char as their HP drains.
      let tint = 1;
      const hp = this.buildingHp.get(key);
      if (hp !== undefined) {
        const ratio = clamp(hp / this._hpFor(b), 0, 1);
        tint = 0.58 + 0.42 * ratio;
      }
      this._addSilhouette(builders, b, placeG, lodLevel, tint);
    };

    const shadowR2 = SHADOW_NEAR_R * SHADOW_NEAR_R;

    // Pass 1: buildings close enough to land inside the sun shadow box.
    for (let ci = 0; ci < chunks.length; ci++) {
      const { s, stream } = chunks[ci];
      for (let i = 0; i < stream.length; i++) {
        const item = stream[i];
        const b = item.b;
        const dx = b.x - camX;
        const dz = b.z - camZ;
        if (dx * dx + dz * dz > shadowR2) continue;
        writeBuilding(s, b, item.lodLevel);
      }
    }
    const nearN = n;
    const nearPN = pn;
    const nearGN = gn;
    const nearHN = hn;

    // Pass 2: everything beyond the shadow ring (drawn, but casting nothing).
    for (let ci = 0; ci < chunks.length; ci++) {
      const { s, stream } = chunks[ci];
      for (let i = 0; i < stream.length; i++) {
        const item = stream[i];
        const b = item.b;
        const dx = b.x - camX;
        const dz = b.z - camZ;
        if (dx * dx + dz * dz <= shadowR2) continue;
        writeBuilding(s, b, item.lodLevel);
      }
    }

    // The proxies share the main instance buffers, so the shadow-pass geometry
    // is just this prefix. Nothing else needs uploading for them.
    if (this.shadowMesh) this.shadowMesh.count = nearN;
    if (this.plinthShadowMesh) this.plinthShadowMesh.count = nearPN;
    if (this.gableRoofShadowMesh) this.gableRoofShadowMesh.count = nearGN;
    if (this.hipRoofShadowMesh) this.hipRoofShadowMesh.count = nearHN;

    this.mesh.count = n;
    this._uploadInstances('mesh', this.mesh, n, colorDirty);

    this.plinthMesh.count = pn;
    this._uploadInstances('plinth', this.plinthMesh, pn, plinthColorDirty);

    this.gableRoofMesh.count = gn;
    this._uploadInstances('gable', this.gableRoofMesh, gn, gableColorDirty);

    this.hipRoofMesh.count = hn;
    this._uploadInstances('hip', this.hipRoofMesh, hn, hipColorDirty);

    this.ruinMesh.count = rn;
    this._uploadInstances('ruin', this.ruinMesh, rn, ruinColorDirty);

    // Streets: one ribbon mesh for every settlement road in range. Distant
    // roads are sub-pixel, so they are culled, and the ribbon is only rebuilt
    // when the camera has moved far enough to matter (it is expensive).
    let roadCount = 0;
    if (this.preset.roadDetail) {
      const streets = [];
      for (const s of settlements) {
        const sdx = s.x - camX;
        const sdz = s.z - camZ;
        const reach = STREET_RANGE + s.radius;
        if (sdx * sdx + sdz * sdz > reach * reach) continue;
        for (const r of s.roads) streets.push(r);
      }
      roadCount = streets.length;
      const hasRibbon = !!this.roadMesh.geometry.attributes.position;
      const mdx = camX - (this._streetX ?? Infinity);
      const mdz = camZ - (this._streetZ ?? Infinity);
      if (!hasRibbon || mdx * mdx + mdz * mdz > STREET_REBUILD_DIST * STREET_REBUILD_DIST) {
        this._rebuildStreetRibbons(streets);
        this._streetX = camX;
        this._streetZ = camZ;
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
          // Never float a lamp post out over open water.
          const ly = terrainHeight(lx, lz);
          if (!Number.isFinite(ly) || ly < 0.25) continue;
          _p.set(lx, ly + 6.2, lz);
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
    this._uploadInstances('light', this.lightMesh, ln);

    if (this._cratersDirty) this._rebuildCraters();

    this._lastX = camX;
    this._lastZ = camZ;
    this._lastAlt = camera.position.y;
    this._needsRebuild = false;
    this.stats.buildings = n;
    this.stats.roads = roadCount;
    this.stats.settlements = settlements.length;
    this.stats.lights = ln;
    this.stats.destroyed = this.destroyed.size + this.collapsing.size;
    this.stats.craters = this.craters.length;
    this.stats.ruins = rn;
    this.stats.lod = {
      close: lodClose,
      mid: lodMid,
      far: lodFar,
      roofs: gn + hn,
      plinths: pn,
    };
  }

  // Authentic Primorska / Karst architecture per kind & LOD tier:
  //   - windowless Karst stone foundation plinth from g.base to g.floorY + 0.35
  //   - habitable walls from g.floorY to g.top
  //   - 3D pitched terracotta/slate gable & hip roofs + church campaniles
  //   - close-range rooftop details (chimneys, clerestories, penthouses)
  _addSilhouette(builders, b, g, lodLevel = 0, tint = 1) {
    const { addBox, addPlinth, addGableRoof, addHipRoof } = builders;
    const base = g.base;
    const floorY = g.floorY;
    const top = g.top;
    const wallH = Math.max(1.0, top - floorY);
    const seed = b.colorSeed !== undefined
      ? b.colorSeed
      : (Math.floor(hash2(Math.round(b.x), Math.round(b.z), 0x51ed270b) * 256) & 255);

    const body = tint >= 0.999 ? b.color : shade(b.color, tint);
    const plinthRaw = PLINTH_STONE[seed % PLINTH_STONE.length];
    const plinthCol = tint >= 0.999 ? plinthRaw : shade(plinthRaw, tint);
    const plinthH = Math.max(0.5, floorY + 0.35 - base);

    // Every building rests on a windowless stone retaining plinth extending
    // well below the lowest footprint corner (eliminates floating & wall stretch).
    addPlinth(b.x, base, b.z, b.w * 1.03, plinthH, b.d * 1.03, b.rot, plinthCol);

    const roofCode = b.roofCode !== undefined ? b.roofCode
      : (b.kind === 'church' ? 4
        : b.kind === 'industrial' ? 3
          : b.kind === 'tower' ? 2
            : (b.kind === 'apartment' && b.h >= 14 ? 2 : 0));

    const minSpan = Math.min(b.w, b.d);
    const maxSpan = Math.max(b.w, b.d);
    // Natural regional mix: ~58% weathered sun-baked clay/terracotta,
    // ~26% muted taupe/grey-brown tiles, ~16% dark slate.
    const roofRoll = seed % 19;
    const roofRaw = roofRoll < 11
      ? ROOF_TERRACOTTA[seed % ROOF_TERRACOTTA.length]
      : roofRoll < 16
        ? ROOF_TAUPE[seed % ROOF_TAUPE.length]
        : ROOF_SLATE[seed % ROOF_SLATE.length];
    const roofCol = tint >= 0.999 ? roofRaw : shade(roofRaw, tint);

    switch (b.kind) {
      case 'church': {
        // Karst limestone nave + terracotta gable roof + slender white
        // campanile bell tower with a pointed pyramidal spire.
        const naveH = wallH * 0.72;
        const naveTop = floorY + naveH;
        addBox(b.x, floorY, b.z, b.w, naveH, b.d, b.rot, body);
        const naveRise = Math.min(8.5, Math.max(2.0, minSpan * 0.32));
        addGableRoof(b.x, naveTop - 0.1, b.z, b.w, naveRise, b.d, b.rot, roofCol);

        // Campanile at one end of the nave's long axis (exact +rot world offset).
        const campW = clamp(minSpan * 0.34, 3.2, 6.8);
        const campH = wallH * (1.35 + (seed % 31) * 0.01);
        const wide = b.w >= b.d;
        const lx = wide ? -b.w * 0.42 : 0;
        const lz = wide ? 0 : -b.d * 0.42;
        const c = Math.cos(b.rot);
        const s = Math.sin(b.rot);
        const tx = b.x + lx * c + lz * s;
        const tz = b.z - lx * s + lz * c;

        addPlinth(tx, base, tz, campW * 1.12, plinthH, campW * 1.12, b.rot, plinthCol);
        addBox(tx, floorY, tz, campW, campH, campW, b.rot, body);
        const spireH = clamp(campW * 1.55, 4.5, 11.5);
        addHipRoof(tx, floorY + campH - 0.1, tz, campW, spireH, campW, b.rot, roofCol, 1.08);
        break;
      }
      case 'tower': {
        const podiumH = Math.min(wallH * 0.16, Math.max(2, wallH - 2));
        addBox(b.x, floorY, b.z, b.w * 1.08, podiumH, b.d * 1.08, b.rot, body);
        addBox(b.x, floorY + podiumH, b.z, b.w, wallH - podiumH, b.d, b.rot, body);
        if (lodLevel <= 1) {
          const crownH = Math.min(12, Math.max(2.5, wallH * 0.12));
          const cw = b.w * 0.72;
          const cd = b.d * 0.72;
          addBox(b.x, top, b.z, cw, crownH, cd, b.rot, body);
          addBox(b.x, top + crownH, b.z, cw * 0.34, 2.6, cd * 0.34, b.rot + 0.2, 0x545a5c);
          if (b.h > 75) {
            addBox(b.x, top + crownH + 2.6, b.z, 0.8, Math.min(14, b.h * 0.1), 0.8, b.rot, 0x6b7072);
          }
        }
        break;
      }
      case 'apartment': {
        addBox(b.x, floorY, b.z, b.w, wallH, b.d, b.rot, body);
        if (roofCode === 1) {
          const rise = Math.min(4.8, Math.max(1.4, minSpan * 0.16));
          addHipRoof(b.x, top - 0.1, b.z, b.w, rise, b.d, b.rot, roofCol);
        } else if (roofCode === 0) {
          const rise = Math.min(5.0, Math.max(1.4, minSpan * 0.18));
          addGableRoof(b.x, top - 0.1, b.z, b.w, rise, b.d, b.rot, roofCol);
        } else if (lodLevel <= 1) {
          // Flat parapet & rooftop mechanical penthouse.
          addBox(b.x, top, b.z, b.w * 0.82, Math.min(2.2, Math.max(1, wallH * 0.05)), b.d * 0.82, b.rot, shade(body, 0.85));
        }
        break;
      }
      case 'industrial': {
        addBox(b.x, floorY, b.z, b.w, wallH, b.d, b.rot, body);
        const indRaw = ROOF_INDUSTRIAL[seed % ROOF_INDUSTRIAL.length];
        const indRoof = tint >= 0.999 ? indRaw : shade(indRaw, tint);
        const rise = Math.min(5.5, Math.max(1.1, minSpan * 0.14));
        addGableRoof(b.x, top - 0.1, b.z, b.w, rise, b.d, b.rot, indRoof);
        if (lodLevel === 0 && maxSpan >= 16) {
          // Clerestory roof monitor along the hall ridge at close range.
          const wide = b.w > b.d;
          addBox(
            b.x, top + rise * 0.72, b.z,
            wide ? b.w * 0.65 : b.w * 0.24,
            1.4,
            wide ? b.d * 0.24 : b.d * 0.65,
            b.rot, 0x6f736e,
          );
        }
        break;
      }
      case 'shed': {
        addBox(b.x, floorY, b.z, b.w, wallH, b.d, b.rot, body);
        const shedRoofRaw = (seed & 3) === 0 ? ROOF_INDUSTRIAL[seed % ROOF_INDUSTRIAL.length] : roofRaw;
        const shedRoof = tint >= 0.999 ? shedRoofRaw : shade(shedRoofRaw, tint);
        const rise = Math.min(2.6, Math.max(0.7, minSpan * 0.24));
        addGableRoof(b.x, top - 0.08, b.z, b.w, rise, b.d, b.rot, shedRoof);
        break;
      }
      default: {
        // Primorska / Vipava house: warm stucco walls + pitched terracotta
        // gable (or hipped) roof + close-range terracotta chimney.
        addBox(b.x, floorY, b.z, b.w, wallH, b.d, b.rot, body);
        const rise = Math.min(5.2, Math.max(1.2, minSpan * (0.28 + (seed % 11) * 0.01)));
        if (roofCode === 1) {
          addHipRoof(b.x, top - 0.1, b.z, b.w, rise, b.d, b.rot, roofCol);
        } else if (roofCode === 2) {
          addBox(b.x, top, b.z, b.w * 0.9, 0.9, b.d * 0.9, b.rot, shade(body, 0.78));
        } else {
          addGableRoof(b.x, top - 0.1, b.z, b.w, rise, b.d, b.rot, roofCol);
        }
        if (lodLevel === 0 && roofCode !== 2 && minSpan >= 5.5) {
          // Small rooftop chimney protruding on one side of the ridge.
          const c = Math.cos(b.rot);
          const s = Math.sin(b.rot);
          const ox = ((seed & 1) ? 0.18 : -0.18) * b.w;
          const oz = ((seed & 2) ? 0.18 : -0.18) * b.d;
          addBox(
            b.x + ox * c + oz * s,
            top + rise * 0.55,
            b.z - ox * s + oz * c,
            0.75, Math.max(1.1, rise * 0.55), 0.75,
            b.rot, 0xb8866e,
          );
        }
      }
    }
  }

  // Mark only the live prefix of an instanced pool for upload (PERF-06).
  // `instanceMatrix.needsUpdate = true` on its own streams the entire
  // allocation, so a rebuild that drew 2,500 hip roofs still pushed all 13,000
  // matrices. The used range is `count * itemSize` (16 floats per instance
  // matrix, 3 per instance colour), and a pool that is empty now and was empty
  // on the previous upload is skipped completely.
  _uploadInstances(key, mesh, count, colorDirty = false) {
    if (!mesh) return;
    const prev = this._prevCounts[key] || 0;
    this._prevCounts[key] = count;
    if (count <= 0 && prev <= 0) return;

    const mat = mesh.instanceMatrix;
    if (mat) {
      mat.clearUpdateRanges();
      mat.addUpdateRange(0, Math.max(0, count) * 16);
      mat.needsUpdate = true;
    }
    if (colorDirty && mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, Math.max(0, count) * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }

  // Re-instance every building that is currently mid-collapse into the small
  // dedicated pool. Called once per frame while `collapsing` is non-empty (and
  // on the frame it empties, so `count` drops back to 0) instead of rebuilding
  // the whole city.
  _updateCollapseMesh() {
    const mesh = this.collapseMesh;
    if (!mesh) return;
    const cap = mesh.instanceMatrix.count;
    let n = 0;

    const addBox = (x, baseY, z, w, h, d, rot, color, tiltX = 0, tiltZ = 0) => {
      if (n >= cap || !(h > 0) || !(w > 0) || !(d > 0)) return false;
      _p.set(x, baseY, z);
      _e.set(tiltX, rot || 0, tiltZ);
      _q.setFromEuler(_e);
      _s.set(w, h, d);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(n, _m);
      _c.setHex(color).convertSRGBToLinear();
      mesh.setColorAt(n, _c);
      n++;
      return true;
    };

    for (const c of this.collapsing.values()) {
      if (n >= cap) break;
      // Same grounding record the city rebuild uses, so the leaning block keeps
      // standing exactly where its intact counterpart stood.
      this._addCollapse(addBox, c.b, this._ground(c.b), c);
    }

    mesh.count = n;
    this._uploadInstances('collapse', mesh, n, n > 0);
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
      const wx = b.x + lx * cos + lz * sin;
      const wz = b.z - lx * sin + lz * cos;

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
    this.plinthMesh?.geometry.dispose();
    this.plinthMaterial?.dispose();
    this.gableRoofMesh?.geometry.dispose();
    this.hipRoofMesh?.geometry.dispose();
    this.roofMaterial?.dispose();
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
    this.plinthMesh?.removeFromParent();
    this.gableRoofMesh?.removeFromParent();
    this.hipRoofMesh?.removeFromParent();
    this.ruinMesh.removeFromParent();
    // collapseMesh shares this.mesh's geometry and this.material, so those are
    // disposed above; only the scene reference is dropped here.
    this.collapseMesh?.removeFromParent();
    this.collapseMesh = null;
    // Shadow proxies share the main geometry, materials and instance buffers,
    // so they must not dispose any of them — just leave the scene.
    this.shadowMesh?.removeFromParent();
    this.shadowMesh = null;
    this.plinthShadowMesh?.removeFromParent();
    this.plinthShadowMesh = null;
    this.gableRoofShadowMesh?.removeFromParent();
    this.gableRoofShadowMesh = null;
    this.hipRoofShadowMesh?.removeFromParent();
    this.hipRoofShadowMesh = null;
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