// Aircraft assembly: model + cockpit + flight model + cameras + lights.
import * as THREE from 'three';
import { createF16, updateF16Visual } from './f16.js';
import { createCockpit } from './cockpit.js';
import { FlightModel } from './flight.js';
import { CONFIG } from '../config.js';
import { clamp, smoothstep } from '../world/noise.js';
import { airportNear } from '../world/terrain.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _lookQ = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _fbRight = new THREE.Vector3();
const _fbUp = new THREE.Vector3();
const _fbTmp = new THREE.Vector3();

// Near planes tuned per rig: the cockpit keeps a tight near so the instrument
// panel never clips, while every external rig pushes near out to 1.5 (12x more
// depth precision at the horizon, no shader-side depth hacks needed).
const COCKPIT_NEAR = 0.22;
const EXTERNAL_NEAR = 1.5;

export class Aircraft {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.flight = new FlightModel();

    this.model = createF16();
    this.cockpit = createCockpit();
    this.model.add(this.cockpit.group);
    this.scene.add(this.model);

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.camera.cockpitFov, window.innerWidth / window.innerHeight,
      COCKPIT_NEAR, CONFIG.render.far,
    );
    this.mode = 'cockpit';
    this.lookYaw = 0;
    this.lookPitch = 0;
    this._lastLook = 0;
    this.chaseYaw = 0;
    this.chasePitch = 0;
    this.chaseDist = CONFIG.camera.chaseDistance;
    this.orbitAngle = 0;
    // Telephoto flyby camera anchor + Doppler shift fed to the engine audio.
    this.dopplerRatio = 1.0;
    this._flybyAnchor = new THREE.Vector3();
    this._flybyAnchored = false;
    this._cockpitAlerts = null;
    this._camPos = new THREE.Vector3();
    this._camInit = false;
    this._shake = 0;
    this._airport = null;
    this._airportTimer = 0;

    // landing light
    this.landingLight = new THREE.SpotLight(0xfff3d6, 0, 90, 0.34, 0.55, 1.4);
    this.landingLight.position.set(0, -0.5, -4.4);
    this.landingTarget = new THREE.Object3D();
    this.landingTarget.position.set(0, -2.5, -32);
    this.landingLight.target = this.landingTarget;
    this.model.add(this.landingLight, this.landingTarget);

    // anti-collision beacon (on dorsal spine behind cockpit)
    this.beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false }),
    );
    this.beacon.position.set(0, 0.90, 1.55);
    this.model.add(this.beacon);

    this._env = {
      airport: null, windX: 0, windZ: 0,
      night: 0, rain: 0, lowFuel: false, rwrThreat: false, flameout: false, time: 0,
    };
    this._state = { time: 0 };
  }

  reset(spawn) {
    this.flight.reset(spawn);
    this.model.position.copy(this.flight.position);
    this.model.quaternion.copy(this.flight.quaternion);
    this.lookYaw = 0;
    this.lookPitch = 0;
    this._camInit = false;
    this.mode = 'cockpit';
    this._airport = null;
    this._airportTimer = 0;
  }

  setMode(mode) {
    this.mode = mode;
    this._camInit = false;
    this._flybyAnchored = false;
    this.dopplerRatio = 1.0;
    if (mode === 'cockpit') {
      this.camera.fov = CONFIG.camera.cockpitFov;
    } else {
      this.camera.fov = CONFIG.camera.externalFov;
    }
    this.camera.near = mode === 'cockpit' ? COCKPIT_NEAR : EXTERNAL_NEAR;
    this.camera.updateProjectionMatrix();
  }

  nextMode() {
    const order = ['cockpit', 'chase', 'wing', 'orbit', 'flyby'];
    const i = order.indexOf(this.mode);
    this.setMode(order[(i + 1) % order.length]);
    return this.mode;
  }

  toggleCockpit() {
    this.setMode(this.mode === 'cockpit' ? 'chase' : 'cockpit');
    return this.mode;
  }

  update(dt, cmd, weather, input, started, cockpitAlerts = null) {
    const flight = this.flight;
    flight.update(dt, cmd, this.world, weather);
    this._state.time += dt;

    if (cockpitAlerts) this._cockpitAlerts = cockpitAlerts;

    this.model.position.copy(flight.position);
    this.model.quaternion.copy(flight.quaternion);
    updateF16Visual(this.model, flight, dt, this.mode, started);

    // exterior details
    const ud = this.model.userData;
    const night = weather?.night ?? 0;
    const strobe = (Math.sin(this._state.time * 6) > 0.86) ? 1 : 0.12;
    for (const halo of ud.navLights.halos) {
      halo.material.opacity = (0.35 + (1 - night) * 0.25) * (0.7 + 0.3 * Math.sin(this._state.time * 3));
    }
    this.beacon.visible = night > 0.25 && strobe > 0.5;
    this.landingLight.intensity = night > 0.2 && flight.gearPos > 0.5
      ? 700 * smoothstep(0.2, 0.7, night) : 0;

    // cockpit screens
    this._airportTimer -= dt;
    if (this._airportTimer <= 0) {
      this._airportTimer = 0.8;
      this._airport = airportNear(flight.position.x, flight.position.z, 60000);
    }
    const env = this._env;
    env.windX = flight.wind.x;
    env.windZ = flight.wind.z;
    env.windDir = flight.windDir;
    env.windKts = flight.windSpeed * 1.94384;
    if (this._airport) {
      const dx = this._airport.x - flight.position.x;
      const dz = this._airport.z - flight.position.z;
      env.airport = {
        name: this._airport.name,
        code: this._airport.code,
        bearing: (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360,
        dist: Math.hypot(dx, dz),
      };
    } else {
      env.airport = null;
    }

    // Cockpit environmental cues (night backlighting, canopy rain, master
    // caution). Alerts from main.js win; otherwise fall back to weather/sky.
    const alerts = cockpitAlerts || this._cockpitAlerts;
    env.night = clamp(alerts?.night ?? night, 0, 1);
    env.rain = clamp(alerts?.rain ?? weather?.state?.rain ?? 0, 0, 1);
    env.lowFuel = !!alerts?.lowFuel;
    env.rwrThreat = !!alerts?.rwrThreat;
    env.flameout = !!alerts?.flameout;
    env.time = this._state.time;

    this.cockpit.update(dt, flight, env);

    this._updateCamera(dt, input, started);
  }

  _updateCamera(dt, input, started) {
    const flight = this.flight;
    const cam = this.camera;
    const pos = flight.position;
    const q = flight.quaternion;

    // Only the telephoto flyby rig produces a Doppler shift for the engine audio.
    if (this.mode !== 'flyby') this.dopplerRatio = 1.0;

    if (!started) {
      // slow showcase orbit behind the menu
      this.orbitAngle += dt * 0.10;
      const r = 22;
      const h = 6.5;
      _v.set(
        Math.sin(this.orbitAngle) * r,
        h + Math.sin(this.orbitAngle * 0.7) * 1.2,
        Math.cos(this.orbitAngle) * r,
      ).add(pos);
      cam.position.copy(_v);
      _v2.copy(pos).addScaledVector(flight.forward, 2);
      cam.up.set(0, 1, 0);
      cam.lookAt(_v2);
      cam.fov = 42;
      cam.near = EXTERNAL_NEAR;
      cam.updateProjectionMatrix();
      return;
    }

    // Alt+0 recenters every camera offset (works in cockpit and external views).
    if (input && input.anyDown('AltLeft', 'AltRight') && input.wasPressed('Digit0')) {
      this.lookYaw = 0;
      this.lookPitch = 0;
      this.chaseYaw = 0;
      this.chasePitch = 0;
      this.chaseDist = CONFIG.camera.chaseDistance;
      this._lastLook = 0;
    }

    if (this.mode === 'cockpit') {
      // head-look offsets
      if (input) {
        const alt = input.anyDown('AltLeft', 'AltRight');
        const panYaw = (input.isDown('ArrowLeft') ? 1 : 0) - (input.isDown('ArrowRight') ? 1 : 0);
        const panPitch = (input.isDown('ArrowUp') ? 1 : 0) - (input.isDown('ArrowDown') ? 1 : 0);
        const active = input.pointerLocked || (input.mouse.buttons & 4);
        if (alt && (panYaw || panPitch)) {
          // keyboard head-look (Alt + arrows) — never auto-recenters mid-pan
          this.lookYaw = clamp(this.lookYaw + panYaw * 1.8 * dt, -2.2, 2.2);
          this.lookPitch = clamp(this.lookPitch + panPitch * 1.2 * dt, -1.1, 1.1);
          this._lastLook = 0;
        } else if (active && (input.mouse.dx || input.mouse.dy)) {
          this.lookYaw -= input.mouse.dx * CONFIG.camera.mouseSensitivity;
          this.lookPitch -= input.mouse.dy * CONFIG.camera.mouseSensitivity;
          this.lookYaw = clamp(this.lookYaw, -2.2, 2.2);
          this.lookPitch = clamp(this.lookPitch, -1.1, 1.1);
          this._lastLook = 0;
        } else {
          this._lastLook += dt;
          if (this._lastLook > 1.4) {
            const k = 1 - Math.exp(-1.8 * dt);
            this.lookYaw *= 1 - k;
            this.lookPitch *= 1 - k;
          }
        }
      }
      _v.set(0, 1.048, -2.18).applyQuaternion(q).add(pos);
      cam.position.copy(_v);
      _e.set(0, 0, 0);
      _lookQ.setFromEuler(_e);
      _q.copy(q).multiply(_lookQ);
      // apply head look in aircraft local frame
      _e.set(this.lookPitch, this.lookYaw, 0, 'YXZ');
      _lookQ.setFromEuler(_e);
      _q.multiply(_lookQ);
      cam.quaternion.copy(_q);

      // buffet / g shake
      const buffet = flight.stall ? 1 : 0;
      this._shake += ((buffet * 0.8 + flight.turbulence * 0.4) - this._shake) * (1 - Math.exp(-3 * dt));
      if (this._shake > 0.001) {
        const t = this._state.time;
        cam.position.x += Math.sin(t * 37) * 0.012 * this._shake;
        cam.position.y += Math.sin(t * 41 + 1) * 0.010 * this._shake;
        cam.position.z += Math.sin(t * 29 + 2) * 0.012 * this._shake;
      }
      cam.fov = CONFIG.camera.cockpitFov;
      cam.near = COCKPIT_NEAR;
      cam.updateProjectionMatrix();
      return;
    }

    if (this.mode === 'chase' || this.mode === 'orbit') {
      if (input) {
        if (input.mouse.wheel) {
          this.chaseDist = clamp(this.chaseDist + input.mouse.wheel * 3, 12, 90);
        }
        if ((input.mouse.buttons & 1) && (input.mouse.dx || input.mouse.dy)) {
          this.chaseYaw -= input.mouse.dx * 0.005;
          this.chasePitch = clamp(this.chasePitch + input.mouse.dy * 0.004, -0.8, 1.1);
        }
        if (input.anyDown('AltLeft', 'AltRight')) {
          // keyboard orbit control (Alt + arrows) + Alt ± distance
          const panYaw = (input.isDown('ArrowLeft') ? 1 : 0) - (input.isDown('ArrowRight') ? 1 : 0);
          const panPitch = (input.isDown('ArrowUp') ? 1 : 0) - (input.isDown('ArrowDown') ? 1 : 0);
          if (panYaw) this.chaseYaw += panYaw * 1.6 * dt;
          if (panPitch) this.chasePitch = clamp(this.chasePitch + panPitch * 1.1 * dt, -0.8, 1.1);
          const zoom = (input.anyDown('Equal', 'NumpadAdd') ? 1 : 0)
            - (input.anyDown('Minus', 'NumpadSubtract') ? 1 : 0);
          if (zoom) this.chaseDist = clamp(this.chaseDist + zoom * 38 * dt, 12, 120);
        }
      }
      const hdg = Math.atan2(flight.forward.x, -flight.forward.z);
      const yaw = hdg + Math.PI + this.chaseYaw;
      const pitch = clamp(this.chasePitch, -0.6, 1.2);
      const dist = this.chaseDist;
      const targetY = pos.y + Math.sin(pitch + 0.18) * dist * 0.55 + 2.4;
      _v.set(
        pos.x + Math.sin(yaw) * Math.cos(pitch) * dist,
        targetY,
        pos.z - Math.cos(yaw) * Math.cos(pitch) * dist,
      );
      // keep above terrain
      const gh = this.world.heightAt(_v.x, _v.z) + 2.5;
      if (_v.y < gh) _v.y = gh;

      if (!this._camInit) {
        cam.position.copy(_v);
        this._camInit = true;
      } else {
        const k = 1 - Math.exp(-5 * dt);
        cam.position.lerp(_v, k);
      }
      // Keep aircraft framed cleanly: center in orbit mode or when orbiting chase yaw,
      // gentle forward lead when flying straight behind in chase mode.
      const lead = this.mode === 'orbit'
        ? 0
        : 5.5 * Math.max(0, Math.cos(this.chaseYaw));
      _v2.copy(pos).addScaledVector(flight.forward, lead);
      _v2.y += this.mode === 'orbit' ? 0.35 : 0.85;
      cam.up.set(0, 1, 0);
      cam.lookAt(_v2);
      cam.fov = CONFIG.camera.externalFov;
      cam.near = EXTERNAL_NEAR;
      cam.updateProjectionMatrix();
      return;
    }

    if (this.mode === 'wing') {
      _v.set(9.2, 2.1, 3.2).applyQuaternion(q).add(pos);
      cam.position.copy(_v);
      _v2.copy(pos).addScaledVector(flight.forward, 4.5);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q).lerp(new THREE.Vector3(0, 1, 0), 0.35);
      cam.up.copy(up).normalize();
      cam.lookAt(_v2);
      cam.fov = CONFIG.camera.externalFov;
      cam.near = EXTERNAL_NEAR;
      cam.updateProjectionMatrix();
      return;
    }

    if (this.mode === 'flyby') {
      // Tripod planted ahead of the jet: the aircraft flies at the camera,
      // punches past it, then the anchor reseats for the next pass.
      _fbRight.set(1, 0, 0).applyQuaternion(q);
      _fbUp.set(0, 1, 0).applyQuaternion(q);
      const anchor = this._flybyAnchor;

      const passed = this._flybyAnchored && _fbTmp.copy(pos).sub(anchor).dot(flight.forward) > 320;
      const tooFar = this._flybyAnchored && _fbTmp.copy(pos).sub(anchor).length() > 900;
      if (!this._flybyAnchored || passed || tooFar) {
        const ahead = clamp(flight.speed * 2.1, 110, 340);
        anchor.copy(pos)
          .addScaledVector(flight.forward, ahead)
          .addScaledVector(_fbRight, 26)
          .addScaledVector(_fbUp, 10);
        const gh = this.world.heightAt(anchor.x, anchor.z) + 6;
        if (anchor.y < gh) anchor.y = gh;
        this._flybyAnchored = true;
      }

      cam.position.copy(anchor);
      cam.up.set(0, 1, 0);
      cam.lookAt(pos);
      cam.fov = 38;
      cam.near = EXTERNAL_NEAR;
      cam.updateProjectionMatrix();

      // Radial closing speed (positive = inbound) -> engine Doppler pitch.
      _fbTmp.copy(anchor).sub(pos);
      const dist = _fbTmp.length();
      const vToward = dist > 1e-3 ? _fbTmp.multiplyScalar(1 / dist).dot(flight.velocity) : 0;
      this.dopplerRatio = clamp(340 / Math.max(120, 340 - vToward), 0.74, 1.36);
    }
  }

  telemetry(weather, time, sky) {
    const f = this.flight;
    const ap = this._airport;
    let bearing = null;
    let dist = null;
    if (ap) {
      bearing = (Math.atan2(ap.x - f.position.x, -(ap.z - f.position.z)) * 180 / Math.PI + 360) % 360;
      dist = Math.hypot(ap.x - f.position.x, ap.z - f.position.z);
    }
    return {
      kts: f.speed * 1.94384,
      mach: f.speed / 340.3,
      altFt: f.position.y * 3.28084,
      aglFt: f.agl * 3.28084,
      vsFpm: f.verticalSpeed * 196.85,
      heading: f.heading,
      pitch: f.pitchDeg,
      roll: f.rollDeg,
      throttle: f.throttle,
      gear: f.gearPos > 0.5,
      gearPos: f.gearPos,
      flaps: f.flapsIndex,
      g: f.gForce,
      aoa: f.aoa,
      stall: f.stall,
      onGround: f.onGround,
      crashed: f.crashed,
      crashReason: f.crashReason,
      brake: f.brake,
      afterburner: f.afterburner,
      speedMs: f.speed,
      altitude: f.position.y,
      airport: ap,
      bearing,
      dist,
      weather: weather?.presetName,
      hour: time?.hour,
      clock: time?.clock,
      night: sky?.night ?? 0,
      mode: this.mode,
      position: f.position,
      windDir: f.windDir,
      windKts: f.windSpeed * 1.94384,
      windMs: f.windSpeed,
      windGust: f.windGust,
      headwindKts: f.headwind * 1.94384,
      crosswindKts: f.crosswind * 1.94384,
      turbulence: f.turbulence,
    };
  }
}