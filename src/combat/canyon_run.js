// Feature 30 — Soča & Vipava Canyon Run.
//
// A Top Gun: Maverick-style timed low-level gate course through the real
// Vipava Valley: Ajdovščina (LJAJ departure), the Vipava valley floor,
// Vogršček dam, Šempeter, Gorizia castle, the Soča gorge, Solkan arch bridge
// and the Sveta Gora finish. Eight gates, ~24 km, flown low.
//
// The module is headless-safe: `new CanyonRunSystem(null)` skips every
// Three.js object and keeps the pure course/state machine, which is what the
// Node acceptance test and the MCP bridge drive. Pass a THREE.Scene to get
// the glowing gate rings and the active beacon pillar.
//
// World conventions (ARCHITECTURE.md): 1 unit = 1 metre, Y up,
// North = -Z, East = +X, headingDeg = atan2(dx, -dz) clockwise from north.

import * as THREE from 'three';
import { terrainHeight } from '../world/terrain.js';

const DEG = Math.PI / 180;

/** Medal cut-offs in seconds for the ~24 km course at 450-650 kt. */
export const MEDAL_GOLD_S = 95;
export const MEDAL_SILVER_S = 125;

const MPS_TO_KTS = 1.943844;

const COLOR_ACTIVE = 0x38ffe0;   // next gate: cyan-gold pulse
const COLOR_UPCOMING = 0xffaa44; // dim amber
const COLOR_PASSED = 0x44ff88;   // emerald, fades out

/** The eight real-world gates, ordered from LJAJ to Sveta Gora. */
export const CANYON_GATES = [
  { id: 'gate-1', name: 'LJAJ DEPARTURE', x: -2200, z: -150, agl: 110, radius: 130, headingDeg: 270 },
  { id: 'gate-2', name: 'VIPAVA VALLEY', x: -7500, z: -850, agl: 110, radius: 130, headingDeg: 275 },
  { id: 'gate-3', name: 'VOGRŠČEK DAM', x: -13005, z: -1534, agl: 95, radius: 125, headingDeg: 290 },
  { id: 'gate-4', name: 'ŠEMPETER APPROACH', x: -16800, z: -4200, agl: 100, radius: 125, headingDeg: 315 },
  { id: 'gate-5', name: 'GORIZIA CASTLE', x: -19500, z: -6350, agl: 115, radius: 125, headingDeg: 10 },
  { id: 'gate-6', name: 'SOČA GORGE ENTRY', x: -18600, z: -8600, agl: 90, radius: 115, headingDeg: 15 },
  { id: 'gate-7', name: 'SOLKAN ARCH BRIDGE', x: -18201, z: -10035, agl: 85, radius: 110, headingDeg: 20 },
  { id: 'gate-8', name: 'SVETA GORA FINISH', x: -17720, z: -11947, agl: 130, radius: 145, headingDeg: 15 },
];

function norm360(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Bearing from one world point to another, degrees clockwise from north. */
function bearingDeg(x1, z1, x2, z2) {
  return norm360(Math.atan2(x2 - x1, -(z2 - z1)) / DEG);
}

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

export class CanyonRunSystem {
  /**
   * @param {THREE.Scene|null} scene  pass null for headless operation
   */
  constructor(scene = null) {
    this.scene = scene || null;

    this.group = null;
    this.gates = [];
    this._ringGeo = null;
    this._pillarGeo = null;
    this._pillarMat = null;
    this._pillar = null;

    this._heightAt = (x, z) => terrainHeight(x, z);
    this._lastPos = null;

    this._resetState();
    this.gates = this._resolveGates();
  }

  // -- lifecycle -----------------------------------------------------------

  _resetState() {
    this.active = false;
    this.gateIndex = 0;
    this.elapsed = 0;
    this.finished = false;
    this.medal = null;
    this.splits = [];
    this.bestSpeedKts = 0;
    this.finishTimeS = null;
    this._lastPos = null;
  }

  _resolveGates() {
    return CANYON_GATES.map((g) => ({
      id: g.id,
      name: g.name,
      x: g.x,
      z: g.z,
      agl: g.agl,
      radius: g.radius,
      headingDeg: norm360(g.headingDeg),
      y: this._heightAt(g.x, g.z) + g.agl,
    }));
  }

  /** Build/reset the gates and start the clock. */
  start(world = null) {
    this._heightAt = world && typeof world.heightAt === 'function'
      ? (x, z) => world.heightAt(x, z)
      : (x, z) => terrainHeight(x, z);

    this._clearVisuals();
    this._resetState();
    this.gates = this._resolveGates();
    this.active = true;
    this._buildVisuals();
    this._updateVisuals(0);
    return this.getState();
  }

  /** Hide/clear every gate mesh and stop the clock. */
  stop() {
    this.active = false;
    this._clearVisuals();
    return this.getState();
  }

  // -- per-frame -----------------------------------------------------------

  /**
   * @param {number} dt seconds
   * @param {{x:number,y:number,z:number}} aircraftPos
   * @param {number} speedMs ground speed, m/s (for best-speed tracking)
   * @returns {{gatePassed: object|null, finished: boolean, medal: string|null}}
   */
  update(dt, aircraftPos, speedMs = 0) {
    const step = Math.max(0, finite(dt));
    const kts = Math.max(0, finite(speedMs)) * MPS_TO_KTS;
    if (kts > this.bestSpeedKts) this.bestSpeedKts = kts;

    const pos = this._resolvePos(aircraftPos);
    if (pos) this._lastPos = pos;

    let gatePassed = null;

    if (this.active && !this.finished) {
      this.elapsed += step;

      // One gate per frame keeps ordering strict; gates are kilometres apart.
      if (pos && this.gateIndex < this.gates.length) {
        const gate = this.gates[this.gateIndex];
        if (this._passesGate(gate, pos)) {
          this.gateIndex++;
          this.splits.push({
            index: this.gateIndex - 1,
            id: gate.id,
            name: gate.name,
            t: this.elapsed,
          });
          gatePassed = gate;
          if (this.gateIndex >= this.gates.length) {
            this.finished = true;
            this.medal = this._medalFor(this.elapsed);
            this.finishTimeS = this.elapsed;
          }
        }
      }
    }

    this._updateVisuals(step);

    return {
      gatePassed: gatePassed ? this._gateState(gatePassed) : null,
      finished: this.finished,
      medal: this.medal,
    };
  }

  _resolvePos(aircraftPos) {
    if (!aircraftPos) return null;
    const x = finite(aircraftPos.x, NaN);
    const z = finite(aircraftPos.z, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    return { x, y: finite(aircraftPos.y, NaN), z };
  }

  /**
   * Ring passage: inside the slab through the gate plane and within the ring
   * radius laterally/vertically. Missing y falls back to the gate centre.
   */
  _passesGate(gate, pos) {
    const dx = pos.x - gate.x;
    const dz = pos.z - gate.z;
    const dy = Number.isFinite(pos.y) ? pos.y - gate.y : 0;

    const h = gate.headingDeg * DEG;
    const nx = Math.sin(h);
    const nz = -Math.cos(h); // gate normal = direction of flight
    const tx = Math.cos(h);
    const tz = Math.sin(h);  // lateral axis inside the ring plane

    const along = dx * nx + dz * nz;
    const lateral = dx * tx + dz * tz;
    const slab = Math.max(60, gate.radius * 0.6);
    return Math.abs(along) <= slab && Math.hypot(lateral, dy) <= gate.radius;
  }

  _medalFor(seconds) {
    if (seconds <= MEDAL_GOLD_S) return 'GOLD';
    if (seconds <= MEDAL_SILVER_S) return 'SILVER';
    return 'BRONZE';
  }

  // -- state ---------------------------------------------------------------

  _gateState(gate) {
    if (!gate) return null;
    return {
      id: gate.id,
      name: gate.name,
      x: gate.x,
      y: gate.y,
      z: gate.z,
      agl: gate.agl,
      radius: gate.radius,
      headingDeg: gate.headingDeg,
    };
  }

  /** HUD / steerpoint snapshot. */
  getState() {
    const next = this.gateIndex < this.gates.length ? this.gates[this.gateIndex] : null;
    const pos = this._lastPos;

    let distToNextM = 0;
    let bearingToNextDeg = 0;
    if (next && pos) {
      distToNextM = Math.hypot(next.x - pos.x, next.z - pos.z);
      bearingToNextDeg = bearingDeg(pos.x, pos.z, next.x, next.z);
    }

    return {
      active: this.active,
      gateIndex: this.gateIndex,
      totalGates: this.gates.length,
      nextGate: this._gateState(next),
      elapsed: this.elapsed,
      finished: this.finished,
      medal: this.medal,
      splits: this.splits.map((s) => ({ ...s })),
      distToNextM,
      bearingToNextDeg,
    };
  }

  // -- visuals -------------------------------------------------------------

  _buildVisuals() {
    if (!this.scene) return;

    const group = new THREE.Group();
    group.name = 'canyonRunGates';
    this.scene.add(group);
    this.group = group;

    // One unit torus, scaled per gate by its radius.
    this._ringGeo = new THREE.TorusGeometry(1, 0.045, 8, 44);

    for (const gate of this.gates) {
      const mat = new THREE.MeshBasicMaterial({
        color: COLOR_UPCOMING,
        toneMapped: false,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(this._ringGeo, mat);
      ring.position.set(gate.x, gate.y, gate.z);
      ring.scale.setScalar(gate.radius);
      // Torus normal is +Z; rotate it to face along the gate heading.
      ring.rotation.y = Math.PI - gate.headingDeg * DEG;
      group.add(ring);
      gate.ring = ring;
      gate.mat = mat;
      gate.fade = 1;
    }

    // Vertical beacon pillar, moved onto whichever gate is active.
    this._pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    this._pillarMat = new THREE.MeshBasicMaterial({
      color: COLOR_ACTIVE,
      toneMapped: false,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this._pillar = new THREE.Mesh(this._pillarGeo, this._pillarMat);
    this._pillar.scale.set(7, 1500, 7);
    this._pillar.visible = false;
    group.add(this._pillar);
  }

  _updateVisuals(dt) {
    if (!this.group) return;

    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 6.0);
    const step = Math.max(0, finite(dt));

    for (let i = 0; i < this.gates.length; i++) {
      const gate = this.gates[i];
      if (!gate.ring || !gate.mat) continue;

      if (i < this.gateIndex) {
        // Passed: emerald and fading out.
        gate.mat.color.setHex(COLOR_PASSED);
        gate.fade = Math.max(0, gate.fade - step * 1.4);
        gate.mat.opacity = 0.5 * gate.fade;
        gate.ring.scale.setScalar(gate.radius * (1 + (1 - gate.fade) * 0.18));
        if (gate.fade <= 0.01) gate.ring.visible = false;
      } else if (i === this.gateIndex && !this.finished) {
        // Active next gate: bright cyan-gold pulse.
        gate.mat.color.setHex(COLOR_ACTIVE);
        gate.mat.opacity = 0.55 + 0.45 * pulse;
        gate.ring.scale.setScalar(gate.radius * (1 + 0.03 * pulse));
        gate.ring.visible = true;
        gate.fade = 1;
      } else {
        gate.mat.color.setHex(COLOR_UPCOMING);
        gate.mat.opacity = 0.3;
        gate.ring.scale.setScalar(gate.radius);
        gate.ring.visible = true;
        gate.fade = 1;
      }
    }

    const next = this.gates[this.gateIndex];
    if (this._pillar) {
      if (next && !this.finished) {
        this._pillar.visible = true;
        this._pillar.position.set(next.x, next.y + 750, next.z);
        this._pillarMat.opacity = 0.1 + 0.1 * pulse;
      } else {
        this._pillar.visible = false;
      }
    }
  }

  _clearVisuals() {
    if (this.group) {
      if (this.scene) this.scene.remove(this.group);
      this.group = null;
    }

    for (const gate of this.gates) {
      if (gate.mat) gate.mat.dispose();
      gate.ring = null;
      gate.mat = null;
      gate.fade = 1;
    }

    if (this._ringGeo) {
      this._ringGeo.dispose();
      this._ringGeo = null;
    }
    if (this._pillarGeo) {
      this._pillarGeo.dispose();
      this._pillarGeo = null;
    }
    if (this._pillarMat) {
      this._pillarMat.dispose();
      this._pillarMat = null;
    }
    this._pillar = null;
  }

  /** Release every Three.js resource and forget the course. */
  dispose() {
    this.active = false;
    this._clearVisuals();
    this.gates = [];
    this.splits = [];
    this.scene = null;
  }
}