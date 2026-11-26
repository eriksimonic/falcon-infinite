// Feature 32 — weapon follow-cam and freeze-frame photo mode.
//
// WeaponCamSystem rides live ordnance (BFFG > MK82 > AIM9) from the rail all
// the way to the impact point, then holds a pulled-back "watch the fireball"
// angle for 2.2 s before handing back (or hopping to the next live round).
//
// PhotoModeController freezes the simulation anchor and orbits/zooms/FOVs a
// detached camera around the jet with a one-click PNG snapshot.
//
// Both are headless-safe: they only touch a supplied THREE camera (or plain
// {position, lookAt} object) and never the aircraft physics. captureSnapshot()
// returns null when there is no DOM.
import * as THREE from 'three';

// Lower number wins when several rounds are in the air at once.
const PRIORITY = { BFFG: 0, MK82: 1, AIM9: 2 };

const LABELS = {
  BFFG: 'BFFG-9000 MEGA-ORDNANCE',
  MK82: 'MK-82 500 LB',
  AIM9: 'AIM-9 SIDEWINDER',
};

const LINGER_TIME = 2.2; // seconds watching the impact
const LIVE_TRAIL_MIN = 14; // metres behind the warhead
const LIVE_TRAIL_MAX = 22;
const LIVE_TRAIL_ABOVE = 4;
const LIVE_SIDE_OFFSET = 2.2; // dramatic three-quarter angle
const LIVE_LOOK_AHEAD = 18;
const LINGER_BACK = 65; // metres behind the impact point
const LINGER_UP = 28; // metres above it

const PHOTO_FOV_MIN = 20;
const PHOTO_FOV_MAX = 90;
const PHOTO_DIST_MIN = 8;
const PHOTO_DIST_MAX = 180;
const PHOTO_PITCH_LIMIT = 1.35;
const PHOTO_ORBIT_SENS = 0.005; // radians per pixel of drag
const PHOTO_ZOOM_SENS = 0.15;

const UP = new THREE.Vector3(0, 1, 0);

const MS_TO_KTS = 1.94384;
const M_TO_FT = 3.28084;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function readPosition(obj, out) {
  if (!obj) return false;
  if (obj.position && typeof obj.position.x === 'number') {
    out.set(obj.position.x, obj.position.y, obj.position.z);
    return true;
  }
  if (typeof obj.x === 'number' && typeof obj.y === 'number' && typeof obj.z === 'number') {
    out.set(obj.x, obj.y, obj.z);
    return true;
  }
  return false;
}

export class WeaponCamSystem {
  constructor() {
    this.active = false;
    this.tracking = false;
    this.lingering = false;
    this.label = '';
    this.trackId = null;
    this.mode = 'idle'; // 'idle' | 'live' | 'linger'
    this.lingerTimer = 0;
    this.lastSpeed = 0;
    this.lastAlt = 0;

    this.impactPos = new THREE.Vector3();
    this.impactDir = new THREE.Vector3(0, 0, -1);

    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._placed = false;
  }

  toggle() {
    return this.setActive(!this.active);
  }

  setActive(on) {
    const next = !!on;
    if (next === this.active) return this.active;
    this.active = next;
    if (next) {
      this._placed = false;
    } else {
      this._clearTrack();
    }
    return this.active;
  }

  reset() {
    this.active = false;
    this._clearTrack();
    this._placed = false;
    return this;
  }

  _clearTrack() {
    this.trackId = null;
    this.mode = 'idle';
    this.tracking = false;
    this.lingering = false;
    this.lingerTimer = 0;
    this.label = '';
    this.lastSpeed = 0;
    this.lastAlt = 0;
  }

  // ------------------------------------------------------------- ordnance
  /** All live guided/bomb rounds the cam may track, in no particular order. */
  _collect(weapons) {
    const out = [];
    if (!weapons) return out;

    let list = null;
    if (typeof weapons.getActiveOrdnance === 'function') {
      try {
        const got = weapons.getActiveOrdnance();
        if (Array.isArray(got) && got.length) list = got;
      } catch {
        list = null;
      }
    }
    if (!list) {
      list = [];
      if (Array.isArray(weapons.missiles)) list = list.concat(weapons.missiles);
      if (Array.isArray(weapons.bombs)) list = list.concat(weapons.bombs);
      // WeaponSystem keeps every projectile in one pool.
      if (Array.isArray(weapons.projectiles)) list = list.concat(weapons.projectiles);
    }

    for (const p of list) {
      if (!p || p.dead || p.alive === false) continue;
      const pos = p.position;
      if (!pos || typeof pos.x !== 'number') continue;
      const type = p.type || p.kind || p.weapon;
      if (!(type in PRIORITY)) continue;
      out.push(p);
    }
    return out;
  }

  /** The live round we are already tracking, or null when it has vanished. */
  _findTracked(list) {
    if (this.trackId == null) return null;
    for (const p of list) if (p.id === this.trackId) return p;
    return null;
  }

  /** Highest-priority live round; ties go to the oldest (lowest id). */
  _pick(list) {
    let best = null;
    let bestScore = Infinity;
    let bestId = Infinity;
    for (const p of list) {
      const score = PRIORITY[p.type || p.kind || p.weapon];
      const id = typeof p.id === 'number' ? p.id : Infinity;
      if (score < bestScore || (score === bestScore && id < bestId)) {
        best = p;
        bestScore = score;
        bestId = id;
      }
    }
    return best;
  }

  _beginTrack(p) {
    this.mode = 'live';
    this.trackId = p.id != null ? p.id : null;
    this.tracking = true;
    this.lingering = false;
    this.lingerTimer = 0;
    this.label = LABELS[p.type || p.kind || p.weapon] || '';
    readPosition(p, this.impactPos);
    if (p.velocity && typeof p.velocity.x === 'number') {
      this.impactDir.set(p.velocity.x, p.velocity.y, p.velocity.z);
      if (this.impactDir.lengthSq() < 1e-6) this.impactDir.set(0, 0, -1);
      else this.impactDir.normalize();
    }
  }

  _enterLinger() {
    this.mode = 'linger';
    this.tracking = false;
    this.lingering = true;
    this.lingerTimer = LINGER_TIME;
    this.lastSpeed = 0;
    this.trackId = null;
  }

  // --------------------------------------------------------------- update
  /**
   * @param {number} dt seconds
   * @param {object} camera THREE camera (needs position + lookAt)
   * @param {object} weapons WeaponSystem-like: getActiveOrdnance?.() |
   *                         missiles/bombs | projectiles
   * @param {object} aircraftPos player position (fallback status altitude)
   */
  update(dt, camera, weapons, aircraftPos) {
    const h = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const status = {
      active: this.active,
      tracking: false,
      lingering: false,
      label: this.label,
      speedKts: 0,
      altFt: 0,
    };

    if (!this.active) return status;
    if (!camera || typeof camera.lookAt !== 'function' || !camera.position) return status;

    const candidates = this._collect(weapons);
    let framed = false;

    // Follow the current round until it disappears.
    if (this.mode === 'live') {
      const live = this._findTracked(candidates);
      if (!live) {
        this._enterLinger();
      } else {
        this._updateLive(h, camera, live);
        framed = true;
      }
    }

    // Watch the fireball, then move on.
    if (this.mode === 'linger') {
      this.lingerTimer -= h;
      if (this.lingerTimer <= 0) {
        this.lingering = false;
        this.lingerTimer = 0;
        this.mode = 'idle';
        const next = this._pick(candidates);
        if (next) this._beginTrack(next);
        else this.active = false; // nothing left to watch: hand control back
      } else {
        this._updateLinger(h, camera);
        framed = true;
      }
    }

    // Idle while armed: snap onto the next thing fired.
    if (this.mode === 'idle' && this.active) {
      const next = this._pick(candidates);
      if (next) this._beginTrack(next);
    }

    // A track acquired this frame still gets its camera placed immediately.
    if (this.mode === 'live' && !framed) {
      const live = this._findTracked(candidates);
      if (live) this._updateLive(h, camera, live);
    }

    status.active = this.active;
    status.tracking = this.mode === 'live' && this.tracking;
    status.lingering = this.mode === 'linger' && this.lingering;
    status.label = this.label;

    if (status.tracking) {
      status.speedKts = Math.round(this.lastSpeed * MS_TO_KTS);
      status.altFt = Math.round(this.impactPos.y * M_TO_FT);
    } else if (status.lingering) {
      status.altFt = Math.round(this.impactPos.y * M_TO_FT);
    } else if (readPosition(aircraftPos, this._tmp)) {
      status.altFt = Math.round(this._tmp.y * M_TO_FT);
    }
    return status;
  }

  _updateLive(h, camera, proj) {
    readPosition(proj, this._tmp);
    this.impactPos.copy(this._tmp);

    const vel = proj.velocity;
    if (vel && typeof vel.x === 'number' && vel.lengthSq() > 1e-6) {
      this._dir.copy(vel);
      this.impactDir.copy(vel).normalize();
      this.lastSpeed = this._dir.length();
      this._dir.normalize();
    } else {
      this._dir.copy(this.impactDir);
      this.lastSpeed = 0;
    }

    // Trail distance grows with closing speed: 14 m at bomb speed, 22 m at
    // Mach-plus missile speed.
    const trail = LIVE_TRAIL_MIN + clamp((this.lastSpeed - 60) / 800, 0, 1) * (LIVE_TRAIL_MAX - LIVE_TRAIL_MIN);

    this._right.crossVectors(this._dir, UP);
    if (this._right.lengthSq() < 1e-6) this._right.set(1, 0, 0);
    else this._right.normalize();

    this._desired
      .copy(this.impactPos)
      .addScaledVector(this._dir, -trail)
      .addScaledVector(this._right, LIVE_SIDE_OFFSET);
    this._desired.y += LIVE_TRAIL_ABOVE;

    const k = this._placed ? 1 - Math.exp(-9 * h) : 1;
    camera.position.lerp(this._desired, k);
    this._placed = true;

    // Look ahead along the flight path so the target grows in frame.
    this._look.copy(this.impactPos).addScaledVector(this._dir, LIVE_LOOK_AHEAD);
    camera.lookAt(this._look);
  }

  _updateLinger(h, camera) {
    this._desired.copy(this.impactPos).addScaledVector(this.impactDir, -LINGER_BACK);
    this._desired.y += LINGER_UP;

    const k = this._placed ? 1 - Math.exp(-6 * h) : 1;
    camera.position.lerp(this._desired, k);
    this._placed = true;

    this._look.copy(this.impactPos);
    this._look.y += 6; // centre the fireball, not the crater floor
    camera.lookAt(this._look);
    this.lastSpeed = 0;
  }
}

export class PhotoModeController {
  constructor() {
    this.active = false;
    this.frozen = false;
    this.fov = 50;
    this.yaw = 0; // radians, orbit azimuth
    this.pitch = 0.22; // radians, elevation above the jet
    this.dist = 28; // metres
    this.target = new THREE.Vector3();
    this.snapshotCount = 0;

    this._desired = new THREE.Vector3();
    this._placed = false;
  }

  /** Freeze the sim and anchor the orbit on the player aircraft. */
  enter(aircraftPos, currentYaw = this.yaw, currentPitch = this.pitch) {
    if (readPosition(aircraftPos, this._desired)) this.target.copy(this._desired);
    if (Number.isFinite(currentYaw)) this.yaw = currentYaw;
    if (Number.isFinite(currentPitch)) this.pitch = clamp(currentPitch, -PHOTO_PITCH_LIMIT, PHOTO_PITCH_LIMIT);
    this.active = true;
    this.frozen = true;
    this._placed = false;
    return this;
  }

  exit() {
    this.active = false;
    this.frozen = false;
    this._placed = false;
    return this;
  }

  /** Drag-orbit: dx/dy in pixels from the mouse. */
  orbit(dx, dy) {
    if (!this.active) return this;
    const x = Number.isFinite(dx) ? dx : 0;
    const y = Number.isFinite(dy) ? dy : 0;
    this.yaw -= x * PHOTO_ORBIT_SENS;
    this.pitch = clamp(this.pitch + y * PHOTO_ORBIT_SENS, -PHOTO_PITCH_LIMIT, PHOTO_PITCH_LIMIT);
    return this;
  }

  /** Positive delta pulls the camera in (wheel up / '+' key). */
  zoom(delta) {
    if (!this.active) return this;
    const d = Number.isFinite(delta) ? delta : 0;
    this.dist = clamp(this.dist * Math.exp(-d * PHOTO_ZOOM_SENS), PHOTO_DIST_MIN, PHOTO_DIST_MAX);
    return this;
  }

  /** Positive delta widens the lens (FOV up). Clamped to 20..90. */
  adjustFov(delta) {
    if (!this.active) return this;
    const d = Number.isFinite(delta) ? delta : 0;
    this.fov = clamp(this.fov + d, PHOTO_FOV_MIN, PHOTO_FOV_MAX);
    return this;
  }

  /** Place the camera on the orbit shell; no aircraft physics touched. */
  updateCamera(camera, dt = 1 / 60) {
    if (!this.active) return false;
    if (!camera || !camera.position || typeof camera.lookAt !== 'function') return false;

    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    this._desired.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + sp * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );

    const h = Number.isFinite(dt) && dt > 0 ? clamp(dt, 0, 0.5) : 1 / 60;
    const k = this._placed ? 1 - Math.exp(-14 * h) : 1;
    camera.position.lerp(this._desired, k);
    this._placed = true;
    camera.lookAt(this.target);

    if (typeof camera.fov === 'number') {
      camera.fov = this.fov;
      if (typeof camera.updateProjectionMatrix === 'function') camera.updateProjectionMatrix();
    }
    return true;
  }

  /**
   * Composite the live frame onto an offscreen canvas with a corner stamp and
   * download it as a PNG. Returns the data URL, or null without a DOM.
   */
  captureSnapshot(canvas, filename = 'falcon-infinite.png') {
    if (typeof document === 'undefined' || !canvas) return null;
    try {
      const w = canvas.width || 1280;
      const h = canvas.height || 720;
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      if (!ctx) return null;

      ctx.drawImage(canvas, 0, 0, w, h);

      // Subtle bottom-left stamp: accent rule + wordmark.
      const pad = Math.round(Math.min(w, h) * 0.035);
      const fs = Math.max(12, Math.round(Math.min(w, h) * 0.022));
      const ruleH = Math.max(1, Math.round(fs * 0.12));

      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = fs * 0.6;
      ctx.fillStyle = 'rgba(255, 210, 120, 0.9)';
      ctx.fillRect(pad, h - pad - fs * 1.9, fs * 2.6, ruleH);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
      ctx.font = `600 ${fs}px "Helvetica Neue", Arial, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillText('FALCON / INFINITE \u00b7 VIPAVA VALLEY', pad, h - pad);
      ctx.restore();

      const url = out.toDataURL('image/png');
      const name = /\.png$/i.test(filename) ? filename : `${filename}.png`;
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      if (document.body && typeof document.body.appendChild === 'function') {
        document.body.appendChild(link);
        link.click();
        if (typeof link.remove === 'function') link.remove();
      } else if (typeof link.click === 'function') {
        link.click();
      }
      this.snapshotCount++;
      return url;
    } catch {
      return null;
    }
  }
}

export { PRIORITY as ORDNANCE_PRIORITY, LABELS as ORDNANCE_LABELS, LINGER_TIME };