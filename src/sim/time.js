// Simulated clock and time acceleration.
import { CONFIG } from '../config.js';

export class TimeSystem {
  constructor() {
    this.hour = CONFIG.time.startHour;
    this.scaleIndex = CONFIG.time.scaleIndex;
    this.dayLengthSeconds = CONFIG.time.dayLengthSeconds;
    this.paused = false;
  }

  get scale() {
    return CONFIG.time.scales[this.scaleIndex];
  }

  get scaleLabel() {
    return '×' + this.scale;
  }

  setScaleIndex(i) {
    this.scaleIndex = (i + CONFIG.time.scales.length) % CONFIG.time.scales.length;
    return this.scale;
  }

  cycleScale() {
    return this.setScaleIndex(this.scaleIndex + 1);
  }

  setHour(h) {
    this.hour = ((h % 24) + 24) % 24;
  }

  addHours(d) {
    this.setHour(this.hour + d);
  }

  update(dt) {
    if (this.paused) return;
    // 24h per dayLengthSeconds at ×1
    this.hour += dt * (24 / this.dayLengthSeconds) * this.scale;
    this.hour = ((this.hour % 24) + 24) % 24;
  }

  get clock() {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  get phase() {
    const h = this.hour;
    if (h < 5) return 'NIGHT';
    if (h < 7.5) return 'DAWN';
    if (h < 11) return 'MORNING';
    if (h < 14) return 'MIDDAY';
    if (h < 18) return 'AFTERNOON';
    if (h < 20.5) return 'DUSK';
    return 'NIGHT';
  }
}