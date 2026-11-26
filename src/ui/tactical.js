// Tactical HUD overlay — drawn on top of the base HUD (ui/hud.js).
//
// Layers:
//   - NVG phosphor mode (binocular mask, emerald wash, scanlines, indicator)
//   - 3D->2D projected target diamond / lock box + off-screen arrow
//   - CCIP bomb fall line + impact pipper (MK82)
//   - M61A1 EEGS gun funnel + lead pipper (GUN)
//   - Steerpoint caret with objective label & distance
//   - F-16 RWR azimuth scope (bottom-right)
//   - Weapon / flare strip + AWACS radio feed
//   - G-LOC blackout / redout tunnel vision
//
// Everything is defensive: no DOM access at import/construction time, every
// optional input is sanitised, so the module renders against a minimal 2D
// canvas mock in headless Node tests.

import { Vector3 } from 'three';

const TAU = Math.PI * 2;

const GREEN = '#9dffc0';
const GREEN_DIM = 'rgba(157,255,192,0.56)';
const GREEN_FAINT = 'rgba(157,255,192,0.22)';
const AMBER = '#ffc46b';
const RED = '#ff6b5e';
const INK = '#eafff1';
const MONO = 'ui-monospace, Menlo, monospace';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fb = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const vecNum = (v, key, fb = 0) => (v && Number.isFinite(v[key]) ? v[key] : fb);

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

function radial(ctx, x0, y0, r0, x1, y1, r1) {
  if (typeof ctx.createRadialGradient !== 'function') return null;
  try {
    return ctx.createRadialGradient(x0, y0, Math.max(0, r0), x1, y1, Math.max(0.001, r1));
  } catch (err) {
    return null;
  }
}

function addStops(grad, stops) {
  if (!grad || typeof grad.addColorStop !== 'function') return false;
  for (const [at, color] of stops) {
    try {
      grad.addColorStop(clamp(at, 0, 1), color);
    } catch (err) {
      return false;
    }
  }
  return true;
}

export class TacticalOverlay {
  constructor() {
    this.nvg = false;
    this.gloc = 0; // -1 full redout .. 0 clear .. +1 full blackout
    this.gStrain = 0;
    this._t = 0;
    this._v1 = new Vector3();
    this._v2 = new Vector3();
  }

  toggleNVG() {
    this.nvg = !this.nvg;
    return this.nvg;
  }

  // -------------------------------------------------------------------------
  // Physiological G-LOC / redout integration
  // -------------------------------------------------------------------------
  update(dt, flight) {
    const step = clamp(num(dt, 1 / 60), 0, 0.25);
    this._t += step;

    let g = 1;
    if (flight && typeof flight === 'object') g = num(flight.gForce, 1);
    else if (typeof flight === 'number') g = num(flight, 1);
    const gSafe = clamp(g, -14, 18);

    this.gloc = clamp(num(this.gloc, 0), -1, 1);

    if (gSafe > 5.8) {
      // Sustained positive G: greyout -> blackout. Faster above 7.5G.
      const over = (gSafe - 5.8) / 3.2; // ~1.0 at the 9G limit
      const severe = Math.max(0, gSafe - 7.5);
      const drive = 0.085 + over * 0.20 + severe * 0.11;
      // Roll off any residual redout first, then build blackout asymptotically.
      if (this.gloc < 0) this.gloc = Math.min(0, this.gloc + 2.6 * step);
      this.gloc += (1 - Math.max(0, this.gloc)) * drive * step;
    } else if (gSafe >= 4.5) {
      // High-but-tolerable band: hold with very slow recovery.
      const decay = Math.exp(-0.12 * step);
      this.gloc *= decay;
    } else if (gSafe > -1.8) {
      // Relaxed recovery below 4.5G. Lower G clears faster.
      const rec = clamp(2.5 - Math.max(0, gSafe) * 0.22, 1.3, 2.5);
      this.gloc *= Math.exp(-rec * step);
      if (Math.abs(this.gloc) < 0.0015) this.gloc = 0;
    } else {
      // Negative G redout.
      const over = (-gSafe - 1.8) / 2.2;
      const drive = 0.30 + over * 0.45;
      if (this.gloc > 0) this.gloc = Math.max(0, this.gloc - 2.6 * step);
      this.gloc -= (1 + this.gloc) * drive * step;
    }

    this.gloc = clamp(num(this.gloc, 0), -1, 1);

    const posStrain = clamp((gSafe - 4.2) / 4.2, 0, 1);
    const negStrain = clamp((-gSafe - 1.2) / 2.0, 0, 1);
    const loadStrain = clamp(Math.abs(this.gloc) * 0.85, 0, 1);
    this.gStrain = clamp(Math.max(posStrain, negStrain, loadStrain), 0, 1);

    return {
      gloc: this.gloc,
      blackout: Math.max(0, this.gloc),
      redout: Math.max(0, -this.gloc),
      gStrain: this.gStrain,
    };
  }

  // -------------------------------------------------------------------------
  // Drawing entry point
  // -------------------------------------------------------------------------
  draw(ctx, w, h, state) {
    if (!ctx) return;
    const width = num(w, 0);
    const height = num(h, 0);
    if (width <= 0 || height <= 0) return;
    const st = state && typeof state === 'object' ? state : {};
    const s = clamp(Math.min(width / 1600, height / 900), 0.62, 1.15);

    // Kill the one-frame projection lag: the world matrices (and the camera's
    // inverse world matrix) must be current before any 3D point is projected.
    // In chase/orbit views the camera moves every frame, so projecting against
    // last frame's matrix puts the pipper one frame behind the aircraft.
    const cam = st.camera;
    if (cam && typeof cam.updateMatrixWorld === 'function') {
      try {
        cam.updateMatrixWorld();
      } catch (err) {
        /* a projection-less mock camera must never break the overlay */
      }
    }

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    if (this.nvg) this._drawNVGWash(ctx, width, height, s);
    if (this.gloc > 0.15 || this.gloc < -0.15) this._drawGLOC(ctx, width, height);

    this._drawTargets(ctx, width, height, s, st);
    this._drawWeapons(ctx, width, height, s, st);
    this._drawSteerpoint(ctx, width, height, s, st);
    this._drawRWR(ctx, width, height, s, st);
    this._drawWeaponStrip(ctx, width, height, s, st);
    this._drawRadioFeed(ctx, width, height, s, st);
    if (this.nvg) this._drawNVGFinish(ctx, width, height, s);

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // NVG
  // -------------------------------------------------------------------------
  _drawNVGWash(ctx, w, h, s) {
    ctx.save();

    ctx.fillStyle = 'rgba(34, 235, 122, 0.065)';
    ctx.fillRect(0, 0, w, h);

    const eyeR = Math.min(w * 0.232, h * 0.44);
    const eyeY = h * 0.47;
    const bridge = Math.max(3 * s, w * 0.006);
    const leftX = w * 0.5 - eyeR - bridge;
    const rightX = w * 0.5 + eyeR + bridge;

    // Dark goggle mask with two circular binocular view holes. Each half is
    // masked separately so the two holes never produce an even-odd lens seam.
    ctx.fillStyle = 'rgba(1, 7, 4, 0.66)';
    for (const [x0, x1, ex] of [[0, w * 0.5, leftX], [w * 0.5, w, rightX]]) {
      ctx.beginPath();
      ctx.rect(x0 - 1, -1, (x1 - x0) + 2, h + 2);
      ctx.arc(ex, eyeY, eyeR, 0, TAU, true);
      ctx.fill('evenodd');
    }

    // Soft phosphor tube edge glow.
    for (const ex of [leftX, rightX]) {
      const grad = radial(ctx, ex, eyeY, eyeR * 0.62, ex, eyeY, eyeR * 1.12);
      if (addStops(grad, [
        [0, 'rgba(90, 255, 158, 0)'],
        [0.78, 'rgba(90, 255, 158, 0.03)'],
        [1, 'rgba(70, 235, 135, 0.10)'],
      ])) {
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(ex, eyeY, eyeR * 1.12, 0, TAU);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  _drawNVGFinish(ctx, w, h, s) {
    ctx.save();

    // Ultra-fine scanlines (single path, single stroke).
    ctx.strokeStyle = 'rgba(0, 62, 24, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 0.5; y < h; y += 3) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    // "NVG ON" indicator — top-left, clear of the radio feed below it.
    const blink = Math.sin(this._t * 3.1) > -0.35;
    const bw = 76 * s;
    const bh = 18 * s;
    const bx = 16 * s;
    const by = 13 * s;
    roundRectPath(ctx, bx, by, bw, bh, 4 * s);
    ctx.fillStyle = 'rgba(4, 24, 12, 0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 255, 175, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = blink ? GREEN : 'rgba(157,255,192,0.35)';
    ctx.beginPath();
    ctx.arc(bx + 9 * s, by + bh * 0.5, 2.4 * s, 0, TAU);
    ctx.fill();

    ctx.fillStyle = GREEN;
    ctx.font = `700 ${Math.round(9 * s)}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillText('NVG ON', bx + 16 * s, by + bh * 0.5 + 0.5);

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // G-LOC / redout tunnel vision
  // -------------------------------------------------------------------------
  _drawGLOC(ctx, w, h) {
    const g = clamp(num(this.gloc, 0), -1, 1);
    const amp = clamp((Math.abs(g) - 0.15) / 0.85, 0, 1);
    if (amp <= 0) return;
    const cx = w * 0.5;
    const cy = h * 0.47;
    const minD = Math.min(w, h);
    const maxD = Math.hypot(w, h) * 0.55;
    const inner = Math.max(0, minD * (0.50 - 0.38 * amp));
    const blackout = g > 0;

    ctx.save();

    if (!blackout) {
      // Crimson wash bleeding through the redout.
      ctx.fillStyle = `rgba(176, 10, 16, ${(0.16 * amp).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    const grad = radial(ctx, cx, cy, inner, cx, cy, maxD);
    const rgb = blackout ? '0,0,0' : '120,4,10';
    const edge = (blackout ? 0.97 : 0.90) * amp;
    const mid = 0.20 * amp;
    if (!addStops(grad, [
      [0, `rgba(${rgb},0)`],
      [0.52, `rgba(${rgb},${mid.toFixed(3)})`],
      [0.82, `rgba(${rgb},${(edge * 0.72).toFixed(3)})`],
      [1, `rgba(${rgb},${edge.toFixed(3)})`],
    ])) {
      ctx.fillStyle = `rgba(${rgb},${(0.55 * amp).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      return;
    }

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Slow pulse at heavy blackout for a "tunnel closing" feel.
    if (blackout && amp > 0.55) {
      const pulse = 0.04 * amp * (0.5 + 0.5 * Math.sin(this._t * 6));
      ctx.fillStyle = `rgba(0,0,0,${pulse.toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Projected targets, CCIP, gun reticle, steerpoint
  // -------------------------------------------------------------------------
  _drawTargets(ctx, w, h, s, state) {
    const camera = state.camera || null;
    const own = this._ownPos(state);
    const headingDeg = this._heading(state);
    const targets = Array.isArray(state.targets) ? state.targets : [];
    const locked = state.lockedTarget || null;

    let plotted = 0;
    for (const t of targets) {
      if (!t || t === locked || t.alive === false) continue;
      if (plotted >= 40) break;
      const p = this._project(t.position, camera, w, h);
      if (!p || p.behind) continue;
      if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue;
      const r = 4.4 * s;
      const col = t.airborne ? AMBER : GREEN_DIM;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
      plotted++;
    }

    if (!locked) return;

    const range = this._range(locked, own);
    const selected = state.weapons && state.weapons.selected;
    const col = selected === 'AIM9' ? AMBER : GREEN;
    const label = String(locked.label || locked.kind || 'TARGET');
    const p = this._project(locked.position, camera, w, h);
    const onScreen = p && !p.behind && p.x > -24 && p.x < w + 24 && p.y > -24 && p.y < h + 24;

    if (onScreen) {
      const half = clamp(30 - ((range == null ? 4000 : range) / 20000) * 15, 13, 27) * s;
      const leg = half * 0.42;
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      // four corner brackets
      ctx.moveTo(p.x - half, p.y - half + leg);
      ctx.lineTo(p.x - half, p.y - half);
      ctx.lineTo(p.x - half + leg, p.y - half);
      ctx.moveTo(p.x + half - leg, p.y - half);
      ctx.lineTo(p.x + half, p.y - half);
      ctx.lineTo(p.x + half, p.y - half + leg);
      ctx.moveTo(p.x + half, p.y + half - leg);
      ctx.lineTo(p.x + half, p.y + half);
      ctx.lineTo(p.x + half - leg, p.y + half);
      ctx.moveTo(p.x - half + leg, p.y + half);
      ctx.lineTo(p.x - half, p.y + half);
      ctx.lineTo(p.x - half, p.y + half - leg);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.8 * s, 0, TAU);
      ctx.fillStyle = col;
      ctx.fill();

      ctx.font = `700 ${Math.round(9.5 * s)}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = col;
      const tx = clamp(p.x, 60 * s, w - 60 * s);
      ctx.fillText('LOCK ' + label, tx, clamp(p.y - half - 10 * s, 14 * s, h - 14 * s));
      ctx.font = `600 ${Math.round(9 * s)}px ${MONO}`;
      ctx.fillStyle = GREEN_DIM;
      ctx.fillText(this._fmtRange(range), tx, clamp(p.y + half + 10 * s, 14 * s, h - 14 * s));
      ctx.restore();
    } else {
      let dir = null;
      if (Number.isFinite(locked.bearingRad)) {
        const rel = num(locked.bearingRad, 0) - (headingDeg * Math.PI) / 180;
        dir = { x: Math.sin(rel), y: -Math.cos(rel) };
      } else if (own && locked.position) {
        dir = this._relDir(own, locked.position, headingDeg);
      } else if (p) {
        const dx = p.x - w * 0.5;
        const dy = p.y - h * 0.5;
        const len = Math.hypot(dx, dy) || 1;
        dir = { x: dx / len, y: dy / len };
      }
      if (dir) this._edgeArrow(ctx, dir, w, h, s, col, 'LOCK ' + label, this._fmtRange(range));
    }
  }

  _drawWeapons(ctx, w, h, s, state) {
    const weapons = state.weapons;
    if (!weapons) return;
    const selected = weapons.selected;
    const camera = state.camera || null;
    const tel = state.telemetry || {};
    const isExternal = !!tel.mode && tel.mode !== 'cockpit';
    const cx = w * 0.5;
    const cy = h * 0.46;
    const externalHorizon = h * 0.47;

    // ------------------------------------------------ true 3D anchors (12A)
    // Every anchor below is optional. With no camera, or with a solver that has
    // no valid solution this frame, we fall back to the legacy fixed screen
    // coordinates so the overlay still renders in headless/early-frame use.
    const gunSol = weapons.gunSolution && weapons.gunSolution.valid ? weapons.gunSolution : null;
    const bore = weapons.boresightPoint && weapons.boresightPoint.valid
      ? weapons.boresightPoint
      : null;
    const boreProj = bore ? this._project(bore, camera, w, h) : null;
    const boreVisible = !!(boreProj && !boreProj.behind);
    const boreOnScreen = !!(boreVisible
      && boreProj.x >= 0 && boreProj.x <= w && boreProj.y >= 0 && boreProj.y <= h);
    const bx = boreVisible ? boreProj.x : null;
    const by = boreVisible ? boreProj.y : null;

    let gunProj = null;
    if (gunSol && gunSol.aimPoint) {
      const gp = this._project(gunSol.aimPoint, camera, w, h);
      if (gp && !gp.behind) gunProj = gp;
    }
    const gx = gunProj ? gunProj.x : cx;
    const gy = gunProj ? gunProj.y : cy + (isExternal ? 0 : 13.75 * s);
    const impactValid = !!(gunSol && gunSol.impactValid);

    // ------------------------------------------------------------- CCIP
    const ccip = weapons.ccip;
    if (selected === 'MK82' && ccip && ccip.valid) {
      const p = this._project(ccip, camera, w, h);
      if (p && !p.behind && p.x > 0 && p.x < w && p.y > 0 && p.y < h) {
        // The Bomb Fall Line starts on the aircraft's true 3D flight path
        // (ccipOrigin), then the nose boresight, then the legacy centre.
        let origin = null;
        const co = weapons.ccipOrigin;
        if (co && co.valid) {
          const o = this._project(co, camera, w, h);
          if (o && !o.behind && o.x >= 0 && o.x <= w && o.y >= 0 && o.y <= h) origin = o;
        }
        if (!origin && boreVisible) origin = boreProj;
        const ox = origin ? origin.x : cx;
        const oy = origin ? origin.y : cy;

        ctx.save();
        ctx.strokeStyle = 'rgba(157,255,192,0.72)';
        ctx.lineWidth = 1.2;
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash([6 * s, 6 * s]);
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);

        const rr = (isExternal ? 11 : 13) * s;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4 * s, 0, TAU);
        ctx.fillStyle = GREEN;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(p.x - rr - 4 * s, p.y);
        ctx.lineTo(p.x - rr + 3 * s, p.y);
        ctx.moveTo(p.x + rr - 3 * s, p.y);
        ctx.lineTo(p.x + rr + 4 * s, p.y);
        ctx.moveTo(p.x, p.y - rr - 4 * s);
        ctx.lineTo(p.x, p.y - rr + 3 * s);
        ctx.moveTo(p.x, p.y + rr - 3 * s);
        ctx.lineTo(p.x, p.y + rr + 4 * s);
        ctx.stroke();

        const tti = Math.max(0, num(ccip.timeToImpact, 0));
        ctx.font = `700 ${Math.round(9.5 * s)}px ${MONO}`;
        ctx.textAlign = 'left';
        ctx.fillStyle = GREEN;
        ctx.fillText('MK-82  ' + tti.toFixed(1) + 's', clamp(p.x + rr + 8 * s, 4, w - 70 * s), clamp(p.y + rr + 8 * s, 12 * s, h - 12 * s));
        ctx.restore();
      }
    }

    // ------------------------------------------------------------- GUN
    if (selected === 'GUN') {
      const r = (isExternal ? 14 : 25) * s;

      if (isExternal) {
        // Minimal micro-HUD: a segmented level horizon anchored on the true 3D
        // boresight (ultra light so the jet stays unobstructed)...
        const rollRad = (num(tel.roll, 0) * Math.PI) / 180;
        const pitchOff = clamp(num(tel.pitch, 0), -18, 18) * 1.4 * s;
        const wx = boreOnScreen ? bx : cx;
        const wy = boreOnScreen ? by : externalHorizon + (boreVisible ? 0 : pitchOff);
        ctx.save();
        ctx.translate(wx, wy);
        ctx.rotate(-rollRad);
        ctx.strokeStyle = 'rgba(157,255,192,0.30)';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.moveTo(-42 * s, 0);
        ctx.lineTo(-18 * s, 0);
        ctx.lineTo(-18 * s, 3.5 * s);
        ctx.moveTo(42 * s, 0);
        ctx.lineTo(18 * s, 0);
        ctx.lineTo(18 * s, 3.5 * s);
        ctx.stroke();
        ctx.restore();

        // ...and the crisp ballistic gun pipper on the true 3D trajectory the
        // rounds actually follow (tiny ring + dot + 4 short ticks).
        const pr = 5.5 * s;
        ctx.save();
        ctx.strokeStyle = impactValid ? GREEN : 'rgba(157,255,192,0.72)';
        ctx.fillStyle = impactValid ? GREEN : 'rgba(157,255,192,0.85)';
        ctx.lineWidth = impactValid ? 1.4 : 1.0;
        ctx.beginPath();
        ctx.arc(gx, gy, pr, 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(gx, gy, 1.5 * s, 0, TAU);
        ctx.fill();
        const tick = impactValid ? 4.5 : 3.5;
        ctx.beginPath();
        ctx.moveTo(gx - pr - tick * s, gy);
        ctx.lineTo(gx - pr - 0.5 * s, gy);
        ctx.moveTo(gx + pr + 0.5 * s, gy);
        ctx.lineTo(gx + pr + tick * s, gy);
        ctx.moveTo(gx, gy - pr - tick * s);
        ctx.lineTo(gx, gy - pr - 0.5 * s);
        ctx.moveTo(gx, gy + pr + 0.5 * s);
        ctx.lineTo(gx, gy + pr + tick * s);
        ctx.stroke();
        ctx.restore();
      } else {
        // Cockpit EEGS: the pipper sits exactly on the projected 3D ballistic
        // point, so rounds go through the reticle dot in turns / AoA / head-look.
        ctx.save();
        ctx.strokeStyle = GREEN;
        ctx.lineWidth = 1.2;

        if (typeof ctx.setLineDash === 'function') ctx.setLineDash([3 * s, 4 * s]);
        ctx.beginPath();
        ctx.arc(gx, gy, r, 0, TAU);
        ctx.stroke();
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);

        ctx.beginPath();
        ctx.moveTo(gx - r * 1.75, gy - r * 1.8);
        ctx.lineTo(gx - r * 0.48, gy);
        ctx.moveTo(gx + r * 1.75, gy - r * 1.8);
        ctx.lineTo(gx + r * 0.48, gy);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(gx - 7 * s, gy);
        ctx.lineTo(gx - 2 * s, gy);
        ctx.moveTo(gx + 2 * s, gy);
        ctx.lineTo(gx + 7 * s, gy);
        ctx.moveTo(gx, gy - 5 * s);
        ctx.lineTo(gx, gy + 5 * s);
        ctx.stroke();

        for (const off of [-r * 0.62, 0, r * 0.62]) {
          ctx.beginPath();
          ctx.moveTo(gx + off, gy - r);
          ctx.lineTo(gx + off, gy - r + 4 * s);
          ctx.stroke();
        }

        ctx.font = `700 ${Math.round(9 * s)}px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = GREEN_DIM;
        ctx.fillText('GUN', gx, gy + r + 10 * s);
        ctx.restore();
      }

      // Ballistic lead pipper: the true 3D leadPoint when the solver provides
      // one, otherwise the legacy velocity-lead approximation.
      let leadProj = null;
      let leadTof = 0;
      if (gunSol) {
        if (gunSol.leadValid && gunSol.leadPoint) {
          const lp = this._project(gunSol.leadPoint, camera, w, h);
          if (lp && !lp.behind && lp.x > 0 && lp.x < w && lp.y > 0 && lp.y < h) leadProj = lp;
        }
      } else {
        const t = state.lockedTarget;
        if (t && t.airborne && t.position) {
          const range = this._range(t, this._ownPos(state));
          const tof = clamp((range == null ? 900 : range) / 1030, 0.12, 2.2);
          leadTof = tof;
          const lead = {
            x: vecNum(t.position, 'x') + vecNum(t.velocity, 'x') * tof,
            y: vecNum(t.position, 'y') + vecNum(t.velocity, 'y') * tof,
            z: vecNum(t.position, 'z') + vecNum(t.velocity, 'z') * tof,
          };
          const q = this._project(lead, camera, w, h);
          if (q && !q.behind && q.x > 0 && q.x < w && q.y > 0 && q.y < h) leadProj = q;
        }
      }

      if (leadProj) {
        const lr = (gunSol ? 7 : clamp(9 - leadTof * 2.5, 4, 9)) * s;
        ctx.save();
        if (isExternal) {
          // Faint dashed cue from the nose boresight to the lead ring: put the
          // boresight on the ring and the rounds will meet the target.
          const ax = bx != null ? bx : gx;
          const ay = by != null ? by : gy;
          ctx.strokeStyle = 'rgba(255,196,107,0.30)';
          ctx.lineWidth = 1.0;
          if (typeof ctx.setLineDash === 'function') ctx.setLineDash([2.5 * s, 5 * s]);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(leadProj.x, leadProj.y);
          ctx.stroke();
          if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
        }
        ctx.strokeStyle = AMBER;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(leadProj.x, leadProj.y, lr, 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(leadProj.x, leadProj.y, 1.8 * s, 0, TAU);
        ctx.fillStyle = AMBER;
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(leadProj.x - lr - 5 * s, leadProj.y);
        ctx.lineTo(leadProj.x - lr - 1.5 * s, leadProj.y);
        ctx.moveTo(leadProj.x + lr + 1.5 * s, leadProj.y);
        ctx.lineTo(leadProj.x + lr + 5 * s, leadProj.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ------------------------------------------------------------- AIM-9
    if (selected === 'AIM9') {
      // Seeker field-of-view cue on the true 3D nose boresight, so in chase or
      // cockpit head-look you see exactly where the seeker is looking.
      const sx = boreVisible ? bx : cx;
      const sy = boreVisible ? by : cy;
      const locked = !!(state.lockedTarget && state.lockedTarget.alive !== false);
      const sr = 11 * s;

      ctx.save();
      if (locked) {
        ctx.strokeStyle = AMBER;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, TAU);
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(157,255,192,0.42)';
        ctx.lineWidth = 1.0;
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash([3 * s, 5 * s]);
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, TAU);
        ctx.stroke();
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.moveTo(sx - sr - 4 * s, sy);
      ctx.lineTo(sx - sr + 2 * s, sy);
      ctx.moveTo(sx + sr - 2 * s, sy);
      ctx.lineTo(sx + sr + 4 * s, sy);
      ctx.moveTo(sx, sy - sr - 4 * s);
      ctx.lineTo(sx, sy - sr + 2 * s);
      ctx.moveTo(sx, sy + sr - 2 * s);
      ctx.lineTo(sx, sy + sr + 4 * s);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(sx, sy, 1.6 * s, 0, TAU);
      ctx.fillStyle = locked ? AMBER : 'rgba(157,255,192,0.55)';
      ctx.fill();
      ctx.restore();
    }
  }

  _drawSteerpoint(ctx, w, h, s, state) {
    const mission = state.mission;
    const st = mission && mission.steerpoint;
    if (!st) return;

    const distNm = Number.isFinite(st.distanceNm)
      ? Math.max(0, st.distanceNm)
      : Math.max(0, num(st.distanceM, 0)) / 1852;
    const idx = Math.max(1, Math.round(num(
      st.index != null ? st.index : (mission.steerpointIndex != null ? mission.steerpointIndex : 1),
      1,
    )));
    const label = `STPT ${idx} \u00b7 ${distNm.toFixed(1)} NM`;
    const sub = String(st.label || 'OBJECTIVE');

    const p = this._project(st, state.camera, w, h);
    const onScreen = p && !p.behind && p.x > -16 && p.x < w + 16 && p.y > -16 && p.y < h + 16;

    if (onScreen) {
      ctx.save();
      const half = 8 * s;
      ctx.strokeStyle = AMBER;
      ctx.lineWidth = 1.3;
      ctx.strokeRect(p.x - half, p.y - half, half * 2, half * 2);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + half + 2 * s);
      ctx.lineTo(p.x - 4 * s, p.y + half + 7 * s);
      ctx.lineTo(p.x + 4 * s, p.y + half + 7 * s);
      ctx.closePath();
      ctx.fillStyle = AMBER;
      ctx.fill();

      ctx.font = `700 ${Math.round(9.5 * s)}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = AMBER;
      const tx = clamp(p.x, 76 * s, w - 76 * s);
      ctx.fillText(label, tx, clamp(p.y - half - 22 * s, 14 * s, h - 14 * s));
      ctx.font = `600 ${Math.round(8.5 * s)}px ${MONO}`;
      ctx.fillStyle = GREEN_DIM;
      ctx.fillText(sub, tx, clamp(p.y - half - 10 * s, 14 * s, h - 14 * s));
      ctx.restore();
      return;
    }

    let dir = null;
    if (Number.isFinite(st.relBearingDeg)) {
      const rel = (st.relBearingDeg * Math.PI) / 180;
      dir = { x: Math.sin(rel), y: -Math.cos(rel) };
    } else {
      const own = this._ownPos(state);
      if (own) dir = this._relDir(own, st, this._heading(state));
    }
    if (dir) this._edgeArrow(ctx, dir, w, h, s, AMBER, label, sub);
  }

  // -------------------------------------------------------------------------
  // RWR azimuth scope
  // -------------------------------------------------------------------------
  _drawRWR(ctx, w, h, s, state) {
    const R = 54 * clamp(s, 0.9, 1.1);
    const cx = w - 20 * s - R;
    const cy = h - 20 * s - R;
    const contacts = Array.isArray(state.rwrContacts) ? state.rwrContacts : [];
    const headingRad = (this._heading(state) * Math.PI) / 180;

    ctx.save();

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fillStyle = 'rgba(3, 9, 6, 0.62)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(157,255,192,0.30)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    for (const f of [0.35, 0.68]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * f, 0, TAU);
      ctx.strokeStyle = 'rgba(157,255,192,0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(157,255,192,0.14)';
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.9, cy);
    ctx.lineTo(cx + R * 0.9, cy);
    ctx.moveTo(cx, cy - R * 0.9);
    ctx.lineTo(cx, cy + R * 0.9);
    ctx.stroke();

    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU - Math.PI / 2;
      const r0 = R * (i % 3 === 0 ? 0.84 : 0.90);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * R * 0.97, cy + Math.sin(a) * R * 0.97);
      ctx.stroke();
    }

    // Nose reference caret at scope top.
    ctx.beginPath();
    ctx.moveTo(cx, cy - R + 2 * s);
    ctx.lineTo(cx - 4.5 * s, cy - R + 9 * s);
    ctx.lineTo(cx + 4.5 * s, cy - R + 9 * s);
    ctx.closePath();
    ctx.fillStyle = GREEN;
    ctx.fill();

    ctx.font = `700 ${Math.round(8 * s)}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = GREEN_DIM;
    ctx.fillText('RWR', cx, cy + R * 0.60);

    let maxD = 18000;
    for (const c of contacts) maxD = Math.max(maxD, num(c && c.distance, 0));

    let anyLaunch = false;
    for (const c of contacts) {
      if (!c) continue;
      const cState = String(c.state || 'SEARCH').toUpperCase();
      const missile = !!c.isMissile || cState === 'LAUNCH';
      if (cState === 'LAUNCH') anyLaunch = true;
      const dist = Math.max(0, num(c.distance, 0));
      const bearing = num(c.bearingRad, 0) - headingRad;
      const rr = clamp(dist / maxD, 0.10, 1) * (R - 10 * s);
      const px = cx + Math.sin(bearing) * rr;
      const py = cy - Math.cos(bearing) * rr;

      const col = cState === 'LAUNCH' ? RED : (cState === 'LOCK' ? AMBER : GREEN);
      if (cState === 'LAUNCH' && Math.sin(this._t * 22) < -0.2) continue;

      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1.2;

      if (missile) {
        ctx.beginPath();
        ctx.arc(px, py, 7.5 * s, 0, TAU);
        ctx.stroke();
      } else if (cState === 'LOCK') {
        ctx.beginPath();
        ctx.arc(px, py, 6.5 * s, 0, TAU);
        ctx.stroke();
      }

      const sym = this._rwrSymbol(c);
      ctx.font = `700 ${Math.round((sym.length > 1 ? 7.2 : 8.6) * s)}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(sym, px, py + 0.5);
    }

    ctx.restore();

    if (anyLaunch) {
      const flash = Math.sin(this._t * 20) > 0;
      ctx.save();
      ctx.font = `700 ${Math.round(10 * s)}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = flash ? RED : 'rgba(255,107,94,0.45)';
      ctx.fillText('MISSILE LAUNCH', cx, cy - R - 11 * s);
      ctx.restore();
    }
  }

  _rwrSymbol(contact) {
    const text = String(contact.kind || contact.label || contact.type || '').toUpperCase();
    if (contact.isMissile || String(contact.state || '').toUpperCase() === 'LAUNCH') return 'M';
    if (text.includes('MIG') || text.includes('BANDIT') || text.includes('FIGHTER')) return '29';
    if (text.includes('SAM') || text.includes('SA-')) return 'S';
    if (text.includes('AAA')) return 'A';
    if (text.includes('RADAR') || text.includes('EWR') || text.includes('EARLY')) return 'R';
    return 'R';
  }

  // -------------------------------------------------------------------------
  // Weapon / flare strip + radio feed
  // -------------------------------------------------------------------------
  _drawWeaponStrip(ctx, w, h, s, state) {
    const weapons = state.weapons;
    if (!weapons || !weapons.ammo) return;

    const ammo = weapons.ammo;
    const segs = [
      { key: 'GUN', text: 'GUN ' + Math.round(num(ammo.GUN, 0)) },
      { key: 'AIM9', text: 'AIM-9 ' + Math.round(num(ammo.AIM9, 0)) },
      { key: 'MK82', text: 'MK-82 ' + Math.round(num(ammo.MK82, 0)) },
      { key: 'FLARE', text: 'FLR ' + Math.round(num(ammo.FLARE, 0)) },
    ];

    const font = `700 ${Math.round(9 * s)}px ${MONO}`;
    ctx.save();
    ctx.font = font;

    const widths = segs.map((sg) => this._textW(ctx, sg.text));
    const segPad = 11 * s;
    const total = widths.reduce((a, b) => a + b + segPad, 0) + 10 * s;
    const hgt = 22 * s;
    const x1 = w - 20 * s;
    const x0 = x1 - total;
    const R = 54 * clamp(s, 0.9, 1.1);
    const y0 = h - 20 * s - 2 * R - 9 * s - hgt;

    roundRectPath(ctx, x0, y0, total, hgt, 4 * s);
    ctx.fillStyle = 'rgba(4, 10, 7, 0.58)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(157,255,192,0.20)';
    ctx.lineWidth = 1;
    ctx.stroke();

    let cur = x0 + 5 * s;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const sw = widths[i] + segPad;
      const selected = weapons.selected === seg.key;
      if (selected) {
        roundRectPath(ctx, cur + 1 * s, y0 + 3 * s, sw - 2 * s, hgt - 6 * s, 3 * s);
        ctx.fillStyle = 'rgba(255,196,107,0.16)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,196,107,0.62)';
        ctx.stroke();
      }
      ctx.fillStyle = selected ? AMBER : (num(ammo[seg.key], 0) <= 0 ? 'rgba(157,255,192,0.30)' : INK);
      ctx.textAlign = 'center';
      ctx.fillText(seg.text, cur + sw * 0.5, y0 + hgt * 0.5 + 0.5);
      cur += sw;
    }

    ctx.restore();
  }

  _drawRadioFeed(ctx, w, h, s, state) {
    const mission = state.mission;
    const radio = mission && Array.isArray(mission.radio) ? mission.radio : [];
    if (radio.length === 0) return;

    const msgs = radio.slice(-3);
    const x = 16 * s;
    const y = (this.nvg ? 40 * s : 14 * s);
    const maxW = Math.min(330 * s, w * 0.36);
    const font = `600 ${Math.round(9 * s)}px ${MONO}`;

    ctx.save();
    ctx.font = font;

    const blocks = [];
    for (const m of msgs) {
      if (!m) continue;
      const sender = m.sender ? String(m.sender) + ': ' : '';
      const body = String(m.text || '');
      blocks.push({
        msg: m,
        lines: this._wrapText(ctx, (sender + body).trim(), maxW - 16 * s, 2),
      });
    }
    if (blocks.length === 0) {
      ctx.restore();
      return;
    }

    const lineH = 11.5 * s;
    const gap = 4 * s;
    let panelH = 10 * s;
    for (const b of blocks) panelH += b.lines.length * lineH + gap;

    roundRectPath(ctx, x, y, maxW, panelH, 4 * s);
    ctx.fillStyle = 'rgba(4, 10, 7, 0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(157,255,192,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    let ty = y + 5 * s + lineH * 0.5;
    for (const b of blocks) {
      const m = b.msg;
      const ttl = Math.max(0.001, num(m.ttl, 7.5));
      const age = Math.max(0, num(m.age, 0));
      const alpha = clamp(1 - age / ttl, 0.22, 1);
      const pri = String(m.priority || 'info');
      const col = pri === 'urgent' ? RED : (pri === 'warn' ? AMBER : GREEN);

      ctx.globalAlpha = alpha;
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      for (const line of b.lines) {
        ctx.fillText(line, x + 8 * s, ty);
        ty += lineH;
      }
      ty += gap;
    }
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Small drawing helpers
  // -------------------------------------------------------------------------
  _edgeArrow(ctx, dir, w, h, s, color, label, sub) {
    const dx = num(dir && dir.x, 0);
    const dy = num(dir && dir.y, -1);
    const len = Math.hypot(dx, dy);
    if (!(len > 0.0001)) return;
    const nx = dx / len;
    const ny = dy / len;
    const margin = 46 * s;
    const cx = w * 0.5;
    const cy = h * 0.47;
    const pt = this._edgePoint(cx, cy, nx, ny, w, h, margin);

    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(Math.atan2(ny, nx) + Math.PI * 0.5);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, -11 * s);
    ctx.lineTo(-6 * s, 4 * s);
    ctx.lineTo(0, 0.5 * s);
    ctx.lineTo(6 * s, 4 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.font = `700 ${Math.round(9.5 * s)}px ${MONO}`;
    let align = 'center';
    let tx = pt.x;
    if (nx > 0.45) {
      align = 'right';
      tx = pt.x - 12 * s;
    } else if (nx < -0.45) {
      align = 'left';
      tx = pt.x + 12 * s;
    }
    ctx.textAlign = align;

    let ty = pt.y - 18 * s;
    if (ny > 0.45) ty = pt.y - 30 * s;
    else if (ny < -0.45) ty = pt.y + 20 * s;
    ty = clamp(ty, 14 * s, h - 28 * s);
    tx = clamp(tx, 8 * s, w - 8 * s);

    ctx.fillStyle = color;
    ctx.fillText(label, tx, ty);
    if (sub) {
      ctx.font = `600 ${Math.round(8.5 * s)}px ${MONO}`;
      ctx.fillStyle = GREEN_DIM;
      ctx.fillText(sub, tx, ty + 11.5 * s);
    }
    ctx.restore();
  }

  _edgePoint(cx, cy, dx, dy, w, h, margin) {
    const minX = margin;
    const maxX = w - margin;
    const minY = margin;
    const maxY = h - margin;
    let t = Infinity;
    if (Math.abs(dx) > 0.0001) {
      const tx = dx > 0 ? (maxX - cx) / dx : (minX - cx) / dx;
      if (tx > 0) t = Math.min(t, tx);
    }
    if (Math.abs(dy) > 0.0001) {
      const ty = dy > 0 ? (maxY - cy) / dy : (minY - cy) / dy;
      if (ty > 0) t = Math.min(t, ty);
    }
    if (!Number.isFinite(t) || t <= 0) t = 0;
    return { x: cx + dx * t, y: cy + dy * t };
  }

  _project(pos, camera, w, h) {
    if (!pos || !camera || !camera.matrixWorldInverse || !camera.projectionMatrix) return null;
    const x = num(pos.x, NaN);
    const y = num(pos.y, NaN);
    const z = num(pos.z, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;

    const camSpace = this._v1.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    const behind = camSpace.z > -0.5;

    let ndc;
    try {
      ndc = this._v2.set(x, y, z).project(camera);
    } catch (err) {
      return null;
    }
    if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) return null;

    return {
      x: (ndc.x * 0.5 + 0.5) * w,
      y: (-ndc.y * 0.5 + 0.5) * h,
      behind: behind || ndc.z > 1,
      ndcX: ndc.x,
      ndcY: ndc.y,
    };
  }

  _heading(state) {
    const t = state && state.telemetry;
    if (t && Number.isFinite(t.heading)) return t.heading;
    if (state && Number.isFinite(state.heading)) return state.heading;
    return 0;
  }

  _ownPos(state) {
    const t = state && state.telemetry;
    if (t) {
      const p = t.position || t.pos || t;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
        return { x: p.x, y: p.y, z: p.z };
      }
    }
    const fl = state && state.flight;
    if (fl && fl.position && Number.isFinite(fl.position.x)) {
      return { x: fl.position.x, y: num(fl.position.y), z: num(fl.position.z) };
    }
    return null;
  }

  _range(target, own) {
    if (!target) return null;
    const p = target.position;
    if (own && p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      const dx = p.x - own.x;
      const dy = p.y - own.y;
      const dz = p.z - own.z;
      const d = Math.hypot(dx, dy, dz);
      if (Number.isFinite(d)) return d;
    }
    if (Number.isFinite(target.distance)) return Math.max(0, target.distance);
    return null;
  }

  _fmtRange(m) {
    if (!Number.isFinite(m)) return '';
    if (m >= 926) return (m / 1852).toFixed(1) + ' NM';
    return Math.round(m) + ' M';
  }

  _relDir(own, pos, headingDeg) {
    const dx = num(pos.x) - own.x;
    const dz = num(pos.z) - own.z;
    const bearing = Math.atan2(dx, -dz);
    const rel = bearing - (num(headingDeg, 0) * Math.PI) / 180;
    return { x: Math.sin(rel), y: -Math.cos(rel) };
  }

  _textW(ctx, text) {
    if (typeof ctx.measureText === 'function') {
      try {
        const m = ctx.measureText(text);
        if (m && Number.isFinite(m.width)) return m.width;
      } catch (err) {
        /* fall through */
      }
    }
    return String(text).length * 6;
  }

  _wrapText(ctx, text, maxW, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (words.length === 0) return [''];
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
      const probe = cur ? cur + ' ' + words[i] : words[i];
      if (!cur || this._textW(ctx, probe) <= maxW) {
        cur = probe;
      } else {
        lines.push(cur);
        cur = words[i];
        if (lines.length >= maxLines - 1) {
          // Fill the last available line with the remaining words.
          const rest = words.slice(i).join(' ');
          let last = rest;
          while (last.length > 4 && this._textW(ctx, last) > maxW) {
            last = last.slice(0, -1);
          }
          if (last !== rest) last = last.replace(/\s+\S*$/, '') + '\u2026';
          lines.push(last);
          return lines;
        }
      }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, maxLines);
  }
}