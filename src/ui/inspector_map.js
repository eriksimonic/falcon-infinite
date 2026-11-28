// Big interactive Environment Inspector & Click-to-Teleport Map (Ctrl+F -> M).
//
// Renders a shaded elevation relief map of the active theater (100x100 km
// Vipava Valley or procedural world), overlays real OSM rivers, highways,
// bridges, airports, towns, landmarks, the aircraft and the Free Camera cone.
// Clicking anywhere on the map teleports the Free Camera directly above that
// world coordinate for instant visual inspection and debugging.
//
// Headless-safe: all coordinate conversions work without a DOM; rendering only
// runs when a canvas element is attached.

import { terrainHeight, airportsNear } from '../world/terrain.js';

const M_PER_LAT = 111132.92;

export class InspectorMap {
  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.visible = false;
    this.spanM = 46000; // default view: core Vipava Valley + Nova Gorica + Nanos + Stanjel
    this.centerX = -6000;
    this.centerZ = -1000;
    this.clickAgl = 180;

    this._root = null;
    this._canvas = null;
    this._ctx = null;
    this._hoverEl = null;
    this._statsEl = null;
    this._listEl = null;
    this._aglBtns = [];
    this._timeInput = null;
    this._timeLabel = null;
    this._weatherSelect = null;

    this._reliefCache = null;
    this._reliefKey = '';
    this._hoverWorld = null;
    this._dragging = false;
    this._dragMoved = false;
    this._dragStart = { x: 0, y: 0, cx: 0, cz: 0 };
    this._data = {
      places: [],
      landmarks: [],
      airports: [],
      roads: [],
      water: null,
      geoOrigin: null,
    };
  }

  /** Attach DOM elements from index.html. Safe to skip in headless Node tests. */
  attach(rootEl) {
    if (!rootEl || typeof document === 'undefined') return;
    this._root = rootEl;
    this._canvas = rootEl.querySelector('#inspector-canvas');
    this._ctx = this._canvas ? this._canvas.getContext('2d') : null;
    this._hoverEl = rootEl.querySelector('#inspector-hover');
    this._statsEl = rootEl.querySelector('#inspector-stats');
    this._listEl = rootEl.querySelector('#inspector-list');
    this._timeInput = rootEl.querySelector('#inspector-time');
    this._timeLabel = rootEl.querySelector('#inspector-time-val');
    this._weatherSelect = rootEl.querySelector('#inspector-weather');

    const closeBtn = rootEl.querySelector('#inspector-close');
    closeBtn?.addEventListener('click', () => this.hide());

    const fitAllBtn = rootEl.querySelector('#inspector-fit-all');
    fitAllBtn?.addEventListener('click', () => {
      this.centerX = -5000;
      this.centerZ = 4000;
      this.spanM = 100000;
      this._reliefKey = '';
      this.render();
    });

    const fitValleyBtn = rootEl.querySelector('#inspector-fit-valley');
    fitValleyBtn?.addEventListener('click', () => {
      this.centerX = -6000;
      this.centerZ = -1000;
      this.spanM = 42000;
      this._reliefKey = '';
      this.render();
    });

    this._aglBtns = [...rootEl.querySelectorAll('[data-agl]')];
    for (const btn of this._aglBtns) {
      btn.addEventListener('click', () => {
        const v = Number(btn.dataset.agl);
        if (Number.isFinite(v) && v > 0) {
          this.clickAgl = v;
          for (const b of this._aglBtns) b.classList.toggle('on', b === btn);
        }
      });
    }

    this._timeInput?.addEventListener('input', () => {
      const h = Number(this._timeInput.value);
      if (Number.isFinite(h)) {
        this._updateTimeLabel(h);
        this.cb.onTime?.(h);
      }
    });

    this._weatherSelect?.addEventListener('change', () => {
      this.cb.onWeather?.(this._weatherSelect.value);
    });

    if (this._canvas) {
      this._canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0 || e.button === 2) {
          this._dragging = true;
          this._dragMoved = false;
          this._dragStart = {
            x: e.clientX,
            y: e.clientY,
            cx: this.centerX,
            cz: this.centerZ,
          };
        }
      });
      window.addEventListener('mousemove', (e) => {
        if (!this.visible || !this._canvas) return;
        const rect = this._canvas.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / Math.max(1, rect.width)) * this._canvas.width;
        const py = ((e.clientY - rect.top) / Math.max(1, rect.height)) * this._canvas.height;
        if (this._dragging) {
          const dxPx = e.clientX - this._dragStart.x;
          const dyPx = e.clientY - this._dragStart.y;
          if (Math.hypot(dxPx, dyPx) > 6) {
            this._dragMoved = true;
            const mPerPx = this.spanM / Math.max(1, rect.width);
            this.centerX = this._dragStart.cx - dxPx * mPerPx;
            this.centerZ = this._dragStart.cz - dyPx * mPerPx;
            this._reliefKey = '';
            this.render();
          }
          return;
        }
        if (px >= 0 && px <= this._canvas.width && py >= 0 && py <= this._canvas.height) {
          this._hoverWorld = this.canvasToWorld(px, py, this._canvas.width, this._canvas.height);
          this._updateHoverReadout();
        }
      });
      window.addEventListener('mouseup', (e) => {
        if (!this._dragging) return;
        const wasDrag = this._dragMoved;
        this._dragging = false;
        this._dragMoved = false;
        if (!this.visible || wasDrag || e.button !== 0 || !this._canvas) return;
        const rect = this._canvas.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
        const px = ((e.clientX - rect.left) / Math.max(1, rect.width)) * this._canvas.width;
        const py = ((e.clientY - rect.top) / Math.max(1, rect.height)) * this._canvas.height;
        const w = this.canvasToWorld(px, py, this._canvas.width, this._canvas.height);
        this.cb.onTeleport?.(w.x, w.z, this.clickAgl, !e.shiftKey);
      });
      this._canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = this._canvas.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / Math.max(1, rect.width)) * this._canvas.width;
        const py = ((e.clientY - rect.top) / Math.max(1, rect.height)) * this._canvas.height;
        const before = this.canvasToWorld(px, py, this._canvas.width, this._canvas.height);
        const factor = e.deltaY > 0 ? 1.28 : 1 / 1.28;
        this.spanM = Math.max(3000, Math.min(120000, this.spanM * factor));
        const after = this.canvasToWorld(px, py, this._canvas.width, this._canvas.height);
        this.centerX += before.x - after.x;
        this.centerZ += before.z - after.z;
        this._reliefKey = '';
        this.render();
      }, { passive: false });
      this._canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  /** Convert canvas pixel `(px, py)` to world `(x, z)` metres. */
  canvasToWorld(px, py, width, height) {
    const scale = this.spanM / Math.max(1, width);
    return {
      x: this.centerX + (px - width * 0.5) * scale,
      z: this.centerZ + (py - height * 0.5) * scale,
    };
  }

  /** Convert world `(x, z)` metres to canvas pixel `(px, py)`. */
  worldToCanvas(wx, wz, width, height) {
    const scale = Math.max(1, width) / this.spanM;
    return {
      px: width * 0.5 + (wx - this.centerX) * scale,
      py: height * 0.5 + (wz - this.centerZ) * scale,
    };
  }

  setTheaterData({ places = [], landmarks = [], roads = [], water = null, geoOrigin = null } = {}) {
    this._data.places = Array.isArray(places) ? places : [];
    this._data.landmarks = Array.isArray(landmarks) ? landmarks : [];
    this._data.roads = Array.isArray(roads) ? roads : [];
    this._data.water = water || null;
    this._data.geoOrigin = geoOrigin || null;
    this._reliefKey = '';
    this._rebuildQuickList();
  }

  show(state = {}) {
    this.visible = true;
    this._lastState = state;
    if (this._root) this._root.classList.remove('hidden');
    if (this._timeInput && Number.isFinite(state.hour)) {
      this._timeInput.value = String(state.hour);
      this._updateTimeLabel(state.hour);
    }
    if (this._weatherSelect && state.weather) {
      this._weatherSelect.value = state.weather;
    }
    this._rebuildQuickList();
    this.render(state);
  }

  hide() {
    this.visible = false;
    this._dragging = false;
    if (this._root) this._root.classList.add('hidden');
    this.cb.onClose?.();
  }

  toggle(state = {}) {
    if (this.visible) this.hide();
    else this.show(state);
    return this.visible;
  }

  _updateTimeLabel(h) {
    if (!this._timeLabel) return;
    const hr = ((Math.floor(h) % 24) + 24) % 24;
    const mn = Math.floor((h - Math.floor(h)) * 60);
    this._timeLabel.textContent = `${String(hr).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
  }

  _updateHoverReadout() {
    if (!this._hoverEl || !this._hoverWorld) return;
    const { x, z } = this._hoverWorld;
    const h = terrainHeight(x, z);
    let gps = '';
    if (this._data.geoOrigin) {
      const { lat0, lon0 } = this._data.geoOrigin;
      const mLon = 111412.84 * Math.cos((lat0 * Math.PI) / 180);
      const lat = lat0 - z / M_PER_LAT;
      const lon = lon0 + x / mLon;
      gps = ` · ${lat.toFixed(4)}°N ${lon.toFixed(4)}°E`;
    }
    this._hoverEl.textContent =
      `CURSOR X ${Math.round(x)}  Z ${Math.round(z)} · ELEV ${Math.round(h)} M${gps} · CLICK TO TELEPORT`;
  }

  _rebuildQuickList() {
    if (!this._listEl) return;
    const items = [];
    const aps = airportsNear(0, 0, 4);
    for (const ap of aps) {
      items.push({ tag: 'APT', name: `${ap.code} ${ap.name}`, x: ap.x, z: ap.z, agl: 160 });
    }
    for (const lm of this._data.landmarks) {
      items.push({ tag: 'LMK', name: lm.name, x: lm.x, z: lm.z, agl: 150 });
    }
    for (const pl of this._data.places) {
      if (pl.kind === 'landmark') continue;
      items.push({ tag: pl.kind === 'city' ? 'CITY' : 'TOWN', name: pl.name, x: pl.x, z: pl.z, agl: 220 });
    }

    this._listEl.innerHTML = items.map((it, idx) =>
      `<button type="button" class="im-item" data-idx="${idx}">` +
      `<span class="im-tag im-${it.tag.toLowerCase()}">${it.tag}</span>` +
      `<span class="im-name">${it.name}</span></button>`
    ).join('');

    this._quickItems = items;
    this._listEl.onclick = (e) => {
      const btn = e.target.closest('button[data-idx]');
      if (!btn) return;
      const it = this._quickItems[Number(btn.dataset.idx)];
      if (!it) return;
      this.cb.onTeleport?.(it.x, it.z, this.clickAgl || it.agl, true);
    };
  }

  /** Pre-bake shaded elevation relief image for the current viewport. */
  _ensureRelief(W, H) {
    const key = `${Math.round(this.centerX)}:${Math.round(this.centerZ)}:${Math.round(this.spanM)}:${W}x${H}`;
    if (this._reliefCache && this._reliefKey === key) return this._reliefCache;

    const rw = 220;
    const rh = Math.max(120, Math.round(rw * (H / Math.max(1, W))));
    const off = document.createElement('canvas');
    off.width = rw;
    off.height = rh;
    const octx = off.getContext('2d');
    const img = octx.createImageData(rw, rh);
    const d = img.data;
    const step = this.spanM / rw;

    for (let j = 0; j < rh; j++) {
      const wz = this.centerZ + (j - rh * 0.5) * step;
      for (let i = 0; i < rw; i++) {
        const wx = this.centerX + (i - rw * 0.5) * step;
        const h = terrainHeight(wx, wz);
        const idx = (j * rw + i) * 4;
        if (h < 0.2) {
          // Adriatic sea
          d[idx] = 20;
          d[idx + 1] = 56;
          d[idx + 2] = 84;
          d[idx + 3] = 255;
        } else {
          const hx = terrainHeight(wx + step, wz) - h;
          const hz = terrainHeight(wx, wz + step) - h;
          const shade = Math.max(0.58, Math.min(1.32, 0.96 - (hx + hz) / (step * 1.4)));
          let r, g, b;
          if (h < 180) {
            // Valley floor
            const t = h / 180;
            r = 56 + t * 28;
            g = 86 + t * 20;
            b = 54 + t * 12;
          } else if (h < 700) {
            // Karst hills & ridges
            const t = (h - 180) / 520;
            r = 84 + t * 44;
            g = 106 + t * 14;
            b = 66 + t * 26;
          } else if (h < 1450) {
            // High Karst / Nanos plateau
            const t = (h - 700) / 750;
            r = 128 + t * 52;
            g = 120 + t * 50;
            b = 92 + t * 62;
          } else {
            // Alpine summits
            r = 210;
            g = 212;
            b = 208;
          }
          d[idx] = Math.min(255, Math.max(0, Math.round(r * shade)));
          d[idx + 1] = Math.min(255, Math.max(0, Math.round(g * shade)));
          d[idx + 2] = Math.min(255, Math.max(0, Math.round(b * shade)));
          d[idx + 3] = 255;
        }
      }
    }
    octx.putImageData(img, 0, 0);
    this._reliefCache = off;
    this._reliefKey = key;
    return off;
  }

  render(state = this._lastState || {}) {
    if (!this.visible || !this._canvas || !this._ctx) return;
    this._lastState = state;
    const ctx = this._ctx;
    const W = this._canvas.width;
    const H = this._canvas.height;

    // 1. Elevation shaded relief
    const relief = this._ensureRelief(W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(relief, 0, 0, W, H);

    // 2. Coordinate grid (every 5 km or 10 km)
    const gridStep = this.spanM > 60000 ? 10000 : this.spanM > 20000 ? 5000 : 1000;
    const topLeft = this.canvasToWorld(0, 0, W, H);
    const botRight = this.canvasToWorld(W, H, W, H);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = Math.floor(topLeft.x / gridStep) * gridStep; gx <= botRight.x; gx += gridStep) {
      const { px } = this.worldToCanvas(gx, 0, W, H);
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
    }
    for (let gz = Math.floor(topLeft.z / gridStep) * gridStep; gz <= botRight.z; gz += gridStep) {
      const { py } = this.worldToCanvas(0, gz, W, H);
      ctx.moveTo(0, py);
      ctx.lineTo(W, py);
    }
    ctx.stroke();

    // 3. Inland rivers & lakes
    const water = this._data.water;
    if (water) {
      if (Array.isArray(water.lakes)) {
        ctx.fillStyle = 'rgba(60, 175, 220, 0.55)';
        for (const poly of water.lakes) {
          if (!Array.isArray(poly) || poly.length < 3) continue;
          ctx.beginPath();
          for (let i = 0; i < poly.length; i++) {
            const { px, py } = this.worldToCanvas(poly[i][0], poly[i][1], W, H);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
        }
      }
      if (Array.isArray(water.rivers)) {
        ctx.strokeStyle = 'rgba(72, 195, 238, 0.65)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (const r of water.rivers) {
          const pts = r?.pts;
          if (!Array.isArray(pts) || pts.length < 2) continue;
          for (let i = 0; i < pts.length; i++) {
            const { px, py } = this.worldToCanvas(pts[i][0], pts[i][1], W, H);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      }
    }

    // 4. OSM roads & bridged viaducts
    const roads = this._data.roads;
    if (roads.length > 0) {
      ctx.strokeStyle = 'rgba(235, 222, 190, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const r of roads) {
        if (!r || !Array.isArray(r.pts) || r.pts.length < 2 || r.b === 1) continue;
        for (let i = 0; i < r.pts.length; i++) {
          const { px, py } = this.worldToCanvas(r.pts[i][0], r.pts[i][1], W, H);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      }
      ctx.stroke();

      // Highlight bridged road spans in amber so you can spot/click any bridge!
      ctx.strokeStyle = 'rgba(255, 194, 82, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const r of roads) {
        if (!r || r.b !== 1 || !Array.isArray(r.pts) || r.pts.length < 2) continue;
        for (let i = 0; i < r.pts.length; i++) {
          const { px, py } = this.worldToCanvas(r.pts[i][0], r.pts[i][1], W, H);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
    }

    // 5. Airports with runway strip orientation
    const aps = airportsNear(0, 0, 4);
    for (const ap of aps) {
      const { px, py } = this.worldToCanvas(ap.x, ap.z, W, H);
      if (px < -30 || px > W + 30 || py < -30 || py > H + 30) continue;
      const rad = ((ap.heading || 0) * Math.PI) / 180;
      const halfPx = Math.max(7, ((ap.length || 1200) * 0.5 / this.spanM) * W);
      const dx = Math.sin(rad) * halfPx;
      const dy = -Math.cos(rad) * halfPx;
      ctx.strokeStyle = '#7dffb2';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px - dx, py - dy);
      ctx.lineTo(px + dx, py + dy);
      ctx.stroke();
      ctx.fillStyle = '#c8ffe0';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(ap.code, px + 7, py - 5);
    }

    // 6. Towns & Cities
    ctx.font = '10px monospace';
    for (const pl of this._data.places) {
      if (pl.kind === 'landmark') continue;
      const { px, py } = this.worldToCanvas(pl.x, pl.z, W, H);
      if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
      ctx.fillStyle = pl.kind === 'city' ? '#ffffff' : 'rgba(232, 236, 224, 0.85)';
      ctx.beginPath();
      ctx.arc(px, py, pl.kind === 'city' ? 3.2 : 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(pl.name, px + 5, py + 3);
    }

    // 7. 12 Iconic Landmarks (amber diamonds)
    for (const lm of this._data.landmarks) {
      const { px, py } = this.worldToCanvas(lm.x, lm.z, W, H);
      if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
      ctx.fillStyle = '#ffbe55';
      ctx.beginPath();
      ctx.moveTo(px, py - 5);
      ctx.lineTo(px + 4.5, py);
      ctx.lineTo(px, py + 5);
      ctx.lineTo(px - 4.5, py);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffe2a6';
      ctx.font = '10px monospace';
      ctx.fillText(lm.name.replace(/\s*\(.*\)/, ''), px + 6, py - 4);
    }

    // 8. Aircraft position
    if (state.aircraftPos) {
      const { px, py } = this.worldToCanvas(state.aircraftPos.x, state.aircraftPos.z, W, H);
      ctx.strokeStyle = '#7aff9f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#7aff9f';
      ctx.font = 'bold 10px monospace';
      ctx.fillText('F-16', px + 8, py + 3);
    }

    // 9. Free Camera position + look cone
    if (state.camPos) {
      const { px, py } = this.worldToCanvas(state.camPos.x, state.camPos.z, W, H);
      const yaw = Number.isFinite(state.camYaw) ? state.camYaw : 0;
      const fx = -Math.sin(yaw);
      const fy = -Math.cos(yaw);
      ctx.fillStyle = 'rgba(255, 224, 102, 0.22)';
      ctx.beginPath();
      ctx.moveTo(px, py);
      const a = Math.atan2(fy, fx);
      ctx.arc(px, py, 28, a - 0.45, a + 0.45);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#ffe066';
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 10. Scale bar
    const barKm = this.spanM > 60000 ? 10 : this.spanM > 20000 ? 5 : 1;
    const barPx = (barKm * 1000 / this.spanM) * W;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(14, H - 32, barPx + 24, 20);
    ctx.strokeStyle = '#8dffb4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(22, H - 19);
    ctx.lineTo(22 + barPx, H - 19);
    ctx.stroke();
    ctx.fillStyle = '#d7ffe5';
    ctx.font = '10px monospace';
    ctx.fillText(`${barKm} KM`, 26, H - 22);

    // Debug stats footer
    if (this._statsEl && state.debugStats) {
      const s = state.debugStats;
      this._statsEl.textContent =
        `FPS ${s.fps} · DRAW ${s.calls} · TRIS ${s.tris}k · TILES ${s.tiles} · ` +
        `BLD ${s.buildings} (C:${s.lodClose} M:${s.lodMid} F:${s.lodFar}) · ` +
        `ROOFS ${s.roofs} · PLINTHS ${s.plinths}`;
    }
  }
}
