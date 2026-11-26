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

// ---------------------------------------------------------------------------
// Fragment-side surface detail, one tuning block per theater.
// rockColors: [sunlit strata, mid limestone, shadowed member, scree]
// fieldColors: [olive grove, tilled earth, sunlit meadow, vine rows]
// ---------------------------------------------------------------------------
const TERRAIN_DETAILS = {
  temperate: {
    detailAlbedo: 1.0,
    bump: 0.75,
    rock: 0.9,
    field: 0.46,
    sheen: 0.05,
    strataPeriod: 9.5,
    strataContrast: 0.85,
    rockColors: [0xb6ae9c, 0x8f887b, 0x625c52, 0x9d9484],
    fieldColors: [0x7f9450, 0xa58d60, 0xb8c57c, 0x5c783d],
  },
  desert: {
    detailAlbedo: 0.86,
    bump: 0.82,
    rock: 1.0,
    field: 0.12,
    sheen: 0.03,
    strataPeriod: 12.5,
    strataContrast: 0.7,
    rockColors: [0xb38d64, 0x96714f, 0x6a513b, 0xa2805c],
    fieldColors: [0x8f8a58, 0xb29a6b, 0xa9a06b, 0x76794a],
  },
  vipava: {
    detailAlbedo: 1.06,
    bump: 0.86,
    rock: 1.0,
    field: 0.72,
    sheen: 0.06,
    strataPeriod: 8.2,
    strataContrast: 1.0,
    rockColors: [0xd4cebb, 0xaba491, 0x776f62, 0xbab2a2],
    fieldColors: [0x73923f, 0xab926a, 0xafc573, 0x50732d],
  },
};

const DETAIL_VERTEX_PARS = /* glsl */`
varying vec3 vTerrWorld;
`;

const DETAIL_VERTEX_MAIN = /* glsl */`
  vTerrWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

// Fragment prologue: uniforms, hash, analytic-gradient value noise, strata.
const DETAIL_FRAGMENT_PARS = /* glsl */`
uniform vec3 uTerrRockLight;
uniform vec3 uTerrRockMid;
uniform vec3 uTerrRockDark;
uniform vec3 uTerrScree;
uniform vec3 uTerrFieldA;
uniform vec3 uTerrFieldB;
uniform vec3 uTerrFieldC;
uniform vec3 uTerrFieldD;
uniform vec4 uTerrShape;    // x albedo detail, y bump, z rock, w fields
uniform vec2 uTerrStrata;   // x period (m), y contrast
uniform float uTerrSheen;
uniform vec3 uTerrSunDir;
uniform vec3 uTerrSunColor;
varying vec3 vTerrWorld;

// Cheap stable hash (Dave Hoskins style); world coords up to ~5e4.
float thHash( vec2 p ) {
  vec3 p3 = fract( p.xyx * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

// Value noise with analytic derivatives:
//   x = value in [0,1], yz = d(value)/d(p) in noise space.
vec3 thNoise( vec2 p, float seed ) {
  vec2 i = floor( p );
  vec2 f = p - i;
  vec2 w = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  vec2 dw = 30.0 * f * f * ( f * ( f - 2.0 ) + 1.0 );
  vec2 s = i + seed;
  float a = thHash( s );
  float b = thHash( s + vec2( 1.0, 0.0 ) );
  float c = thHash( s + vec2( 0.0, 1.0 ) );
  float d = thHash( s + vec2( 1.0, 1.0 ) );
  float ab = a + ( b - a ) * w.x;
  float cd = c + ( d - c ) * w.x;
  float v = ab + ( cd - ab ) * w.y;
  return vec3(
    v,
    ( ( b - a ) + ( d - c - b + a ) * w.y ) * dw.x,
    ( cd - ab ) * dw.y
  );
}

// Horizontal sedimentary/Karst strata: crisp members, dark seams, warped so
// the layers undulate instead of reading as a ruler.
float thStrata( float y, float warp, float period, float contrast ) {
  float t = ( y + warp ) / period;
  float s1 = abs( fract( t ) * 2.0 - 1.0 );
  float s2 = abs( fract( t * 0.271 + 0.37 ) * 2.0 - 1.0 );
  float band = smoothstep( 0.28, 0.62, s1 );
  float member = smoothstep( 0.35, 0.65, s2 );
  float seam = 1.0 - smoothstep( 0.0, 0.09, s1 );
  return clamp( ( band * 0.72 + member * 0.28 ) * ( 1.0 - seam * 0.55 * contrast ) + 0.12, 0.0, 1.0 );
}
`;

// Albedo / micro-roughness pass, injected right after <color_fragment>.
const DETAIL_ALBEDO = /* glsl */`
  vec3 terrBase = diffuseColor.rgb;
  vec2 terrP = vTerrWorld.xz;
  float terrDist = length( vTerrWorld - cameraPosition );

  // Screen-space pixel footprint in metres: fwidth() is already m/px here.
  float pxM = max( fwidth( terrP.x ), fwidth( terrP.y ) );

  // 4-octave per-band LOD cascade. Each band multiplies a smooth distance
  // rolloff by its own wavelength-matched Nyquist rolloff, so an octave
  // dissolves just before it would shimmer while the coarser octaves stay
  // vivid from cruise altitude.
  float f6 = ( 1.0 - smoothstep( 1200.0, 4800.0, terrDist ) ) * ( 1.0 - smoothstep( 1.4, 4.2, pxM ) );
  float f28 = ( 1.0 - smoothstep( 4500.0, 16000.0, terrDist ) ) * ( 1.0 - smoothstep( 6.5, 19.0, pxM ) );
  float f140 = ( 1.0 - smoothstep( 15000.0, 36000.0, terrDist ) ) * ( 1.0 - smoothstep( 32.0, 92.0, pxM ) );
  float f520 = 1.0 - smoothstep( 34000.0, 56000.0, terrDist );

  // 6 m / 28 m / 140 m / 520 m world-space detail octaves.
  vec3 n6 = thNoise( terrP * ( 1.0 / 6.0 ), 11.0 );
  vec3 n28 = thNoise( terrP * ( 1.0 / 28.0 ), 37.0 );
  vec3 n140 = thNoise( terrP * ( 1.0 / 140.0 ), 73.0 );
  vec3 n520 = thNoise( terrP * ( 1.0 / 520.0 ), 131.0 );
  float d6 = n6.x - 0.5;
  float d28 = n28.x - 0.5;
  float d140 = n140.x - 0.5;
  float d520 = n520.x - 0.5;

  // The detail gradient is assembled per octave in the micro-bump pass, where
  // each band is weighted by its own fade.

  vec3 terrN = normalize( vec4( normalize( vNormal ), 0.0 ) * viewMatrix ).xyz;
  float terrSlope = length( terrN.xz ) / max( abs( terrN.y ), 0.08 );

  vec3 terrAlb = terrBase;
  float terrLum = dot( terrBase, vec3( 0.2126, 0.7152, 0.0722 ) );
  float snowMask = smoothstep( 0.60, 0.80, terrLum );
  float detailA = uTerrShape.x * ( 1.0 - 0.55 * snowMask );

  // 1) Tactile albedo break-up: breaks the smooth vertex-colour plastic look.
  float tone = 1.0 + ( d6 * 0.24 * f6 + d28 * 0.30 * f28 + d140 * 0.24 * f140 + d520 * 0.18 * f520 ) * detailA;
  terrAlb *= clamp( tone, 0.62, 1.42 );
  // sunlit ridges warm, hollows cool
  float warmth = clamp( 0.5 + d28 * 1.7 + d6 * 0.9, 0.0, 1.0 );
  vec3 warmTint = mix( vec3( 0.93, 0.97, 1.05 ), vec3( 1.07, 1.01, 0.92 ), warmth );
  terrAlb *= mix( vec3( 1.0 ), warmTint, 0.34 * detailA * ( 1.0 - snowMask ) );

  // 2) Geological cliffs: crisp strata bands, scree, crevice darkening.
  float rockMask = smoothstep( 0.34, 0.62, terrSlope ) * uTerrShape.z;
  float strataAA = 1.0 - smoothstep( 0.35, 1.35,
    fwidth( vTerrWorld.y ) / max( uTerrStrata.x, 1.0 ) );
  float warp = ( d140 * 0.9 + d28 * 0.15 ) * uTerrStrata.x;
  float band = thStrata( vTerrWorld.y, warp, uTerrStrata.x, uTerrStrata.y );
  band = mix( 0.52, band, strataAA );
  float scree = smoothstep( 0.42, 0.80, n28.x ) * smoothstep( 0.30, 0.60, terrSlope );
  float crev = smoothstep( 0.03, 0.34, abs( d6 ) * 2.0 );
  crev = mix( 1.0, crev, f6 );

  vec3 rockCol = mix( uTerrRockDark, uTerrRockLight, band * 0.72 + 0.14 );
  rockCol = mix( rockCol, uTerrRockMid, 0.22 * ( 0.5 + d28 ) );
  rockCol = mix( rockCol, uTerrScree, scree * 0.45 );
  rockCol *= mix( 1.0, crev, 0.72 * ( 1.0 - snowMask ) );
  rockCol *= 1.0 + d6 * 0.16 * f6 + d28 * 0.12 * f28;
  terrAlb = mix( terrAlb, rockCol, rockMask * ( 1.0 - snowMask * 0.85 ) );

  // 3) Valley agricultural patchwork: rotated parcels on flat 20..320 m land.
  float fieldHeight = smoothstep( 20.0, 34.0, vTerrWorld.y )
                    * ( 1.0 - smoothstep( 286.0, 320.0, vTerrWorld.y ) );
  float fieldFlat = 1.0 - smoothstep( 0.055, 0.14, terrSlope );
  float fieldMask = fieldHeight * fieldFlat * smoothstep( 0.30, 0.62, n140.x )
                  * uTerrShape.w * ( 1.0 - snowMask );
  float fieldAA = ( 1.0 - smoothstep( 0.28, 0.95, pxM / 120.0 ) )
                * ( 1.0 - smoothstep( 14000.0, 26000.0, terrDist ) );

  // Rotation drifts with the macro noise so neighbouring valleys differ.
  float rot = mix( -0.5, 0.62, n140.x ) + d28 * 0.18;
  float cr = cos( rot );
  float sr = sin( rot );
  vec2 rp = vec2( terrP.x * cr - terrP.y * sr, terrP.x * sr + terrP.y * cr );
  vec2 gcell = rp / vec2( 96.0, 143.0 );
  vec2 cell = floor( gcell );
  vec2 cf = fract( gcell );
  float ch = thHash( cell + 19.0 );

  vec3 fieldCol = mix( uTerrFieldB, uTerrFieldC, smoothstep( 0.16, 0.30, ch ) );
  fieldCol = mix( fieldCol, uTerrFieldA, smoothstep( 0.46, 0.60, ch ) );
  fieldCol = mix( fieldCol, uTerrFieldD, smoothstep( 0.74, 0.86, ch ) );
  fieldCol *= 0.86 + 0.30 * fract( ch * 7.31 );          // mown vs lush parcels
  fieldCol = mix( terrBase, fieldCol, 0.72 );            // stay in palette

  // Vineyard rows / plough furrows, faded before they alias.
  float vine = smoothstep( 0.70, 0.84, ch );
  float rowFade = ( 1.0 - smoothstep( 0.7, 2.0, fwidth( cf.x ) * 56.6 ) )
                * ( 1.0 - smoothstep( 2400.0, 4200.0, terrDist ) );
  float rows = 0.5 + 0.5 * sin( cf.x * 56.6 + ch * 12.0 );
  fieldCol *= mix( 1.0, mix( 0.78, 1.10, rows ), vine * rowFade );

  // Field tracks / hedgerows between parcels.
  float edge = min( min( cf.x, 1.0 - cf.x ), min( cf.y, 1.0 - cf.y ) );
  float border = smoothstep( 0.0, 0.045, edge );
  fieldCol *= mix( 0.68, 1.0, border );

  terrAlb = mix( terrAlb, fieldCol, fieldMask * fieldAA * mix( 0.55, 1.0, border ) );
  diffuseColor.rgb = terrAlb;
`;

// Micro-bump pass, injected right after <normal_fragment_begin>.
const DETAIL_NORMAL = /* glsl */`
  // 4) Analytic micro-bump: tilt the lit normal by each detail octave's
  // gradient, weighted by that octave's own distance/Nyquist fade. No global
  // pixel-footprint kill switch here: that used to zero every octave (even the
  // 28 m and 140 m bands) beyond ~450 m and flattened the terrain from altitude.
  float bumpFade = 1.0 - smoothstep( 32000.0, 52000.0, terrDist );
  float bumpAmt = uTerrShape.y * bumpFade * mix( 1.0, 1.35, rockMask );
  vec2 detailG = n6.yz   * ( 0.65 * f6   / 6.0 )
               + n28.yz  * ( 2.40 * f28  / 28.0 )
               + n140.yz * ( 6.80 * f140 / 140.0 )
               + n520.yz * ( 14.0 * f520 / 520.0 );
  vec2 bumpG = detailG;

  float bandUp = thStrata( vTerrWorld.y + 0.5, warp, uTerrStrata.x, uTerrStrata.y );
  float bandDown = thStrata( vTerrWorld.y - 0.5, warp, uTerrStrata.x, uTerrStrata.y );
  float strataTilt = ( bandUp - bandDown ) * rockMask * strataAA * bumpFade * 0.10;

  vec3 terrNp = normalize( vec3(
    terrN.x - bumpG.x * bumpAmt,
    terrN.y - strataTilt,
    terrN.z - bumpG.y * bumpAmt
  ) );
  normal = normalize( mat3( viewMatrix ) * terrNp );
`;

// Micro-roughness sheen, injected where the outgoing radiance is summed.
const DETAIL_SHEEN = /* glsl */`
  // 1b) Micro-roughness: rough ground scatters, smooth ground glints.
  vec3 terrV = normalize( cameraPosition - vTerrWorld );
  vec3 terrH = normalize( uTerrSunDir + terrV );
  float terrRough = clamp( 0.62 + d28 * 0.55 - d6 * 0.35
    + terrSlope * 0.22 + rockMask * 0.25, 0.05, 1.0 );
  float terrGlint = pow( max( dot( terrNp, terrH ), 0.0 ), mix( 90.0, 6.0, terrRough ) );
  outgoingLight += uTerrSunColor * ( terrGlint * ( 1.0 - terrRough )
    * uTerrSheen * bumpFade );
`;

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

    // Uniforms shared with the shader patch below. They outlive onBeforeCompile
    // so retuning a theater only rewrites values, never recompiles the program.
    this.detailUniforms = {
      uTerrRockLight: { value: new THREE.Color(0xffffff) },
      uTerrRockMid: { value: new THREE.Color(0xffffff) },
      uTerrRockDark: { value: new THREE.Color(0xffffff) },
      uTerrScree: { value: new THREE.Color(0xffffff) },
      uTerrFieldA: { value: new THREE.Color(0xffffff) },
      uTerrFieldB: { value: new THREE.Color(0xffffff) },
      uTerrFieldC: { value: new THREE.Color(0xffffff) },
      uTerrFieldD: { value: new THREE.Color(0xffffff) },
      uTerrShape: { value: new THREE.Vector4(1, 0.8, 0.9, 0.4) },
      uTerrStrata: { value: new THREE.Vector2(9.5, 0.9) },
      uTerrSheen: { value: 0.05 },
      uTerrSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.2) },
      uTerrSunColor: { value: new THREE.Color(0xfff2d0) },
    };

    // Keep the stock Lambert material: fog, directional/hemisphere lights and
    // shadow lookups stay exactly as Three.js computes them, and the detail is
    // layered on top through onBeforeCompile.
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      emissive: 0x0a1008,
      emissiveIntensity: 0.45,
    });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.detailUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + DETAIL_VERTEX_PARS)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + DETAIL_VERTEX_MAIN);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + DETAIL_FRAGMENT_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + DETAIL_ALBEDO)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n' + DETAIL_NORMAL)
        .replace(
          'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
          'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;\n' + DETAIL_SHEEN,
        );
    };
    this.material.customProgramCacheKey = () => 'terrain-detail-v1';

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
    this._applyDetailPalette();
  }

  setTheater(name) {
    const next = PALETTES[name] ? name : 'temperate';
    if (next === this.theater) return;
    this.theater = next;
    this.water.setPalette(PALETTES[next]);
    this._applyDetailPalette();
    // Drop every cached tile so terrain repaints cleanly in the new palette:
    // no old-LOD geometry survives to overlap the rebuilt quadtree.
    this._clearTiles();
    this.lastBuildX = Infinity;
    this.lastBuildZ = Infinity;
  }

  /** Copy the active theater's rock/field tuning into the shader uniforms. */
  _applyDetailPalette() {
    const d = TERRAIN_DETAILS[this.theater] || TERRAIN_DETAILS.temperate;
    const u = this.detailUniforms;
    const col = (hex) => new THREE.Color(hex).convertSRGBToLinear();
    u.uTerrRockLight.value.copy(col(d.rockColors[0]));
    u.uTerrRockMid.value.copy(col(d.rockColors[1]));
    u.uTerrRockDark.value.copy(col(d.rockColors[2]));
    u.uTerrScree.value.copy(col(d.rockColors[3]));
    u.uTerrFieldA.value.copy(col(d.fieldColors[0]));
    u.uTerrFieldB.value.copy(col(d.fieldColors[1]));
    u.uTerrFieldC.value.copy(col(d.fieldColors[2]));
    u.uTerrFieldD.value.copy(col(d.fieldColors[3]));
    u.uTerrShape.value.set(d.detailAlbedo, d.bump, d.rock, d.field);
    u.uTerrStrata.value.set(d.strataPeriod, d.strataContrast);
    u.uTerrSheen.value = d.sheen;
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
    // Split earlier than the config radius: ~22% more leaves, so ridge
    // silhouettes and valley slopes gain geometric resolution while still
    // approaching from altitude, without a tile-count blow-up.
    const factor = CONFIG.world.terrainDetailDistance * 1.22;

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
    // Mid rings go slightly denser than far ones (capped by the quality
    // preset); near rings already use segmentsNear.
    const segs = level >= 6 ? this.preset.segmentsNear
      : level >= 3 ? Math.max(28, Math.min(this.preset.segmentsNear, 32)) : this.preset.segmentsFar;
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
    // Keep the terrain sheen in step with the sun used by sky + water.
    if (sunDir) this.detailUniforms.uTerrSunDir.value.copy(sunDir);
    if (sunColor) this.detailUniforms.uTerrSunColor.value.copy(sunColor);
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
      // The surface itself also sits SEA_LEVEL - 0.45 below the waterline, so
      // the 0..2 m Monfalcone/Grado deltas never Z-fight it; the offset is the
      // second line of defence for shallow river mouths.
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 4,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    // Sink the sheet below the sea-level datum so flat coastal land (0..2 m)
    // sits unambiguously above it and shorelines stop shimmering.
    this.mesh.position.y = SEA_LEVEL - 0.45;
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