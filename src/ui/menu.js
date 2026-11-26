// DOM UI: boot, menu, pause, help, crash, toasts, ATC strip.
export class UI {
  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.$ = (id) => document.getElementById(id);
    this.boot = this.$('boot');
    this.bootBar = this.$('boot-bar');
    this.bootStatus = this.$('boot-status');
    this.menu = this.$('menu');
    this.pause = this.$('pause');
    this.help = this.$('help');
    this.crash = this.$('crash');
    this.toastEl = this.$('toast');
    this.debugEl = this.$('debug');
    this.atcEl = this.$('atc');
    this.pauseStats = this.$('pause-stats');
    this.crashReason = this.$('crash-reason');
    this.crashSub = this.$('crash-sub');

    this.weather = 'few';
    this.wind = 'auto';
    this.quality = 'medium';
    this.hour = 15.5;

    this._bindPills('opt-weather', (v) => { this.weather = v; this.cb.onWeather?.(v); });
    this._bindPills('opt-wind', (v) => { this.wind = v; this.cb.onWind?.(v); });
    this._bindPills('opt-quality', (v) => { this.quality = v; this.cb.onQuality?.(v); });
    this._bindPills('opt-time', (v) => { this.hour = parseFloat(v); this.cb.onTime?.(parseFloat(v)); });

    this.$('start-btn').addEventListener('click', () => this.cb.onStart?.());
    this.$('resume-btn').addEventListener('click', () => this.cb.onResume?.());
    this.$('respawn-btn').addEventListener('click', () => this.cb.onRespawn?.());
    this.$('menu-btn').addEventListener('click', () => this.cb.onMenu?.());
    this.$('help-close').addEventListener('click', () => this.hideHelp());
    this.$('crash-reset').addEventListener('click', () => this.cb.onRespawn?.());

    this._toastTimer = null;
    this._toastQueue = [];
    this._atcTimer = 0;
  }

  _bindPills(id, cb) {
    const root = this.$(id);
    if (!root) return;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      for (const x of root.querySelectorAll('button')) x.classList.remove('on');
      b.classList.add('on');
      cb(b.dataset.v);
    });
  }

  setBootProgress(p, text) {
    if (this.bootBar) this.bootBar.style.width = Math.round(p * 100) + '%';
    if (text && this.bootStatus) this.bootStatus.textContent = text;
  }

  hideBoot() {
    this.boot?.classList.add('hidden');
  }

  showMenu() {
    this.menu.classList.remove('hidden');
    this.pause.classList.add('hidden');
    this.crash.classList.add('hidden');
  }

  hideMenu() {
    this.menu.classList.add('hidden');
  }

  showPause(stats) {
    this.pause.classList.remove('hidden');
    if (stats) {
      this.pauseStats.innerHTML = stats;
    }
  }

  hidePause() {
    this.pause.classList.add('hidden');
  }

  toggleHelp() {
    this.help.classList.toggle('hidden');
    return !this.help.classList.contains('hidden');
  }

  hideHelp() {
    this.help.classList.add('hidden');
  }

  showCrash(reason) {
    this.crashReason.textContent = reason || 'IMPACT';
    this.crashSub.textContent = 'Airframe lost. Press R or reset to return to the runway.';
    this.crash.classList.remove('hidden');
  }

  hideCrash() {
    this.crash.classList.add('hidden');
  }

  toast(text, ms = 2200) {
    const item = document.createElement('div');
    item.className = 'item';
    item.textContent = text;
    this.toastEl.appendChild(item);
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.toastEl.classList.remove('show');
      setTimeout(() => {
        while (this.toastEl.firstChild) this.toastEl.removeChild(this.toastEl.firstChild);
      }, 300);
    }, ms);
  }

  setATC(html) {
    if (!this.atcEl) return;
    if (html) {
      this.atcEl.innerHTML = html;
      this.atcEl.classList.remove('hidden');
    } else {
      this.atcEl.classList.add('hidden');
    }
  }

  setDebug(text, visible) {
    if (!this.debugEl) return;
    this.debugEl.textContent = text;
    this.debugEl.classList.toggle('hidden', !visible);
  }
}