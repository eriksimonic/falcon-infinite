// Procedural F-16 turbofan jet + atmospheric wind audio:
// - Deep F-16 turbofan: sub-bass thrust foundation, dual-formant exhaust nozzle
//   body, broadband roar/shear, afterburner ignition & crackle, warm multi-stage
//   N1/N2 turbine spool whine + intake howl, stereo spatial micro-delay depth,
//   and canopy interior/exterior acoustic framing.
// - Atmospheric wind simulation: ambient airfield/crosswind rush, resonant
//   whistling gusts, dual-band high-speed airframe slipstream & transonic hiss,
//   plus aerodynamic/gust airframe buffet shudder.
// No sample files — everything is synthesised with WebAudio.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function makeNoiseBuffer(ctx, seconds, pink) {
  const sr = ctx.sampleRate;
  const len = Math.max(sr, Math.floor(sr * seconds));
  const xfade = Math.min(2048, Math.floor(len * 0.1));
  const buf = ctx.createBuffer(2, len, sr);

  for (let ch = 0; ch < 2; ch++) {
    const out = buf.getChannelData(ch);
    if (!pink) {
      for (let i = 0; i < len; i++) out[i] = (Math.random() * 2 - 1) * 0.85;
      continue;
    }

    // Paul Kellet 7-stage pink noise with seamless loop crossfade.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    const nextPink = () => {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      return p * 0.11;
    };

    for (let i = 0; i < 1024; i++) nextPink();
    for (let i = 0; i < len; i++) out[i] = nextPink();

    // Seamless equal-power overlap at loop wrap so there is never a seam/click.
    for (let i = 0; i < xfade; i++) {
      const t = i / xfade;
      const tail = nextPink();
      const a = Math.sin(t * Math.PI * 0.5);
      const b = Math.cos(t * Math.PI * 0.5);
      out[i] = out[i] * a + tail * b;
    }

    let peak = 0;
    for (let i = 0; i < len; i++) {
      const v = Math.abs(out[i]);
      if (v > peak) peak = v;
    }
    if (peak > 0.001) {
      const s = 0.88 / peak;
      for (let i = 0; i < len; i++) out[i] *= s;
    }
  }
  return buf;
}

function makeCrackleCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // Asymmetric soft clip turns turbulent noise peaks into jet crackle.
    const biased = x + 0.18 * x * x;
    curve[i] = Math.tanh(biased * 2.4);
  }
  return curve;
}

function makeWarmCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // Gentle symmetrical tape/tube-style warmth for dense low-end weight.
    curve[i] = Math.tanh(x * 1.65);
  }
  return curve;
}

export class SimAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.paused = false;
    this.master = null;
    this.nodes = {};
    this._n1 = 0;
    this._n2 = 0;
    this._abEnv = 0;
    this._wasAB = false;
    this._abCooldown = 0;
    this._turbTime = 0;
    this._gearTimer = 0;
    this._engineAlive = true;
  }

  async start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this._engineAlive = true;
      this.setPaused(false);
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    // Browsers hand back a freshly constructed context in the 'suspended' state
    // until a user gesture unlocks it. Wake it here so the very first frame of
    // engine audio is not silently dropped.
    if (ctx.state === 'suspended') {
      try {
        const waking = ctx.resume();
        if (waking && typeof waking.catch === 'function') waking.catch(() => {});
      } catch (err) {
        /* context may already be resuming / unsupported — ignore */
      }
    }

    // Master chain with smooth dynamics compressor (preserves deep sub-bass weight).
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 18;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.012;
    compressor.release.value = 0.22;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.66;
    compressor.connect(this.master).connect(ctx.destination);

    // Separate buses: simBus fades on pause/menu; sfxBus plays through crashes.
    const simBus = ctx.createGain();
    simBus.gain.value = this.paused ? 0 : 1;
    simBus.connect(compressor);

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = 1;
    // Weapon / explosion SFX get their own soft limiter, wired straight into
    // the master. Routing sfxBus through the simBus compressor meant the loud
    // continuous jet engine rode the shared gain reduction and ducked every
    // cannon burst, bomb release and explosion into near silence.
    const sfxCompressor = ctx.createDynamicsCompressor();
    sfxCompressor.threshold.value = -6;
    sfxCompressor.knee.value = 12;
    sfxCompressor.ratio.value = 4;
    sfxCompressor.attack.value = 0.003;
    sfxCompressor.release.value = 0.15;
    sfxBus.connect(sfxCompressor).connect(this.master);

    const engineBus = ctx.createGain();
    engineBus.gain.value = 1;
    engineBus.connect(simBus);

    // Coprime stereo noise buffers eliminate any perceptible periodic loop.
    const pinkBuf = makeNoiseBuffer(ctx, 4.3, true);
    const whiteBuf = makeNoiseBuffer(ctx, 5.7, false);

    const pinkSrc = ctx.createBufferSource();
    pinkSrc.buffer = pinkBuf;
    pinkSrc.loop = true;

    const whiteSrc = ctx.createBufferSource();
    whiteSrc.buffer = whiteBuf;
    whiteSrc.loop = true;

    const warmCurve = makeWarmCurve();

    // -------------------------------------------------------- exhaust bus
    // Mid-scoop EQ keeps the jet warm and cinematic instead of boxy.
    const exhaustEq = ctx.createBiquadFilter();
    exhaustEq.type = 'peaking';
    exhaustEq.frequency.value = 1050;
    exhaustEq.Q.value = 0.8;
    exhaustEq.gain.value = -2.8;

    // Lowpass models canopy attenuation in cockpit vs wide-open exterior roar.
    const exhaustFilter = ctx.createBiquadFilter();
    exhaustFilter.type = 'lowpass';
    exhaustFilter.frequency.value = 1850;
    exhaustFilter.Q.value = 0.55;

    const exhaustGain = ctx.createGain();
    exhaustGain.gain.value = 0.85;
    exhaustEq.connect(exhaustFilter).connect(exhaustGain).connect(engineBus);

    // Subtle spatial depth / exhaust plume width (micro-delay reflection bus).
    const depthDelay = ctx.createDelay ? ctx.createDelay(0.05) : null;
    const depthLP = ctx.createBiquadFilter();
    depthLP.type = 'lowpass';
    depthLP.frequency.value = 1600;
    const depthGain = ctx.createGain();
    depthGain.gain.value = 0.24;
    if (depthDelay) {
      depthDelay.delayTime.value = 0.013;
      exhaustFilter.connect(depthDelay).connect(depthLP).connect(depthGain).connect(engineBus);
    }

    // Layer 0: Dedicated Sub-Bass Jet Thrust Foundation (chest-felt 35-130 Hz weight)
    const subLP1 = ctx.createBiquadFilter();
    subLP1.type = 'lowpass';
    subLP1.frequency.value = 92;
    subLP1.Q.value = 0.9;
    const subDrive = ctx.createGain();
    subDrive.gain.value = 2.0;
    const subWarm = ctx.createWaveShaper();
    subWarm.curve = warmCurve;
    subWarm.oversample = '2x';
    const subLP2 = ctx.createBiquadFilter();
    subLP2.type = 'lowpass';
    subLP2.frequency.value = 115;
    subLP2.Q.value = 0.7;
    const subShelf = ctx.createBiquadFilter();
    subShelf.type = 'lowshelf';
    subShelf.frequency.value = 68;
    subShelf.gain.value = 8.0;
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    pinkSrc.connect(subLP1).connect(subDrive).connect(subWarm).connect(subLP2).connect(subShelf).connect(subGain).connect(exhaustEq);

    // Layer 1: Deep jet exhaust rumble (80-480 Hz)
    const rumbleLP = ctx.createBiquadFilter();
    rumbleLP.type = 'lowpass';
    rumbleLP.frequency.value = 160;
    rumbleLP.Q.value = 0.8;
    const rumbleShelf = ctx.createBiquadFilter();
    rumbleShelf.type = 'lowshelf';
    rumbleShelf.frequency.value = 105;
    rumbleShelf.gain.value = 5.5;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    pinkSrc.connect(rumbleLP).connect(rumbleShelf).connect(rumbleGain).connect(exhaustEq);

    // Layer 1B: Dual-Formant Exhaust Nozzle Throat / Cavity Body (guttural jet depth)
    const nozzleF1 = ctx.createBiquadFilter();
    nozzleF1.type = 'bandpass';
    nozzleF1.frequency.value = 185;
    nozzleF1.Q.value = 1.9;
    const nozzleF2 = ctx.createBiquadFilter();
    nozzleF2.type = 'bandpass';
    nozzleF2.frequency.value = 370;
    nozzleF2.Q.value = 1.6;
    const nozzleDrive = ctx.createGain();
    nozzleDrive.gain.value = 1.75;
    const nozzleWarm = ctx.createWaveShaper();
    nozzleWarm.curve = warmCurve;
    nozzleWarm.oversample = '2x';
    const nozzleGain = ctx.createGain();
    nozzleGain.gain.value = 0;
    pinkSrc.connect(nozzleF1).connect(nozzleDrive);
    pinkSrc.connect(nozzleF2).connect(nozzleDrive);
    nozzleDrive.connect(nozzleWarm).connect(nozzleGain).connect(exhaustEq);

    // Layer 2: Mid-band jet thrust roar
    const roarBP = ctx.createBiquadFilter();
    roarBP.type = 'bandpass';
    roarBP.frequency.value = 360;
    roarBP.Q.value = 0.65;
    const roarGain = ctx.createGain();
    roarGain.gain.value = 0;
    pinkSrc.connect(roarBP).connect(roarGain).connect(exhaustEq);

    // Layer 3: High-band jet shear / rushing air wash
    const shearBP = ctx.createBiquadFilter();
    shearBP.type = 'bandpass';
    shearBP.frequency.value = 1200;
    shearBP.Q.value = 0.55;
    const shearGain = ctx.createGain();
    shearGain.gain.value = 0;
    whiteSrc.connect(shearBP).connect(shearGain).connect(exhaustEq);

    // Layer 4: Afterburner saturated roar + supersonic shock-cell crackle
    const abDrive = ctx.createGain();
    abDrive.gain.value = 2.8;
    const abShaper = ctx.createWaveShaper();
    abShaper.curve = makeCrackleCurve();
    abShaper.oversample = '2x';
    const abRoarBP = ctx.createBiquadFilter();
    abRoarBP.type = 'bandpass';
    abRoarBP.frequency.value = 360;
    abRoarBP.Q.value = 0.55;
    const abRoarGain = ctx.createGain();
    abRoarGain.gain.value = 0;
    pinkSrc.connect(abDrive).connect(abShaper).connect(abRoarBP).connect(abRoarGain).connect(exhaustEq);

    const abCrackleBP = ctx.createBiquadFilter();
    abCrackleBP.type = 'bandpass';
    abCrackleBP.frequency.value = 2100;
    abCrackleBP.Q.value = 0.75;
    const abCrackleGain = ctx.createGain();
    abCrackleGain.gain.value = 0;
    whiteSrc.connect(abCrackleBP).connect(abCrackleGain).connect(exhaustEq);

    // -------------------------------------------------------- turbine whine
    const turbineGain = ctx.createGain();
    turbineGain.gain.value = 0.85;
    turbineGain.connect(engineBus);

    // N1 fan / low-pressure compressor whine (smooth, warm multi-harmonic)
    const fanBP = ctx.createBiquadFilter();
    fanBP.type = 'bandpass';
    fanBP.frequency.value = 580;
    fanBP.Q.value = 1.45;
    const fanGain = ctx.createGain();
    fanGain.gain.value = 0;
    fanBP.connect(fanGain).connect(turbineGain);

    const fanOsc1 = ctx.createOscillator();
    fanOsc1.type = 'sine';
    fanOsc1.frequency.value = 540;
    const fanOsc2 = ctx.createOscillator();
    fanOsc2.type = 'triangle';
    fanOsc2.frequency.value = 542;
    const fanOsc2Gain = ctx.createGain();
    fanOsc2Gain.gain.value = 0.22;
    // Warm harmonic shadow (pure sine at 0.5x fanFreq -> 270..910 Hz, adds depth without buzz)
    const fanSubOsc = ctx.createOscillator();
    fanSubOsc.type = 'sine';
    fanSubOsc.frequency.value = 270;
    const fanSubGain = ctx.createGain();
    fanSubGain.gain.value = 0.32;

    fanOsc1.connect(fanBP);
    fanOsc2.connect(fanOsc2Gain).connect(fanBP);
    fanSubOsc.connect(fanSubGain).connect(fanGain);

    // N2 core high-pressure turbine whistle
    const coreOsc = ctx.createOscillator();
    coreOsc.type = 'sine';
    coreOsc.frequency.value = 1520;
    const coreGain = ctx.createGain();
    coreGain.gain.value = 0;
    coreOsc.connect(coreGain).connect(turbineGain);

    // Narrowband filtered intake howl tracking N1 compressor blades
    const intakeBP = ctx.createBiquadFilter();
    intakeBP.type = 'bandpass';
    intakeBP.frequency.value = 750;
    intakeBP.Q.value = 7.2;
    const intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;
    whiteSrc.connect(intakeBP).connect(intakeGain).connect(turbineGain);

    // ----------------------------------------- atmospheric wind & slipstream
    // 1. Ambient environmental wind & rolling gusts (runway & airborne crosswind)
    const ambWindBP = ctx.createBiquadFilter();
    ambWindBP.type = 'bandpass';
    ambWindBP.frequency.value = 260;
    ambWindBP.Q.value = 1.25;
    const ambWindGain = ctx.createGain();
    ambWindGain.gain.value = 0;
    pinkSrc.connect(ambWindBP).connect(ambWindGain).connect(simBus);

    // 2. Resonant wind gust howl / whistling across canopy & wings
    const gustHowl1 = ctx.createBiquadFilter();
    gustHowl1.type = 'bandpass';
    gustHowl1.frequency.value = 640;
    gustHowl1.Q.value = 5.8;
    const gustHowl2 = ctx.createBiquadFilter();
    gustHowl2.type = 'bandpass';
    gustHowl2.frequency.value = 1180;
    gustHowl2.Q.value = 7.2;
    const gustHowlGain = ctx.createGain();
    gustHowlGain.gain.value = 0;
    whiteSrc.connect(gustHowl1).connect(gustHowlGain);
    whiteSrc.connect(gustHowl2).connect(gustHowlGain);
    gustHowlGain.connect(simBus);

    // 3. High-speed airframe slipstream & boundary-layer canopy rush
    const windBP = ctx.createBiquadFilter();
    windBP.type = 'bandpass';
    windBP.frequency.value = 700;
    windBP.Q.value = 0.62;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    whiteSrc.connect(windBP).connect(windGain).connect(simBus);

    // 4. High-speed / transonic upper air hiss (> 260 kt)
    const airHissHP = ctx.createBiquadFilter();
    airHissHP.type = 'highpass';
    airHissHP.frequency.value = 2600;
    const airHissGain = ctx.createGain();
    airHissGain.gain.value = 0;
    whiteSrc.connect(airHissHP).connect(airHissGain).connect(simBus);

    // 5. Aerodynamic high-AoA / high-G / stall / wind-gust airframe buffet shudder
    const buffetLP = ctx.createBiquadFilter();
    buffetLP.type = 'lowpass';
    buffetLP.frequency.value = 100;
    buffetLP.Q.value = 1.35;
    const buffetGain = ctx.createGain();
    buffetGain.gain.value = 0;
    pinkSrc.connect(buffetLP).connect(buffetGain).connect(simBus);

    // 6. Rain on canopy
    const rainHP = ctx.createBiquadFilter();
    rainHP.type = 'highpass';
    rainHP.frequency.value = 2200;
    const rainLP = ctx.createBiquadFilter();
    rainLP.type = 'lowpass';
    rainLP.frequency.value = 7400;
    const rainGain = ctx.createGain();
    rainGain.gain.value = 0;
    whiteSrc.connect(rainHP).connect(rainLP).connect(rainGain).connect(simBus);

    // 7. Cockpit stall warning horn
    const stallOsc1 = ctx.createOscillator();
    stallOsc1.type = 'triangle';
    stallOsc1.frequency.value = 860;
    const stallOsc2 = ctx.createOscillator();
    stallOsc2.type = 'sine';
    stallOsc2.frequency.value = 1290;
    const stallOsc2Gain = ctx.createGain();
    stallOsc2Gain.gain.value = 0.35;
    const stallGain = ctx.createGain();
    stallGain.gain.value = 0;
    stallOsc1.connect(stallGain);
    stallOsc2.connect(stallOsc2Gain).connect(stallGain);
    stallGain.connect(simBus);

    pinkSrc.start();
    whiteSrc.start();
    fanOsc1.start();
    fanOsc2.start();
    fanSubOsc.start();
    coreOsc.start();
    stallOsc1.start();
    stallOsc2.start();

    this.nodes = {
      compressor, sfxCompressor, simBus, sfxBus, engineBus,
      pinkBuf, whiteBuf, pinkSrc, whiteSrc,
      exhaustEq, exhaustFilter, exhaustGain, depthGain,
      subLP1, subLP2, subShelf, subGain,
      rumbleLP, rumbleShelf, rumbleGain,
      nozzleF1, nozzleF2, nozzleGain,
      roarBP, roarGain,
      shearBP, shearGain,
      abRoarBP, abRoarGain, abCrackleBP, abCrackleGain,
      turbineGain, fanBP, fanGain, fanOsc1, fanOsc2, fanSubOsc,
      coreOsc, coreGain, intakeBP, intakeGain,
      ambWindBP, ambWindGain, gustHowl1, gustHowl2, gustHowlGain,
      windBP, windGain, airHissHP, airHissGain, buffetLP, buffetGain,
      rainGain, stallGain,
    };
    this.ready = true;
    this._engineAlive = true;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.66, this.ctx.currentTime, 0.05);
    }
  }

  setPaused(paused) {
    this.paused = paused;
    if (!this.ready || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.nodes.simBus.gain.setTargetAtTime(paused ? 0 : 1, now, 0.06);
    if (!paused && this._engineAlive) {
      this.nodes.engineBus.gain.setTargetAtTime(1, now, 0.08);
    }
  }

  resetEngine() {
    this._engineAlive = true;
    this._wasAB = false;
    this._abEnv = 0;
    if (this.ready && this.ctx) {
      this.nodes.engineBus.gain.setTargetAtTime(1, this.ctx.currentTime, 0.08);
    }
  }

  update(dt, t) {
    if (!this.ready || !this.ctx) return;
    const now = this.ctx.currentTime;
    const maxF = this.ctx.sampleRate * 0.45;
    const fClamp = (hz) => clamp(hz, 25, maxF);
    const n = this.nodes;

    const stepDt = clamp(dt || 0.016, 0.001, 0.1);
    this._turbTime += stepDt;
    if (this._abCooldown > 0) this._abCooldown -= stepDt;
    if (this._gearTimer > 0) this._gearTimer -= stepDt;

    const throttle = clamp(t.throttle ?? 0, 0, 1);
    const speed = Math.max(0, t.speed ?? 0);
    const ab = !!t.afterburner;
    const isExternal = !!t.mode && t.mode !== 'cockpit';
    const windSpeed = Math.max(0, t.windSpeed ?? 0);
    const windGust = clamp(t.windGust ?? 0, 0, 1);
    const crosswind = Math.abs(t.crosswind ?? 0);
    const beta = Math.abs(t.beta ?? 0);
    const turbIn = Math.max(0, t.turbulence ?? 0);
    const alt = Math.max(0, t.altitude ?? 0);
    // Flyby Doppler shift: pitch the turbine/whine and resonant bands with the
    // closing radial velocity. 1.0 (all other cameras) reproduces the old mix.
    const doppler = clamp(t.doppler ?? 1.0, 0.72, 1.38);

    // Realistic turbine spool inertia (N1 fan slightly slower than N2 core).
    const ram = Math.min(0.08, speed / 2200);
    const targetN1 = clamp(throttle + ram, 0, 1.05);
    const targetN2 = clamp(throttle * 0.96 + ram * 0.7, 0, 1.04);
    const kN1 = 1 - Math.exp(-stepDt / 0.32);
    const kN2 = 1 - Math.exp(-stepDt / 0.22);
    this._n1 += (targetN1 - this._n1) * kN1;
    this._n2 += (targetN2 - this._n2) * kN2;
    const n1 = this._n1;
    const n2 = this._n2;

    // Afterburner envelope + ignition "whoomp" on rising edge.
    const abTarget = ab ? clamp(0.45 + ((throttle - 0.89) / 0.11) * 0.55, 0.45, 1) : 0;
    if (ab && !this._wasAB && this._abCooldown <= 0 && !this.paused && this._engineAlive) {
      this._abIgnite(isExternal);
      this._abCooldown = 0.65;
    }
    this._wasAB = ab;
    this._abEnv += (abTarget - this._abEnv) * (1 - Math.exp(-stepDt / 0.16));
    const abAmt = this._abEnv;

    // Slow incommensurate turbulence wobble (organic hot-gas shear, never rhythmic).
    const tt = this._turbTime;
    const turb = (Math.sin(tt * 2.3) * 0.55 + Math.sin(tt * 3.7 + 1.1) * 0.45) * (0.045 + abAmt * 0.055);
    const windWave = 0.5 + 0.5 * (Math.sin(tt * 0.72) * 0.6 + Math.sin(tt * 1.41 + 2.1) * 0.4);

    // Interior (cockpit canopy) vs exterior acoustic framing + spatial depth.
    const extCut = isExternal ? (7800 + abAmt * 3200) : (1850 + abAmt * 700);
    n.exhaustFilter.frequency.setTargetAtTime(fClamp(extCut), now, 0.08);
    n.exhaustGain.gain.setTargetAtTime(isExternal ? 1.08 : 0.86, now, 0.08);
    n.depthGain.gain.setTargetAtTime(isExternal ? (0.28 + abAmt * 0.12) : (0.16 + abAmt * 0.06), now, 0.10);
    n.turbineGain.gain.setTargetAtTime(isExternal ? 1.05 : 0.84, now, 0.08);

    // 0. Dedicated Sub-Bass Jet Thrust Foundation (deep physical weight)
    const subCut = (82 + n1 * 48 + abAmt * 38) * (1 + turb * 0.6);
    n.subLP1.frequency.setTargetAtTime(fClamp(subCut), now, 0.10);
    n.subLP2.frequency.setTargetAtTime(fClamp(subCut * 1.25), now, 0.10);
    n.subGain.gain.setTargetAtTime(0.14 + n1 * 0.36 + abAmt * 0.28, now, 0.12);

    // 1. Deep jet exhaust rumble
    const rumbleFreq = (145 + n1 * 235 + abAmt * 180) * (1 + turb);
    n.rumbleLP.frequency.setTargetAtTime(fClamp(rumbleFreq), now, 0.10);
    n.rumbleGain.gain.setTargetAtTime(0.11 + n1 * 0.34 + abAmt * 0.22, now, 0.12);

    // 1B. Exhaust Nozzle Throat / Cavity Body (warm guttural jet resonance)
    n.nozzleF1.frequency.setTargetAtTime(fClamp((165 + n1 * 115 + abAmt * 55) * (1 + turb * 0.9) * doppler), now, 0.10);
    n.nozzleF2.frequency.setTargetAtTime(fClamp((330 + n1 * 210 + abAmt * 95) * (1 - turb * 0.8) * doppler), now, 0.10);
    n.nozzleGain.gain.setTargetAtTime(0.085 + n1 * 0.24 + abAmt * 0.16, now, 0.12);

    // 2. Mid-band jet thrust roar
    const roarFreq = (310 + n1 * 440 + abAmt * 260) * (1 + turb * 1.4) * doppler;
    n.roarBP.frequency.setTargetAtTime(fClamp(roarFreq), now, 0.10);
    n.roarGain.gain.setTargetAtTime(0.055 + n1 * 0.31 + abAmt * 0.16, now, 0.12);

    // 3. High-band jet shear / rushing exhaust air
    const shearFreq = (1050 + n1 * 1400 + abAmt * 700) * (1 + turb) * doppler;
    n.shearBP.frequency.setTargetAtTime(fClamp(shearFreq), now, 0.12);
    n.shearGain.gain.setTargetAtTime(0.045 + n1 * 0.13 + abAmt * 0.08, now, 0.14);

    // 4. Afterburner saturated roar & shock-cell crackle
    n.abRoarBP.frequency.setTargetAtTime(fClamp((290 + abAmt * 300) * (1 + turb * 1.6) * doppler), now, 0.09);
    n.abRoarGain.gain.setTargetAtTime(abAmt * (isExternal ? 0.48 : 0.36), now, 0.10);
    n.abCrackleBP.frequency.setTargetAtTime(fClamp(1750 + abAmt * 950), now, 0.09);
    n.abCrackleGain.gain.setTargetAtTime(abAmt * (isExternal ? 0.20 : 0.09), now, 0.10);

    // 5. Turbine spool whine (N1 fan + warm sub-harmonic + N2 core + intake howl)
    const fanFreq = (540 + n1 * 1280) * doppler;
    n.fanOsc1.frequency.setTargetAtTime(fClamp(fanFreq), now, 0.08);
    n.fanOsc2.frequency.setTargetAtTime(fClamp(fanFreq * 1.0035), now, 0.08);
    n.fanSubOsc.frequency.setTargetAtTime(fClamp(fanFreq * 0.5), now, 0.08);
    n.fanBP.frequency.setTargetAtTime(fClamp(fanFreq * 1.06), now, 0.08);
    const fanCurve = 0.021 + Math.sin(clamp(n1, 0, 1) * Math.PI * 0.78) * 0.015 - abAmt * 0.008;
    n.fanGain.gain.setTargetAtTime(Math.max(0.011, fanCurve), now, 0.12);

    const coreFreq = (1520 + n2 * 2200) * doppler;
    n.coreOsc.frequency.setTargetAtTime(fClamp(coreFreq), now, 0.08);
    const coreCurve = 0.013 - n2 * 0.004 - abAmt * 0.003;
    n.coreGain.gain.setTargetAtTime(Math.max(0.004, coreCurve), now, 0.14);

    n.intakeBP.frequency.setTargetAtTime(fClamp(fanFreq * 1.38), now, 0.08);
    n.intakeGain.gain.setTargetAtTime(0.044 + n1 * 0.030 - abAmt * 0.018, now, 0.12);

    // 6. Atmospheric Wind Simulation Audio
    // 6a. Ambient airfield & crosswind rush (audible even at rest on the runway!)
    const envWindNorm = clamp(windSpeed / 22, 0, 1.35);
    const gustEnergy = clamp(envWindNorm * 0.65 + windGust * (0.45 + envWindNorm * 0.55), 0, 1.5);
    const envScale = isExternal ? 1.15 : 0.78;
    const ambFreq = (165 + envWindNorm * 280 + windGust * 190) * (0.88 + windWave * 0.24);
    n.ambWindBP.frequency.setTargetAtTime(fClamp(ambFreq), now, 0.16);
    n.ambWindGain.gain.setTargetAtTime(clamp(gustEnergy * 0.19 * envScale, 0, 0.34), now, 0.18);

    // 6b. Resonant whistling wind gusts (crosswind / gusts sweeping across canopy & wings)
    const xwindNorm = clamp(crosswind / 16, 0, 1.2);
    const howlDrive = clamp((windGust * 0.7 + envWindNorm * 0.45 + xwindNorm * 0.35 + beta * 1.2) - 0.18, 0, 1.2);
    const howlPitch1 = (460 + envWindNorm * 340 + windGust * 260) * (0.90 + windWave * 0.22);
    const howlPitch2 = howlPitch1 * (1.72 + Math.sin(tt * 0.47) * 0.08);
    n.gustHowl1.frequency.setTargetAtTime(fClamp(howlPitch1), now, 0.14);
    n.gustHowl2.frequency.setTargetAtTime(fClamp(howlPitch2), now, 0.14);
    n.gustHowlGain.gain.setTargetAtTime(howlDrive * (isExternal ? 0.085 : 0.055), now, 0.16);

    // 6c. High-speed airframe slipstream & boundary-layer canopy rush (scales with dynamic pressure)
    const airDensity = Math.exp(-alt / 9500);
    const eas = speed * Math.sqrt(airDensity); // equivalent airspeed -> real acoustic pressure
    const slipAmt = Math.pow(clamp(eas / 320, 0, 1.4), 1.45);
    const slipBoost = 1 + clamp(beta * 1.4 + xwindNorm * 0.25 + windGust * 0.22, 0, 0.75);
    const windScale = isExternal ? 0.17 : 0.24;
    n.windBP.frequency.setTargetAtTime(fClamp(420 + eas * 5.2 + windGust * 220), now, 0.16);
    n.windGain.gain.setTargetAtTime(0.006 + slipAmt * windScale * slipBoost, now, 0.18);

    // 6d. High-speed upper air hiss (above ~240 kt / 125 m/s)
    const highSpeedHiss = clamp((eas - 120) / 220, 0, 1.1);
    n.airHissHP.frequency.setTargetAtTime(fClamp(2300 + eas * 4.0), now, 0.20);
    n.airHissGain.gain.setTargetAtTime(highSpeedHiss * highSpeedHiss * (isExternal ? 0.08 : 0.11), now, 0.20);

    // 7. Aerodynamic + Wind-Gust Airframe Buffet Shudder
    const aoa = Math.abs(t.aoa ?? 0);
    const gEx = Math.max(0, Math.abs((t.gForce ?? 1) - 1) - 2.2) / 5.5;
    const aoaEx = !t.onGround ? clamp((aoa - 0.18) / 0.16, 0, 1) : 0;
    const stallBuf = t.stalled && !t.onGround ? 1 : 0;
    const windBuf = !t.onGround
      ? clamp((turbIn * 0.45 + windGust * envWindNorm * 0.55) * clamp(eas / 95, 0.2, 1.1), 0, 0.85)
      : clamp(windGust * envWindNorm * 0.35, 0, 0.35);
    const buffet = clamp(Math.max(stallBuf, aoaEx * 0.65, gEx * 0.55, windBuf), 0, 1);
    n.buffetLP.frequency.setTargetAtTime(fClamp(78 + buffet * 52), now, 0.10);
    n.buffetGain.gain.setTargetAtTime(buffet * 0.28, now, 0.08);

    // 8. Rain
    n.rainGain.gain.setTargetAtTime(clamp(t.rain ?? 0, 0, 1) * (isExternal ? 0.11 : 0.19), now, 0.35);

    // 9. Stall warning horn (cockpit)
    const stall = t.stalled && !t.onGround;
    const pulse = (Math.sin(now * 24) > 0) ? 1 : 0.15;
    n.stallGain.gain.setTargetAtTime(stall ? 0.032 * pulse : 0, now, 0.015);
  }

  /** Deep pressure "whoomp" when the afterburner lights. */
  _abIgnite(isExternal) {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dest = this.nodes.exhaustEq;

    // Low pressure burst
    const src = ctx.createBufferSource();
    src.buffer = this.nodes.pinkBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(340, now);
    lp.frequency.exponentialRampToValueAtTime(58, now + 0.48);
    const g = ctx.createGain();
    const amp = isExternal ? 0.58 : 0.42;
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(amp, now + 0.035);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.52);
    src.connect(lp).connect(g).connect(dest);
    src.start(now, Math.random() * 2.0, 0.55);

    // Sub-bass ignition thump
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(88, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 0.38);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.001, now);
    og.gain.linearRampToValueAtTime(isExternal ? 0.32 : 0.22, now + 0.025);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
    osc.connect(og).connect(dest);
    osc.start(now);
    osc.stop(now + 0.45);
  }

  /** Hydraulic landing gear actuator whir + lock clunk. */
  gear(up) {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dest = this.nodes.sfxBus;

    const src = ctx.createBufferSource();
    const len = Math.floor(ctx.sampleRate * 0.72);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const e = Math.min(1, i / 3500) * Math.max(0, 1 - i / len);
      d[i] = (Math.random() * 2 - 1) * 0.28 * e;
    }
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(up ? 480 : 380, now);
    f.frequency.linearRampToValueAtTime(up ? 880 : 240, now + 0.65);
    f.Q.value = 2.4;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    src.connect(f).connect(g).connect(dest);
    src.start(now);

    // Mechanical uplock/downlock clunk at end of travel
    const clunk = ctx.createOscillator();
    clunk.type = 'sine';
    clunk.frequency.setValueAtTime(115, now + 0.62);
    clunk.frequency.exponentialRampToValueAtTime(42, now + 0.74);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.001, now + 0.61);
    cg.gain.linearRampToValueAtTime(0.18, now + 0.625);
    cg.gain.exponentialRampToValueAtTime(0.001, now + 0.76);
    clunk.connect(cg).connect(dest);
    clunk.start(now + 0.61);
    clunk.stop(now + 0.78);
  }

  thump(strength = 1) {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dest = this.nodes.sfxBus;
    const s = clamp(strength, 0.1, 1.2);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(115, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.32);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.48 * s, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc.connect(g).connect(dest);
    osc.start(now);
    osc.stop(now + 0.48);

    // Brief tire scrub burst
    const scrub = ctx.createBufferSource();
    scrub.buffer = this.nodes.whiteBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1850, now);
    bp.frequency.exponentialRampToValueAtTime(650, now + 0.14);
    bp.Q.value = 2.2;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.14 * s, now);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    scrub.connect(bp).connect(sg).connect(dest);
    scrub.start(now, Math.random() * 2.0, 0.18);
  }

  crash() {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this._engineAlive = false;
    this.nodes.engineBus.gain.setTargetAtTime(0, now, 0.06);

    const src = ctx.createBufferSource();
    const len = Math.floor(ctx.sampleRate * 2.2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const e = Math.pow(1 - i / len, 2.2);
      d[i] = (Math.random() * 2 - 1) * e;
    }
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2400, now);
    f.frequency.exponentialRampToValueAtTime(120, now + 1.85);
    const g = ctx.createGain();
    g.gain.value = 0.85;
    src.connect(f).connect(g).connect(this.nodes.sfxBus);
    src.start(now);
  }

  click() {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.055, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    osc.connect(g).connect(this.nodes.sfxBus);
    osc.start(now);
    osc.stop(now + 0.045);
  }
}
