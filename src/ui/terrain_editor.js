// In-game Terrain & Colour Paint Editor (F9) — tactical floating sidebar plus a
// 3D terrain-hugging brush ring that drapes itself over every DEM sample it
// touches, so the cursor stays readable on mountain ridges and over open sea.
//
// Design notes
// ------------
// * 100% headless-safe: without `document` the class only holds state; no DOM,
//   no scene mutation, no listeners. Node tests import it directly.
// * Terrain picking is analytical (ray-march against `max(heightAt(x,z), 0)`)
//   rather than triangle picking. That makes it immune to the shader `discard`
//   below `-0.24 m` and lets the player paint dry land UP out of the Adriatic:
//   the pick never lands on water/sky/cloud meshes and never depends on which
//   tile happens to be streamed in at this instant.
// * All height/colour edits flow through `TerrainEdits` and out through
//   `onHeightChanged(bounds)` so `App` can drop only the touched terrain tiles
//   and rebuild them immediately (the ring/telemetry stay in sync because the
//   pick reads the same `heightAt` the mesh samples).

import * as THREE from 'three';

const RING_OUTER_SEGMENTS = 64;
const RING_INNER_SEGMENTS = 32;
const RING_INNER_SCALE = 0.35;
const RING_LIFT = 1.5; // metres above the ground so z-fighting never bites
const RING_RENDER_ORDER = 999;

const COLOR_CYAN = 0x4de2ff; // raise / flatten / smooth
const COLOR_CORAL = 0xff6b6b; // lower / erase
const COLOR_EMERALD = 0x4effa1; // colour & vegetation brushes

const RADIUS_MIN = 40;
const RADIUS_MAX = 3000;
const RADIUS_DEFAULT = 320;
const STRENGTH_DEFAULT = 0.55;

// Ray-march bounds for the terrain pick (metres along the view ray).
const PICK_T_START = 10;
const PICK_T_MAX = 45000;

// Passed to `onHeightChanged` when an operation touches an unknown region
// (import / reset), which forces a full terrain refresh.
const FULL_BOUNDS = { xMin: -200000, xMax: 200000, zMin: -200000, zMax: 200000 };

const HEIGHT_BRUSHES = [
  { mode: 'raise', label: 'RAISE', title: 'Raise terrain inside the ring' },
  { mode: 'lower', label: 'LOWER', title: 'Lower terrain inside the ring' },
  { mode: 'flatten', label: 'FLATTEN', title: 'Flatten to the elevation sampled when the stroke began' },
  { mode: 'smooth', label: 'SMOOTH', title: 'Average neighbouring cells — softens spikes' },
  { mode: 'erase_height', label: 'ERASE H', title: 'Remove height edits — back to the streamed DEM' },
];

const COLOR_BRUSHES = [
  { mode: 'desaturate', label: 'TAME NEON', title: 'Pull the over-bright neon green down to natural saturation' },
  { mode: 'darken', label: 'DARKEN', title: 'Darken the albedo tint' },
  { mode: 'lighten', label: 'LIGHTEN', title: 'Lighten the albedo tint' },
  { mode: 'deep_forest', label: 'DEEP FOREST', title: 'Dense Kras conifer tone' },
  { mode: 'warm_olive', label: 'WARM OLIVE', title: 'Mediterranean olive grass' },
  { mode: 'karst_stone', label: 'KARST STONE', title: 'Pale limestone / beach' },
  { mode: 'erase_color', label: 'ERASE C', title: 'Remove colour edits' },
];

const COLOR_MODE_SET = new Set(COLOR_BRUSHES.map((b) => b.mode));

const LOCATIONS = [
  { name: 'Grado', x: -39000, z: 23500, agl: 320, yaw: 0.2, pitch: -0.45 },
  { name: 'Causeway', x: -39000, z: 18500, agl: 280, yaw: 3.1, pitch: -0.48 },
  { name: 'Monfalcone', x: -27500, z: 8900, agl: 340, yaw: -0.5, pitch: -0.42 },
  { name: 'Kras Border', x: -16500, z: 4500, agl: 480, yaw: 0.4, pitch: -0.42 },
  { name: 'Nova Gorica', x: -19400, z: -7000, agl: 360, yaw: 0.3, pitch: -0.38 },
  { name: 'Trieste', x: -8300, z: 26400, agl: 360, yaw: 0.6, pitch: -0.4 },
];

const STYLE_ID = 'terrain-editor-styles';
const PANEL_ID = 'terrain-editor-panel';

const STYLES = `
#terrain-editor-root {
  position: fixed; inset: 0; z-index: 65;
  pointer-events: none;
  font-family: var(--mono, ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace);
  color: #cfe6f2;
  letter-spacing: 0.06em;
  -webkit-font-smoothing: antialiased;
}
#terrain-editor-panel {
  position: absolute; top: 64px; left: 14px;
  width: 275px; max-height: calc(100vh - 92px);
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 11px 9px;
  background: rgba(8, 14, 20, 0.88);
  border: 1px solid rgba(110, 210, 255, 0.25);
  border-radius: 6px;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(110, 210, 255, 0.05);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  font-size: 10px;
  pointer-events: auto;
  overflow-y: auto; overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgba(110, 210, 255, 0.35) transparent;
}
#terrain-editor-panel.te-hidden { display: none; }
#terrain-editor-panel::-webkit-scrollbar { width: 5px; }
#terrain-editor-panel::-webkit-scrollbar-thumb { background: rgba(110, 210, 255, 0.3); border-radius: 3px; }

.te-head { display: flex; align-items: center; gap: 6px; padding-bottom: 2px; }
.te-title {
  flex: 1 1 auto; font-size: 10px; font-weight: 600; letter-spacing: 0.13em;
  color: #4de2ff; text-shadow: 0 0 12px rgba(77, 226, 255, 0.35);
  white-space: nowrap;
}
.te-key {
  font-size: 8px; padding: 2px 4px; border-radius: 2px;
  color: #ffc46b; background: rgba(255, 196, 107, 0.14);
  border: 1px solid rgba(255, 196, 107, 0.3); letter-spacing: 0.08em;
}
.te-close {
  appearance: none; -webkit-appearance: none;
  width: 16px; height: 16px; padding: 0; line-height: 13px;
  font-family: inherit; font-size: 12px; text-align: center;
  color: #9fb6c4; background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(110, 210, 255, 0.2); border-radius: 2px;
  cursor: pointer;
}
.te-close:hover { color: #ff8f8f; border-color: rgba(255, 107, 107, 0.55); background: rgba(255, 107, 107, 0.12); }

.te-sect {
  display: flex; flex-direction: column; gap: 5px;
  border-top: 1px solid rgba(110, 210, 255, 0.13); padding-top: 7px;
}
.te-sect.te-sect-flush { border-top: 0; padding-top: 0; }
.te-label {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 8.5px; letter-spacing: 0.16em; color: #7d93a3;
}
.te-label span.te-hint { color: #4e6577; letter-spacing: 0.06em; }

.te-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.te-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }

.te-pill, .te-btn {
  appearance: none; -webkit-appearance: none;
  font-family: inherit; font-size: 8.5px; letter-spacing: 0.06em;
  color: #b8cfdc; background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(110, 210, 255, 0.18); border-radius: 3px;
  padding: 5px 3px; text-align: center; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.te-pill:hover, .te-btn:hover {
  background: rgba(110, 210, 255, 0.13); border-color: rgba(110, 210, 255, 0.45); color: #eaf7ff;
}
.te-pill.on {
  color: #eafcff; background: rgba(77, 226, 255, 0.18);
  border-color: #4de2ff;
  box-shadow: inset 0 0 0 1px rgba(77, 226, 255, 0.22), 0 0 12px rgba(77, 226, 255, 0.18);
}
.te-pill.on[data-group="color"] {
  color: #eafff4; background: rgba(78, 255, 161, 0.16);
  border-color: #4effa1;
  box-shadow: inset 0 0 0 1px rgba(78, 255, 161, 0.22), 0 0 12px rgba(78, 255, 161, 0.16);
}
.te-pill.te-erase.on { border-color: #ff6b6b; background: rgba(255, 107, 107, 0.16); color: #ffecec; }

.te-btn { width: 100%; padding: 6px 6px; font-size: 9px; letter-spacing: 0.09em; }
.te-btn.te-save { color: #d7ffe8; border-color: rgba(78, 255, 161, 0.4); background: rgba(78, 255, 161, 0.1); }
.te-btn.te-save:hover { background: rgba(78, 255, 161, 0.2); border-color: #4effa1; color: #ffffff; }
.te-btn.te-danger { color: #ffc9c4; border-color: rgba(255, 107, 107, 0.35); }
.te-btn.te-danger:hover { background: rgba(255, 107, 107, 0.16); border-color: #ff6b6b; }
.te-btn.te-danger.te-armed { background: rgba(255, 107, 107, 0.26); border-color: #ff6b6b; color: #ffffff; }
.te-btn:disabled { opacity: 0.55; cursor: default; }

.te-row { display: flex; align-items: center; gap: 7px; }
.te-row-label { width: 54px; flex: 0 0 auto; font-size: 8.5px; letter-spacing: 0.13em; color: #7d93a3; }
.te-range {
  flex: 1 1 auto; min-width: 0; height: 3px; margin: 0;
  -webkit-appearance: none; appearance: none; outline: none;
  border-radius: 2px; cursor: ew-resize;
  background: linear-gradient(90deg, rgba(77, 226, 255, 0.65), rgba(77, 226, 255, 0.1));
}
.te-range::-webkit-slider-thumb {
  -webkit-appearance: none; width: 9px; height: 13px; border-radius: 2px;
  background: #4de2ff; border: 1px solid #05131b;
  box-shadow: 0 0 8px rgba(77, 226, 255, 0.5);
}
.te-range::-moz-range-thumb {
  width: 9px; height: 13px; border-radius: 2px;
  background: #4de2ff; border: 1px solid #05131b;
}
.te-val {
  width: 54px; flex: 0 0 auto; text-align: right;
  font-size: 9.5px; color: #4de2ff; font-variant-numeric: tabular-nums;
}

.te-tel {
  display: flex; flex-direction: column; gap: 1px;
  padding: 6px 7px; border-radius: 4px;
  background: rgba(0, 0, 0, 0.36);
  border: 1px solid rgba(110, 210, 255, 0.16);
  font-size: 9px; line-height: 1.55; color: #92b4c6;
  font-variant-numeric: tabular-nums; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.te-tel b { color: #dcf3ff; font-weight: 500; }
.te-tel .te-tel-dim { color: #6f8797; }

.te-foot {
  font-size: 8px; line-height: 1.55; letter-spacing: 0.07em; color: #6d8494;
  border-top: 1px solid rgba(110, 210, 255, 0.13); padding-top: 6px;
}
`;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Normalise whatever a `TerrainEdits` mutation returns into a single bounds
 * shape: `{ xMin, xMax, zMin, zMax }`. Accepts the canonical object, the
 * `{ minX, maxX, minZ, maxZ }` spelling, a `[xMin, xMax, zMin, zMax]` array,
 * or a wrapper such as `{ bounds: {...} }`. Returns null when there is nothing
 * usable (a caller may then fall back to the last known region).
 */
export function normalizeBounds(res) {
  if (!res || typeof res !== 'object') return null;
  if (Array.isArray(res)) {
    if (res.length >= 4 && res.slice(0, 4).every(isFiniteNum)) {
      return { xMin: res[0], xMax: res[1], zMin: res[2], zMax: res[3] };
    }
    return null;
  }
  if (res.bounds) {
    const inner = normalizeBounds(res.bounds);
    if (inner) return inner;
  }
  const xMin = res.xMin ?? res.minX;
  const xMax = res.xMax ?? res.maxX;
  const zMin = res.zMin ?? res.minZ;
  const zMax = res.zMax ?? res.maxZ;
  if (![xMin, xMax, zMin, zMax].every(isFiniteNum)) return null;
  return {
    xMin: Math.min(xMin, xMax),
    xMax: Math.max(xMin, xMax),
    zMin: Math.min(zMin, zMax),
    zMax: Math.max(zMin, zMax),
  };
}

export class TerrainEditorUI {
  constructor(callbacks = {}) {
    const cb = callbacks || {};

    this.scene = cb.scene || null;
    this.edits = cb.edits || null;

    this.onHeightChanged = typeof cb.onHeightChanged === 'function' ? cb.onHeightChanged : null;
    this.onSaveProject = typeof cb.onSaveProject === 'function' ? cb.onSaveProject : null;
    this.onTeleport = typeof cb.onTeleport === 'function' ? cb.onTeleport : null;
    this.onExit = typeof cb.onExit === 'function' ? cb.onExit : null;
    this.onToast = typeof cb.onToast === 'function' ? cb.onToast : null;
    // Optional: fired when a *height* change is committed (stroke end, undo,
    // import, reset) so world systems can re-ground houses, roads and props.
    this._onStrokeEnd = typeof cb.onStrokeEnd === 'function' ? cb.onStrokeEnd : null;

    this.active = false;
    this.mode = 'raise';
    this.radius = RADIUS_DEFAULT;
    this.strength = STRENGTH_DEFAULT;

    // --- pointer / stroke state -------------------------------------------
    this._heightFn = (x, z) => 0;
    // Base (un-edited) elevation provider. `TerrainEdits.applyHeightBrush` needs
    // this for FLATTEN so it can turn an absolute `targetY` into a grid delta.
    this._baseHeightAt = (x, z) => {
      const h = this._heightFn(x, z);
      const height = isFiniteNum(h) ? h : 0;
      if (this.edits && typeof this.edits.sampleHeightDelta === 'function') {
        const d = this.edits.sampleHeightDelta(x, z);
        return height - (isFiniteNum(d) ? d : 0);
      }
      return height;
    };
    this._hoverWorld = null; // { x, y, z, ground, t }
    this._lastPointer = { x: 0, y: 0 };
    this._prevLook = { x: 0, y: 0 };
    this._paintHeld = false;
    this._lookDrag = false;
    this._flattenHeight = 0;
    this._strokeStartElev = null;
    this._lastBounds = null;
    this._elapsed = 0;

    // --- DOM refs (all null in headless) ----------------------------------
    this._root = null;
    this._panel = null;
    this._telemetryEl = null;
    this._telXEl = null;
    this._telZEl = null;
    this._telElevEl = null;
    this._telDeltaEl = null;
    this._undoLabelEl = null;
    this._radiusInput = null;
    this._radiusValEl = null;
    this._strengthInput = null;
    this._strengthValEl = null;
    this._resetBtn = null;
    this._saveBtn = null;
    this._fileInput = null;
    this._modeButtons = new Map();
    this._resetTimer = 0;

    // --- 3D brush ring ----------------------------------------------------
    this._ringGroup = null;
    this._ringOuter = null;
    this._ringInner = null;
    this._ringColor = 0;
    this._tmpA = null;
    this._tmpB = null;

    if (this.scene) this._buildRing();
  }

  // =====================================================================
  // 3D brush ring
  // =====================================================================
  _buildRing() {
    if (this._ringGroup) return;
    if (!this.scene || typeof this.scene.add !== 'function') return;

    const group = new THREE.Group();
    group.name = 'terrain-editor-brush-ring';
    group.visible = false;

    const make = (segments) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments * 3), 3));
      const mat = new THREE.LineBasicMaterial({
        color: COLOR_CYAN,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
        depthWrite: false,
      });
      const line = new THREE.LineLoop(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = RING_RENDER_ORDER;
      group.add(line);
      return line;
    };

    this._ringOuter = make(RING_OUTER_SEGMENTS);
    this._ringInner = make(RING_INNER_SEGMENTS);
    this._ringInner.material.opacity = 0.55;
    this._ringColor = COLOR_CYAN;
    this._ringGroup = group;

    this.scene.add(group);
  }

  /** Attach a scene after construction (e.g. when the world finishes loading). */
  attachScene(scene) {
    this.scene = scene || null;
    this._buildRing();
    if (this._ringGroup) this._ringGroup.visible = !!this.active && !!this._hoverWorld;
    return this;
  }

  _drapeRing(line, radius, cx, cz, hf) {
    const attr = line.geometry.getAttribute('position');
    const arr = attr.array;
    const n = arr.length / 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const vx = cx + Math.cos(a) * radius;
      const vz = cz + Math.sin(a) * radius;
      const h = hf(vx, vz);
      const ground = isFiniteNum(h) ? h : 0;
      arr[i * 3] = vx;
      arr[i * 3 + 1] = Math.max(ground, 0) + RING_LIFT;
      arr[i * 3 + 2] = vz;
    }
    attr.needsUpdate = true;
  }

  /**
   * Re-drape the brush ring under a world position. Every vertex samples its
   * own elevation, so the ring snakes over ridges and floats 1.5 m above sea
   * level when painting flooded land back up.
   */
  updateCursorRing(x, z, heightAt) {
    if (!this._ringGroup) return;
    if (!isFiniteNum(x) || !isFiniteNum(z)) return;
    const hf = this._resolveHeightAt(heightAt);
    this._drapeRing(this._ringOuter, this.radius, x, z, hf);
    this._drapeRing(this._ringInner, this.radius * RING_INNER_SCALE, x, z, hf);
    this._setRingColor(this._ringColorForMode(this.mode));
    this._ringGroup.visible = !!this.active;
    this._ringInner.material.opacity = this._paintHeld ? 0.9 : 0.55;
  }

  _setRingColor(hex) {
    if (hex === this._ringColor) return;
    this._ringColor = hex;
    if (this._ringOuter) this._ringOuter.material.color.setHex(hex);
    if (this._ringInner) this._ringInner.material.color.setHex(hex);
  }

  _ringColorForMode(mode) {
    if (mode === 'lower' || mode === 'erase_height' || mode === 'erase_color') return COLOR_CORAL;
    if (COLOR_MODE_SET.has(mode)) return COLOR_EMERALD;
    return COLOR_CYAN;
  }

  // =====================================================================
  // Terrain picking
  // =====================================================================
  _resolveHeightAt(heightAt) {
    if (typeof heightAt === 'function') {
      this._heightFn = heightAt;
      return heightAt;
    }
    return this._heightFn;
  }

  _viewRect(canvas) {
    if (canvas && typeof canvas.getBoundingClientRect === 'function') {
      const r = canvas.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      }
    }
    if (typeof window !== 'undefined' && window.innerWidth > 0) {
      return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }
    return { left: 0, top: 0, width: 1920, height: 1080 };
  }

  /**
   * Build a world ray from a mouse position and ray-march it against
   * `max(heightAt(x, z), 0)`.
   *
   * Marching the analytic ground instead of the tile triangles means:
   *   1. the pick still works where the terrain shader `discard`s foliage and
   *      sub -0.24 m seabed fragments, and over open water (y = 0), so the
   *      player can raise dry land out of the sea;
   *   2. it is deterministic and cheap (<0.15 ms), and never snaps to sky,
   *      clouds or the water plane.
   *
   * Adaptive step grows with distance; each crossing gets 8 binary refinement
   * iterations (≈0.2 % of the step) before the hit point is returned.
   *
   * @returns {{x:number, y:number, z:number, ground:number, t:number}|null}
   */
  pickWorldPoint(clientX, clientY, camera, canvas, heightAt) {
    if (!camera) return null;
    if (!isFiniteNum(clientX) || !isFiniteNum(clientY)) return null;

    const hf = this._resolveHeightAt(heightAt);
    const rect = this._viewRect(canvas);
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);

    if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld();

    const near = this._tmpA || (this._tmpA = new THREE.Vector3());
    const origin = this._tmpB || (this._tmpB = new THREE.Vector3());
    near.set(ndcX, ndcY, 0.5).unproject(camera);
    origin.setFromMatrixPosition(camera.matrixWorld);

    let dx = near.x - origin.x;
    let dy = near.y - origin.y;
    let dz = near.z - origin.z;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-6)) return null;
    dx /= len;
    dy /= len;
    dz /= len;

    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;

    const groundAt = (x, z) => {
      const h = hf(x, z);
      const g = isFiniteNum(h) ? h : 0;
      return g > 0 ? g : 0;
    };

    const hitAt = (t) => {
      const x = ox + dx * t;
      const z = oz + dz * t;
      const ground = groundAt(x, z);
      return { x, y: oy + dy * t, z, ground, t };
    };

    // Camera below the surface (or skimming it): clamp the hit right in front.
    if (oy - groundAt(ox, oz) <= 0) {
      let lo = 0;
      let hi = PICK_T_START;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) * 0.5;
        const x = ox + dx * mid;
        const z = oz + dz * mid;
        if (oy + dy * mid - groundAt(x, z) <= 0) hi = mid;
        else lo = mid;
      }
      return hitAt(hi);
    }

    let t = PICK_T_START;
    let prevT = 0;
    while (t <= PICK_T_MAX) {
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      const diff = y - groundAt(x, z);

      if (diff <= 0) {
        // Bracketed crossing — binary refine for a sub-step hit point.
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) * 0.5;
          const mx = ox + dx * mid;
          const my = oy + dy * mid;
          const mz = oz + dz * mid;
          if (my - groundAt(mx, mz) <= 0) hi = mid;
          else lo = mid;
        }
        return hitAt(hi);
      }

      prevT = t;
      t += Math.max(6, t * 0.015);
    }
    return null;
  }

  // =====================================================================
  // Brush application
  // =====================================================================
  _isColorMode(mode) {
    return COLOR_MODE_SET.has(mode == null ? this.mode : mode);
  }

  _applyBrush(world, dt) {
    if (!world || !this.edits) return null;
    const color = this._isColorMode();
    const opts = {
      mode: this.mode,
      x: world.x,
      z: world.z,
      radius: this.radius,
      strength: clamp(this.strength, 0, 1),
      dt: clamp(isFiniteNum(dt) ? dt : 0.016, 0.001, 0.1),
      // FLATTEN pins the absolute elevation sampled when the stroke began;
      // `baseHeightAt` lets the store convert that into a grid delta per cell.
      targetY: isFiniteNum(this._flattenHeight) ? this._flattenHeight : null,
      baseHeightAt: color ? null : this._baseHeightAt,
    };

    let res;
    try {
      const fn = color ? this.edits.applyColorBrush : this.edits.applyHeightBrush;
      res = typeof fn === 'function' ? fn.call(this.edits, opts) : null;
    } catch (err) {
      console.warn('[terrain-editor] brush failed:', err);
      return null;
    }

    // `{ changed: false }` means every touched cell was already at its target
    // value (brush stalled past the 5 cm quantum) — rebuilding tiles then would
    // burn frames for nothing.
    if (res && res.changed === false) return null;

    const bounds = normalizeBounds(res);
    if (bounds) this._lastBounds = bounds;
    // Colour edits also live in the terrain vertex attributes, so they need the
    // same tile rebuild as height edits.
    this._emitHeightChanged(bounds);
    return bounds;
  }

  _emitHeightChanged(bounds) {
    if (!this.onHeightChanged) return;
    const b = bounds || this._lastBounds;
    if (!b) return;
    try {
      this.onHeightChanged(b);
    } catch (err) {
      console.warn('[terrain-editor] onHeightChanged failed:', err);
    }
  }

  /**
   * Tell the host that a height edit has been committed, so actors that are
   * welded to the old surface (houses, roads, trees, landmarks, water) can be
   * re-grounded. Colour-only strokes never fire this.
   */
  _notifyStrokeEnd(kind, bounds) {
    if (kind !== 'height' || !this._onStrokeEnd) return;
    const b = bounds || this._lastBounds;
    try {
      this._onStrokeEnd({ kind, bounds: b ? { ...b } : null });
    } catch (err) {
      console.warn('[terrain-editor] onStrokeEnd failed:', err);
    }
  }

  _refreshUndoCount() {
    const n = this.edits && isFiniteNum(this.edits.undoCount) ? this.edits.undoCount : 0;
    if (this._undoLabelEl) this._undoLabelEl.textContent = String(n);
  }

  triggerUndo() {
    if (!this.edits || typeof this.edits.undo !== 'function') {
      this._toast('Nothing to undo');
      return;
    }
    let res = null;
    try {
      res = this.edits.undo();
    } catch (err) {
      console.warn('[terrain-editor] undo failed:', err);
      return;
    }
    this._refreshUndoCount();
    const bounds = normalizeBounds(res);
    if (bounds) this._lastBounds = bounds;
    this._emitHeightChanged(bounds || this._lastBounds || null);
    if (res && res.kind === 'height') this._notifyStrokeEnd('height', bounds);
    this._updateTelemetry();
  }

  // =====================================================================
  // DOM
  // =====================================================================
  _ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLES;
    (document.head || document.documentElement).appendChild(style);
  }

  _ensureDOM() {
    if (typeof document === 'undefined') return false;
    if (this._panel && this._panel.isConnected) return true;

    this._ensureStyles();

    const root = document.createElement('div');
    root.id = 'terrain-editor-root';

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'te-hidden';

    const pills = (list, group) =>
      list
        .map(
          (b) =>
            `<button class="te-pill${b.mode.startsWith('erase') ? ' te-erase' : ''}" ` +
            `data-group="${group}" data-mode="${b.mode}" title="${b.title}">${b.label}</button>`,
        )
        .join('');

    panel.innerHTML = `
      <div class="te-head">
        <span class="te-title">TERRAIN &amp; COLOR PAINTER</span>
        <span class="te-key">F9</span>
        <button class="te-close" data-act="close" title="Close (F9)">&times;</button>
      </div>

      <div class="te-sect te-sect-flush">
        <div class="te-label">HEIGHT BRUSHES</div>
        <div class="te-grid" data-group="height">${pills(HEIGHT_BRUSHES, 'height')}</div>
      </div>

      <div class="te-sect">
        <div class="te-label">COLOR / VEGETATION</div>
        <div class="te-grid" data-group="color">${pills(COLOR_BRUSHES, 'color')}</div>
      </div>

      <div class="te-sect">
        <div class="te-label">BRUSH<span class="te-hint">[ ] SIZE</span></div>
        <div class="te-row">
          <span class="te-row-label">RADIUS</span>
          <input class="te-range" type="range" min="0" max="1000" step="1" value="500" aria-label="Brush radius">
          <span class="te-val">320 m</span>
        </div>
        <div class="te-row">
          <span class="te-row-label">STRENGTH</span>
          <input class="te-range" type="range" min="5" max="100" step="1" value="55" aria-label="Brush strength">
          <span class="te-val">55%</span>
        </div>
      </div>

      <div class="te-sect">
        <div class="te-label">QUICK JUMP</div>
        <div class="te-grid te-grid-2">
          ${LOCATIONS.map((l, i) => `<button class="te-pill" data-loc="${i}">${l.name}</button>`).join('')}
        </div>
      </div>

      <div class="te-sect">
        <div class="te-label">CURSOR</div>
        <div class="te-tel">
          <div class="te-tel-line">POS: (<b class="te-x">—</b>, <b class="te-z">—</b>)</div>
          <div class="te-tel-line te-tel-dim">ELEV: <b class="te-elev">—</b> m &middot; &Delta;: <b class="te-delta">—</b> m</div>
        </div>
      </div>

      <div class="te-sect">
        <div class="te-label">ACTIONS</div>
        <button class="te-btn" data-act="undo">UNDO (CTRL+Z) &middot; <span class="te-undo-n">0</span></button>
        <button class="te-btn te-save" data-act="save">SAVE TO PROJECT</button>
        <div class="te-grid te-grid-2">
          <button class="te-btn" data-act="export">EXPORT JSON</button>
          <button class="te-btn" data-act="import">IMPORT JSON</button>
        </div>
        <button class="te-btn te-danger" data-act="reset">RESET ALL</button>
        <input class="te-file" type="file" accept=".json,application/json" hidden>
      </div>

      <div class="te-foot">
        L-DRAG Paint &middot; R-DRAG Look &middot; WASD/QE Fly &middot; WHEEL Speed<br>
        [ ] Size &middot; Ctrl+Z Undo &middot; F9 Exit
      </div>
    `;

    root.appendChild(panel);
    (document.body || document.documentElement).appendChild(root);

    this._root = root;
    this._panel = panel;
    this._telemetryEl = panel.querySelector('.te-tel');
    this._telXEl = panel.querySelector('.te-x');
    this._telZEl = panel.querySelector('.te-z');
    this._telElevEl = panel.querySelector('.te-elev');
    this._telDeltaEl = panel.querySelector('.te-delta');
    this._undoLabelEl = panel.querySelector('.te-undo-n');
    this._radiusInput = panel.querySelectorAll('.te-range')[0];
    this._radiusValEl = panel.querySelectorAll('.te-val')[0];
    this._strengthInput = panel.querySelectorAll('.te-range')[1];
    this._strengthValEl = panel.querySelectorAll('.te-val')[1];
    this._resetBtn = panel.querySelector('[data-act="reset"]');
    this._saveBtn = panel.querySelector('[data-act="save"]');
    this._fileInput = panel.querySelector('.te-file');

    panel.querySelectorAll('[data-mode]').forEach((btn) => {
      const mode = btn.dataset.mode;
      this._modeButtons.set(mode, btn);
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.setMode(mode);
      });
    });

    panel.querySelectorAll('[data-loc]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const spot = LOCATIONS[Number(btn.dataset.loc)];
        if (!spot) return;
        if (this.onTeleport) this.onTeleport({ ...spot });
      });
    });

    panel.querySelector('[data-act="close"]').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.hide();
      if (this.onExit) this.onExit();
    });

    panel.querySelector('[data-act="undo"]').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.triggerUndo();
    });

    this._saveBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._doSave();
    });

    panel.querySelector('[data-act="export"]').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._doExport();
    });

    panel.querySelector('[data-act="import"]').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (this._fileInput) this._fileInput.click();
    });

    this._fileInput.addEventListener('change', () => this._doImport());

    this._resetBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._handleResetClick();
    });

    this._radiusInput.addEventListener('input', () => {
      this.setRadius(this._sliderToRadius(Number(this._radiusInput.value)), false);
    });
    this._strengthInput.addEventListener('input', () => {
      this.setStrength(Number(this._strengthInput.value) / 100, false);
    });

    // Never let a slider drag fall through to the canvas and start painting.
    panel.addEventListener('pointerdown', (ev) => ev.stopPropagation());

    this._syncModeButtons();
    this._syncRadiusUI();
    this._syncStrengthUI();
    this._refreshUndoCount();
    this._renderTelemetry(null);
    return true;
  }

  // --- radius (logarithmic slider 40 m .. 3000 m) -----------------------
  _radiusToSlider(r) {
    const t = Math.log(clamp(r, RADIUS_MIN, RADIUS_MAX) / RADIUS_MIN) / Math.log(RADIUS_MAX / RADIUS_MIN);
    return Math.round(clamp(t, 0, 1) * 1000);
  }

  _sliderToRadius(v) {
    const t = clamp(v / 1000, 0, 1);
    return RADIUS_MIN * Math.pow(RADIUS_MAX / RADIUS_MIN, t);
  }

  setRadius(m, syncSlider = true) {
    const r = clamp(isFiniteNum(m) ? m : RADIUS_DEFAULT, RADIUS_MIN, RADIUS_MAX);
    this.radius = r;
    if (this._radiusValEl) this._radiusValEl.textContent = `${Math.round(r)} m`;
    // Only push back into the slider when the change did not come from it —
    // otherwise rounding could nudge the thumb under the user's finger.
    if (syncSlider && this._radiusInput) this._radiusInput.value = String(this._radiusToSlider(r));
    if (this._hoverWorld) this.updateCursorRing(this._hoverWorld.x, this._hoverWorld.z, this._heightFn);
    return r;
  }

  _syncRadiusUI() {
    if (this._radiusValEl) this._radiusValEl.textContent = `${Math.round(this.radius)} m`;
    if (this._radiusInput) this._radiusInput.value = String(this._radiusToSlider(this.radius));
  }

  /** Hotkey helper for `[` (0.83) and `]` (1.2) — multiplicative, clamped. */
  adjustRadius(mult) {
    const m = isFiniteNum(mult) && mult > 0 ? mult : 1;
    return this.setRadius(this.radius * m);
  }

  setStrength(f, syncSlider = true) {
    const s = clamp(isFiniteNum(f) ? f : STRENGTH_DEFAULT, 0.05, 1);
    this.strength = s;
    if (syncSlider && this._strengthInput) this._strengthInput.value = String(Math.round(s * 100));
    this._syncStrengthUI();
    return s;
  }

  _syncStrengthUI() {
    if (this._strengthValEl) this._strengthValEl.textContent = `${Math.round(this.strength * 100)}%`;
  }

  setMode(mode) {
    if (!mode || (!COLOR_MODE_SET.has(mode) && !HEIGHT_BRUSHES.some((b) => b.mode === mode))) return this.mode;
    this.mode = mode;
    this._syncModeButtons();
    if (this._ringGroup) this._setRingColor(this._ringColorForMode(mode));
    return this.mode;
  }

  _syncModeButtons() {
    if (!this._modeButtons.size) return;
    for (const [mode, btn] of this._modeButtons) {
      btn.classList.toggle('on', mode === this.mode);
    }
  }

  // =====================================================================
  // Telemetry
  // =====================================================================
  _updateTelemetry() {
    this._renderTelemetry(this._hoverWorld);
  }

  _renderTelemetry(hit) {
    const xEl = this._telXEl;
    if (!xEl || !this._telemetryEl) return;

    if (!hit) {
      xEl.textContent = '—';
      this._telZEl.textContent = '—';
      this._telElevEl.textContent = '—';
      this._telDeltaEl.textContent = '—';
      return;
    }

    const elev = isFiniteNum(hit.ground) ? hit.ground : 0;
    const base = isFiniteNum(this._strokeStartElev) ? this._strokeStartElev : elev;
    const delta = elev - base;
    // toFixed() renders tiny negatives as "-0"; normalise so the readout never
    // claims a negative zero.
    const metres = (v) => {
      const r = Math.round(v);
      return r === 0 ? '0' : r.toString();
    };
    const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
    xEl.textContent = metres(hit.x);
    this._telZEl.textContent = metres(hit.z);
    this._telElevEl.textContent = signed(elev);
    this._telDeltaEl.textContent = signed(delta);
  }

  // =====================================================================
  // Actions
  // =====================================================================
  _toast(msg) {
    if (!msg) return;
    if (this.onToast) this.onToast(msg);
  }

  _exportJSON() {
    if (!this.edits || typeof this.edits.exportJSON !== 'function') return null;
    try {
      return this.edits.exportJSON();
    } catch (err) {
      console.warn('[terrain-editor] exportJSON failed:', err);
      return null;
    }
  }

  async _doSave() {
    const jsonObj = this._exportJSON();
    if (!jsonObj) {
      this._toast('No terrain edits to save');
      return;
    }

    try {
      if (typeof this.edits.saveToLocalStorage === 'function') this.edits.saveToLocalStorage();
    } catch (err) {
      console.warn('[terrain-editor] localStorage save failed:', err);
    }

    if (this._saveBtn) {
      this._saveBtn.disabled = true;
      this._saveBtn.textContent = 'SAVING…';
    }

    let res = { ok: false, message: 'No save handler wired' };
    try {
      if (this.onSaveProject) {
        const out = await this.onSaveProject(jsonObj);
        if (out && typeof out === 'object') res = { ok: !!out.ok, message: out.message || '' };
        else res = { ok: true, message: '' };
      }
    } catch (err) {
      res = { ok: false, message: err && err.message ? err.message : 'Save failed' };
    }

    if (this._saveBtn) {
      this._saveBtn.disabled = false;
      this._saveBtn.textContent = 'SAVE TO PROJECT';
    }
    this._toast(res.ok ? res.message || 'Terrain edits saved' : `Save failed: ${res.message || 'unknown error'}`);
  }

  _doExport() {
    const jsonObj = this._exportJSON();
    if (!jsonObj) {
      this._toast('No terrain edits to export');
      return;
    }
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
    try {
      const text = JSON.stringify(jsonObj, null, 2);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vipava_edits.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      this._toast('Exported vipava_edits.json');
    } catch (err) {
      console.warn('[terrain-editor] export failed:', err);
      this._toast('Export failed');
    }
  }

  _doImport() {
    const input = this._fileInput;
    if (!input || !input.files || !input.files[0]) return;
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      let obj = null;
      try {
        obj = JSON.parse(String(reader.result));
      } catch (err) {
        this._toast('Invalid JSON file');
        return;
      }
      try {
        if (this.edits && typeof this.edits.importJSON === 'function') {
          this.edits.importJSON(obj);
        } else {
          this._toast('No edits store attached');
          return;
        }
      } catch (err) {
        console.warn('[terrain-editor] importJSON failed:', err);
        this._toast('Import failed');
        return;
      }
      this._refreshUndoCount();
      this._lastBounds = FULL_BOUNDS;
      this._emitHeightChanged(FULL_BOUNDS);
      this._notifyStrokeEnd('height', FULL_BOUNDS);
      this._toast(`Imported ${file.name}`);
    };
    reader.onerror = () => this._toast('Could not read file');
    reader.readAsText(file);
    input.value = '';
  }

  _handleResetClick() {
    const btn = this._resetBtn;
    if (!btn) return;
    if (btn.classList.contains('te-armed')) {
      this._resetAll();
      return;
    }
    btn.classList.add('te-armed');
    btn.textContent = 'CONFIRM RESET?';
    clearTimeout(this._resetTimer);
    this._resetTimer = setTimeout(() => {
      if (!this._resetBtn) return;
      this._resetBtn.classList.remove('te-armed');
      this._resetBtn.textContent = 'RESET ALL';
    }, 3000);
  }

  _resetAll() {
    clearTimeout(this._resetTimer);
    if (this._resetBtn) {
      this._resetBtn.classList.remove('te-armed');
      this._resetBtn.textContent = 'RESET ALL';
    }
    try {
      if (this.edits && typeof this.edits.clearAll === 'function') this.edits.clearAll();
      if (this.edits && typeof this.edits.saveToLocalStorage === 'function') this.edits.saveToLocalStorage();
    } catch (err) {
      console.warn('[terrain-editor] reset failed:', err);
      return;
    }
    this._refreshUndoCount();
    this._lastBounds = FULL_BOUNDS;
    this._emitHeightChanged(FULL_BOUNDS);
    this._notifyStrokeEnd('height', FULL_BOUNDS);
    this._toast('All terrain edits cleared');
  }

  // =====================================================================
  // Visibility
  // =====================================================================
  show() {
    this.active = true;
    if (this._ensureDOM()) {
      this._panel.classList.remove('te-hidden');
      this._refreshUndoCount();
      this._syncModeButtons();
      this._renderTelemetry(this._hoverWorld);
    }
    if (this._ringGroup) this._ringGroup.visible = !!this._hoverWorld;
    return this;
  }

  hide() {
    this.active = false;
    this._paintHeld = false;
    this._lookDrag = false;
    this._strokeStartElev = null;
    if (this._panel) this._panel.classList.add('te-hidden');
    if (this._ringGroup) this._ringGroup.visible = false;
    return this;
  }

  toggle() {
    return this.active ? this.hide() : this.show();
  }

  // =====================================================================
  // Input plumbing (driven by src/main.js)
  // =====================================================================
  isPointerOverUI(target) {
    if (!target || typeof target !== 'object') return false;
    const panel = this._panel;
    if (!panel || typeof panel.contains !== 'function') return false;
    try {
      if (panel === target) return true;
      return panel.contains(target);
    } catch (err) {
      return false;
    }
  }

  /**
   * @returns {{ handled: boolean, lookDrag: boolean }}
   *   `handled` — the editor consumed the press (skip camera/weapon handling).
   *   `lookDrag` — right button: the caller should apply `onPointerMove` deltas
   *                to the free camera yaw/pitch for this drag.
   */
  onPointerDown(ev, camera, canvas, heightAt) {
    if (!this.active || !ev) return { handled: false, lookDrag: false };
    if (this.isPointerOverUI(ev.target)) return { handled: false, lookDrag: false };

    if (ev.button === 2) {
      this._lookDrag = true;
      this._prevLook.x = ev.clientX || 0;
      this._prevLook.y = ev.clientY || 0;
      this._lastPointer.x = ev.clientX || 0;
      this._lastPointer.y = ev.clientY || 0;
      return { handled: true, lookDrag: true };
    }

    if (ev.button !== 0) return { handled: false, lookDrag: false };

    this._lastPointer.x = ev.clientX;
    this._lastPointer.y = ev.clientY;
    const hf = this._resolveHeightAt(heightAt);
    const hit = this.pickWorldPoint(ev.clientX, ev.clientY, camera, canvas, hf);

    if (!hit) {
      this._hoverWorld = null;
      if (this._ringGroup) this._ringGroup.visible = false;
      this._updateTelemetry();
      return { handled: true, lookDrag: false };
    }

    this._hoverWorld = hit;
    // FLATTEN pins the target elevation the instant the stroke begins.
    this._flattenHeight = hit.ground;
    this._strokeStartElev = hit.ground;
    this._paintHeld = true;

    // `TerrainEdits.beginStroke` groups undo records by grid: 'height' | 'color'.
    if (this.edits && typeof this.edits.beginStroke === 'function') {
      try {
        this.edits.beginStroke(this._isColorMode() ? 'color' : 'height');
      } catch (err) {
        console.warn('[terrain-editor] beginStroke failed:', err);
      }
    }

    // The store clamps every brush to its own world bounds; say so once per
    // stroke instead of leaving the player clicking at a dead cursor.
    const eb = this.edits && this.edits.bounds;
    if (eb && [eb.xMin, eb.xMax, eb.zMin, eb.zMax].every(isFiniteNum)
      && (hit.x < eb.xMin || hit.x > eb.xMax || hit.z < eb.zMin || hit.z > eb.zMax)) {
      this._toast('Outside the editable terrain area');
    }

    this._applyBrush(hit, 0.12);
    this.updateCursorRing(hit.x, hit.z, hf);
    this._updateTelemetry();
    return { handled: true, lookDrag: false };
  }

  /**
   * @returns {{ lookDx: number, lookDy: number }} right-drag deltas in pixels
   *   (0, 0 when not looking around).
   */
  onPointerMove(ev, camera, canvas, heightAt) {
    if (!this.active || !ev) return { lookDx: 0, lookDy: 0 };

    this._lastPointer.x = ev.clientX;
    this._lastPointer.y = ev.clientY;

    let lookDx = 0;
    let lookDy = 0;

    if (this._lookDrag) {
      if (isFiniteNum(ev.movementX) && isFiniteNum(ev.movementY) && (ev.movementX || ev.movementY)) {
        lookDx = ev.movementX;
        lookDy = ev.movementY;
      } else {
        lookDx = ev.clientX - this._prevLook.x;
        lookDy = ev.clientY - this._prevLook.y;
      }
      this._prevLook.x = ev.clientX;
      this._prevLook.y = ev.clientY;
    }

    this._refreshHover(camera, canvas, heightAt);
    return { lookDx, lookDy };
  }

  _refreshHover(camera, canvas, heightAt) {
    const hf = this._resolveHeightAt(heightAt);
    const hit = this.pickWorldPoint(this._lastPointer.x, this._lastPointer.y, camera, canvas, hf);
    this._hoverWorld = hit || null;
    if (hit) {
      this.updateCursorRing(hit.x, hit.z, hf);
    } else if (this._ringGroup) {
      this._ringGroup.visible = false;
    }
    this._updateTelemetry();
    return hit;
  }

  onPointerUp(ev) {
    if (!this.active) return;
    const button = ev && isFiniteNum(ev.button) ? ev.button : -1;

    if (button === 2) {
      this._lookDrag = false;
      return;
    }
    // Middle/other buttons are not ours; -1 means the event carried no button
    // info and is treated as a left release.
    if (button !== 0 && button !== -1) return;
    if (!this._paintHeld) return;

    this._paintHeld = false;
    this._strokeStartElev = null;

    let stroke = null;
    if (this.edits && typeof this.edits.endStroke === 'function') {
      try {
        stroke = this.edits.endStroke();
      } catch (err) {
        console.warn('[terrain-editor] endStroke failed:', err);
      }
    }
    try {
      if (this.edits && typeof this.edits.saveToLocalStorage === 'function') this.edits.saveToLocalStorage();
    } catch (err) {
      console.warn('[terrain-editor] localStorage save failed:', err);
    }
    this._refreshUndoCount();
    if (stroke && stroke.kind === 'height') {
      this._notifyStrokeEnd('height', normalizeBounds(stroke.bounds));
    }
    if (this._hoverWorld) this.updateCursorRing(this._hoverWorld.x, this._hoverWorld.z, this._heightFn);
    this._updateTelemetry();
  }

  /**
   * Per-frame tick: re-picks under the last pointer while the left button is
   * held, applies the brush with a steady dt-based rate (so holding still keeps
   * raising, and dragging paints smoothly), and refreshes ring + telemetry.
   */
  update(dt, camera, canvas, heightAt) {
    if (!this.active) return;
    const step = clamp(isFiniteNum(dt) ? dt : 0.016, 0, 0.1);
    this._elapsed += step;

    if (typeof heightAt === 'function') this._heightFn = heightAt;
    const hf = this._heightFn;

    if (this._paintHeld && camera && canvas) {
      // Re-pick every frame so the brush stays welded to the cursor even if the
      // camera keeps drifting, and so dragging follows the pointer exactly.
      const hit = this.pickWorldPoint(this._lastPointer.x, this._lastPointer.y, camera, canvas, hf);
      if (hit) this._hoverWorld = hit;
    }

    if (this._paintHeld && this._hoverWorld && step > 0) {
      this._applyBrush(this._hoverWorld, step);
      this.updateCursorRing(this._hoverWorld.x, this._hoverWorld.z, hf);
      this._updateTelemetry();
      return;
    }

    if (this._hoverWorld) this.updateCursorRing(this._hoverWorld.x, this._hoverWorld.z, hf);
  }

  // =====================================================================
  // Teardown
  // =====================================================================
  dispose() {
    if (this._resetTimer) clearTimeout(this._resetTimer);
    this._resetTimer = 0;
    this._paintHeld = false;
    this._lookDrag = false;
    this.active = false;

    if (this._ringGroup) {
      if (this.scene && typeof this.scene.remove === 'function') this.scene.remove(this._ringGroup);
      this._ringGroup.traverse((obj) => {
        if (obj.geometry && typeof obj.geometry.dispose === 'function') obj.geometry.dispose();
        if (obj.material && typeof obj.material.dispose === 'function') obj.material.dispose();
      });
      this._ringGroup = null;
      this._ringOuter = null;
      this._ringInner = null;
    }

    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
    this._panel = null;
    this._telemetryEl = null;
    this._telXEl = null;
    this._telZEl = null;
    this._telElevEl = null;
    this._telDeltaEl = null;
    this._undoLabelEl = null;
    this._radiusInput = null;
    this._radiusValEl = null;
    this._strengthInput = null;
    this._strengthValEl = null;
    this._resetBtn = null;
    this._saveBtn = null;
    this._fileInput = null;
    this._modeButtons.clear();
    this._hoverWorld = null;
  }
}

export default TerrainEditorUI;