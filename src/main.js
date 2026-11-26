import './ui/style.css';
import * as THREE from 'three';
import { CONFIG, QUALITY, WEATHER, WIND, THEATERS } from './config.js';
import { on } from './core/events.js';
import { Input } from './core/input.js';
import { SimAudio } from './core/audio.js';
import { CombatAudio } from './core/combat_audio.js';
import { BitchingBetty } from './core/betty.js';
import { attachMcpBridge } from './core/mcp_bridge.js';
import { World } from './world/world.js';
import { TimeSystem } from './sim/time.js';
import { WeatherSystem } from './sim/weather.js';
import { SkySystem } from './sim/sky.js';
import { CloudSystem } from './sim/clouds.js';
import { CombatVFX } from './sim/vfx.js';
import { FuelSystem, TankerSystem } from './sim/fuel.js';
import { AirTrafficSystem } from './sim/traffic.js';
import { Aircraft } from './aircraft/aircraft.js';
import { AutopilotSystem, ILSComputer } from './aircraft/autopilot.js';
import { EjectionSystem } from './aircraft/ejection.js';
import { WeaponSystem } from './combat/weapons.js';
import { TargetSystem } from './combat/targets.js';
import { MissionDirector, MISSIONS } from './combat/missions.js';
import { HUD } from './ui/hud.js';
import { TacticalOverlay } from './ui/tactical.js';
import { KneeboardMap } from './ui/kneeboard.js';
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
    this.combatAudio = new CombatAudio();
    this.betty = new BitchingBetty({ onChime: () => this.audio.click() });
    this._playerHits = 0;
    this._lastRadioCount = 0;
    this._lockedTarget = null;
    this._rwrContacts = [];
    this._missionSnap = null;
    this._fuelState = null;
    this._tankerState = null;
    this._ilsState = null;
    this._flameoutNotified = false;
    on('ils:callout', (ev) => {
      if (this.mode === 'fly' && ev && ev.text) {
        this.betty.announce(ev.text);
        this.ui.toast('ILS · ' + ev.text.toUpperCase());
      }
    });

    this.ui = new UI({
      onStart: () => this.startFlight(),
      onResume: () => this.resume(),
      onRespawn: () => this.respawn(),
      onMenu: () => this.returnToMenu(),
      onMission: (m) => {
        if (MISSIONS[m]) this.ui.toast('MISSION · ' + MISSIONS[m].label);
      },
      onTheater: (th) => this.setTheater(th),
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
    this.vfx = new CombatVFX(this.scene);
    this.weapons = new WeaponSystem(this.scene);
    this.targets = new TargetSystem(this.scene);
    this.missions = new MissionDirector();
    this.tactical = new TacticalOverlay();
    this.autopilot = new AutopilotSystem();
    this.ils = new ILSComputer();
    this.fuel = new FuelSystem();
    this.tanker = new TankerSystem(this.scene);
    this.ejection = new EjectionSystem(this.scene);
    this.traffic = new AirTrafficSystem(this.scene);
    this.kneeboard = new KneeboardMap();
    this.hud = new HUD(document.getElementById('hud'));
    this.hud.setVisible(false);

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('mousedown', (e) => {
      if (this.mode === 'fly' && this.kneeboard.visible && e.button === 0) {
        const f = this.aircraft.flight;
        const picked = this.kneeboard.pickAirportAt(
          e.clientX, e.clientY, window.innerWidth, window.innerHeight,
          f, this.world.airportsNear(f.position.x, f.position.z, 3),
        );
        if (picked) {
          this.audio.click();
          this.ui.toast(`DIVERT · ${picked.code} ${picked.name.toUpperCase()}`);
        }
      }
    });

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

  setTheater(name) {
    const th = THEATERS[name];
    if (!th) return;
    this.sky.setTheater(name);
    this.world.setTheater(name);
    this.world.terrain.refresh(this.camera.position, 16);
    this.ui.toast('THEATER · ' + th.label);
  }

  _startActiveMission(spawn) {
    this.weapons.reset();
    this.vfx.reset();
    this.targets.clear();
    this.autopilot.disengage();
    this.fuel.reset();
    this.tanker.reset(spawn);
    this.ejection.reset();
    this.traffic.reset(this.aircraft.flight);
    this.kneeboard.clearTrack();
    this._playerHits = 0;
    this._flameoutNotified = false;
    this._lockedTarget = null;
    this._rwrContacts = [];
    const specs = this.missions.startMission(this.ui.mission || 'free', spawn, this.world);
    if (specs.length > 0) this.targets.spawnScenario(specs, this.world);
    this._missionSnap = this.missions.update(0, this.aircraft.flight, this.targets.targets, []);
    this._lastRadioCount = this._missionSnap?.radio?.length || 0;
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
      this.betty.setMuted(this.muted);
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
    this.audio.start().then(() => {
      if (this.audio.ctx && this.audio.nodes?.sfxBus) {
        this.combatAudio.attach(this.audio.ctx, this.audio.nodes.sfxBus);
      }
    });
    this.audio.resetEngine();
    this.audio.setPaused(false);
    this.setTheater(this.ui.theater || 'temperate');
    this.aircraft.setMode('cockpit');
    this.aircraft.reset(this.spawn);
    this._startActiveMission(this.spawn);
    this.ui.hideMenu();
    this.ui.hidePause();
    this.ui.hideCrash();
    this.hud.setVisible(true);
    this.mode = 'fly';
    this.weather.night = this.sky.night;
    const mLabel = MISSIONS[this.ui.mission]?.label || 'FREE FLIGHT';
    this.ui.toast(`${mLabel} · SHIFT THROTTLE · SPACE FIRE · TAB WEAPON`);
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
    this._startActiveMission(sp);
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
      brake: i.isDown('KeyB'),
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
    if (i.wasPressed('Tab')) {
      const w = this.weapons.cycleWeapon();
      this.audio.click();
      this.ui.toast('WEAPON · ' + w);
    }
    if (i.wasPressed('Digit1')) { this.weapons.selectWeapon('GUN'); this.audio.click(); this.ui.toast('WEAPON · GUN'); }
    if (i.wasPressed('Digit2')) { this.weapons.selectWeapon('AIM9'); this.audio.click(); this.ui.toast('WEAPON · AIM-9'); }
    if (i.wasPressed('Digit3')) { this.weapons.selectWeapon('MK82'); this.audio.click(); this.ui.toast('WEAPON · MK-82'); }
    if (i.wasPressed('KeyX')) {
      const res = this.weapons.deployFlare(f);
      if (res.deployed) {
        this.combatAudio.flarePop();
        this.ui.toast('FLARES · ' + this.weapons.ammo.FLARE);
      }
    }
    if (i.wasPressed('KeyN')) {
      const on = this.tactical.toggleNVG();
      this.audio.click();
      this.ui.toast(on ? 'NVG · ON' : 'NVG · OFF');
    }
    if (i.wasPressed('KeyZ')) {
      const apMode = this.autopilot.cycleMode(f);
      this.audio.click();
      this.ui.toast('AUTOPILOT · ' + apMode);
    }
    if (i.wasPressed('KeyK')) {
      const vis = this.kneeboard.toggle();
      this.audio.click();
      if (vis) this.input.releasePointerLock();
      this.ui.toast(vis ? 'KNEEBOARD · ON (O = ZOOM, CLICK AIRPORT)' : 'KNEEBOARD · OFF');
    }
    if (i.wasPressed('KeyO') && this.kneeboard.visible) {
      const rng = this.kneeboard.cycleZoom();
      this.audio.click();
      this.ui.toast('MAP RANGE · ' + Math.round(rng / 1000) + ' KM');
    }
    if (i.wasPressed('KeyL')) {
      const wOn = this.traffic.toggleWingman();
      this.audio.click();
      this.ui.toast(wOn ? 'WINGMAN · VIPER 1-2 JOINING' : 'WINGMAN · STAND DOWN');
    }
    if (i.wasPressed('KeyJ') && !f.crashed && !this.ejection.active) {
      if (this.ejection.trigger(f)) {
        this.autopilot.disengage();
        this.combatAudio.missileLaunch();
        this.ui.toast('EJECTION · ACES II — PRESS R TO RESET');
      }
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
      cmd = this.ejection.active ? NEUTRAL_CMD : this.buildCommand();
      this.handleFlightKeys(cmd);
      if (!this.ejection.active) {
        cmd = this.autopilot.computeCommand(this.aircraft.flight, cmd);
      }
      if (this._fuelState && this._fuelState.empty) {
        this.aircraft.flight.targetThrottle = 0;
      }
    }

    if (fly) {
      this.aircraft.update(simDt, cmd, this.weather, this.input, true);
      this.weather.night = this.sky.night;
      const f = this.aircraft.flight;
      if (f.touchdown > 0.2) {
        this.audio.thump(clamp(f.touchdown / 5, 0.15, 1));
        const g = this.ils.gradeTouchdown(f.touchdown, f.rollDeg);
        this.ui.toast(`TOUCHDOWN · ${g.grade} (${Math.round(g.fpm)} FPM)`);
      }
      if (this.ejection.active) {
        const ej = this.ejection.update(simDt, this.world, this.weather);
        if (ej && ej.cameraPos && ej.lookAt) {
          this.camera.position.copy(ej.cameraPos);
          this.camera.up.set(0, 1, 0);
          this.camera.lookAt(ej.lookAt);
        }
      }
      if (f.crashed && this.mode === 'fly' && !this.ejection.active) this.onCrash();
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
      const f = this.aircraft.flight;
      // Combat updates: target lock, firing, ballistics, SAM AI, missions, VFX
      this._lockedTarget = this.targets.findLockTarget(f, this.weapons.selected);
      const triggerHeld = this.input.isDown('Space')
        || (this.aircraft.mode === 'cockpit' && this.input.pointerLocked && (this.input.mouse.buttons & 1));
      if (triggerHeld && !f.crashed) {
        const fired = this.weapons.fire(f, this._lockedTarget);
        if (fired.fired) {
          if (fired.type === 'GUN') {
            this.combatAudio.cannonShot();
            this.vfx.triggerMuzzleFlash(f);
          } else if (fired.type === 'AIM9') {
            this.combatAudio.missileLaunch();
            this.ui.toast('FOX 2 · AIM-9 AWAY');
          } else if (fired.type === 'MK82') {
            this.combatAudio.bombRelease();
            this.ui.toast('PICKLE · MK-82 AWAY');
          }
        }
      }

      const wEvents = this.weapons.update(simDt, f, this.world, this.targets.targets);
      for (const ev of wEvents) {
        if (ev.kind === 'trail') {
          this.vfx.spawnTrail(ev.position, ev.color, ev.size);
        } else if (ev.kind === 'impact') {
          const scale = ev.weapon === 'MK82' ? 2.2 : (ev.weapon === 'AIM9' ? 1.5 : 0.45);
          this.vfx.spawnExplosion(ev.position, scale);
          const dist = Math.hypot(
            ev.position.x - f.position.x,
            ev.position.y - f.position.y,
            ev.position.z - f.position.z,
          );
          if (ev.weapon !== 'GUN' || ev.hitTargetId) this.combatAudio.explosion(dist);
          const destroyed = this.targets.applyImpact(ev);
          if (destroyed.length > 0) {
            this.missions.notifyDestroyed(destroyed);
            for (const d of destroyed) {
              this.vfx.spawnExplosion(d.position, 2.5);
              if (d.kind !== 'BANDIT') this.vfx.spawnSmokePlume(d.position, 90);
              this.ui.toast(d.kind === 'BANDIT' ? `SPLASH · ${d.label}` : `SHACK · ${d.label}`);
            }
          }
        }
      }

      const tOut = this.targets.update(simDt, f, this.world, this.weapons.flares);
      this._rwrContacts = tOut.rwrContacts || [];
      for (const m of this.targets.enemyMissiles) {
        if (Math.random() < 0.45) this.vfx.spawnTrail(m.position, 0xf2e8dc, 2.2);
      }
      for (const ev of tOut.events || []) {
        if (ev.kind === 'playerHit') {
          this._playerHits++;
          this.vfx.spawnExplosion(ev.position, 1.8);
          this.combatAudio.explosion(25);
          this.missions.notifyPlayerHit();
          if (this._playerHits >= 2) {
            f._crash('SAM IMPACT — AIRFRAME DESTROYED');
            this.onCrash();
          } else {
            this.ui.toast('WARNING · SAM PROXIMITY HIT — DEFEND & FLARE!');
          }
        }
      }

      const prevRadioHead = this._missionSnap?.radio?.[this._missionSnap.radio.length - 1]?.text;
      this._missionSnap = this.missions.update(simDt, f, this.targets.targets, this._rwrContacts);
      const nextRadioHead = this._missionSnap?.radio?.[this._missionSnap.radio.length - 1]?.text;
      if (nextRadioHead && nextRadioHead !== prevRadioHead) {
        this.combatAudio.radioBeep();
      }

      const vfxState = this.vfx.update(simDt, f, this.weather, this.camera);
      if (vfxState.sonicBoom) {
        this.combatAudio.sonicBoom();
        this.ui.toast('MACH 1.0 · SONIC BOOM');
      }

      const glocState = this.tactical.update(simDt, f);

      // Wave 3 systems: Tanker, Fuel, Traffic/Wingman, ILS, Kneeboard & Bitching Betty
      this._tankerState = this.tanker.update(simDt, f);
      this._fuelState = this.fuel.update(simDt, f, !!this._tankerState?.contact);
      if (this._fuelState.bingoTriggered) {
        this.ui.toast('BINGO FUEL · ' + Math.round(this._fuelState.fuelLb) + ' LB');
      }
      if (this._fuelState.empty && !this._flameoutNotified) {
        this._flameoutNotified = true;
        this.ui.toast('FLAMEOUT · OUT OF FUEL');
      }
      this.traffic.update(simDt, f, this.weather);
      this.kneeboard.recordPosition(f.position.x, f.position.z);

      let rwrHighest = 'NONE';
      const rank = { NONE: 0, SEARCH: 1, LOCK: 2, LAUNCH: 3 };
      for (const c of this._rwrContacts) {
        const st = c.isMissile ? 'LAUNCH' : (c.state || 'SEARCH');
        if ((rank[st] || 0) > rank[rwrHighest]) rwrHighest = st;
      }
      this.combatAudio.update(simDt, {
        weapon: this.weapons.selected,
        hasLock: !!this._lockedTarget,
        rwrHighest,
        gStrain: glocState.gStrain,
        paused: false,
      });

      const t = this.aircraft.telemetry(this.weather, this.time, this.sky);
      this._ilsState = this.ils.update(simDt, f, t.airport);
      this.betty.update(simDt, {
        onGround: f.onGround,
        crashed: f.crashed,
        aglFt: t.aglFt,
        vsFpm: t.vsFpm,
        stall: f.stall,
        kts: t.kts,
        bingoFuel: !!this._fuelState?.bingo,
        missileLaunch: rwrHighest === 'LAUNCH',
      });

      t.timeScale = this.time.scale;
      t.weather = WEATHER[this.weather.presetName].label;
      t.clock = this.time.clock;
      t.sideSlip = this.aircraft.flight.beta;
      t.fuelLb = this._fuelState?.fuelLb ?? 7000;
      t.fuelFraction = this._fuelState?.fraction ?? 1;
      t.refueling = !!this._fuelState?.refueling;
      t.autopilot = this.autopilot.mode;
      t.ils = this._ilsState;
      this.hud.update(simDt, t, {
        overlay: this.tactical,
        kneeboard: this.kneeboard,
        kneeboardState: this.kneeboard.visible ? {
          flight: f,
          heading: t.heading,
          heightAt: (x, z) => this.world.heightAt(x, z),
          airports: this.world.airportsNear(f.position.x, f.position.z, 3),
          targets: this.targets.targets,
          tanker: this._tankerState,
          steerpoint: this._missionSnap?.steerpoint || null,
          windDir: t.windDir,
          windKts: t.windKts,
        } : null,
        telemetry: t,
        camera: this.camera,
        weapons: this.weapons,
        lockedTarget: this._lockedTarget,
        targets: this.targets.targets,
        rwrContacts: this._rwrContacts,
        mission: this._missionSnap,
      });
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
        const mInfo = this._missionSnap && this._missionSnap.status !== 'FREE'
          ? ` · ${this._missionSnap.status} ${this._missionSnap.destroyedCount}/${this._missionSnap.totalObjectives} · PTS ${this._missionSnap.score}`
          : '';
        if (ap) {
          this.ui.setATC(
            `<b>${ap.code}</b> ${ap.name}${mInfo}<br>` +
            `RWY ${String(Math.round(ap.heading / 10) || 36).padStart(2, '0')} · ` +
            `${(t.dist / 1000).toFixed(1)} KM · ${String(Math.round(t.bearing)).padStart(3, '0')}°<br>` +
            `${t.clock} · ×${this.time.scale} · ${WEATHER[this.weather.presetName].label}`,
          );
        } else {
          this.ui.setATC(`NO AIRPORT IN RANGE${mInfo}<br>${t.clock} · ×${this.time.scale}`);
        }
      }
    } else {
      this.vfx.update(simDt, this.aircraft.flight, this.weather, this.camera);
      this.combatAudio.update(simDt, { paused: true });
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
  attachMcpBridge(app);
});