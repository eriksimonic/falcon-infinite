// Visual keyboard + categorized reference control map shared by Menu and ESC Pause.
const KEY_ROWS = [
  [
    { k: '1', s: 'GUN', c: 'cbt' },
    { k: '2', s: 'AIM9', c: 'cbt' },
    { k: '3', s: 'MK82', c: 'cbt' },
    { k: '[', s: '-1H', c: 'wld' },
    { k: ']', s: '+1H', c: 'wld' },
  ],
  [
    { k: 'TAB', s: 'WPN', c: 'cbt', w: 1.4 },
    { k: 'Q', s: 'YAW', c: 'flt' },
    { k: 'W', s: 'DWN', c: 'flt' },
    { k: 'E', s: 'YAW', c: 'flt' },
    { k: 'R', s: 'RST', c: 'sys' },
    { k: 'T', s: 'TIM', c: 'wld' },
    { k: 'Y', s: 'WX', c: 'wld' },
    { k: 'U', s: 'WND', c: 'wld' },
    { k: 'O', s: 'ZM', c: 'sys' },
  ],
  [
    { k: 'A', s: 'ROL', c: 'flt' },
    { k: 'S', s: 'UP', c: 'flt' },
    { k: 'D', s: 'ROL', c: 'flt' },
    { k: 'F', s: 'FLP', c: 'flt' },
    { k: 'G', s: 'GER', c: 'flt' },
    { k: 'H', s: 'HLP', c: 'sys' },
    { k: 'J', s: 'EJC', c: 'cbt' },
    { k: 'K', s: 'MAP', c: 'sys' },
    { k: 'L', s: 'WNG', c: 'sys' },
  ],
  [
    { k: '⇧', s: 'THR+', c: 'flt', w: 1.5 },
    { k: 'Z', s: 'AP', c: 'sys' },
    { k: 'X', s: 'FLR', c: 'cbt' },
    { k: 'C', s: 'CAM', c: 'wld' },
    { k: 'V', s: 'VIEW', c: 'wld' },
    { k: 'B', s: 'BRK', c: 'flt' },
    { k: 'N', s: 'NVG', c: 'cbt' },
    { k: 'M', s: 'MUT', c: 'sys' },
  ],
  [
    { k: 'CTRL', s: 'THR-', c: 'flt', w: 1.6 },
    { k: 'SPACE', s: 'FIRE WEAPON', c: 'cbt', w: 4.2 },
    { k: 'ESC', s: 'PAUSE', c: 'sys', w: 1.5 },
  ],
];

const CONTROL_GROUPS = [
  {
    title: 'FLIGHT',
    cls: 'flt',
    items: [
      [['W', 'S'], 'Pitch down / up'],
      [['A', 'D'], 'Roll left / right'],
      [['Q', 'E'], 'Rudder / steer'],
      [['⇧', 'CTRL'], 'Throttle + / −'],
      [['G', 'F'], 'Gear / Flaps'],
      [['B'], 'Brakes / airbrake'],
    ],
  },
  {
    title: 'COMBAT',
    cls: 'cbt',
    items: [
      [['SPC'], 'Fire weapon'],
      [['TAB'], 'Cycle weapon'],
      [['1', '2', '3'], 'GUN / AIM-9 / MK-82'],
      [['X'], 'Deploy flares'],
      [['N'], 'NVG night vision'],
      [['J'], 'ACES II eject'],
    ],
  },
  {
    title: 'SYSTEMS',
    cls: 'sys',
    items: [
      [['Z'], 'Autopilot mode'],
      [['K', 'O'], 'Kneeboard / zoom'],
      [['L'], 'Toggle wingman'],
      [['R'], 'Reset to runway'],
      [['M'], 'Mute audio'],
    ],
  },
  {
    title: 'VIEW & WORLD',
    cls: 'wld',
    items: [
      [['V'], 'Cockpit view'],
      [['C'], 'Camera cycle / flyby'],
      [['Y', 'U'], 'Weather / wind'],
      [['T'], 'Time scale'],
      [['[', ']'], 'Time − / + 1h'],
      [['F2', 'F4'], 'Replay / replay speed'],
      [['F1', 'F3'], 'Hide UI / Perf'],
    ],
  },
];

function renderControlMap(el) {
  if (!el) return;
  const kbdRows = KEY_ROWS.map((row) =>
    `<div class="kb-row">${row.map((key) => {
      const style = key.w ? ` style="flex:${key.w}"` : '';
      return `<div class="kb-cap kb-${key.c}"${style}><b>${key.k}</b><i>${key.s}</i></div>`;
    }).join('')}</div>`
  ).join('');

  const legend = `
    <div class="kb-legend">
      <span class="leg-flt"><i></i>FLIGHT</span>
      <span class="leg-cbt"><i></i>COMBAT</span>
      <span class="leg-sys"><i></i>SYSTEMS</span>
      <span class="leg-wld"><i></i>VIEW/WORLD</span>
    </div>
  `;

  const groups = CONTROL_GROUPS.map((g) => `
    <div class="cm-group">
      <div class="cm-head cm-${g.cls}">${g.title}</div>
      <div class="cm-list">${g.items.map(([keys, label]) =>
        `<div class="cm-item"><span class="cm-keys">${keys.map((k) => `<kbd class="k-${g.cls}">${k}</kbd>`).join('')}</span><span class="cm-lbl">${label}</span></div>`
      ).join('')}</div>
    </div>
  `).join('');

  el.innerHTML = `<div class="kb-board">${kbdRows}</div>${legend}<div class="cm-groups">${groups}</div>`;
}

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

    renderControlMap(this.$('menu-control-map'));
    renderControlMap(this.$('pause-control-map'));

    this.mission = 'free';
    this.theater = 'temperate';
    this.weather = 'few';
    this.wind = 'auto';
    this.quality = 'medium';
    this.hour = 15.5;

    this._bindPills('opt-mission', (v) => { this.mission = v; this.cb.onMission?.(v); });
    this._bindPills('opt-theater', (v) => { this.theater = v; this.cb.onTheater?.(v); });
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