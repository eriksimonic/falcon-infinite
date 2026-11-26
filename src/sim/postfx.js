// Feature 32 — selective cinematic bloom.
//
// Three.js's built-in EffectComposer chain: RenderPass -> UnrealBloomPass ->
// OutputPass. The bloom threshold is deliberately high (0.88 by day, tapering
// to 0.72 at night) so the sunlit sky, clouds and terrain stay clean while the
// HDR/un-tonemapped emissives — afterburner Mach diamonds, BFFG plasma,
// fireball cores, city night windows, H4 traffic streaks, runway strobes and
// landmark beacons — flare properly.
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

// Day is conservative (blue sky sits under the threshold), night opens up so
// window/beacon/traffic emissives pop in the dark.
const DAY_THRESHOLD = 0.88;
const NIGHT_THRESHOLD = 0.72;
const DAY_STRENGTH = 0.36;
const NIGHT_STRENGTH = 0.58;
const BLOOM_RADIUS = 0.45;

const NIGHT_BLEND_RATE = 1.6; // blend units per second (smooth dusk/dawn)
const PULSE_DECAY = 0.6; // seconds for a detonation bloom spike to fade
const PULSE_FLOOR = 0.002;

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
   * @param {{enabled?: boolean, night?: boolean}} [options]
   */
  constructor(renderer, scene, camera, options = {}) {
    const { enabled = true, night = false } = options || {};

    this.renderer = renderer || null;
    this.scene = scene || null;
    this.camera = camera || null;

    this.nightBlend = night ? 1 : 0;
    this.threshold = night ? NIGHT_THRESHOLD : DAY_THRESHOLD;
    this.strength = night ? NIGHT_STRENGTH : DAY_STRENGTH;
    this.radius = BLOOM_RADIUS;

    // Temporary additive bloom spike (detonations, Mach 1.0 shockwave).
    this.bloomPulse = 0;

    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.outputPass = null;

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

      this.composer = new EffectComposer(this.renderer);
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

      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(this.outputPass);

      this.supported = true;
      this._applyBloom();
    } catch (err) {
      // Any failure (no GL, stubbed renderer, odd canvas) is a passthrough.
      this.composer = null;
      this.renderPass = null;
      this.bloomPass = null;
      this.outputPass = null;
      this.supported = false;
      this.enabled = false;
      this.lastError = err;
    }
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

  /** Smoothly move the threshold/strength between day and night presets. */
  setNight(night) {
    this.night = !!night;
    return this;
  }

  /** Temporary bloom spike (BFFG/Mk-82 detonation, Mach 1.0 shockwave). */
  pulseBloom(amount = 0.55) {
    const add = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    if (add > 0) this.bloomPulse = Math.min(2.5, Math.max(this.bloomPulse, add));
    return this;
  }

  /** Decay the bloom pulse and ease day/night tuning. */
  update(dt) {
    const h = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;

    const target = this.night ? 1 : 0;
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
    pass.strength = this.strength + this.bloomPulse;
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
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.outputPass = null;
    this.enabled = false;
    return this;
  }
}