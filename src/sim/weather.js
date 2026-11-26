// Weather presets with smooth transitions, multi-layer 3D wind field, gusts,
// altitude shear/jetstream, thermals/ridge drafts, turbulence and rain.
import { WEATHER, WIND } from '../config.js';
import { noise2, clamp, lerp } from '../world/noise.js';

const KEYS = ['coverage', 'density', 'rain', 'fog', 'turbulence', 'visibility', 'cloudBase', 'windSpeed'];

export class WeatherSystem {
  constructor(preset = 'few', windPreset = 'auto') {
    this.presetName = preset;
    this.windPresetName = WIND[windPreset] ? windPreset : 'auto';
    const p = WEATHER[preset];
    this.target = { ...p };
    this.state = {
      ...p,
      overcast: 0,
      windX: 0,
      windZ: 0,
      gust: 0,
      gustSpeed: 0,
      gustiness: 0.35,
      time: 0,
    };
    this.windAngle = 0.7;
    this.flash = 0;
    this._nextFlash = 8;
    this._gustPhase = Math.random() * 100;
    this._gustPulse = 0;
    this._gustTarget = 0;
    this._nextGust = 2.5;
    this._applyTarget(1);
  }

  setPreset(name, instant = false) {
    if (!WEATHER[name]) return;
    this.presetName = name;
    this.target = { ...WEATHER[name] };
    this._syncWindTarget();
    if (instant) this._applyTarget(1);
  }

  setWindPreset(name, instant = false) {
    if (!WIND[name]) return;
    this.windPresetName = name;
    this._syncWindTarget();
    if (instant) this._applyTarget(1);
  }

  _syncWindTarget() {
    const wp = WEATHER[this.presetName];
    const windCfg = WIND[this.windPresetName] || WIND.auto;
    this.target.windSpeed = windCfg.speed != null ? windCfg.speed : wp.windSpeed;
    this.target.turbulence = windCfg.turbulence != null
      ? Math.max(windCfg.turbulence, wp.turbulence * 0.5)
      : wp.turbulence;
  }

  _applyTarget(t) {
    for (const k of KEYS) {
      this.state[k] = lerp(this.state[k], this.target[k], t);
    }
    this.state.overcast = clamp((this.state.coverage - 0.35) / 0.65, 0, 1);
    const windCfg = WIND[this.windPresetName] || WIND.auto;
    const targetGustiness = windCfg.gustiness != null
      ? windCfg.gustiness
      : clamp(this.state.turbulence * 0.65 + this.state.windSpeed / 28, 0.1, 1.0);
    this.state.gustiness = lerp(this.state.gustiness, targetGustiness, t);
  }

  update(dt) {
    this.state.time += dt;
    // with time acceleration the sky changes faster but weather itself is slow
    const t = 1 - Math.pow(0.001, dt);
    this._applyTarget(t);

    // slowly veering base wind direction
    this.windAngle += dt * 0.0055;

    // dynamic rolling gusts (organic swell & decay every 3-10 seconds)
    this._gustPhase += dt;
    this._nextGust -= dt;
    if (this._nextGust <= 0) {
      const g = this.state.gustiness;
      this._nextGust = 2.5 + Math.random() * (6.5 - g * 3.0);
      this._gustTarget = (0.35 + Math.random() * 0.65) * g;
    } else {
      this._gustTarget = Math.max(0, this._gustTarget - dt * 0.22);
    }
    const rise = this._gustTarget > this._gustPulse ? 1.8 : 0.65;
    this._gustPulse += (this._gustTarget - this._gustPulse) * (1 - Math.exp(-rise * dt));

    const waveGust = Math.max(
      0,
      0.5 + 0.5 * Math.sin(this._gustPhase * 0.53) * Math.cos(this._gustPhase * 0.29 + 1.2),
    ) * this.state.gustiness * 0.45;

    const gustLevel = clamp(this._gustPulse + waveGust, 0, 1);
    const gustExtra = gustLevel * (2.5 + this.state.windSpeed * 0.55);
    this.state.gust = gustLevel;
    this.state.gustSpeed = gustExtra;

    const effSpeed = this.state.windSpeed + gustExtra * 0.45;
    this.state.windX = Math.cos(this.windAngle) * effSpeed;
    this.state.windZ = Math.sin(this.windAngle) * effSpeed;

    // lightning in storms
    this.flash = Math.max(0, this.flash - dt * 6);
    if (this.state.rain > 0.35) {
      this._nextFlash -= dt;
      if (this._nextFlash <= 0) {
        this._nextFlash = 4 + Math.random() * 12;
        this.flash = 0.6 + Math.random() * 0.8;
      }
    }
  }

  /**
   * Local 3D wind vector in m/s at world (x, z, alt).
   * Models boundary-layer shear, Ekman altitude veer, upper-level jetstream,
   * spatially coherent gusts, and convective/orographic vertical drafts.
   */
  windAt(x, z, alt, out, terrainSlope = 0) {
    const t = this.state.time;
    const h = Math.max(0, alt || 0);

    // Boundary-layer friction near ground, smooth strengthening + upper jetstream.
    const blFactor = 0.72 + 0.28 * clamp(h / 260, 0, 1);
    const midShear = 1 + Math.min(0.65, h / 5500);
    const jetCenter = 9500;
    const jetBand = Math.exp(-Math.pow((h - jetCenter) / 3400, 2));
    const jetExtra = jetBand * (8 + this.state.windSpeed * 0.75);

    // Altitude veering (wind turns clockwise ~28 deg with height).
    const veer = clamp(h / 6500, 0, 1) * 0.48;
    const ang = this.windAngle + veer;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);

    // 2-octave spatial gust field moving with the wind.
    const advX = x - this.state.windX * t * 0.35;
    const advZ = z - this.state.windZ * t * 0.35;
    const n1 = noise2(advX * 0.00055, advZ * 0.00055, 301);
    const n2 = noise2(advX * 0.0018 + t * 0.14, advZ * 0.0018 - t * 0.11, 307);
    const crossN = noise2(advX * 0.0009 + 41, advZ * 0.0009 - 19, 311);

    const gustScale = (0.35 + this.state.gust * 0.95) * (1.8 + this.state.turbulence * 4.8);
    const alongGust = (n1 * 0.65 + n2 * 0.35) * gustScale + this.state.gustSpeed * 0.55;
    const crossGust = crossN * gustScale * 0.55;

    const baseMag = (this.state.windSpeed * blFactor * midShear) + jetExtra + alongGust;
    out.x = cosA * baseMag - sinA * crossGust;
    out.z = sinA * baseMag + cosA * crossGust;

    // Vertical drafts: thermals/turbulence + gentle ridge lift over sloped terrain.
    const thermal = noise2(advX * 0.00075, advZ * 0.00075 + t * 0.08, 303);
    const turbVert = noise2(x * 0.0022 + t * 0.25, z * 0.0022, 313);
    const ridgeLift = clamp(terrainSlope, 0, 0.8) * Math.min(14, Math.hypot(out.x, out.z)) * 0.22;
    const groundDamp = clamp(h / 45, 0.05, 1);
    out.y = (thermal * (1.4 + this.state.turbulence * 2.2) + turbVert * this.state.turbulence * 1.6 + ridgeLift) * groundDamp;
    return out;
  }
}
