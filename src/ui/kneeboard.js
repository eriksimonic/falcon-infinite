// Pilot kneeboard map — drawn directly onto the main 2D HUD canvas, so it adds
// no DOM elements and stays crisp on retina displays.
//
// North-up tactical chart centred on the aircraft:
//   - cached coarse terrain relief (ocean navy, green lowlands, sand peaks)
//   - range rings, graticule and N/E/S/W compass rose
//   - airports with runway ticks + ICAO codes (click to set a diversion)
//   - target diamonds, tanker symbol, steerpoint course line
//   - rolling breadcrumb track and a wind barb in the corner
//
// The class never touches the DOM: it renders through `draw(ctx, w, h, state)`
// and therefore runs against a minimal 2D canvas mock in headless Node tests.
//
// World conventions (ARCHITECTURE.md): 1 unit = 1 metre, north = -Z, east = +X,
// heading degrees clockwise from north. Screen up is north.

const TAU = Math.PI * 2;

const ZOOM_LEVELS = [16000, 32000, 64000];
const TRACK_STEP_M = 150;
const TRACK_MAX = 240;
const GRID_RES = 15;

const GREEN = '#9dffc0';
const GREEN_DIM = 'rgba(157,255,192,0.55)';
const GREEN_FAINT = 'rgba(157,255,192,0.22)';
const INK = '#eafff1';
const MUTED = 'rgba(186,214,199,0.62)';
const AMBER = '#ffc46b';
const RED = '#ff6b5e';
const CYAN = '#6fe3ff';
const MONO = 'ui-monospace, Menlo, monospace';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fb = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  if (typeof ctx.arcTo !== 'function') {
    if (typeof ctx.rect === 'function') ctx.rect(x, y, w, h);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function setDash(ctx, pattern) {
  if (typeof ctx.setLineDash === 'function') {
    try {
      ctx.setLineDash(pattern);
    } catch (err) {
      /* ignored — minimal headless canvas */
    }
  }
}

// Position from either `{ x, z }`, `{ position: { x, z } }` or a Vector3.
function objPos(o) {
  if (!o || typeof o !== 'object') return null;
  const p = o.position && typeof o.position === 'object' ? o.position : o;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  return { x: p.x, z: p.z };
}

function terrainColor(h) {
  if (h <= 0) {
    const d = clamp(-h / 900, 0, 1);
    return `rgba(${(6 + d * 8) | 0},${(22 + d * 18) | 0},${(44 + d * 30) | 0},0.94)`;
  }
  const bands = [
    [0, 'rgba(24,52,36,0.94)'],
    [220, 'rgba(38,64,40,0.94)'],
    [520, 'rgba(62,74,44,0.94)'],
    [950, 'rgba(92,88,54,0.94)'],
    [1450, 'rgba(122,108,70,0.94)'],
    [1900, 'rgba(152,134,92,0.94)'],
  ];
  let col = bands[0][1];
  for (const [limit, c] of bands) if (h >= limit) col = c;
  return col;
}

const pad3 = (v) => String(Math.round(v) % 360).padStart(3, '0');
const pad2 = (v) => String(Math.round(v)).padStart(2, '0');

export class KneeboardMap {
  constructor() {
    this.visible = false;
    this.rangeM = 32000;
    this.track = [];
    this.selectedAirport = null;

    // Diagnostics: number of terrain grid rebuilds (cache misses).
    this.gridBuilds = 0;
    this._grid = null;
  }

  // -------------------------------------------------------------- controls
  toggle() {
    this.visible = !this.visible;
    return this.visible;
  }

  cycleZoom() {
    const i = ZOOM_LEVELS.indexOf(this.rangeM);
    this.rangeM = ZOOM_LEVELS[(i < 0 ? 1 : i + 1) % ZOOM_LEVELS.length];
    return this.rangeM;
  }

  recordPosition(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const last = this.track[this.track.length - 1];
    if (last && Math.hypot(x - last.x, z - last.z) < TRACK_STEP_M) return false;
    this.track.push({ x, z });
    if (this.track.length > TRACK_MAX) this.track.splice(0, this.track.length - TRACK_MAX);
    return true;
  }

  clearTrack() {
    this.track.length = 0;
    this.selectedAirport = null;
    return this;
  }

  // -------------------------------------------------------------- geometry
  // Panel anchored on the centre-left. `size` is the map square; the header
  // strip sits above it. Both draw() and pickAirportAt() share this layout.
  _geometry(w, h) {
    const minD = Math.max(0, Math.min(w, h));
    const size = Math.max(90, Math.min(minD * 0.48, Math.min(w - 24, h - 24)));
    const k = clamp(size / 340, 0.7, 2.0);
    const headerH = Math.max(14, 17 * k);
    const totalH = size + headerH;
    const margin = Math.max(10, minD * 0.03);
    const x = margin;
    const y = clamp((h - totalH) * 0.5, margin, Math.max(margin, h - totalH - margin));
    const cx = x + size * 0.5;
    const cy = y + headerH + size * 0.5;
    const r = Math.max(10, size * 0.5 - 9 * k);
    return { x, y, size, headerH, totalH, cx, cy, r, k };
  }

  _scale(g) {
    // rangeM is the full map width, so the visible radius covers rangeM / 2.
    return g.r / Math.max(1, this.rangeM * 0.5);
  }

  _project(x, z, own, g) {
    const sc = this._scale(g);
    return { x: g.cx + (x - own.x) * sc, y: g.cy + (z - own.z) * sc };
  }

  _own(flight) {
    if (flight && typeof flight === 'object') {
      const direct = objPos(flight);
      if (direct) return direct;
      const positioned = objPos(flight.position);
      if (positioned) return positioned;
      if (flight.telemetry) {
        const tele = objPos(flight.telemetry.position) || objPos(flight.telemetry);
        if (tele) return tele;
      }
    }
    return { x: 0, z: 0 };
  }

  _heading(flight) {
    if (!flight || typeof flight !== 'object') return 0;
    if (Number.isFinite(flight.heading)) return flight.heading;
    if (flight.telemetry && Number.isFinite(flight.telemetry.heading)) return flight.telemetry.heading;
    return 0;
  }

  _wind(state) {
    const w = state.wind && typeof state.wind === 'object' ? state.wind : {};
    const pick = (...vals) => vals.find((v) => typeof v === 'number' && Number.isFinite(v));
    const dir = pick(w.dirDeg, w.dir, w.direction, w.fromDeg, state.windDir);
    const kts = pick(w.kts, w.speedKts, w.speed, state.windKts);
    return { dir: dir == null ? 0 : dir, kts: kts == null ? 0 : kts };
  }

  // -------------------------------------------------------- terrain cache
  _ensureGrid(own, heightAt) {
    const gr = this._grid;
    if (
      gr
      && gr.rangeM === this.rangeM
      && Math.hypot(own.x - gr.cx, own.z - gr.cz) <= this.rangeM * 0.08
    ) {
      return gr;
    }
    return this._buildGrid(own, heightAt);
  }

  _buildGrid(own, heightAt) {
    if (typeof heightAt !== 'function') {
      this._grid = null;
      return null;
    }
    const res = GRID_RES;
    const span = this.rangeM;
    const step = span / (res - 1);
    const originX = own.x - span * 0.5;
    const originZ = own.z - span * 0.5;
    const heights = new Float32Array(res * res);
    for (let iy = 0; iy < res; iy++) {
      const wz = originZ + iy * step;
      for (let ix = 0; ix < res; ix++) {
        const wx = originX + ix * step;
        let h = 0;
        try {
          h = heightAt(wx, wz);
        } catch (err) {
          h = 0;
        }
        heights[iy * res + ix] = Number.isFinite(h) ? h : 0;
      }
    }
    this._grid = { cx: own.x, cz: own.z, rangeM: this.rangeM, res, step, originX, originZ, heights };
    this.gridBuilds++;
    return this._grid;
  }

  // ---------------------------------------------------------------- picking
  /**
   * Click-pick an airport icon on the visible kneeboard.
   * @returns {object|null} the new selectedAirport (or null when none hit)
   */
  pickAirportAt(screenX, screenY, w, h, flight, airports) {
    if (!this.visible) return null;
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return null;
    const W = num(w, 0);
    const H = num(h, 0);
    if (W <= 0 || H <= 0) return null;

    const g = this._geometry(W, H);
    const insidePanel = screenX >= g.x && screenX <= g.x + g.size
      && screenY >= g.y && screenY <= g.y + g.totalH;
    if (!insidePanel) {
      this.selectedAirport = null;
      return null;
    }

    const own = this._own(flight);
    const list = Array.isArray(airports) ? airports : [];
    const hitR = Math.max(9, g.k * 12);
    let best = null;
    let bestD = Infinity;

    for (const ap of list) {
      const p = objPos(ap);
      if (!p) continue;
      const s = this._project(p.x, p.z, own, g);
      if (Math.hypot(s.x - g.cx, s.y - g.cy) > g.r + hitR) continue;
      const d = Math.hypot(screenX - s.x, screenY - s.y);
      if (d <= hitR && d < bestD) {
        best = ap;
        bestD = d;
      }
    }

    this.selectedAirport = best;
    return best;
  }

  // ------------------------------------------------------------------ draw
  draw(ctx, w, h, state) {
    if (!this.visible || !ctx) return;
    const W = num(w, 0);
    const H = num(h, 0);
    if (W <= 0 || H <= 0) return;

    const st = state && typeof state === 'object' ? state : {};
    const flight = st.flight && typeof st.flight === 'object' ? st.flight : st;
    const own = this._own(flight);
    const heading = this._heading(flight);
    const g = this._geometry(W, H);
    const k = g.k;

    ctx.save();
    ctx.textBaseline = 'middle';

    // Tactical glass panel ---------------------------------------------------
    roundRectPath(ctx, g.x, g.y, g.size, g.totalH, 9 * k);
    ctx.fillStyle = 'rgba(6, 17, 12, 0.84)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(157,255,192,0.42)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Header strip, clipped to the rounded panel.
    ctx.save();
    roundRectPath(ctx, g.x, g.y, g.size, g.totalH, 9 * k);
    ctx.clip();
    ctx.fillStyle = 'rgba(12, 34, 23, 0.88)';
    ctx.fillRect(g.x, g.y, g.size, g.headerH);
    ctx.strokeStyle = GREEN_FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.x + 6 * k, g.y + g.headerH);
    ctx.lineTo(g.x + g.size - 6 * k, g.y + g.headerH);
    ctx.stroke();
    ctx.restore();

    const headerY = g.y + g.headerH * 0.54;
    ctx.font = `700 ${Math.round(9.5 * k)}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = GREEN;
    ctx.fillText('KNEEBOARD', g.x + 9 * k, headerY);

    ctx.textAlign = 'center';
    ctx.fillStyle = MUTED;
    ctx.font = `600 ${Math.round(8.5 * k)}px ${MONO}`;
    ctx.fillText(`HDG ${pad3(heading)}`, g.cx, headerY);

    ctx.textAlign = 'right';
    ctx.fillStyle = GREEN;
    ctx.font = `700 ${Math.round(9 * k)}px ${MONO}`;
    ctx.fillText(`RNG ${Math.round(this.rangeM / 1000)} KM`, g.x + g.size - 9 * k, headerY);

    // Chart body ------------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r, 0, TAU);
    ctx.clip();

    ctx.fillStyle = 'rgba(3, 9, 14, 0.94)';
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r, 0, TAU);
    ctx.fill();

    const heightAt = typeof st.heightAt === 'function' ? st.heightAt : null;
    const grid = heightAt ? this._ensureGrid(own, heightAt) : null;
    if (grid) this._drawTerrain(ctx, g, grid, own);

    this._drawGraticule(ctx, g);
    this._drawRings(ctx, g);
    this._drawCompass(ctx, g);
    this._drawTrack(ctx, g, own);
    this._drawSteerpoint(ctx, g, own, st.steerpoint, AMBER, 'STPT');
    this._drawDiversion(ctx, g, own);
    this._drawAirports(ctx, g, own, st.airports);
    this._drawTargets(ctx, g, own, st.targets);
    this._drawTanker(ctx, g, own, st.tanker);
    this._drawPlayer(ctx, g, heading);

    ctx.restore();

    // Chart frame -----------------------------------------------------------
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r, 0, TAU);
    ctx.strokeStyle = 'rgba(157,255,192,0.40)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r - 2 * k, 0, TAU);
    ctx.strokeStyle = 'rgba(157,255,192,0.10)';
    ctx.lineWidth = 1;
    ctx.stroke();

    this._drawWind(ctx, g, this._wind(st));

    // Corner detail ticks.
    ctx.strokeStyle = GREEN_FAINT;
    ctx.lineWidth = 1;
    const tick = 5 * k;
    for (const [tx, ty, dx, dy] of [
      [g.x + 6 * k, g.y + 6 * k, 1, 1],
      [g.x + g.size - 6 * k, g.y + 6 * k, -1, 1],
      [g.x + 6 * k, g.y + g.totalH - 6 * k, 1, -1],
      [g.x + g.size - 6 * k, g.y + g.totalH - 6 * k, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + dx * tick, ty);
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx, ty + dy * tick);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ------------------------------------------------------------ chart parts
  _drawTerrain(ctx, g, grid, own) {
    const sc = g.r / (grid.rangeM * 0.5);
    const cellPx = grid.step * sc;
    const half = cellPx * 0.5 + 0.5;
    const cull = (g.r + cellPx) * (g.r + cellPx);
    const { res, heights, step } = grid;

    for (let iy = 0; iy < res - 1; iy++) {
      for (let ix = 0; ix < res - 1; ix++) {
        const h = (
          heights[iy * res + ix]
          + heights[iy * res + ix + 1]
          + heights[(iy + 1) * res + ix]
          + heights[(iy + 1) * res + ix + 1]
        ) * 0.25;

        const wx = grid.originX + (ix + 0.5) * step;
        const wz = grid.originZ + (iy + 0.5) * step;
        const px = g.cx + (wx - own.x) * sc;
        const py = g.cy + (wz - own.z) * sc;
        const dx = px - g.cx;
        const dy = py - g.cy;
        if (dx * dx + dy * dy > cull) continue;

        ctx.fillStyle = terrainColor(h);
        ctx.fillRect(px - half, py - half, cellPx + 0.5, cellPx + 0.5);
      }
    }
  }

  _drawGraticule(ctx, g) {
    ctx.strokeStyle = 'rgba(157,255,192,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [-0.5, 0.5]) {
      ctx.moveTo(g.cx + g.r * f, g.cy - g.r);
      ctx.lineTo(g.cx + g.r * f, g.cy + g.r);
      ctx.moveTo(g.cx - g.r, g.cy + g.r * f);
      ctx.lineTo(g.cx + g.r, g.cy + g.r * f);
    }
    ctx.stroke();
  }

  _drawRings(ctx, g) {
    setDash(ctx, [3 * g.k, 5 * g.k]);
    for (const f of [0.34, 0.67, 1]) {
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, g.r * f, 0, TAU);
      ctx.strokeStyle = f === 1 ? 'rgba(157,255,192,0.30)' : 'rgba(157,255,192,0.16)';
      ctx.lineWidth = f === 1 ? 1.1 : 1;
      ctx.stroke();
    }
    setDash(ctx, []);
  }

  _drawCompass(ctx, g) {
    const k = g.k;
    ctx.strokeStyle = 'rgba(157,255,192,0.26)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU - Math.PI * 0.5;
      const r0 = g.r * (i % 3 === 0 ? 0.90 : 0.94);
      const r1 = g.r * 0.975;
      ctx.beginPath();
      ctx.moveTo(g.cx + Math.cos(a) * r0, g.cy + Math.sin(a) * r0);
      ctx.lineTo(g.cx + Math.cos(a) * r1, g.cy + Math.sin(a) * r1);
      ctx.stroke();
    }

    ctx.font = `700 ${Math.round(9.5 * k)}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = INK;
    const inset = 11 * k;
    ctx.fillText('N', g.cx, g.cy - g.r + inset);
    ctx.fillText('E', g.cx + g.r - inset, g.cy);
    ctx.fillText('S', g.cx, g.cy + g.r - inset);
    ctx.fillText('W', g.cx - g.r + inset, g.cy);
  }

  _drawTrack(ctx, g, own) {
    if (this.track.length < 2) return;
    ctx.strokeStyle = 'rgba(255,196,107,0.50)';
    ctx.lineWidth = 1.3 * g.k;
    ctx.beginPath();
    for (let i = 0; i < this.track.length; i++) {
      const p = this.track[i];
      const s = this._project(p.x, p.z, own, g);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();

    const last = this.track[this.track.length - 1];
    const lp = this._project(last.x, last.z, own, g);
    ctx.beginPath();
    ctx.arc(lp.x, lp.y, 1.8 * g.k, 0, TAU);
    ctx.fillStyle = AMBER;
    ctx.fill();
  }

  _drawSteerpoint(ctx, g, own, steerpoint, color, prefix) {
    const p = objPos(steerpoint);
    if (!p) return;
    this._drawCourse(ctx, g, own, p, color, prefix, String(steerpoint.label || steerpoint.name || 'OBJECTIVE'));
  }

  _drawDiversion(ctx, g, own) {
    const ap = this.selectedAirport;
    const p = objPos(ap);
    if (!p) return;
    const code = String(ap.code || ap.name || ap.id || 'DIV').toUpperCase().slice(0, 5);
    this._drawCourse(ctx, g, own, p, CYAN, `DIV ${code}`, '');
  }

  _drawCourse(ctx, g, own, target, color, prefix, label) {
    const k = g.k;
    const p = this._project(target.x, target.z, own, g);
    const dx = p.x - g.cx;
    const dy = p.y - g.cy;
    const distPx = Math.hypot(dx, dy);
    const maxPx = g.r - 9 * k;
    let ex = p.x;
    let ey = p.y;
    if (distPx > maxPx && distPx > 0.0001) {
      const f = maxPx / distPx;
      ex = g.cx + dx * f;
      ey = g.cy + dy * f;
    }

    setDash(ctx, [5 * k, 4 * k]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(g.cx, g.cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    setDash(ctx, []);

    // Waypoint box + caret.
    const half = 4.5 * k;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(ex - half, ey - half, half * 2, half * 2);
    ctx.beginPath();
    ctx.moveTo(ex, ey - half - 1);
    ctx.lineTo(ex - 3 * k, ey - half - 5 * k);
    ctx.lineTo(ex + 3 * k, ey - half - 5 * k);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    const distM = Math.hypot(target.x - own.x, target.z - own.z);
    const tx = clamp(ex, g.x + 34 * k, g.x + g.size - 34 * k);
    let ty = ey + 13 * k;
    if (ty > g.y + g.totalH - 26 * k) ty = ey - 13 * k;
    ty = clamp(ty, g.y + g.headerH + 11 * k, g.y + g.totalH - 8 * k);

    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.round(8.5 * k)}px ${MONO}`;
    ctx.fillStyle = color;
    ctx.fillText(prefix, tx, ty);
    let line = ty + 10 * k;
    if (label) {
      ctx.font = `600 ${Math.round(8 * k)}px ${MONO}`;
      ctx.fillStyle = GREEN_DIM;
      ctx.fillText(label.slice(0, 16), tx, line);
      line += 9.5 * k;
    }
    ctx.font = `600 ${Math.round(7.5 * k)}px ${MONO}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(`${(distM / 1852).toFixed(1)} NM`, tx, Math.min(line, g.y + g.totalH - 8 * k));
  }

  _drawAirports(ctx, g, own, airports) {
    const k = g.k;
    const list = Array.isArray(airports) ? airports : [];
    let plotted = 0;

    for (const ap of list) {
      if (plotted >= 40) break;
      const p = objPos(ap);
      if (!p) continue;
      const s = this._project(p.x, p.z, own, g);
      if (Math.hypot(s.x - g.cx, s.y - g.cy) > g.r - 3 * k) continue;

      const selected = ap === this.selectedAirport;
      const color = selected ? AMBER : GREEN;

      // Runway tick, aligned with the real runway heading.
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(((num(ap.heading, 0)) * Math.PI) / 180);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -6 * k);
      ctx.lineTo(0, 6 * k);
      ctx.moveTo(-2.5 * k, -6 * k);
      ctx.lineTo(2.5 * k, -6 * k);
      ctx.moveTo(-2.5 * k, 6 * k);
      ctx.lineTo(2.5 * k, 6 * k);
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(s.x, s.y, selected ? 8 * k : 2.2 * k, 0, TAU);
      ctx.fillStyle = selected ? 'rgba(255,196,107,0.20)' : color;
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = AMBER;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      const code = String(ap.code || ap.id || '').toUpperCase().slice(0, 4);
      if (code) {
        ctx.font = `600 ${Math.round(8 * k)}px ${MONO}`;
        ctx.textAlign = 'left';
        ctx.fillStyle = selected ? AMBER : GREEN_DIM;
        ctx.fillText(code, s.x + 5 * k, s.y - 5 * k);
      }
      plotted++;
    }
  }

  _drawTargets(ctx, g, own, targets) {
    const k = g.k;
    const list = Array.isArray(targets) ? targets : [];
    let plotted = 0;

    for (const t of list) {
      if (plotted >= 30) break;
      if (!t || t.alive === false) continue;
      const p = objPos(t);
      if (!p) continue;
      const s = this._project(p.x, p.z, own, g);
      if (Math.hypot(s.x - g.cx, s.y - g.cy) > g.r - 4 * k) continue;

      const color = t.airborne ? AMBER : RED;
      const r = 3.6 * k;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(Math.PI * 0.25);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.restore();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.2 * k, 0, TAU);
      ctx.fill();

      const kind = String(t.kind || 'TGT').toUpperCase().slice(0, 4);
      ctx.font = `600 ${Math.round(7 * k)}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      ctx.fillText(kind, s.x, s.y + 7 * k);
      plotted++;
    }
  }

  _drawTanker(ctx, g, own, tanker) {
    const p = objPos(tanker);
    if (!p) return;
    const k = g.k;
    const s = this._project(p.x, p.z, own, g);
    if (Math.hypot(s.x - g.cx, s.y - g.cy) > g.r - 4 * k) return;

    ctx.strokeStyle = CYAN;
    ctx.fillStyle = CYAN;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - 4.5 * k);
    ctx.lineTo(s.x + 4 * k, s.y + 3.5 * k);
    ctx.lineTo(s.x - 4 * k, s.y + 3.5 * k);
    ctx.closePath();
    ctx.stroke();

    ctx.font = `700 ${Math.round(7.5 * k)}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText('TKR', s.x, s.y + 9 * k);
  }

  _drawPlayer(ctx, g, heading) {
    const k = g.k;
    ctx.save();
    ctx.translate(g.cx, g.cy);
    ctx.rotate(((heading % 360) * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -9 * k);
    ctx.lineTo(1.8 * k, -2.5 * k);
    ctx.lineTo(8.5 * k, 2 * k);
    ctx.lineTo(8.5 * k, 4 * k);
    ctx.lineTo(2 * k, 2.6 * k);
    ctx.lineTo(1.6 * k, 7 * k);
    ctx.lineTo(3.8 * k, 9 * k);
    ctx.lineTo(-3.8 * k, 9 * k);
    ctx.lineTo(-1.6 * k, 7 * k);
    ctx.lineTo(-2 * k, 2.6 * k);
    ctx.lineTo(-8.5 * k, 4 * k);
    ctx.lineTo(-8.5 * k, 2 * k);
    ctx.lineTo(-1.8 * k, -2.5 * k);
    ctx.closePath();
    ctx.fillStyle = GREEN;
    ctx.fill();
    ctx.strokeStyle = 'rgba(4,16,10,0.9)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();
  }

  _drawWind(ctx, g, wind) {
    const k = g.k;
    const bw = 60 * k;
    const bh = 30 * k;
    const bx = g.x + g.size - bw - 7 * k;
    const by = g.y + g.totalH - bh - 7 * k;

    roundRectPath(ctx, bx, by, bw, bh, 4 * k);
    ctx.fillStyle = 'rgba(4, 12, 8, 0.82)';
    ctx.fill();
    ctx.strokeStyle = GREEN_FAINT;
    ctx.lineWidth = 1;
    ctx.stroke();

    const dir = ((wind.dir % 360) + 360) % 360;
    const kts = Math.max(0, num(wind.kts, 0));

    ctx.save();
    ctx.translate(bx + 12 * k, by + bh * 0.5);
    ctx.rotate((dir * Math.PI) / 180);
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(0, 10 * k);
    ctx.lineTo(0, -10 * k);
    ctx.stroke();

    const feathers = clamp(Math.round(kts / 10), 0, 5);
    ctx.beginPath();
    for (let i = 0; i < feathers; i++) {
      const y = -10 * k + i * 3.4 * k;
      ctx.moveTo(0, y);
      ctx.lineTo(4.5 * k, y + 2.6 * k);
    }
    if (kts < 5) {
      ctx.moveTo(-2 * k, -8 * k);
      ctx.arc(0, -10 * k, 2 * k, 0, TAU);
    }
    ctx.stroke();
    ctx.restore();

    ctx.font = `700 ${Math.round(7.5 * k)}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = CYAN;
    ctx.fillText(`${pad3(dir)}/${pad2(kts)}`, bx + 24 * k, by + bh * 0.5 + 0.5);
  }
}