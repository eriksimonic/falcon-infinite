// Headless acceptance tests for VIPER-OPTICS — the helmet-cam optical
// post-process fused into the existing FXAA pass (barrel distortion, radial
// chromatic aberration, peripheral speed blur, canopy sheen, filmic contrast,
// vignette and ASA 200 35 mm film grain) with ZERO extra render targets.
// Run: node tests/optics_perf_test.mjs
//
// Two modes are exercised:
//   * pure headless (no renderer at all) — every API must stay inert-safe;
//   * a stub renderer that advertises a GL context, which lets the real
//     EffectComposer chain build in Node so the pass/target wiring (PERF-04)
//     is asserted on live objects, not just on source text.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PostFXSystem,
  CinemaOpticsFXAAShader,
  DAY_THRESHOLD,
  NIGHT_THRESHOLD,
  DAY_STRENGTH,
  NIGHT_STRENGTH,
  INTERNAL_RENDER_SCALE,
  RENDER_SCALE_MIN,
  RENDER_SCALE_MAX,
} from '../src/sim/postfx.js';
import { CONFIG } from '../src/config.js';

let checks = 0;
const failures = [];
function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
}

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 1. CinemaOpticsFXAAShader — uniforms + GLSL contract
// ---------------------------------------------------------------------------
{
  ok(INTERNAL_RENDER_SCALE === 0.90 && RENDER_SCALE_MIN === 0.5 && RENDER_SCALE_MAX === 1.0,
    'the 90% internal render constants are exported and pinned');
  ok(CinemaOpticsFXAAShader && typeof CinemaOpticsFXAAShader === 'object',
    'CinemaOpticsFXAAShader is exported as a shader object');

  const u = CinemaOpticsFXAAShader.uniforms;
  ok(u && u.tDiffuse && u.tDiffuse.value === null,
    'shader keeps tDiffuse, wired by ShaderPass');
  ok(u.resolution && u.resolution.value instanceof THREE.Vector2,
    'shader keeps the stock `resolution` uniform as a Vector2');
  ok(near(u.resolution.value.x, 1 / 1280, 1e-12) && near(u.resolution.value.y, 1 / 720, 1e-12),
    'resolution defaults to 1/1280 x 1/720',
    `got ${u.resolution.value.x}, ${u.resolution.value.y}`);

  for (const key of ['uDistortion', 'uChroma', 'uBlur', 'uVignette', 'uGrain', 'uCanopyGlint', 'uTime']) {
    ok(u[key] && u[key].value === 0, `shader declares ${key} at 0.0`);
  }

  // VIPER-OPTICS sun flare + filmic softness uniforms.
  ok(u.uSunScreen && u.uSunScreen.value instanceof THREE.Vector2,
    'shader declares uSunScreen as a Vector2');
  ok(near(u.uSunScreen.value.x, 0.5) && near(u.uSunScreen.value.y, 0.5),
    'uSunScreen defaults to the frame centre');
  ok(u.uSunFlare && u.uSunFlare.value === 0, 'shader declares uSunFlare at 0.0');
  ok(u.uSunColor && u.uSunColor.value instanceof THREE.Color,
    'shader declares uSunColor as a THREE.Color');
  ok(u.uSoftness && u.uSoftness.value === 0, 'shader declares uSoftness at 0.0');
  ok(u.uAspect && near(u.uAspect.value, 16 / 9), 'shader declares uAspect at 16/9',
    `got ${u.uAspect && u.uAspect.value}`);

  const frag = CinemaOpticsFXAAShader.fragmentShader;
  const vert = CinemaOpticsFXAAShader.vertexShader;
  ok(typeof frag === 'string' && frag.length > 1200, 'fragment shader is present');
  ok(/varying vec2 vUv;/.test(vert) && /gl_Position = projectionMatrix \* modelViewMatrix/.test(vert),
    'vertex shader supplies vUv');

  // Uniform declarations for every optic control.
  for (const decl of [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 resolution;',
    'uniform float uDistortion;',
    'uniform float uChroma;',
    'uniform float uBlur;',
    'uniform float uVignette;',
    'uniform float uGrain;',
    'uniform float uCanopyGlint;',
    'uniform float uTime;',
    'uniform vec2 uSunScreen;',
    'uniform float uSunFlare;',
    'uniform vec3 uSunColor;',
    'uniform float uSoftness;',
    'uniform float uAspect;',
  ]) {
    ok(frag.includes(decl), `fragment shader declares "${decl}"`);
  }

  // Step 1 — barrel distortion with auto-scale (no black corners, no smear).
  ok(/#define EDGE_UV 0\.001/.test(frag),
    'safe sample border is 0.001, not the old smearing 0.0005');
  ok(/float zoom = 1\.0 \/ \(1\.0 \+ max\(k, 0\.0\) \* 2\.05 \+ uChroma \* 2\.5\);/.test(frag),
    'auto-zoom covers the full corner radius (r2 = 2.0) plus a CA margin');
  ok(/zoom \*= 1\.0 - 2\.0 \* uChroma;/.test(frag),
    'the CA split reach is folded into the zoom (UV units, not p units)');
  ok(/vec2 dUv = 0\.5 \+ 0\.5 \* p \* zoom \* \(1\.0 \+ k \* r2\);/.test(frag),
    'distortion applies the k1 radius term');

  // Step 2 — FXAA around the distorted UV.
  ok(/rgbNW/.test(frag) && /rgbNE/.test(frag) && /rgbSW/.test(frag) && /rgbSE/.test(frag),
    'FXAA samples the four diagonal neighbours');
  ok(/lumaMin/.test(frag) && /lumaMax/.test(frag) && /lumaB < lumaMin \|\| lumaB > lumaMax/.test(frag),
    'FXAA blends with a luma-guided tap choice');

  // Step 2b — filmic optical softness reuses the FXAA diagonal taps.
  ok(/vec3 softAvg = 0\.25 \* \(rgbNW \+ rgbNE \+ rgbSW \+ rgbSE\);/.test(frag),
    'softness averages the four FXAA diagonal taps (zero extra lookups)');
  ok(/mix\(fxaaCol, softAvg, clamp\(uSoftness \* \(0\.45 \+ 0\.55 \* edgeW\), 0\.0, 0\.42\)\)/.test(frag),
    'softness blends hardest on edges, capped at 0.42');
  ok(/if \(uSoftness > 0\.001\)/.test(frag), 'softness costs nothing when disabled');
  ok(!/softAvg\s*=\s*0\.25 \* \(tap/.test(frag) && !/vec3 softAvg = 0\.25 \* \(0\.5/.test(frag),
    'softAvg is built from already-fetched samples, not fresh taps');

  // Step 3 — radial CA + peripheral blur, gated on r2. The gate now starts at
  // r2 = 0.24 so only the outer frame receives delicate lens falloff and the
  // central 75% of the view stays clean and sharp.
  ok(/float edgeW = smoothstep\(0\.24, 1\.28, r2\);/.test(frag),
    'CA/blur gate starts outside the central core (smoothstep 0.24..1.28)');
  ok(/vec2 caOff = p \* \(r2 \* uChroma\);/.test(frag),
    'chromatic aberration is radial');
  ok(/mix\(fxaaCol\.r, rCh, edgeW\)/.test(frag) && /mix\(fxaaCol\.b, bCh, edgeW\)/.test(frag),
    'centre pixels keep the pure FXAA sample (edgeW = 0)');
  ok(/uBlur > 0\.0002 && edgeW > 0\.001/.test(frag),
    'peripheral blur is skipped while it would be invisible');
  ok(/float rad = uBlur \* edgeW \* 0\.72;/.test(frag),
    'bokeh radius scales with uBlur and the radial edge weight, tightened to 0.72x');
  ok(/vec2 aspectFix = vec2\(1\.0 \/ uAspect, 1\.0\);/.test(frag),
    'bokeh offsets are aspect-corrected, so the disc stays circular');
  // Eight taps: a rotated six-point soft ring plus two radial motion taps.
  for (const [decl, label] of [['vec2 d1 = vec2(0.9659, 0.2588);', '15 deg'],
    ['vec2 d2 = vec2(0.2588, 0.9659);', '75 deg'],
    ['vec2 d3 = vec2(-0.7071, 0.7071);', '135 deg']]) {
    ok(frag.includes(decl), `bokeh ring direction ${label} is present`);
  }
  ok(/vec2 ring = rad \* 0\.62 \* aspectFix;/.test(frag),
    'six ring taps sit on a 0.62 radius soft disc');
  const ringTap = /tap\(dUv \+ d1 \* ring\) \+ tap\(dUv - d1 \* ring\)[\s\S]*tap\(dUv \+ d2 \* ring\) \+ tap\(dUv - d2 \* ring\)[\s\S]*tap\(dUv \+ d3 \* ring\) \+ tap\(dUv - d3 \* ring\)/.test(frag);
  ok(ringTap, 'six symmetric ring taps feed the bokeh average');
  ok(/tap\(dUv - d3 \* ring\)\) \* 0\.12;/.test(frag), 'ring taps carry 0.12 each');
  ok(/vec2 radialDir = p \* inversesqrt\(max\(r2, 0\.0001\)\);/.test(frag) &&
    /vec2 motion = radialDir \* \(rad \* 1\.15\) \* aspectFix;/.test(frag),
    'two radial motion taps run along p');
  ok(/bokeh \+= \(tap\(dUv \+ motion\) \+ tap\(dUv - motion\)\) \* 0\.14;/.test(frag),
    'motion taps are symmetric and carry 0.14 each');
  ok(/vec2 cOff = caOff \* 0\.50;/.test(frag),
    'bokeh taps carry only half the radial red/cyan split (no rainbow ghosts)');
  ok(/bokeh\.r = mix\(bokeh\.r, tap\(dUv \+ motion \* 0\.5 \+ cOff\)\.r, 0\.35\);/.test(frag) &&
    /bokeh\.b = mix\(bokeh\.b, tap\(dUv - motion \* 0\.5 - cOff\)\.b, 0\.35\);/.test(frag),
    'the bokeh R/B channels are split gently along the inner half of the radial axis');
  ok(/vec2 room = min\(dUv - vec2\(EDGE_UV\), vec2\(1\.0 - EDGE_UV\) - dUv\);/.test(frag) &&
    /float fit = min\(1\.0, min\(room\.x \/ max\(reach\.x, 0\.0001\),/.test(frag),
    'the kernel renormalises to stay inside the safe frame (no border stretch)');
  ok(/clamp\(edgeW \* 0\.65, 0\.0, 0\.65\)/.test(frag),
    'blur blend is capped at 0.65: silky falloff, zero double-vision dots');
  ok(!/clamp\(edgeW \* 0\.88, 0\.0, 0\.88\)/.test(frag),
    'the old 0.88 blur blend cap is gone');
  ok(!/bp \* 0\.35/.test(frag) && !/bp \* 1\.40/.test(frag),
    'the old four collinear radial taps are gone');

  // Step 4 — canopy sheen, filmic contrast, vignette, grain.
  ok(/vec3\(0\.45, 0\.85, 0\.62\)/.test(frag), 'canopy sheen is the pale teal-green tint');
  ok(/uCanopyGlint > 0\.001/.test(frag), 'canopy sheen costs nothing when disabled');
  ok(/col \* col \* \(3\.0 - 2\.0 \* col\)/.test(frag), 'filmic S-curve is applied');
  ok(/vec3\(1\.02, 1\.005, 0\.98\)/.test(frag) && /vec3\(0\.97, 0\.99, 1\.03\)/.test(frag),
    'warm-highlight / cool-shadow split toning is present');
  ok(/smoothstep\(0\.38, 1\.58, r2\) \* uVignette/.test(frag), 'filmic vignette uses r2');

  // Step 4c — ASA 200 35 mm emulsion grain: 24 fps celluloid cadence, a fine
  // crystal plus a coarser halide clump, an 82/18 luminance/dye split and a
  // photographic midtone/shadow response that fades off blown-out white.
  ok(/float filmFrame = floor\(uTime \* 24\.0\);/.test(frag),
    'grain runs on the 24 fps celluloid cadence, not 60 fps digital snow');
  ok(!/fract\(uTime \* 17\.3\)/.test(frag), 'the old synthetic uTime * 17.3 grain is gone');
  ok(/vec2 gCoord = gl_FragCoord\.xy;/.test(frag),
    'grain is measured in pixel space via gl_FragCoord');
  ok(/vec2 clumpCoord = floor\(gCoord \* 0\.62\) \+ frameSeed;/.test(frag),
    'a 0.62x coarser silver-halide clump sits under the pixel-scale crystal');
  ok(/float lumGrain = fineGrain \* 0\.74 \+ clumpGrain \* 0\.26 - 0\.5;/.test(frag),
    'fine and clumped grain are blended and centred on zero');
  ok(/vec3 dyeGrain = vec3\([\s\S]*?\) - 0\.5;/.test(frag),
    'three independent dye-coupler layers are sampled');
  ok(/vec3 grainRGB = vec3\(lumGrain\) \* 0\.82 \+ dyeGrain \* 0\.18;/.test(frag),
    '82% correlated luminance grain + 18% subtle R/G/B dye scatter');
  ok(/float lumaG = dot\(col, vec3\(0\.2126, 0\.7152, 0\.0722\)\);/.test(frag),
    'the film response reads photographic luma');
  ok(/float toneResp = \(0\.38 \+ 0\.85 \* 4\.0 \* lumaG \* \(1\.0 - lumaG\)\) \* \(1\.0 - smoothstep\(0\.86, 1\.0, lumaG\)\);/
    .test(frag),
    'midtone/shadow response curve fades cleanly off blown-out highlights');
  ok(/col \+= grainRGB \* \(uGrain \* toneResp\);/.test(frag),
    'emulsion grain is composited through uGrain and the film response');
  ok(/if \(uGrain > 0\.0005\)/.test(frag), 'grain costs nothing when disabled (menu)');

  ok(/gl_FragColor = vec4\(clamp\(col, 0\.0, 1\.0\), 1\.0\);/.test(frag),
    'fragment output is clamped');

  // Step 4b2 — analytical screen-space sun flare.
  ok(/float flareDisc\(vec2 uv, vec2 pos, float rad, float aspect\)/.test(frag),
    'flareDisc bokeh helper is declared');
  ok(/\(1\.0 - smoothstep\(rad \* 0\.45, rad, d\)\) \* \(0\.65 \+ 0\.35 \* smoothstep\(rad \* 0\.4, rad \* 0\.92, d\)\)/
      .test(frag.replace(/\s+/g, ' ')),
    'flareDisc has a soft rim falloff');
  ok(/if \(uSunFlare > 0\.005\)/.test(frag), 'the flare block is skipped when invisible');
  ok(/vec2 sunDelta = \(vUv - sunPos\) \* vec2\(uAspect, 1\.0\);/.test(frag),
    'sun vector is aspect-corrected and anchored on the distortion-corrected sun position');
  ok(!/\(vUv - uSunScreen\)/.test(frag) && !/vec2\(0\.5\) - uSunScreen/.test(frag),
    'Step 4b2 no longer compares raw vUv against rectilinear uSunScreen');

  // The flare anchor has to land on the pixel the barrel-distorted sun disc
  // actually occupies, which sits further out from centre than rectilinear
  // uSunScreen. Step 4b2 therefore inverts Step 1 with 4 Newton-Raphson steps
  // on the strictly monotonic radial cubic zoom * (r + max(k,0) * r^3).
  ok(/vec2 sunPos = uSunScreen;/.test(frag),
    'flare anchor is initialised from the rectilinear uSunScreen');
  ok(/vec2 sq = uSunScreen \* 2\.0 - 1\.0;/.test(frag) && /float sr = length\(sq\);/.test(frag),
    'inverse solver converts uSunScreen into a centred screen radius');
  ok(/float kPos = max\(k, 0\.0\);/.test(frag),
    'inverse solver mirrors Step 1 by clamping distortion to k >= 0');
  ok(/float r = sr \/ max\(zoom, 0\.001\);/.test(frag),
    'inverse solver seeds r from screen radius / auto-zoom');
  ok(/for \(int i = 0; i < 4; i\+\+\) \{[\s\S]{0,80}?float rSq = r \* r;[\s\S]{0,80}?float f = zoom \* \(r \+ kPos \* r \* rSq\) - sr;[\s\S]{0,80}?float df = zoom \* \(1\.0 \+ 3\.0 \* kPos \* rSq\);[\s\S]{0,40}?r -= f \/ max\(df, 0\.00001\);/
    .test(frag),
    '4 Newton-Raphson iterations solve zoom * (r + k*r^3) = screen radius');
  ok(/sunPos = 0\.5 \+ 0\.5 \* sq \* \(r \/ sr\);/.test(frag),
    'inverse solver writes the distortion-corrected anchor into sunPos');

  // Numerically prove the solver: mapping sunPos back through Step 1's dUv
  // must reproduce uSunScreen to well under 1e-6 for both the cockpit
  // (k = 0.21) and the chase (k = 0.25) distortion modes.
  const opticsZoom = (k, chroma) =>
    (1 / (1 + Math.max(k, 0) * 2.05 + chroma * 2.5)) * (1 - 2 * chroma);
  const stepOneUv = (uv, k, chroma) => {
    const zoom = opticsZoom(k, chroma);
    const px = uv[0] * 2 - 1;
    const py = uv[1] * 2 - 1;
    const r2 = px * px + py * py;
    return [0.5 + 0.5 * px * zoom * (1 + k * r2),
            0.5 + 0.5 * py * zoom * (1 + k * r2)];
  };
  const invertSunPos = (uSun, k, chroma) => {
    const zoom = opticsZoom(k, chroma);
    const sq = [uSun[0] * 2 - 1, uSun[1] * 2 - 1];
    const sr = Math.hypot(sq[0], sq[1]);
    if (sr <= 0.00001) return [uSun[0], uSun[1]];
    const kPos = Math.max(k, 0);
    let r = sr / Math.max(zoom, 0.001);
    for (let i = 0; i < 4; i++) {
      const rSq = r * r;
      const f = zoom * (r + kPos * r * rSq) - sr;
      const df = zoom * (1 + 3 * kPos * rSq);
      r -= f / Math.max(df, 0.00001);
    }
    const s = r / sr;
    return [0.5 + 0.5 * sq[0] * s, 0.5 + 0.5 * sq[1] * s];
  };
  for (const [mode, k] of [['cockpit', 0.21], ['chase', 0.25]]) {
    for (const chroma of [0.0045, 0.0]) {
      for (const sun of [[0.22, 0.72], [0.78, 0.36], [0.95, 0.90], [0.02, 0.5], [0.99, 0.01]]) {
        const sunPos = invertSunPos(sun, k, chroma);
        const back = stepOneUv(sunPos, k, chroma);
        const err = Math.hypot(back[0] - sun[0], back[1] - sun[1]);
        ok(err < 1e-6,
          `${mode} k=${k} chroma=${chroma}: 4-step Newton inverse round-trips within 1e-6`,
          `sun(${sun}) -> sunPos(${sunPos.map(v => v.toFixed(5))}) -> ${err.toExponential(2)}`);
      }
      // The misalignment being fixed is real, not a rounding artefact: the
      // visible disc sits measurably further out than rectilinear uSunScreen.
      const moved = invertSunPos([0.78, 0.36], k, chroma);
      ok(Math.hypot(moved[0] - 0.78, moved[1] - 0.36) > 0.02,
        `${mode} k=${k} chroma=${chroma}: barrel inverse shifts the anchor perceptibly off uSunScreen`,
        `sunPos ${moved.map(v => v.toFixed(4))}`);
    }
  }
  ok(/float veil = exp\(-sunD \* 1\.9\) \* 0\.28 \+ exp\(-sunD \* 7\.5\) \* 0\.34;/.test(frag),
    'soft atmospheric veiling glare follows the sun distance');
  ok(/pow\(abs\(cos\(ang \* 4\.0\)\), 18\.0\) \* 0\.65/.test(frag) &&
    /pow\(abs\(cos\(ang \* 4\.0 \+ 0\.7854\)\), 28\.0\) \* 0\.35/.test(frag),
    'starburst is an 8-point diffraction pattern');
  ok(/float star = rays \* exp\(-sunD \* 5\.2\) \* 0\.55;/.test(frag),
    'starburst rays fall off with sun distance');
  ok(/exp\(-abs\(vUv\.y - sunPos\.y\) \* 58\.0\)/.test(frag) &&
    /exp\(-abs\(vUv\.x - sunPos\.x\) \* 2\.2\) \* 0\.36/.test(frag),
    'thin anamorphic horizontal streak follows the corrected sun position');
  ok(/vec2 axis = vec2\(0\.5\) - sunPos;/.test(frag),
    'ghosts march along the corrected sun -> screen-centre optical axis');
  for (const [mult, rad] of [['0.65', '0.022'], ['1.25', '0.042'], ['1.65', '0.028'],
    ['2.15', '0.056'], ['2.60', '0.032']]) {
    const anchor = mult === '1.65' ? 'g3' : `sunPos + axis * ${mult}`;
    ok(frag.includes(`${anchor}, ${rad}, uAspect`),
      `lens-flare ghost at axis ${mult} with radius ${rad}`);
  }
  ok(frag.includes('vec2 g3 = sunPos + axis * 1.65;'),
    'third ghost anchor is derived from the corrected sun position');
  for (const tint of ['vec3(1.0, 0.72, 0.38)', 'vec3(0.42, 0.86, 1.0)',
    'vec3(1.0, 0.58, 0.78)', 'vec3(0.72, 0.92, 0.60)', 'vec3(1.0, 0.65, 0.35)']) {
    ok(frag.includes(tint), `flare ghost tint ${tint} is present`);
  }
  ok(/col \+= max\(flare, vec3\(0\.0\)\) \* \(uSunFlare \* 0\.85\);/.test(frag),
    'flare is added gently, scaled by uSunFlare');
  const flareIdx = frag.indexOf('col += max(flare, vec3(0.0))');
  const vigIdx = frag.indexOf('float vig = 1.0 - smoothstep(0.38, 1.58, r2)');
  ok(flareIdx > 0 && vigIdx > flareIdx,
    'flare is composited before the vignette/clamp', `${flareIdx} vs ${vigIdx}`);

  // Standalone GLSL: no three.js chunk system, no second pass needed.
  ok(!/#include/.test(frag) && !/#include/.test(vert),
    'shader is standalone GLSL (no chunk includes)');

  // Balanced braces / parens in both stages (catches a broken edit early).
  for (const [name, src] of [['vertex', vert], ['fragment', frag]]) {
    const open = (src.match(/\{/g) || []).length;
    const close = (src.match(/\}/g) || []).length;
    ok(open === close && open > 0, `${name} shader braces are balanced`, `${open} vs ${close}`);
    const pOpen = (src.match(/\(/g) || []).length;
    const pClose = (src.match(/\)/g) || []).length;
    ok(pOpen === pClose, `${name} shader parens are balanced`, `${pOpen} vs ${pClose}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Headless PostFXSystem — construction, chainability, optic targets
// ---------------------------------------------------------------------------
{
  const fx = new PostFXSystem(null, null, null, { enabled: true });
  ok(fx.supported === false && fx.enabled === false,
    'PostFX still disables itself without a renderer');
  ok(fx.opticsPass === null && fx.fxaaPass === null,
    'no optics pass is built headlessly');
  ok(fx.optics && fx.optics.distortion === 0 && fx.optics.blur === 0 &&
    fx.optics.chroma === 0 && fx.optics.vignette === 0 &&
    fx.optics.grain === 0 && fx.optics.canopyGlint === 0,
    'optics state starts at zero (menu frame is untouched)');

  ok(fx.setOptics() === fx, 'setOptics() is chainable and argument-safe');
  ok(fx.setOptics({ cockpitView: true }) === fx, 'setOptics({...}) is chainable');

  // -- 90% internal render: default, option override, clamped live setter.
  ok(fx.renderScale === 0.90,
    'renderScale defaults to 0.90 (90% linear = ~81% of the fragment pixels)',
    `got ${fx.renderScale}`);
  ok(new PostFXSystem(null, null, null, { renderScale: 0.65 }).renderScale === 0.65,
    'constructor accepts a renderScale override');
  ok(fx.setRenderScale(0.1) === fx && fx.renderScale === 0.5,
    'setRenderScale clamps up to the 0.5 floor', `got ${fx.renderScale}`);
  ok(fx.setRenderScale(9) === fx && fx.renderScale === 1.0,
    'setRenderScale clamps down to the 1.0 ceiling', `got ${fx.renderScale}`);
  ok(fx.setRenderScale(0.90).renderScale === 0.90,
    'setRenderScale accepts a value inside the window');
  ok(fx.setRenderScale(NaN).renderScale === 0.90,
    'setRenderScale ignores junk input and keeps the current scale');
  ok(fx.setRenderScale().renderScale === 0.90,
    'setRenderScale is argument-safe and chainable');

  const settle = (system, n = 4) => {
    for (let i = 0; i < n; i++) system.update(1);
    return system.optics;
  };

  // -- GoPro lens/FOV pairing: a real fisheye warp on wider glass. The wider
  //    camera lens cancels the barrel zoom at the centre, so the jet and HUD
  //    keep their exact comfortable scale while the outer frame wraps to the
  //    full 84 deg (cockpit) / 66 deg (external) fisheye angle.
  ok(CONFIG.camera.cockpitFov === 84, 'cockpit lens is an 84 deg fisheye',
    `got ${CONFIG.camera.cockpitFov}`);
  ok(CONFIG.camera.externalFov === 66, 'external lens is a 66 deg fisheye',
    `got ${CONFIG.camera.externalFov}`);

  // -- Corner-safety proof for the barrel warp (zero border-clamp smear).
  //    zoom = 1 / (1 + k*2.05 + chroma*2.5) * (1 - 2*chroma). At the corner
  //    p = (1, 1), r2 = 2.0, each axis of dUv lands at 0.5 + 0.5*zoom*(1 + k*2)
  //    and the CA split adds p * r2 * chroma = 2*chroma in UV units, so the
  //    worst-case reach must stay below (0.5 - EDGE_UV) = 0.499.
  for (const [k, label] of [[0.21, 'cockpit'], [0.25, 'external']]) {
    const chroma = 0.0045;               // hard cap in setOptics()
    const zoom = (1 / (1 + k * 2.05 + chroma * 2.5)) * (1 - 2 * chroma);
    const corner = 0.5 * zoom * (1 + k * 2.0);
    const caOff = 2 * chroma;
    ok(corner + caOff < 0.5 - 0.001,
      `${label} warp + CA stays inside the [0.001, 0.999] safe frame`,
      `reach ${(corner + caOff).toFixed(4)} of 0.499`);
    ok(corner - caOff > 0 && corner < 0.5 - 0.001,
      `${label} centre tap never reaches the border clamp`,
      `axis uv ${(0.5 + corner).toFixed(4)}`);
  }

  // -- Cockpit helmet cam (day, slow, level).
  fx.setOptics({
    cockpitView: true, speedNorm: 0, gLoad: 1,
    afterburner: false, machPulse: 0, aglNorm: 0, freeCam: false, night: 0,
  });
  let o = settle(fx);
  ok(near(o.distortion, 0.21), 'cockpit GoPro fisheye distortion is 0.21', `got ${o.distortion}`);
  ok(near(o.softness, 0.04), 'cockpit filmic softness is 0.04', `got ${o.softness}`);
  ok(near(o.chroma, 0.0015), 'cockpit CA baseline is 0.0015', `got ${o.chroma}`);
  ok(near(o.blur, 0.0016), 'cockpit peripheral bokeh baseline is 0.0016', `got ${o.blur}`);
  ok(near(o.vignette, 0.26), 'cockpit vignette is 0.26', `got ${o.vignette}`);
  ok(near(o.grain, 0.042), 'cockpit daytime grain is ASA 200 0.042', `got ${o.grain}`);
  ok(near(o.canopyGlint, 0.065), 'cockpit daytime canopy sheen is 0.065', `got ${o.canopyGlint}`);

  // -- Cockpit at night: sheen off, ASA 200 pushed up in low light.
  fx.setOptics({ cockpitView: true, night: 1, gLoad: 1 });
  o = settle(fx);
  ok(o.canopyGlint < 1e-3, 'canopy sheen is disabled at night', `got ${o.canopyGlint}`);
  ok(near(o.grain, 0.062), 'cockpit night grain is pushed to 0.062', `got ${o.grain}`);

  // -- External chase view: full GoPro fisheye on the wider 66 deg lens.
  fx.setOptics({
    cockpitView: false, speedNorm: 0, gLoad: 1,
    afterburner: false, machPulse: 0, aglNorm: 0, freeCam: false, night: 0,
  });
  o = settle(fx);
  ok(near(o.distortion, 0.25), 'external GoPro fisheye distortion is 0.25', `got ${o.distortion}`);
  ok(near(o.softness, 0.05), 'external filmic softness is 0.05', `got ${o.softness}`);
  ok(near(o.chroma, 0.0013), 'external CA baseline is 0.0013', `got ${o.chroma}`);
  ok(near(o.blur, 0.0015), 'external bokeh baseline is 0.0015', `got ${o.blur}`);
  ok(near(o.vignette, 0.22), 'external vignette is 0.22', `got ${o.vignette}`);
  ok(o.canopyGlint < 1e-3, 'external views have no canopy sheen', `got ${o.canopyGlint}`);
  ok(near(o.grain, 0.042), 'external daytime grain is ASA 200 0.042', `got ${o.grain}`);

  // External at night pushes the same ASA 200 stock one stop.
  fx.setOptics({
    cockpitView: false, speedNorm: 0, gLoad: 1, freeCam: false, night: 1,
  });
  o = settle(fx);
  ok(near(o.grain, 0.062), 'external night grain is 0.062', `got ${o.grain}`);

  // -- High-G + Mach 1 + afterburner surge (cockpit).
  fx.setOptics({
    cockpitView: true, speedNorm: 1.2, gLoad: 9, afterburner: true,
    machPulse: 1, aglNorm: 1, freeCam: false, night: 0,
  });
  o = settle(fx);
  // Tasteful caps: the surge lifts CA/blur above baseline but the clamp keeps
  // the corner split at 2–3 px — never the old 17 px rainbow ghosting.
  ok(o.chroma > 0.0040, 'high-G + Mach surge lifts CA above 0.0040', `got ${o.chroma}`);
  ok(o.chroma <= 0.0045 + 1e-6, 'CA stays capped at 0.0045 (no rainbow streaks)', `got ${o.chroma}`);
  ok(o.blur > 0.0040, 'high-G + Mach surge drives peripheral blur up', `got ${o.blur}`);
  ok(o.blur <= 0.0046 + 1e-6, 'peripheral bokeh stays capped at 0.0046', `got ${o.blur}`);
  ok(near(o.distortion, 0.21, 1e-6), 'G load never changes the lens focal length', `got ${o.distortion}`);

  // External surge is tamer than the cockpit one.
  fx.setOptics({
    cockpitView: false, speedNorm: 1.2, gLoad: 9, afterburner: true,
    machPulse: 1, aglNorm: 1, freeCam: false, night: 0,
  });
  const extSurge = settle(fx).chroma;
  fx.setOptics({
    cockpitView: true, speedNorm: 1.2, gLoad: 9, afterburner: true,
    machPulse: 1, aglNorm: 1, freeCam: false, night: 0,
  });
  const pitSurge = settle(fx).chroma;
  ok(extSurge < pitSurge, 'external CA surge stays tamer than cockpit', `${extSurge} vs ${pitSurge}`);

  // -- Free Cam: clean rectilinear inspection, zero distortion and zero blur.
  fx.setOptics({
    cockpitView: true, speedNorm: 1.2, gLoad: 9, afterburner: true,
    machPulse: 1, aglNorm: 1, freeCam: true, night: 0,
    sunFlare: 0.9, sunScreenX: 0.2, sunScreenY: 0.7,
  });
  ok(fx._optDistortion === 0 && fx._optBlur === 0 && fx._optSoftness === 0,
    'Free Cam targets zero distortion, zero blur and zero softness');
  ok(fx._optSunFlare === 0, 'Free Cam forces the sun flare off');
  o = settle(fx, 8);
  ok(o.distortion < 1e-3, 'Free Cam decays distortion to ~0', `got ${o.distortion}`);
  ok(o.blur < 1e-3, 'Free Cam decays blur to ~0', `got ${o.blur}`);
  ok(o.softness < 1e-3, 'Free Cam decays softness to ~0', `got ${o.softness}`);
  ok(o.sunFlare < 1e-3, 'Free Cam decays the sun flare to ~0', `got ${o.sunFlare}`);
  ok(near(o.chroma, 0.0003, 1e-4), 'Free Cam keeps only 0.0003 CA', `got ${o.chroma}`);
  ok(near(o.vignette, 0.06, 1e-2), 'Free Cam vignette is 0.06', `got ${o.vignette}`);
  ok(near(o.grain, 0.022), 'Free Cam daytime grain is the lighter ASA 200 0.022', `got ${o.grain}`);
  ok(o.canopyGlint < 1e-3, 'Free Cam has no canopy sheen', `got ${o.canopyGlint}`);

  // Free Cam at night keeps the same inspection grain, pushed one stop.
  fx.setOptics({ freeCam: true, night: 1 });
  ok(near(fx._optGrain, 0.036), 'Free Cam night grain target is 0.036', `got ${fx._optGrain}`);
  o = settle(fx, 8);
  ok(near(o.grain, 0.036), 'Free Cam night grain eases to 0.036', `got ${o.grain}`);

  // -- Night: same geometry, but the sun is below the horizon so no flare.
  fx.setOptics({
    cockpitView: false, speedNorm: 0, gLoad: 1, freeCam: false, menu: false,
    night: 1, sunFlare: 0, sunScreenX: 0.5, sunScreenY: 0.5,
  });
  o = settle(fx);
  ok(o.sunFlare === 0, 'night keeps sunFlare at exactly 0', `got ${o.sunFlare}`);
  ok(near(o.distortion, 0.25), 'night keeps the external GoPro fisheye barrel', `got ${o.distortion}`);

  // From a clean slate Free Cam is exactly zero, not merely small.
  const clean = new PostFXSystem(null, null, null, {});
  clean.setOptics({ freeCam: true, cockpitView: true, speedNorm: 1.2, gLoad: 6 });
  for (let i = 0; i < 3; i++) clean.update(1);
  ok(clean.optics.distortion === 0 && clean.optics.blur === 0,
    'Free Cam starts and stays at exactly zero distortion/blur');

  // -- Menu: pristine, no lens at all.
  clean.setOptics({ menu: true });
  ok(clean._optGrain === 0, 'menu keeps the ASA 200 grain target at exactly 0',
    `got ${clean._optGrain}`);
  for (let i = 0; i < 3; i++) clean.update(1);
  ok(clean.optics.distortion < 1e-6 && clean.optics.blur < 1e-6 &&
    clean.optics.vignette < 1e-6 && clean.optics.grain < 1e-6 &&
    clean.optics.softness < 1e-6 && clean.optics.sunFlare < 1e-6,
    'menu keeps a pristine frame (no lens, no vignette, no grain, no flare)');

  // -- Easing: smooth, monotone, never overshoots.
  const ease = new PostFXSystem(null, null, null, {});
  ease.setOptics({ cockpitView: true, gLoad: 1, night: 0 });
  let prev = ease.optics.distortion;
  let monotone = true;
  let overshoot = false;
  for (let i = 0; i < 40; i++) {
    ease.update(1 / 60);
    const v = ease.optics.distortion;
    if (v < prev - 1e-12) monotone = false;
    if (v > 0.21 + 1e-9) overshoot = true;
    prev = v;
  }
  ok(monotone, 'distortion eases monotonically toward its target');
  ok(!overshoot, 'distortion never overshoots the cockpit target');
  ok(prev > 0.17, 'distortion is essentially settled after 40 frames', `got ${prev}`);
  ok(near(ease._opticsTime, 40 / 60, 1e-9), 'update() advances the optics clock',
    `got ${ease._opticsTime}`);

  // -- Sun flare target is clamped 0..1 and eased in.
  const flareFx = new PostFXSystem(null, null, null, {});
  flareFx.setOptics({ cockpitView: false, sunFlare: 4, sunScreenX: 0.31, sunScreenY: 0.22 });
  ok(flareFx._optSunFlare === 1, 'sunFlare is clamped to 1', `got ${flareFx._optSunFlare}`);
  for (let i = 0; i < 30; i++) flareFx.update(1 / 60);
  ok(flareFx.optics.sunFlare > 0.9 && flareFx.optics.sunFlare <= 1 + 1e-9,
    'sunFlare eases smoothly up to its target', `got ${flareFx.optics.sunFlare}`);
  flareFx.setOptics({ cockpitView: false, sunFlare: -3 });
  ok(flareFx._optSunFlare === 0, 'negative sunFlare clamps to 0', `got ${flareFx._optSunFlare}`);

  // -- Defensive inputs never throw and never produce NaN.
  ease.setOptics({ cockpitView: true, speedNorm: NaN, gLoad: NaN, machPulse: NaN, aglNorm: NaN, night: 'x' });
  ease.update(NaN);
  ease.update(-1);
  ok(Number.isFinite(ease.optics.chroma) && Number.isFinite(ease.optics.blur),
    'junk optics input leaves finite values');
  ok(ease.resize(1920, 1080, 2) === ease, 'resize stays safe headlessly');
  ok(ease.dispose() === ease, 'dispose stays safe headlessly');
}

// ---------------------------------------------------------------------------
// 3. Built composer (stub GL renderer) — PERF-04 wiring on live objects
// ---------------------------------------------------------------------------
{
  // A renderer whose getContext() reports a live GL context is all _build()
  // needs; nothing below actually draws, so no WebGL implementation is needed.
  const hadDocument = 'document' in globalThis;
  const prevDocument = globalThis.document;
  if (!hadDocument) globalThis.document = { createElementNS: () => ({ getContext: () => null }) };

  const stub = {
    getContext: () => ({}),
    getPixelRatio: () => 1,
    getSize: (v) => { v.set(1280, 720); return v; },
    capabilities: { isWebGL2: true, maxSamples: 4 },
    render() {},
  };

  const fx = new PostFXSystem(stub, { name: 'scene' }, { name: 'camera' }, {});
  ok(fx.supported === true && fx.enabled === true, 'composer builds against a GL-capable renderer');
  ok(fx.composer && fx.composer.passes.length === 4,
    'composer still has exactly four passes (scene, bloom, output, fxaa+optics)',
    `got ${fx.composer && fx.composer.passes.length}`);
  ok(fx.opticsPass === fx.fxaaPass, 'opticsPass is an alias of the single fxaaPass');
  ok(fx.composer.passes[3] === fx.opticsPass, 'the optics pass is the final fullscreen pass');
  ok(fx.opticsPass.material.uniforms.uDistortion, 'optics material carries uDistortion');
  ok(fx.opticsPass.material.uniforms.resolution.value instanceof THREE.Vector2,
    'optics material carries the stock resolution uniform');

  // PERF-04: one MSAA scene target + one non-MSAA post target, nothing else.
  ok(fx.sceneTarget && fx.postTarget, 'both HDR targets exist');
  ok(fx.sceneTarget.samples === 4, 'scene target keeps 4x MSAA', `got ${fx.sceneTarget.samples}`);
  ok(fx.postTarget.samples === 0, 'post target is not multisampled', `got ${fx.postTarget.samples}`);
  ok(fx.postTarget.depthBuffer === false, 'post target carries no depth buffer');
  ok(fx.renderTarget === fx.sceneTarget, 'renderTarget alias still points at the scene target');
  ok(fx.composer.renderTarget1 !== fx.composer.renderTarget2,
    'composer still has exactly two distinct buffers');
  ok(fx.composer.renderTarget2 === fx.sceneTarget,
    'the preallocated scene target replaces the composer clone');
  ok(fx.composer.readBuffer === fx.sceneTarget && fx.composer.writeBuffer === fx.postTarget,
    'buffers are wired scene -> post');

  // VIPER-OPTICS 90% internal render: both HDR buffers are sized at
  // CSS * dpr * renderScale (0.90 linear), and the final optics pass — which
  // still writes the full-resolution canvas — bilinearly upscales them.
  const inW = Math.round(1280 * 0.90); // 1152
  const inH = Math.round(720 * 0.90);  // 648
  ok(fx.renderScale === 0.90, 'the built composer runs at renderScale 0.90',
    `got ${fx.renderScale}`);
  ok(fx.sceneTarget.width === inW && fx.sceneTarget.height === inH,
    `scene target is rasterised at 90% (${inW}x${inH})`,
    `got ${fx.sceneTarget.width}x${fx.sceneTarget.height}`);
  ok(fx.postTarget.width === inW && fx.postTarget.height === inH,
    `post target is rasterised at 90% (${inW}x${inH})`,
    `got ${fx.postTarget.width}x${fx.postTarget.height}`);
  ok(Math.abs((inW * inH) / (1280 * 720) - 0.81) < 0.01,
    'the internal buffer is ~81% of the native fragment count',
    `${inW * inH} vs ${1280 * 720}`);
  for (const [name, target] of [['sceneTarget', fx.sceneTarget], ['postTarget', fx.postTarget]]) {
    ok(target.texture.minFilter === THREE.LinearFilter &&
      target.texture.magFilter === THREE.LinearFilter,
      `${name} filters linearly so the final pass hardware-upscales smoothly`,
      `min=${target.texture.minFilter} mag=${target.texture.magFilter}`);
  }

  // Resolution plumbing survives the shader swap, and it tracks the 90%
  // buffer's real texel size so FXAA's diagonal taps hit exact neighbours.
  const res = fx.opticsPass.material.uniforms.resolution.value;
  ok(near(res.x, 1 / inW, 1e-12) && near(res.y, 1 / inH, 1e-12),
    'resolution is one texel of the 90% buffer (1152x648 at DPR 1)',
    `got ${res.x}, ${res.y}`);
  ok(near(fx.opticsPass.material.uniforms.uAspect.value, 1280 / 720, 1e-12),
    'uAspect stays the CSS frame ratio (16:9), not the scaled buffer ratio',
    `got ${fx.opticsPass.material.uniforms.uAspect.value}`);

  fx.resize(1920, 1080, 2);
  const rsW = Math.round(1920 * 2 * 0.90); // 3456
  const rsH = Math.round(1080 * 2 * 0.90); // 1944
  ok(near(res.x, 1 / rsW, 1e-12) && near(res.y, 1 / rsH, 1e-12),
    'resize keeps `resolution` on the dpr * 0.90 buffer',
    `got ${res.x}, ${res.y}`);
  ok(fx.sceneTarget.width === rsW && fx.sceneTarget.height === rsH &&
    fx.postTarget.width === rsW && fx.postTarget.height === rsH,
    'resize re-sizes both HDR targets to dpr * 0.90',
    `got ${fx.sceneTarget.width}x${fx.sceneTarget.height} / ${fx.postTarget.width}x${fx.postTarget.height}`);
  ok(near(fx.opticsPass.material.uniforms.uAspect.value, 1920 / 1080, 1e-9),
    'resize keeps uAspect on the CSS frame ratio',
    `got ${fx.opticsPass.material.uniforms.uAspect.value}`);

  // Live render-scale changes re-size the composer without a reload.
  fx.setRenderScale(1.0);
  ok(fx.sceneTarget.width === 3840 && fx.postTarget.width === 3840 &&
    near(res.x, 1 / 3840, 1e-12),
    'setRenderScale(1.0) restores a native-resolution internal buffer',
    `got ${fx.sceneTarget.width}, res ${res.x}`);
  fx.setRenderScale(0.5);
  ok(fx.sceneTarget.width === 1920 && near(res.x, 1 / 1920, 1e-12),
    'setRenderScale(0.5) halves the internal buffer',
    `got ${fx.sceneTarget.width}, res ${res.x}`);
  fx.setRenderScale(0.90);
  ok(fx.sceneTarget.width === rsW && fx.postTarget.width === rsW &&
    near(res.x, 1 / rsW, 1e-12),
    'setRenderScale(0.90) returns to the internal flight size',
    `got ${fx.sceneTarget.width}, res ${res.x}`);

  // Uniform upload: the eased state reaches the GPU-side uniforms.
  fx.setOptics({
    cockpitView: true, speedNorm: 0.5, gLoad: 1,
    afterburner: false, machPulse: 0, aglNorm: 0, freeCam: false, night: 0,
  });
  for (let i = 0; i < 4; i++) fx.update(1);
  const u = fx.opticsPass.material.uniforms;
  for (const key of ['uDistortion', 'uChroma', 'uBlur', 'uVignette', 'uGrain',
    'uCanopyGlint', 'uSoftness', 'uSunFlare']) {
    const prop = key[1].toLowerCase() + key.slice(2);
    ok(near(u[key].value, fx.optics[prop], 1e-9),
      `${key} is uploaded from the live optics state`,
      `${u[key].value} vs ${fx.optics[prop]}`);
  }
  ok(u.uTime.value > 3, 'uTime is uploaded and advancing', `got ${u.uTime.value}`);

  // Sun flare handoff: the screen position is immediate (locked to the disc),
  // the visibility eases, and the sun colour is copied through.
  const sunCol = new THREE.Color(0xffe2b0);
  fx.setOptics({
    cockpitView: false, sunScreenX: 0.31, sunScreenY: 0.74, sunFlare: 0.8, sunColor: sunCol,
  });
  ok(near(u.uSunScreen.value.x, 0.31, 1e-12) && near(u.uSunScreen.value.y, 0.74, 1e-12),
    'uSunScreen is uploaded immediately (no lag)',
    `got ${u.uSunScreen.value.x}, ${u.uSunScreen.value.y}`);
  ok(near(u.uSunColor.value.getHex(), 0xffe2b0),
    'uSunColor is uploaded from sky.sunColor', `got ${u.uSunColor.value.getHex().toString(16)}`);
  ok(fx._optSunFlare === 0.8, 'sunFlare target is taken from the frame');
  fx.update(1 / 60);
  ok(u.uSunFlare.value > 0 && u.uSunFlare.value < 0.8,
    'sunFlare eases toward its target instead of snapping',
    `got ${u.uSunFlare.value}`);
  // Off-screen sun keeps a screen position outside [0..1].
  fx.setOptics({ cockpitView: false, sunScreenX: 1.42, sunScreenY: -0.3, sunFlare: 0.5 });
  ok(u.uSunScreen.value.x > 1 && u.uSunScreen.value.y < 0,
    'an off-frame sun still projects outside [0..1]',
    `got ${u.uSunScreen.value.x}, ${u.uSunScreen.value.y}`);

  // Free Cam uploads exactly zero distortion/blur.
  fx.setOptics({ freeCam: true, cockpitView: true, speedNorm: 0.5, gLoad: 6 });
  for (let i = 0; i < 12; i++) fx.update(1);
  ok(u.uDistortion.value < 1e-3 && u.uBlur.value < 1e-3,
    'Free Cam uploads ~zero distortion and blur',
    `${u.uDistortion.value}, ${u.uBlur.value}`);

  fx.dispose();
  ok(fx.composer === null && fx.opticsPass === null && fx.fxaaPass === null,
    'dispose tears the optics pass down with the composer');

  if (!hadDocument) {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
}

// ---------------------------------------------------------------------------
// 4. Source contracts: single pass, two targets, main.js wiring
// ---------------------------------------------------------------------------
{
  const postfx = read('../src/sim/postfx.js');

  ok((postfx.match(/new THREE\.WebGLRenderTarget\(/g) || []).length === 2,
    'postfx allocates exactly two render targets (PERF-04)',
    `got ${(postfx.match(/new THREE\.WebGLRenderTarget\(/g) || []).length}`);
  ok((postfx.match(/new ShaderPass\(/g) || []).length === 1,
    'postfx builds exactly one fullscreen ShaderPass',
    `got ${(postfx.match(/new ShaderPass\(/g) || []).length}`);
  ok(/new ShaderPass\(CinemaOpticsFXAAShader\)/.test(postfx),
    'the FXAA pass is built from CinemaOpticsFXAAShader');
  ok(!/new ShaderPass\(FXAAShader\)/.test(postfx),
    'the stock FXAAShader pass is gone');
  ok(!/jsm\/shaders\/FXAAShader\.js/.test(postfx),
    'the stock FXAAShader module is no longer imported');
  ok((postfx.match(/this\.composer\.addPass\(/g) || []).length === 4,
    'the composer still receives exactly four passes',
    `got ${(postfx.match(/this\.composer\.addPass\(/g) || []).length}`);
  ok(/this\.opticsPass = this\.fxaaPass;/.test(postfx),
    'opticsPass aliases fxaaPass (no second swap / render target)');
  ok(/this\.renderTarget = this\.sceneTarget;/.test(postfx),
    'renderTarget stays an alias of the MSAA scene target');
  ok(/uSunScreen: \{ value: new THREE\.Vector2\(0\.5, 0\.5\) \}/.test(postfx),
    'uSunScreen is initialised at screen centre');
  ok(/uSoftness: \{ value: 0\.0 \}/.test(postfx) && /uAspect: \{ value: 16 \/ 9 \}/.test(postfx),
    'uSoftness and uAspect are declared with defaults');
  ok(/const aspect = width > 0 && height > 0 \? width \/ height : w \/ h;/.test(postfx) &&
    /uniforms\.uAspect\.value = aspect;/.test(postfx),
    '_updateFxaaResolution keeps uAspect on the CSS frame ratio');

  // 90% internal render + full-resolution hardware bilinear upscale.
  ok(/const INTERNAL_RENDER_SCALE = 0\.90;/.test(postfx),
    'INTERNAL_RENDER_SCALE is pinned at 0.90');
  ok(/this\.renderScale = clamp\(/.test(postfx) &&
    /options\.renderScale !== undefined \? options\.renderScale : INTERNAL_RENDER_SCALE/.test(postfx),
    'PostFXSystem defaults renderScale to INTERNAL_RENDER_SCALE and honours an option');
  ok(/setRenderScale\(scale\) \{/.test(postfx) &&
    /this\.renderScale = clamp\(raw, RENDER_SCALE_MIN, RENDER_SCALE_MAX\);/.test(postfx),
    'setRenderScale() clamps into [0.5, 1.0]');
  ok(/Math\.round\(size\.x \* dpr \* this\.renderScale\)/.test(postfx) &&
    /Math\.round\(w \* scaled\)/.test(postfx),
    'build and resize both size the targets at dpr * renderScale');
  ok(/this\.composer\.setPixelRatio\(dpr \* this\.renderScale\);/.test(postfx) &&
    /this\.composer\.setPixelRatio\(scaled\);/.test(postfx),
    'the composer pixel ratio follows dpr * renderScale in build and resize');
  ok(/tex\.minFilter = THREE\.LinearFilter;/.test(postfx) &&
    /tex\.magFilter = THREE\.LinearFilter;/.test(postfx),
    'both HDR textures use LinearFilter so the final pass upscales bilinearly');
  ok(/_updateFxaaResolution\(size\.x, size\.y, dpr \* this\.renderScale\);/.test(postfx) &&
    /_updateFxaaResolution\(w, h, scaled\);/.test(postfx),
    'FXAA resolution is synced to the 90% buffer in build and resize');
  ok(/samples: this\.samples/.test(postfx) && /samples: 0,/.test(postfx),
    'PERF-04 sample split (MSAA scene / plain post) is intact');
  ok(DAY_THRESHOLD === 1.05 && NIGHT_THRESHOLD === 0.94 &&
    DAY_STRENGTH === 0.14 && NIGHT_STRENGTH === 0.19,
    'bloom contract constants are unchanged');

  const main = read('../src/main.js');
  ok(/this\._opticsScratch = \{/.test(main), 'main.js preallocates _opticsScratch once');
  for (const key of ['cockpitView', 'speedNorm', 'gLoad', 'afterburner', 'machPulse',
    'aglNorm', 'freeCam', 'night', 'sunScreenX', 'sunScreenY', 'sunFlare', 'sunColor']) {
    ok(new RegExp(`\\n\\s*${key}:`).test(main), `_opticsScratch carries ${key}`);
  }
  ok(/this\.postfx\.setOptics\(this\._opticsScratch\)/.test(main),
    'the loop feeds the lens from the shared scratch object');
  // Sun projection into screen space for the analytical flare.
  ok(/const _sunProj = new THREE\.Vector3\(\);/.test(main) &&
    /const _camFwd = new THREE\.Vector3\(\);/.test(main),
    'main.js preallocates _sunProj/_camFwd scratch vectors');
  ok(/_sunProj\.set\(e\[12\], e\[13\], e\[14\]\)\.addScaledVector\(sun, 10000\)\.project\(cam\);/.test(main) &&
    /cam\.updateWorldMatrix\(true, false\);/.test(main),
    'sky.sunDir is projected through the live camera pose');
  ok(/cam\.getWorldDirection\(_camFwd\);/.test(main) && /_camFwd\.dot\(sun\)/.test(main),
    'camera forward is used to gate the flare');
  ok(/opt\.sunScreenX = ndcX \* 0\.5 \+ 0\.5;/.test(main) &&
    /opt\.sunScreenY = ndcY \* 0\.5 \+ 0\.5;/.test(main),
    'NDC is converted to screen UV for the shader');
  ok(/opt\.sunColor = this\.sky\.sunColor;/.test(main), 'the sun colour rides the scratch object');
  ok(/smoothstep\(0\.12, 0\.55, sunFacing\)/.test(main) &&
    /smoothstep\(-0\.02, 0\.18, sunElev\)/.test(main) &&
    /\(1 - overcast \* 0\.85\)/.test(main) &&
    /Math\.hypot\(ndcX, ndcY\) \* 0\.55/.test(main),
    'sunFlare fades with facing, elevation, overcast and frame edge');
  ok(/this\.aircraft\.mode === 'cockpit' && this\.mode === 'fly'/.test(main),
    'cockpit optics only engage in a live cockpit flight');
  ok(/clamp\(speed \/ 350, 0, 1\.4\)/.test(main), 'speed is normalised to 350 m/s');
  ok(/Number\.isFinite\(fl\.gForce\) \? fl\.gForce : 1/.test(main),
    'G force drives the lens');
  ok(/this\._juiceState\?\.machPulse \|\| 0/.test(main), 'Mach pulse feeds the lens');
  ok(/1 - smoothstep\(15, 220, agl\)/.test(main),
    'low altitude ramps the ground-rush blur');
  ok(/this\.freeCam && this\.freeCam\.active/.test(main), 'Free Cam is detected for the lens');
  ok(/import \{ clamp, smoothstep \} from '\.\/world\/noise\.js'/.test(main),
    'main.js imports smoothstep for the AGL ramp');

  // The sun handoff must land before the flight model integrates.
  const sunIdx = main.indexOf('this.weather.sunDir = this.sky.sunDir;');
  const sunColIdx = main.indexOf('this.weather.sunColor = this.sky.sunColor;');
  const acIdx = main.indexOf('this.aircraft.update(simDt, cmd, this.weather, this.input, true, alerts);');
  ok(sunIdx > 0 && sunColIdx > sunIdx && acIdx > sunColIdx,
    'weather.sunDir/sunColor sync happens before aircraft.update()',
    `sunDir=${sunIdx} sunColor=${sunColIdx} update=${acIdx}`);
  ok(/this\.weather\.night = this\.sky\.night;/.test(main),
    'weather.night sync is preserved');
}

// ---------------------------------------------------------------------------
// 5. The existing cinematic suite is untouched and still green (294/294)
// ---------------------------------------------------------------------------
{
  let out = '';
  let threw = null;
  try {
    out = execFileSync(process.execPath,
      [fileURLToPath(new URL('./cinematic_juice_test.mjs', import.meta.url))],
      { encoding: 'utf8' });
  } catch (err) {
    threw = err;
    out = (err && err.stdout) || '';
  }
  const m = out.match(/cinematic juice checks: (\d+), failures: (\d+)/);
  ok(threw === null, 'cinematic_juice_test.mjs exits clean',
    threw ? String(threw.message) : '');
  ok(m && Number(m[2]) === 0, 'cinematic_juice_test.mjs reports 0 failures',
    m ? `failures=${m[2]}` : 'no summary line');
  ok(m && Number(m[1]) >= 294, 'cinematic_juice_test.mjs still runs 294+ checks',
    m ? `checks=${m[1]}` : 'no summary line');
}

console.log(`viper optics checks: ${checks}, failures: ${failures.length}`);
for (const f of failures) console.log('  FAIL ' + f);
if (failures.length) process.exitCode = 1;
else console.log('ALL VIPER-OPTICS CHECKS PASSED');