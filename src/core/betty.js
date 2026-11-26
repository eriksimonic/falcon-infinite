// Bitching Betty — classic F-16 cockpit voice warnings.
//
// Uses the Web Speech API when it is available (sharp, fast delivery:
// pitch ~1.05, rate ~1.12). When TTS is missing, disabled or throws, it falls
// back to a "double chime" callback (`onChime(text, alertId)`) so the same
// alert flow works headless in Node tests and in browsers without voices.
//
// Priority-ordered alerts, each with its own cooldown so Betty never spams:
//   PULL_UP > MISSILE > STALL > OVERSPEED > BINGO > ALTITUDE
//
// The module never touches `window` at import time and is constructible in a
// plain Node process.

const ALERTS = [
  {
    id: 'PULL_UP',
    text: 'Pull up. Pull up.',
    cooldown: 3.5,
    test: (s) => s.pullUpOverride || (s.aglFt < 700 && s.vsFpm < -900),
  },
  {
    id: 'MISSILE',
    text: 'Chaff. Flare.',
    cooldown: 4.5,
    test: (s) => s.missileLaunch === true,
  },
  {
    id: 'STALL',
    text: 'Warning. Stall.',
    cooldown: 4.0,
    test: (s) => s.stall === true,
  },
  {
    id: 'OVERSPEED',
    text: 'Warning. Overspeed.',
    cooldown: 6.0,
    test: (s) => s.kts > 620,
  },
  {
    id: 'BINGO',
    text: 'Bingo fuel.',
    cooldown: 18.0,
    test: (s) => s.bingoFuel === true,
  },
  {
    id: 'ALTITUDE',
    text: 'Altitude. Altitude.',
    cooldown: 5.0,
    test: (s) => s.aglFt < 300 && s.vsFpm < -250,
  },
];

const num = (v, fb = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

function detectTTS() {
  try {
    if (typeof window === 'undefined') return null;
    const synth = window.speechSynthesis;
    if (!synth || typeof synth.speak !== 'function') return null;
    const Utter = window.SpeechSynthesisUtterance
      || (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null);
    if (!Utter) return null;
    return { synth, Utter };
  } catch (err) {
    return null;
  }
}

export class BitchingBetty {
  /**
   * @param {{ onChime?: (text: string, alertId: string) => void,
   *           enabled?: boolean, muted?: boolean }} [options]
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.enabled = opts.enabled !== false;
    this.muted = opts.muted === true;
    this.lastCallout = null;
    this.onChime = typeof opts.onChime === 'function' ? opts.onChime : null;

    const tts = detectTTS();
    this._synth = tts ? tts.synth : null;
    this._Utterance = tts ? tts.Utter : null;
    this.ttsAvailable = !!tts;

    this._clock = 0;
    this._next = Object.create(null); // alertId -> earliest next fire time
    this.chimeCount = 0;
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.muted && this._synth && typeof this._synth.cancel === 'function') {
      try {
        this._synth.cancel();
      } catch (err) {
        /* ignored */
      }
    }
    return this.muted;
  }

  /** Clear cooldowns (e.g. after a respawn). */
  reset() {
    this._clock = 0;
    this._next = Object.create(null);
  }

  /**
   * Evaluate alert conditions for this frame.
   * @param {number} dt seconds
   * @param {{onGround?:boolean, crashed?:boolean, aglFt?:number, vsFpm?:number,
   *          stall?:boolean, kts?:number, bingoFuel?:boolean,
   *          missileLaunch?:boolean, pullUpOverride?:boolean}} [state]
   * @returns {{spoke: string|null, alertId: string|null}}
   */
  update(dt, state) {
    const step = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? dt : 0;
    this._clock += step;

    const st = state && typeof state === 'object' ? state : {};
    const silent = !this.enabled
      || this.muted
      || st.crashed === true
      || st.onGround === true;
    if (silent) return { spoke: null, alertId: null };

    const s = {
      aglFt: num(st.aglFt, Infinity),
      vsFpm: num(st.vsFpm, 0),
      kts: num(st.kts, 0),
      stall: st.stall === true,
      bingoFuel: st.bingoFuel === true,
      missileLaunch: st.missileLaunch === true,
      pullUpOverride: st.pullUpOverride === true,
    };

    for (const alert of ALERTS) {
      const readyAt = this._next[alert.id];
      if (readyAt !== undefined && this._clock < readyAt) continue;

      let active = false;
      try {
        active = alert.test(s);
      } catch (err) {
        active = false;
      }
      if (!active) continue;

      this._next[alert.id] = this._clock + alert.cooldown;
      const spoke = this._speak(alert.text, alert.id);
      return { spoke, alertId: spoke ? alert.id : null };
    }

    return { spoke: null, alertId: null };
  }

  /**
   * Immediate one-shot callout (e.g. ILS "Five hundred", "Minimums").
   * Ignores per-alert cooldowns but honours mute/enabled.
   * @returns {boolean} true when the callout was emitted
   */
  announce(text) {
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message) return false;
    return !!this._speak(message, 'ANNOUNCE');
  }

  // ------------------------------------------------------------- internals
  _speak(text, alertId) {
    if (!this.enabled || this.muted) return null;
    this.lastCallout = text;

    if (this.ttsAvailable) {
      try {
        const u = new this._Utterance(text);
        u.lang = 'en-US';
        u.pitch = 1.05;
        u.rate = 1.12;
        u.volume = 0.95;
        if (typeof this._synth.cancel === 'function') this._synth.cancel();
        this._synth.speak(u);
        return text;
      } catch (err) {
        /* fall through to the chime fallback */
      }
    }

    this._chime(text, alertId);
    return text;
  }

  _chime(text, alertId) {
    this.chimeCount++;
    if (typeof this.onChime === 'function') {
      try {
        this.onChime(text, alertId);
      } catch (err) {
        /* a broken UI callback must never break flight */
      }
    }
  }
}