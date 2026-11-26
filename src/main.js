import './ui/style.css';
import * as THREE from 'three';
import { CONFIG, QUALITY, WEATHER, WIND } from './config.js';
import { Input } from './core/input.js';
import { SimAudio } from './core/audio.js';
import { World } from './world/world.js';
import { TimeSystem } from './sim/time.js';
import { WeatherSystem } from './sim/weather.js';
import { SkySystem } from './sim/sky.js';
import { CloudSystem } from './sim/clouds.js';
import { Aircraft } from './aircraft/aircraft.js';
import { HUD } from './ui/hud.js';
import { UI } from './ui/menu.js';
import { spawnPoint, airportNear, airportsNear } from './world/terrain.js';
import { settlementsNear } from './world/settlements.js';
import { clamp } from './world/noise.js';

const NEUTRAL_CMD = {
  pitch: 0, roll: 0, yaw: 0, throttleDelta: 0,
  gearToggle: false, flapsToggle: false, brake: false,
};

class App {
  constructor() {
    this.canvas = document.getElementById('scene');
    this.scene = new THREE.Scene();
    this.preset = QUALITY.medium;
    this.mode = 'boot';
    this.ready = false;
    this.paused = false;
    this.uiHidden = false;
    this.debug = false;
    this.muted = false;
    this.last = performance.now();
    this.fps = 60;
    this._statTimer = 0;
    this._atcTimer = 0;
    this._crashTimer = 0;
    this._toastFlags = new Set();

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.preset.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.preset.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CONFIG.render.exposure;

    this.input = new Input();
    this.input.attach(this.canvas);
    this.input.captured = this.canvas;
    this.audio = new SimAudio();

    this.ui = new UI({
      onStart: () => this.startFlight(),
      onResume: () => this.resume(),
      onRespawn: () => this.respawn(),
      onMenu: () => this.returnToMenu(),
      onWeather: (w) => {
        this.weather.setPreset(w, true);
        this.ui.toast('WEATHER · ' + WEATHER[w].label);
      },
      onWind: (w) => {
        this.weather.setWindPreset(w, true);
        this.ui.toast('WIND · ' + WIND[w].label);
      },
      onQuality: (q) => this.setQuality(q),
      onTime: (h) => {
        this.time.setHour(h);
        this.ui.toast('TIME ' + this.time.clock);
      },
    });

    this.time = new TimeSystem();
    this.time.setHour(this.ui.hour);
    this.weather = new WeatherSystem(this.ui.weather, this.ui.wind);
    this.sky = new SkySystem(this.scene, this.renderer);

    this.spawn = this.chooseSpawn();
    this.world = new World(this.scene, this.preset);
    this.aircraft = new Aircraft(this.scene, this.world);
    this.camera = this.aircraft.camera;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();

    this.aircraft.reset(this.spawn);
    this.aircraft.model.position.copy(this.aircraft.flight.position);
    this.aircraft.model.quaternion.copy(this.aircraft.flight.quaternion);

    this.clouds = new CloudSystem(this.scene, this.preset);
    this.hud = new HUD(document.getElementById('hud'));
    this.hud.setVisible(false);

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));

    this.loop = this.loop.bind(this);
    this.init();
  }

  async init() {
    const raf = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    try {
      this.ui.setBootProgress(0.06, 'INITIALISING FLIGHT SYSTEMS');
      await raf();
      this.ui.setBootProgress(0.12, 'RAISING LANDMASS');
      await raf();

      const cp = this.camera.position;
      cp.set(this.spawn.x, this.spawn.y + 8, this.spawn.z);
      this.world.terrain.refresh(cp, 1);
      await raf();

      // Build the nearest terrain tiles while the boot bar animates. The rest
      // streams in behind the menu, so boot never waits on the full quadtree.
      const bootTarget = 90;
      for (let i = 0; i < 9; i++) {
        this.world.terrain._buildPending(12);
        this.ui.setBootProgress(0.16 + i * 0.04, 'CUTTING TERRAIN');
        await raf();
        if (this.world.terrain.pending.length === 0 || this.world.terrain.tiles.size >= bootTarget) break;
      }

      this.ui.setBootProgress(0.56, 'PAVING RUNWAYS');
      await raf();
      this.sky.update(0.016, this.time, this.weather, this.camera, 0);
      this.world.weather = this.weather;
      this.world.airports.update(0.016, this.camera, this.weather, this.sky);
      await raf();

      this.ui.setBootProgress(0.68, 'BUILDING SETTLEMENTS');
      await raf();
      this.world.buildings.rebuild(this.camera);
      this.ui.setBootProgress(0.82, 'PLANTING FORESTS');
      await raf();
      this.world.vegetation.rebuild(this.camera);
      await raf();

      this.ui.setBootProgress(0.92, 'WEATHER UPLINK');
      this.clouds.update(0.016, this.camera, this.weather, this.sky);
      await raf();

      this.ui.setBootProgress(1, 'READY');
      await new Promise((r) => setTimeout(r, 260));
      this.ui.hideBoot();
      this.aircraft.setMode('cockpit');
      this.mode = 'menu';
      this.ready = true;
      this.ui.showMenu();
      this.last = performance.now();
      requestAnimationFrame(this.loop);
    } catch (err) {
      console.error(err);
      this.ui.setBootProgress(0.2, 'WEBGL / INIT ERROR — SEE CONSOLE');
      const s = document.createElement('pre');
      s.style.cssText = 'position:fixed;bottom:20px;left:20px;color:#ff8a7a;font:10px monospace;z-index:99;max-width:90vw;white-space:pre-wrap';
      s.textContent = String(err?.stack || err);
      document.body.appendChild(s);
    }
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.preset.pixelRatio));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setQuality(name) {
    const q = QUALITY[name];
    if (!q) return;
    this.preset = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.world.setPreset(q);
    this.resize();
    this.ui.toast('QUALITY · ' + name.toUpperCase());
  }

  onKey(e) {
    const code = e.code;
    if (this.mode === 'menu') {
      if (code === 'Enter') this.startFlight();
      return;
    }
    if (this.mode === 'crash') {
      if (code === 'KeyR') this.respawn();
      if (code === 'Escape') this.returnToMenu();
      if (code === 'F3') {
        this.debug = !this.debug;
        if (!this.debug) this.ui.setDebug('', false);
      }
      return;
    }
    if (code === 'F3') {
      this.debug = !this.debug;
      if (!this.debug) this.ui.setDebug('', false);
      return;
    }
    if (code === 'F1') {
      this.uiHidden = !this.uiHidden;
      this.hud.setVisible(!this.uiHidden);
      if (this.uiHidden) this.ui.setATC('');
      return;
    }
    if (code === 'KeyM') {
      this.muted = !this.muted;
      this.audio.setMuted(this.muted);
      this.ui.toast(this.muted ? 'AUDIO MUTED' : 'AUDIO ON');
      return;
    }
    if (code === 'KeyH') {
      this.ui.toggleHelp();
      return;
    }
    if (code === 'Escape' || code === 'KeyP') {
      if (!document.getElementById('help').classList.contains('hidden')) {
        this.ui.hideHelp();
        return;
      }
      if (this.mode === 'fly') this.pause();
      else if (this.mode === 'pause') this.resume();
      return;
    }
  }

  startFlight() {
    if (!this.ready) return;
    this.input.requestPointerLock();
    this.audio.start();
    this.audio.resetEngine();
    this.audio.setPaused(false);
    this.aircraft.setMode('cockpit');
    this.aircraft.reset(this.spawn);
    this.ui.hideMenu();
    this.ui.hidePause();
    this.ui.hideCrash();
    this.hud.setVisible(true);
    this.mode = 'fly';
    this.weather.night = this.sky.night;
    this.ui.toast('SHIFT = THROTTLE UP · S = ROTATE · G = GEAR');
    this.last = performance.now();
  }

  pause() {
    if (this.mode !== 'fly') return;
    this.mode = 'pause';
    this.audio.setPaused(true);
    this.input.releasePointerLock();
    const t = this.aircraft.telemetry(this.weather, this.time, this.sky);
    const ap = t.airport;
    this.ui.showPause(`
      ${Math.round(t.kts)} KTS · ${Math.round(t.altFt).toLocaleString()} FT · HDG ${String(Math.round(t.heading)).padStart(3, '0')}<br>
      ${ap ? ap.name.toUpperCase() + ' · ' + ap.code : 'NO AIRPORT IN RANGE'}<br>
      TIME ${t.clock} · ×${this.time.scale} · ${WEATHER[this.weather.presetName].label}
    `);
  }

  resume() {
    if (this.mode !== 'pause') return;
    this.mode = 'fly';
    this.audio.setPaused(false);
    this.ui.hidePause();
    this.input.requestPointerLock();
    this.last = performance.now();
  }

  /**
   * Pick a starting airport that has a real city nearby, so the first flight
   * shows off the world instead of an empty field.
   */
  chooseSpawn() {
    let best = null;
    const candidates = airportsNear(0, 0, 3);
    for (const ap of candidates) {
      const setts = settlementsNear(ap.x, ap.z, 9000);
      let city = null;
      let cityD = Infinity;
      for (const s of setts) {
        if (s.type !== 'metro') continue;
        const d = Math.hypot(s.x - ap.x, s.z - ap.z);
        if (d < cityD) { cityD = d; city = s; }
      }
      if (!city) continue;
      const runwayBonus = ap.length >= 1800 ? 0 : 2500;
      const score = cityD + runwayBonus + Math.hypot(ap.x, ap.z) * 0.012;
      if (!best || score < best.score) best = { ap, city, cityD, score };
    }
    if (best) {
      const sp = this.spawnForAirport(best.ap, best.city);
      sp.city = best.city;
      sp.airport = best.ap;
      return sp;
    }
    return spawnPoint();
  }

  spawnForAirport(ap, city = null) {
    if (!ap) return spawnPoint();
    let heading = ap.heading;
    if (city) {
      const cityBearing = (Math.atan2(city.x - ap.x, -(city.z - ap.z)) * 180 / Math.PI + 360) % 360;
      const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
      if (diff(cityBearing, (heading + 180) % 360) < diff(cityBearing, heading)) {
        heading = (heading + 180) % 360;
      }
    }
    const rad = (heading * Math.PI) / 180;
    const dirX = Math.sin(rad);
    const dirZ = -Math.cos(rad);
    const back = ap.length * 0.5 - 90;
    return {
      x: ap.x - dirX * back,
      z: ap.z - dirZ * back,
      y: ap.elevation + CONFIG.aircraft.gearHeight + 0.02,
      heading,
      airport: ap,
      city,
    };
  }

  respawn() {
    const f = this.aircraft.flight;
    const ap = airportNear(f.position.x, f.position.z, 80000);
    const sp = this.spawnForAirport(ap);
    this.aircraft.reset(sp);
    this.aircraft.setMode('cockpit');
    this.audio.resetEngine();
    this.audio.setPaused(false);
    this.ui.hideCrash();
    this.ui.hidePause();
    this.hud.setVisible(!this.uiHidden);
    this.mode = 'fly';
    this._crashTimer = 0;
    this.input.requestPointerLock();
    this.ui.toast('RESET · ' + (ap ? ap.name.toUpperCase() : 'RUNWAY'));
  }

  returnToMenu() {
    this.mode = 'menu';
    this.audio.setPaused(true);
    this.ui.showMenu();
    this.ui.hidePause();
    this.ui.hideCrash();
    this.hud.setVisible(false);
    this.input.releasePointerLock();
    this.aircraft.reset(this.spawn);
    this.aircraft.setMode('cockpit');
  }

  buildCommand() {
    const i = this.input;
    const up = i.anyDown('ShiftLeft', 'ShiftRight') || i.isDown('ArrowUp');
    const down = i.anyDown('ControlLeft', 'ControlRight') || i.isDown('ArrowDown');
    return {
      pitch: (i.isDown('KeyS') ? 1 : 0) - (i.isDown('KeyW') ? 1 : 0),
      roll: (i.isDown('KeyA') ? 1 : 0) - (i.isDown('KeyD') ? 1 : 0),
      yaw: (i.isDown('KeyQ') ? 1 : 0) - (i.isDown('KeyE') ? 1 : 0),
      throttleDelta: (up ? 1 : 0) - (down ? 1 : 0),
      gearToggle: i.wasPressed('KeyG'),
      flapsToggle: i.wasPressed('KeyF'),
      brake: i.isDown('KeyB') || i.isDown('Space'),
    };
  }

  handleFlightKeys(cmd) {
    const f = this.aircraft.flight;
    const i = this.input;
    if (cmd.gearToggle && !f.onGround) this.audio.gear(!f.gearDown);
    if (cmd.flapsToggle) this.ui.toast('FLAPS ' + (f.flapsIndex + 1) % 3);
    if (i.wasPressed('KeyV')) {
      const m = this.aircraft.toggleCockpit();
      this.ui.toast('VIEW · ' + m.toUpperCase());
    }
    if (i.wasPressed('KeyC')) {
      const m = this.aircraft.nextMode();
      this.ui.toast('CAMERA · ' + m.toUpperCase());
    }
    if (i.wasPressed('KeyT')) {
      const s = this.time.cycleScale();
      this.ui.toast('TIME SCALE ×' + s);
    }
    if (i.wasPressed('BracketLeft')) {
      this.time.addHours(-1);
      this.ui.toast('TIME ' + this.time.clock);
    }
    if (i.wasPressed('BracketRight')) {
      this.time.addHours(1);
      this.ui.toast('TIME ' + this.time.clock);
    }
    if (i.wasPressed('KeyR')) this.respawn();
    if (i.wasPressed('KeyY')) {
      const names = Object.keys(WEATHER);
      const idx = names.indexOf(this.weather.presetName);
      const next = names[(idx + 1) % names.length];
      this.weather.setPreset(next, true);
      this.ui.toast('WEATHER · ' + WEATHER[next].label);
    }
    if (i.wasPressed('KeyU')) {
      const names = Object.keys(WIND);
      const idx = names.indexOf(this.weather.windPresetName);
      const next = names[(idx + 1) % names.length];
      this.weather.setWindPreset(next, true);
      this.ui.toast('WIND · ' + WIND[next].label);
    }
  }

  update(dt) {
    const simDt = Math.min(dt, 0.05);
    const fly = this.mode === 'fly';
    const menu = this.mode === 'menu';

    if (fly || menu) {
      this.time.update(menu ? simDt * 0.25 : simDt);
      this.weather.update(menu ? simDt * 0.5 : simDt);
    }

    let cmd = NEUTRAL_CMD;
    if (fly) {
      cmd = this.buildCommand();
      this.handleFlightKeys(cmd);
    }

    if (fly) {
      this.aircraft.update(simDt, cmd, this.weather, this.input, true);
      this.weather.night = this.sky.night;
      const f = this.aircraft.flight;
      if (f.touchdown > 0.2) {
        this.audio.thump(clamp(f.touchdown / 5, 0.15, 1));
        this.ui.toast('TOUCHDOWN');
      }
      if (f.crashed && this.mode === 'fly') this.onCrash();
    } else if (menu) {
      this.aircraft.update(simDt, NEUTRAL_CMD, this.weather, this.input, false);
    } else if (this.mode === 'crash') {
      this.aircraft.update(simDt, NEUTRAL_CMD, this.weather, this.input, true);
    }

    // atmosphere and streaming keep running (frozen during pause)
    if (this.mode !== 'pause' || !this.ready) {
      this.sky.update(simDt, this.time, this.weather, this.camera, this.weather.flash);
      this.world.update(simDt, this.camera, this.sky, this.weather);
      this.clouds.update(simDt, this.camera, this.weather, this.sky);
    }

    if (fly) {
      const t = this.aircraft.telemetry(this.weather, this.time, this.sky);
      t.timeScale = this.time.scale;
      t.weather = WEATHER[this.weather.presetName].label;
      t.clock = this.time.clock;
      t.sideSlip = this.aircraft.flight.beta;
      this.hud.update(simDt, t);
      this.audio.update(simDt, {
        throttle: this.aircraft.flight.throttle,
        speed: this.aircraft.flight.speed,
        afterburner: this.aircraft.flight.afterburner,
        rain: this.weather.state.rain,
        stalled: this.aircraft.flight.stall,
        onGround: this.aircraft.flight.onGround,
        mode: this.aircraft.mode,
        aoa: this.aircraft.flight.aoa,
        gForce: this.aircraft.flight.gForce,
        windSpeed: this.aircraft.flight.windSpeed,
        windGust: this.aircraft.flight.windGust,
        crosswind: this.aircraft.flight.crosswind,
        beta: this.aircraft.flight.beta,
        turbulence: this.aircraft.flight.turbulence,
        altitude: this.aircraft.flight.position.y,
      });
      this._atcTimer -= simDt;
      if (this._atcTimer <= 0) {
        this._atcTimer = 1.0;
        const ap = t.airport;
        if (ap) {
          this.ui.setATC(
            `<b>${ap.code}</b> ${ap.name}<br>` +
            `RWY ${String(Math.round(ap.heading / 10) || 36).padStart(2, '0')} · ` +
            `${(t.dist / 1000).toFixed(1)} KM · ${String(Math.round(t.bearing)).padStart(3, '0')}°<br>` +
            `${t.clock} · ×${this.time.scale} · ${WEATHER[this.weather.presetName].label}`,
          );
        } else {
          this.ui.setATC(`NO AIRPORT IN RANGE<br>${t.clock} · ×${this.time.scale}`);
        }
      }
    } else {
      this.hud.update(simDt, null);
    }

    // debug / perf
    this._statTimer -= simDt;
    if (this._statTimer <= 0) {
      this._statTimer = 0.3;
      if (this.debug) {
        const info = this.renderer.info;
        const f = this.aircraft.flight;
        this.ui.setDebug(
          `FPS ${this.fps.toFixed(0)}   ${this.mode.toUpperCase()}\n` +
          `draw ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k\n` +
          `pos ${f.position.x.toFixed(0)} ${f.position.z.toFixed(0)}\n` +
          `alt ${f.position.y.toFixed(0)}m  spd ${(f.speed * 1.944).toFixed(0)}kt\n` +
          `tiles ${this.world.terrain.tiles.size}  bld ${this.world.buildings.stats.buildings}  ` +
          `trees ${this.world.vegetation._trees}\n` +
          `apt ${this.world.airports.built.size}  ` +
          `time ${this.time.clock} ×${this.time.scale}\n` +
          `wx ${this.weather.presetName}  night ${this.sky.night.toFixed(2)}`,
          true,
        );
      }
    }
  }

  onCrash() {
    this.mode = 'crash';
    this._crashTimer = 0;
    this.aircraft.setMode('chase');
    this.audio.crash();
    this.input.releasePointerLock();
    this.hud.setVisible(false);
    this.ui.showCrash(this.aircraft.flight.crashReason || 'IMPACT');
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    const raw = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(0.1, Math.max(0.0001, raw));
    this.fps = this.fps * 0.94 + (1 / dt) * 0.06;

    if (this.ready) this.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  window.__falcon = app;
});