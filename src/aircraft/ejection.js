// ACES II ejection sequence: canopy jettison, rocket seat boost, stabilised
// parachute descent and clean touchdown on the analytic terrain.
//
// Pure simulation state always advances, whether or not `scene` is provided;
// the procedural seat/pilot, canopy frame and striped chute dome are only
// built when a scene exists, so headless tests can run without WebGL.
import * as THREE from 'three';
import { clamp, smoothstep } from '../world/noise.js';

const G = 9.80665;
const ROCKET_TIME = 0.55;      // s of rocket burn
const ROCKET_ACCEL = 55;       // m/s^2 upward thrust
const SEAT_UP_SPEED = 38;      // m/s initial local-up launch speed
const CANOPY_UP_SPEED = 16;    // m/s local-up jettison speed
const CANOPY_AFT_SPEED = 12;   // m/s local-aft jettison speed
const CHUTE_DELAY = 1.2;       // s after trigger before the canopy inflates
const CHUTE_OPEN_TIME = 1.6;   // s for the canopy to inflate smoothly
const CHUTE_SINK = -5.5;       // m/s stabilised descent rate
const GROUND_CLEARANCE = 1.0;  // seat origin height above terrain when landed

const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _identity = new THREE.Quaternion();

function heightAt(world, x, z) {
  if (world && typeof world.heightAt === 'function') return world.heightAt(x, z);
  return 0;
}

export class EjectionSystem {
  constructor(scene = null) {
    this.scene = scene || null;

    this.active = false;
    this.phase = 'NONE';
    this.seatPos = new THREE.Vector3();
    this.seatVel = new THREE.Vector3();
    this.canopyPos = new THREE.Vector3();
    this.canopyVel = new THREE.Vector3();
    this.timer = 0;

    // Camera rig consumed by the app: smoothly tracks the descending pilot.
    this.cameraPos = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();

    this.chuteOpen = 0;
    this._canopyLanded = false;
    this._group = null;
    this._seatGroup = null;
    this._canopyMesh = null;
    this._chuteGroup = null;
  }

  /** Deactivate the sequence and remove every procedural mesh. */
  reset() {
    this.active = false;
    this.phase = 'NONE';
    this.timer = 0;
    this.chuteOpen = 0;
    this._canopyLanded = false;

    this.seatPos.set(0, 0, 0);
    this.seatVel.set(0, 0, 0);
    this.canopyPos.set(0, 0, 0);
    this.canopyVel.set(0, 0, 0);
    this.cameraPos.set(0, 0, 0);
    this.lookAt.set(0, 0, 0);

    if (this._group) {
      if (this.scene) this.scene.remove(this._group);
      this._dispose(this._group);
      this._group = null;
      this._seatGroup = null;
      this._canopyMesh = null;
      this._chuteGroup = null;
    }
  }

  /**
   * Fire the seat from a flight model. Returns true when newly triggered,
   * false when a sequence is already running.
   */
  trigger(flight) {
    if (this.active) return false;

    const pos = flight && flight.position ? flight.position : _zero;
    const vel = flight && flight.velocity ? flight.velocity : _zero;
    const q = flight && flight.quaternion ? flight.quaternion : _identity;

    _up.set(0, 1, 0).applyQuaternion(q);
    _fwd.set(0, 0, -1).applyQuaternion(q);

    this.seatPos.copy(pos);
    this.seatVel.copy(vel).addScaledVector(_up, SEAT_UP_SPEED);

    this.canopyPos.copy(pos);
    this.canopyVel.copy(vel)
      .addScaledVector(_up, CANOPY_UP_SPEED)
      .addScaledVector(_fwd, -CANOPY_AFT_SPEED);

    this.timer = 0;
    this.chuteOpen = 0;
    this._canopyLanded = false;
    this.phase = 'ROCKET';
    this.active = true;

    this._build();
    this._updateCamera();
    this._syncVisuals();
    return true;
  }

  /**
   * Advance the sequence.
   * Returns { active, phase, seatPos, cameraPos, lookAt } for the renderer.
   */
  update(dt, world, weather) {
    if (!this.active) {
      return {
        active: false,
        phase: this.phase,
        seatPos: this.seatPos,
        cameraPos: this.cameraPos,
        lookAt: this.lookAt,
      };
    }

    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    this.timer += dt;

    this._advanceCanopy(dt, world);
    if (this.phase === 'ROCKET' || this.phase === 'CHUTE') {
      this._advanceSeat(dt, world, weather);
    }

    this._updateCamera();
    this._syncVisuals();

    return {
      active: this.active,
      phase: this.phase,
      seatPos: this.seatPos,
      cameraPos: this.cameraPos,
      lookAt: this.lookAt,
    };
  }

  // ------------------------------------------------------------ simulation

  _advanceCanopy(dt, world) {
    if (this._canopyLanded) return;

    this.canopyVel.y -= G * dt;
    this.canopyPos.addScaledVector(this.canopyVel, dt);

    const gh = heightAt(world, this.canopyPos.x, this.canopyPos.z);
    if (this.canopyPos.y <= gh + 0.25) {
      this.canopyPos.y = gh + 0.25;
      this.canopyVel.set(0, 0, 0);
      this._canopyLanded = true;
    }
  }

  _advanceSeat(dt, world, weather) {
    if (this.phase === 'ROCKET') {
      this.seatVel.y -= G * dt;
      if (this.timer <= ROCKET_TIME) this.seatVel.y += ROCKET_ACCEL * dt;
      if (this.timer > CHUTE_DELAY) this.phase = 'CHUTE';
    }

    if (this.phase === 'CHUTE') {
      this.chuteOpen = smoothstep(CHUTE_DELAY, CHUTE_DELAY + CHUTE_OPEN_TIME, this.timer);

      this._sampleWind(weather, _wind);
      const open = this.chuteOpen;

      // Horizontal velocity bleeds off into the local wind.
      const hk = 1 - Math.exp(-1.7 * open * dt);
      this.seatVel.x += (_wind.x - this.seatVel.x) * hk;
      this.seatVel.z += (_wind.z - this.seatVel.z) * hk;

      // Vertical speed settles gently to the canopy sink rate.
      const vk = 1 - Math.exp(-2.2 * open * dt);
      this.seatVel.y += (CHUTE_SINK - this.seatVel.y) * vk;
    }

    this.seatPos.addScaledVector(this.seatVel, dt);

    const gh = heightAt(world, this.seatPos.x, this.seatPos.z);
    if (this.seatPos.y <= gh + GROUND_CLEARANCE) {
      this.seatPos.y = gh + GROUND_CLEARANCE;
      this.seatVel.set(0, 0, 0);
      this.phase = 'LANDED';
    }
  }

  _sampleWind(weather, out) {
    out.set(0, 0, 0);
    if (!weather) return out;

    if (typeof weather.windAt === 'function') {
      weather.windAt(this.seatPos.x, this.seatPos.z, this.seatPos.y, out);
      return out;
    }
    const s = weather.state;
    if (s && Number.isFinite(s.windX) && Number.isFinite(s.windZ)) {
      out.set(s.windX, 0, s.windZ);
    }
    return out;
  }

  _updateCamera() {
    if (!this.active) {
      this.cameraPos.copy(this.seatPos);
      this.lookAt.copy(this.seatPos);
      return;
    }
    const t = this.timer;
    const r = 12 + 2 * Math.sin(t * 0.2);
    const a = 0.8 + t * 0.12;
    this.cameraPos.set(
      this.seatPos.x + Math.cos(a) * r,
      this.seatPos.y + 4.5 + 1.5 * Math.sin(t * 0.3),
      this.seatPos.z + Math.sin(a) * r,
    );
    this.lookAt.copy(this.seatPos);
    this.lookAt.y += 1.4;
  }

  // -------------------------------------------------------------- geometry

  _dispose(group) {
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mats = obj.material
        ? (Array.isArray(obj.material) ? obj.material : [obj.material])
        : [];
      for (const m of mats) m.dispose();
    });
  }

  _build() {
    if (!this.scene || this._group) return;

    const group = new THREE.Group();
    group.name = 'ejection-sequence';

    const seatMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.8, metalness: 0.3 });
    const suitMat = new THREE.MeshStandardMaterial({ color: 0x5f6f4a, roughness: 0.9 });
    const helmetMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.35, metalness: 0.15 });
    const visorMat = new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.2, metalness: 0.65 });

    // ------------------------------------------------------ pilot + seat
    const seatGroup = new THREE.Group();

    const pan = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.22, 0.72), seatMat);
    pan.position.set(0, -0.42, 0);
    seatGroup.add(pan);

    const back = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.95, 0.18), seatMat);
    back.position.set(0, 0.05, 0.33);
    seatGroup.add(back);

    const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 0.2), seatMat);
    headrest.position.set(0, 0.62, 0.36);
    seatGroup.add(headrest);

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.68, 8), suitMat);
    torso.position.set(0, 0.06, 0.14);
    seatGroup.add(torso);

    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), helmetMat);
    helmet.position.set(0, 0.6, 0.12);
    seatGroup.add(helmet);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.03), visorMat);
    visor.position.set(0, 0.6, -0.03);
    seatGroup.add(visor);

    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.09, 0.55, 6), suitMat);
      leg.position.set(s * 0.13, -0.6, -0.16);
      leg.rotation.x = 0.18;
      seatGroup.add(leg);
    }

    group.add(seatGroup);

    // -------------------------------------------------- jettisoned canopy
    const canopyGeo = new THREE.SphereGeometry(0.95, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
    canopyGeo.scale(1.0, 0.75, 1.6);
    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0x9fd8ff,
      transparent: true,
      opacity: 0.32,
      roughness: 0.15,
      metalness: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const canopy = new THREE.Mesh(canopyGeo, canopyMat);
    group.add(canopy);

    // ------------------------------------------------------- parachute dome
    const chuteGroup = new THREE.Group();
    const domeGeo = new THREE.SphereGeometry(6.2, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.5);
    const vertCount = domeGeo.attributes.position.count;
    const colors = new Float32Array(vertCount * 3);
    const orange = new THREE.Color(0xff7a1a);
    const white = new THREE.Color(0xf2f2f2);
    for (let i = 0; i < vertCount; i++) {
      const x = domeGeo.attributes.position.getX(i);
      const z = domeGeo.attributes.position.getZ(i);
      const a = Math.atan2(z, x);
      const stripe = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12) % 2;
      const c = stripe ? white : orange;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    domeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const domeMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0.0,
    });
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.scale.y = 0.72;
    chuteGroup.add(dome);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(6.15, 0.1, 6, 32),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 }),
    );
    rim.rotation.x = Math.PI / 2;
    chuteGroup.add(rim);

    const riserPts = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      riserPts.push(new THREE.Vector3(Math.cos(a) * 6.0, 0, Math.sin(a) * 6.0));
      riserPts.push(new THREE.Vector3(0, -5.2, 0));
    }
    const risers = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(riserPts),
      new THREE.LineBasicMaterial({ color: 0xe8e8e8, transparent: true, opacity: 0.75 }),
    );
    chuteGroup.add(risers);

    chuteGroup.visible = false;
    group.add(chuteGroup);

    this.scene.add(group);
    this._group = group;
    this._seatGroup = seatGroup;
    this._canopyMesh = canopy;
    this._chuteGroup = chuteGroup;
  }

  _syncVisuals() {
    if (!this._group) return;

    this._seatGroup.position.copy(this.seatPos);
    this._seatGroup.rotation.set(
      0.08 * Math.sin(this.timer * 3.1),
      0,
      0.06 * Math.sin(this.timer * 2.3),
    );

    this._canopyMesh.position.copy(this.canopyPos);
    if (!this._canopyLanded) {
      this._canopyMesh.rotation.set(this.timer * 0.9, this.timer * 0.5, this.timer * 0.7);
    }

    const showChute = (this.phase === 'CHUTE' || this.phase === 'LANDED') && this.chuteOpen > 0.02;
    this._chuteGroup.visible = showChute;
    if (showChute) {
      const open = this.chuteOpen;
      this._chuteGroup.position.set(
        this.seatPos.x,
        this.seatPos.y + 5.4 + 1.6 * open,
        this.seatPos.z,
      );
      this._chuteGroup.scale.setScalar(0.18 + 0.82 * open);
      this._chuteGroup.rotation.z = 0.12 * Math.sin(this.timer * 1.3);
    }
  }
}