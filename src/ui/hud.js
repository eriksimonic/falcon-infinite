// Dual-mode Canvas 2D HUD:
// - Cockpit view: authentic green F-16C HUD symbology.
// - External views (chase / wing / orbit): clean edge-anchored telemetry dock
//   with a 100% unobstructed center viewport.
const GREEN = '#8dffb4';
const GREEN_DIM = 'rgba(141,255,180,0.48)';
const INK = '#e8f5ee';
const MUTED = 'rgba(186,214,199,0.62)';
const AMBER = '#ffc46b';
const RED = '#ff6b5e';

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function wrapDeltaDeg(a, b) {
  return ((a - b + 540) % 360) - 180;
}

// Clamp a deviation to the ±1 full-scale needle range.
function clamp1(v) {
  if (!Number.isFinite(v)) return 0;
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

export class HUD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.visible = true;
    this._t = 0;
    this._lastMode = null;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * dpr);
    this.canvas.height = Math.floor(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setVisible(v) {
    this.visible = v;
    this.canvas.style.display = v ? 'block' : 'none';
  }

  update(dt, t, tactical = null) {
    if (!this.visible || !t) return;
    this._t += dt;
    this._lastMode = t.mode;
    // Redraw every animation frame: at 60+ FPS a 30 FPS throttle left the 2D
    // CCIP/gun pippers one or two WebGL frames behind the scene during
    // manoeuvres.
    this.draw(t, tactical);
  }

  draw(t, tactical = null) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!t) return;
    // Mist wash sits under all symbology so instruments stay crisp in cloud.
    this._drawCloudMist(t);
    // Feature 32 cinematic stress cues sit under the avionics symbology.
    this._drawJuiceFx(t);
    if (t.mode === 'cockpit') {
      this.drawCockpitHUD(t);
    } else {
      this.drawExternalHUD(t);
    }
    // Feature 30/32 shared racing + optical-pod strips (both view modes).
    this._drawCanyonStrip(t);
    this._drawWeaponCamBanner(t);
    if (tactical && tactical.overlay) {
      tactical.overlay.draw(ctx, this.w, this.h, tactical);
    }
    if (tactical && tactical.kneeboard && tactical.kneeboard.visible && tactical.kneeboardState) {
      tactical.kneeboard.draw(ctx, this.w, this.h, tactical.kneeboardState);
    }
  }

  // -------------------------------------------------------------------------
  // External camera UI: unobstructed center, sleek edge-anchored telemetry
  // -------------------------------------------------------------------------
  drawExternalHUD(t) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const s = Math.max(0.76, Math.min(1.12, Math.min(w / 1440, h / 820)));
    const accent = t.night > 0.5 ? '#a8ffc2' : GREEN;
    const mono = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

    ctx.save();
    ctx.textBaseline = 'middle';

    // 1. Top-center compact magnetic compass strip --------------------------
    const cw = Math.min(340 * s, w * 0.42);
    const ch = 36 * s;
    const cx = w * 0.5;
    const cy = 14 * s;

    roundRect(ctx, cx - cw * 0.5, cy, cw, ch, 6 * s);
    ctx.fillStyle = 'rgba(5, 11, 8, 0.54)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Clip ticks inside compass box
    ctx.save();
    roundRect(ctx, cx - cw * 0.5 + 8 * s, cy + 2, cw - 16 * s, ch - 4, 4 * s);
    ctx.clip();

    const hdg = ((t.heading % 360) + 360) % 360;
    const pxPerDeg = 3.2 * s;
    const baseTick = Math.floor(hdg / 5) * 5;
    ctx.font = `${Math.round(9.5 * s)}px ${mono}`;
    ctx.textAlign = 'center';

    for (let off = -65; off <= 65; off += 5) {
      const deg = (baseTick + off + 360) % 360;
      const diff = wrapDeltaDeg(deg, hdg);
      const x = cx + diff * pxPerDeg;
      if (Math.abs(x - cx) > cw * 0.5 - 6 * s) continue;
      const major = deg % 30 === 0;
      const mid = deg % 10 === 0;
      ctx.strokeStyle = major ? 'rgba(200, 255, 220, 0.72)' : 'rgba(141, 255, 180, 0.34)';
      ctx.lineWidth = major ? 1.2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, cy + ch - 4 * s);
      ctx.lineTo(x, cy + ch - (major ? 12 : mid ? 9 : 6) * s);
      ctx.stroke();

      if (major) {
        const cardinals = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
        const lbl = cardinals[deg] || String(deg / 10).padStart(2, '0');
        ctx.fillStyle = cardinals[deg] ? accent : MUTED;
        ctx.fillText(lbl, x, cy + 12 * s);
      }
    }

    // Airport bearing bug on compass
    if (t.airport && t.bearing != null) {
      const bDiff = wrapDeltaDeg(t.bearing, hdg);
      const bx = Math.max(cx - cw * 0.5 + 14 * s, Math.min(cx + cw * 0.5 - 14 * s, cx + bDiff * pxPerDeg));
      ctx.fillStyle = AMBER;
      ctx.beginPath();
      ctx.moveTo(bx, cy + ch - 2 * s);
      ctx.lineTo(bx - 4.5 * s, cy + ch - 9 * s);
      ctx.lineTo(bx + 4.5 * s, cy + ch - 9 * s);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Center heading pill floating seamlessly over the strip
    const pillW = 48 * s;
    const pillH = 20 * s;
    roundRect(ctx, cx - pillW * 0.5, cy + (ch - pillH) * 0.5, pillW, pillH, 4 * s);
    ctx.fillStyle = 'rgba(7, 16, 11, 0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.55)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.font = `700 ${Math.round(11.5 * s)}px ${mono}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(hdg) % 360).padStart(3, '0') + '°', cx, cy + ch * 0.5 + 0.5);

    // 1b. Minimal ILS approach pill (top-left) — never blocks the jet -------
    this._drawExternalILS(ctx, t, s, mono);

    // 1c. Instant replay badge, tucked below the compass strip --------------
    this._drawReplayBanner(ctx, t, s, mono, cy + ch + 42 * s);

    // 2. Top-right camera mode badge ----------------------------------------
    const modeLabel = 'EXT · ' + (t.mode || 'CHASE').toUpperCase();
    const hintLabel = 'V COCKPIT  ·  C CAM  ·  F1 HIDE';
    const badgeW = 196 * s;
    const badgeH = 38 * s;
    const bx = w - badgeW - 20 * s;
    const by = 14 * s;
    roundRect(ctx, bx, by, badgeW, badgeH, 6 * s);
    ctx.fillStyle = 'rgba(5, 11, 8, 0.50)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'right';
    ctx.fillStyle = accent;
    ctx.font = `700 ${Math.round(10.5 * s)}px ${mono}`;
    ctx.fillText(modeLabel, bx + badgeW - 11 * s, by + 13 * s);
    ctx.fillStyle = MUTED;
    ctx.font = `${Math.round(8.5 * s)}px ${mono}`;
    ctx.fillText(hintLabel, bx + badgeW - 11 * s, by + 27 * s);

    // 2b. Compact live wind indicator pill tucked below camera badge
    const windKts = Math.round(t.windKts ?? 0);
    const windDir = Math.round(t.windDir ?? 0) % 360;
    const wPillW = 148 * s;
    const wPillH = 26 * s;
    const wPillX = w - wPillW - 20 * s;
    const wPillY = by + badgeH + 7 * s;
    roundRect(ctx, wPillX, wPillY, wPillW, wPillH, 5 * s);
    ctx.fillStyle = 'rgba(5, 11, 8, 0.50)';
    ctx.fill();
    ctx.strokeStyle = windKts >= 25 ? 'rgba(255, 196, 107, 0.35)' : 'rgba(141, 255, 180, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Relative wind arrow (direction wind blows TO relative to aircraft nose)
    const relWindRad = (((windDir + 180) - hdg) * Math.PI) / 180;
    this._drawWindArrow(ctx, wPillX + 16 * s, wPillY + wPillH * 0.5, 7.5 * s, relWindRad, windKts >= 25 ? AMBER : accent);

    ctx.textAlign = 'right';
    ctx.fillStyle = MUTED;
    ctx.font = `600 ${Math.round(8.5 * s)}px ${mono}`;
    ctx.fillText('WND', wPillX + 54 * s, wPillY + wPillH * 0.5 + 0.5);
    ctx.fillStyle = windKts >= 25 ? AMBER : INK;
    ctx.font = `700 ${Math.round(10 * s)}px ${mono}`;
    ctx.fillText(`${String(windDir).padStart(3, '0')}°/${String(windKts).padStart(2, '0')}KT`, wPillX + wPillW - 10 * s, wPillY + wPillH * 0.5 + 0.5);

    // 3. Warnings banner (compact, tucked below compass — never over jet!) --
    const warnings = [];
    if (t.stall) warnings.push({ text: 'STALL', color: RED });
    if (!t.onGround && t.gear && t.aglFt < 700 && t.vsFpm < -900) warnings.push({ text: 'PULL UP', color: AMBER });
    if (t.kts > 620) warnings.push({ text: 'OVERSPEED', color: RED });
    if (!t.gear && t.aglFt < 500 && t.vsFpm < -300) warnings.push({ text: 'GEAR', color: RED });

    if (warnings.length > 0) {
      const flash = Math.sin(this._t * 12) > 0;
      const warnText = warnings.map((item) => item.text).join('  ·  ');
      const primaryCol = warnings[0].color;
      ctx.font = `700 ${Math.round(11.5 * s)}px ${mono}`;
      const ww = Math.max(110 * s, ctx.measureText(warnText).width + 28 * s);
      const wh = 24 * s;
      const wy = cy + ch + 10 * s;
      roundRect(ctx, cx - ww * 0.5, wy, ww, wh, 4 * s);
      ctx.fillStyle = flash ? 'rgba(38, 10, 8, 0.85)' : 'rgba(20, 8, 7, 0.55)';
      ctx.fill();
      ctx.strokeStyle = primaryCol;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = flash ? primaryCol : 'rgba(255, 180, 160, 0.72)';
      ctx.textAlign = 'center';
      ctx.fillText(warnText, cx, wy + wh * 0.5 + 0.5);
    }

    // Subtle micro level-horizon reference in follow/external view (non-intrusive)
    if (t.mode !== 'cockpit') {
      ctx.save();
      const mcx = w * 0.5;
      const mcy = h * 0.47 + Math.max(-24 * s, Math.min(24 * s, (t.pitch / 20) * 24 * s));
      ctx.translate(mcx, mcy);
      ctx.rotate((-t.roll * Math.PI) / 180);
      ctx.strokeStyle = 'rgba(141, 255, 180, 0.24)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-48 * s, 0);
      ctx.lineTo(-22 * s, 0);
      ctx.moveTo(22 * s, 0);
      ctx.lineTo(48 * s, 0);
      ctx.stroke();
      ctx.restore();
    }

    // 4. Bottom-center compact Flight Instrument Dock -----------------------
    // Sized cleanly to avoid overlapping #atc (left: 24px, ~210px wide)
    // and well below #toast (bottom: 12vh).
    const dockW = Math.min(640 * s, Math.max(460 * s, w - 490 * s));
    const dockH = 58 * s;
    const dockX = cx - dockW * 0.5;
    const dockY = h - dockH - 18 * s;

    roundRect(ctx, dockX, dockY, dockW, dockH, 8 * s);
    ctx.fillStyle = 'rgba(5, 11, 8, 0.62)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Subtle top edge glint
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.14)';
    ctx.beginPath();
    ctx.moveTo(dockX + 16 * s, dockY + 0.5);
    ctx.lineTo(dockX + dockW - 16 * s, dockY + 0.5);
    ctx.stroke();

    // Column anchors inside the dock
    const spdX = dockX + 18 * s;
    const thrX = dockX + dockW * 0.21;
    const attX = dockX + dockW * 0.435;
    const altX = dockX + dockW * 0.525;
    const aeroX = dockX + dockW * 0.725;
    const sysX = dockX + dockW - 14 * s;

    // Subtle dividers
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.12)';
    ctx.lineWidth = 1;
    for (const divX of [dockX + dockW * 0.19, dockX + dockW * 0.375, dockX + dockW * 0.495, dockX + dockW * 0.70, dockX + dockW * 0.83]) {
      ctx.beginPath();
      ctx.moveTo(divX, dockY + 11 * s);
      ctx.lineTo(divX, dockY + dockH - 11 * s);
      ctx.stroke();
    }

    // (a) Airspeed & Mach
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `600 ${Math.round(8.5 * s)}px ${mono}`;
    ctx.fillText('IAS', spdX, dockY + 13 * s);
    ctx.fillStyle = INK;
    ctx.font = `700 ${Math.round(18 * s)}px ${mono}`;
    ctx.fillText(String(Math.round(t.kts)).padStart(3, '0'), spdX, dockY + 31 * s);
    ctx.fillStyle = GREEN_DIM;
    ctx.font = `${Math.round(9 * s)}px ${mono}`;
    ctx.fillText('KTS', spdX + 41 * s, dockY + 33 * s);
    ctx.fillStyle = MUTED;
    ctx.font = `${Math.round(9 * s)}px ${mono}`;
    ctx.fillText('M ' + t.mach.toFixed(2), spdX, dockY + 47 * s);

    // (b) Throttle bar & AB indicator
    const thrBarW = dockW * 0.145;
    const thrBarH = 7 * s;
    const thrPct = Math.round(t.throttle * 100);
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `600 ${Math.round(8.5 * s)}px ${mono}`;
    ctx.fillText('THR', thrX, dockY + 13 * s);
    ctx.fillStyle = t.afterburner ? AMBER : accent;
    ctx.font = `700 ${Math.round(11 * s)}px ${mono}`;
    ctx.textAlign = 'right';
    ctx.fillText(t.afterburner ? 'AB ' + thrPct + '%' : thrPct + '%', thrX + thrBarW, dockY + 13 * s);

    roundRect(ctx, thrX, dockY + 26 * s, thrBarW, thrBarH, 3 * s);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fill();
    if (t.throttle > 0.005) {
      roundRect(ctx, thrX, dockY + 26 * s, Math.max(4 * s, thrBarW * t.throttle), thrBarH, 3 * s);
      ctx.fillStyle = t.afterburner ? AMBER : accent;
      ctx.fill();
    }
    // Military power tick at 89%
    ctx.strokeStyle = 'rgba(255, 196, 107, 0.55)';
    ctx.beginPath();
    ctx.moveTo(thrX + thrBarW * 0.89, dockY + 24 * s);
    ctx.lineTo(thrX + thrBarW * 0.89, dockY + 35 * s);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = t.refueling ? '#6fe3ff' : (t.fuelLb != null && t.fuelLb <= 1500 ? AMBER : MUTED);
    ctx.font = `${Math.round(8.5 * s)}px ${mono}`;
    const fuelStr = t.fuelLb != null ? ` · ${Math.round(t.fuelLb)}LB` : '';
    const apStr = t.autopilot && t.autopilot !== 'OFF' ? ` · AP ${t.autopilot === 'ALT_HDG' ? 'ALT' : 'ATT'}` : '';
    const baseThrLabel = t.refueling ? 'REFUELING' : (t.onGround ? 'GROUND' : (t.afterburner ? 'AB' : 'DRY'));
    ctx.fillText(baseThrLabel + fuelStr + apStr, thrX, dockY + 47 * s);

    // (c) Compact Mini Attitude Indicator (Horizon Ball)
    const attR = 20 * s;
    const attCy = dockY + dockH * 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.arc(attX, attCy, attR, 0, Math.PI * 2);
    ctx.clip();

    ctx.save();
    ctx.translate(attX, attCy);
    ctx.rotate((-t.roll * Math.PI) / 180);
    const pitchShift = Math.max(-attR, Math.min(attR, (t.pitch / 35) * attR));
    ctx.translate(0, pitchShift);
    ctx.fillStyle = '#14423a';
    ctx.fillRect(-attR * 2, -attR * 2.5, attR * 4, attR * 2.5);
    ctx.fillStyle = '#3b2b18';
    ctx.fillRect(-attR * 2, 0, attR * 4, attR * 2.5);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-attR * 2, 0);
    ctx.lineTo(attR * 2, 0);
    ctx.stroke();
    ctx.restore();

    // Fixed miniature aircraft reference symbol
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(attX - 11 * s, attCy);
    ctx.lineTo(attX - 4 * s, attCy);
    ctx.lineTo(attX - 2 * s, attCy + 2.5 * s);
    ctx.moveTo(attX + 11 * s, attCy);
    ctx.lineTo(attX + 4 * s, attCy);
    ctx.lineTo(attX + 2 * s, attCy + 2.5 * s);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(attX, attCy, attR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.36)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // (d) Altitude, AGL & Vertical Speed
    const altVal = Math.max(0, Math.round(t.altFt));
    const aglVal = Math.max(0, Math.round(t.aglFt / 10) * 10);
    const vsVal = Math.round(t.vsFpm / 10) * 10;
    const vsSign = vsVal >= 0 ? '+' : '';
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `600 ${Math.round(8.5 * s)}px ${mono}`;
    ctx.fillText('ALT', altX, dockY + 13 * s);
    ctx.fillStyle = INK;
    ctx.font = `700 ${Math.round(18 * s)}px ${mono}`;
    const altStr = altVal.toLocaleString();
    ctx.fillText(altStr, altX, dockY + 31 * s);
    const altW = ctx.measureText(altStr).width;
    ctx.fillStyle = GREEN_DIM;
    ctx.font = `${Math.round(9 * s)}px ${mono}`;
    ctx.fillText('FT', altX + altW + 5 * s, dockY + 33 * s);
    ctx.fillStyle = MUTED;
    ctx.font = `${Math.round(8.5 * s)}px ${mono}`;
    ctx.fillText(`AGL ${aglVal} · ${vsSign}${vsVal} FPM`, altX, dockY + 47 * s);

    // (e) G-load & Angle of Attack
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `600 ${Math.round(8.5 * s)}px ${mono}`;
    ctx.fillText('G', aeroX, dockY + 19 * s);
    ctx.fillText('AOA', aeroX, dockY + 40 * s);
    ctx.textAlign = 'right';
    ctx.fillStyle = Math.abs(t.g) > 7.5 ? AMBER : INK;
    ctx.font = `700 ${Math.round(11.5 * s)}px ${mono}`;
    ctx.fillText(t.g.toFixed(1), aeroX + 54 * s, dockY + 19 * s);
    ctx.fillStyle = t.stall ? RED : INK;
    ctx.fillText((t.aoa * 57.3).toFixed(1) + '°', aeroX + 54 * s, dockY + 40 * s);

    // (f) Compact System Status Pills (GEAR, FLAPS, BRK)
    const gearMoving = t.gearPos > 0.05 && t.gearPos < 0.95;
    const gearText = gearMoving ? 'GEAR TRN' : (t.gear ? 'GEAR DN' : 'GEAR UP');
    const gearColor = gearMoving ? AMBER : (t.gear ? accent : MUTED);
    this._drawStatusPill(ctx, sysX - 78 * s, dockY + 10 * s, 78 * s, 17 * s, gearText, gearColor, s, mono);

    const flapText = 'FLP ' + t.flaps;
    const flapCol = t.flaps > 0 ? accent : MUTED;
    const brkCol = t.brake ? AMBER : 'rgba(140, 160, 150, 0.35)';
    this._drawStatusPill(ctx, sysX - 78 * s, dockY + 32 * s, 40 * s, 17 * s, flapText, flapCol, s, mono);
    this._drawStatusPill(ctx, sysX - 35 * s, dockY + 32 * s, 35 * s, 17 * s, 'BRK', brkCol, s, mono);

    // Carrier FLOLS meatball on the left edge (clear of the dock/viewport)
    this._drawMeatball(ctx, t, s, mono);

    ctx.restore();
  }

  _drawStatusPill(ctx, x, y, w, h, text, color, s, mono) {
    roundRect(ctx, x, y, w, h, 3 * s);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = color;
    ctx.font = `700 ${Math.round(8.5 * s)}px ${mono}`;
    ctx.textAlign = 'center';
    ctx.fillText(text, x + w * 0.5, y + h * 0.5 + 0.5);
  }

  _drawWindArrow(ctx, x, y, r, angleRad, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angleRad);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, r);
    ctx.lineTo(0, -r * 0.75);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(-r * 0.45, -r * 0.25);
    ctx.lineTo(r * 0.45, -r * 0.25);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Cockpit F-16C HUD (authentic green fighter symbology)
  // -------------------------------------------------------------------------
  drawCockpitHUD(t) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;

    const s = Math.max(0.58, Math.min(1.12, Math.min(w / 1600, h / 900) * 0.88));
    const cx = w * 0.5;
    const cy = h * 0.46;
    const color = t.night > 0.5 ? '#a8ffc2' : GREEN;

    ctx.save();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.font = `${Math.round(12 * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.95;

    // ------------------------------------------------------------- pitch ladder
    const roll = (t.roll * Math.PI) / 180;
    const DEG = 8 * s;
    const pitchPx = t.pitch * DEG;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-roll);
    ctx.translate(0, pitchPx);

    for (let a = -30; a <= 30; a += 5) {
      if (a === 0) continue;
      const y = -a * DEG;
      const half = (a % 10 === 0 ? 84 : 42) * s;
      ctx.globalAlpha = a % 10 === 0 ? 0.9 : 0.55;
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(-16 * s, y);
      ctx.moveTo(16 * s, y);
      ctx.lineTo(half, y);
      ctx.stroke();
      if (a % 10 === 0) {
        ctx.font = `${Math.round(10 * s)}px ui-monospace, monospace`;
        ctx.textAlign = 'right';
        ctx.fillText(String(Math.abs(a)), -half - 6 * s, y);
        ctx.textAlign = 'left';
        ctx.fillText(String(Math.abs(a)), half + 6 * s, y);
        // tick hooks
        ctx.beginPath();
        ctx.moveTo(-half, y);
        ctx.lineTo(-half, y + (a > 0 ? 7 : -7) * s);
        ctx.moveTo(half, y);
        ctx.lineTo(half, y + (a > 0 ? 7 : -7) * s);
        ctx.stroke();
      }
    }
    // horizon
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(-160 * s, 0);
    ctx.lineTo(-24 * s, 0);
    ctx.moveTo(24 * s, 0);
    ctx.lineTo(160 * s, 0);
    ctx.stroke();

    // flight path marker (velocity vector)
    if (t.speedMs > 22 && !t.onGround) {
      const alphaDeg = (t.aoa || 0) * 57.3;
      const betaDeg = (t.sideSlip || 0) * 57.3;
      const fx = Math.max(-130 * s, Math.min(130 * s, betaDeg * DEG));
      const fy = Math.max(-130 * s, Math.min(130 * s, alphaDeg * DEG));
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.arc(fx, fy, 6 * s, 0, Math.PI * 2);
      ctx.moveTo(fx - 18 * s, fy);
      ctx.lineTo(fx - 6 * s, fy);
      ctx.moveTo(fx + 6 * s, fy);
      ctx.lineTo(fx + 18 * s, fy);
      ctx.moveTo(fx, fy - 6 * s);
      ctx.lineTo(fx, fy - 13 * s);
      ctx.stroke();
    }
    ctx.restore();

    // bank scale arc
    ctx.globalAlpha = 0.6;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.arc(0, 0, 145 * s, -Math.PI * 0.72, -Math.PI * 0.28);
    ctx.stroke();
    for (const a of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
      const ang = (a * Math.PI) / 180 - Math.PI / 2;
      const r0 = 145 * s;
      const r1 = (a % 30 === 0 ? 157 : 151) * s;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
      ctx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
      ctx.stroke();
    }
    // bank pointer
    ctx.rotate(roll);
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(0, -145 * s);
    ctx.lineTo(-6 * s, -135 * s);
    ctx.lineTo(6 * s, -135 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // boresight
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(cx - 8 * s, cy);
    ctx.lineTo(cx + 8 * s, cy);
    ctx.moveTo(cx, cy - 8 * s);
    ctx.lineTo(cx, cy + 8 * s);
    ctx.stroke();

    // ------------------------------------------------------------- speed & alt tapes
    const tapeS = 195 * s;
    this.drawTape(ctx, cx - 255 * s, cy, tapeS, t.kts, 10, 50, s, true, color);
    this.drawTape(ctx, cx + 255 * s, cy, tapeS, t.altFt, 100, 500, s, false, color);

    // ------------------------------------------------------------- heading tape
    const hdgY = cy - 195 * s;
    ctx.save();
    ctx.translate(cx, hdgY);
    const hdgRange = 40;
    const pxPerDeg = 4.2 * s;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    for (let d = -hdgRange; d <= hdgRange; d += 5) {
      const hd = (Math.round(t.heading / 5) * 5 + d + 360) % 360;
      const diff = wrapDeltaDeg(hd, t.heading);
      const x = diff * pxPerDeg;
      if (Math.abs(x) > 165 * s) continue;
      const big = hd % 10 === 0;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, (big ? 10 : 6) * s);
      ctx.stroke();
      if (hd % 30 === 0) {
        ctx.fillStyle = color;
        ctx.font = `${Math.round(10 * s)}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(String(hd / 10).padStart(2, '0'), x, 22 * s);
      }
    }
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(0, -2 * s);
    ctx.lineTo(-5 * s, -10 * s);
    ctx.lineTo(5 * s, -10 * s);
    ctx.closePath();
    ctx.fill();
    ctx.font = `bold ${Math.round(13 * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(t.heading) % 360).padStart(3, '0'), 0, -22 * s);
    ctx.restore();

    // ------------------------------------------------------------- data column
    ctx.globalAlpha = 0.92;
    ctx.font = `${Math.round(11 * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    const dx = cx + 360 * s;
    const dy = cy - 44 * s;
    const lines = [
      ['M', t.mach.toFixed(2)],
      ['G', t.g.toFixed(1)],
      ['AOA', (t.aoa * 57.3).toFixed(1)],
      ['VS', (t.vsFpm >= 0 ? '+' : '') + Math.round(t.vsFpm / 10) * 10],
      ['AGL', String(Math.max(0, Math.round(t.aglFt / 10) * 10))],
    ];
    lines.forEach(([k, v], i) => {
      ctx.fillStyle = GREEN_DIM;
      ctx.fillText(k, dx, dy + i * 18 * s);
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.fillText(v, dx + 66 * s, dy + i * 18 * s);
      ctx.textAlign = 'left';
    });

    // throttle bar
    const tx = cx - 350 * s;
    const ty = cy + 54 * s;
    ctx.globalAlpha = 0.82;
    ctx.strokeStyle = GREEN_DIM;
    ctx.strokeRect(tx, ty, 7 * s, 90 * s);
    ctx.fillStyle = t.afterburner ? AMBER : color;
    const th = 90 * s * t.throttle;
    ctx.fillRect(tx, ty + 90 * s - th, 7 * s, th);
    ctx.fillStyle = GREEN_DIM;
    ctx.font = `${Math.round(9 * s)}px ui-monospace, monospace`;
    ctx.save();
    ctx.translate(tx - 8 * s, ty + 90 * s);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'left';
    ctx.fillText('THR', 0, 0);
    ctx.restore();
    if (t.afterburner) {
      ctx.fillStyle = AMBER;
      ctx.fillText('AB', tx - 2 * s, ty - 8 * s);
    }

    // gear / flaps / brake / live wind vector (placed cleanly above glare shield)
    ctx.textAlign = 'left';
    const gx = cx - 350 * s;
    const gy = cy - 90 * s;
    ctx.fillStyle = t.gear ? GREEN : AMBER;
    ctx.fillText(t.gear ? 'GEAR DN' : 'GEAR UP', gx, gy);
    ctx.fillStyle = GREEN_DIM;
    ctx.fillText('FLAPS ' + t.flaps, gx, gy + 16 * s);
    if (t.brake) {
      ctx.fillStyle = AMBER;
      ctx.fillText('BRAKE', gx, gy + 32 * s);
    }
    const cWindKts = Math.round(t.windKts ?? 0);
    const cWindDir = Math.round(t.windDir ?? 0) % 360;
    const cRelRad = (((cWindDir + 180) - t.heading) * Math.PI) / 180;
    const wy = gy + 54 * s;
    this._drawWindArrow(ctx, gx + 7 * s, wy, 7 * s, cRelRad, cWindKts >= 25 ? AMBER : color);
    ctx.fillStyle = cWindKts >= 25 ? AMBER : color;
    ctx.font = `${Math.round(10 * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(`${String(cWindDir).padStart(3, '0')}/${String(cWindKts).padStart(2, '0')}K`, gx + 19 * s, wy + 1);

    // ------------------------------------------------------------- warnings
    const flash = Math.sin(this._t * 12) > 0;
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(15 * s)}px ui-monospace, monospace`;
    if (t.stall) {
      ctx.fillStyle = flash ? RED : 'rgba(255,107,94,0.4)';
      ctx.fillText('STALL', cx, cy + 102 * s);
    }
    if (!t.onGround && t.gear && t.aglFt < 700 && t.vsFpm < -900) {
      ctx.fillStyle = flash ? AMBER : 'rgba(255,196,107,0.4)';
      ctx.fillText('PULL UP', cx, cy + 126 * s);
    }
    if (t.kts > 620) {
      ctx.fillStyle = flash ? RED : 'rgba(255,107,94,0.4)';
      ctx.fillText('OVERSPEED', cx, cy - 150 * s);
    }
    if (!t.gear && t.aglFt < 500 && t.vsFpm < -300) {
      ctx.fillStyle = flash ? RED : 'rgba(255,107,94,0.4)';
      ctx.fillText('GEAR', cx, cy + 150 * s);
    }

    // ------------------------------------------------------- ILS approach cues
    this._drawCockpitILS(ctx, t, cx, cy, s, color);

    // Carrier FLOLS meatball + instant replay badge
    const cockpitMono = 'ui-monospace, monospace';
    this._drawMeatball(ctx, t, s, cockpitMono);
    this._drawReplayBanner(ctx, t, s, cockpitMono, 12 * s);

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Shared polish overlays: cloud mist, ILS, FLOLS meatball, replay badge
  // -------------------------------------------------------------------------
  _drawCloudMist(t) {
    const mist = t.cloudMist ?? 0;
    if (!(mist > 0.02)) return;
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const alpha = Math.min(0.36, mist * 0.36);
    const cx = w * 0.5;
    const cy = h * 0.5;
    const r = Math.hypot(w, h) * 0.5;
    const grad = ctx.createRadialGradient(cx, cy, r * 0.26, cx, cy, r * 0.95);
    grad.addColorStop(0, 'rgba(225, 236, 245, 0)');
    grad.addColorStop(0.55, `rgba(225, 236, 245, ${(alpha * 0.35).toFixed(3)})`);
    grad.addColorStop(1, `rgba(225, 236, 245, ${alpha.toFixed(3)})`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  _drawCockpitILS(ctx, t, cx, cy, s, color) {
    const ils = t.ils;
    if (!ils || !ils.active) return;
    const locDev = clamp1(ils.locDev);
    const gsDev = clamp1(ils.gsDev);
    const nx = cx + locDev * 84 * s;
    const ny = cy - gsDev * 72 * s;
    const distNm = Number.isFinite(ils.distNm) ? ils.distNm.toFixed(1) : '--';

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    // Four subtle reference dots framing the deviation scales
    ctx.globalAlpha = 0.3;
    for (const dy of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy + dy * 78 * s, 1.6 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const dx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(cx + dx * 96 * s, cy, 1.6 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    // Localizer (vertical) + glideslope (horizontal) fly-to needles
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(nx, cy - 64 * s);
    ctx.lineTo(nx, cy + 64 * s);
    ctx.moveTo(nx, cy - 64 * s);
    ctx.lineTo(nx + 5 * s, cy - 64 * s);
    ctx.moveTo(nx, cy + 64 * s);
    ctx.lineTo(nx + 5 * s, cy + 64 * s);
    ctx.moveTo(cx - 40 * s, ny);
    ctx.lineTo(cx + 40 * s, ny);
    ctx.stroke();

    // Compact approach label below the pitch ladder
    ctx.globalAlpha = 0.9;
    ctx.font = `${Math.round(11 * s)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`ILS ${ils.runwayLabel || ''} · ${distNm} NM`, cx, cy + 178 * s);
    ctx.restore();
  }

  _drawExternalILS(ctx, t, s, mono) {
    const ils = t.ils;
    if (!ils || !ils.active) return;
    const locDev = clamp1(ils.locDev);
    const gsDev = clamp1(ils.gsDev);
    const distNm = Number.isFinite(ils.distNm) ? ils.distNm.toFixed(1) : '--';

    const pw = 178 * s;
    const ph = 46 * s;
    const px = 20 * s;
    const py = 14 * s;

    ctx.save();
    roundRect(ctx, px, py, pw, ph, 5 * s);
    ctx.fillStyle = 'rgba(5, 11, 8, 0.52)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `600 ${Math.round(8.5 * s)}px ${mono}`;
    ctx.fillText(`ILS ${ils.runwayLabel || ''} · ${distNm} NM`, px + 10 * s, py + 13 * s);

    // Localizer mini bar
    const locX = px + 40 * s;
    const locY = py + 31 * s;
    const locHalf = 24 * s;
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(locX - locHalf, locY);
    ctx.lineTo(locX + locHalf, locY);
    ctx.moveTo(locX, locY - 4 * s);
    ctx.lineTo(locX, locY + 4 * s);
    ctx.stroke();
    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.arc(locX + locDev * locHalf, locY, 2.6 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = GREEN_DIM;
    ctx.font = `${Math.round(7.5 * s)}px ${mono}`;
    ctx.textAlign = 'right';
    ctx.fillText('LOC', locX - locHalf - 4 * s, locY);

    // Glideslope mini bar
    const gsX = px + pw - 34 * s;
    const gsY = py + 31 * s;
    const gsHalf = 8 * s;
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.30)';
    ctx.beginPath();
    ctx.moveTo(gsX, gsY - gsHalf);
    ctx.lineTo(gsX, gsY + gsHalf);
    ctx.moveTo(gsX - 4 * s, gsY);
    ctx.lineTo(gsX + 4 * s, gsY);
    ctx.stroke();
    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.arc(gsX, gsY - gsDev * gsHalf, 2.6 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = GREEN_DIM;
    ctx.textAlign = 'left';
    ctx.fillText('GS', gsX + 8 * s, gsY);
    ctx.restore();
  }

  _drawMeatball(ctx, t, s, mono) {
    const mb = t.meatball;
    if (!mb || !mb.active) return;
    const w = this.w;
    const h = this.h;
    const x = Math.max(46 * s, Math.min(76 * s, w * 0.055));
    const cy = h * 0.5;
    const offset = clamp1(mb.ballOffset);
    const by = cy - offset * 20 * s;
    const ballCol = Math.abs(offset) > 0.6 ? RED : AMBER;
    const distNm = Number.isFinite(mb.distNm) ? mb.distNm.toFixed(1) : '--';

    ctx.save();
    ctx.fillStyle = 'rgba(5, 11, 8, 0.34)';
    roundRect(ctx, x - 26 * s, cy - 34 * s, 52 * s, 68 * s, 6 * s);
    ctx.fill();

    // Green datum line + faint vertical rails
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.72)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - 18 * s, cy);
    ctx.lineTo(x + 18 * s, cy);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(141, 255, 180, 0.20)';
    ctx.beginPath();
    ctx.moveTo(x - 18 * s, cy - 24 * s);
    ctx.lineTo(x - 18 * s, cy + 24 * s);
    ctx.moveTo(x + 18 * s, cy - 24 * s);
    ctx.lineTo(x + 18 * s, cy + 24 * s);
    ctx.stroke();

    // The meatball
    ctx.fillStyle = ballCol;
    ctx.beginPath();
    ctx.arc(x, by, 5 * s, 0, Math.PI * 2);
    ctx.fill();

    // Carrier caption
    ctx.fillStyle = 'rgba(186, 214, 199, 0.72)';
    ctx.font = `600 ${Math.round(8.5 * s)}px ${mono}`;
    ctx.textAlign = 'center';
    ctx.fillText(`CVN-71 ${distNm}NM`, x, cy + 42 * s);
    ctx.restore();
  }

  _drawReplayBanner(ctx, t, s, mono, y) {
    if (!t.replaying) return;
    const w = this.w;
    const rate = Number(t.replayRate) || 1;
    const time = Number(t.replayTime) || 0;
    const dur = Number(t.replayDuration) || 0;
    const text = `REPLAY · ${rate}× · ${time.toFixed(1)}/${dur.toFixed(1)}s`;
    const hint = '[F2 EXIT · F4 SPEED]';

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(11 * s)}px ${mono}`;
    const tw = ctx.measureText(text).width;
    ctx.font = `${Math.round(8.5 * s)}px ${mono}`;
    const hw = ctx.measureText(hint).width;
    const bw = Math.max(tw, hw) + 56 * s;
    const bh = 36 * s;
    const bx = w * 0.5 - bw * 0.5;

    roundRect(ctx, bx, y, bw, bh, 5 * s);
    ctx.fillStyle = 'rgba(26, 18, 4, 0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 196, 107, 0.62)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    const pulse = 0.55 + 0.45 * Math.sin(this._t * 6);
    ctx.fillStyle = `rgba(255, 196, 107, ${pulse.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(bx + 15 * s, y + bh * 0.5, 3.2 * s, 0, Math.PI * 2);
    ctx.fill();

    const tx = bx + bw * 0.5 + 4 * s;
    ctx.textAlign = 'center';
    ctx.fillStyle = AMBER;
    ctx.font = `700 ${Math.round(11 * s)}px ${mono}`;
    ctx.fillText(text, tx, y + bh * 0.5 - 6 * s);
    ctx.fillStyle = 'rgba(255, 216, 160, 0.72)';
    ctx.font = `${Math.round(8.5 * s)}px ${mono}`;
    ctx.fillText(hint, tx, y + bh * 0.5 + 8 * s);
    ctx.restore();
  }

  drawTape(ctx, x, cy, half, value, minor, major, s, isSpeed, color) {
    const scale = isSpeed ? 2.4 * s : 0.14 * s;
    const range = half / scale;
    const step = minor;
    const top = Math.ceil((value + range) / step) * step;
    const bottom = Math.floor((value - range) / step) * step;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.textAlign = isSpeed ? 'right' : 'left';
    ctx.font = `${Math.round(10 * s)}px ui-monospace, monospace`;
    for (let v = bottom; v <= top; v += step) {
      if (v < 0) continue;
      const y = cy - (v - value) * scale;
      if (Math.abs(y - cy) > half) continue;
      const isMajor = v % major === 0;
      const len = (isMajor ? 12 : 7) * s;
      const dir = isSpeed ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dir * len, y);
      ctx.stroke();
      if (isMajor) {
        ctx.globalAlpha = 0.8;
        ctx.fillText(String(v), x + dir * (len + 6 * s), y);
        ctx.globalAlpha = 0.55;
      }
    }
    // current value box
    ctx.globalAlpha = 0.9;
    ctx.font = `bold ${Math.round(13 * s)}px ui-monospace, monospace`;
    ctx.textAlign = isSpeed ? 'right' : 'left';
    const bw = 54 * s;
    const bx = isSpeed ? x - bw - 20 * s : x + 20 * s;
    ctx.fillStyle = 'rgba(3,8,5,0.55)';
    ctx.fillRect(bx, cy - 11 * s, bw, 22 * s);
    ctx.strokeStyle = color;
    ctx.strokeRect(bx, cy - 11 * s, bw, 22 * s);
    ctx.fillStyle = color;
    ctx.fillText(String(Math.round(value)), bx + bw - 5 * s, cy + 1);
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Feature 32: G-LOC / redout vignettes and the Mach 1.0 shock ring
  // -------------------------------------------------------------------------
  _drawJuiceFx(t) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const r = Math.hypot(w, h) * 0.5;

    const black = t.juice?.blackout ?? 0;
    if (black > 0.02) {
      const a = Math.min(0.94, black * 0.95);
      const grad = ctx.createRadialGradient(cx, cy, r * 0.16, cx, cy, r * 0.82);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(0.55, `rgba(0, 0, 0, ${(a * 0.55).toFixed(3)})`);
      grad.addColorStop(1, `rgba(0, 0, 0, ${a.toFixed(3)})`);
      ctx.save();
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    const red = t.juice?.redout ?? 0;
    if (red > 0.02) {
      const a = Math.min(0.8, red * 0.85);
      const grad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 0.85);
      grad.addColorStop(0, 'rgba(120, 0, 0, 0)');
      grad.addColorStop(0.6, `rgba(140, 8, 4, ${(a * 0.45).toFixed(3)})`);
      grad.addColorStop(1, `rgba(120, 0, 0, ${a.toFixed(3)})`);
      ctx.save();
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    const mach = t.juice?.machPulse ?? 0;
    if (mach > 0.05) {
      ctx.save();
      ctx.strokeStyle = `rgba(214, 240, 255, ${(0.30 * mach).toFixed(3)})`;
      ctx.lineWidth = Math.max(2, 18 * mach);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.94, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Feature 30: Soča Canyon Run racing telemetry strip
  // -------------------------------------------------------------------------
  _fmtRaceTime(seconds) {
    const sec = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
  }

  _drawCanyonStrip(t) {
    const c = t.canyon;
    if (!c || !c.active) return;
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const cockpit = t.mode === 'cockpit';
    const s = cockpit
      ? Math.max(0.58, Math.min(1.12, Math.min(w / 1600, h / 900) * 0.88))
      : Math.max(0.76, Math.min(1.12, Math.min(w / 1440, h / 820)));
    const mono = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';
    const total = c.totalGates || 8;
    const finished = !!c.finished;
    const gateNo = Math.min((c.gateIndex || 0) + 1, total);
    const gateName = c.nextGate?.name || 'FINISH';

    const line1 = finished
      ? `COURSE COMPLETE · ${c.medal || 'GOLD'} MEDAL · ${this._fmtRaceTime(c.elapsed)}`
      : `GATE ${gateNo} / ${total} · ${gateName}`;
    const timer = this._fmtRaceTime(c.elapsed);
    const dist = c.nextGate ? `${(c.distToNextM / 1000).toFixed(1)} KM` : '—';
    const brg = c.nextGate ? ` · ${String(Math.round(c.bearingToNextDeg)).padStart(3, '0')}°` : '';
    const line2 = finished ? 'F6 PHOTO MODE · S SNAPSHOT' : `${timer} · ${dist}${brg}`;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(12 * s)}px ${mono}`;
    const tw = ctx.measureText(line1).width;
    ctx.font = `${Math.round(9 * s)}px ${mono}`;
    const tw2 = ctx.measureText(line2).width;
    const bw = Math.max(228 * s, Math.max(tw, tw2) + 46 * s);
    const bh = finished ? 44 * s : 46 * s;
    const bx = w * 0.5 - bw * 0.5;
    const by = cockpit ? 8 * s : 58 * s;
    const accent = finished ? AMBER : '#38ffe0';

    roundRect(ctx, bx, by, bw, bh, 6 * s);
    ctx.fillStyle = finished ? 'rgba(26, 18, 4, 0.82)' : 'rgba(3, 14, 12, 0.72)';
    ctx.fill();
    ctx.strokeStyle = finished ? 'rgba(255, 196, 107, 0.72)' : 'rgba(56, 255, 224, 0.52)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = accent;
    ctx.font = `700 ${Math.round(12 * s)}px ${mono}`;
    ctx.fillText(line1, w * 0.5, by + bh * (finished ? 0.5 : 0.36));
    if (!finished) {
      ctx.fillStyle = 'rgba(196, 240, 228, 0.86)';
      ctx.font = `${Math.round(9 * s)}px ${mono}`;
      ctx.fillText(line2, w * 0.5, by + bh * 0.72);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Feature 32: weapon follow-cam optical-pod banner
  // -------------------------------------------------------------------------
  _drawWeaponCamBanner(t) {
    const wc = t.weaponCam;
    if (!wc || !wc.active || !(wc.tracking || wc.lingering)) return;
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const cockpit = t.mode === 'cockpit';
    const s = cockpit
      ? Math.max(0.58, Math.min(1.12, Math.min(w / 1600, h / 900) * 0.88))
      : Math.max(0.76, Math.min(1.12, Math.min(w / 1440, h / 820)));
    const mono = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

    const roundel = wc.lingering ? 'IMPACT · LINGER' : (wc.label || 'ORDNANCE').split(' ')[0];
    const telemetry = wc.lingering
      ? 'WPN CAM · IMPACT · LINGER'
      : `WPN CAM · ${roundel} · ${Math.round(wc.speedKts || 0)} KT · ${Math.round(wc.altFt || 0).toLocaleString()} FT`;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(10 * s)}px ${mono}`;
    const tw = ctx.measureText(telemetry).width;
    const bw = tw + 54 * s;
    const bh = 22 * s;
    const bx = w * 0.5 - bw * 0.5;
    const by = cockpit ? 60 * s : 112 * s;

    roundRect(ctx, bx, by, bw, bh, 4 * s);
    ctx.fillStyle = 'rgba(20, 4, 4, 0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 107, 94, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const pulse = 0.55 + 0.45 * Math.sin(this._t * 7);
    ctx.fillStyle = `rgba(255, 107, 94, ${pulse.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(bx + 14 * s, by + bh * 0.5, 3 * s, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 214, 206, 0.95)';
    ctx.font = `700 ${Math.round(10 * s)}px ${mono}`;
    ctx.fillText(telemetry, w * 0.5 + 6 * s, by + bh * 0.5 + 0.5);
    ctx.restore();
  }
}
