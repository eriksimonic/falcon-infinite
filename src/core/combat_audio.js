// Hybrid combat audio layered on top of SimAudio's shared AudioContext.
//
// Preloads authentic F-16 & military weapon samples from /media/sfx/ into
// WebAudio AudioBuffers when running in a browser, and automatically falls
// back to the built-in procedural WebAudio synth while loading or in headless
// environments.
//
// Continuous cues:
//   - AIM-9 IR seeker growl (real sample or ~220 Hz synth) -> lock tone
//   - RWR search ping / lock triple-chirp / SAM launch warning
//   - Pilot G-strain breathing under sustained load
// One-shots: Vulcan cannon, missile launch, bomb release, flare pop,
// explosion (distance-filtered), sonic boom, tanker boom contact, radio beep.

const TAU = Math.PI * 2;

const SAMPLE_URLS = {
  vulcan: '/media/sfx/vulcan.wav',
  aim9_growl: '/media/sfx/aim9_growl.wav',
  missile_launch: '/media/sfx/missile_launch.wav',
  aim_launch_pop: '/media/sfx/aim_launch_pop.wav',
  bomb_release: '/media/sfx/bomb_release.wav',
  flare_pop: '/media/sfx/flare_pop.wav',
  explosion: '/media/sfx/explosion.wav',
  explosion_heavy: '/media/sfx/explosion_heavy.ogg',
  sonic_boom: '/media/sfx/sonic_boom.ogg',
  rwr_new: '/media/sfx/rwr_new.wav',
  rwr_sam_launch: '/media/sfx/rwr_sam_launch.wav',
  boom_contact: '/media/sfx/boom_contact.wav',
  caution: '/media/sfx/caution.wav',
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fin = (v, fb = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

export class CombatAudio {
  constructor() {
    this.ctx = null;
    this.dest = null;
    this.ready = false;

    this._bus = null;
    this._noiseBuf = null;
    this._noiseOff = 0;
    this._samples = new Map();
    this._samplesLoading = false;
    this._aim9SampleSrc = null;
    this._aim9SampleGain = null;
    this._rwrLaunchCd = 0;
    this._expToggle = 0;
    this._jitterSeed = 0x51a7c3;
    this._t = 0;
    this._bt = 0;
    this._pingCd = 0;
    this._lockCd = 0;
    this._warbleT = 0;
    this._warbleHi = false;
    this._rwrPrev = 'NONE';
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  attach(ctx, destNode) {
    if (!ctx || typeof ctx.createGain !== 'function') {
      this.ctx = null;
      this.dest = null;
      this.ready = false;
      return;
    }
    const dest = destNode && typeof destNode.connect === 'function'
      ? destNode
      : (ctx.destination && typeof ctx.destination.connect === 'function' ? ctx.destination : null);
    if (!dest) {
      this.ctx = null;
      this.dest = null;
      this.ready = false;
      return;
    }
    if (this.ready && this.ctx === ctx && this._bus) {
      this.dest = dest;
      return;
    }

    this.ctx = ctx;
    this.dest = dest;
    this._noiseOff = 0;
    try {
      this._build();
      this.ready = true;
      this._loadSamples();
    } catch (err) {
      this.ready = false;
      this._bus = null;
    }
  }

  _nextRand() {
    this._jitterSeed = (Math.imul(this._jitterSeed, 1664525) + 1013904223) >>> 0;
    return this._jitterSeed / 4294967296;
  }

  _loadSamples() {
    if (this._samplesLoading || !this.ctx) return;
    if (typeof window === 'undefined' || typeof fetch !== 'function') return;
    if (typeof this.ctx.decodeAudioData !== 'function') return;
    this._samplesLoading = true;

    const ctx = this.ctx;
    for (const [key, url] of Object.entries(SAMPLE_URLS)) {
      fetch(url)
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .then((ab) => (ab && this.ctx === ctx ? ctx.decodeAudioData(ab) : null))
        .then((decoded) => {
          if (!decoded || this.ctx !== ctx) return;
          this._samples.set(key, decoded);
          if (key === 'aim9_growl') this._initAim9SampleLoop(decoded);
        })
        .catch(() => { /* graceful fallback to procedural synth */ });
    }
  }

  _initAim9SampleLoop(buf) {
    if (!this._ready() || this._aim9SampleSrc || !buf) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this._gainNode(0);
      src.connect(g).connect(this._bus);
      this._start(src, this._now());
      this._aim9SampleSrc = src;
      this._aim9SampleGain = g;
    } catch (err) {
      this._aim9SampleSrc = null;
      this._aim9SampleGain = null;
    }
  }

  _playSample(key, opts = {}) {
    if (!this._ready()) return false;
    const buf = this._samples.get(key);
    if (!buf || typeof this.ctx.createBufferSource !== 'function') return false;
    try {
      const t0 = this._now();
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const jitter = clamp(fin(opts.jitter, 0.04), 0, 0.25);
      const baseRate = clamp(fin(opts.rate, 1), 0.4, 2.5);
      const rate = clamp(baseRate * (1 + (this._nextRand() * 2 - 1) * jitter), 0.4, 2.5);
      if (src.playbackRate) this._paramSet(src.playbackRate, rate, t0);

      const g = this._gainNode(clamp(fin(opts.gain, 0.7), 0.001, 1.2));
      const lpHz = fin(opts.lowpassHz, 0);
      if (lpHz > 40) {
        const lp = this._filter('lowpass', lpHz, 0.7);
        src.connect(lp).connect(g).connect(this._bus);
      } else {
        src.connect(g).connect(this._bus);
      }

      const off = Math.max(0, fin(opts.startOffset, 0));
      const dur = fin(opts.duration, 0);
      if (dur > 0.02) src.start(t0, off, dur);
      else src.start(t0, off);
      return true;
    } catch (err) {
      return false;
    }
  }

  _maxFreq() {
    const sr = fin(this.ctx && this.ctx.sampleRate, 48000);
    return clamp(sr * 0.45, 8000, 96000);
  }

  _makeNoise(seconds) {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.createBuffer !== 'function') return null;
    const sr = Math.round(clamp(fin(ctx.sampleRate, 48000), 8000, 192000));
    const len = Math.max(256, Math.floor(sr * clamp(fin(seconds, 1), 0.1, 4)));
    let buf;
    try {
      buf = ctx.createBuffer(1, len, sr);
    } catch (err) {
      return null;
    }
    if (!buf || typeof buf.getChannelData !== 'function') return null;
    let data;
    try {
      data = buf.getChannelData(0);
    } catch (err) {
      return null;
    }
    if (!data || typeof data.length !== 'number') return null;
    // Deterministic LCG noise (no Math.random dependency).
    let seed = 0x1f2e3d4c;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = ((seed / 4294967296) * 2 - 1) * 0.85;
    }
    return buf;
  }

  _build() {
    const ctx = this.ctx;
    const bus = ctx.createGain();
    this._paramSet(bus.gain, 0.9, 0);
    bus.connect(this.dest);
    this._bus = bus;

    this._noiseBuf = this._makeNoise(1.7);

    // ------------------------------------------------------- AIM-9 seeker
    this._seekerLP = this._filter('lowpass', 820, 2.4);
    this._seekerGain = this._gainNode(0);
    const seekerMix = this._gainNode(0.6);
    this._seekerOsc = this._osc('sawtooth', 220);
    this._seekerOsc2 = this._osc('square', 223.7);
    this._seekerOsc2Gain = this._gainNode(0.32);
    this._seekerOsc.connect(seekerMix);
    this._seekerOsc2.connect(this._seekerOsc2Gain).connect(seekerMix);
    seekerMix.connect(this._seekerLP).connect(this._seekerGain).connect(bus);

    this._seekerBP = this._filter('bandpass', 1500, 1.15);
    this._seekerNoiseGain = this._gainNode(0);
    this._seekerNoiseSrc = this._noiseSrc(true);
    if (this._seekerNoiseSrc) {
      this._seekerNoiseSrc.connect(this._seekerBP).connect(this._seekerNoiseGain).connect(bus);
      this._start(this._seekerNoiseSrc, 0);
    }

    this._lockLP = this._filter('lowpass', 3200, 0.9);
    this._lockGain = this._gainNode(0);
    this._lockOsc = this._osc('square', 880);
    this._lockOsc.connect(this._lockLP).connect(this._lockGain).connect(bus);

    // ------------------------------------------------------- RWR audio
    this._rwrGain = this._gainNode(0);
    this._rwrOsc = this._osc('square', 1200);
    this._rwrOsc.connect(this._rwrGain).connect(bus);

    // ------------------------------------------------------- G-strain breath
    this._breathLP = this._filter('lowpass', 400, 0.9);
    this._breathGain = this._gainNode(0);
    this._breathSrc = this._noiseSrc(true);
    if (this._breathSrc) {
      this._breathSrc.connect(this._breathLP).connect(this._breathGain).connect(bus);
      this._start(this._breathSrc, 0);
    }

    this._start(this._seekerOsc, 0);
    this._start(this._seekerOsc2, 0);
    this._start(this._lockOsc, 0);
    this._start(this._rwrOsc, 0);
  }

  // -------------------------------------------------------------------------
  // Continuous tactical cues
  // -------------------------------------------------------------------------
  update(dt, state) {
    if (!this.ready || !this.ctx) return;

    const step = clamp(fin(dt, 1 / 60), 0, 0.25);
    const s = state && typeof state === 'object' ? state : {};
    const now = this._now();
    const paused = !!s.paused;

    this._t += step;
    if (paused) {
      this._target(this._seekerGain.gain, 0, now, 0.06);
      this._target(this._seekerNoiseGain.gain, 0, now, 0.06);
      this._target(this._lockGain.gain, 0, now, 0.04);
      if (this._aim9SampleGain) this._target(this._aim9SampleGain.gain, 0, now, 0.06);
      this._target(this._rwrGain.gain, 0, now, 0.04);
      this._target(this._breathGain.gain, 0, now, 0.06);
      return;
    }

    const weapon = String(s.weapon || 'GUN').toUpperCase();
    const aim9 = weapon === 'AIM9';
    const hasLock = !!s.hasLock;
    const lockOn = aim9 && hasLock;
    const gStrain = clamp(fin(s.gStrain, 0), 0, 1);
    const rwr = this._normRwr(s.rwrHighest);

    // ------------------------------------------------------- Sidewinder
    if (this._aim9SampleGain && this._aim9SampleSrc) {
      // Real F-16 AIM-9 growl sample; pitch rises sharply on IR heat lock.
      this._target(this._aim9SampleGain.gain, aim9 ? (lockOn ? 0.22 : 0.14) : 0, now, 0.05);
      if (this._aim9SampleSrc.playbackRate) {
        this._target(this._aim9SampleSrc.playbackRate, lockOn ? 1.68 : 1.0, now, 0.05);
      }
      this._target(this._seekerGain.gain, 0, now, 0.05);
      this._target(this._seekerNoiseGain.gain, 0, now, 0.05);
      this._target(this._lockGain.gain, lockOn ? 0.032 : 0, now, 0.02);
    } else {
      this._freqTarget(this._seekerOsc.frequency, 220 * (1 + 0.004 * Math.sin(this._t * 7.3)), now, 0.06);
      this._freqTarget(this._seekerOsc2.frequency, 223.7 * (1 + 0.004 * Math.sin(this._t * 6.1 + 1.2)), now, 0.06);
      this._freqTarget(this._lockOsc.frequency, 880, now, 0.02);
      this._target(this._seekerGain.gain, lockOn ? 0.024 : (aim9 ? 0.10 : 0), now, 0.06);
      this._target(this._seekerNoiseGain.gain, aim9 && !lockOn ? 0.030 : 0, now, 0.06);
      this._target(this._lockGain.gain, lockOn ? 0.075 : 0, now, 0.02);
    }

    // ------------------------------------------------------- RWR
    this._pingCd -= step;
    this._lockCd -= step;
    this._warbleT -= step;
    this._rwrLaunchCd -= step;

    if (rwr === 'LAUNCH') {
      if (this._samples.has('rwr_sam_launch')) {
        this._target(this._rwrGain.gain, 0, now, 0.04);
        if (this._rwrLaunchCd <= 0) {
          this._playSample('rwr_sam_launch', { gain: 0.42, jitter: 0 });
          this._rwrLaunchCd = 1.65;
        }
      } else {
        this._target(this._rwrGain.gain, 0.058, now, 0.03);
        if (this._warbleT <= 0) {
          this._warbleHi = !this._warbleHi;
          this._freqTarget(this._rwrOsc.frequency, this._warbleHi ? 1440 : 620, now, 0.012);
          this._warbleT = 0.13;
        }
        if (this._rwrPrev !== 'LAUNCH') this._launchAlarm(now);
      }
    } else if (rwr === 'LOCK') {
      this._target(this._rwrGain.gain, 0, now, 0.05);
      if (this._lockCd <= 0) {
        if (!this._playSample('rwr_new', { gain: 0.34, rate: 1.25, jitter: 0 })) {
          this._tripleChirp(now);
        }
        this._lockCd = 0.95;
        this._pingCd = Math.max(this._pingCd, 0.6);
      }
    } else if (rwr === 'SEARCH') {
      this._target(this._rwrGain.gain, 0, now, 0.05);
      if (this._pingCd <= 0) {
        if (!this._playSample('rwr_new', { gain: 0.24, rate: 1.0, jitter: 0 })) {
          this._beep(1180, 0.055, 0.032, 'sine', now);
        }
        this._pingCd = 1.6;
      }
    } else {
      this._target(this._rwrGain.gain, 0, now, 0.06);
      this._pingCd = 0;
      this._lockCd = 0;
      this._warbleT = 0;
      this._rwrLaunchCd = 0;
    }
    this._rwrPrev = rwr;

    // ------------------------------------------------------- G-strain breathing
    this._bt += step;
    const strain = gStrain > 0.35 ? clamp((gStrain - 0.35) / 0.65, 0, 1) : 0;
    const wave = 0.5 + 0.5 * Math.sin(this._bt * TAU * 0.48);
    const breath = strain * (0.012 + 0.034 * wave);
    this._target(this._breathGain.gain, breath, now, 0.06);
    this._freqTarget(this._breathLP.frequency, 340 + strain * 560, now, 0.12);
  }

  _normRwr(v) {
    const t = String(v == null ? 'NONE' : v).toUpperCase();
    return t === 'SEARCH' || t === 'LOCK' || t === 'LAUNCH' ? t : 'NONE';
  }

  // -------------------------------------------------------------------------
  // One-shot SFX
  // -------------------------------------------------------------------------
  cannonShot() {
    if (!this._ready()) return;
    if (this._playSample('vulcan', { gain: 0.48, rate: 1.0, jitter: 0.055 })) return;
    const t0 = this._now();

    // Low-mid bark.
    const bark = this._noiseSrc(false);
    if (bark) {
      const bp = this._filter('bandpass', 300, 1.05);
      this._sweep(bp.frequency, 340, 120, t0, 0.07);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.30, 0.003, 0, 0.07, t0);
      bark.connect(bp).connect(g).connect(this._bus);
      this._playNoise(bark, t0, end, 0.12);
    }

    // Crisp mechanical snap.
    const snap = this._noiseSrc(false);
    if (snap) {
      const hp = this._filter('highpass', 2700, 0.8);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.15, 0.001, 0, 0.022, t0);
      snap.connect(hp).connect(g).connect(this._bus);
      this._playNoise(snap, t0, end, 0.05);
    }

    // Short breech thump.
    const thump = this._osc('square', 130);
    const tg = this._gainNode(0);
    const tend = this._env(tg.gain, 0.20, 0.002, 0, 0.055, t0);
    this._sweep(thump.frequency, 130, 52, t0, 0.055);
    thump.connect(tg).connect(this._bus);
    this._start(thump, t0);
    this._stop(thump, tend + 0.02);
  }

  missileLaunch() {
    if (!this._ready()) return;
    const playedMain = this._playSample('missile_launch', { gain: 0.64, rate: 1.0, jitter: 0.04, duration: 2.2 });
    const playedPop = this._playSample('aim_launch_pop', { gain: 0.45, rate: 1.0, jitter: 0.04 });
    if (playedMain || playedPop) return;
    const t0 = this._now();

    // Rocket ignition crack.
    const ign = this._noiseSrc(false);
    if (ign) {
      const bp = this._filter('bandpass', 2200, 1.2);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.26, 0.002, 0, 0.075, t0);
      ign.connect(bp).connect(g).connect(this._bus);
      this._playNoise(ign, t0, end, 0.12);
    }

    const kick = this._osc('sine', 92);
    const kg = this._gainNode(0);
    const kend = this._env(kg.gain, 0.22, 0.004, 0, 0.28, t0);
    this._sweep(kick.frequency, 92, 34, t0, 0.30);
    kick.connect(kg).connect(this._bus);
    this._start(kick, t0);
    this._stop(kick, kend + 0.02);

    // Pressurised whoosh tail.
    const whoosh = this._noiseSrc(false);
    if (whoosh) {
      const bp = this._filter('bandpass', 1600, 0.75);
      this._sweep(bp.frequency, 1750, 240, t0, 0.82);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.22, 0.05, 0.08, 0.76, t0);
      whoosh.connect(bp).connect(g).connect(this._bus);
      this._playNoise(whoosh, t0, end, 0.95);
    }
  }

  bombRelease() {
    if (!this._ready()) return;
    if (this._playSample('bomb_release', { gain: 0.62, rate: 1.0, jitter: 0.04 })) return;
    const t0 = this._now();

    const clunk = this._osc('sine', 108);
    const cg = this._gainNode(0);
    const cend = this._env(cg.gain, 0.26, 0.003, 0, 0.15, t0);
    this._sweep(clunk.frequency, 108, 44, t0, 0.16);
    clunk.connect(cg).connect(this._bus);
    this._start(clunk, t0);
    this._stop(clunk, cend + 0.02);

    const metal = this._noiseSrc(false);
    if (metal) {
      const bp = this._filter('bandpass', 900, 3.4);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.16, 0.002, 0, 0.055, t0);
      metal.connect(bp).connect(g).connect(this._bus);
      this._playNoise(metal, t0, end, 0.1);
    }

    const click = this._noiseSrc(false);
    if (click) {
      const hp = this._filter('highpass', 2500, 0.7);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.10, 0.001, 0, 0.014, t0);
      click.connect(hp).connect(g).connect(this._bus);
      this._playNoise(click, t0, end, 0.04);
    }
  }

  flarePop() {
    if (!this._ready()) return;
    if (this._playSample('flare_pop', { gain: 0.56, rate: 1.0, jitter: 0.06 })) return;
    const t0 = this._now();

    const pop = this._noiseSrc(false);
    if (pop) {
      const hp = this._filter('highpass', 1300, 0.8);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.30, 0.002, 0, 0.045, t0);
      pop.connect(hp).connect(g).connect(this._bus);
      this._playNoise(pop, t0, end, 0.08);
    }

    const hiss = this._noiseSrc(false);
    if (hiss) {
      const bp = this._filter('bandpass', 2800, 0.6);
      this._sweep(bp.frequency, 3600, 1500, t0, 0.28);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.13, 0.008, 0.01, 0.27, t0);
      hiss.connect(bp).connect(g).connect(this._bus);
      this._playNoise(hiss, t0, end, 0.34);
    }

    const kick = this._osc('triangle', 150);
    const kg = this._gainNode(0);
    const kend = this._env(kg.gain, 0.09, 0.002, 0, 0.06, t0);
    this._sweep(kick.frequency, 150, 70, t0, 0.07);
    kick.connect(kg).connect(this._bus);
    this._start(kick, t0);
    this._stop(kick, kend + 0.02);
  }

  explosion(distanceM) {
    if (!this._ready()) return;
    const t0 = this._now();
    const d = Math.max(0, fin(distanceM, 0));
    const att = clamp(1 / (1 + d / 240), 0.04, 1);
    const lpHz = clamp(14000 / (1 + d / 320), 420, 14000);
    this._expToggle = 1 - this._expToggle;
    const key = this._expToggle === 0 && this._samples.has('explosion_heavy') ? 'explosion_heavy' : 'explosion';
    if (this._playSample(key, { gain: 0.85 * att, rate: 0.96, jitter: 0.08, lowpassHz: lpHz })) return;

    const boom = this._noiseSrc(false);
    if (boom) {
      const lp = this._filter('lowpass', 480, 0.85);
      this._sweep(lp.frequency, 520, 65, t0, 1.45);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.80 * att, 0.012, 0.04, 1.44, t0);
      boom.connect(lp).connect(g).connect(this._bus);
      this._playNoise(boom, t0, end, 1.62);
    }

    const rumble = this._noiseSrc(false);
    if (rumble) {
      const bp = this._filter('bandpass', 130, 0.7);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.38 * att, 0.03, 0.08, 1.35, t0);
      rumble.connect(bp).connect(g).connect(this._bus);
      this._playNoise(rumble, t0, end, 1.55);
    }

    const sub = this._osc('sine', 52);
    const sg = this._gainNode(0);
    const send = this._env(sg.gain, 0.45 * att, 0.015, 0.05, 1.1, t0);
    this._sweep(sub.frequency, 54, 22, t0, 1.15);
    sub.connect(sg).connect(this._bus);
    this._start(sub, t0);
    this._stop(sub, send + 0.02);
  }

  sonicBoom() {
    if (!this._ready()) return;
    if (this._playSample('sonic_boom', { gain: 0.78, rate: 1.0, jitter: 0.03 })) return;
    const t0 = this._now();

    // Double N-wave pressure crack.
    for (let i = 0; i < 2; i++) {
      const when = t0 + i * 0.085;
      const crack = this._noiseSrc(false);
      if (!crack) continue;
      const hp = this._filter('highpass', 1400, 0.6);
      const g = this._gainNode(0);
      const end = this._env(g.gain, i === 0 ? 0.30 : 0.21, 0.001, 0, 0.05, when);
      crack.connect(hp).connect(g).connect(this._bus);
      this._playNoise(crack, when, end, 0.07);
    }

    const sub = this._osc('sine', 46);
    const sg = this._gainNode(0);
    const send = this._env(sg.gain, 0.28, 0.004, 0.02, 0.42, t0);
    this._sweep(sub.frequency, 48, 23, t0, 0.5);
    sub.connect(sg).connect(this._bus);
    this._start(sub, t0);
    this._stop(sub, send + 0.02);

    const tail = this._noiseSrc(false);
    if (tail) {
      const lp = this._filter('lowpass', 320, 0.8);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.10, 0.005, 0.02, 0.55, t0);
      tail.connect(lp).connect(g).connect(this._bus);
      this._playNoise(tail, t0, end, 0.66);
    }
  }

  boomContact() {
    if (!this._ready()) return;
    if (this._playSample('boom_contact', { gain: 0.58, jitter: 0 })) return;
    this.radioBeep();
  }

  radioBeep() {
    if (!this._ready()) return;
    const t0 = this._now();

    const click = this._noiseSrc(false);
    if (click) {
      const hp = this._filter('highpass', 2600, 0.8);
      const g = this._gainNode(0);
      const end = this._env(g.gain, 0.08, 0.001, 0, 0.012, t0);
      click.connect(hp).connect(g).connect(this._bus);
      this._playNoise(click, t0, end, 0.04);
    }

    this._beep(1240, 0.05, 0.055, 'sine', t0);
    this._beep(1620, 0.04, 0.042, 'sine', t0 + 0.06);
  }

  _tripleChirp(t0) {
    this._beep(1760, 0.038, 0.05, 'square', t0);
    this._beep(2100, 0.038, 0.045, 'square', t0 + 0.055);
    this._beep(1760, 0.038, 0.05, 'square', t0 + 0.11);
  }

  _launchAlarm(t0) {
    this._beep(1480, 0.09, 0.055, 'square', t0);
    this._beep(700, 0.09, 0.055, 'square', t0 + 0.10);
  }

  _beep(freq, dur, gain, type, when) {
    if (!this._ready()) return;
    const osc = this._osc(type, freq);
    const g = this._gainNode(0);
    const end = this._env(g.gain, gain, 0.004, 0, dur, when);
    osc.connect(g).connect(this._bus);
    this._start(osc, when);
    this._stop(osc, end + 0.01);
  }

  // -------------------------------------------------------------------------
  // Node / param helpers
  // -------------------------------------------------------------------------
  _ready() {
    return !!(this.ready && this.ctx && this._bus);
  }

  _now() {
    return Math.max(0, fin(this.ctx && this.ctx.currentTime, 0));
  }

  _gainNode(v) {
    const g = this.ctx.createGain();
    this._paramSet(g.gain, v, 0);
    return g;
  }

  _osc(type, hz) {
    const o = this.ctx.createOscillator();
    if (o) {
      o.type = type;
      this._paramSet(o.frequency, hz, this._now());
    }
    return o;
  }

  _filter(type, hz, q) {
    const f = this.ctx.createBiquadFilter();
    if (f) {
      f.type = type;
      this._paramSet(f.frequency, hz, this._now());
      if (f.Q) this._paramSet(f.Q, q, 0);
    }
    return f;
  }

  _noiseSrc(loop) {
    if (!this._noiseBuf || typeof this.ctx.createBufferSource !== 'function') return null;
    const src = this.ctx.createBufferSource();
    if (!src) return null;
    src.buffer = this._noiseBuf;
    src.loop = !!loop;
    return src;
  }

  _start(node, when) {
    if (!node || typeof node.start !== 'function') return;
    try {
      node.start(Math.max(0, fin(when, 0)));
    } catch (err) {
      /* already started or unsupported — ignore */
    }
  }

  _stop(node, when) {
    if (!node || typeof node.stop !== 'function') return;
    try {
      node.stop(Math.max(0.001, fin(when, 0.001)));
    } catch (err) {
      /* ignore */
    }
  }

  _playNoise(src, when, end, dur) {
    if (!src) return;
    const t = Math.max(0, fin(when, 0));
    const off = this._noiseOffset();
    const length = Math.max(0.02, fin(dur, 0.1));
    if (typeof src.start === 'function') {
      try {
        src.start(t, off, length);
      } catch (err) {
        this._start(src, t);
      }
    }
    this._stop(src, Math.max(t + 0.02, fin(end, t + length)) + 0.03);
  }

  _noiseOffset() {
    const len = this._noiseBuf && Number.isFinite(this._noiseBuf.duration)
      ? this._noiseBuf.duration
      : 1.6;
    this._noiseOff = (this._noiseOff + 0.37) % Math.max(0.2, len - 0.4);
    return this._noiseOff;
  }

  _paramSet(param, value, when) {
    if (!param) return;
    const v = fin(value, 0);
    const t = Math.max(0, fin(when, 0));
    if (typeof param.setValueAtTime === 'function') {
      try {
        param.setValueAtTime(v, t);
        return;
      } catch (err) {
        /* fall through to direct write */
      }
    }
    param.value = v;
  }

  _target(param, value, now, tc) {
    if (!param) return;
    const v = fin(value, 0);
    const t = Math.max(0, fin(now, 0));
    const time = clamp(fin(tc, 0.05), 0.001, 2);
    if (typeof param.setTargetAtTime === 'function') {
      try {
        param.setTargetAtTime(v, t, time);
        return;
      } catch (err) {
        /* fall through */
      }
    }
    param.value = v;
  }

  _freqTarget(param, hz, now, tc) {
    if (!param) return;
    const f = clamp(fin(hz, 440), 15, this._maxFreq());
    this._target(param, f, now, tc);
  }

  _sweep(param, from, to, when, dur) {
    if (!param) return;
    const t = Math.max(0, fin(when, 0));
    const f0 = clamp(fin(from, 440), 15, this._maxFreq());
    const f1 = clamp(fin(to, f0), 15, this._maxFreq());
    const d = Math.max(0.001, fin(dur, 0.05));
    if (typeof param.setValueAtTime === 'function') {
      try {
        param.setValueAtTime(f0, t);
      } catch (err) {
        /* ignore */
      }
    }
    if (typeof param.exponentialRampToValueAtTime === 'function') {
      try {
        param.exponentialRampToValueAtTime(f1, t + d);
        return;
      } catch (err) {
        /* fall through */
      }
    }
    if (typeof param.linearRampToValueAtTime === 'function') {
      try {
        param.linearRampToValueAtTime(f1, t + d);
        return;
      } catch (err) {
        /* ignore */
      }
    }
    param.value = f1;
  }

  _ramp(param, value, when) {
    if (!param) return;
    const v = clamp(fin(value, 0.0001), 0.0001, 1);
    const t = Math.max(0.001, fin(when, 0.001));
    if (typeof param.linearRampToValueAtTime === 'function') {
      try {
        param.linearRampToValueAtTime(v, t);
        return;
      } catch (err) {
        /* fall through */
      }
    }
    param.value = v;
  }

  _exp(param, value, when) {
    if (!param) return;
    const v = clamp(fin(value, 0.0001), 0.0001, 1);
    const t = Math.max(0.001, fin(when, 0.001));
    if (typeof param.exponentialRampToValueAtTime === 'function') {
      try {
        param.exponentialRampToValueAtTime(v, t);
        return;
      } catch (err) {
        /* fall through */
      }
    }
    param.value = v;
  }

  /** Attack → hold → exponential decay gain envelope. Returns the end time. */
  _env(param, peak, attack, hold, decay, t0) {
    const t = Math.max(0, fin(t0, 0));
    const a = clamp(fin(attack, 0.004), 0.0005, 1);
    const h = Math.max(0, fin(hold, 0));
    const d = clamp(fin(decay, 0.05), 0.005, 4);
    const p = clamp(fin(peak, 0.1), 0.0002, 1);
    this._paramSet(param, 0.0001, t);
    this._ramp(param, p, t + a);
    const end = t + a + h + d;
    this._exp(param, 0.0001, end);
    return end;
  }
}