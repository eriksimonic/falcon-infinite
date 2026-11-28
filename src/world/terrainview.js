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
    // Northern Adriatic / Gulf of Trieste: the Monfalcone bay is a muted
    // emerald-teal slate, never the electric mid-blue of open ocean.
    waterDeep: 0x143c48,
    waterShallow: 0x26595b,
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

// In-game F9 Terrain & Color Paint Editor: same world->uv convention as the
// ortho tiers (flipY = false, row 0 == zMin), so painted strokes land exactly
// under the cursor.
uniform sampler2D uEditColorTex;
uniform vec4 uEditBounds;   // xMin, zMin, 1/spanX, 1/spanZ
uniform float uEditEnabled;
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

// Stable 2D hash for cellular (Voronoi) work: unlike thHash() it returns both
// coordinates, so one call yields a jittered cell centre.
vec2 thHash2( vec2 p, float seed ) {
  vec2 q = vec2(
    dot( p, vec2( 127.1, 311.7 ) ) + seed * 17.3,
    dot( p, vec2( 269.5, 183.3 ) ) + seed * 31.7
  );
  return fract( sin( q ) * 43758.5453 );
}

// Tightly packed convex tree-crown domes: returns
//   (height 0..1, dH/dx, dH/dy, speciesId 0..1)
// where each jittered cell is a round treetop mound with a sharp dark shadow
// crevice along the Voronoi boundary. Cells are Laguerre-weighted (each tree
// gets its own crown radius) so broad spreading beech can crowd right up
// against a tiny narrow spruce, and a per-cell species value opens natural
// canopy clearings in ~14% of cells so the forest gathers into groves instead
// of reading as one even carpet. Derivative-free (no fwidth), so it may be
// evaluated under any control flow and its gradient stays per-pixel crisp at
// every sun elevation.
vec4 thCrown( vec2 p, float seed ) {
  vec2 n = floor( p );
  vec2 f = fract( p );
  float minW2 = 8.0;      // winning cell's weighted (Laguerre) squared distance
  float secW2 = 8.0;      // runner-up in the same weighted metric
  vec2 bestVec = vec2( 0.0 );
  float bestH = 0.8;
  float bestGap = 1.0;
  float bestSpecies = 0.5;
  float bestRadW = 1.0;
  for ( int j = -1; j <= 1; j++ ) {
    for ( int i = -1; i <= 1; i++ ) {
      vec2 g = vec2( float( i ), float( j ) );
      vec2 rnd = thHash2( n + g, seed );
      // Wide jitter keeps tree centres from ever lining up in rows.
      vec2 o = 0.05 + 0.90 * rnd;
      vec2 r = g + o - f;
      float d2 = dot( r, r );
      // Per-tree crown radius: big broad crowns win more space, narrow spruce
      // lose it, so the partition thins and thickens organically.
      float radW = 0.62 + 0.95 * fract( rnd.x * 11.31 + rnd.y * 5.73 );
      float wd2 = d2 / ( radW * radW );
      if ( wd2 < minW2 ) {
        secW2 = minW2;
        minW2 = wd2;
        bestVec = r;
        bestRadW = radW;
        bestH = 0.75 + 0.45 * fract( rnd.x * 7.13 + rnd.y * 3.71 );
        // Low species values are clearings / open meadow gaps, everything else
        // is a full-height crown: organic groves, not a uniform canopy skin.
        float species = fract( rnd.x * 19.7 + rnd.y * 7.3 );
        bestSpecies = species;
        bestGap = mix( 0.28, 1.0, smoothstep( 0.06, 0.22, species ) );
      } else if ( wd2 < secW2 ) {
        secW2 = wd2;
      }
    }
  }
  // Convex dome profile (1 at crown peak, dipping sharply into inter-tree
  // crevice). Weighted space keeps the crevice falloff isotropic even between
  // a 2.5x wider crown and its narrow neighbour.
  float edgeGap = smoothstep( 0.0, 0.30, sqrt( secW2 ) - sqrt( minW2 ) );
  // The clearing dip eases back to full crown height at the cell rim, so an
  // opening gets a natural bowl-shaped shoulder instead of a cliff where the
  // neighbouring crown begins.
  float gapW = mix( 1.0, bestGap, smoothstep( 0.05, 0.75, edgeGap ) );
  float dome = clamp( ( 1.0 - minW2 * 1.20 ) * bestH * gapW, 0.0, 1.0 );
  float h = clamp( dome * ( 0.45 + 0.55 * edgeGap ), 0.0, 1.0 );
  // Analytical outward radial slope of the crown dome (points from center to
  // edge). Divided by the crown weight squared because the dome is profiled in
  // weighted space: narrow spruce rims stay crisp, broad flat crowns stay soft.
  vec2 grad = bestVec * ( 2.6 * bestH * gapW ) / ( bestRadW * bestRadW );
  return vec4( h, grad.x, grad.y, bestSpecies );
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
  // WaterSurface is an opaque ocean plane at y = -0.18 m across the entire
  // world. Discarding terrain fragments strictly below -0.24 m eliminates all
  // seabed Z-fighting through the sea at every distance (0..160 km) and near
  // plane (0.08..0.3 m) while keeping a 6 cm overlap at the waterline (zero crack).
  if ( vTerrWorld.y < -0.24 ) discard;

  vec3 terrBase = diffuseColor.rgb;
  vec2 terrP = vTerrWorld.xz;
  float terrDist = length( vTerrWorld - cameraPosition );

  // Screen-space pixel footprint in metres: fwidth() is already m/px here.
  float pxM = max( fwidth( terrP.x ), fwidth( terrP.y ) );

  // 5-octave per-band LOD cascade. Each band multiplies a smooth distance
  // rolloff by its own wavelength-matched Nyquist rolloff, so an octave
  // dissolves just before it would shimmer while the coarser octaves stay
  // vivid from cruise altitude.
  float f2 = ( 1.0 - smoothstep( 350.0, 1400.0, terrDist ) ) * ( 1.0 - smoothstep( 0.45, 1.55, pxM ) );
  float f6 = ( 1.0 - smoothstep( 1200.0, 4800.0, terrDist ) ) * ( 1.0 - smoothstep( 1.4, 4.2, pxM ) );
  float f28 = ( 1.0 - smoothstep( 4500.0, 16000.0, terrDist ) ) * ( 1.0 - smoothstep( 6.5, 19.0, pxM ) );
  float f140 = ( 1.0 - smoothstep( 15000.0, 36000.0, terrDist ) ) * ( 1.0 - smoothstep( 32.0, 92.0, pxM ) );
  float f520 = 1.0 - smoothstep( 34000.0, 56000.0, terrDist );

  // 2.2 m / 6 m / 28 m / 140 m / 520 m world-space detail octaves with distinct
  // non-orthogonal rotations so hills never show axis-aligned grid blobs.
  // The 2.2 m octave is evaluated only when it is still resolvable; thNoise()
  // uses no fwidth()/dFdx()/dFdy(), so gating it on f2 is branch-safe and
  // saves GPU ALU over distant terrain.
  mat2 r2 = mat2( -0.52, -0.85, 0.85, -0.52 );
  mat2 r6 = mat2( 0.80, -0.60, 0.60, 0.80 );
  mat2 r28 = mat2( 0.45, -0.89, 0.89, 0.45 );
  mat2 r140 = mat2( -0.73, -0.68, 0.68, -0.73 );
  mat2 r520 = mat2( 0.28, 0.96, -0.96, 0.28 );

  vec3 n2 = vec3( 0.5, 0.0, 0.0 );
  if ( f2 > 0.005 ) {
    n2 = thNoise( ( r2 * terrP ) * ( 1.0 / 2.2 ), 211.0 );
  }
  vec3 n6 = thNoise( ( r6 * terrP ) * ( 1.0 / 6.0 ), 11.0 );
  vec3 n28 = thNoise( ( r28 * terrP ) * ( 1.0 / 28.0 ), 37.0 );
  vec3 n140 = thNoise( ( r140 * terrP ) * ( 1.0 / 140.0 ), 73.0 );
  vec3 n520 = thNoise( ( r520 * terrP ) * ( 1.0 / 520.0 ), 131.0 );
  float d2 = n2.x - 0.5;
  float d6 = n6.x - 0.5;
  float d28 = n28.x - 0.5;
  float d140 = n140.x - 0.5;
  float d520 = n520.x - 0.5;

  // The detail gradient is assembled per octave in the micro-bump pass, where
  // each band is weighted by its own fade.

  // Swizzle to .xyz BEFORE normalizing: vec4(n, 0.0) * viewMatrix puts the
  // view-matrix translation dot product (~camera distance) into .w, so a 4D
  // normalize() would divide .xyz by ~1e4 and collapse terrN to ~0.
  vec3 terrN = normalize( ( vec4( normalize( vNormal ), 0.0 ) * viewMatrix ).xyz );
  float terrSlope = length( terrN.xz ) / max( abs( terrN.y ), 0.08 );

  // Rock and strata shading terms stay outside the albedo branch because
  // DETAIL_NORMAL and DETAIL_SHEEN read them.
  float rockMask = smoothstep( 0.38, 0.84, terrSlope ) * uTerrShape.z;
  float strataFw = fwidth( vTerrWorld.y );
  float strataAA = 1.0 - smoothstep( 0.35, 1.35,
    strataFw / max( uTerrStrata.x, 1.0 ) );
  float warp = ( d140 * 0.9 + d28 * 0.15 ) * uTerrStrata.x;

  // Field parcel lattice, hoisted for the same reason: rowFade needs
  // fwidth( cf.x ), and no derivative may sit inside per-pixel control flow.
  // Rotation drifts with the macro noise so neighbouring valleys differ.
  float rot = mix( -0.5, 0.62, n140.x ) + d28 * 0.18;
  float cr = cos( rot );
  float sr = sin( rot );
  vec2 rp = vec2( terrP.x * cr - terrP.y * sr, terrP.x * sr + terrP.y * cr );
  vec2 gcell = rp / vec2( 96.0, 143.0 );
  vec2 cell = floor( gcell );
  vec2 cf = fract( gcell );
  float cfFw = fwidth( cf.x );

  // Ortho tier weights, hoisted above the procedural albedo so the skip test
  // is a plain comparison. The tier uv/weight vectors are reused by the drape;
  // only the texture reads happen there.
  vec3 oMacro = vec3( 0.0 );
  vec3 oReg = vec3( 0.0 );
  vec3 oHD = vec3( 0.0 );
  float satW = 0.0;
  if ( uOrthoFlags.w > 0.5 ) {
    if ( uOrthoFlags.z > 0.5 ) {
      oMacro = orthoWeight( terrP, uOrthoMacroBounds, uOrthoBlend.z );
      satW = oMacro.z;
    }
    if ( uOrthoFlags.y > 0.5 ) {
      oReg = orthoWeight( terrP, uOrthoRegBounds, uOrthoBlend.y );
      satW = max( satW, oReg.z );
    }
    if ( uOrthoFlags.x > 0.5 ) {
      oHD = orthoWeight( terrP, uOrthoHDBounds, uOrthoBlend.x );
      satW = max( satW, oHD.z );
    }
  }
  // Shorelines: over water the terrain mesh is sunk to the seabed, so the
  // imagery must fade back into the coastal seabed tint instead of showing a
  // satellite sea surface under the ocean plane. Hoisted because it is part of
  // the skip decision: submerged pixels still need the procedural albedo.
  float submerge = 1.0 - smoothstep( -2.2, -0.10, vTerrWorld.y );

  vec3 terrAlb = diffuseColor.rgb;

  // Under a fully opaque satellite drape on dry ground the procedural albedo is
  // computed and then thrown away by mix( terrAlb, satRgb, 1.0 ). Skip it there.
  // Every derivative and every value DETAIL_NORMAL / DETAIL_SHEEN reads is
  // already computed above, so this branch holds no fwidth()/dFdx()/dFdy().
  if ( satW < 0.999 || submerge > 0.0 ) {
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

    float ch = thHash( cell + 19.0 );

    vec3 fieldCol = mix( uTerrFieldB, uTerrFieldC, smoothstep( 0.16, 0.30, ch ) );
    fieldCol = mix( fieldCol, uTerrFieldA, smoothstep( 0.46, 0.60, ch ) );
    fieldCol = mix( fieldCol, uTerrFieldD, smoothstep( 0.74, 0.86, ch ) );
    fieldCol *= 0.86 + 0.30 * fract( ch * 7.31 );          // mown vs lush parcels
    fieldCol = mix( terrBase, fieldCol, 0.72 );            // stay in palette

    // Vineyard rows / plough furrows, faded before they alias.
    float vine = smoothstep( 0.70, 0.84, ch );
    float rowFade = ( 1.0 - smoothstep( 0.7, 2.0, cfFw * 56.6 ) )
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
  }

  // 3c) Real satellite ortho-imagery drape: macro -> regional -> HD, each tier
  // cross-faded by a metric edge weight so the three JPEGs never seam. Only
  // active in the baked Vipava theater (uOrthoFlags.w), so temperate/desert
  // stay 100% procedural.
  if ( uOrthoFlags.w > 0.5 ) {
    // Atmospheric air blurring & heat-haze distortion: 0 up close (< 4.5 km) so
    // nearby fields & forests stay tack-sharp, ramping progressively softer over
    // 5..45 km of warm valley air.
    float airBlurT = smoothstep( 4500.0, 42000.0, terrDist );
    float distMipBias = airBlurT * 2.4;
    // Subtle rising heat-haze refraction shimmer in warm daytime valley air (> 6 km).
    float airShimmerAmt = smoothstep( 6000.0, 26000.0, terrDist )
                        * smoothstep( 0.05, 0.35, uTerrSunDir.y )
                        * ( 1.0 - smoothstep( 150.0, 1800.0, vTerrWorld.y ) );
    vec2 airShimmer = vec2(
      sin( terrP.y * 0.0018 - uTerrTime * 2.1 + terrP.x * 0.0005 ),
      cos( terrP.x * 0.0015 - uTerrTime * 1.7 - terrP.y * 0.0006 )
    ) * ( 0.00055 * airShimmerAmt );

    // The bias argument walks the hardware trilinear mip chain instead of
    // fetching extra taps: zero extra samplers or render targets, yet kilometres
    // of air soften the imagery exactly the way the eye expects. Each tier takes
    // the same shimmer warp scaled down with its resolution so the three JPEGs
    // never shear apart at their cross-fade seams.
    vec3 satRgb = vec3( 0.0 );
    if ( uOrthoFlags.z > 0.5 ) {
      satRgb = texture2D( uOrthoMacro, clamp( oMacro.xy + airShimmer, 0.001, 0.999 ), distMipBias ).rgb;
    }
    if ( uOrthoFlags.y > 0.5 ) {
      satRgb = mix( satRgb, texture2D( uOrthoReg, clamp( oReg.xy + airShimmer * 0.85, 0.001, 0.999 ), distMipBias ).rgb, oReg.z );
    }
    if ( uOrthoFlags.x > 0.5 ) {
      satRgb = mix( satRgb, texture2D( uOrthoHD, clamp( oHD.xy + airShimmer * 0.55, 0.001, 0.999 ), distMipBias * 0.85 ).rgb, oHD.z );
    }

    // Baked imagery already carries its own shadow; Three.js Lambert adds sun
    // and hemisphere on top, so lift the satellite shadows a touch and keep a
    // faint gamma curve to stop the valley reading as double-darkened mud.
    satRgb = pow( max( satRgb, vec3( 0.0 ) ), vec3( 0.95 ) ) * 1.05;

    // Crisp 2.2 m / 6 m / 28 m luminance-aware micro-grain so imagery stays
    // tactile at AGL 30-400 m instead of turning into a blurry photo pasted on
    // the ground. The mask backs off on deep shadow and near-white surfaces so
    // the grain reads as meadow/soil/karst texture, never as noise.
    float satLum = dot( satRgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    float grainMask = smoothstep( 0.04, 0.18, satLum ) * ( 1.0 - smoothstep( 0.65, 0.92, satLum ) * 0.45 );
    float microGrain = d2 * 0.16 * f2 + d6 * 0.14 * f6 + d28 * 0.10 * f28;
    // Air absorbs contrast with range: the same airBlurT that biases the mip
    // chain also fades this procedural grain, so distant meadows/karst soften
    // into haze instead of sparkling against the blurred imagery.
    microGrain *= 1.0 - 0.5 * airBlurT;
    satRgb *= 1.0 + microGrain * grainMask;

    // Subtle warm/cool earth micro-tint keeps large ortho patches organic.
    vec3 microTint = mix( vec3( 0.97, 1.01, 0.98 ), vec3( 1.03, 0.99, 0.96 ), n28.x );
    satRgb *= mix( vec3( 1.0 ), microTint, 0.35 * f28 * grainMask );

    satRgb = mix( satRgb, terrAlb, submerge * 0.85 );

    terrAlb = mix( terrAlb, satRgb, satW );
  }

  // 3c-bis) Mediterranean shoreline band (Monfalcone / Marina Julia / Grado).
  // With the sea-datum sink fixed the coastal fields stay dry, so the waterline
  // is now a land/sea contact instead of a 24 m cliff. Feather that contact into
  // wet shoal, broken limestone surf wash, wet karst boulders and damp-to-dry
  // shingle. The contour itself is broken by THREE rotated octaves (28 m + 6 m
  // + 2.2 m), so every band edge is a crisp irregular rocky indentation instead
  // of a smooth, straight, plastic line.
  {
    float shoreNoise = d28 * 0.65 + d6 * 0.45 + d2 * 0.25;
    float shoreH = vTerrWorld.y + shoreNoise * 0.45;
    float shoreFade = 1.0 - smoothstep( 18000.0, 32000.0, terrDist );

    // Wet submerged rock feather: melt the seaward rock from -0.70 m through
    // +0.10 m smoothly into Adriatic shallow teal, so there is no colour jump
    // and no hard straight intersection where the terrain meets the sea plane.
    float shoal = 1.0 - smoothstep( -0.70, 0.10, shoreH );
    terrAlb = mix( terrAlb, vec3( 0.032, 0.095, 0.102 ), shoal * 0.80 );

    // Coastal stones: dark wet limestone boulders against pale weathered
    // Adriatic karst cobbles and gritty shingle gravel. Every octave used here
    // (d2/d6/d28, n6/n28) is already evaluated above - zero extra noise fetches.
    float shoreStoneMask = smoothstep( -0.45, 0.0, shoreH )
                         * ( 1.0 - smoothstep( 0.55, 2.2, shoreH ) );
    // The strong boulder/cobble relief belongs at the waterline: fade it out by
    // +1.15 m so Monfalcone's reclaimed farmland above +0.8 m stays clean
    // green/ortho while the actual 0..1.1 m shore reads richly stony and rugged.
    float stoneW = shoreStoneMask * shoreFade
                 * ( 1.0 - smoothstep( 0.60, 1.15, shoreH ) )
                 * ( 1.0 - 0.45 * smoothstep( 0.55, 1.15, terrSlope ) );
    float stoneSpeck = clamp( 0.5 + d2 * 1.45 + d6 * 0.95 + ( n6.x - 0.5 ) * 0.60,
                              0.0, 1.0 );
    float stoneGrit = smoothstep( 0.46, 0.74, stoneSpeck );          // crisp shingle
    float stonePatch = smoothstep( 0.32, 0.68, n6.x * 0.62 + n28.x * 0.38 );
    vec3 stoneCol = mix( vec3( 0.14, 0.14, 0.13 ),                   // wet boulder
                         vec3( 0.36, 0.34, 0.29 ),                   // pale karst
                         smoothstep( 0.24, 0.80, stoneSpeck ) );
    // Gritty gravel between the cobbles plus darkened troughs and crevices, so
    // the stones read as real 3D rubble instead of a flat painted tint.
    stoneCol = mix( stoneCol, vec3( 0.29, 0.27, 0.22 ), 0.34 * stoneGrit );
    stoneCol *= 0.80 + 0.34 * ( 0.5 + d6 * 1.2 + d28 * 0.5 );
    terrAlb = mix( terrAlb, stoneCol,
                   stoneW * ( 0.26 + 0.46 * stonePatch + 0.18 * stoneGrit ) );

    // Broken pale surf wash / pebble specks straddling -0.26 .. +0.18 m so the
    // depth intersection is dissolved into irregular wash rather than a stroke.
    float surfBand = smoothstep( -0.26, -0.10, shoreH )
                   * ( 1.0 - smoothstep( 0.06, 0.18, shoreH ) );
    float surfBreak = smoothstep( 0.18, 0.70,
                                 n2.x * 0.30 + n6.x * 0.45 + n28.x * 0.25 );
    terrAlb = mix( terrAlb, vec3( 0.36, 0.37, 0.34 ),
                   surfBand * surfBreak * shoreFade * 0.50 );

    // Damp sand -> dry pale shingle, only on gentle shores: the steep Duino
    // limestone cliffs keep their rock while Grado's flats get real beach.
    // Tighter +1.15 m upper fade and a 0.28 cap keep Monfalcone's real ports,
    // docks and reclaimed fields recognisable instead of sand-blasted.
    float beachMask = smoothstep( -0.12, 0.22, shoreH )
                    * ( 1.0 - smoothstep( 0.62, 1.15, shoreH ) )
                    * ( 1.0 - smoothstep( 0.35, 0.85, terrSlope ) )
                    * ( 1.0 - smoothstep( 22000.0, 38000.0, terrDist ) );
    vec3 beachCol = mix( vec3( 0.22, 0.20, 0.15 ), vec3( 0.34, 0.31, 0.23 ),
                         smoothstep( 0.25, 1.55, shoreH ) );
    terrAlb = mix( terrAlb, beachCol, beachMask * 0.28 );
  }

  // 3d) Forest canopy mask. Hoisted OUT of every if block because DETAIL_NORMAL
  // and DETAIL_SHEEN read it: terrAlb is fully finalized here (the ortho branch
  // above has already mixed satRgb in), and a declaration placed inside that
  // branch would not be in scope for the later passes.
  // Deep-green, moderately lit, non-vertical ground above the valley floor and
  // below the alpine snow line. The mask keys on the scale-invariant normalized
  // green ratio gRatio = G / (R+G+B): measured on vipava_ortho_hd.jpg real
  // conifer/deciduous mountains sit at 0.395..0.458 regardless of exposure,
  // while grey towns, asphalt roads and pale limestone cluster near 0.333.
  // A raw green-excess term would be crushed by the dark linear luminance
  // (0.018..0.093) of shaded forest, which is exactly what made the old mask
  // almost invisible.
  float rgbSum = terrAlb.r + terrAlb.g + terrAlb.b;
  float gRatio = terrAlb.g / max( rgbSum, 0.0001 );
  float fLum = dot( terrAlb, vec3( 0.2126, 0.7152, 0.0722 ) );
  float forestMask = smoothstep( 0.362, 0.412, gRatio )
                   * ( 1.0 - smoothstep( 0.105, 0.195, fLum ) )
                   * smoothstep( 0.004, 0.014, fLum )
                   * ( 1.0 - smoothstep( 0.78, 1.38, terrSlope ) )
                   * smoothstep( 2.0, 22.0, vTerrWorld.y )
                   * ( 1.0 - smoothstep( 1500.0, 1820.0, vTerrWorld.y ) );

  // 3e) Tree-crown fur: 30 m forest stand clumps + 13 m individual crowns, each
  // an analytic 3x3 cellular Voronoi dome (thCrown) so forested ridges read as
  // tightly packed convex treetops parted by dark shadow crevices instead of
  // soft, flat noise. thCrown() is derivative-free, so evaluating it
  // unconditionally stays branch-safe; the fades only weight it.
  vec3 fViewDir = normalize( cameraPosition - vTerrWorld );
  mat2 rCan2 = mat2( -0.83, -0.56, 0.56, -0.83 );
  mat2 rCan1 = mat2( 0.62, -0.78, 0.78, 0.62 );
  float fCan2 = ( 1.0 - smoothstep( 28000.0, 48000.0, terrDist ) )
              * ( 1.0 - smoothstep( 7.0, 26.0, pxM ) );
  float fCan1 = ( 1.0 - smoothstep( 14000.0, 28000.0, terrDist ) )
              * ( 1.0 - smoothstep( 2.6, 9.5, pxM ) );
  // Organic domain warp built ONLY from the multi-scale fields already
  // evaluated above - zero extra noise fetches. The d* values and the n*.y
  // derivatives are both centred on 0 (n*.y is d(value)/d(p), not a value), so
  // pairing them keeps the warp free of DC bias: it displaces the cell lattice
  // without shifting the forest as a whole. 140 m + 28 m ragged up the 30 m
  // stands, 28 m + 6 m the 13 m individual crowns, so cell boundaries stop
  // reading as straight geometric seams.
  vec2 canWarp2 = vec2( d140, n140.y * 0.45 ) * 18.0
                + vec2( d28,  n28.y  * 0.45 ) * 8.0;
  vec2 canWarp1 = vec2( d28,  n28.y  * 0.45 ) * 7.5
                + vec2( d6,   n6.y   * 0.45 ) * 3.0;
  vec4 can2 = thCrown( ( rCan2 * ( terrP + canWarp2 ) ) * ( 1.0 / 30.0 ), 173.0 );
  // One-step canopy height parallax: crown tops sample slightly ahead of the
  // trunk line, so an oblique camera sees treetop thickness on forested ridges
  // instead of a flat painted dome.
  vec2 furShift = fViewDir.xz * ( ( can2.x - 0.35 ) * 6.5 / max( fViewDir.y, 0.28 ) );
  vec4 can1 = thCrown( ( rCan1 * ( terrP + canWarp1 + furShift ) ) * ( 1.0 / 13.0 ), 197.0 );
  // Billowy convex crown domes: stands carry the broad silhouette, individual
  // crowns give the bumpy texture.
  float crownH = clamp( can1.x * 0.65 + can2.x * 0.35, 0.0, 1.0 );
  // Leafy edge breakup: fine 6 m relief and the 28 m octave (band-limited by
  // its own LOD fade so it cannot shimmer at range) shear the silhouette into
  // irregular treetop edges instead of clean round domes.
  crownH = clamp( crownH + d6 * 0.28 * f6 + d28 * 0.18 * f28, 0.0, 1.0 );
  // Lush right down to 800 m - 2 km (alongside the real instanced trees) and
  // bold all the way out to the 35 km horizon where instances are gone.
  float furDistW = 0.55 + 0.45 * smoothstep( 600.0, 3200.0, terrDist );
  // Grove patchiness: thick tight conifer stands on one ridge, naturally
  // broken and thinned canopy on the next flank, instead of an even carpet.
  float grovePatch = smoothstep( 0.18, 0.78, n140.x * 0.6 + n28.x * 0.4 );
  float furW = forestMask * furDistW * max( fCan1, fCan2 ) * mix( 0.45, 1.0, grovePatch );
  // Canopy crevice self-shadowing: dark troughs between crowns, crisp sunlit
  // crown tips.
  float furShade = mix( 0.52, 1.28, smoothstep( 0.08, 0.86, crownH ) );
  // Per-tree multi-species tint across four real Slovenian alpine/karst tones:
  // dark blue spruce -> deep pine -> sunlit olive beech -> warm ochre oak scrub.
  // can1.w is this individual crown's species seed, can2.w its surrounding
  // stand's; per-tree dominates close in and hands over to the stand seed as
  // the 13 m crowns fade, so the tint never aliases into sub-pixel confetti.
  float spTree = mix( can2.w, can1.w, clamp( fCan1 * 1.3, 0.0, 1.0 ) );
  vec3 furTint = mix( vec3( 0.74, 0.87, 0.80 ), vec3( 0.90, 0.99, 0.87 ),
                      smoothstep( 0.12, 0.36, spTree ) );
  furTint = mix( furTint, vec3( 1.10, 1.08, 0.84 ), smoothstep( 0.40, 0.62, spTree ) );
  furTint = mix( furTint, vec3( 1.14, 0.95, 0.76 ), smoothstep( 0.70, 0.94, spTree ) );
  // Per-tree brightness jitter so neighbouring crowns of the same species
  // still read as separate trees rather than one flat colour field.
  float spLum = 0.90 + 0.20 * fract( can1.w * 7.31 + can2.w * 3.17 );
  furTint *= mix( 1.0, spLum, mix( 0.4, 1.0, fCan1 ) );
  terrAlb *= mix( vec3( 1.0 ), furTint * furShade, furW );

  // 3g) Fine leaf-cluster / needle-tuft micro-detail layered on top of the
  // crown fur: a 4.2 m bough sub-clump octave plus a 1.8 m dappled individual
  // leaf-fleck octave. Both Nyquist fades (and every domain-warp offset) are
  // computed OUTSIDE the branch so gating on them stays derivative-safe, and
  // thNoise() uses no fwidth()/dFdx()/dFdy(), so the two fetches are skipped
  // outright on non-forest pixels and distant hills at zero shimmer cost.
  float fLeaf2 = ( 1.0 - smoothstep( 2600.0, 6200.0, terrDist ) )
               * ( 1.0 - smoothstep( 1.0, 3.6, pxM ) );
  float fLeaf1 = ( 1.0 - smoothstep( 800.0, 2400.0, terrDist ) )
               * ( 1.0 - smoothstep( 0.40, 1.45, pxM ) );
  mat2 rLeaf2 = mat2( 0.91, -0.41, 0.41, 0.91 );
  mat2 rLeaf1 = mat2( -0.34, -0.94, 0.94, -0.34 );
  vec3 leaf2 = vec3( 0.5, 0.0, 0.0 );
  vec3 leaf1 = vec3( 0.5, 0.0, 0.0 );
  if ( forestMask > 0.01 && ( fLeaf2 > 0.005 || fLeaf1 > 0.005 ) ) {
    // Shear the leaf lattice by the same irregular crown domain warp (plus the
    // thCrown gradient) the fur uses, so tufts cling to the 3D treetop
    // geometry instead of sliding over it as a flat painted layer.
    vec2 leafP = terrP + furShift + can1.yz * 1.35;
    if ( fLeaf2 > 0.005 ) {
      leaf2 = thNoise( ( rLeaf2 * leafP ) * ( 1.0 / 4.2 ), 239.0 );
    }
    if ( fLeaf1 > 0.005 ) {
      // Warp the 1.8 m flecks by the coarse bough field so individual leaves
      // bunch into clumps with ragged holes instead of an even dither.
      vec2 leafWarp = vec2( leaf2.x - 0.5, leaf2.y * 0.4 ) * 1.1;
      leaf1 = thNoise( ( rLeaf1 * ( leafP + leafWarp ) ) * ( 1.0 / 1.8 ), 271.0 );
    }
  }
  // Dappled leaf speckle: the 4.2 m octave lumps the crown into bough
  // sub-clumps, the crisp 1.8 m octave punches tiny sunlit individual leaves
  // and dark sub-canopy shadow pockets into every crown. The contrast gain is
  // clamped so no fleck can blow out or crush the underlying albedo.
  float leafFleck = ( leaf2.x - 0.5 ) * 0.55 * fLeaf2
                  + ( leaf1.x - 0.5 ) * 0.72 * fLeaf1;
  float leafW = forestMask * max( fLeaf2, fLeaf1 );
  float leafContrast = clamp( 1.0 + leafFleck * 0.68, 0.62, 1.38 );
  // Sunlit golden-leaf tips on the bright face of a tuft, cool deep green in
  // the shadow pockets between them.
  vec3 leafTipTint = mix( vec3( 0.92, 0.97, 0.90 ), vec3( 1.12, 1.07, 0.80 ),
                          clamp( 0.5 + leafFleck * 1.4, 0.0, 1.0 ) );
  terrAlb *= mix( vec3( 1.0 ), leafContrast * leafTipTint, leafW );

  // 3f) Close-range sun-baked Mediterranean grade. Real late-summer alpine
  // pasture and forest at 0..7 km reads golden-olive under a high sun, not the
  // loud emerald of raw satellite albedo. The weight dies out by ~7.5 km where
  // the bluish Rayleigh aerial perspective already cools the terrain, so the
  // near grade can never fight the distance haze.
  float nearYellowW  = 1.0 - smoothstep( 1800.0, 7500.0, terrDist );
  // Gate on the same scale-invariant green ratio the forest mask uses: roads,
  // grey Karst limestone, terracotta roofs and blue-teal water sit near 0.333
  // and keep their own colour; only genuinely green hills get re-graded.
  float gPull = smoothstep( 0.34, 0.44, gRatio );
  // (a) Trim over-saturated green toward its natural luminance so crowns and
  // meadows lose the toy-green glow without flattening the overall exposure.
  float tLum = dot( terrAlb, vec3( 0.2126, 0.7152, 0.0722 ) );
  terrAlb = mix( terrAlb, vec3( tLum ), 0.16 * nearYellowW * gPull );
  // (b) Push the golden-yellow channel bias for sun-baked fields, meadows and
  // forested hillsides: more red/yellow, less blue.
  terrAlb *= mix( vec3( 1.0 ), vec3( 1.12, 1.03, 0.82 ), 0.58 * nearYellowW * gPull );

  // 3f-bis) Soft neon-green chroma guard: tame overly loud lime/neon pasture
  // spots toward natural Mediterranean olive without touching deep Kras conifers.
  float neonExcess = smoothstep( 0.405, 0.475, gRatio ) * smoothstep( 0.065, 0.155, fLum );
  if ( neonExcess > 0.001 ) {
    float nLum = dot( terrAlb, vec3( 0.2126, 0.7152, 0.0722 ) );
    vec3 naturalOlive = mix( terrAlb, vec3( nLum ), 0.34 ) * vec3( 1.04, 0.94, 0.90 );
    terrAlb = mix( terrAlb, naturalOlive, neonExcess * 0.65 );
  }

  // 3h) User-painted colour / saturation overlay (F9 Terrain & Color Painter).
  if ( uEditEnabled > 0.5 ) {
    vec2 edUv = ( terrP - uEditBounds.xy ) * uEditBounds.zw;
    if ( edUv.x >= 0.0 && edUv.x <= 1.0 && edUv.y >= 0.0 && edUv.y <= 1.0 ) {
      vec4 ed = texture2D( uEditColorTex, edUv );
      // Byte 128 (128/255 = 0.5019608) is exact 1.0 identity for tint & saturation.
      vec3 edTint = ed.rgb * ( 255.0 / 128.0 );
      float edSat = ed.a * ( 255.0 / 128.0 );
      float edLum = dot( terrAlb, vec3( 0.2126, 0.7152, 0.0722 ) );
      terrAlb = mix( vec3( edLum ), terrAlb, edSat );
      terrAlb *= edTint;
    }
  }

  diffuseColor.rgb = terrAlb;
`;

// Micro-bump pass, injected right after <normal_fragment_begin>.
const DETAIL_NORMAL = /* glsl */`
  // 4) Restrained micro-bump: keep smooth valley floors and forested slopes
  // clean (avoiding the crumpled bump-map look) while preserving crisp rock
  // relief on steep Karst cliffs and canyon walls.
  float bumpFade = 1.0 - smoothstep( 26000.0, 44000.0, terrDist );
  // Distant air columns swallow micro-relief the same way they blur the ortho
  // mip chain: past 12 km the 2.2 m / 6 m / 28 m ground grain and rock bump
  // relax toward the smooth macro normal instead of sparkling at range.
  float farSoftN = smoothstep( 12000.0, 45000.0, terrDist );
  // Grazing sunset light makes any tangential normal tilt read as a hard
  // shadow/sun flip, so damp the micro-bump as the sun sinks (leopard spots).
  float sunBump = smoothstep( 0.05, 0.30, uTerrSunDir.y );
  float bumpAmt = uTerrShape.y * bumpFade * mix( 0.44, 0.80, rockMask ) * mix( 0.24, 1.0, sunBump );
  bumpAmt *= ( 1.0 - 0.55 * farSoftN );
  // The 2.2 m octave rides along under the same f2 gate that produced n2: when
  // it is off, n2.yz is exactly 0 and the weight is 0, so the term vanishes.
  vec2 detailG = ( n2.yz * r2 )     * ( 0.22 * f2   / 2.2 )
               + ( n6.yz * r6 )     * ( 0.42 * f6   / 6.0 )
               + ( n28.yz * r28 )   * ( 1.25 * f28  / 28.0 )
               + ( n140.yz * r140 ) * ( 2.35 * f140 / 140.0 )
               + ( n520.yz * r520 ) * ( 3.40 * f520 / 520.0 );

  // 4a-bis) Coastal stone / Karst boulder micro-bump. Rebuild exactly the
  // shoreline mask the albedo pass tinted with (still zero extra noise fetches:
  // d2/d6/d28 and n2/n6 are the shared octaves, and the 2.2 m / 6 m gradients
  // dissolve on their own fades), then push crisp stone facets into detailG
  // BEFORE the saturating hyperbola so a boulder rim can never fold the normal.
  float shoreStoneH = vTerrWorld.y + ( d28 * 0.65 + d6 * 0.45 + d2 * 0.25 ) * 0.45;
  float shoreStoneMask = smoothstep( -0.45, 0.0, shoreStoneH )
                       * ( 1.0 - smoothstep( 0.55, 2.2, shoreStoneH ) );
  // Strongest right at the waterline so inland fields stay flat and clean.
  float shoreStoneW = shoreStoneMask * ( 1.0 - smoothstep( 0.60, 1.15, shoreStoneH ) );
  vec2 stoneG = ( n2.yz * r2 ) * ( 0.62 * f2 / 2.2 )
              + ( n6.yz * r6 ) * ( 1.05 * f6 / 6.0 );
  detailG += stoneG * shoreStoneW;
  // Tactile boulder relief: boost the bump amplitude on the stony shoreline so
  // wet limestone cobbles physically catch the sun with crisp 3D relief.
  bumpAmt += shoreStoneMask * 0.65 * bumpFade;
  // Smooth hyperbolic saturation instead of a hard clamp: C-infinity smooth and
  // mathematically bounded below 0.44 everywhere, so micro-relief stays crisp
  // and readable while it becomes impossible for a peak to fold the normal over
  // into a black zig-zag/leopard speck at grazing light.
  float gLen = length( detailG );
  detailG *= 0.44 / ( 0.44 + gLen );
  vec2 bumpG = detailG;

  // 4b) Tree-crown dome bump. thCrown() already carries the analytic outward
  // radial slope of each convex crown, so rotating the gradient back out of
  // cell space into world XZ gives crisp per-treetop normals that catch
  // directional sun and dusk light at any elevation. Saturated with the
  // identical hyperbolic falloff as detailG so a crown edge can never fold the
  // normal past vertical and punch a black grazing-angle speck.
  vec2 canopyG = ( can1.yz * rCan1 ) * ( 0.72 * fCan1 )
               + ( can2.yz * rCan2 ) * ( 0.52 * fCan2 );
  // Leafy micro-ruffle: the 6 m derivative field adds bushy, needle-cluster
  // relief on top of each convex dome so crowns never read as smooth billiard
  // balls. Gated by the canopy fades and by the same LOD band as n6, so it
  // dissolves before it can shimmer at range.
  canopyG += ( n6.yz * r6 ) * ( 0.85 * f6 / 6.0 ) * max( fCan1, fCan2 );
  // Individual bough / leaf-cluster micro-bump: the leaf octaves' own analytic
  // gradients rotated back into world XZ, scaled by their wavelength and their
  // Nyquist fades (both of which are constant per pixel here), so sunlit
  // ruffled leaf clusters catch light up close and dissolve cleanly before the
  // 1.8 m / 4.2 m lattices could alias at range. The shared hyperbolic
  // saturation below keeps the combined normal from ever folding over.
  canopyG += ( leaf2.yz * rLeaf2 ) * ( 0.85 * fLeaf2 / 4.2 )
           + ( leaf1.yz * rLeaf1 ) * ( 0.62 * fLeaf1 / 1.8 );
  float cLen = length( canopyG );
  canopyG *= 0.64 / ( 0.64 + cLen );
  float furBump = forestMask * furDistW * mix( 0.55, 1.0, sunBump ) * 1.15;

  float bandUp = thStrata( vTerrWorld.y + 0.5, warp, uTerrStrata.x, uTerrStrata.y );
  float bandDown = thStrata( vTerrWorld.y - 0.5, warp, uTerrStrata.x, uTerrStrata.y );
  float strataTilt = ( bandUp - bandDown ) * rockMask * strataAA * bumpFade * 0.12;

  vec3 terrNp = normalize( vec3(
    terrN.x - bumpG.x * bumpAmt - canopyG.x * furBump,
    terrN.y - strataTilt,
    terrN.z - bumpG.y * bumpAmt - canopyG.y * furBump
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
  // Canopy needles are matte: kill the smooth-ground glare over forest so the
  // fur reads as foliage rather than varnished hillside.
  terrRough = clamp( terrRough + forestMask * 0.25, 0.05, 1.0 );
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

  // 3) Aerial perspective (VI PER-ATMOS): distant ridges drift toward a
  // height-aware bluish Rayleigh haze, and the air between the camera and a
  // ridge that sits toward the sun azimuth catches warm sunlit Mie dust. The
  // valley floor is dustier than high alpine air, so Nanos, Trnovski gozd and
  // the Julian Alps separate in depth instead of dissolving into flat grey.
  // terrV above is already -terrViewDir (camera -> surface is the view ray).
  vec3 terrViewDir = -terrV;
  // Night stays dark and crisp: no blue haze without daylight.
  float dayVis = smoothstep( -0.05, 0.25, uTerrSunDir.y );

  // 3a) Velvety forest fuzz / crown rim backscatter: grazing-angle light
  // scattering off needles and sunlit crown tips, warm olive rather than the
  // grey specular a smooth hillside would give. Applied here so it enters the
  // buffer BEFORE the aerial-perspective mix below and therefore hazes cleanly
  // into the blue alpine atmosphere instead of glowing through it.
  float furVelvet = pow( 1.0 - max( dot( terrNp, terrV ), 0.0 ), 2.2 ) * 0.075
                  + smoothstep( 0.45, 0.90, crownH ) * 0.065;
  outgoingLight += vec3( 0.42, 0.54, 0.28 ) * uTerrSunColor * furVelvet
                 * forestMask * furDistW * dayVis
                 * max( dot( terrN, uTerrSunDir ) * 0.6 + 0.4, 0.0 );
  float lowAir = 1.0 - smoothstep( 100.0, 2600.0, 0.5 * ( cameraPosition.y + vTerrWorld.y ) );
  float aerialT = 1.0 - exp( -terrDist * ( 0.000024 + lowAir * 0.000020 ) );
  aerialT = clamp( aerialT * smoothstep( 2500.0, 9000.0, terrDist ), 0.0, 0.72 );
  vec3 rayleighBlue = mix( vec3( 0.42, 0.58, 0.80 ), vec3( 0.54, 0.68, 0.86 ),
    smoothstep( 0.0, 0.5, uTerrSunDir.y ) );
  // Nudge the analytic Rayleigh tint toward the live sky zenith so the far
  // ridges and the real dome share one atmosphere.
  rayleighBlue = mix( rayleighBlue, uTerrSkyColor, 0.16 * dayVis );
  float sunAlign = max( dot( terrViewDir, uTerrSunDir ), 0.0 );
  float miePhase = pow( sunAlign, 4.0 ) * 0.65 + pow( sunAlign, 18.0 ) * 0.35;
  vec3 dustGlow = mix( vec3( 0.92, 0.76, 0.56 ), uTerrSunColor, 0.55 );
  vec3 atmosCol = mix( rayleighBlue, dustGlow, clamp( miePhase * ( 0.45 + lowAir * 0.40 ), 0.0, 0.72 ) );
  // Distant terrain loses a little chroma before it is pushed toward the haze.
  float distDesat = aerialT * 0.35 * dayVis;
  float outLum = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
  outgoingLight = mix( outgoingLight, vec3( outLum ), distDesat );
  outgoingLight = mix( outgoingLight, atmosCol, aerialT * 0.62 * dayVis );
  // Luminous low-altitude valley dust veil when looking toward the sun.
  outgoingLight += dustGlow * miePhase * aerialT * 0.14 * dayVis * ( 0.5 + 0.5 * lowAir );
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

// 1x1 neutral edit-paint texture (byte 128 == exact 1.0x tint & saturation).
// Binding a real texture from the first frame means enabling the F9 painter only
// flips `uEditEnabled`; no recompile, no sampler rebind stall.
function neutralEditColorTexture() {
  const tex = new THREE.DataTexture(
    new Uint8Array([128, 128, 128, 128]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
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

// Coastal mesh jitter: breaks the DEM's straight/smooth waterline into organic
// coves, pebble spits and jutting rocky teeth. Two octaves only - a ~55 m
// cove/headland warp plus ~18 m teeth - and both are pure functions of the
// WORLD coordinate, so neighbouring tiles sample the identical field at their
// shared border and stitch with zero cracks. Range is bounded to
// [-0.38, +0.38] m, which is deliberately far below the C1 land/sea ramp: it
// re-shapes the coastline without punching ledges into dry ground.
function coastJitter(wx, wz) {
  const cove = fbm01(wx / 55, wz / 55, 2, 4177) * 2 - 1;
  const teeth = fbm01(wx / 18 + 31.7, wz / 18 - 12.3, 2, 8231) * 2 - 1;
  return cove * 0.22 + teeth * 0.16;
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
    this._neutralEditColor = neutralEditColorTexture();
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
      // F9 painter: neutral 1x1 edit texture, disabled until vipava.
      uEditColorTex: { value: this._neutralEditColor },
      uEditBounds: { value: new THREE.Vector4(-50000, -50000, 1 / 100000, 1 / 100000) },
      uEditEnabled: { value: 0 },
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
    // Invalidated meshes stay in the scene until the re-sampled replacement is
    // swapped in, so a live DEM patch never opens a rectangular hole.
    this._staleTiles = new Map(); // key -> mesh (still drawn, not streamed)
    // Index arrays depend only on `segs`, so one BufferAttribute is shared by
    // every tile of a level band instead of ~10k floats allocated per tile.
    this._indexCache = new Map(); // segs -> THREE.BufferAttribute
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
   * Bind the F9 painter's RGBA tint/saturation grid. `bounds` is the painter's
   * world rectangle; omitting it reuses whatever the texture was baked against.
   * Passing null restores the neutral 1x1 texture and disables the overlay.
   */
  setEditColorTexture(tex, bounds = null) {
    const u = this.detailUniforms;
    u.uEditColorTex.value = tex || this._neutralEditColor;
    if (bounds) {
      const spanX = bounds.xMax - bounds.xMin;
      const spanZ = bounds.zMax - bounds.zMin;
      if (spanX > 0 && spanZ > 0) {
        u.uEditBounds.value.set(bounds.xMin, bounds.zMin, 1 / spanX, 1 / spanZ);
      }
    }
    u.uEditEnabled.value = tex ? 1 : 0;
  }

  /** Hide the painted colour overlay (the edit grid itself stays in memory). */
  clearEditColorTexture() {
    const u = this.detailUniforms;
    u.uEditColorTex.value = this._neutralEditColor;
    u.uEditEnabled.value = 0;
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
      // Do not remove the mesh: it keeps drawing until the replacement tile
      // (freshly sampled from the streamed DEM) is built and swapped in.
      this.tiles.delete(key);
      this._stale.delete(key);
      this._staleTiles.set(key, mesh);
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
    // An explicit sync refresh must fill up to `immediate` tiles in one go, so
    // the frame-time budget is disabled here.
    if (immediate > 0) this._buildPending(immediate, Infinity);
  }

  /** Remove every tile mesh and its GPU geometry, resetting streaming state. */
  _clearTiles() {
    for (const mesh of this.tiles.values()) this._releaseMesh(mesh);
    this.tiles.clear();
    for (const mesh of this._staleTiles.values()) this._releaseMesh(mesh);
    this._staleTiles.clear();
    this._stale.clear();
    this.pending.length = 0;
  }

  /** Remove one tile mesh from the scene and free its per-tile geometry. */
  _releaseMesh(mesh) {
    this.group.remove(mesh);
    const geo = mesh.geometry;
    if (!geo) return;
    // The index attribute is shared by every tile of a `segs` band, so detach
    // it before dispose: WebGLGeometries deletes geometry.index on dispose,
    // which would throw away the cached GPU index buffer for all other tiles.
    geo.setIndex(null);
    geo.dispose();
  }

  /** One index BufferAttribute per `segs`, shared by every tile of that band. */
  _sharedIndex(segs) {
    const cached = this._indexCache.get(segs);
    if (cached) return cached;
    const N = segs + 1;
    const mainCount = N * N;
    const vertexCount = mainCount + 4 * N;
    const indexCount = segs * segs * 6 + 4 * (N - 1) * 6;
    const arr = vertexCount < 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
    let o = 0;
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * N + i;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        arr[o++] = a; arr[o++] = c; arr[o++] = b;
        arr[o++] = b; arr[o++] = c; arr[o++] = d;
      }
    }
    // skirt faces
    for (let e = 0; e < 4; e++) {
      const s = mainCount + e * N;
      for (let k = 0; k < N - 1; k++) {
        // find main-grid partners for skirt index k
        let m0, m1;
        if (e === 0) { m0 = k; m1 = k + 1; }
        else if (e === 1) { m0 = (N - 1) * N + k; m1 = m0 + 1; }
        else if (e === 2) { m0 = k * N; m1 = (k + 1) * N; }
        else { m0 = k * N + N - 1; m1 = (k + 1) * N + N - 1; }
        arr[o++] = m0; arr[o++] = s + k; arr[o++] = m1;
        arr[o++] = m1; arr[o++] = s + k; arr[o++] = s + k + 1;
      }
    }
    const attr = new THREE.BufferAttribute(arr, 1);
    this._indexCache.set(segs, attr);
    return attr;
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

    // Horizon mountain ring: the quadtree used to stop at the 2x2 root tiles
    // around the jet, so the ground ended as little as 16.4 km behind it.
    // An 8x8 macro grid keeps the Julian Alps, Triglav, Nanos, Sneznik, the
    // Dolomites, the Karst and the Istria coastline on the horizon out to
    // 135 km, inside the 160 km far plane.
    const HORIZON_RANGE = 135000; // outer cull distance
    const HORIZON_FULL = 48000;   // beyond this: level 0 only (~800 tris)
    const HORIZON_MID = 30000;    // beyond this: level 1 max (~819 m spacing)

    const seen = new Set();

    const visit = (x, z, size, level) => {
      const d = distanceToRect(camX, camZ, x, z, size);
      // distanceToRect is monotonic down the tree, so culling here discards
      // whole subtrees without building them.
      if (d > HORIZON_RANGE) return;
      // Horizon bands cap the subdivision level, so the far ring costs almost
      // no triangles and builds fast: level 0 roots (32,768 m, segmentsFar) are
      // silhouette-only, the mid ring may reach level 1 (16,384 m) where the
      // ~819 m vertex spacing is enough to read Alpine/Karst ridgelines. Inner
      // tiles (d <= 30 km) keep the exact existing quadtree rules.
      const bandLevel = d > HORIZON_FULL ? 0 : d > HORIZON_MID ? 1 : maxLevel;
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
      if (level < bandLevel && level < maxLevel && size > minSize && d < size * splitFactor) {
        const h = size * 0.5;
        visit(x, z, h, level + 1);
        visit(x + h, z, h, level + 1);
        visit(x, z + h, h, level + 1);
        visit(x + h, z + h, h, level + 1);
        return;
      }
      const key = level + ':' + x + ':' + z;
      if (seen.has(key)) return;
      seen.add(key);
      leaves.push({ x, z, size, level });
    };

    // Centered 8x8 macro grid: two root tiles of margin around the camera, so
    // the horizon ring wraps the aircraft on every side.
    for (let oz = -3; oz <= 4; oz++) {
      for (let ox = -3; ox <= 4; ox++) {
        visit(baseX + ox * ROOT, baseZ + oz * ROOT, ROOT, 0);
      }
    }

    this.leaves = leaves;
    const activeKeys = new Set(leaves.map((l) => l.level + ':' + l.x + ':' + l.z));

    // Keep meshes that are no longer visible until their LOD replacements are
    // built, otherwise fast flight shows rectangular holes at tile boundaries.
    for (const key of activeKeys) this._stale.delete(key);
    for (const [key] of this.tiles) {
      if (!activeKeys.has(key)) this._stale.add(key);
    }
    // Invalidated meshes still drawing: keep them while their key is part of
    // the visible quadtree, drop them once it leaves range with no replacement.
    for (const [key, mesh] of this._staleTiles) {
      if (activeKeys.has(key)) continue;
      this._staleTiles.delete(key);
      this._releaseMesh(mesh);
    }

    // queue missing leaves, farthest first: _buildPending pops the nearest
    // tile with O(1) pop() instead of an O(n) shift() per tile.
    this.pending.length = 0;
    for (const leaf of leaves) {
      const key = leaf.level + ':' + leaf.x + ':' + leaf.z;
      if (this.tiles.has(key)) continue;
      leaf.key = key;
      leaf.dist = distanceToRect(camX, camZ, leaf.x, leaf.z, leaf.size);
      this.pending.push(leaf);
    }
    this.pending.sort((a, b) => b.dist - a.dist);
    this.lastBuildX = camX;
    this.lastBuildZ = camZ;
  }

  _buildPending(budgetTiles = 4, budgetMs = 4) {
    // Wall-clock budget: a High near tile costs ~8.5k terrainHeight samples, so
    // streaming must stop on time, not only on a tile count.
    const clock = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance
      : Date;
    const start = clock.now();
    let built = 0;
    while (this.pending.length && built < budgetTiles) {
      const node = this.pending.pop();
      if (this.tiles.has(node.key)) continue;
      const mesh = this._buildTile(node);
      // Swap the invalidated placeholder out only once its replacement exists,
      // so the ground never blinks while a streamed DEM patch is re-sampled.
      const stale = this._staleTiles.get(node.key);
      if (stale) {
        this._staleTiles.delete(node.key);
        this._releaseMesh(stale);
      }
      this.tiles.set(node.key, mesh);
      this.group.add(mesh);
      built++;
      // Always build at least one tile, then honour the time budget.
      if (clock.now() - start >= budgetMs) break;
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
        // Sea-datum sink: the open Adriatic is a flat h = 0.0 sheet in the DEM,
        // so ANY jitter or ramp applied to it lifts mesh blobs above
        // WaterSurface (SEA_LEVEL - 0.18) and speckles the whole open sea with
        // rocky blotches. Pure sea/seabed (h <= 0.03) is therefore mapped
        // monotonically onto [-16, -0.45] m: never a millimetre above -0.45,
        // i.e. always under the water plane and under the -0.24 m shader
        // discard plane. The coastal margin (0.03..1.1 m) keeps the organic
        // cove / rocky-tooth jitter, windowed to exactly 0 at both ends, so
        // inland ground (h >= 1.1 m: fields, buildings, airports) is untouched.
        let meshH = h;
        if (h <= 0.03) {
          // Pure sea/seabed: guaranteed underwater (<= -0.45 m, well below WaterSurface -0.18 m)
          // so zero open-sea vertices can ever poke above the water plane.
          const t = smoothstep(-0.45, 0.03, h);
          meshH = -16.0 + 15.55 * t;
        } else if (h < 1.1) {
          // Actual land-to-sea coastal margin (0.03..1.1 m): organic cove & rocky-tooth erosion.
          // Deterministic world-space jitter carves jagged inlets/coves right along the real shore
          // while inland farmland (> ~0.45 m) and deep open sea (<= 0.03 m) stay completely clean.
          const band = smoothstep(0.03, 0.14, h) * (1.0 - smoothstep(0.32, 0.95, h));
          const hc = band > 0 ? h + coastJitter(wx, wz) * band : h;
          if (hc < 0.05) {
            const t = smoothstep(-0.35, 0.05, hc);
            meshH = -12.0 + (hc + 12.0) * t;
          }
        }
        positions[idx * 3] = wx;

        positions[idx * 3 + 1] = meshH;
        positions[idx * 3 + 2] = wz;

        // Normals / slope only, evaluated on the DEM field (not meshH) so the sun
        // lighting stays smooth across the shoreline ramp. Sampled on a fixed
        // 14 m world-space baseline when step < DEM pixel size: it depends only on
        // (wx, wz), so neighbouring tiles agree exactly and the DEM's sub-pixel
        // interpolation steps don't facet the shading.
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

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // The index depends only on `segs`: share one attribute per level band.
    geo.setIndex(this._sharedIndex(segs));
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += skirtDepth;

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'tile-' + node.key;
    // Receive real-time shadows from buildings, landmarks, trees and the F-16.
    mesh.receiveShadow = true;
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
      // A wider ring needs more tiles while at altitude; the time budget in
      // _buildPending still caps the frame cost.
      const budget = _cam.y > 3000 ? 10 : 6;
      this._buildPending(budget);
    }
    if (!this.pending.length && this._stale.size) {
      for (const key of this._stale) {
        const mesh = this.tiles.get(key);
        if (!mesh) continue;
        this.tiles.delete(key);
        this._releaseMesh(mesh);
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
    for (const mesh of this.tiles.values()) this._releaseMesh(mesh);
    this.tiles.clear();
    for (const mesh of this._staleTiles.values()) this._releaseMesh(mesh);
    this._staleTiles.clear();
    this._stale.clear();
    // Shared index attributes were detached from every geometry before its
    // dispose, so just drop the cache handles.
    this._indexCache.clear();
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
    // Half the plane must outlive the 160 km far plane, otherwise the sea shows
    // a hard edge (and the sky dome's underside behind it) at the horizon.
    const waterSize = Math.max(160000, CONFIG.world.waterSize);
    const geo = new THREE.PlaneGeometry(waterSize, waterSize, 80, 80);
    geo.rotateX(-Math.PI / 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.2) },
        uSunColor: { value: new THREE.Color(0xfff2d0) },
        uSkyColor: { value: new THREE.Color(0x8fb4c8) },
        uDeep: { value: new THREE.Color(0x143c48).convertSRGBToLinear() },
        uShallow: { value: new THREE.Color(0x26595b).convertSRGBToLinear() },
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

          // Smooth Schlick Fresnel (F0 = 0.02) sky reflection over a muted Gulf
          // of Trieste: desaturate the reflected sky toward horizon mist and cap
          // the Fresnel share so coastal water never flashes electric blue.
          vec3 reflDir = reflect(-viewDir, n);
          float skyGrad = smoothstep(0.0, 0.55, max(reflDir.y, 0.0));
          vec3 skyRefl = mix(mix(uSkyColor, fogColor, 0.55), uSkyColor, skyGrad);
          float reflLum = dot(skyRefl, vec3(0.2126, 0.7152, 0.0722));
          skyRefl = mix(skyRefl, vec3(reflLum), 0.20);
          skyRefl = mix(skyRefl, fogColor, 0.14 + 0.18 * smoothstep(4000.0, 32000.0, distXZ));
          float cosV = clamp(dot(n, viewDir), 0.0, 1.0);
          float fres = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
          col = mix(col, skyRefl, clamp(fres * 0.78, 0.0, 0.74));

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

          // Rayleigh + Mie aerial perspective (VIPER-ATMOS): the exact constants
          // the terrain pass uses, so the Adriatic melts into the same misty
          // horizon band the Karst ridges and the Julian Alps fade into.
          vec3 wViewDir = -viewDir;
          float waterDist = length(cameraPosition - vWorld);
          float wDayVis = smoothstep(-0.05, 0.25, uSunDir.y);
          float wLowAir = 1.0 - smoothstep(100.0, 2600.0, 0.5 * (cameraPosition.y + vWorld.y));
          float wAerialT = 1.0 - exp(-waterDist * (0.000024 + wLowAir * 0.000020));
          wAerialT = clamp(wAerialT * smoothstep(2500.0, 9000.0, waterDist), 0.0, 0.72);
          vec3 wRayleigh = mix(vec3(0.42, 0.58, 0.80), vec3(0.54, 0.68, 0.86),
            smoothstep(0.0, 0.5, uSunDir.y));
          wRayleigh = mix(wRayleigh, uSkyColor, 0.16 * wDayVis);
          float wSunAlign = max(dot(wViewDir, uSunDir), 0.0);
          float wMiePhase = pow(wSunAlign, 4.0) * 0.65 + pow(wSunAlign, 18.0) * 0.35;
          vec3 wDustGlow = mix(vec3(0.92, 0.76, 0.56), uSunColor, 0.55);
          vec3 wAtmosCol = mix(wRayleigh, wDustGlow,
            clamp(wMiePhase * (0.45 + wLowAir * 0.40), 0.0, 0.72));
          float wOutLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(col, vec3(wOutLum), wAerialT * 0.35 * wDayVis);
          col = mix(col, wAtmosCol, wAerialT * 0.62 * wDayVis);

          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    // Sit slightly BELOW sea datum (SEA_LEVEL - 0.18) so the sheet hides the
    // sunk seabed (<= -16 m) while dry coastal land (>= 0.05 m) stands proud of
    // it: no flooded farmland puddles, no plane slicing through the fields.
    this.mesh.position.y = SEA_LEVEL - 0.18;
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
    u.uDeep.value.copy(new THREE.Color(pal?.waterDeep ?? 0x143c48).convertSRGBToLinear());
    u.uShallow.value.copy(new THREE.Color(pal?.waterShallow ?? 0x26595b).convertSRGBToLinear());
  }

  update(dt, camera) {
    this.material.uniforms.uTime.value += dt;
    this.mesh.position.y = SEA_LEVEL - 0.18;
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