// Quadtree LOD terrain renderer + ocean surface.
import * as THREE from 'three';
import { terrainHeight, SEA_LEVEL } from './terrain.js';
import { fbm01, smoothstep, clamp } from './noise.js';
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
  // Vipava Valley / Slovenian Karst: sunlit Mediterranean sage meadows,
  // warm vineyard earth, natural pine/oak hillsides, pale Karst limestone.
  vipava: {
    sand: new THREE.Color(0xdcc9a2).convertSRGBToLinear(),
    grassLow: new THREE.Color(0x7c8c5e).convertSRGBToLinear(),   // sunlit sage-green valley floor
    grassHigh: new THREE.Color(0x959d76).convertSRGBToLinear(),  // warm sunlit hillside meadow
    forest: new THREE.Color(0x465b3f).convertSRGBToLinear(),     // natural Mediterranean pine/oak
    rock: new THREE.Color(0xc4bfb2).convertSRGBToLinear(),       // pale sunlit Karst limestone
    rockDark: new THREE.Color(0x8e897d).convertSRGBToLinear(),   // weathered limestone shadow
    snow: new THREE.Color(0xf0f3f0).convertSRGBToLinear(),
    dirt: new THREE.Color(0xa8987b).convertSRGBToLinear(),       // warm Karst earth
    seabed: new THREE.Color(0x24475b).convertSRGBToLinear(),
    snowLineBase: 1550,
    forestMix: 0.72,
    dryMix: 0.24,
    waterDeep: 0x0c3554,
    waterShallow: 0x1c5d78,
  },
};

// ---------------------------------------------------------------------------
// Fragment-side surface detail, one tuning block per theater.
// rockColors: [sunlit strata, mid limestone, shadowed member, scree]
// fieldColors: [olive grove, tilled earth, sunlit meadow, vine rows]
// ---------------------------------------------------------------------------
const TERRAIN_DETAILS = {
  temperate: {
    detailAlbedo: 0.72,
    bump: 0.26,
    rock: 0.88,
    field: 0.46,
    sheen: 0.04,
    strataPeriod: 9.5,
    strataContrast: 0.75,
    rockColors: [0xb6ae9c, 0x8f887b, 0x6c665c, 0x9d9484],
    fieldColors: [0x7f9450, 0xa58d60, 0xb8c57c, 0x5c783d],
  },
  desert: {
    detailAlbedo: 0.68,
    bump: 0.30,
    rock: 1.0,
    field: 0.12,
    sheen: 0.03,
    strataPeriod: 12.5,
    strataContrast: 0.65,
    rockColors: [0xb38d64, 0x96714f, 0x6a513b, 0xa2805c],
    fieldColors: [0x8f8a58, 0xb29a6b, 0xa9a06b, 0x76794a],
  },
  vipava: {
    detailAlbedo: 0.68,
    bump: 0.28,
    rock: 0.95,
    field: 0.78,
    sheen: 0.04,
    strataPeriod: 9.0,
    strataContrast: 0.72,
    rockColors: [0xd8d2c1, 0xb6afa0, 0x867f73, 0xc3bbb0],
    // sunlit vineyards, warm soil, golden meadow, Mediterranean olive groves
    fieldColors: [0x758554, 0xaa9a7c, 0x9fa678, 0x5c6e46],
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
uniform float uTerrTime;
uniform vec3 uTerrSkyColor;

// Baked Esri World Imagery tiers (vipava only). Bounds are
// vec4( xMin, zMin, 1/spanX, 1/spanZ ); every JPEG is stored flipY = false, so
// texture row 0 / v = 0 is zMin (north) and row H-1 / v = 1 is zMax (south).
uniform sampler2D uOrthoHD;
uniform sampler2D uOrthoReg;
uniform sampler2D uOrthoMacro;
uniform vec4 uOrthoHDBounds;
uniform vec4 uOrthoRegBounds;
uniform vec4 uOrthoMacroBounds;
uniform vec3 uOrthoBlend;   // x hd, y regional, z macro edge fade (m)
uniform vec4 uOrthoFlags;   // x hasHD, y hasRegional, z hasMacro, w enabled
varying vec3 vTerrWorld;

// Cheap stable hash (Dave Hoskins style); world coords up to ~5e4.
float thHash( vec2 p ) {
  vec3 p3 = fract( p.xyx * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

// World -> texture uv for one ortho tier, plus a soft metric edge weight that
// reaches 0 exactly on the tier boundary (so adjacent tiers never seam).
vec3 orthoWeight( vec2 p, vec4 bounds, float blendM ) {
  vec2 span = vec2( 1.0 / bounds.z, 1.0 / bounds.w );
  vec2 uv = ( p - bounds.xy ) * bounds.zw;
  vec2 edge = min( p - bounds.xy, bounds.xy + span - p );
  float w = smoothstep( 0.0, max( blendM, 1.0 ), min( edge.x, edge.y ) );
  return vec3( uv, w );
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
  return clamp( ( band * 0.72 + member * 0.28 ) * ( 1.0 - seam * 0.28 * contrast ) + 0.12, 0.0, 1.0 );
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

  // 6 m / 28 m / 140 m / 520 m world-space detail octaves with distinct
  // non-orthogonal rotations so hills never show axis-aligned grid blobs.
  mat2 r6 = mat2( 0.80, -0.60, 0.60, 0.80 );
  mat2 r28 = mat2( 0.45, -0.89, 0.89, 0.45 );
  mat2 r140 = mat2( -0.73, -0.68, 0.68, -0.73 );
  mat2 r520 = mat2( 0.28, 0.96, -0.96, 0.28 );

  vec3 n6 = thNoise( ( r6 * terrP ) * ( 1.0 / 6.0 ), 11.0 );
  vec3 n28 = thNoise( ( r28 * terrP ) * ( 1.0 / 28.0 ), 37.0 );
  vec3 n140 = thNoise( ( r140 * terrP ) * ( 1.0 / 140.0 ), 73.0 );
  vec3 n520 = thNoise( ( r520 * terrP ) * ( 1.0 / 520.0 ), 131.0 );
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

  // 1) Tactile albedo break-up: gentle tonal variation without noisy bump look.
  float tone = 1.0 + ( d6 * 0.12 * f6 + d28 * 0.16 * f28 + d140 * 0.14 * f140 + d520 * 0.10 * f520 ) * detailA;
  terrAlb *= clamp( tone, 0.80, 1.22 );
  // sunlit ridges warm, hollows cool
  float warmth = clamp( 0.5 + d28 * 1.2 + d6 * 0.5, 0.0, 1.0 );
  vec3 warmTint = mix( vec3( 0.95, 0.98, 1.03 ), vec3( 1.05, 1.01, 0.94 ), warmth );
  terrAlb *= mix( vec3( 1.0 ), warmTint, 0.24 * detailA * ( 1.0 - snowMask ) );

  // 2) Geological cliffs: crisp strata bands, scree, crevice darkening.
  float rockMask = smoothstep( 0.38, 0.84, terrSlope ) * uTerrShape.z;
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
  rockCol *= mix( 1.0, crev, 0.35 * ( 1.0 - snowMask ) );
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
  fieldCol *= mix( 0.84, 1.0, border );

  terrAlb = mix( terrAlb, fieldCol, fieldMask * fieldAA * mix( 0.65, 1.0, border ) );

  // 3b) Subtle earth harmony: pull ~10% toward luminance so greens stay natural
  // without washing the sunlit valley into dark mud.
  float finalLum = dot( terrAlb, vec3( 0.2126, 0.7152, 0.0722 ) );
  terrAlb = mix( terrAlb, vec3( finalLum ), 0.10 );

  // 3c) Real satellite ortho-imagery drape: macro -> regional -> HD, each tier
  // cross-faded by a metric edge weight so the three JPEGs never seam. Only
  // active in the baked Vipava theater (uOrthoFlags.w), so temperate/desert
  // stay 100% procedural.
  if ( uOrthoFlags.w > 0.5 ) {
    vec3 satRgb = vec3( 0.0 );
    float satW = 0.0;
    if ( uOrthoFlags.z > 0.5 ) {
      vec3 m = orthoWeight( terrP, uOrthoMacroBounds, uOrthoBlend.z );
      satRgb = texture2D( uOrthoMacro, m.xy ).rgb;
      satW = m.z;
    }
    if ( uOrthoFlags.y > 0.5 ) {
      vec3 r = orthoWeight( terrP, uOrthoRegBounds, uOrthoBlend.y );
      satRgb = mix( satRgb, texture2D( uOrthoReg, r.xy ).rgb, r.z );
      satW = max( satW, r.z );
    }
    if ( uOrthoFlags.x > 0.5 ) {
      vec3 h = orthoWeight( terrP, uOrthoHDBounds, uOrthoBlend.x );
      satRgb = mix( satRgb, texture2D( uOrthoHD, h.xy ).rgb, h.z );
      satW = max( satW, h.z );
    }

    // Baked imagery already carries its own shadow; Three.js Lambert adds sun
    // and hemisphere on top, so lift the satellite shadows a touch and keep a
    // faint gamma curve to stop the valley reading as double-darkened mud.
    satRgb = pow( max( satRgb, vec3( 0.0 ) ), vec3( 0.94 ) ) * 1.12;

    // Crisp micro-grain so imagery stays tactile at AGL 30-400 m instead of
    // turning into a blurry photo pasted on the ground.
    satRgb *= 1.0 + ( d6 * 0.10 * f6 + d28 * 0.08 * f28 );

    // Shorelines: over water the terrain mesh is sunk to the seabed, so fade
    // the imagery back into the coastal seabed tint instead of showing a
    // satellite sea surface under the ocean plane.
    float submerge = 1.0 - smoothstep( -6.0, 0.2, vTerrWorld.y );
    satRgb = mix( satRgb, terrAlb, submerge * 0.85 );

    terrAlb = mix( terrAlb, satRgb, satW );
  }

  diffuseColor.rgb = terrAlb;
`;

// Micro-bump pass, injected right after <normal_fragment_begin>.
const DETAIL_NORMAL = /* glsl */`
  // 4) Restrained micro-bump: keep smooth valley floors and forested slopes
  // clean (avoiding the crumpled bump-map look) while preserving crisp rock
  // relief on steep Karst cliffs and canyon walls.
  float bumpFade = 1.0 - smoothstep( 26000.0, 44000.0, terrDist );
  // Grazing sunset light makes any tangential normal tilt read as a hard
  // shadow/sun flip, so damp the micro-bump as the sun sinks (leopard spots).
  float sunBump = smoothstep( 0.05, 0.30, uTerrSunDir.y );
  float bumpAmt = uTerrShape.y * bumpFade * mix( 0.14, 0.42, rockMask ) * mix( 0.32, 1.0, sunBump );
  vec2 detailG = ( n6.yz * r6 )     * ( 0.22 * f6   / 6.0 )
               + ( n28.yz * r28 )   * ( 0.75 * f28  / 28.0 )
               + ( n140.yz * r140 ) * ( 1.80 * f140 / 140.0 )
               + ( n520.yz * r520 ) * ( 3.20 * f520 / 520.0 );
  // Soft-clamp the gradient so no peak can over-tilt a normal past grazing
  // incidence and self-shadow into an inverted speck.
  detailG *= min( 1.0, 0.45 / max( length( detailG ), 1e-4 ) );
  vec2 bumpG = detailG;

  float bandUp = thStrata( vTerrWorld.y + 0.5, warp, uTerrStrata.x, uTerrStrata.y );
  float bandDown = thStrata( vTerrWorld.y - 0.5, warp, uTerrStrata.x, uTerrStrata.y );
  float strataTilt = ( bandUp - bandDown ) * rockMask * strataAA * bumpFade * 0.08;

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
  vec3 terrSheenTerm = uTerrSunColor * ( terrGlint * ( 1.0 - terrRough )
    * uTerrSheen * bumpFade );
  outgoingLight += terrSheenTerm;

  // 2) Soft drifting cloud shadows: two low-frequency masks (~1.8 km) advected
  // downwind at ~14 m/s, so the valley floor gains slow, natural luminance
  // life. Fades out once a pixel averages the pattern away, and there is no
  // cloud shadow without a sun (dawn, dusk, night). Direct sunlight only: the
  // sky term is what fills a cloud shadow back in. The material is injected
  // after outgoingLight is summed, so rebuild it from the shaded direct term.
  float cloudPx = 1.0 - smoothstep( 260.0, 900.0, pxM );
  float cloudSun = smoothstep( 0.08, 0.34, uTerrSunDir.y );
  vec2 cloudP = ( terrP + vec2( 1.0, 0.72 ) * ( uTerrTime * 14.0 ) ) * ( 1.0 / 1800.0 );
  float cloudA = thNoise( cloudP, 211.0 ).x;
  float cloudB = thNoise( cloudP * 1.73 + vec2( 13.0, 7.0 ), 227.0 ).x;
  float cloudMask = smoothstep( 0.54, 0.84, cloudA * 0.62 + cloudB * 0.38 );
  float cloudShadow = 1.0 - 0.20 * cloudMask * cloudSun * cloudPx;
  reflectedLight.directDiffuse *= cloudShadow;
  outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse
    + totalEmissiveRadiance + terrSheenTerm;

  // 3) Rayleigh aerial perspective: distant ridges drift toward a cool
  // sky-haze tint, stronger from the valley floor than from cruise altitude so
  // Nanos, Trnovski gozd and the Julian Alps separate clearly in depth.
  float aer = smoothstep( 9000.0, 48000.0, terrDist );
  float aerAlt = mix( 0.38, 0.18, smoothstep( 320.0, 3200.0, cameraPosition.y ) );
  float dayF = mix( 0.30, 1.0, smoothstep( -0.06, 0.34, uTerrSunDir.y ) );
  vec3 hazeCol = mix( uTerrSkyColor, vec3( 0.56, 0.68, 0.84 ), 0.35 ) * dayF;
  outgoingLight = mix( outgoingLight, hazeCol, clamp( aer * aerAlt, 0.0, 1.0 ) );
`;

function distanceToRect(px, pz, x, z, size) {
  const dx = Math.max(x - px, 0, px - (x + size));
  const dz = Math.max(z - pz, 0, pz - (z + size));
  return Math.hypot(dx, dz);
}

// Baked satellite tiers (scripts/bake_vipava_ortho.py). These defaults match
// vipava_ortho_meta.json and are used before the metadata arrives.
const ORTHO_TIERS = {
  hd: { f: 'vipava_ortho_hd.jpg', xMin: -25000, xMax: 15000, zMin: -15000, zMax: 15000, blendM: 1500 },
  regional: { f: 'vipava_ortho.jpg', xMin: -50000, xMax: 50000, zMin: -50000, zMax: 50000, blendM: 6000 },
  macro: { f: 'vipava_ortho_macro.jpg', xMin: -250000, xMax: 250000, zMin: -250000, zMax: 250000, blendM: 20000 },
};
const ORTHO_META_URL = './media/vipava_ortho_meta.json';

// 1x1 neutral DataTexture: a legal sampler binding with zero DOM/Image
// dependency, so the terrain shader compiles and runs in headless Node.
function neutralOrthoTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function orthoBoundsVec4(tier) {
  return new THREE.Vector4(
    tier.xMin,
    tier.zMin,
    1 / (tier.xMax - tier.xMin),
    1 / (tier.zMax - tier.zMin),
  );
}

function vertexColor(h, slope, x, z, out, pal = PALETTES.temperate) {
  const n = fbm01(x * 0.00042, z * 0.00042, 3, 881);
  // Continuous noise only: a world-aligned blocky hash here painted 20 m
  // square checkerboard patches across hillsides at every LOD.
  const fine = fbm01(x * 0.0035, z * 0.0035, 2, 71);
  const snowLine = pal.snowLineBase + fbm01(x * 0.0006, z * 0.0009, 2, 991) * 260;

  if (h < 0.15) {
    out.copy(pal.seabed);
  } else if (h < 1.6) {
    out.copy(pal.sand);
  } else {
    out.copy(pal.grassLow).lerp(pal.grassHigh, n);
    // forest / irrigated oasis patches
    const forest = smoothstep(0.52, 0.74, fbm01(x * 0.0011, z * 0.0011, 3, 1201));
    const forestMix = pal.forestMix ?? (pal === PALETTES.desert ? 0.35 : 0.8);
    // Broad smoothstep instead of a binary slope<0.55 gate: a hard threshold
    // flipped whole quadtree quads between pine green and sage meadow wherever
    // the hillside sat near ~29 deg, producing a square checkerboard.
    const forestSlope = 1 - smoothstep(0.32, 0.78, slope);
    out.lerp(pal.forest, forest * forestMix * forestSlope);
    // dry / dirt in low flat basins
    const dry = smoothstep(0.62, 0.84, fbm01(x * 0.00022, z * 0.00022, 2, 1311));
    const dryMix = pal.dryMix ?? (pal === PALETTES.desert ? 0.55 : 0.35);
    out.lerp(pal.dirt, dry * dryMix);
  }

  // rock on steep slopes
  const rockT = smoothstep(0.42, 0.86, slope);
  if (h > 1) out.lerp(pal.rock, rockT * 0.92);
  // high altitude rock then snow/limestone
  if (h > 700) {
    out.lerp(pal.rockDark, smoothstep(700, 1150, h) * 0.65);
    out.lerp(pal.snow, smoothstep(snowLine, snowLine + 320, h) * (1 - clamp((slope - 0.7) * 1.6, 0, 1)));
  }
  // subtle per-vertex tonal noise
  const v = 0.95 + fine * 0.10;
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
    this._neutralOrtho = neutralOrthoTexture();
    this._orthoState = 'idle';   // idle | loading | ready | failed
    this._orthoMetaUrl = ORTHO_META_URL;
    this._orthoBind = null;      // last bound { hd, regional, macro, meta }
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
      uTerrTime: { value: 0 },
      uTerrSkyColor: { value: new THREE.Color(0x8fb4c8) },
      // Satellite ortho tiers: neutral 1x1 fallbacks, disabled until vipava.
      uOrthoHD: { value: this._neutralOrtho },
      uOrthoReg: { value: this._neutralOrtho },
      uOrthoMacro: { value: this._neutralOrtho },
      uOrthoHDBounds: { value: orthoBoundsVec4(ORTHO_TIERS.hd) },
      uOrthoRegBounds: { value: orthoBoundsVec4(ORTHO_TIERS.regional) },
      uOrthoMacroBounds: { value: orthoBoundsVec4(ORTHO_TIERS.macro) },
      uOrthoBlend: {
        value: new THREE.Vector3(
          ORTHO_TIERS.hd.blendM,
          ORTHO_TIERS.regional.blendM,
          ORTHO_TIERS.macro.blendM,
        ),
      },
      uOrthoFlags: { value: new THREE.Vector4(0, 0, 0, 0) },
    };

    // Keep the stock Lambert material: fog, directional/hemisphere lights and
    // shadow lookups stay exactly as Three.js computes them, and the detail is
    // layered on top through onBeforeCompile.
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      emissive: 0x1e2620,
      emissiveIntensity: 0.42,
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
    this.material.customProgramCacheKey = () => 'terrain-detail-v2';

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
    // Satellite imagery belongs to the baked Vipava height field only: any
    // other theater must stay fully procedural.
    if (next === 'vipava') {
      if (this._orthoState === 'ready' && this._orthoBind) this.setOrthoTextures(this._orthoBind);
      else this._ensureOrthoTextures();
    } else {
      this.clearOrthoTextures();
    }
    // Drop every cached tile so terrain repaints cleanly in the new palette:
    // no old-LOD geometry survives to overlap the rebuilt quadtree.
    this._clearTiles();
    this.lastBuildX = Infinity;
    this.lastBuildZ = Infinity;
  }

  /**
   * Bind the baked satellite tiers. Any tier may be null (a failed download
   * just disables that level); `meta` is the parsed vipava_ortho_meta.json.
   */
  setOrthoTextures({ hd = null, regional = null, macro = null, meta = null } = {}) {
    const u = this.detailUniforms;
    const tiers = { hd, regional, macro };
    const slots = [
      ['hd', 'uOrthoHD', 'uOrthoHDBounds'],
      ['regional', 'uOrthoReg', 'uOrthoRegBounds'],
      ['macro', 'uOrthoMacro', 'uOrthoMacroBounds'],
    ];
    let any = 0;
    for (const [key, texUniform, boundsUniform] of slots) {
      const tex = tiers[key] || null;
      if (tex) {
        tex.colorSpace = THREE.SRGBColorSpace;
        // flipY = false + uv = (x-xMin)/spanX, (z-zMin)/spanZ: row 0 is zMin.
        tex.flipY = false;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = 8;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        any++;
      }
      // Fill any missing bound from the meta entry or the bake defaults.
      const src = ORTHO_TIERS[key];
      const m = (meta && meta[key]) || {};
      const merged = {
        xMin: m.xMin ?? src.xMin,
        xMax: m.xMax ?? src.xMax,
        zMin: m.zMin ?? src.zMin,
        zMax: m.zMax ?? src.zMax,
        blendM: m.blendM ?? src.blendM,
      };
      u[texUniform].value = tex || this._neutralOrtho;
      u[boundsUniform].value.copy(orthoBoundsVec4(merged));
      u.uOrthoBlend.value.setComponent(['hd', 'regional', 'macro'].indexOf(key), merged.blendM);
    }
    u.uOrthoFlags.value.set(hd ? 1 : 0, regional ? 1 : 0, macro ? 1 : 0, any ? 1 : 0);
    this._orthoState = any ? 'ready' : 'failed';
    if (any) this._orthoBind = { hd, regional, macro, meta };
  }

  /** Disable the satellite drape (keeps the textures for a later re-bind). */
  clearOrthoTextures() {
    this.detailUniforms.uOrthoFlags.value.set(0, 0, 0, 0);
  }

  /**
   * Drop every cached tile that overlaps the world rectangle so freshly
   * streamed DEM (live AWS Terrarium tiles) is re-sampled into geometry.
   * Returns the number of tiles invalidated.
   */
  invalidateBounds(xMin, xMax, zMin, zMax) {
    let dropped = 0;
    for (const [key, mesh] of this.tiles) {
      const parts = key.split(':');
      const x = Number(parts[1]);
      const z = Number(parts[2]);
      const size = mesh.userData?.size ?? 0;
      if (x > xMax || x + size < xMin || z > zMax || z + size < zMin) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      this.tiles.delete(key);
      this._stale.delete(key);
      dropped++;
    }
    // Force the next update() to re-queue the missing leaves immediately.
    if (dropped) this.lastBuildX = Infinity;
    return dropped;
  }

  /** Lazily load the baked satellite tiers once the Vipava theater is active. */
  _ensureOrthoTextures() {
    if (this._orthoState !== 'idle') return;
    // Headless Node: no Image/TextureLoader, so stay on the neutral fallbacks.
    if (typeof document === 'undefined' || typeof fetch !== 'function') {
      this._orthoState = 'failed';
      return;
    }
    this._orthoState = 'loading';
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const load = (url) => new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    fetch(this._orthoMetaUrl)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((meta) => {
        const resolved = {};
        for (const key of ['hd', 'regional', 'macro']) {
          const m = (meta && meta[key]) || {};
          resolved[key] = m.url || './media/' + ORTHO_TIERS[key].f;
        }
        return Promise.all([
          load(resolved.hd).catch(() => null),
          load(resolved.regional).catch(() => null),
          load(resolved.macro).catch(() => null),
        ]).then(([hd, regional, macro]) => {
          this.setOrthoTextures({ hd, regional, macro, meta });
          // A theater switch during the download leaves the bind cached but
          // must not paint satellite imagery over a procedural theater.
          if (this.theater !== 'vipava') this.clearOrthoTextures();
          if (!hd && !regional && !macro) {
            console.warn('VIPAVA · ortho imagery unavailable, keeping procedural terrain');
          }
        });
      })
      .catch((err) => {
        this._orthoState = 'failed';
        console.warn('VIPAVA · ortho imagery load failed', err);
      });
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
      // Feature 37: mid-level tiles over steep ground (Nanos, Trnovski gozd,
      // the Solkan gorge, Stanjel hill) split one level deeper than flat
      // valley floor / ocean, so ridges keep their silhouette without spending
      // triangles on plains.
      let splitFactor = factor;
      if (level >= 3 && level < maxLevel) {
        const h = size * 0.5;
        const c = terrainHeight(x + h, z + h);
        let lo = c;
        let hi = c;
        for (let k = 0; k < 4; k++) {
          const hx = terrainHeight(k & 1 ? x + size : x, k & 2 ? z + size : z);
          if (hx < lo) lo = hx;
          else if (hx > hi) hi = hx;
        }
        if (hi - lo > Math.max(35, size * 0.06)) splitFactor = factor * 1.3;
      }
      if (level < maxLevel && size > minSize && d < size * splitFactor) {
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
      : level >= 3 ? Math.max(30, Math.min(this.preset.segmentsNear, 36)) : this.preset.segmentsFar;
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
        // Sink sea-datum terrain below the ocean plane so sea mesh never
        // clips through WaterSurface at any angle, leaving coastal docks >= 0.85 m intact.
        let meshH = h;
        if (h <= 0.12) {
          meshH = -24.0;
        } else if (h < 0.85) {
          const t = smoothstep(0.12, 0.85, h);
          meshH = -24.0 + (h + 24.0) * t;
        }
        positions[idx * 3] = wx;
        positions[idx * 3 + 1] = meshH;
        positions[idx * 3 + 2] = wz;

        // Normals / slope only. Positions above stay exactly on hAt() so
        // geometry, building and road grounding are untouched.
        // Near tiles have step < DEM pixel size, so finite differencing the
        // grid picks up sub-pixel interpolation steps from the DEM and facets
        // the shading. Sample a fixed 14 m world-space baseline instead: it
        // depends only on (wx, wz), so neighbouring tiles agree exactly.
        let dx;
        let dz;
        if (step >= 12) {
          dx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * step);
          dz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * step);
        } else {
          const nStep = 14;
          dx = (terrainHeight(wx + nStep, wz) - terrainHeight(wx - nStep, wz)) / (2 * nStep);
          dz = (terrainHeight(wx, wz + nStep) - terrainHeight(wx, wz - nStep)) / (2 * nStep);
        }
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
    this.detailUniforms.uTerrTime.value += dt;
    this.timeSinceRebuild += dt;
    const moved = Math.hypot(_cam.x - this.lastBuildX, _cam.z - this.lastBuildZ);

    if (moved > 96 || this.lastBuildX === Infinity) {
      this._rebuild(_cam);
    }
    if (this.pending.length) {
      // more budget while at altitude or during boot (Feature 37 raises it a
      // little: finer 128 m leaves need to stream in without holes)
      const budget = this.lastBuildX === Infinity ? 20 : (_cam.y > 3000 ? 10 : 6);
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
    // Aerial perspective haze tint follows the live sky.
    if (skyColor) this.detailUniforms.uTerrSkyColor.value.copy(skyColor);
    this.water.setAtmosphere(sunDir, sunColor, skyColor);
  }

  dispose() {
    for (const mesh of this.tiles.values()) mesh.geometry.dispose();
    this.tiles.clear();
    if (this._orthoBind) {
      for (const tex of [this._orthoBind.hd, this._orthoBind.regional, this._orthoBind.macro]) {
        if (tex && tex !== this._neutralOrtho) tex.dispose();
      }
      this._orthoBind = null;
    }
    if (this._neutralOrtho) this._neutralOrtho.dispose();
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
    const geo = new THREE.PlaneGeometry(160000, 160000, 80, 80);
    geo.rotateX(-Math.PI / 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.2) },
        uSunColor: { value: new THREE.Color(0xfff2d0) },
        uSkyColor: { value: new THREE.Color(0x8fb4c8) },
        uDeep: { value: new THREE.Color(0x0c3554).convertSRGBToLinear() },
        uShallow: { value: new THREE.Color(0x1c5d78).convertSRGBToLinear() },
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

        // Cheap stable hash (Dave Hoskins style), same family as the terrain pass.
        float wHash(vec2 p) {
          vec3 p3 = fract(p.xyx * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        // Quintic-interpolated 2D value noise with analytic derivatives:
        //   x = value in [0,1], yz = d(value)/d(p) in noise space.
        // Two-dimensional by construction, so it can never form 1D plane stripes.
        vec3 wNoise(vec2 p, float seed) {
          vec2 i = floor(p);
          vec2 f = p - i;
          vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
          vec2 dw = 30.0 * f * f * (f * (f - 2.0) + 1.0);
          vec2 s = i + seed;
          float a = wHash(s);
          float b = wHash(s + vec2(1.0, 0.0));
          float c = wHash(s + vec2(0.0, 1.0));
          float d = wHash(s + vec2(1.0, 1.0));
          float ab = a + (b - a) * w.x;
          float cd = c + (d - c) * w.x;
          return vec3(
            ab + (cd - ab) * w.y,
            ((b - a) + (d - c - b + a) * w.y) * dw.x,
            (cd - ab) * dw.y
          );
        }

        // One rotated, independently drifting 2D noise layer.
        // cs = (cos, sin) of a non-orthogonal rotation, freq = 1/wavelength (1/m),
        // drift = world-space scroll velocity (m/s). Returns the value plus the
        // gradient rotated back into world space (height per metre of ground).
        vec3 wLayer(vec2 p, vec2 cs, float freq, float seed, vec2 drift, float t) {
          vec2 pw = p - drift * t;
          vec2 q = vec2(cs.x * pw.x - cs.y * pw.y, cs.y * pw.x + cs.x * pw.y) * freq;
          vec3 v = wNoise(q, seed);
          return vec3(v.x, vec2(cs.x * v.y + cs.y * v.z, -cs.y * v.y + cs.x * v.z) * freq);
        }

        // Screen-space Nyquist rolloff (strictly ordered edges per GLSL ES spec).
        float wNyquist(float L, float px) {
          return 1.0 - smoothstep(L * 0.10, L * 0.45, px);
        }

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float t = uTime;
          vec2 p = vWorld.xz;
          float distXZ = length(vWorld.xz - cameraPosition.xz);

          // World metres covered by one pixel: the hard anti-aliasing budget.
          float pixSize = max(length(fwidth(p)), 0.05);

          // Four 2D wave octaves (8 m, 22 m, 65 m, 180 m). Each is a pair of
          // counter-drifting noise layers at slightly different scales and
          // rotations, so crests shimmer organically instead of sliding rigidly.
          vec3 L8a   = wLayer(p, vec2(0.80, 0.60),  1.0 / 8.0,   11.0, vec2(0.30, -0.42),  t);
          vec3 L8b   = wLayer(p, vec2(0.28, -0.96), 1.0 / 8.7,   17.0, vec2(-0.36, -0.31), t);
          vec3 L22a  = wLayer(p, vec2(-0.42, 0.91), 1.0 / 22.0,  23.0, vec2(-0.46, 0.33),  t);
          vec3 L22b  = wLayer(p, vec2(0.94, 0.34),  1.0 / 24.5,  29.0, vec2(0.38, 0.52),   t);
          vec3 L65a  = wLayer(p, vec2(0.62, -0.78), 1.0 / 65.0,  37.0, vec2(0.30, 0.44),   t);
          vec3 L65b  = wLayer(p, vec2(-0.87, -0.49), 1.0 / 71.0,  43.0, vec2(-0.40, 0.36),  t);
          vec3 L180a = wLayer(p, vec2(-0.19, 0.98), 1.0 / 180.0, 53.0, vec2(0.42, -0.30),  t);
          vec3 L180b = wLayer(p, vec2(0.76, 0.65),  1.0 / 195.0, 59.0, vec2(-0.35, -0.46), t);

          float f8   = wNyquist(8.0,   pixSize);
          float f22  = wNyquist(22.0,  pixSize);
          float f65  = wNyquist(65.0,  pixSize);
          float f180 = wNyquist(180.0, pixSize);

          // Non-repeating isotropic surface slope. Amplitudes are matched to each
          // wavelength so the summed tilt peaks ~0.08 (crisp, never noisy).
          vec2 tilt = (L8a.yz   + L8b.yz)   * (0.5 * 0.26) * f8
                    + (L22a.yz  + L22b.yz)  * (0.5 * 0.70) * f22
                    + (L65a.yz  + L65b.yz)  * (0.5 * 1.86) * f65
                    + (L180a.yz + L180b.yz) * (0.5 * 4.02) * f180;
          tilt *= min(1.0, 0.085 / max(length(tilt), 1e-5));
          vec3 n = normalize(vec3(-tilt.x, 1.0, -tilt.y));

          // Domain-warped low-frequency fBM (~700 m / ~2100 m) for subtle
          // current / wind patches: pure 2D noise, zero stripes at any altitude.
          vec2 wq = vec2(
            wNoise(p * (1.0 / 1300.0), 61.0).x,
            wNoise(p * (1.0 / 1700.0) + 19.0, 67.0).x
          ) - 0.5;
          vec2 mp = p + wq * 820.0;
          float m700  = wNoise(mp * (1.0 / 700.0), 83.0).x;
          float m2100 = wNoise(mp * (1.0 / 2100.0) + 23.0, 97.0).x;
          float macroPatch = clamp(m700 * 0.62 + m2100 * 0.38, 0.0, 1.0);
          // Flatten the macro pattern once a pixel starts averaging it away.
          macroPatch = mix(0.5, macroPatch, 1.0 - smoothstep(55.0, 190.0, pixSize));

          // Time-of-day body lighting: the unlit sea must darken with the sun.
          float dayLum = mix(0.16, 1.0, smoothstep(-0.08, 0.35, uSunDir.y));
          // Gentle crest break-up with neutral mean so luminance stays steady as
          // each octave fades out near its Nyquist limit.
          float crest = mix(0.5, L22a.x, f22) * 0.42
                      + mix(0.5, L65a.x, f65) * 0.33
                      + mix(0.5, L180a.x, f180) * 0.25;

          vec3 col = mix(uDeep, uShallow, 0.22 + 0.22 * macroPatch);
          col *= dayLum * (0.93 + 0.14 * crest);

          // Smooth Schlick Fresnel (F0 = 0.02) sky reflection.
          vec3 reflDir = reflect(-viewDir, n);
          float skyGrad = smoothstep(0.0, 0.55, max(reflDir.y, 0.0));
          vec3 skyRefl = mix(mix(uSkyColor, fogColor, 0.55), uSkyColor, skyGrad);
          float cosV = clamp(dot(n, viewDir), 0.0, 1.0);
          float fres = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
          col = mix(col, skyRefl, clamp(fres, 0.0, 0.92));

          // Soft sun glitter: sharp core + broad sheen, masked by sunVis and
          // smoothed at grazing angles / far distances.
          vec3 halfVec = normalize(uSunDir + viewDir);
          float sunVis = smoothstep(-0.02, 0.12, uSunDir.y);
          float ndh = max(dot(n, halfVec), 0.0);
          float specCore = pow(ndh, 220.0) * 1.10;
          float specSheen = pow(ndh, 24.0) * 0.045;
          float graze = smoothstep(0.02, 0.16, cosV);
          float farSmooth = mix(1.0, 0.45, smoothstep(7000.0, 30000.0, distXZ));
          col += uSunColor * (specCore * graze + specSheen) * sunVis * farSmooth;

          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    // Float cleanly above the sunken sea-datum terrain (<= -24.0 m) while
    // coastal land >= 0.85 m remains untouched.
    this.mesh.position.y = SEA_LEVEL + 0.12;
    this.mesh.renderOrder = 0;
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
    u.uDeep.value.copy(new THREE.Color(pal?.waterDeep ?? 0x0c3554).convertSRGBToLinear());
    u.uShallow.value.copy(new THREE.Color(pal?.waterShallow ?? 0x1c5d78).convertSRGBToLinear());
  }

  update(dt, camera) {
    this.material.uniforms.uTime.value += dt;
    this.mesh.position.y = SEA_LEVEL + 0.12;
    if (camera && camera.position) {
      const snap = 2000;
      this.mesh.position.x = Math.round(camera.position.x / snap) * snap;
      this.mesh.position.z = Math.round(camera.position.z / snap) * snap;
    }
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