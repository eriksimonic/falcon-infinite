// Hold-H Smart Autopilot Command Prompt + Live Flight Plan HUD strip.
//
// Two pieces of cockpit glass, both owned by this module:
//  * `#ap-command-prompt` — a compact, centred tactical card (z-index 70) that
//    fades in while `open === true`. Every operation is reachable by clicking
//    its row OR by pressing a single digit (1-3 nearest airbases, 4 tanker,
//    5 altitude/heading hold, 0 disengage) — and Esc cancels.
//  * `#ap-plan-strip` — a non-blocking top-centre pill (z-index 45,
//    `pointer-events: none`) that appears only while AUTO_LAND / AUTO_REFUEL is
//    engaged and renders the live leg pipeline (done / active / pending).
//
// Design notes
// ------------
// * 100% headless-safe: without `document` the constructor only holds state and
//   `show()` / `handleKey()` / `updatePlanStrip()` remain fully functional for
//   Node tests — no DOM access is ever attempted.
// * `handleKey()` is pure routing: `main.js` owns the global key listener, so
//   this module never installs a window-level keyboard hook (no double fires).
// * The strip rebuilds its markup only when the summary text actually changes,
//   and toggles visibility only on state transitions, so a 60 Hz producer can
//   call `updatePlanStrip()` every frame without thrashing layout.
// * All styling lives in one injected `<style id="autopilot-prompt-styles">`
//   to match the dark-glass / cyan-emerald HUD language of the other panels.

const STYLE_ID = 'autopilot-prompt-styles';
const PROMPT_ID = 'ap-command-prompt';
const STRIP_ID = 'ap-plan-strip';

const LAND_STEPS = ['PATTERN', 'INTERCEPT', 'FINAL', 'FLARE', 'ROLLOUT'];
const REFUEL_STEPS = ['RENDEZVOUS', 'JOIN', 'CONTACT'];

const MODE_LABEL = {
  AUTO_LAND: 'AUTO-LAND',
  AUTO_REFUEL: 'AUTO-REFUEL',
  ALT_HDG: 'ALT & HDG',
  ATT: 'ATT HOLD',
};

const STYLES = `
#${PROMPT_ID} {
  position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(120% 90% at 50% 45%, rgba(4, 10, 14, 0.42), rgba(2, 5, 8, 0.72));
  font-family: "JetBrains Mono", Consolas, ui-monospace, monospace;
  letter-spacing: 0.06em; color: #d3e8f2;
  -webkit-font-smoothing: antialiased;
}
#${PROMPT_ID}.ap-hidden { display: none; }

#${PROMPT_ID} .ap-card {
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  display: flex; flex-direction: column; gap: 9px;
  padding: 13px 14px 11px;
  background: rgba(7, 14, 20, 0.90);
  border: 1px solid rgba(90, 235, 190, 0.35);
  border-radius: 7px;
  box-shadow:
    0 22px 60px rgba(0, 0, 0, 0.62),
    inset 0 0 0 1px rgba(90, 235, 190, 0.06),
    0 0 26px rgba(90, 235, 190, 0.07);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  overflow: hidden;
}

#${PROMPT_ID} .ap-head {
  display: flex; align-items: center; gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(90, 235, 190, 0.16);
}
#${PROMPT_ID} .ap-title {
  flex: 1 1 auto; min-width: 0;
  font-size: 10px; font-weight: 600; letter-spacing: 0.14em;
  color: #5eebbe; text-shadow: 0 0 14px rgba(90, 235, 190, 0.32);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#${PROMPT_ID} .ap-title .ap-dim { color: #5f7d88; font-weight: 500; }
#${PROMPT_ID} .ap-badge {
  flex: 0 0 auto;
  font-size: 8px; letter-spacing: 0.12em;
  padding: 3px 6px; border-radius: 3px;
  color: #8fa8b6;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(140, 175, 190, 0.25);
  white-space: nowrap;
}
#${PROMPT_ID} .ap-badge.ap-badge-active {
  color: #d8fff2;
  background: rgba(90, 235, 190, 0.14);
  border-color: rgba(90, 235, 190, 0.55);
  box-shadow: 0 0 12px rgba(90, 235, 190, 0.18);
}

#${PROMPT_ID} .ap-options {
  display: flex; flex-direction: column; gap: 5px;
  overflow-y: auto; overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgba(90, 235, 190, 0.35) transparent;
}
#${PROMPT_ID} .ap-options::-webkit-scrollbar { width: 5px; }
#${PROMPT_ID} .ap-options::-webkit-scrollbar-thumb {
  background: rgba(90, 235, 190, 0.28); border-radius: 3px;
}

#${PROMPT_ID} .ap-opt {
  appearance: none; -webkit-appearance: none;
  display: flex; align-items: flex-start; gap: 9px;
  width: 100%; padding: 7px 8px;
  font-family: inherit; font-size: 10px; text-align: left;
  color: #cfe6f2;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(90, 235, 190, 0.16);
  border-radius: 4px;
  cursor: pointer;
  transition: background 110ms ease, border-color 110ms ease, box-shadow 110ms ease;
}
#${PROMPT_ID} .ap-opt:hover:not(:disabled) {
  background: rgba(90, 235, 190, 0.10);
  border-color: rgba(90, 235, 190, 0.48);
  box-shadow: inset 0 0 0 1px rgba(90, 235, 190, 0.10);
}
#${PROMPT_ID} .ap-opt:focus-visible {
  outline: 1px solid rgba(90, 235, 190, 0.7);
  outline-offset: 1px;
}
#${PROMPT_ID} .ap-opt:disabled { opacity: 0.38; cursor: default; }

#${PROMPT_ID} .ap-key {
  flex: 0 0 auto; width: 18px; height: 18px; margin-top: 1px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 600; letter-spacing: 0;
  color: #9ff6d9;
  background: rgba(90, 235, 190, 0.10);
  border: 1px solid rgba(90, 235, 190, 0.38);
  border-radius: 3px;
}
#${PROMPT_ID} .ap-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
#${PROMPT_ID} .ap-line {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  font-size: 10px; line-height: 1.35;
}
#${PROMPT_ID} .ap-op { color: #effcff; font-weight: 600; letter-spacing: 0.08em; }
#${PROMPT_ID} .ap-sep { color: #4c6a76; }
#${PROMPT_ID} .ap-target { color: #a8c6d4; }
#${PROMPT_ID} .ap-sub {
  font-size: 8.5px; line-height: 1.4;
  color: #7290a0; letter-spacing: 0.07em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#${PROMPT_ID} .ap-tag {
  font-size: 7.5px; letter-spacing: 0.1em;
  padding: 1px 4px; border-radius: 2px;
  color: #9ff6d9;
  background: rgba(90, 235, 190, 0.12);
  border: 1px solid rgba(90, 235, 190, 0.38);
}
#${PROMPT_ID} .ap-tag.ap-warn {
  color: #ffd08a;
  background: rgba(255, 176, 74, 0.13);
  border-color: rgba(255, 176, 74, 0.45);
}

#${PROMPT_ID} .ap-opt.ap-danger { border-color: rgba(255, 138, 108, 0.42); }
#${PROMPT_ID} .ap-opt.ap-danger .ap-op { color: #ffb397; }
#${PROMPT_ID} .ap-opt.ap-danger .ap-key {
  color: #ffc4ad;
  background: rgba(255, 138, 108, 0.12);
  border-color: rgba(255, 138, 108, 0.45);
}
#${PROMPT_ID} .ap-opt.ap-danger:hover:not(:disabled) {
  background: rgba(255, 138, 108, 0.14);
  border-color: rgba(255, 138, 108, 0.7);
  box-shadow: inset 0 0 0 1px rgba(255, 138, 108, 0.12);
}

#${PROMPT_ID} .ap-empty {
  font-size: 9px; letter-spacing: 0.08em;
  color: #61798a;
  padding: 6px 8px;
  border: 1px dashed rgba(120, 160, 180, 0.22);
  border-radius: 4px;
}

#${PROMPT_ID} .ap-foot {
  font-size: 7.5px; line-height: 1.5; letter-spacing: 0.08em;
  color: #5d7784;
  border-top: 1px solid rgba(90, 235, 190, 0.13);
  padding-top: 7px;
  white-space: normal;
}

#${STRIP_ID} {
  position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
  z-index: 45; pointer-events: none;
  max-width: min(680px, calc(100vw - 24px));
  display: flex; flex-direction: column; gap: 3px;
  padding: 6px 12px 6px;
  background: rgba(7, 14, 20, 0.90);
  border: 1px solid rgba(90, 235, 190, 0.30);
  border-radius: 5px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(90, 235, 190, 0.05);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  font-family: "JetBrains Mono", Consolas, ui-monospace, monospace;
  color: #cfe6f2;
  letter-spacing: 0.06em;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
#${STRIP_ID}.ap-hidden { display: none; }

#${STRIP_ID} .ap-strip-top {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  white-space: nowrap;
}
#${STRIP_ID} .ap-strip-title {
  font-size: 9.5px; font-weight: 600; letter-spacing: 0.11em;
  color: #5eebbe; text-shadow: 0 0 12px rgba(90, 235, 190, 0.30);
}
#${STRIP_ID} .ap-strip-metric {
  font-size: 9px; color: #eafaff; font-variant-numeric: tabular-nums;
}
#${STRIP_ID} .ap-strip-hint {
  font-size: 7.5px; letter-spacing: 0.07em; color: #5d7784;
}
#${STRIP_ID} .ap-strip-steps {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: 8px; letter-spacing: 0.1em;
  font-variant-numeric: tabular-nums;
}
#${STRIP_ID} .ap-step { color: #55707d; white-space: nowrap; }
#${STRIP_ID} .ap-step.ap-done { color: #4f8f74; }
#${STRIP_ID} .ap-step.ap-active {
  color: #061512;
  background: rgba(90, 235, 190, 0.92);
  border-radius: 2px;
  padding: 1px 5px;
  font-weight: 600;
  box-shadow: 0 0 12px rgba(90, 235, 190, 0.35);
}
`;

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pickNum(...vals) {
  for (const v of vals) if (isFiniteNum(v)) return v;
  return null;
}

function fmtDist(m) {
  if (!isFiniteNum(m) || m < 0) return '—';
  if (m < 1000) return Math.round(m) + ' M';
  return (m / 1000).toFixed(1) + ' KM';
}

function fmtBearing(deg) {
  if (!isFiniteNum(deg)) return null;
  const d = Math.round(((deg % 360) + 360) % 360);
  return String(d).padStart(3, '0') + '°';
}

function fmtAlt(m) {
  if (!isFiniteNum(m)) return null;
  return Math.round(m).toLocaleString('en-US') + ' M';
}

function fmtEta(sec) {
  if (!isFiniteNum(sec) || sec < 0) return null;
  const total = Math.round(sec);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

/** '08/26', '08', ['08','26'], 8 -> normalised "08/26" / "08". */
function fmtRunway(rwy) {
  if (rwy == null) return '';
  if (Array.isArray(rwy)) {
    const parts = rwy.map((r) => String(r).trim()).filter(Boolean);
    return parts.join('/');
  }
  if (typeof rwy === 'number' && isFiniteNum(rwy)) {
    return String(Math.round(rwy)).padStart(2, '0');
  }
  return String(rwy).trim();
}

/** 0..1 ratio (or an already-percent value) -> integer percent, or null. */
function toPercent(v) {
  if (!isFiniteNum(v)) return null;
  const pct = v <= 1 ? v * 100 : v;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function isApActive(mode) {
  const m = String(mode || '').toUpperCase();
  return m !== '' && m !== 'OFF' && m !== 'MANUAL' && m !== 'NONE';
}

/** Digit1..Digit5 / Numpad0 / Escape -> '1'..'5', '0' (cancel) or ''. */
function normalizeKey(code) {
  if (typeof code !== 'string') return '';
  const raw = code.trim();
  if (raw === 'Escape' || raw === 'Esc') return 'ESC';
  const m = /^(?:Digit|Numpad)?([0-5])$/.exec(raw);
  return m ? m[1] : '';
}

/**
 * Collapse the many shapes a producer may hand us into
 * `[{ label, state }]` with state in done | active | pending.
 */
function normalizeSteps(summary) {
  const defaults = summary && summary.mode === 'AUTO_REFUEL' ? REFUEL_STEPS : LAND_STEPS;
  const raw = Array.isArray(summary && summary.steps) && summary.steps.length
    ? summary.steps
    : defaults;
  const activeName = String(
    (summary && (summary.activeStep || summary.active || summary.phase)) || ''
  ).toUpperCase();

  const out = [];
  for (const item of raw) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const label = item.trim().toUpperCase();
      if (!label) continue;
      if (label === activeName) out.push({ label, state: 'active' });
      else out.push({ label, state: '' });
      continue;
    }
    if (typeof item !== 'object') continue;
    const label = String(item.label || item.name || item.id || item.key || item.phase || '')
      .trim()
      .toUpperCase();
    if (!label) continue;
    let state = typeof item.state === 'string' ? item.state.toLowerCase() : '';
    if (state !== 'done' && state !== 'active' && state !== 'pending') state = '';
    if (!state && (item.done || item.complete || item.completed)) state = 'done';
    if (!state && (item.active || item.current)) state = 'active';
    if (!state && activeName && label === activeName) state = 'active';
    out.push({ label, state });
  }

  const activeIdx = out.findIndex((s) => s.state === 'active');
  return out.map((s, i) => {
    if (s.state) return s;
    if (activeIdx < 0) return { label: s.label, state: 'pending' };
    return { label: s.label, state: i < activeIdx ? 'done' : 'pending' };
  });
}

function stripMetric(summary) {
  const dist = pickNum(summary.distM, summary.distanceM, summary.remainingM, summary.rangeM);
  const eta = pickNum(summary.etaSec, summary.etaSeconds, summary.eta);
  const parts = [];
  if (dist != null) parts.push(fmtDist(dist));
  if (eta != null) parts.push('ETA ' + fmtEta(eta));
  if (summary.metric) parts.push(String(summary.metric));
  return parts.join(' · ');
}

export class AutopilotPromptUI {
  /**
   * @param {object} [callbacks]
   * @param {(airport:object)=>void} [callbacks.onSelectLand]
   * @param {()=>void} [callbacks.onSelectRefuel]
   * @param {()=>void} [callbacks.onSelectHold]
   * @param {()=>void} [callbacks.onDisengage]
   * @param {()=>void} [callbacks.onClose]
   */
  constructor(callbacks = {}) {
    const cb = callbacks && typeof callbacks === 'object' ? callbacks : {};
    this.callbacks = {
      onSelectLand: typeof cb.onSelectLand === 'function' ? cb.onSelectLand : null,
      onSelectRefuel: typeof cb.onSelectRefuel === 'function' ? cb.onSelectRefuel : null,
      onSelectHold: typeof cb.onSelectHold === 'function' ? cb.onSelectHold : null,
      onDisengage: typeof cb.onDisengage === 'function' ? cb.onDisengage : null,
      onClose: typeof cb.onClose === 'function' ? cb.onClose : null,
    };

    this.open = false;
    this.state = {
      airports: [],
      tanker: null,
      fuelPct: 1,
      onGround: false,
      apMode: 'OFF',
      apTarget: '',
      apPhase: '',
    };

    this.planSummary = null;

    this._entries = [];
    this._stripHtml = '';
    this._stripVisible = false;

    // DOM handles stay null in Node / headless.
    this.el = null;
    this.card = null;
    this.optionsEl = null;
    this.badgeEl = null;
    this.stripEl = null;

    this._onOverlayClick = null;
    this._onOptionsClick = null;
    this._disposed = false;

    if (typeof document === 'undefined' || !document) return;
    this._buildDom();
  }

  // ---------------------------------------------------------------- DOM setup

  _buildDom() {
    if (typeof document === 'undefined' || !document) return;

    const parent = document.body || document.documentElement;
    if (!parent) return;

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLES;
      (document.head || parent).appendChild(style);
    }

    if (!this.el) {
      const root = document.createElement('div');
      root.id = PROMPT_ID;
      root.className = 'ap-hidden';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', 'Smart autopilot command prompt');
      root.innerHTML = [
        '<div class="ap-card" role="document">',
        '  <div class="ap-head">',
        '    <div class="ap-title">SMART AUTOPILOT <span class="ap-dim">·</span> SELECT OPERATION</div>',
        '    <div class="ap-badge" data-role="mode-badge">MANUAL</div>',
        '  </div>',
        '  <div class="ap-options" data-role="options"></div>',
        '  <div class="ap-foot">PRESS 1-5 OR CLICK · 0 DISENGAGE · ESC CANCEL · TAP H FOR CONTROLS HELP</div>',
        '</div>',
      ].join('\n');

      this._onOverlayClick = (ev) => {
        if (!this.open || !this.el) return;
        if (ev.target === this.el) this.hide(true);
      };
      root.addEventListener('click', this._onOverlayClick);

      this.el = root;
      this.card = root.querySelector('.ap-card');
      this.optionsEl = root.querySelector('[data-role="options"]');
      this.badgeEl = root.querySelector('[data-role="mode-badge"]');

      this._onOptionsClick = (ev) => {
        if (!this.open || !this.optionsEl) return;
        const target = ev.target;
        const btn = target && target.closest ? target.closest('[data-key]') : null;
        if (!btn || !this.optionsEl.contains(btn) || btn.disabled) return;
        ev.preventDefault();
        this._activateKey(btn.getAttribute('data-key'));
      };
      this.optionsEl.addEventListener('click', this._onOptionsClick);

      parent.appendChild(root);
    }

    if (!this.stripEl) {
      const strip = document.createElement('div');
      strip.id = STRIP_ID;
      strip.className = 'ap-hidden';
      strip.setAttribute('aria-live', 'off');
      this.stripEl = strip;
      this._stripVisible = false;
      parent.appendChild(strip);
    }
  }

  // ------------------------------------------------------------------ prompt

  /**
   * Render a fresh option list and open the command prompt.
   * Safe with partial state — every field falls back to the previous value.
   */
  show(state = {}) {
    const s = state && typeof state === 'object' ? state : {};
    const prev = this.state;

    this.state = {
      airports: Array.isArray(s.airports) ? s.airports.filter(Boolean) : [],
      tanker: s.tanker && typeof s.tanker === 'object' ? s.tanker : null,
      fuelPct: isFiniteNum(s.fuelPct) ? s.fuelPct : prev.fuelPct,
      onGround: typeof s.onGround === 'boolean' ? s.onGround : prev.onGround,
      apMode: typeof s.apMode === 'string' && s.apMode ? s.apMode : prev.apMode,
      apTarget: typeof s.apTarget === 'string' ? s.apTarget : prev.apTarget,
      apPhase: typeof s.apPhase === 'string' ? s.apPhase : prev.apPhase,
    };

    this.open = true;
    this._entries = this._buildEntries(this.state);
    this._render();

    if (this.el) this.el.classList.remove('ap-hidden');
    return this;
  }

  /** Hide the prompt; `notifyClose: true` fires `onClose()` (Esc / backdrop). */
  hide(notifyClose = false) {
    const wasOpen = this.open;
    this.open = false;
    if (this.el) this.el.classList.add('ap-hidden');
    if (notifyClose && wasOpen && this.callbacks.onClose) {
      this.callbacks.onClose();
    }
    return this;
  }

  /**
   * Route a KeyboardEvent.code while the prompt is open.
   * @returns {boolean} true when the key belonged to the prompt (consumed).
   */
  handleKey(code) {
    if (!this.open || this._disposed) return false;
    const key = normalizeKey(code);
    if (!key) return false;
    return this._activateKey(key);
  }

  _buildEntries(state) {
    const entries = [];

    const airports = state.airports.slice().sort((a, b) => {
      const da = pickNum(a && a.distM, a && a.distanceM);
      const db = pickNum(b && b.distM, b && b.distanceM);
      return (da == null ? Infinity : da) - (db == null ? Infinity : db);
    });
    airports.slice(0, 3).forEach((airport, i) => {
      entries.push({ key: String(i + 1), kind: 'land', airport, nearest: i === 0, disabled: false });
    });

    entries.push({
      key: '4',
      kind: 'refuel',
      disabled: !!state.onGround || !state.tanker,
    });
    entries.push({
      key: '5',
      kind: 'hold',
      disabled: !!state.onGround,
    });
    entries.push({
      key: '0',
      kind: isApActive(state.apMode) ? 'disengage' : 'cancel',
      danger: isApActive(state.apMode),
      disabled: false,
    });

    return entries;
  }

  _render() {
    this._renderBadge();
    if (!this.optionsEl) return;
    this.optionsEl.innerHTML = this._renderOptionsHtml();
  }

  _renderBadge() {
    if (!this.badgeEl) return;
    const active = isApActive(this.state.apMode);
    const label = MODE_LABEL[this.state.apMode] || String(this.state.apMode).replace(/_/g, ' ');
    const target = this.state.apTarget ? ' ' + this.state.apTarget : '';
    this.badgeEl.textContent = active ? 'ACTIVE: ' + label + target : 'MANUAL';
    this.badgeEl.classList.toggle('ap-badge-active', active);
  }

  _renderOptionsHtml() {
    const rows = [];
    for (const entry of this._entries) {
      if (entry.kind === 'land') rows.push(this._landRow(entry));
      else if (entry.kind === 'refuel') rows.push(this._refuelRow(entry));
      else if (entry.kind === 'hold') rows.push(this._holdRow(entry));
      else if (entry.kind === 'disengage') rows.push(this._disengageRow(entry));
      else if (entry.kind === 'cancel') rows.push(this._cancelRow(entry));
    }

    if (!this._entries.some((e) => e.kind === 'land')) {
      rows.unshift('<div class="ap-empty">NO AIRBASE IN RANGE</div>');
    }
    return rows.join('\n');
  }

  _rowOpen(entry, extraClass = '') {
    const cls = ['ap-opt', extraClass].filter(Boolean).join(' ');
    return (
      '<button type="button" class="' + cls + '" data-key="' + esc(entry.key) + '"' +
      (entry.disabled ? ' disabled aria-disabled="true"' : '') + '>'
    );
  }

  _landRow(entry) {
    const ap = entry.airport || {};
    const code = ap.code || ap.icao || ap.id || '----';
    const name = ap.name || ap.label || '';
    const dist = pickNum(ap.distM, ap.distanceM);
    const bearing = fmtBearing(pickNum(ap.bearingDeg, ap.bearing, ap.brgDeg));
    const rwy = fmtRunway(ap.rwy != null ? ap.rwy : ap.runway != null ? ap.runway : ap.runways);
    const elev = fmtAlt(pickNum(ap.elevM, ap.elevation, ap.elevationM, ap.elev));

    const sub = [fmtDist(dist)];
    if (bearing) sub.push('BRG ' + bearing);
    if (rwy) sub.push('RWY ' + rwy);
    if (elev) sub.push('ELEV ' + elev);

    return [
      this._rowOpen(entry),
      '<span class="ap-key">' + esc(entry.key) + '</span>',
      '<span class="ap-body">',
      '  <span class="ap-line">',
      '    <span class="ap-op">AUTO-LAND</span>',
      '    <span class="ap-sep">·</span>',
      '    <span class="ap-target">' + esc(code) + (name ? ' ' + esc(name) : '') + '</span>',
      entry.nearest ? '    <span class="ap-tag">NEAREST</span>' : '',
      '  </span>',
      '  <span class="ap-sub">' + esc(sub.join(' · ')) + '</span>',
      '</span>',
      '</button>',
    ].filter(Boolean).join('\n');
  }

  _refuelRow(entry) {
    const tanker = this.state.tanker || {};
    const dist = pickNum(tanker.distM, tanker.distanceM);
    const bearing = fmtBearing(pickNum(tanker.bearingDeg, tanker.bearing, tanker.brgDeg));
    const alt = fmtAlt(pickNum(tanker.altM, tanker.altitudeM, tanker.alt));
    const pct = toPercent(pickNum(tanker.fuelPct, tanker.fuel, this.state.fuelPct));
    const lowFuel = pct != null && pct < 30;

    const sub = [fmtDist(dist)];
    if (bearing) sub.push('BRG ' + bearing);
    if (alt) sub.push('ALT ' + alt);
    if (pct != null) sub.push('FUEL ' + pct + '%');

    return [
      this._rowOpen(entry),
      '<span class="ap-key">' + esc(entry.key) + '</span>',
      '<span class="ap-body">',
      '  <span class="ap-line">',
      '    <span class="ap-op">AUTO-REFUEL</span>',
      '    <span class="ap-sep">·</span>',
      '    <span class="ap-target">KC-135 TANKER</span>',
      lowFuel ? '    <span class="ap-tag ap-warn">LOW FUEL</span>' : '',
      '  </span>',
      '  <span class="ap-sub">' + esc(sub.join(' · ')) + '</span>',
      '</span>',
      '</button>',
    ].filter(Boolean).join('\n');
  }

  _holdRow(entry) {
    return [
      this._rowOpen(entry),
      '<span class="ap-key">' + esc(entry.key) + '</span>',
      '<span class="ap-body">',
      '  <span class="ap-line">',
      '    <span class="ap-op">CRUISE HOLD</span>',
      '    <span class="ap-sep">·</span>',
      '    <span class="ap-target">ALT &amp; HDG</span>',
      '  </span>',
      '  <span class="ap-sub">HOLD CURRENT ALTITUDE &amp; HEADING</span>',
      '</span>',
      '</button>',
    ].join('\n');
  }

  _disengageRow(entry) {
    return [
      this._rowOpen(entry, 'ap-danger'),
      '<span class="ap-key">' + esc(entry.key) + '</span>',
      '<span class="ap-body">',
      '  <span class="ap-line">',
      '    <span class="ap-op">DISENGAGE AUTOPILOT</span>',
      '    <span class="ap-sep">·</span>',
      '    <span class="ap-target">MANUAL CONTROL</span>',
      '  </span>',
      '  <span class="ap-sub">RETURN STICK &amp; THROTTLE TO PILOT</span>',
      '</span>',
      '</button>',
    ].join('\n');
  }

  _cancelRow(entry) {
    return [
      this._rowOpen(entry),
      '<span class="ap-key">' + esc(entry.key) + '</span>',
      '<span class="ap-body">',
      '  <span class="ap-line">',
      '    <span class="ap-op">CANCEL</span>',
      '    <span class="ap-sep">·</span>',
      '    <span class="ap-target">CLOSE PROMPT</span>',
      '  </span>',
      '  <span class="ap-sub">NO AUTOPILOT ENGAGED</span>',
      '</span>',
      '</button>',
    ].join('\n');
  }

  /**
   * Fire the callback for `key` ('1'..'5', '0', 'ESC').
   * Disabled rows consume the key but do nothing; returns true when consumed.
   */
  _activateKey(key) {
    if (key === 'ESC') {
      this.hide(true);
      return true;
    }
    const entry = this._entries.find((e) => e.key === key);
    if (!entry) return false;
    if (entry.disabled) return true;

    const cb = this.callbacks;
    this.hide(false);

    if (entry.kind === 'land' && cb.onSelectLand) cb.onSelectLand(entry.airport);
    else if (entry.kind === 'refuel' && cb.onSelectRefuel) cb.onSelectRefuel();
    else if (entry.kind === 'hold' && cb.onSelectHold) cb.onSelectHold();
    else if (entry.kind === 'disengage' && cb.onDisengage) cb.onDisengage();
    else if (entry.kind === 'cancel' && cb.onClose) cb.onClose();
    return true;
  }

  // -------------------------------------------------------------- plan strip

  /**
   * Show / refresh the live flight-plan pill. Callable every frame: markup is
   * rebuilt only when the rendered HTML string actually changes.
   */
  updatePlanStrip(planSummary, extra = {}) {
    this.planSummary = planSummary && typeof planSummary === 'object' ? planSummary : null;

    if (!this.planSummary) {
      this._stripHtml = '';
      this._setStripVisible(false);
      return this;
    }

    const mode = this.planSummary.mode;
    if (mode !== 'AUTO_LAND' && mode !== 'AUTO_REFUEL') {
      this._stripHtml = '';
      this._setStripVisible(false);
      return this;
    }

    const s = Object.assign({}, this.planSummary, extra && typeof extra === 'object' ? extra : {});

    const target = s.targetLabel || s.label || s.target || s.airportCode ||
      (s.airport && (s.airport.code || s.airport.icao)) || '';
    let title;
    let rwy = '';
    if (mode === 'AUTO_LAND') {
      rwy = fmtRunway(s.runway != null ? s.runway : s.rwy != null ? s.rwy : s.airport && s.airport.rwy);
      title = 'AUTOPILOT · AUTO-LAND ' + (target || 'AIRBASE') + (rwy ? ' (RWY ' + rwy.split('/')[0] + ')' : '');
    } else {
      title = 'AUTOPILOT · AUTO-REFUEL ' + (target || 'KC-135');
    }

    const metric = stripMetric(s);
    const stepsHtml = this._renderStepsHtml(normalizeSteps(s));

    const html = [
      '<div class="ap-strip-top">',
      '  <span class="ap-strip-title">' + esc(title) + '</span>',
      metric ? '  <span class="ap-strip-metric">' + esc(metric) + '</span>' : '',
      '  <span class="ap-strip-hint">[HOLD H: MENU · STICK: OVERRIDE]</span>',
      '</div>',
      '<div class="ap-strip-steps">' + stepsHtml + '</div>',
    ].filter(Boolean).join('\n');

    if (html !== this._stripHtml) {
      this._stripHtml = html;
      if (this.stripEl) this.stripEl.innerHTML = html;
    }
    this._setStripVisible(true);
    return this;
  }

  _renderStepsHtml(steps) {
    return steps.map((step) => {
      let cls = 'ap-step';
      let icon = '·';
      if (step.state === 'done') {
        cls += ' ap-done';
        icon = '✓';
      } else if (step.state === 'active') {
        cls += ' ap-active';
        icon = '▶';
      }
      return '<span class="' + cls + '">' + icon + ' ' + esc(step.label) + '</span>';
    }).join('');
  }

  _setStripVisible(visible) {
    if (this._stripVisible === visible) return;
    this._stripVisible = visible;
    if (this.stripEl) this.stripEl.classList.toggle('ap-hidden', !visible);
  }

  // ----------------------------------------------------------------- cleanup

  /** Remove every node, listener and injected style this instance created. */
  dispose() {
    this._disposed = true;
    this.open = false;

    if (this.optionsEl && this._onOptionsClick) {
      this.optionsEl.removeEventListener('click', this._onOptionsClick);
    }
    if (this.el && this._onOverlayClick) {
      this.el.removeEventListener('click', this._onOverlayClick);
    }
    this._onOptionsClick = null;
    this._onOverlayClick = null;

    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    if (this.stripEl && this.stripEl.parentNode) this.stripEl.parentNode.removeChild(this.stripEl);

    if (typeof document !== 'undefined' && document) {
      const style = document.getElementById(STYLE_ID);
      if (style && style.parentNode) style.parentNode.removeChild(style);
    }

    this.el = null;
    this.card = null;
    this.optionsEl = null;
    this.badgeEl = null;
    this.stripEl = null;
    this._entries = [];
    this._stripHtml = '';
    this._stripVisible = false;
    this.planSummary = null;
  }
}

export default AutopilotPromptUI;