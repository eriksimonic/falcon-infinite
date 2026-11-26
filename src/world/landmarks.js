// Iconic 3D landmarks for the real Vipava Valley theater.
//
// The bake script (`scripts/bake_vipava_osm.py`) turns a hand-curated list of
// real-GPS landmarks (Sveta Gora Basilica, Solkan bridge & dam, the Nanos
// broadcast mast, Gorizia castle, the Trieste lighthouse, …) into world-space
// records on the baked OSM payload:
//
//   { id, name, kind, x, z, rot, scale?, length?, height? }
//
// `LandmarkSystem` normalizes that list, grounds every landmark on the active
// terrain and builds a rich multi-part procedural mesh per kind. Every
// structure sits on a 4 m deep foundation skirt so a hilltop basilica or the
// Nanos mast never floats over a steep DEM slope.
//
// The system is 100% headless-safe: with `scene === null` it neither touches
// the DOM/WebGL nor builds meshes, so Node unit tests can drive the whole
// normalization + beacon animation path. A plain `{ add, remove }` stub scene
// is enough to exercise the mesh builders (THREE geometry needs no renderer).

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

export const LANDMARK_KINDS = ['church', 'bridge', 'dam', 'tower', 'castle', 'lighthouse'];

const FOUNDATION_DEPTH = 4; // metres of skirt below the terrain sample
const FOUNDATION_TOP = 0.6; // …and this much above it, so slopes never win

const KINDS = new Set(LANDMARK_KINDS);

// Palette (sRGB hex; converted to linear when the material is created).
const COL = {
  limestone: 0xe7e1d3,
  limestoneDark: 0xcfc6b2,
  stone: 0xc4bba7,
  terracotta: 0xa8543a,
  concrete: 0xb9b7af,
  concreteDark: 0x8f8e88,
  steel: 0x9aa0a4,
  steelDark: 0x61676b,
  red: 0xc22a1c,
  white: 0xf1f0ea,
  gold: 0xc9a34a,
  window: 0x2b3238,
  roofDark: 0x6f6a60,
  beaconRed: 0xff2a14,
  beaconWhite: 0xfff8dc,
};

const DEFAULT_HEIGHT = {
  bridge: 34,
  dam: 28,
  tower: 90,
  lighthouse: 60,
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalize one baked landmark record. Returns null when it cannot be placed.
 * `y` is always sampled from the active terrain, never trusted from the file.
 */
function normalizeLandmark(item, index, heightAt) {
  if (!item || typeof item !== 'object') return null;
  const x = Number(item.x);
  const z = Number(item.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;

  const y = heightAt(x, z);
  if (!Number.isFinite(y)) return null;

  const kind = KINDS.has(item.kind) ? item.kind : 'church';
  const scale = Math.max(0.2, num(item.scale, 1));
  const height = Math.max(2, num(item.height, DEFAULT_HEIGHT[kind] || 20));
  const length = Math.max(4, num(item.length, kind === 'bridge' ? 220 : kind === 'dam' ? 180 : 0));
  const record = {
    id: typeof item.id === 'string' && item.id ? item.id : `landmark-${index}`,
    name: typeof item.name === 'string' ? item.name : `Landmark ${index + 1}`,
    kind,
    x,
    y,
    z,
    rot: num(item.rot, 0),
    scale,
    height,
  };
  if (length > 0) record.length = length;
  if (Number.isFinite(Number(item.phase))) record.phase = Number(item.phase);
  return record;
}

export class LandmarkSystem {
  /**
   * @param {THREE.Scene|{add:Function,remove:Function}|null} scene
   *        null keeps the whole system headless (no meshes are built).
   */
  constructor(scene = null) {
    this.scene = scene || null;
    this.landmarks = [];
    this.group = this.scene ? new THREE.Group() : null;
    this._beacons = [];
    this._time = 0;
    this.stats = { landmarks: 0, beacons: 0 };

    // Shared unit geometries, created lazily the first time a mesh is built
    // and disposed only by dispose() (clear() reuses them).
    this._geo = null;
    // Per-system material cache: one material per (colour, options) key.
    this._materials = new Map();

    if (this.group) {
      this.group.name = 'landmarks';
      this.scene.add(this.group);
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  /**
   * Replace every landmark with `list` (baked OSM records) and rebuild meshes.
   *
   * @param {Array<object>|null} list
   * @param {(x:number, z:number) => number} heightAt
   * @returns {number} number of placed landmarks
   */
  setLandmarks(list, heightAt = terrainHeight) {
    this.clear();
    if (!Array.isArray(list) || list.length === 0) return 0;

    const sample = typeof heightAt === 'function' ? heightAt : terrainHeight;
    for (let i = 0; i < list.length; i++) {
      const lm = normalizeLandmark(list[i], i, sample);
      if (!lm) continue;
      this.landmarks.push(lm);
      if (this.group) this._buildLandmark(lm);
    }

    this.stats.landmarks = this.landmarks.length;
    this.stats.beacons = this._beacons.length;
    return this.landmarks.length;
  }

  /** Blink aviation strobes and pulse lighthouse beacons. */
  update(dt) {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this._time += step;

    for (const b of this._beacons) {
      if (b.kind === 'aviation') {
        // Hard red strobe: ~1 Hz on/off with a touch of rise/fall.
        const phase = Math.sin(this._time * b.speed + b.phase);
        const on = phase > 0.15;
        b.mesh.visible = on;
        if (b.material) b.material.emissiveIntensity = on ? 2.6 : 0.05;
        b.mesh.scale.setScalar(on ? 1.15 : 0.85);
      } else {
        // Lighthouse: slow white pulse with an expanding halo.
        const pulse = 0.5 + 0.5 * Math.sin(this._time * b.speed + b.phase);
        if (b.material) {
          b.material.opacity = 0.35 + 0.6 * pulse;
          if ('emissiveIntensity' in b.material) b.material.emissiveIntensity = 0.6 + 2.4 * pulse;
        }
        b.mesh.scale.setScalar(1 + 0.3 * pulse);
        if (b.halo) {
          b.halo.scale.setScalar(1.4 + 1.5 * pulse);
          if (b.halo.material) b.halo.material.opacity = 0.05 + 0.28 * pulse;
        }
      }
    }
  }

  /** Remove every landmark mesh and release its materials. */
  clear() {
    if (this.group) {
      for (const child of [...this.group.children]) {
        this.group.remove(child);
      }
    }
    // Beacon materials are standalone (they animate per landmark), so they are
    // not part of the shared cache above.
    for (const b of this._beacons) {
      b.material?.dispose();
      b.halo?.material?.dispose();
    }
    for (const material of this._materials.values()) material.dispose();
    this._materials.clear();
    this._beacons.length = 0;
    this.landmarks = [];
    this.stats.landmarks = 0;
    this.stats.beacons = 0;
  }

  /** Detach the system from the scene and free everything. */
  dispose() {
    this.clear();
    if (this._geo) {
      for (const g of Object.values(this._geo)) g.dispose();
      this._geo = null;
    }
    if (this.group) {
      this.group.removeFromParent();
      this.group = null;
    }
  }

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------
  _resources() {
    if (this._geo) return this._geo;
    this._geo = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl8: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
      cyl16: new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
      cone4: new THREE.ConeGeometry(0.5, 1, 4),
      cone8: new THREE.ConeGeometry(0.5, 1, 8),
      cone12: new THREE.ConeGeometry(0.5, 1, 12),
      sphere: new THREE.SphereGeometry(0.5, 10, 8),
    };
    return this._geo;
  }

  /** Cached opaque material for a colour (released by clear()). */
  _mat(color, { roughness = 0.9, metalness = 0.02, emissive = 0x000000 } = {}) {
    const key = `${color}:${roughness}:${metalness}:${emissive}`;
    let material = this._materials.get(key);
    if (material) return material;
    material = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      emissive,
      emissiveIntensity: emissive ? 1 : 0,
    });
    material.color.convertSRGBToLinear();
    if (emissive) material.emissive.convertSRGBToLinear();
    this._materials.set(key, material);
    return material;
  }

  /** Box part: unit cube scaled to (w, h, d), centred on (x, y, z). */
  _box(parent, color, x, y, z, w, h, d, rx = 0, ry = 0, rz = 0, opts) {
    const mesh = new THREE.Mesh(this._resources().box, this._mat(color, opts));
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.scale.set(w, h, d);
    parent.add(mesh);
    return mesh;
  }

  /** Cylinder part (uniform radius) with unit height along Y. */
  _cyl(parent, color, x, y, z, radius, h, segments = 8, rx = 0, ry = 0, rz = 0, opts) {
    const geo = segments >= 16 ? this._resources().cyl16 : this._resources().cyl8;
    const mesh = new THREE.Mesh(geo, this._mat(color, opts));
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.scale.set(radius * 2, h, radius * 2);
    parent.add(mesh);
    return mesh;
  }

  /** Cone / pyramid (tapered to a point) with unit height along Y. */
  _cone(parent, color, x, y, z, radius, h, segments = 8, rx = 0, ry = 0, rz = 0, opts) {
    const geo = segments === 4 ? this._resources().cone4
      : segments <= 8 ? this._resources().cone8
        : this._resources().cone12;
    const mesh = new THREE.Mesh(geo, this._mat(color, opts));
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.scale.set(radius * 2, h, radius * 2);
    parent.add(mesh);
    return mesh;
  }

  /** Sphere part (finials, beacons). */
  _sphere(parent, color, x, y, z, radius, opts) {
    const mesh = new THREE.Mesh(this._resources().sphere, this._mat(color, opts));
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(radius * 2);
    parent.add(mesh);
    return mesh;
  }

  /** Foundation skirt: 4 m into the ground plus a shallow visible plinth. */
  _foundation(parent, w, d, color = COL.stone) {
    const h = FOUNDATION_DEPTH + FOUNDATION_TOP;
    return this._box(parent, color, 0, FOUNDATION_TOP - h / 2, 0, w, h, d);
  }

  /** Gable roof made from two slanted slabs; ridge runs along local Z. */
  _gableRoof(parent, color, width, depth, rise, y, thickness = 0.7) {
    const half = width * 0.5;
    const slope = Math.hypot(half, rise);
    const angle = Math.atan2(rise, half);
    const midY = y + rise * 0.5;
    const x = half * 0.5;
    this._box(parent, color, -x, midY, 0, slope, thickness, depth, 0, 0, angle);
    this._box(parent, color, x, midY, 0, slope, thickness, depth, 0, 0, -angle);
  }

  // -------------------------------------------------------------------------
  // Landmark builder
  // -------------------------------------------------------------------------
  _buildLandmark(lm) {
    const obj = new THREE.Group();
    obj.name = `landmark:${lm.id}`;
    obj.position.set(lm.x, lm.y, lm.z);
    obj.rotation.y = lm.rot || 0;
    obj.userData.landmark = lm;

    switch (lm.kind) {
      case 'bridge': this._buildBridge(obj, lm); break;
      case 'dam': this._buildDam(obj, lm); break;
      case 'tower': this._buildTower(obj, lm); break;
      case 'castle': this._buildCastle(obj, lm); break;
      case 'lighthouse': this._buildLighthouse(obj, lm); break;
      case 'church':
      default: this._buildChurch(obj, lm); break;
    }

    lm.object = obj;
    this.group.add(obj);
    return obj;
  }

  // White Karst limestone nave, terracotta gable roof, tall campanile with a
  // tapered spire and a golden finial cross. Covers Sveta Gora, Kostanjevica
  // and the Piran bell tower alike (the scale field differentiates them).
  _buildChurch(parent, lm) {
    const s = lm.scale;
    const naveW = 15 * s;
    const naveH = 11 * s;
    const naveD = 28 * s;
    const roofRise = naveW * 0.34;

    this._foundation(parent, naveW + 5, naveD + 5, COL.limestoneDark);
    this._box(parent, COL.limestoneDark, 0, 0.45, 0, naveW + 2.4, 1.5, naveD + 2.4);
    this._box(parent, COL.limestone, 0, naveH * 0.5 + 1, 0, naveW, naveH, naveD);
    this._gableRoof(parent, COL.terracotta, naveW + 0.8, naveD + 1.2, roofRise, naveH + 1);

    // Apse at the liturgical east end.
    this._cyl(parent, COL.limestone, 0, naveH * 0.42 + 1, naveD * 0.5 + 1.5, naveW * 0.32, naveH * 0.8, 8);
    this._cone(parent, COL.terracotta, 0, naveH * 0.86 + 1, naveD * 0.5 + 1.5, naveW * 0.36, roofRise * 0.8, 8);

    // Front portal + a row of dark arched windows along both long walls.
    this._box(parent, COL.window, 0, 3.1 * s + 1, naveD * 0.5 + 0.12, 3.2 * s, 4.6 * s, 0.3);
    for (let i = -1; i <= 1; i++) {
      this._box(parent, COL.window, naveW * 0.5 + 0.1, naveH * 0.62 + 1, i * 8 * s, 0.25, 3.4 * s, 1.5 * s);
      this._box(parent, COL.window, -naveW * 0.5 - 0.1, naveH * 0.62 + 1, i * 8 * s, 0.25, 3.4 * s, 1.5 * s);
    }

    // Campanile: square shaft, belfry with open arches, cornice, spire, cross.
    const towerW = 7 * s;
    const towerH = 30 * s;
    const tz = -naveD * 0.5 - towerW * 0.5 - 1;
    this._foundation(parent, towerW + 3, towerW + 3, COL.limestoneDark);
    this._box(parent, COL.limestone, 0, towerH * 0.5, tz, towerW, towerH, towerW);
    this._box(parent, COL.limestoneDark, 0, towerH * 0.86, tz, towerW * 1.06, 1.2 * s, towerW * 1.06);
    // Belfry openings on all four faces.
    for (let f = 0; f < 4; f++) {
      const a = (f * Math.PI) / 2;
      this._box(
        parent, COL.window,
        Math.sin(a) * towerW * 0.5, towerH * 0.74, tz + Math.cos(a) * towerW * 0.5,
        Math.abs(Math.sin(a)) > 0.5 ? 0.3 : towerW * 0.42,
        6 * s,
        Math.abs(Math.cos(a)) > 0.5 ? 0.3 : towerW * 0.42,
      );
    }
    const spireH = 12 * s;
    this._cone(parent, COL.terracotta, 0, towerH + spireH * 0.5 - 0.4, tz, towerW * 0.62, spireH, 4, 0, Math.PI / 4);
    // Golden finial ball + cross.
    const finialY = towerH + spireH - 0.4;
    this._sphere(parent, COL.gold, 0, finialY + 0.7 * s, tz, 0.75 * s, { metalness: 0.7, roughness: 0.35 });
    this._box(parent, COL.gold, 0, finialY + 2.9 * s, tz, 0.28 * s, 3.4 * s, 0.28 * s, 0, 0, 0, { metalness: 0.7, roughness: 0.35 });
    this._box(parent, COL.gold, 0, finialY + 3.6 * s, tz, 1.7 * s, 0.28 * s, 0.28 * s, 0, 0, 0, { metalness: 0.7, roughness: 0.35 });
  }

  // Multi-span arch viaduct / stone bridge: piers down to the valley floor, a
  // grand semicircular central arch of voussoirs, roadway deck and parapets.
  // Solkan (220 m, 36 m) and the Vipava H4 viaduct (340 m, 28 m).
  _buildBridge(parent, lm) {
    const length = lm.length || 220;
    const height = lm.height || 34;
    const deckW = 9.5 * Math.min(1.4, lm.scale);
    const deckY = height;
    const pierW = 4.6;
    const pierD = deckW * 0.72;
    const span = Math.min(length * 0.42, Math.max(28, height * 1.7));
    const archR = span * 0.5;

    // Deck + parapets + a pale roadway centre strip.
    this._box(parent, COL.concrete, 0, deckY, 0, length, 1.7, deckW);
    this._box(parent, COL.stone, 0, deckY + 1.45, 0, length, 0.25, deckW * 0.62);
    this._box(parent, COL.stone, 0, deckY + 1.4, deckW * 0.5 - 0.4, length, 1.3, 0.7);
    this._box(parent, COL.stone, 0, deckY + 1.4, -deckW * 0.5 + 0.4, length, 1.3, 0.7);

    // Piers: two flanking the central arch, plus extra spans outwards.
    const pierXs = [-length * 0.5 + 3, -span * 0.5, span * 0.5, length * 0.5 - 3];
    for (let x = -length * 0.5 + 3 + 52; x < -span * 0.5 - 30; x += 52) pierXs.push(x);
    for (let x = span * 0.5 + 52; x < length * 0.5 - 30; x += 52) pierXs.push(x);

    for (const px of pierXs) {
      this._foundation(parent, pierW + 1.5, pierD + 1.5, COL.concreteDark);
      this._box(parent, COL.stone, px, (height - 0.9) * 0.5, 0, pierW, height - 0.9, pierD);
      // Small cutwater taper at the base.
      this._box(parent, COL.concreteDark, px, 1.6, 0, pierW * 1.25, 3.2, pierD * 1.18);
    }

    // Grand central arch: voussoir blocks along a semicircle from spring to
    // spring, crown tucked right under the deck underside.
    const springY = height - 0.9 - archR;
    const voussoirs = Math.max(9, Math.round((Math.PI * archR) / 9));
    const seg = (Math.PI * archR) / voussoirs;
    for (let i = 0; i < voussoirs; i++) {
      const a = Math.PI - (i + 0.5) * (Math.PI / voussoirs);
      this._box(
        parent, COL.stone,
        Math.cos(a) * archR, springY + Math.sin(a) * archR, 0,
        seg * 1.16, 1.5, pierD * 0.9,
        0, 0, a - Math.PI / 2,
      );
    }
    // Spandrel infill above the arch haunches, so the opening reads as an arch.
    for (const side of [-1, 1]) {
      this._box(parent, COL.stone, side * (archR * 0.72 + span * 0.5), springY + archR * 0.86, 0,
        archR * 0.5, archR * 0.5, pierD * 0.9);
    }
  }

  // Massive sloped concrete dam (Solkan / Vogršček): gravity wall leaning
  // downstream, crest walkway with intake towers, and spillway chutes.
  _buildDam(parent, lm) {
    const length = lm.length || 180;
    const height = lm.height || 28;
    const baseThick = Math.max(9, height * 0.42);

    this._foundation(parent, length + 4, baseThick + 4, COL.concreteDark);
    // Gravity wall: a thick slab leaning ~8 degrees downstream (local -Z).
    this._box(
      parent, COL.concrete, 0, height * 0.5 + 0.6, 0,
      length, height * 1.04, baseThick,
      -0.14, 0, 0,
    );
    // Crest walkway.
    this._box(parent, COL.concreteDark, 0, height + 1.4, 0, length, 1.2, baseThick * 0.8);
    // Downstream toe buttress.
    this._box(parent, COL.concreteDark, 0, 1.4, -baseThick * 0.42, length * 0.99, 2.8, baseThick * 0.7);

    // Spillway chutes running down the downstream face.
    const chutes = 4;
    for (let i = 0; i < chutes; i++) {
      const cx = (i - (chutes - 1) * 0.5) * (length / (chutes + 1.4));
      this._box(parent, COL.steelDark, cx, height * 0.5 + 0.4, -baseThick * 0.46,
        length / (chutes + 1.4) * 0.42, height * 0.98, 1.4, -0.14, 0, 0);
      // Chute lip / stilling basin block at the toe.
      this._box(parent, COL.concreteDark, cx, 1.2, -baseThick * 0.72, length / (chutes + 1.4) * 0.5, 2.4, 3.2);
    }

    // Crest intake towers + gate blocks.
    const intakes = 3;
    for (let i = 0; i < intakes; i++) {
      const ix = (i - (intakes - 1) * 0.5) * (length * 0.26);
      this._box(parent, COL.concrete, ix, height + 3.4, 0, 7, 9.5, baseThick * 0.5);
      this._box(parent, COL.steelDark, ix, height + 8.4, 0, 8, 0.6, baseThick * 0.58);
    }
  }

  // Red-and-white striped broadcast mast with dish platforms and a blinking
  // red aviation strobe at the top (Nanos / Pleša is 95 m).
  _buildTower(parent, lm) {
    const height = lm.height || 90;
    const sections = Math.max(6, Math.min(16, Math.round(height / 8)));
    const segH = height / sections;
    const baseR = Math.max(1.4, height * 0.024);
    const topR = Math.max(0.55, baseR * 0.38);

    this._foundation(parent, baseR * 5, baseR * 5, COL.concreteDark);
    this._box(parent, COL.concrete, 0, 0.75, 0, baseR * 4.4, 1.5, baseR * 4.4);

    let y = 1.5;
    for (let i = 0; i < sections; i++) {
      const t0 = i / sections;
      const t1 = (i + 1) / sections;
      const r0 = baseR + (topR - baseR) * t0;
      const r1 = baseR + (topR - baseR) * t1;
      const color = i % 2 === 0 ? COL.white : COL.red;
      this._cyl(parent, color, 0, y + segH * 0.5, 0, (r0 + r1) * 0.5, segH + 0.05, 8);
      y += segH;
    }

    // Steel dish platforms + microwave drums.
    for (const frac of [0.42, 0.68]) {
      const py = height * frac;
      const pr = baseR * 2.6;
      this._cyl(parent, COL.steelDark, 0, py, 0, pr, 0.5, 8);
      for (let d = 0; d < 3; d++) {
        const a = (d / 3) * Math.PI * 2;
        this._box(parent, COL.steel, Math.cos(a) * pr * 0.7, py - 1.2, Math.sin(a) * pr * 0.7,
          2.4, 1.6, 0.5, 0, -a, 0);
      }
    }

    // Top mast cap + blinking red strobe beacon.
    this._cyl(parent, COL.steelDark, 0, height + 1.4, 0, topR * 1.5, 2.8, 8);
    const beaconMat = new THREE.MeshStandardMaterial({
      color: COL.beaconRed,
      emissive: COL.beaconRed,
      emissiveIntensity: 2.4,
      roughness: 0.35,
      metalness: 0.1,
      toneMapped: false,
    });
    beaconMat.color.convertSRGBToLinear();
    beaconMat.emissive.convertSRGBToLinear();
    const beacon = new THREE.Mesh(this._resources().sphere, beaconMat);
    beacon.position.set(0, height + 3.6, 0);
    beacon.scale.setScalar(1.6);
    parent.add(beacon);
    this._beacons.push({
      mesh: beacon,
      material: beaconMat,
      kind: 'aviation',
      phase: (lm.phase ?? lm.x * 0.013 + lm.z * 0.007) % (Math.PI * 2),
      speed: 4 + (Math.abs(lm.z) % 900) * 0.0012,
    });
  }

  // Limestone keep, crenellated curtain walls and round corner towers.
  // Gorizia, Predjama and Štanjel.
  _buildCastle(parent, lm) {
    const s = lm.scale;
    const yard = 32 * s;
    const wallH = 9 * s;
    const wallT = 2.6 * s;
    const keepW = 14 * s;
    const keepH = 20 * s;

    this._foundation(parent, yard + 10, yard + 10, COL.limestoneDark);
    this._box(parent, COL.stone, 0, 1.2, 0, yard + 6, 2.4, yard + 6);

    // Curtain walls (four sides) with crenellations along the top.
    this._box(parent, COL.stone, 0, wallH * 0.5 + 2.2, yard * 0.5, yard, wallH, wallT);
    this._box(parent, COL.stone, 0, wallH * 0.5 + 2.2, -yard * 0.5, yard, wallH, wallT);
    this._box(parent, COL.stone, yard * 0.5, wallH * 0.5 + 2.2, 0, wallT, wallH, yard);
    this._box(parent, COL.stone, -yard * 0.5, wallH * 0.5 + 2.2, 0, wallT, wallH, yard);

    const merlon = 2.4 * s;
    const step = merlon * 1.9;
    const topY = wallH + 2.2 + merlon * 0.5;
    const count = Math.floor(yard / step);
    for (let i = 0; i <= count; i++) {
      const t = (i / count - 0.5) * yard * 0.96;
      this._box(parent, COL.limestoneDark, t, topY, yard * 0.5, merlon, merlon, wallT * 1.05);
      this._box(parent, COL.limestoneDark, t, topY, -yard * 0.5, merlon, merlon, wallT * 1.05);
      this._box(parent, COL.limestoneDark, yard * 0.5, topY, t, wallT * 1.05, merlon, merlon);
      this._box(parent, COL.limestoneDark, -yard * 0.5, topY, t, wallT * 1.05, merlon, merlon);
    }

    // Central keep with a terracotta hipped roof and a small inner courtyard.
    this._box(parent, COL.limestone, 0, keepH * 0.5 + 2, 0, keepW, keepH, keepW);
    this._box(parent, COL.limestoneDark, 0, keepH + 2.4, 0, keepW * 1.08, 1.2, keepW * 1.08);
    this._gableRoof(parent, COL.terracotta, keepW * 1.06, keepW * 1.06, keepW * 0.42, keepH + 3);
    // Keep windows.
    for (let i = 0; i < 3; i++) {
      this._box(parent, COL.window, 0, keepH * (0.35 + i * 0.2) + 2, keepW * 0.5 + 0.1, 2.4, 2.6, 0.3);
    }

    // Round corner towers with conical roofs and crenellated galleries.
    const towers = [
      [1, 1], [-1, 1], [1, -1], [-1, -1],
    ];
    for (const [sx, sz] of towers) {
      const tx = sx * yard * 0.5;
      const tz = sz * yard * 0.5;
      const r = 5.4 * s;
      const th = wallH + 5 * s;
      this._cyl(parent, COL.stone, tx, th * 0.5 + 1, tz, r, th, 8);
      this._cyl(parent, COL.limestoneDark, tx, th + 1, tz, r * 1.14, 1.2, 8);
      this._cone(parent, COL.terracotta, tx, th + 4.2 * s, tz, r * 1.05, 6.4 * s, 8);
      for (let m = 0; m < 8; m++) {
        const a = (m / 8) * Math.PI * 2;
        this._box(parent, COL.limestoneDark,
          tx + Math.cos(a) * r * 0.92, th + 2.4 * s, tz + Math.sin(a) * r * 0.92,
          merlon * 0.8, merlon * 0.8, merlon * 0.8);
      }
    }
  }

  // Faro della Vittoria: fluted white monument column, lantern gallery and a
  // pulsing bright white beacon with an additive halo.
  _buildLighthouse(parent, lm) {
    const height = lm.height || 60;
    const shaftH = height * 0.78;
    const baseR = Math.max(2.2, height * 0.07);
    const topR = baseR * 0.62;

    this._foundation(parent, baseR * 5.5, baseR * 5.5, COL.stone);
    // Octagonal podium, then the fluted tapered shaft.
    this._cyl(parent, COL.stone, 0, 1.8, 0, baseR * 2.3, 3.6, 8);
    this._cyl(parent, COL.white, 0, shaftH * 0.5 + 2.6, 0, (baseR + topR) * 0.5, shaftH, 16);
    // Fluting ribs around the shaft.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r = baseR * 0.98;
      this._box(parent, COL.limestoneDark,
        Math.cos(a) * r, shaftH * 0.5 + 2.6, Math.sin(a) * r,
        0.4, shaftH * 0.96, 0.4, 0, -a, 0);
    }

    // Lantern gallery + cupola.
    const galleryY = shaftH + 3.4;
    this._cyl(parent, COL.stone, 0, galleryY, 0, topR * 2.3, 1.2, 16);
    this._cyl(parent, COL.limestoneDark, 0, galleryY + 1.5, 0, topR * 2.0, 1.6, 16);
    this._cyl(parent, COL.white, 0, galleryY + 3.4, 0, topR * 1.35, 3.8, 16);
    this._cone(parent, COL.steelDark, 0, galleryY + 6.2, 0, topR * 1.5, 2.2, 12);
    this._sphere(parent, COL.gold, 0, galleryY + 8.0, 0, 0.7, { metalness: 0.65, roughness: 0.35 });

    // Pulsing white beacon with an additive halo so it flashes for miles.
    const beaconMat = new THREE.MeshBasicMaterial({
      color: COL.beaconWhite,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
      depthWrite: false,
    });
    const beacon = new THREE.Mesh(this._resources().sphere, beaconMat);
    beacon.position.set(0, galleryY + 3.6, 0);
    beacon.scale.setScalar(1.7);
    parent.add(beacon);

    const haloMat = new THREE.MeshBasicMaterial({
      color: COL.beaconWhite,
      transparent: true,
      opacity: 0.15,
      toneMapped: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(this._resources().sphere, haloMat);
    halo.position.copy(beacon.position);
    halo.scale.setScalar(2.2);
    parent.add(halo);

    this._beacons.push({
      mesh: beacon,
      material: beaconMat,
      halo,
      kind: 'lighthouse',
      phase: (lm.phase ?? lm.x * 0.009 - lm.z * 0.005) % (Math.PI * 2),
      speed: 1.6,
    });
  }
}