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
const _chaseUp = new THREE.Vector3();
const _fwdUp = new THREE.Vector3();

// Near planes tuned per rig: the cockpit keeps a tight near so the instrument
// panel never clips, while every external rig pushes near out to 1.5 (12x more
// depth precision at the horizon, no shader-side depth hacks needed).
const COCKPIT_NEAR = 0.22;
const EXTERNAL_NEAR = 1.5;

// Locked follow camera presets, cycled by repeatedly pressing V. Preset 0 keeps
// the original 20 m dead-astern / 4% climb rigid stick; presets 1-4 add distance,
// elevation and an exponential "catch-up" lag so the rig glides cinematically
// behind the jet instead of being welded to it.
const FOLLOW_PRESETS = [
  { label: 'TIGHT', dist: 20, elevRad: Math.atan(0.04), elevLabel: '4%', catchup: 0, lead: 12 }, // 1/5: exact original rigid stick
  { label: 'CLOSE', dist: 35, elevRad: 6 * Math.PI / 180, elevLabel: '6°', catchup: 9.5, lead: 14 }, // 2/5: subtle cinematic catch-up
  { label: 'MEDIUM', dist: 60, elevRad: 10 * Math.PI / 180, elevLabel: '10°', catchup: 6.2, lead: 16 }, // 3/5: 60m / 10° tactical cinematic
  { label: 'WIDE', dist: 95, elevRad: 14 * Math.PI / 180, elevLabel: '14°', catchup: 4.4, lead: 18 }, // 4/5: sweeping dogfight catch-up
  { label: 'HERO', dist: 140, elevRad: 18 * Math.PI / 180, elevLabel: '18°', catchup: 3.1, lead: 20 }, // 5/5: dramatic inertial catch-up
];

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
    this.chaseLocked = false;
    // Detach-jerk accumulator: sub-4px jitter is ignored and slow drift bleeds
    // off, so only a real flick or quick swipe unlocks the follow camera.
    this._detachAccum = 0;
    // Index into FOLLOW_PRESETS; survives setMode()/detach so re-pressing V
    // returns to the preset the pilot was flying. Reset zeroes it.
    this.followPresetIndex = 0;
    this.orbitAngle = 0;
    // Telephoto flyby camera anchor + Doppler shift fed to the engine audio.
    this.dopplerRatio = 1.0;
    this._flybyAnchor = new THREE.Vector3();
    this._flybyAnchored = false;
    this._cockpitAlerts = null;
    this._camPos = new THREE.Vector3();
    this._camInit = false;
    this._shake = 0;
    // Helmet-cam head inertia (metres / radians). Small smoothed scalars driven
    // by G-load and roll rate so the eye socket never snaps: vertical sag under
    // positive G, lateral lean and a subtle bank lag with roll rate. Allocated
    // once at construction so the per-frame camera path stays allocation-free.
    this._headSag = 0;
    this._headLean = 0;
    this._headTilt = 0;
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
      cockpitView: false, sunDir: null, sunColor: null, overcast: 0,
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
    this.chaseLocked = false;
    this._detachAccum = 0;
    this.followPresetIndex = 0;
    this._airport = null;
    this._airportTimer = 0;
  }

  setMode(mode) {
    this.mode = mode;
    this._camInit = false;
    this._flybyAnchored = false;
    this.dopplerRatio = 1.0;
    // Any mode switch drops the rigid follow lock so the new rig is free.
    this.chaseLocked = false;
    this._detachAccum = 0;
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

  // Locked "follow" view: dead astern at 20 m on a 4% climb by default, hard-
  // locked until the pilot moves the mouse. Repeated presses while locked cycle
  // through the 5 cinematic presets; re-pressing after a detach or from another
  // camera mode snaps back to the preset the pilot was last using.
  snapFollowCamera() {
    const wasChase = this.mode === 'chase';
    const wasLocked = wasChase && this.chaseLocked;
    if (wasLocked) {
      this.followPresetIndex = (this.followPresetIndex + 1) % FOLLOW_PRESETS.length;
    }
    const p = FOLLOW_PRESETS[this.followPresetIndex];
    // setMode() clears _camInit and the lock; re-apply the preset pose below.
    this.setMode('chase');
    this.chaseDist = p.dist;
    this.chaseYaw = 0;
    this.chasePitch = p.elevRad;
    this.chaseLocked = true;
    this._detachAccum = 0;
    // Glide from the current camera position only when stepping into a preset
    // that has catch-up; from another camera mode or onto the rigid preset 0,
    // snap cleanly to the new pose instead.
    this._camInit = wasChase && p.catchup > 0;
    return {
      mode: 'chase',
      index: this.followPresetIndex,
      count: FOLLOW_PRESETS.length,
      preset: p,
    };
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
    // A zero-intensity light still costs a full loop in every lit shader;
    // hiding it drops the shadow-casting SpotLight from the program.
    this.landingLight.visible = night > 0.2 && flight.gearPos > 0.5;

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
    // Cockpit sun self-shadowing: the live world sun direction/colour and the
    // overcast fraction drive the cockpit-only shadow spotlight in cockpit.js.
    env.sunDir = weather?.sunDir || null;
    env.sunColor = weather?.sunColor || null;
    env.overcast = weather?.state?.overcast ?? 0;
    // Same test as updateF16Visual (f16.js): only the cockpit view needs the
    // interior lights and the 10 Hz MFD redraw.
    env.cockpitView = !!(started && this.mode === 'cockpit');

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
      // Helmet-cam head inertia: positive G compresses the head down onto the
      // spine, roll rate makes it lean and lag the airframe's bank. Exponential
      // smoothing at 6.5 Hz keeps it weighty without ever lagging behind a
      // snap roll; dt === 0 (restore path) snaps straight to the target.
      const targetSag = clamp(-((flight.gLoad || 1) - 1) * 0.0085, -0.042, 0.022);
      const rollRate = flight.rates ? flight.rates.z : 0;
      const targetLean = clamp(-rollRate * 0.022, -0.042, 0.042);
      const targetTilt = clamp(-rollRate * 0.025, -0.045, 0.045);
      if (dt > 0) {
        const hk = 1 - Math.exp(-6.5 * dt);
        this._headSag += (targetSag - this._headSag) * hk;
        this._headLean += (targetLean - this._headLean) * hk;
        this._headTilt += (targetTilt - this._headTilt) * hk;
      } else {
        this._headSag = targetSag;
        this._headLean = targetLean;
        this._headTilt = targetTilt;
      }
      // Wide helmet-cam eye: sits just forward of the ACES II headrest front
      // face (-2.06) and high enough that the 70° lens frames both MFDs, the
      // 3D ICP, EHSI, throttle/sidestick hands, knees and both sill rails with
      // sky above the glare shield.
      _v.set(this._headLean, 1.14 + this._headSag, -2.13).applyQuaternion(q).add(pos);
      cam.position.copy(_v);
      _e.set(0, 0, 0);
      _lookQ.setFromEuler(_e);
      _q.copy(q).multiply(_lookQ);
      // apply head look in aircraft local frame, plus a fixed -3.2° framing
      // pitch that puts the boresight/WAR-HUD combiner on the 0.46h line at 70°.
      _e.set(this.lookPitch - 0.056, this.lookYaw, this._headTilt, 'YXZ');
      _lookQ.setFromEuler(_e);
      _q.multiply(_lookQ);
      cam.quaternion.copy(_q);

      // buffet / g shake — stall buffet plus the ISA AoA/transonic buffet the
      // flight model publishes (smooth blend so it swells in instead of snapping).
      const buffet = Math.max(flight.stall ? 1 : 0, flight.buffet || 0);
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
      // Locked follow rig: only real mouse motion (pointer-lock look or
      // left-drag) detaches it. Keys and the wheel are deliberately ignored so
      // the camera "sticks" to the jet until the pilot grabs the mouse.
      const locked = this.mode === 'chase' && this.chaseLocked;
      const p = FOLLOW_PRESETS[this.followPresetIndex] || FOLLOW_PRESETS[0];
      // Detach intent. Small mouse bumps must never steal the locked view, so
      // sub-4px jitter is discarded outright, the accumulator bleeds off at
      // 90 px/s (spaced-out nudges can never pile up), and only a real jerk —
      // a single-frame >= 22 px flick or a quick swipe summing >= 42 px —
      // hands the camera back to the pilot.
      let moveMag = 0;
      if (locked) {
        this._detachAccum = Math.max(0, this._detachAccum - dt * 90);
        if (input && (input.pointerLocked || (input.mouse.buttons & 1))) {
          moveMag = Math.hypot(input.mouse.dx || 0, input.mouse.dy || 0);
          if (moveMag >= 4) this._detachAccum += moveMag;
        }
      }
      const hasMouseMove = locked && (moveMag >= 22 || this._detachAccum >= 42);

      if (hasMouseMove) {
        this._detachAccum = 0;
        this.chaseLocked = false;
        this.chaseYaw = -(input.mouse.dx || 0) * 0.005;
        this.chasePitch = clamp(p.elevRad + (input.mouse.dy || 0) * 0.004, -0.8, 1.1);
        // Seed the free rig from the active preset so the hand-off never jumps.
        this.chaseDist = p.dist;
      } else if (!locked && input) {
        if (input.mouse.wheel) {
          this.chaseDist = clamp(this.chaseDist + input.mouse.wheel * 3, 12, 90);
        }
        if ((input.pointerLocked || (input.mouse.buttons & 1)) && (input.mouse.dx || input.mouse.dy)) {
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

      if (this.chaseLocked && this.mode === 'chase') {
        // Preset pose: p.dist dead astern along the jet's 3D tail vector, raised
        // by p.dist * sin(elev). Camera-up follows world +Y projected
        // perpendicular to the flight vector so the horizon stays level in
        // climbs and turns, easing into the airframe's +Y near-vertical.
        const fwd = flight.forward;
        _fwdUp.set(0, 1, 0).applyQuaternion(q);
        _chaseUp.set(0, 1, 0).addScaledVector(fwd, -fwd.y);
        const perpLen = _chaseUp.length();
        if (perpLen > 1e-3) _chaseUp.multiplyScalar(1 / perpLen);
        else _chaseUp.copy(_fwdUp);
        if (Math.abs(fwd.y) > 0.96) {
          const t = clamp((Math.abs(fwd.y) - 0.96) / 0.04, 0, 1);
          _chaseUp.lerp(_fwdUp, t).normalize();
        }

        _v.copy(pos)
          .addScaledVector(fwd, -p.dist * Math.cos(p.elevRad))
          .addScaledVector(_chaseUp, p.dist * Math.sin(p.elevRad));
        // keep above terrain
        const gh = this.world.heightAt(_v.x, _v.z) + 2.5;
        if (_v.y < gh) _v.y = gh;

        if (p.catchup === 0 || !this._camInit) {
          // Rigid stick — preset 0 (and every fresh snap) has no spring lag.
          cam.position.copy(_v);
        } else {
          // Cinematic catch-up: exponential lag behind the ideal pose, so the
          // rig sweeps out in turns and trails the jet under acceleration.
          const k = 1 - Math.exp(-p.catchup * dt);
          cam.position.lerp(_v, k);
          // Cap the trailing lag so even at Mach 2 the jet stays in frame...
          const maxLag = p.dist * 1.45;
          _v2.copy(cam.position).sub(_v);
          const lag = _v2.length();
          if (lag > maxLag) {
            cam.position.copy(_v).addScaledVector(_v2.multiplyScalar(1 / lag), maxLag);
          }
          // ...and snap outright past the panic radius (teleport / respawn).
          const panic = p.dist * 2.2;
          if (cam.position.distanceToSquared(pos) > panic * panic) cam.position.copy(_v);
          // Catch-up can cut across a ridge; never let the lens go underground.
          const camGh = this.world.heightAt(cam.position.x, cam.position.z) + 2.5;
          if (cam.position.y < camGh) cam.position.y = camGh;
        }
        this._camInit = true;

        // Smooth look-target framing: lead the jet along its velocity vector and
        // keep it slightly high in frame so turns and burners read dramatically.
        // Preset 0 keeps the original +0.35 m framing exactly.
        const lookRise = p.catchup === 0 ? 0.35 : 0.35 + p.dist * 0.01;
        _v2.copy(pos).addScaledVector(fwd, p.lead).addScaledVector(_chaseUp, lookRise);
        cam.up.copy(_chaseUp);
        cam.lookAt(_v2);
        cam.fov = CONFIG.camera.externalFov;
        cam.near = EXTERNAL_NEAR;
        cam.updateProjectionMatrix();
        return;
      }

      const hdg = Math.atan2(flight.forward.x, -flight.forward.z);
      const yaw = hdg + Math.PI + this.chaseYaw;
      const pitch = clamp(this.chasePitch, -0.6, 1.2);
      const dist = this.chaseDist;
      // Vertical offset is exactly sin(pitch) * dist so detaching from any
      // follow preset continues from the locked position without a jump.
      const targetY = pos.y + Math.sin(pitch) * dist + 0.25;
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
      kts: (Number.isFinite(f.ias) ? f.ias : f.speed) * 1.94384,
      tasKts: f.speed * 1.94384,
      mach: Number.isFinite(f.mach) ? f.mach : f.speed / 340.3,
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
      iasMs: Number.isFinite(f.ias) ? f.ias : f.speed,
      lefDeg: f.lefDeg || 0,
      catMode: f.catMode || 'CAT I',
      massKg: f.massKg || CONFIG.aircraft.mass,
      buffet: f.buffet || 0,
      brakeTemp: f.brakeTemp || 0,
      antiSkid: !!f.antiSkid,
      aerobraking: !!f.aerobraking,
      gearDown: f.gearPos > 0.5,
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