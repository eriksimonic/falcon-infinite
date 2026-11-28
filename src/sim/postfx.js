// Feature 32 — selective cinematic bloom. Feature 35 tamed it for the
// photoreal Vipava pass.
//
// Three.js's built-in EffectComposer chain: RenderPass -> UnrealBloomPass ->
// OutputPass -> FXAA, rendered into an explicit 4x WebGL2 multisampled HDR
// scene target so hardware MSAA is not silently disabled by the composer's
// default `samples: 0` buffer. Only the scene buffer is multisampled: the
// tonemap/FXAA quads write into a second, non-MSAA, depth-less HDR target, so
// the full-screen passes no longer pay for a 4x sample write + resolve they
// cannot use (PERF-04). FXAA sits after OutputPass, i.e. it filters tonemapped
// sRGB luma rather than linear HDR. The bloom threshold is deliberately high
// (1.05 by day, easing to 0.94 at night) so the sunlit sky, clouds, terrain,
// terrain-lit facades and ordinary lit house windows stay crisp while only
// HDR/un-tonemapped emissives — afterburner Mach diamonds, BFFG plasma,
// fireball cores, landmark beacons, H4 traffic streaks and runway strobes —
// flare properly. A tight radius keeps the night glow as a sharp halo instead
// of a diffuse fog over the whole frame.
//
// Headless-safe: with no renderer, no WebGL context, or `enabled: false` the
// system degrades to a plain `renderer.render(scene, camera)` passthrough, so
// simulation tests and dedicated servers can construct it and call every
// method without a DOM.
//
// VIPER-OPTICS (helmet-cam optics): the stock FXAAShader on the final pass is
// replaced by CinemaOpticsFXAAShader, which folds barrel lens distortion with
// auto-zoom, luma-guided FXAA, filmic optical softness, radial chromatic
// aberration, peripheral radial speed blur, canopy polycarbonate sheen, an
// analytical screen-space sun flare (veiling glare, 8-point diffraction
// starburst, anamorphic streak and five chromatic bokeh ghosts), filmic
// S-curve + split toning, vignette and 35 mm micro-grain into that same single
// fullscreen pass. The whole cinematic look therefore costs ZERO extra render
// targets, zero extra swap and zero extra VRAM: PERF-04's two HDR buffers are
// untouched, and the sun flare is pure math on the sun's projected position —
// no depth buffer, no bright-pass mask, no extra texture fetches.
//
// 90% internal render (crisp aircraft + close terrain): the scene and the post
// buffers are rasterised at 90% linear resolution (~81% of the fragment count)
// and the final optics pass — which still runs at FULL native canvas
// resolution — hardware-bilinear-upscales that slightly smaller buffer on the
// way out. The GoPro fisheye zoom (~0.66x) already magnifies the centre a
// little, so 0.90 keeps the F-16 and the close terrain detailed while a hair of
// natural camera softness remains; distant terrain is softened in 3D by
// terrainview.js instead. The sun starburst, bokeh ghosts, vignette, grain and
// the 2D HUD canvas stay razor sharp on top of it. FXAA's `resolution` uniform
// is kept in step with the 90% buffer's real texel size, so its diagonal taps
// hit exact neighbouring texels instead of a fractional grid.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Day is conservative (blue sky sits well under the threshold), night opens up
// so beacons/traffic/ordnance emissives pop in the dark without turning every
// dim house window into a blurry halo.
const DAY_THRESHOLD = 1.05;
const NIGHT_THRESHOLD = 0.94;
const DAY_STRENGTH = 0.14;
const NIGHT_STRENGTH = 0.19;
const BLOOM_RADIUS = 0.26;

const NIGHT_BLEND_RATE = 1.6; // blend units per second (smooth dusk/dawn)
const PULSE_DECAY = 0.6; // seconds for a detonation bloom spike to fade
const PULSE_FLOOR = 0.002;
const PULSE_LIMIT = 1.1; // soft cap on additive pulse over the base strength

// VIPER-OPTICS: how fast the lens values glide to a new target. Exponential, so
// the transition is frame-rate independent and never overshoots.
const OPTICS_BLEND_RATE = 5.5;

// Crisp internal render: rasterise the scene at 90% linear resolution (~81% of
// the fragment pixels) and let the final full-resolution optics pass
// hardware-upscale it with bilinear filtering. The aircraft and close terrain
// keep their detail (the GoPro fisheye zoom magnifies the centre a little),
// with just a hair of natural camera softness; distant terrain gets its filmic
// softening in 3D from terrainview.js. HUD, flares, grain and starbursts —
// drawn at native resolution — stay crisp.
const INTERNAL_RENDER_SCALE = 0.90;
const RENDER_SCALE_MIN = 0.5;
const RENDER_SCALE_MAX = 1.0;

const _nightLevel = (night) =>
  typeof night === 'number' ? clamp(night, 0, 1) : (night ? 1 : 0);

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export {
  DAY_THRESHOLD, NIGHT_THRESHOLD, DAY_STRENGTH, NIGHT_STRENGTH,
  INTERNAL_RENDER_SCALE, RENDER_SCALE_MIN, RENDER_SCALE_MAX,
};

/**
 * VIPER-OPTICS: FXAA + cinematic lens optics in ONE fullscreen pass.
 *
 * ShaderPass clones these uniforms into the pass material, so `resolution`
 * keeps its exact stock name and `_updateFxaaResolution()` (and the resize
 * path) keep working untouched. `tDiffuse` is wired by ShaderPass itself.
 */
export const CinemaOpticsFXAAShader = {
  uniforms: {
    tDiffuse: { value: null },
    // Same name as stock FXAAShader: one texel in UV space.
    resolution: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uDistortion: { value: 0.0 },
    uChroma: { value: 0.0 },
    uBlur: { value: 0.0 },
    uVignette: { value: 0.0 },
    uGrain: { value: 0.0 },
    uCanopyGlint: { value: 0.0 },
    uTime: { value: 0.0 },
    // VIPER-OPTICS sun flare. uSunScreen is the sun disc projected through the
    // active camera in [0..1] screen UV; it is allowed to leave the frame so an
    // off-edge sun still casts veiling glare and ghosts into the picture.
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uSunFlare: { value: 0.0 },
    uSunColor: { value: new THREE.Color(0xfff1d6) },
    // Filmic optical softness (0..1): gentle sub-pixel diffusion so CG edges
    // read as cinema photography instead of harsh digital oversharpening.
    uSoftness: { value: 0.0 },
    // Frame aspect ratio, so the starburst and bokeh discs stay perfect
    // circles on ultrawide / 16:9 / portrait displays.
    uAspect: { value: 16 / 9 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float uDistortion;
    uniform float uChroma;
    uniform float uBlur;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uCanopyGlint;
    uniform float uTime;
    uniform vec2 uSunScreen;
    uniform float uSunFlare;
    uniform vec3 uSunColor;
    uniform float uSoftness;
    uniform float uAspect;

    varying vec2 vUv;

    #define FXAA_SPAN_MAX 8.0
    #define FXAA_REDUCE_MUL (1.0 / 8.0)
    #define FXAA_REDUCE_MIN (1.0 / 128.0)
    #define EDGE_UV 0.001

    float lumaOf(vec3 c) {
      return dot(c, vec3(0.299, 0.587, 0.114));
    }

    // Clamped tap: every sample stays strictly inside the frame (never past
    // 0.001 / 0.999), so the distortion, the CA split and all eight bokeh taps
    // can never reach the border texel and smear it into a stripe.
    vec3 tap(vec2 uv) {
      return texture2D(tDiffuse, clamp(uv, vec2(EDGE_UV), vec2(1.0 - EDGE_UV))).rgb;
    }

    float hash12(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    // Soft bokeh disc for the lens-flare ghosts: a smooth falloff with a
    // slightly brighter rim, exactly what an out-of-focus point source does.
    // Aspect-corrected so the ghost is a circle, not an oval. The outer
    // smoothstep is written inside-out (1 - smoothstep(low, high, d)) because
    // GLSL leaves edge0 > edge1 undefined.
    float flareDisc(vec2 uv, vec2 pos, float rad, float aspect) {
      vec2 dvec = (uv - pos) * vec2(aspect, 1.0);
      float d = length(dvec);
      return (1.0 - smoothstep(rad * 0.45, rad, d))
           * (0.65 + 0.35 * smoothstep(rad * 0.4, rad * 0.92, d));
    }

    void main() {
      // ---------------------------------------------------------------
      // Step 1 — barrel lens distortion with auto-scale.
      // The zoom covers the FULL corner radius (r2 = 2.0 at p = (+-1, +-1)),
      // so the warped frame never falls off the edge: at the worst case
      // (k = 0.25, uChroma = 0.0045) each corner axis of dUv lands at
      // 0.5 + 0.5 * zoom * (1 + k * 2.0) = 0.98777, i.e. 0.4877 from the
      // centre. The CA split is added in UV units though, i.e. it reaches
      // twice as far measured from the centre, so it is folded into the zoom
      // as well: 0.4877 + p * r2 * uChroma (0.009) = 0.4967 < 0.499, and
      // every FXAA / bokeh / CA sample stays strictly inside [0.001, 0.999].
      // No pixel anywhere on screen ever hits the border clamp, so the old
      // left/right edge stripe smear cannot exist.
      // ---------------------------------------------------------------
      vec2 p = vUv * 2.0 - 1.0;
      float r2 = dot(p, p);
      float k = uDistortion;
      float zoom = 1.0 / (1.0 + max(k, 0.0) * 2.05 + uChroma * 2.5);
      zoom *= 1.0 - 2.0 * uChroma;
      vec2 dUv = 0.5 + 0.5 * p * zoom * (1.0 + k * r2);
      dUv = clamp(dUv, vec2(EDGE_UV), vec2(1.0 - EDGE_UV));

      // ---------------------------------------------------------------
      // Step 2 — luma-guided FXAA at the distorted UV: centre + 4 diagonals
      // give the edge direction, then a two-tap average along that edge is
      // accepted only when it stays inside the local luma range.
      // ---------------------------------------------------------------
      vec2 texel = resolution;
      vec3 rgbM  = tap(dUv);
      vec3 rgbNW = tap(dUv + vec2(-1.0, -1.0) * texel);
      vec3 rgbNE = tap(dUv + vec2( 1.0, -1.0) * texel);
      vec3 rgbSW = tap(dUv + vec2(-1.0,  1.0) * texel);
      vec3 rgbSE = tap(dUv + vec2( 1.0,  1.0) * texel);

      float lM  = lumaOf(rgbM);
      float lNW = lumaOf(rgbNW);
      float lNE = lumaOf(rgbNE);
      float lSW = lumaOf(rgbSW);
      float lSE = lumaOf(rgbSE);

      float lumaMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
      float lumaMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

      vec2 dir = vec2(
        -((lNW + lNE) - (lSW + lSE)),
         ((lNW + lSW) - (lNE + lSE))
      );
      float dirReduce = max(
        (lNW + lNE + lSW + lSE) * (0.25 * FXAA_REDUCE_MUL),
        FXAA_REDUCE_MIN
      );
      float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
      dir = clamp(dir * rcpDirMin, vec2(-FXAA_SPAN_MAX), vec2(FXAA_SPAN_MAX)) * texel;

      vec3 rgbA = 0.5 * (tap(dUv + dir * 0.5) + tap(dUv - dir * 0.5));
      vec3 rgbB = 0.5 * (rgbA + rgbM);
      float lumaB = lumaOf(rgbB);
      vec3 fxaaCol = (lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB;

      float edgeW = smoothstep(0.24, 1.28, r2);

      // ---------------------------------------------------------------
      // Step 2b — filmic optical softness. The same four diagonal samples
      // FXAA already fetched (each ±1 texel, i.e. ~1.25 scene texels across
      // the quad) are averaged into a gentle sub-pixel diffusion. Blended
      // hardest on aliased micro-edges and barely at all in the centre, so
      // ultra-sharp CG polygon edges melt into soft film photography while
      // cockpit instruments stay perfectly readable. Zero extra lookups.
      // ---------------------------------------------------------------
      if (uSoftness > 0.001) {
        vec3 softAvg = 0.25 * (rgbNW + rgbNE + rgbSW + rgbSE);
        fxaaCol = mix(fxaaCol, softAvg, clamp(uSoftness * (0.45 + 0.55 * edgeW), 0.0, 0.42));
      }

      // ---------------------------------------------------------------
      // Step 3 — radial chromatic aberration + peripheral optical blur.
      // Both are gated on r2: the gate now starts at r2 = 0.24 (outside the
      // central core), so the HUD, reticle, MFDs and the middle of the frame
      // keep the pure FXAA pixel — 100% tack-sharp — while only the outer
      // frame gets delicate lens falloff.
      // ---------------------------------------------------------------
      vec2 caOff = p * (r2 * uChroma);
      float rCh = tap(dUv + caOff).r;
      float bCh = tap(dUv - caOff).b;
      vec3 col = vec3(
        mix(fxaaCol.r, rCh, edgeW),
        fxaaCol.g,
        mix(fxaaCol.b, bCh, edgeW)
      );

      if (uBlur > 0.0002 && edgeW > 0.001) {
        // Creamy 8-tap optical bokeh: a rotated six-point soft disc ring
        // around dUv (60 deg apart, 15 deg base rotation) plus two symmetric
        // radial motion taps along p. Aspect-corrected so the defocus disc is
        // truly circular on a wide frame, and radially spread — not collinear
        // — so high-contrast foliage melts into smooth filmic bokeh instead
        // of the stepped double-vision dots a 4-tap march used to produce.
        // The radius is deliberately tight (0.72x): the near-native 90%
        // bilinear scene buffer keeps close detail crisp, so the taps only have
        // to overlap slightly to read as one continuous optical blur.
        float rad = uBlur * edgeW * 0.72;
        vec2 aspectFix = vec2(1.0 / uAspect, 1.0);

        // The radial lens split rides the blur taps at half strength, so the
        // melted periphery carries a faint red/cyan glass fringe instead of a
        // flat grey gaussian — and no rainbow ghost rings around foliage.
        vec2 cOff = caOff * 0.50;

        // Keep the whole kernel inside the safe frame: the outward reach is
        // renormalised once (isotropically, so the disc stays symmetric and
        // circular) instead of letting tap() clamp and stretch a border
        // texel. That is what removes the last possible edge smear.
        vec2 room = min(dUv - vec2(EDGE_UV), vec2(1.0 - EDGE_UV) - dUv);
        vec2 reach = rad * 1.15 * aspectFix + abs(cOff);
        float fit = min(1.0, min(room.x / max(reach.x, 0.0001),
                                  room.y / max(reach.y, 0.0001)));
        rad *= fit;
        cOff *= fit;

        vec2 ring = rad * 0.62 * aspectFix;
        vec2 d1 = vec2(0.9659, 0.2588);   // 15 deg
        vec2 d2 = vec2(0.2588, 0.9659);   // 75 deg
        vec2 d3 = vec2(-0.7071, 0.7071);  // 135 deg
        vec3 bokeh = (tap(dUv + d1 * ring) + tap(dUv - d1 * ring)
                    + tap(dUv + d2 * ring) + tap(dUv - d2 * ring)
                    + tap(dUv + d3 * ring) + tap(dUv - d3 * ring)) * 0.12;

        // Two radial motion taps, symmetric about dUv so the smear never leans.
        vec2 radialDir = p * inversesqrt(max(r2, 0.0001));
        vec2 motion = radialDir * (rad * 1.15) * aspectFix;
        bokeh += (tap(dUv + motion) + tap(dUv - motion)) * 0.14;

        // The split also fringes the melted periphery, at half strength and
        // riding only the inner half of the motion reach so the 8 taps stay
        // one coherent disc instead of splitting into ghost dots.
        bokeh.r = mix(bokeh.r, tap(dUv + motion * 0.5 + cOff).r, 0.35);
        bokeh.b = mix(bokeh.b, tap(dUv - motion * 0.5 - cOff).b, 0.35);

        col = mix(col, bokeh, clamp(edgeW * 0.65, 0.0, 0.65));
      }

      // ---------------------------------------------------------------
      // Step 4a — canopy polycarbonate sheen: soft dual Gaussian lobe near
      // the top centre of the glass, pale teal-green, additive and tiny.
      // ---------------------------------------------------------------
      if (uCanopyGlint > 0.001) {
        vec2 g = (vUv - vec2(0.48, 0.84)) * vec2(1.0, 1.45);
        float lobeA = exp(-dot(g, g) * 150.0);
        float lobeB = exp(-dot(g, g) * 26.0);
        float lobe = lobeA * 0.62 + lobeB * 0.38;
        col += vec3(0.45, 0.85, 0.62) * (lobe * uCanopyGlint);
      }

      // ---------------------------------------------------------------
      // Step 4b — restrained filmic S-curve plus a warm-highlight /
      // cool-shadow split. 8% of the tint only: daylight and night colour
      // stay true.
      // ---------------------------------------------------------------
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.12);
      float lum = lumaOf(col);
      vec3 splitTone = mix(
        vec3(0.97, 0.99, 1.03),
        vec3(1.02, 1.005, 0.98),
        smoothstep(0.18, 0.82, lum)
      );
      col *= mix(vec3(1.0), splitTone, 0.08);

      // ---------------------------------------------------------------
      // Step 4b2 — screen-space sun: soft veiling glare, 8-point diffraction
      // starburst, thin anamorphic horizontal streak and five chromatic bokeh
      // lens-flare ghosts marching along the exact optical axis (sun through
      // screen centre to the opposite corner). Everything is analytic — no
      // extra render targets, no extra texture fetches — and skipped outright
      // when the sun is not in front of the camera.
      // ---------------------------------------------------------------
      if (uSunFlare > 0.005) {
        // Invert Step 1's barrel distortion + auto-zoom so the flare anchor
        // sits on the exact screen pixel where the sky sun disc actually
        // renders. uSunScreen is a rectilinear UV; Step 1 samples the scene at
        // dUv = 0.5 + 0.5 * p * zoom * (1 + k * r2), so the disc the viewer
        // sees lands at the vUv solving dUv(vUv) == uSunScreen, i.e. further
        // out from centre than uSunScreen itself. The radial cubic
        // zoom * (r + max(k,0) * r^3) is strictly monotonic for k >= 0, so
        // 4 Newton-Raphson steps on r converge to well under 1e-6.
        vec2 sunPos = uSunScreen;
        vec2 sq = uSunScreen * 2.0 - 1.0;
        float sr = length(sq);
        if (sr > 0.00001) {
          float kPos = max(k, 0.0);
          float r = sr / max(zoom, 0.001);
          for (int i = 0; i < 4; i++) {
            float rSq = r * r;
            float f = zoom * (r + kPos * r * rSq) - sr;
            float df = zoom * (1.0 + 3.0 * kPos * rSq);
            r -= f / max(df, 0.00001);
          }
          sunPos = 0.5 + 0.5 * sq * (r / sr);
        }

        // Aspect-corrected pixel-to-sun vector: circles stay circles.
        vec2 sunDelta = (vUv - sunPos) * vec2(uAspect, 1.0);
        float sunD = length(sunDelta);

        // Soft atmospheric veiling glare washing out from the disc.
        float veil = exp(-sunD * 1.9) * 0.28 + exp(-sunD * 7.5) * 0.34;

        // 8-point diffraction starburst: cos(4a) gives four double-ended
        // spikes, the 45-degree second term gives the four short diagonals.
        float ang = atan(sunDelta.y, sunDelta.x);
        float rays = pow(abs(cos(ang * 4.0)), 18.0) * 0.65
                   + pow(abs(cos(ang * 4.0 + 0.7854)), 28.0) * 0.35;
        float star = rays * exp(-sunD * 5.2) * 0.55;

        // Thin anamorphic horizontal streak along the sun's row.
        float streak = exp(-abs(vUv.y - sunPos.y) * 58.0)
                     * exp(-abs(vUv.x - sunPos.x) * 2.2) * 0.36;

        vec3 flare = uSunColor * (veil + star);
        flare += vec3(1.0, 0.93, 0.80) * streak;

        // Ghosts march away from the sun through the frame centre.
        vec2 axis = vec2(0.5) - sunPos;

        // 1 — warm amber, close in.
        flare += flareDisc(vUv, sunPos + axis * 0.65, 0.022, uAspect)
               * vec3(1.0, 0.72, 0.38) * 0.42;
        // 2 — cool cyan/teal, the classic wide mid ghost.
        flare += flareDisc(vUv, sunPos + axis * 1.25, 0.042, uAspect)
               * vec3(0.42, 0.86, 1.0) * 0.30;
        // 3 — magenta-gold with a tiny red/blue chromatic rim split.
        vec2 g3 = sunPos + axis * 1.65;
        float rim = 0.0024;
        flare += flareDisc(vUv, g3, 0.028, uAspect) * vec3(1.0, 0.58, 0.78) * 0.26;
        flare += flareDisc(vUv, g3 + vec2(rim, 0.0), 0.028, uAspect) * vec3(0.30, 0.0, 0.0);
        flare -= flareDisc(vUv, g3 - vec2(rim, 0.0), 0.028, uAspect) * vec3(0.0, 0.0, 0.34);
        // 4 — wide soft green-amber bokeh halo.
        flare += flareDisc(vUv, sunPos + axis * 2.15, 0.056, uAspect)
               * vec3(0.72, 0.92, 0.60) * 0.16;
        // 5 — warm orange-blue chroma disc, furthest out.
        flare += flareDisc(vUv, sunPos + axis * 2.60, 0.032, uAspect)
               * vec3(1.0, 0.65, 0.35) * 0.12;

        // Gently additive: photographic glow, never a blinding white-out.
        col += max(flare, vec3(0.0)) * (uSunFlare * 0.85);
      }

      // ---------------------------------------------------------------
      // Step 4c — filmic vignette, ASA 200 35 mm emulsion grain, output.
      //
      // Real celluloid exposes at 24 fps, so the grain field is quantised to
      // a film frame: one organic silver-halide pattern per 1/24 s instead
      // of raw 60 fps digital snow. The pattern is two octaves — a
      // pixel-scale crystal plus a 0.62x coarser halide clump — so it keeps
      // tactile body on high-DPI displays. The three dye-coupler layers
      // share ~82% correlated luminance grain and only ~18% independent
      // R/G/B dye scatter: Kodak/Fuji ASA 200 chroma micro-grain, never
      // ugly digital RGB noise. The response curve keeps the grain rich
      // through the midtones and shadows and fades it cleanly off the
      // blown-out white of sun and cloud cores.
      // ---------------------------------------------------------------
      float vig = 1.0 - smoothstep(0.38, 1.58, r2) * uVignette;
      col *= vig;

      if (uGrain > 0.0005) {
        float filmFrame = floor(uTime * 24.0);
        // Golden-ratio sequent on a 4096-frame (2 min 51 s) loop: every film
        // frame lands on a fresh, well decorrelated seed, and the value stays
        // small enough that the sin hash keeps full fp32 precision even in a
        // multi-hour session (a 170 s repeat is imperceptible).
        vec2 frameSeed = fract(mod(filmFrame, 4096.0) * vec2(0.618033988, 0.754877667)) * 97.0;
        vec2 gCoord = gl_FragCoord.xy;
        vec2 fineCoord = gCoord + frameSeed;
        vec2 clumpCoord = floor(gCoord * 0.62) + frameSeed;

        // 74% pixel-scale crystal + 26% coarser halide clump, centred on 0.
        float fineGrain = hash12(fineCoord);
        float clumpGrain = hash12(clumpCoord + vec2(13.7, 71.3));
        float lumGrain = fineGrain * 0.74 + clumpGrain * 0.26 - 0.5;

        // Three dye-coupler layers, each scattering a little on its own.
        vec3 dyeGrain = vec3(
          hash12(fineCoord + vec2(3.71, 9.13)),
          hash12(fineCoord + vec2(7.29, 1.87)),
          hash12(clumpCoord + vec2(5.53, 4.41))
        ) - 0.5;
        vec3 grainRGB = vec3(lumGrain) * 0.82 + dyeGrain * 0.18;

        // Photographic midtone/shadow response: densest where the emulsion
        // sits mid-scale, clean over blown-out white.
        float lumaG = dot(col, vec3(0.2126, 0.7152, 0.0722));
        float toneResp = (0.38 + 0.85 * 4.0 * lumaG * (1.0 - lumaG)) * (1.0 - smoothstep(0.86, 1.0, lumaG));
        col += grainRGB * (uGrain * toneResp);
      }

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

export class PostFXSystem {
  /**
   * @param {object|null} renderer WebGLRenderer, or null when headless.
   * @param {object|null} scene
   * @param {object|null} camera
   * @param {{enabled?: boolean, night?: boolean|number}} [options]
   */
  constructor(renderer, scene, camera, options = {}) {
    const { enabled = true, night = false } = options || {};

    this.renderer = renderer || null;
    this.scene = scene || null;
    this.camera = camera || null;

    // `night` is a continuous 0..1 level (sky.night), not a boolean: golden
    // hour sits near 0.05 and must not snap straight to full night bloom.
    this.nightTarget = _nightLevel(night);
    this.night = this.nightTarget > 0.5;
    this.nightBlend = this.nightTarget;
    this.threshold = lerp(DAY_THRESHOLD, NIGHT_THRESHOLD, this.nightBlend);
    this.strength = lerp(DAY_STRENGTH, NIGHT_STRENGTH, this.nightBlend);
    this.radius = BLOOM_RADIUS;

    // Temporary additive bloom spike (detonations, Mach 1.0 shockwave).
    this.bloomPulse = 0;

    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.outputPass = null;
    // Dedicated HDR MSAA scene target (where the scene is actually rasterised)
    // plus a plain HDR post target for the tonemap/FXAA quads. Splitting them
    // keeps MSAA on the geometry and off the full-screen passes (PERF-04).
    // `renderTarget` is kept as an alias of `sceneTarget` for compatibility.
    this.sceneTarget = null;
    this.postTarget = null;
    this.renderTarget = null;
    this.fxaaPass = null;
    // VIPER-OPTICS: alias of the same pass. Exactly one final fullscreen pass
    // writes to the canvas; there is no second optics pass and no extra target.
    this.opticsPass = null;
    this.samples = 0;

    // 90% internal scene render (crisp aircraft, slight camera softness). The
    // scene/post targets are rasterised at CSS * dpr * renderScale and
    // hardware-upscaled to the full-resolution canvas by the final optics
    // pass. Clamped to a sane [0.5, 1.0] window: below 0.5 the bilinear
    // stretch is mushy, above 1.0 would defeat the whole point.
    this.renderScale = clamp(
      options && options.renderScale !== undefined ? options.renderScale : INTERNAL_RENDER_SCALE,
      RENDER_SCALE_MIN,
      RENDER_SCALE_MAX,
    );
    // Last CSS size / DPR seen, so setRenderScale() can re-size the composer
    // without waiting for the next window resize event.
    this._viewWidth = 0;
    this._viewHeight = 0;
    this._viewDpr = 1;

    // VIPER-OPTICS state. `optics` is the live (eased) lens, readable by tests
    // and tuning code; the `_opt*` fields are the targets requested by
    // setOptics(). Both start at 0 so the menu renders untouched.
    this.optics = {
      distortion: 0,
      chroma: 0,
      blur: 0,
      vignette: 0,
      grain: 0,
      canopyGlint: 0,
      softness: 0,
      sunFlare: 0,
    };
    this._opticsTime = 0;
    this._optDistortion = 0;
    this._optChroma = 0;
    this._optBlur = 0;
    this._optVignette = 0;
    this._optGrain = 0;
    this._optCanopyGlint = 0;
    this._optSoftness = 0;
    this._optSunFlare = 0;

    this.supported = this._hasRenderableContext();
    this.enabled = !!enabled && this.supported;
    if (this.enabled) this._build();
  }

  // ------------------------------------------------------------- capability
  _hasRenderableContext() {
    const r = this.renderer;
    if (!r || typeof r.render !== 'function') return false;
    // A real WebGLRenderer exposes the live GL context; a stub/headless
    // renderer either lacks the method or returns null.
    if (typeof r.getContext === 'function') {
      let ctx = null;
      try {
        ctx = r.getContext();
      } catch {
        ctx = null;
      }
      if (!ctx) return false;
    }
    // The passes need a real canvas to allocate render targets.
    if (typeof document === 'undefined') return false;
    return true;
  }

  _build() {
    try {
      const size = new THREE.Vector2(1280, 720);
      if (this.renderer && typeof this.renderer.getSize === 'function') {
        this.renderer.getSize(size);
        if (!(size.x > 0) || !(size.y > 0)) size.set(1280, 720);
      }
      const dpr =
        this.renderer && typeof this.renderer.getPixelRatio === 'function'
          ? this.renderer.getPixelRatio() || 1
          : 1;

      // WebGL2 hardware MSAA: EffectComposer's default target has samples 0, so
      // an explicit multisampled HalfFloat HDR target is what restores it.
      // Anything without multisample-target support (WebGL1, odd drivers) falls
      // back to samples: 0 and still gets the FXAA pass on top.
      // 90% internal render: the scene is rasterised at CSS * dpr * renderScale
      // (0.90 linear = ~81% of the fragment pixels) into this buffer. The final
      // optics pass runs at full native canvas resolution and bilinearly
      // upsamples it, so the aircraft and close terrain keep their detail with
      // a hair of camera softness while HUD, flares, grain and the 2D overlay
      // stay razor sharp.
      this._viewWidth = size.x;
      this._viewHeight = size.y;
      this._viewDpr = dpr;
      const rtW = Math.max(1, Math.round(size.x * dpr * this.renderScale));
      const rtH = Math.max(1, Math.round(size.y * dpr * this.renderScale));
      const caps = this.renderer && this.renderer.capabilities;
      const isWebGL2 = !!(caps && caps.isWebGL2);
      const maxSamples = (caps && Number.isFinite(caps.maxSamples) && caps.maxSamples > 0)
        ? caps.maxSamples
        : 4;
      this.samples = isWebGL2 ? Math.min(4, maxSamples) : 0;
      // Scene target: HDR + hardware MSAA + depth. This is the only buffer the
      // scene is rasterised into, so it is the only one that needs samples or a
      // depth attachment.
      this.sceneTarget = new THREE.WebGLRenderTarget(rtW, rtH, {
        type: THREE.HalfFloatType,
        samples: this.samples,
        depthBuffer: true,
      });
      // Post target: receives the OutputPass/FXAA full-screen quads only. A
      // fullscreen triangle needs neither MSAA nor depth, so both are off
      // (PERF-04: the composer's default clone made this a second 4x MSAA HDR
      // buffer, about 157 MB of VRAM and a full multisample write+resolve per
      // frame for nothing).
      this.postTarget = new THREE.WebGLRenderTarget(rtW, rtH, {
        type: THREE.HalfFloatType,
        samples: 0,
        depthBuffer: false,
      });
      // Hardware bilinear upscale: the final optics pass reads one of these
      // 90% buffers and stretches them over the full-resolution canvas, so both
      // textures must filter linearly — NearestFilter would turn the filmic
      // softness into visible texel squares.
      for (const tex of [this.sceneTarget.texture, this.postTarget.texture]) {
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
      }
      this.renderTarget = this.sceneTarget;

      this.composer = new EffectComposer(this.renderer, this.postTarget);
      // EffectComposer clones its constructor target into renderTarget2; that
      // clone is a third full-size buffer nothing needs. Drop it and wire the
      // composer to the two explicit targets: scene -> readBuffer (MSAA),
      // post quads -> writeBuffer (no MSAA, no depth).
      if (this.composer.renderTarget2 &&
          typeof this.composer.renderTarget2.dispose === 'function') {
        this.composer.renderTarget2.dispose();
      }
      this.composer.renderTarget2 = this.sceneTarget;
      this.composer.readBuffer = this.sceneTarget;
      this.composer.writeBuffer = this.postTarget;

      this.composer.setPixelRatio(dpr * this.renderScale);
      this.composer.setSize(size.x, size.y);
      // EffectComposer.setSize rounds nothing, so pin both buffers to the exact
      // integer texel dimensions the FXAA taps are computed from. That is what
      // makes its diagonal neighbours true 1-texel neighbours of the 90% buffer.
      this.sceneTarget.setSize(rtW, rtH);
      this.postTarget.setSize(rtW, rtH);

      this.renderPass = new RenderPass(this.scene, this.camera);
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        this.strength,
        BLOOM_RADIUS,
        this.threshold,
      );
      this.outputPass = new OutputPass();
      // FXAA runs *after* OutputPass so it filters tonemapped sRGB luma (and
      // the bloom halo) instead of linear HDR, where a single firefly pixel
      // would dominate the edge blend. VIPER-OPTICS folds the lens work into
      // this same pass, so the composer still has four passes and two targets.
      this.fxaaPass = new ShaderPass(CinemaOpticsFXAAShader);
      this.opticsPass = this.fxaaPass;
      this._pushOptics();

      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(this.outputPass);
      this.composer.addPass(this.fxaaPass);

      // addPass() sized the bloom pyramid to the DPR drawing buffer; resize()
      // sizes it at CSS resolution. Use one convention from the first frame so
      // the halo does not change size at the first window resize (and so the
      // 1.82x extra bloom pixels at DPR 1.35 are never allocated).
      this.bloomPass.setSize(size.x, size.y);

      // Synced after addPass(): the 90% buffer's real texel size drives FXAA's
      // diagonal taps so they hit exact 1-texel neighbours, while uAspect stays
      // the CSS frame ratio so starbursts and bokeh ghosts remain circles.
      this._updateFxaaResolution(size.x, size.y, dpr * this.renderScale);

      this.supported = true;
      this._applyBloom();
    } catch (err) {
      // Any failure (no GL, stubbed renderer, odd canvas) is a passthrough.
      if (this.fxaaPass && this.fxaaPass.material &&
          typeof this.fxaaPass.material.dispose === 'function') {
        this.fxaaPass.material.dispose();
      }
      if (this.composer && typeof this.composer.dispose === 'function') {
        // Releases whatever the composer had wired up before the failure.
        try {
          this.composer.dispose();
        } catch {
          /* half-built composer */
        }
      }
      this._disposeTargets();
      this.composer = null;
      this.renderPass = null;
      this.bloomPass = null;
      this.outputPass = null;
      this.fxaaPass = null;
      this.opticsPass = null;
      this.samples = 0;
      this.supported = false;
      this.enabled = false;
      this.lastError = err;
    }
  }

  /**
   * Dispose the two HDR targets exactly once. EffectComposer.dispose() already
   * frees its renderTarget1/renderTarget2 — which are postTarget/sceneTarget
   * after the rewire above — so only targets the composer does not reference
   * are disposed here. Null-safe for headless / half-built states, and clears
   * the `renderTarget` alias.
   */
  _disposeTargets() {
    const composer = this.composer;
    const owns = (t) => !!composer &&
      (composer.renderTarget1 === t || composer.renderTarget2 === t);
    if (this.sceneTarget && !owns(this.sceneTarget) &&
        typeof this.sceneTarget.dispose === 'function') {
      this.sceneTarget.dispose();
    }
    if (this.postTarget && !owns(this.postTarget) &&
        typeof this.postTarget.dispose === 'function') {
      this.postTarget.dispose();
    }
    this.sceneTarget = null;
    this.postTarget = null;
    this.renderTarget = null;
  }

  /**
   * Keep FXAA's texel size in step with the 90% internal buffer (DPR and
   * renderScale included). `dpr` here is the *effective* ratio, i.e.
   * dpr * renderScale, so `resolution` is one texel of the buffer the final
   * pass actually reads — its diagonal taps land on exact neighbours instead of
   * a fractional grid. `uAspect` stays the CSS frame ratio (the scale is
   * uniform, so the shape of the picture is unchanged).
   */
  _updateFxaaResolution(width, height, dpr) {
    const pass = this.fxaaPass || this.opticsPass;
    if (!pass || !pass.material?.uniforms?.resolution) return;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    pass.material.uniforms.resolution.value.set(1 / w, 1 / h);
    // Sun starburst rays and bokeh ghosts are built in aspect-corrected UV
    // space, so they stay perfect circles on any monitor shape.
    if (pass.material.uniforms.uAspect) {
      const aspect = width > 0 && height > 0 ? width / height : w / h;
      pass.material.uniforms.uAspect.value = aspect;
    }
  }

  /**
   * 90% internal render control. Clamped to [0.5, 1.0] and applied live: the
   * composer is re-sized on the next call so a quality toggle never needs a
   * reload. 1.0 restores a native-resolution scene buffer.
   */
  setRenderScale(scale) {
    const raw = Number.isFinite(scale) ? scale : this.renderScale;
    this.renderScale = clamp(raw, RENDER_SCALE_MIN, RENDER_SCALE_MAX);
    if (this.composer && this.sceneTarget && this.postTarget &&
        this._viewWidth > 0 && this._viewHeight > 0) {
      this.resize(this._viewWidth, this._viewHeight, this._viewDpr);
    }
    return this;
  }

  // ------------------------------------------------------------------- API
  /** Toggle composer rendering; Low quality disables bloom for max FPS. */
  setEnabled(on) {
    const want = !!on;
    if (want && !this.composer && !this.supported) {
      this.enabled = false;
      return false;
    }
    if (want && !this.composer) this._build();
    this.enabled = want && !!this.composer;
    return this.enabled;
  }

  /**
   * Aim the day/night bloom preset at a continuous 0..1 night level (booleans
   * still work: true = 1, false = 0). The actual transition is eased in
   * update(), so a golden-hour `sky.night ~ 0.05` stays near the day preset
   * instead of snapping to full night bloom.
   */
  setNight(night) {
    this.nightTarget = _nightLevel(night);
    this.night = this.nightTarget > 0.5;
    return this;
  }

  /** Temporary bloom spike (BFFG/Mk-82 detonation, Mach 1.0 shockwave). */
  pulseBloom(amount = 0.55) {
    const add = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    if (add > 0) this.bloomPulse = Math.min(PULSE_LIMIT, Math.max(this.bloomPulse, add));
    return this;
  }

  /**
   * VIPER-OPTICS: aim the helmet-cam lens at the current flight state.
   *
   * Allocation-free and headless-safe: it only writes the `_opt*` targets, and
   * the live values glide toward them inside update(). Chainable.
   *
   * @param {{cockpitView?: boolean, speedNorm?: number, gLoad?: number,
   *   afterburner?: boolean, machPulse?: number, aglNorm?: number,
   *   freeCam?: boolean, night?: number|boolean, menu?: boolean,
   *   sunScreenX?: number, sunScreenY?: number, sunFlare?: number,
   *   sunColor?: object|number}} [opts]
   */
  setOptics(opts = {}) {
    const o = opts || {};
    const freeCam = !!o.freeCam;
    const menu = !freeCam && !!o.menu;
    const cockpitView = !freeCam && !menu && !!o.cockpitView;

    const night = clamp(_nightLevel(o.night), 0, 1);
    const speedNorm = clamp(Number.isFinite(o.speedNorm) ? o.speedNorm : 0, 0, 1.4);
    const aglNorm = clamp(Number.isFinite(o.aglNorm) ? o.aglNorm : 0, 0, 1);
    const gLoad = Number.isFinite(o.gLoad) ? o.gLoad : 1;
    const gAbs = Math.abs(gLoad);
    const afterburner = !!o.afterburner;
    const machPulse = clamp(Number.isFinite(o.machPulse) ? o.machPulse : 0, 0, 1);

    // Subtle, tasteful micro-detail: G-load, afterburner, Mach shockwave and a
    // detonation bloom each push a *whisper* of radial CA (2–3 px at the very
    // corner). Anything stronger splits foliage into rainbow ghost circles.
    const dynamicBoost = clamp(
      (Math.max(0, gAbs - 2.2) / 7.0) * 0.0012
        + (afterburner ? 0.0004 : 0)
        + machPulse * 0.0015
        + Math.min(this.bloomPulse, 1) * 0.0010,
      0,
      0.0028,
    );

    // Fast, low and pulling G smears the outer frame only — a hair of it.
    const speedBlur = clamp(
      speedNorm * 0.0012
        + aglNorm * speedNorm * 0.0010
        + (afterburner ? 0.0005 : 0)
        + Math.max(0, gAbs - 3.5) * 0.00025
        + machPulse * 0.0014,
      0,
      0.0028,
    );

    // ---------------------------------------------------------------
    // Sun flare handoff. The screen-space sun position is written straight
    // into the uniform (no easing) so the starburst stays locked to the disc
    // through fast rolls; only the overall visibility is eased. Free Cam and
    // the menu are inspection/boot modes, so the flare is forced off there
    // regardless of what the caller projected.
    // ---------------------------------------------------------------
    const sunFlareTarget = (freeCam || menu)
      ? 0
      : clamp(Number.isFinite(o.sunFlare) ? o.sunFlare : 0, 0, 1);
    const sunPass = this.opticsPass || this.fxaaPass;
    const sunU = sunPass && sunPass.material && sunPass.material.uniforms;
    if (sunU) {
      if (sunU.uSunScreen && sunU.uSunScreen.value) {
        const sx = Number.isFinite(o.sunScreenX) ? o.sunScreenX : 0.5;
        const sy = Number.isFinite(o.sunScreenY) ? o.sunScreenY : 0.5;
        sunU.uSunScreen.value.set(sx, sy);
      }
      if (sunU.uSunColor && sunU.uSunColor.value && o.sunColor) {
        if (o.sunColor.isColor) sunU.uSunColor.value.copy(o.sunColor);
        else if (typeof o.sunColor === 'number') sunU.uSunColor.value.setHex(o.sunColor);
      }
    }
    this._optSunFlare = sunFlareTarget;

    if (menu) {
      // Menu backdrop: pristine rectilinear frame, no lens personality.
      this._optDistortion = 0;
      this._optChroma = 0;
      this._optBlur = 0;
      this._optVignette = 0;
      this._optGrain = 0;
      this._optCanopyGlint = 0;
      this._optSoftness = 0;
      return this;
    }

    if (freeCam) {
      // Inspection mode: clean rectilinear image, tiny CA/vignette only.
      this._optDistortion = 0;
      this._optChroma = 0.0003;
      this._optBlur = 0;
      this._optVignette = 0.06;
      // ASA 200 inspection grain: lighter than flight, still real film.
      this._optGrain = lerp(0.022, 0.036, night);
      this._optCanopyGlint = 0;
      this._optSoftness = 0;
      return this;
    }

    if (cockpitView) {
      // Helmet cam through the canopy: a real GoPro fisheye barrel. The wide
      // 84 deg camera lens cancels the barrel zoom at the centre, so the HUD,
      // reticle and MFDs keep their exact comfortable scale and sharpness
      // while the cockpit sill rails and horizon wrap out toward the corners
      // at the full fisheye angle. Softness, CA and blur stay tasteful — at
      // 90% the bilinear buffer is nearly native, so the close terrain and the
      // canopy rails keep their detail with just a hair of lens softness.
      this._optDistortion = 0.21;
      this._optSoftness = 0.04;
      this._optChroma = clamp(0.0015 + dynamicBoost, 0, 0.0045);
      this._optBlur = clamp(0.0016 + speedBlur, 0, 0.0046);
      this._optVignette = 0.26;
      // ASA 200 colour negative, pushed a little in low light: cinema grain.
      this._optGrain = lerp(0.042, 0.062, night);
      this._optCanopyGlint = 0.065 * (1 - night);
      return this;
    }

    // External flight views (chase / wing / orbit / flyby): the Viper One-One
    // action-cam look — a full GoPro fisheye. The wider 66 deg lens cancels
    // the barrel zoom at the centre so the F-16 keeps its heroic size, while
    // the horizon and wings sweep out into a dramatic 66 deg fisheye arc.
    this._optDistortion = 0.25;
    this._optSoftness = 0.05;
    this._optChroma = clamp(0.0013 + dynamicBoost * 0.9, 0, 0.0045);
    this._optBlur = clamp(0.0015 + speedBlur * 0.9, 0, 0.0046);
    this._optVignette = 0.22;
    // ASA 200 colour negative, pushed a little in low light: cinema grain.
    this._optGrain = lerp(0.042, 0.062, night);
    this._optCanopyGlint = 0;
    return this;
  }

  /** Push the eased lens state into the single optics/FXAA pass. */
  _pushOptics() {
    const pass = this.opticsPass || this.fxaaPass;
    const u = pass && pass.material && pass.material.uniforms;
    if (!u) return;
    const o = this.optics;
    if (u.uDistortion) u.uDistortion.value = o.distortion;
    if (u.uChroma) u.uChroma.value = o.chroma;
    if (u.uBlur) u.uBlur.value = o.blur;
    if (u.uVignette) u.uVignette.value = o.vignette;
    if (u.uGrain) u.uGrain.value = o.grain;
    if (u.uCanopyGlint) u.uCanopyGlint.value = o.canopyGlint;
    if (u.uSoftness) u.uSoftness.value = o.softness;
    if (u.uSunFlare) u.uSunFlare.value = o.sunFlare;
    if (u.uTime) u.uTime.value = this._opticsTime;
  }

  /** Decay the bloom pulse and ease day/night tuning + lens optics. */
  update(dt) {
    const h = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;

    const target = this.nightTarget;
    const step = NIGHT_BLEND_RATE * h;
    if (this.nightBlend < target) this.nightBlend = Math.min(target, this.nightBlend + step);
    else if (this.nightBlend > target) this.nightBlend = Math.max(target, this.nightBlend - step);

    this.threshold = lerp(DAY_THRESHOLD, NIGHT_THRESHOLD, this.nightBlend);
    this.strength = lerp(DAY_STRENGTH, NIGHT_STRENGTH, this.nightBlend);

    if (this.bloomPulse > 0) {
      this.bloomPulse -= (this.bloomPulse / PULSE_DECAY) * h;
      if (this.bloomPulse < PULSE_FLOOR) this.bloomPulse = 0;
    }

    // VIPER-OPTICS: advance the grain clock and glide the lens values. The
    // exponential ease is frame-rate independent and can never overshoot.
    this._opticsTime += h;
    const ease = 1 - Math.exp(-OPTICS_BLEND_RATE * h);
    const o = this.optics;
    o.distortion += (this._optDistortion - o.distortion) * ease;
    o.chroma += (this._optChroma - o.chroma) * ease;
    o.blur += (this._optBlur - o.blur) * ease;
    o.vignette += (this._optVignette - o.vignette) * ease;
    o.grain += (this._optGrain - o.grain) * ease;
    o.canopyGlint += (this._optCanopyGlint - o.canopyGlint) * ease;
    o.softness += (this._optSoftness - o.softness) * ease;
    o.sunFlare += (this._optSunFlare - o.sunFlare) * ease;
    this._pushOptics();

    this._applyBloom();
    return this;
  }

  _applyBloom() {
    const pass = this.bloomPass;
    if (!pass) return;
    pass.threshold = clamp(this.threshold, 0, 2);
    pass.strength = this.strength + Math.min(this.bloomPulse, PULSE_LIMIT);
    pass.radius = this.radius;
  }

  /** Resize composer + render targets (window resize / DPR change). */
  resize(width, height, dpr) {
    const w = Number.isFinite(width) && width > 0 ? Math.round(width) : 1280;
    const h = Number.isFinite(height) && height > 0 ? Math.round(height) : 720;
    const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    if (!this.composer) return this;
    this._viewWidth = w;
    this._viewHeight = h;
    this._viewDpr = ratio;
    // 90% internal render: composer and both HDR targets track
    // dpr * renderScale; the final optics pass still writes the canvas at the
    // full native resolution the renderer was sized to.
    const scaled = ratio * this.renderScale;
    const rtW = Math.max(1, Math.round(w * scaled));
    const rtH = Math.max(1, Math.round(h * scaled));
    this.composer.setPixelRatio(scaled);
    this.composer.setSize(w, h);
    // Pin to integer texels (EffectComposer does not round) so FXAA taps exact
    // neighbours of the 90% buffer, and keep the bilinear upscale filter.
    if (this.sceneTarget) this.sceneTarget.setSize(rtW, rtH);
    if (this.postTarget) this.postTarget.setSize(rtW, rtH);
    for (const target of [this.sceneTarget, this.postTarget]) {
      const tex = target && target.texture;
      if (!tex) continue;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
    }
    this._updateFxaaResolution(w, h, scaled);
    if (this.bloomPass && typeof this.bloomPass.setSize === 'function') {
      // Bloom pyramid stays at CSS resolution on purpose: sizing it to the DPR
      // drawing buffer would add 1.82x more bloom pixels at DPR 1.35 for a
      // blur that is already a tight low-frequency halo, and the pass upsamples
      // to scene resolution anyway.
      this.bloomPass.setSize(w, h);
    }
    return this;
  }

  /**
   * Render through the composer when enabled, otherwise a straight
   * renderer.render() passthrough. Returns true when something was drawn.
   */
  render(scene, camera) {
    const s = scene || this.scene;
    const c = camera || this.camera;

    if (this.composer && this.enabled) {
      if (this.renderPass) {
        if (s) this.renderPass.scene = s;
        if (c) this.renderPass.camera = c;
      }
      this.composer.render();
      // Two passes swap per frame (OutputPass, then FXAA), so the scene lands
      // back in the MSAA sceneTarget. If someone later adds a pass with an odd
      // swap count, the next frame's RenderPass would draw into the non-MSAA
      // postTarget — restore the invariant instead.
      if (this.sceneTarget && this.composer.readBuffer !== this.sceneTarget) {
        this.composer.swapBuffers();
      }
      return true;
    }

    if (this.renderer && s && c) {
      this.renderer.render(s, c);
      return true;
    }
    return false;
  }

  dispose() {
    if (this.composer) {
      if (this.bloomPass && typeof this.bloomPass.dispose === 'function') this.bloomPass.dispose();
      if (this.outputPass && typeof this.outputPass.dispose === 'function') this.outputPass.dispose();
      if (this.renderPass && typeof this.renderPass.dispose === 'function') this.renderPass.dispose();
      // Frees renderTarget1/renderTarget2, i.e. postTarget + sceneTarget.
      if (typeof this.composer.dispose === 'function') this.composer.dispose();
    }
    if (this.fxaaPass && this.fxaaPass.material &&
        typeof this.fxaaPass.material.dispose === 'function') {
      this.fxaaPass.material.dispose();
    }
    this._disposeTargets();
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.outputPass = null;
    this.fxaaPass = null;
    this.opticsPass = null;
    this.samples = 0;
    this.enabled = false;
    return this;
  }
}