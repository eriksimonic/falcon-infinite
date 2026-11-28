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
 * Sample ground elevation at landmark-local `(lx, lz)` relative to `lm.y`,
 * using Three.js's exact `rotation.y = lm.rot` world transform.
 */
function localGroundY(lm, heightAt, lx, lz) {
  const c = Math.cos(lm.rot || 0);
  const s = Math.sin(lm.rot || 0);
  const wx = lm.x + lx * c + lz * s;
  const wz = lm.z - lx * s + lz * c;
  const h = heightAt(wx, wz);
  return Number.isFinite(h) ? h - lm.y : 0;
}

/** Sample 4 corners + centre of a local footprint `(cx ± w/2, cz ± d/2)`. */
function footprintRange(lm, heightAt, cx, cz, w, d) {
  const hw = w * 0.5;
  const hd = d * 0.5;
  const h0 = localGroundY(lm, heightAt, cx - hw, cz - hd);
  const h1 = localGroundY(lm, heightAt, cx + hw, cz - hd);
  const h2 = localGroundY(lm, heightAt, cx - hw, cz + hd);
  const h3 = localGroundY(lm, heightAt, cx + hw, cz + hd);
  const centerY = localGroundY(lm, heightAt, cx, cz);
  return {
    minY: Math.min(h0, h1, h2, h3, centerY),
    maxY: Math.max(h0, h1, h2, h3, centerY),
    centerY,
  };
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
    // Night-only parts (facade washes, obstruction beacons, lighthouse beam).
    this._uplights = [];
    this._night = 0;
    this._time = 0;
    this.stats = { landmarks: 0, beacons: 0, uplights: 0, night: 0 };

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
      if (this.group) this._buildLandmark(lm, sample);
    }

    this.stats.landmarks = this.landmarks.length;
    this.stats.beacons = this._beacons.length;
    this.stats.uplights = this._uplights.length;
    this.stats.night = this._night;
    return this.landmarks.length;
  }

  /**
   * Set the dusk/night factor directly (0 = day, 1 = full night) and apply the
   * warm uplighting, obstruction beacons and lighthouse beam immediately.
   * `update(dt, night)` calls this for you.
   */
  setNight(night) {
    const n = Number(night);
    this._night = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    this._applyNight();
    return this._night;
  }

  /** Blink aviation strobes, pulse beacons and drive the night uplighting. */
  update(dt, night = null) {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this._time += step;

    for (const b of this._beacons) {
      if (b.kind === 'aviation') {
        // Hard red strobe: ~1 Hz on/off with a touch of rise/fall. At night it
        // swells and burns brighter so the Nanos mast is an unmistakable
        // valley-wide navigation marker.
        const phase = Math.sin(this._time * b.speed + b.phase);
        const on = phase > 0.15;
        b.mesh.visible = on;
        if (b.material) {
          b.material.emissiveIntensity = (on ? 2.6 : 0.05) * (1 + this._night * 1.3);
        }
        b.mesh.scale.setScalar((on ? 1.15 : 0.85) * (1 + this._night * 0.4));
      } else {
        // Lighthouse: slow white pulse with an expanding halo.
        const pulse = 0.5 + 0.5 * Math.sin(this._time * b.speed + b.phase);
        if (b.material) {
          b.material.opacity = Math.min(1, (0.35 + 0.6 * pulse) * (0.8 + 0.35 * this._night));
          if ('emissiveIntensity' in b.material) {
            b.material.emissiveIntensity = (0.6 + 2.4 * pulse) * (1 + this._night * 0.8);
          }
        }
        b.mesh.scale.setScalar((1 + 0.3 * pulse) * (1 + this._night * 0.5));
        if (b.halo) {
          b.halo.scale.setScalar((1.4 + 1.5 * pulse) * (1 + this._night * 0.6));
          if (b.halo.material) {
            b.halo.material.opacity = (0.05 + 0.28 * pulse) * (0.9 + this._night * 0.9);
          }
        }
      }
    }

    if (night !== null && night !== undefined) {
      const n = Number(night);
      this._night = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    }
    this._applyNight();
  }

  /**
   * Apply the current `_night` value to every night-only part. Below 0.15
   * (daytime) everything is hidden, so the added geometry costs no draw calls.
   */
  _applyNight() {
    const n = this._night;
    const active = n > 0.15;
    this.stats.night = n;
    for (const u of this._uplights) {
      if (u.kind === 'beam') {
        // Rotating white lighthouse beam sweeping the Gulf of Trieste.
        u.mesh.rotation.y = this._time * 0.9;
        u.material.opacity = active ? 0.08 + 0.30 * n : 0;
        u.mesh.visible = u.material.opacity > 0.002;
        continue;
      }
      if (u.kind === 'obstruction') {
        const pulse = 0.5 + 0.5 * Math.sin(this._time * u.speed + u.phase);
        const on = active && pulse > 0.2;
        u.material.opacity = on ? 0.35 + 0.65 * pulse : 0;
        u.mesh.visible = on;
        continue;
      }
      // Warm stone wash: emissive gold scaled by night * 0.45.
      u.material.opacity = active ? u.strength * n * 0.45 : 0;
      u.mesh.visible = u.material.opacity > 0.002;
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
    // Night washes / obstruction beacons / lighthouse beams own their materials
    // too (each fades independently), so release them here as well.
    for (const u of this._uplights) u.material?.dispose();
    this._uplights.length = 0;
    for (const material of this._materials.values()) material.dispose();
    this._materials.clear();
    this._beacons.length = 0;
    this.landmarks = [];
    this.stats.landmarks = 0;
    this.stats.beacons = 0;
    this.stats.uplights = 0;
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

  /**
   * Landmark parts never move after construction, so their local matrix is
   * composed once here instead of being recomposed every frame by
   * `scene.updateMatrixWorld()`. `updateMatrix()` also flags `matrixWorld` as
   * dirty, and `_buildLandmark()` refreshes the whole subtree once the parent
   * chain is final so `Box3.setFromObject` stays exact.
   */
  _freeze(mesh) {
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  /** Box part: unit cube scaled to (w, h, d), centred on (x, y, z). */
  _box(parent, color, x, y, z, w, h, d, rx = 0, ry = 0, rz = 0, opts) {
    const mesh = new THREE.Mesh(this._resources().box, this._mat(color, opts));
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.scale.set(w, h, d);
    // Under 2 m a part is smaller than a couple of shadow-map texels
    // (1.37 m each at 2048² over the ±1.4 km sun box), so keeping it out of the
    // shadow pass costs nothing visible and saves a draw call per part.
    mesh.castShadow = Math.max(w, h, d) >= 2;
    mesh.receiveShadow = true;
    this._freeze(mesh);
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
    mesh.castShadow = Math.max(radius * 2, h) >= 2;
    mesh.receiveShadow = true;
    this._freeze(mesh);
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
    mesh.castShadow = Math.max(radius * 2, h) >= 2;
    mesh.receiveShadow = true;
    this._freeze(mesh);
    parent.add(mesh);
    return mesh;
  }

  /** Sphere part (finials, beacons). */
  _sphere(parent, color, x, y, z, radius, opts) {
    const mesh = new THREE.Mesh(this._resources().sphere, this._mat(color, opts));
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(radius * 2);
    this._freeze(mesh);
    parent.add(mesh);
    return mesh;
  }

  /** Foundation skirt anchored at local `(x, z)` from `bottomY` to `topY`. */
  _foundation(parent, w, d, color = COL.stone, x = 0, z = 0, topY = FOUNDATION_TOP, bottomY = -FOUNDATION_DEPTH) {
    const h = Math.max(1.0, topY - bottomY);
    return this._box(parent, color, x, bottomY + h * 0.5, z, w, h, d);
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
  _buildLandmark(lm, heightAt = terrainHeight) {
    const sample = typeof heightAt === 'function' ? heightAt : terrainHeight;
    const obj = new THREE.Group();
    obj.name = `landmark:${lm.id}`;
    obj.position.set(lm.x, lm.y, lm.z);
    obj.rotation.y = lm.rot || 0;
    obj.userData.landmark = lm;

    switch (lm.kind) {
      case 'bridge': this._buildBridge(obj, lm, sample); break;
      case 'dam': this._buildDam(obj, lm, sample); break;
      case 'tower': this._buildTower(obj, lm, sample); break;
      case 'castle': this._buildCastle(obj, lm, sample); break;
      case 'lighthouse': this._buildLighthouse(obj, lm, sample); break;
      case 'church':
      default: this._buildChurch(obj, lm, sample); break;
    }

    lm.object = obj;
    if (this.group) this._addNightGlow(obj, lm);
    this.group.add(obj);
    // Every grounding, deck-pitch, position, rotation and scale write is done
    // by now, so refresh the subtree once (forced) and leave `matrixWorld`
    // exact for `Box3.setFromObject` and the grounding audit. Animated parts
    // (beacons, lighthouse beam, night washes) keep `matrixAutoUpdate` on.
    obj.updateMatrixWorld(true);
    return obj;
  }

  /**
   * Night-only dressing for one landmark: a warm gold facade wash (churches,
   * castles, the Solkan arches), red obstruction beacons on the Nanos mast and
   * a rotating white beam on the Trieste lighthouse. Everything is created at
   * opacity 0 and only switched on by `_applyNight()` after dusk, so daytime
   * frames pay nothing.
   */
  _addNightGlow(parent, lm) {
    // Shared unit cube, scaled per part; no per-landmark geometry to free.
    const boxGeo = this._resources().box;
    const meta = lm._groundMeta || {};
    const baseY = Number.isFinite(meta.baseY) ? meta.baseY : 0;

    const addWash = (x, y, z, w, h, d, strength) => {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffb860,
        transparent: true,
        opacity: 0,
        toneMapped: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(boxGeo, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(w, h, d);
      mesh.visible = false;
      mesh.renderOrder = 3;
      parent.add(mesh);
      this._uplights.push({ kind: 'wash', mesh, material, strength });
      return mesh;
    };

    const addObstruction = (y, radius, phase) => {
      const material = new THREE.MeshBasicMaterial({
        color: COL.beaconRed,
        toneMapped: false,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this._resources().sphere, material);
      mesh.position.set(0, y, 0);
      mesh.scale.setScalar(radius);
      mesh.visible = false;
      parent.add(mesh);
      this._uplights.push({ kind: 'obstruction', mesh, material, phase, speed: 2.4 });
    };

    switch (lm.kind) {
      case 'church': {
        // Sveta Gora / Kostanjevica: warm wash up the nave walls and campanile.
        const s = lm.scale;
        const naveW = 15 * s;
        const naveH = 11 * s;
        const naveD = 28 * s;
        const towerW = 7 * s;
        const towerH = 30 * s;
        const tz = -naveD * 0.5 - towerW * 0.5 - 1;
        addWash(0, baseY + naveH * 0.42 + 1, 0, naveW + 1.6, naveH * 0.72, naveD + 1.6, 1.0);
        addWash(0, baseY + towerH * 0.45, tz, towerW + 1.4, towerH * 0.8, towerW + 1.4, 0.75);
        break;
      }
      case 'castle': {
        // Gorizia / Predjama / Štanjel: curtain walls plus the central keep.
        const s = lm.scale;
        const yard = 32 * s;
        const wallH = 9 * s;
        const keepW = 14 * s;
        const keepH = 20 * s;
        addWash(0, baseY + (wallH + 2.2) * 0.5, 0, yard + 7, wallH + 2, yard + 7, 0.6);
        addWash(0, baseY + keepH * 0.5 + 2, 0, keepW + 2, keepH * 0.8, keepW + 2, 1.0);
        break;
      }
      case 'bridge': {
        // Solkan arch span: a small highlight tucked under the central arch so
        // the voussoirs read at night without washing the gorge in orange.
        const length = lm.length || 220;
        const height = lm.height || 34;
        const deckW = 9.5 * Math.min(1.4, lm.scale);
        const deckMidY = Number.isFinite(meta.deckMidY) ? meta.deckMidY : height;
        const washH = Math.max(4, Math.min(height * 0.24, 8));
        addWash(0, deckMidY - washH * 0.6, 0, length * 0.38, washH, deckW * 0.42, 0.25);
        break;
      }
      case 'tower': {
        // Nanos / Pleša: red obstruction beacons at two thirds and the top.
        const height = lm.height || 90;
        const phase = lm.phase ?? lm.x * 0.013 + lm.z * 0.007;
        addObstruction(baseY + height * 0.66, 1.15, phase);
        addObstruction(baseY + height * 0.99, 0.95, phase + 1.7);
        break;
      }
      case 'lighthouse': {
        // Faro della Vittoria: a long rotating white beam at lantern height.
        const height = lm.height || 60;
        const shaftH = height * 0.78;
        const galleryY = baseY + shaftH + 3.4;
        const material = new THREE.MeshBasicMaterial({
          color: COL.beaconWhite,
          transparent: true,
          opacity: 0,
          toneMapped: false,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Mesh(boxGeo, material);
        mesh.position.set(0, galleryY + 3.6, 0);
        mesh.scale.set(height * 2.4, 1.4, 3.2);
        mesh.visible = false;
        parent.add(mesh);
        this._uplights.push({ kind: 'beam', mesh, material });
        break;
      }
      default:
        break;
    }
  }

  // White Karst limestone nave, terracotta gable roof, tall campanile with a
  // tapered spire and a golden finial cross. Both nave and campanile are
  // individually corner-grounded so hilltop basilicas never float or bury.
  _buildChurch(parent, lm, heightAt = terrainHeight) {
    const s = lm.scale;
    const naveW = 15 * s;
    const naveH = 11 * s;
    const naveD = 28 * s;
    const roofRise = naveW * 0.34;
    const towerW = 7 * s;
    const towerH = 30 * s;
    const tz = -naveD * 0.5 - towerW * 0.5 - 1;

    const naveRange = footprintRange(lm, heightAt, 0, 0, naveW + 4, naveD + 4);
    const towerRange = footprintRange(lm, heightAt, 0, tz, towerW + 3, towerW + 3);
    const baseY = Math.max(0, naveRange.maxY - 1.5);

    this._foundation(parent, naveW + 5, naveD + 5, COL.limestoneDark, 0, 0, baseY + 0.8, naveRange.minY - 6.0);
    this._box(parent, COL.limestoneDark, 0, baseY + 0.45, 0, naveW + 2.4, 1.5, naveD + 2.4);
    this._box(parent, COL.limestone, 0, baseY + naveH * 0.5 + 1, 0, naveW, naveH, naveD);
    this._gableRoof(parent, COL.terracotta, naveW + 0.8, naveD + 1.2, roofRise, baseY + naveH + 1);

    // Apse at the liturgical east end.
    this._cyl(parent, COL.limestone, 0, baseY + naveH * 0.42 + 1, naveD * 0.5 + 1.5, naveW * 0.32, naveH * 0.8, 8);
    this._cone(parent, COL.terracotta, 0, baseY + naveH * 0.86 + 1, naveD * 0.5 + 1.5, naveW * 0.36, roofRise * 0.8, 8);

    // Front portal + a row of dark arched windows along both long walls.
    this._box(parent, COL.window, 0, baseY + 3.1 * s + 1, naveD * 0.5 + 0.12, 3.2 * s, 4.6 * s, 0.3);
    for (let i = -1; i <= 1; i++) {
      this._box(parent, COL.window, naveW * 0.5 + 0.1, baseY + naveH * 0.62 + 1, i * 8 * s, 0.25, 3.4 * s, 1.5 * s);
      this._box(parent, COL.window, -naveW * 0.5 - 0.1, baseY + naveH * 0.62 + 1, i * 8 * s, 0.25, 3.4 * s, 1.5 * s);
    }

    // Campanile: independently anchored at (0, tz) down to its own corners.
    this._foundation(parent, towerW + 3, towerW + 3, COL.limestoneDark, 0, tz, baseY + 0.8, towerRange.minY - 6.0);
    this._box(parent, COL.limestone, 0, baseY + towerH * 0.5, tz, towerW, towerH, towerW);
    this._box(parent, COL.limestoneDark, 0, baseY + towerH * 0.86, tz, towerW * 1.06, 1.2 * s, towerW * 1.06);
    // Belfry openings on all four faces.
    for (let f = 0; f < 4; f++) {
      const a = (f * Math.PI) / 2;
      this._box(
        parent, COL.window,
        Math.sin(a) * towerW * 0.5, baseY + towerH * 0.74, tz + Math.cos(a) * towerW * 0.5,
        Math.abs(Math.sin(a)) > 0.5 ? 0.3 : towerW * 0.42,
        6 * s,
        Math.abs(Math.cos(a)) > 0.5 ? 0.3 : towerW * 0.42,
      );
    }
    const spireH = 12 * s;
    this._cone(parent, COL.terracotta, 0, baseY + towerH + spireH * 0.5 - 0.4, tz, towerW * 0.62, spireH, 4, 0, Math.PI / 4);
    // Golden finial ball + cross.
    const finialY = baseY + towerH + spireH - 0.4;
    this._sphere(parent, COL.gold, 0, finialY + 0.7 * s, tz, 0.75 * s, { metalness: 0.7, roughness: 0.35 });
    this._box(parent, COL.gold, 0, finialY + 2.9 * s, tz, 0.28 * s, 3.4 * s, 0.28 * s, 0, 0, 0, { metalness: 0.7, roughness: 0.35 });
    this._box(parent, COL.gold, 0, finialY + 3.6 * s, tz, 1.7 * s, 0.28 * s, 0.28 * s, 0, 0, 0, { metalness: 0.7, roughness: 0.35 });

    lm._groundMeta = { baseY, naveRange, towerRange };
  }

  // Terrain-conforming multi-span arch viaduct / stone bridge: samples both
  // banks and the valley floor, caps deck grade at 8%, never buries the road,
  // and independently roots every pier deep into its own local ground.
  _buildBridge(parent, lm, heightAt = terrainHeight) {
    const length = lm.length || 220;
    const height = lm.height || 34;
    const deckW = 9.5 * Math.min(1.4, lm.scale);
    const pierW = 4.6;
    const pierD = deckW * 0.72;
    const span = Math.min(length * 0.42, Math.max(28, height * 1.7));
    const archR = span * 0.5;

    // Sample terrain profile across the entire bridge span.
    const sampleTs = [-0.5, -0.35, -0.2, 0, 0.2, 0.35, 0.5];
    const samples = sampleTs.map((t) => {
      const lx = t * length;
      return { t, lx, g: localGroundY(lm, heightAt, lx, 0) };
    });
    const yStart = samples[0].g;
    const yEnd = samples[samples.length - 1].g;
    let yMinSpan = Infinity;
    let yMaxSpan = -Infinity;
    for (let i = 0; i < samples.length; i++) {
      const g = samples[i].g;
      if (g > yMaxSpan) yMaxSpan = g;
      if (i > 0 && i < samples.length - 1 && g < yMinSpan) yMinSpan = g;
    }
    if (!Number.isFinite(yMinSpan)) yMinSpan = Math.min(yStart, yEnd);

    // Bank-to-bank deck elevation with max 8% bridge grade and guaranteed
    // clearance over both the gorge floor and any intermediate terrain crest.
    let deckA = Math.max(yStart + 1.2, yMinSpan + Math.min(height, 18));
    let deckB = Math.max(yEnd + 1.2, yMinSpan + Math.min(height, 18));
    const maxGradeDelta = length * 0.08;
    if (deckA < deckB - maxGradeDelta) deckA = deckB - maxGradeDelta;
    else if (deckB < deckA - maxGradeDelta) deckB = deckA - maxGradeDelta;

    const minInteriorDeck = Math.max(yMaxSpan + 0.8, yMinSpan + Math.min(height, 26));
    const deckYRaw = (lx) => deckA + (deckB - deckA) * ((lx + length * 0.5) / length);
    let lift = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const need = (i === 0 || i === samples.length - 1)
        ? Math.max(s.g + 1.2, minInteriorDeck - maxGradeDelta)
        : Math.max(s.g + 1.2, minInteriorDeck);
      const cur = deckYRaw(s.lx);
      if (need > cur) lift = Math.max(lift, need - cur);
    }
    deckA += lift;
    deckB += lift;

    const deckYAt = (lx) => deckA + (deckB - deckA) * ((lx + length * 0.5) / length);
    const deckMidY = (deckA + deckB) * 0.5;
    const deckPitch = Math.atan2(deckB - deckA, length);
    const deckLen = Math.hypot(length, deckB - deckA);

    // Sloped deck assembly (deck slab, pale roadway strip, side parapets).
    const deckGroup = new THREE.Group();
    deckGroup.position.set(0, deckMidY, 0);
    deckGroup.rotation.z = deckPitch;
    parent.add(deckGroup);
    this._box(deckGroup, COL.concrete, 0, 0, 0, deckLen, 1.7, deckW);
    this._box(deckGroup, COL.stone, 0, 0.98, 0, deckLen, 0.25, deckW * 0.62);
    this._box(deckGroup, COL.stone, 0, 1.4, deckW * 0.5 - 0.4, deckLen, 1.3, 0.7);
    this._box(deckGroup, COL.stone, 0, 1.4, -deckW * 0.5 + 0.4, deckLen, 1.3, 0.7);

    // Piers: two flanking the central arch, plus extra spans outwards.
    const pierXs = [-length * 0.5 + 3, -span * 0.5, span * 0.5, length * 0.5 - 3];
    for (let x = -length * 0.5 + 3 + 52; x < -span * 0.5 - 30; x += 52) pierXs.push(x);
    for (let x = span * 0.5 + 52; x < length * 0.5 - 30; x += 52) pierXs.push(x);
    pierXs.sort((a, b) => a - b);

    const pierGrounds = [];
    for (const px of pierXs) {
      const gPier = Math.min(
        localGroundY(lm, heightAt, px, -pierD * 0.5),
        localGroundY(lm, heightAt, px, 0),
        localGroundY(lm, heightAt, px, pierD * 0.5),
      );
      const pierDeckY = deckYAt(px);
      const pierTop = pierDeckY - 0.8;
      const pierBot = gPier - 6.0;
      const pierH = Math.max(2.0, pierTop - pierBot);

      // Deep footing anchored at `(px, 0)` (never hardcoded at origin!).
      this._foundation(parent, pierW + 1.5, pierD + 1.5, COL.concreteDark, px, 0, gPier + 0.6, pierBot);
      this._box(parent, COL.stone, px, pierBot + pierH * 0.5, 0, pierW, pierH, pierD);
      // Cutwater collar seated right at the local pier ground.
      this._box(parent, COL.concreteDark, px, gPier + 1.0, 0, pierW * 1.25, 3.2, pierD * 1.18);

      pierGrounds.push({ px, gPier, pierBot, pierTop, deckY: pierDeckY });
    }

    // Grand central arch: voussoir blocks springing cleanly from the two
    // central flanking piers right below the deck underside.
    const deckCenterY = deckYAt(0);
    const gLeftPier = localGroundY(lm, heightAt, -archR, 0);
    const gRightPier = localGroundY(lm, heightAt, archR, 0);
    const archRise = Math.min(archR, Math.max(6.0, deckCenterY - Math.min(gLeftPier, gRightPier) - 1.5));
    const springY = deckCenterY - 0.9 - archRise;
    const voussoirs = Math.max(9, Math.round((Math.PI * archR) / 9));
    const seg = (Math.PI * archR) / voussoirs;
    for (let i = 0; i < voussoirs; i++) {
      const a = Math.PI - (i + 0.5) * (Math.PI / voussoirs);
      const vx = Math.cos(a) * archR;
      const vy = springY + Math.sin(a) * archRise;
      const dx = -Math.sin(a) * archR;
      const dy = Math.cos(a) * archRise;
      const tilt = Math.atan2(dy, dx);
      this._box(
        parent, COL.stone,
        vx, vy, 0,
        seg * 1.18, 1.5, pierD * 0.9,
        0, 0, tilt,
      );
    }
    // Spandrel infill walls between the arch haunches and the deck underside.
    for (const side of [-1, 1]) {
      const sx = side * archR * 0.72;
      const haunchY = springY + archRise * 0.68;
      const topUnder = deckYAt(sx) - 0.85;
      const spH = Math.max(1.2, topUnder - haunchY);
      this._box(parent, COL.stone, sx, haunchY + spH * 0.5, 0, archR * 0.46, spH, pierD * 0.88);
    }

    lm._groundMeta = { deckA, deckB, deckMidY, pierGrounds };
  }

  // Canyon-anchored concrete gravity dam (Solkan / Vogršček): samples the
  // entire dam axis so neither wing floats nor sinks below the canyon floor.
  _buildDam(parent, lm, heightAt = terrainHeight) {
    const length = lm.length || 180;
    const height = lm.height || 28;
    const baseThick = Math.max(9, height * 0.42);

    let minY = Infinity;
    let maxY = -Infinity;
    for (const t of [-0.5, -0.25, 0, 0.25, 0.5]) {
      const lx = t * length;
      for (const lz of [-baseThick * 0.5, 0, baseThick * 0.5]) {
        const g = localGroundY(lm, heightAt, lx, lz);
        if (g < minY) minY = g;
        if (g > maxY) maxY = g;
      }
    }
    const crestY = Math.max(height, maxY + 2.0);
    const botY = minY - 6.0;
    const wallH = Math.max(4.0, crestY - botY);

    this._foundation(parent, length + 4, baseThick + 4, COL.concreteDark, 0, 0, minY + 1.0, botY);
    // Gravity wall leaning ~8 degrees downstream (local -Z).
    this._box(
      parent, COL.concrete, 0, botY + wallH * 0.5, 0,
      length, wallH * 1.02, baseThick,
      -0.14, 0, 0,
    );
    // Crest walkway.
    this._box(parent, COL.concreteDark, 0, crestY + 0.6, 0, length, 1.2, baseThick * 0.8);
    // Downstream toe buttress rooted down to `botY`.
    const toeTop = minY + 3.2;
    const toeH = Math.max(2.8, toeTop - botY);
    this._box(parent, COL.concreteDark, 0, botY + toeH * 0.5, -baseThick * 0.42, length * 0.99, toeH, baseThick * 0.7);

    // Spillway chutes running down the downstream face.
    const chutes = 4;
    for (let i = 0; i < chutes; i++) {
      const cx = (i - (chutes - 1) * 0.5) * (length / (chutes + 1.4));
      this._box(parent, COL.steelDark, cx, botY + wallH * 0.5, -baseThick * 0.46,
        (length / (chutes + 1.4)) * 0.42, wallH * 0.96, 1.4, -0.14, 0, 0);
      // Chute lip / stilling basin block at the toe.
      this._box(parent, COL.concreteDark, cx, botY + toeH * 0.5, -baseThick * 0.72,
        (length / (chutes + 1.4)) * 0.5, toeH * 0.85, 3.2);
    }

    // Crest intake towers + gate blocks.
    const intakes = 3;
    for (let i = 0; i < intakes; i++) {
      const ix = (i - (intakes - 1) * 0.5) * (length * 0.26);
      this._box(parent, COL.concrete, ix, crestY + 2.6, 0, 7, 9.5, baseThick * 0.5);
      this._box(parent, COL.steelDark, ix, crestY + 7.6, 0, 8, 0.6, baseThick * 0.58);
    }

    lm._groundMeta = { botY, crestY, minY, maxY };
  }

  // Red-and-white striped broadcast mast with dish platforms and a blinking
  // red aviation strobe at the top (Nanos / Pleša is 95 m).
  _buildTower(parent, lm, heightAt = terrainHeight) {
    const height = lm.height || 90;
    const sections = Math.max(6, Math.min(16, Math.round(height / 8)));
    const segH = height / sections;
    const baseR = Math.max(1.4, height * 0.024);
    const topR = Math.max(0.55, baseR * 0.38);

    const padRange = footprintRange(lm, heightAt, 0, 0, baseR * 5, baseR * 5);
    const baseY = Math.max(0, padRange.maxY - 0.5);

    this._foundation(parent, baseR * 5, baseR * 5, COL.concreteDark, 0, 0, baseY + 0.8, padRange.minY - 6.0);
    this._box(parent, COL.concrete, 0, baseY + 0.75, 0, baseR * 4.4, 1.5, baseR * 4.4);

    let y = baseY + 1.5;
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
      const py = baseY + height * frac;
      const pr = baseR * 2.6;
      this._cyl(parent, COL.steelDark, 0, py, 0, pr, 0.5, 8);
      for (let d = 0; d < 3; d++) {
        const a = (d / 3) * Math.PI * 2;
        this._box(parent, COL.steel, Math.cos(a) * pr * 0.7, py - 1.2, Math.sin(a) * pr * 0.7,
          2.4, 1.6, 0.5, 0, -a, 0);
      }
    }

    // Top mast cap + blinking red strobe beacon.
    this._cyl(parent, COL.steelDark, 0, baseY + height + 1.4, 0, topR * 1.5, 2.8, 8);
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
    beacon.position.set(0, baseY + height + 3.6, 0);
    beacon.scale.setScalar(1.6);
    parent.add(beacon);
    this._beacons.push({
      mesh: beacon,
      material: beaconMat,
      kind: 'aviation',
      phase: (lm.phase ?? lm.x * 0.013 + lm.z * 0.007) % (Math.PI * 2),
      speed: 4 + (Math.abs(lm.z) % 900) * 0.0012,
    });

    lm._groundMeta = { baseY, padRange };
  }

  // Limestone keep, crenellated curtain walls and round corner towers.
  // Curtain wall plinth & every corner tower independently reach below ground.
  _buildCastle(parent, lm, heightAt = terrainHeight) {
    const s = lm.scale;
    const yard = 32 * s;
    const wallH = 9 * s;
    const wallT = 2.6 * s;
    const keepW = 14 * s;
    const keepH = 20 * s;

    const castRange = footprintRange(lm, heightAt, 0, 0, yard + 10, yard + 10);
    const baseY = Math.max(0, castRange.maxY - 2.0);

    this._foundation(parent, yard + 10, yard + 10, COL.limestoneDark, 0, 0, baseY + 1.2, castRange.minY - 6.0);
    this._box(parent, COL.stone, 0, baseY + 1.2, 0, yard + 6, 2.4, yard + 6);

    // Curtain walls (four sides) with crenellations along the top.
    this._box(parent, COL.stone, 0, baseY + wallH * 0.5 + 2.2, yard * 0.5, yard, wallH, wallT);
    this._box(parent, COL.stone, 0, baseY + wallH * 0.5 + 2.2, -yard * 0.5, yard, wallH, wallT);
    this._box(parent, COL.stone, yard * 0.5, baseY + wallH * 0.5 + 2.2, 0, wallT, wallH, yard);
    this._box(parent, COL.stone, -yard * 0.5, baseY + wallH * 0.5 + 2.2, 0, wallT, wallH, yard);

    const merlon = 2.4 * s;
    const step = merlon * 1.9;
    const topY = baseY + wallH + 2.2 + merlon * 0.5;
    const count = Math.floor(yard / step);
    for (let i = 0; i <= count; i++) {
      const t = (i / count - 0.5) * yard * 0.96;
      this._box(parent, COL.limestoneDark, t, topY, yard * 0.5, merlon, merlon, wallT * 1.05);
      this._box(parent, COL.limestoneDark, t, topY, -yard * 0.5, merlon, merlon, wallT * 1.05);
      this._box(parent, COL.limestoneDark, yard * 0.5, topY, t, wallT * 1.05, merlon, merlon);
      this._box(parent, COL.limestoneDark, -yard * 0.5, topY, t, wallT * 1.05, merlon, merlon);
    }

    // Central keep with a terracotta hipped roof and a small inner courtyard.
    this._box(parent, COL.limestone, 0, baseY + keepH * 0.5 + 2, 0, keepW, keepH, keepW);
    this._box(parent, COL.limestoneDark, 0, baseY + keepH + 2.4, 0, keepW * 1.08, 1.2, keepW * 1.08);
    this._gableRoof(parent, COL.terracotta, keepW * 1.06, keepW * 1.06, keepW * 0.42, baseY + keepH + 3);
    // Keep windows.
    for (let i = 0; i < 3; i++) {
      this._box(parent, COL.window, 0, baseY + keepH * (0.35 + i * 0.2) + 2, keepW * 0.5 + 0.1, 2.4, 2.6, 0.3);
    }

    // Round corner towers: each tower's base extends down to its own local ground - 6 m.
    const towers = [
      [1, 1], [-1, 1], [1, -1], [-1, -1],
    ];
    for (const [sx, sz] of towers) {
      const tx = sx * yard * 0.5;
      const tz = sz * yard * 0.5;
      const r = 5.4 * s;
      const towerTop = baseY + wallH + 5 * s + 1;
      const tRange = footprintRange(lm, heightAt, tx, tz, r * 2.2, r * 2.2);
      const tBot = tRange.minY - 6.0;
      const th = Math.max(wallH + 5 * s, towerTop - tBot);
      this._cyl(parent, COL.stone, tx, tBot + th * 0.5, tz, r, th, 8);
      this._cyl(parent, COL.limestoneDark, tx, towerTop, tz, r * 1.14, 1.2, 8);
      this._cone(parent, COL.terracotta, tx, towerTop + 3.2 * s, tz, r * 1.05, 6.4 * s, 8);
      for (let m = 0; m < 8; m++) {
        const a = (m / 8) * Math.PI * 2;
        this._box(parent, COL.limestoneDark,
          tx + Math.cos(a) * r * 0.92, towerTop + 1.4 * s, tz + Math.sin(a) * r * 0.92,
          merlon * 0.8, merlon * 0.8, merlon * 0.8);
      }
    }

    lm._groundMeta = { baseY, castRange };
  }

  // Faro della Vittoria: fluted white monument column, lantern gallery and a
  // pulsing bright white beacon with an additive halo.
  _buildLighthouse(parent, lm, heightAt = terrainHeight) {
    const height = lm.height || 60;
    const shaftH = height * 0.78;
    const baseR = Math.max(2.2, height * 0.07);
    const topR = baseR * 0.62;

    const padRange = footprintRange(lm, heightAt, 0, 0, baseR * 5.5, baseR * 5.5);
    const baseY = Math.max(0, padRange.maxY - 0.5);

    this._foundation(parent, baseR * 5.5, baseR * 5.5, COL.stone, 0, 0, baseY + 0.8, padRange.minY - 6.0);
    // Octagonal podium, then the fluted tapered shaft.
    this._cyl(parent, COL.stone, 0, baseY + 1.8, 0, baseR * 2.3, 3.6, 8);
    this._cyl(parent, COL.white, 0, baseY + shaftH * 0.5 + 2.6, 0, (baseR + topR) * 0.5, shaftH, 16);
    // Fluting ribs around the shaft.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r = baseR * 0.98;
      this._box(parent, COL.limestoneDark,
        Math.cos(a) * r, baseY + shaftH * 0.5 + 2.6, Math.sin(a) * r,
        0.4, shaftH * 0.96, 0.4, 0, -a, 0);
    }

    // Lantern gallery + cupola.
    const galleryY = baseY + shaftH + 3.4;
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

    lm._groundMeta = { baseY, padRange };
  }
}