// Feature 32 — selective cinematic bloom. Feature 35 tamed it for the
// photoreal Vipava pass.
//
// Three.js's built-in EffectComposer chain: RenderPass -> UnrealBloomPass ->
// OutputPass -> FXAA, rendered into an explicit 4x WebGL2 multisampled HDR
// target so hardware MSAA is not silently disabled by the composer's default
// `samples: 0` buffer. FXAA sits after OutputPass, i.e. it filters tonemapped
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
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

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

const _nightLevel = (night) =>
  typeof night === 'number' ? clamp(night, 0, 1) : (night ? 1 : 0);

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export { DAY_THRESHOLD, NIGHT_THRESHOLD, DAY_STRENGTH, NIGHT_STRENGTH };

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
    // Dedicated HDR MSAA target + post-tonemap FXAA pass. Without an explicit
    // multisampled target, EffectComposer allocates `samples: 0` and WebGL2
    // hardware MSAA is silently off whenever PostFX is enabled, so distant
    // rooflines and facade edges flicker frame to frame.
    this.renderTarget = null;
    this.fxaaPass = null;
    this.samples = 0;

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
      const rtW = Math.max(1, Math.round(size.x * dpr));
      const rtH = Math.max(1, Math.round(size.y * dpr));
      const caps = this.renderer && this.renderer.capabilities;
      const isWebGL2 = !!(caps && caps.isWebGL2);
      const maxSamples = (caps && Number.isFinite(caps.maxSamples) && caps.maxSamples > 0)
        ? caps.maxSamples
        : 4;
      this.samples = isWebGL2 ? Math.min(4, maxSamples) : 0;
      this.renderTarget = new THREE.WebGLRenderTarget(rtW, rtH, {
        type: THREE.HalfFloatType,
        samples: this.samples,
      });

      this.composer = new EffectComposer(this.renderer, this.renderTarget);
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(size.x, size.y);

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
      // would dominate the edge blend.
      this.fxaaPass = new ShaderPass(FXAAShader);
      this._updateFxaaResolution(size.x, size.y, dpr);

      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(this.outputPass);
      this.composer.addPass(this.fxaaPass);

      this.supported = true;
      this._applyBloom();
    } catch (err) {
      // Any failure (no GL, stubbed renderer, odd canvas) is a passthrough.
      if (this.fxaaPass && this.fxaaPass.material &&
          typeof this.fxaaPass.material.dispose === 'function') {
        this.fxaaPass.material.dispose();
      }
      if (this.renderTarget && typeof this.renderTarget.dispose === 'function') {
        this.renderTarget.dispose();
      }
      this.composer = null;
      this.renderPass = null;
      this.bloomPass = null;
      this.outputPass = null;
      this.fxaaPass = null;
      this.renderTarget = null;
      this.samples = 0;
      this.supported = false;
      this.enabled = false;
      this.lastError = err;
    }
  }

  /** Keep FXAA's texel size in step with the drawing buffer (DPR included). */
  _updateFxaaResolution(width, height, dpr) {
    if (!this.fxaaPass || !this.fxaaPass.material?.uniforms?.resolution) return;
    const w = Math.max(1, width * dpr);
    const h = Math.max(1, height * dpr);
    this.fxaaPass.material.uniforms.resolution.value.set(1 / w, 1 / h);
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

  /** Decay the bloom pulse and ease day/night tuning. */
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
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this._updateFxaaResolution(w, h, ratio);
    if (this.bloomPass && typeof this.bloomPass.setSize === 'function') {
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
      if (typeof this.composer.dispose === 'function') this.composer.dispose();
    }
    if (this.fxaaPass && this.fxaaPass.material &&
        typeof this.fxaaPass.material.dispose === 'function') {
      this.fxaaPass.material.dispose();
    }
    if (this.renderTarget && typeof this.renderTarget.dispose === 'function') {
      this.renderTarget.dispose();
    }
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.outputPass = null;
    this.fxaaPass = null;
    this.renderTarget = null;
    this.samples = 0;
    this.enabled = false;
    return this;
  }
}