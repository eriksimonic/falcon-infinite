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
import { TerrainEdits, setActiveTerrainEdits } from './world/terrain_edits.js';
import { CarrierGroup } from './world/carrier.js';
import { TimeSystem } from './sim/time.js';
import { WeatherSystem } from './sim/weather.js';
import { SkySystem } from './sim/sky.js';
import { CloudSystem } from './sim/clouds.js';
import { CombatVFX } from './sim/vfx.js';
import { FuelSystem, TankerSystem } from './sim/fuel.js';
import { AirTrafficSystem } from './sim/traffic.js';
import { Aircraft } from './aircraft/aircraft.js';
import { updateF16Visual } from './aircraft/f16.js';
import { ReplaySystem } from './aircraft/replay.js';
import { AutopilotSystem, ILSComputer } from './aircraft/autopilot.js';
import { EjectionSystem } from './aircraft/ejection.js';
import { WeaponSystem } from './combat/weapons.js';
import { TargetSystem } from './combat/targets.js';
import { MissionDirector, MISSIONS } from './combat/missions.js';
import { CanyonRunSystem } from './combat/canyon_run.js';
import { PostFXSystem } from './sim/postfx.js';
import { FlightJuiceSystem } from './sim/juice.js';
import { WeaponCamSystem, PhotoModeController, FreeCamController } from './aircraft/weapon_cam.js';
import { HUD } from './ui/hud.js';
import { TacticalOverlay } from './ui/tactical.js';
import { KneeboardMap } from './ui/kneeboard.js';
import { InspectorMap, camYawToHeadingDeg } from './ui/inspector_map.js';
import { TerrainEditorUI } from './ui/terrain_editor.js';
import { AutopilotPromptUI } from './ui/autopilot_menu.js';
import { UI } from './ui/menu.js';
import { spawnPoint, airportNear, airportsNear, setActiveDEM, setCustomAirports, terrainHeight } from './world/terrain.js';
import { loadVipavaDEM, loadVipavaOSM, loadVipavaBuildings, loadVipavaWater } from './world/dem.js';
import { settlementsNear, clearSettlementCaches } from './world/settlements.js';
import { clamp, smoothstep } from './world/noise.js';

const NEUTRAL_CMD = {
  pitch: 0, roll: 0, yaw: 0, throttleDelta: 0,
  gearToggle: false, flapsToggle: false, brake: false,
};

// Feature 41: localStorage slot holding the last Free Cam pose + environment.
const LAST_VIEW_KEY = 'falcon.lastView.v1';
// Sticky menu choices (quality/theater/mission/weather/wind/hour) live in their
// own slot so a restored camera pose can never overwrite them.
const SETTINGS_KEY = 'falcon.settings.v1';
// FreeCamController clamps its speed to 15..5000 m/s; mirror that on restore.
const LAST_VIEW_SPEED_MIN = 15;
const LAST_VIEW_SPEED_MAX = 5000;

// Map / Free Cam "Spawn F-16" drop: 5,000 ft and 300 kts, heading wherever the
// Free Camera is looking. The altitude is a floor so a spawn over the Julian
// Alps still clears the peaks by ~1,000 ft.
const MAP_SPAWN_ALT_M = 5000 * 0.3048;       // 1524 m (5,000 ft MSL)
const MAP_SPAWN_SPEED_MS = 300 * 0.514444444; // 154.33 m/s (300 kts)
const MAP_SPAWN_MIN_AGL_M = 305;              // ~1,000 ft AGL floor over high peaks

// VIPER-OPTICS: per-frame scratch for projecting the sun disc into screen
// space. Module-level so the render loop never allocates a Vector3.
const _sunProj = new THREE.Vector3();
const _camFwd = new THREE.Vector3();

class App {
  constructor() {
    this.canvas = document.getElementById('scene');
    this.scene = new THREE.Scene();
    // Feature 41: read the sticky menu choices first — the quality preset must
    // exist before WebGLRenderer / World / PostFX initialise, otherwise a
    // returning player boots at `medium` and starts over.
    const savedSettings = this._loadSettings();
    this._savedSettings = savedSettings;
    this.preset = (savedSettings.quality && QUALITY[savedSettings.quality]) || QUALITY.medium;
    this.mode = 'boot';
    this.ready = false;
    this.paused = false;
    // PERF-19: dynamic resolution state. `_dynScale` multiplies the preset
    // pixel ratio; the EMA and the two dwell timers decide when to step it.
    // Initialised before the renderer so `_pixelRatio()` is safe at setup.
    this._dynScale = 1.0;
    this._frameEmaMs = 16.6;
    this._dynSlowSec = 0;
    this._dynFastSec = 0;
    this._dynLastResizeSec = -10;
    this._dynClockSec = 0;
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
      // No canvas MSAA: Medium/High run PostFX, which rasterises the scene into
      // a 4x MSAA HalfFloat target and then FXAA the tonemapped result, so the
      // default framebuffer only ever receives the FXAA quad. Low already used
      // antialias: false (PERF-04).
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(this._pixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CONFIG.render.exposure;
    // Real-time directional shadows (off on the low preset, which is built for
    // integrated GPUs). r187 removed PCFSoftShadowMap — it warned once and fell
    // back to PCFShadowMap (5 hardware PCF taps) — so request PCF directly.
    this.renderer.shadowMap.enabled = !!this.preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

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
    this._autoLandAirport = null;
    // Press-and-hold H: a quick tap toggles help on keyup, a 450 ms hold
    // hands the jet to the smart autopilot (auto-land / auto-refuel cycle).
    this._keyHDownAt = 0;
    this._keyHHeldFired = false;
    this._ilsState = null;
    this._divertAirport = null;
    this._meatballState = null;
    // Baked Vipava geography for the kneeboard map: DEM origin + named places.
    this._vipavaGeoOrigin = null;
    this._vipavaPlaces = null;
    this._cloudMist = 0;
    this._rwrHighest = 'NONE';
    this._replayActive = false;
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
        this._saveSettings();
      },
      onTheater: (th) => {
        this.setTheater(th);
        this._saveSettings();
      },
      onWeather: (w) => {
        this.weather.setPreset(w, true);
        this.ui.toast('WEATHER · ' + WEATHER[w].label);
        this._saveSettings();
      },
      onWind: (w) => {
        this.weather.setWindPreset(w, true);
        this.ui.toast('WIND · ' + WIND[w].label);
        this._saveSettings();
      },
      onQuality: (q) => {
        this.setQuality(q);
        this._saveSettings();
      },
      onTime: (h) => {
        this.time.setHour(h);
        this.ui.toast('TIME ' + this.time.clock);
        this._saveSettings();
      },
      // Feature 33: floating Photo Mode bar buttons.
      onPhotoSave: () => this._savePhoto(),
      onPhotoExit: () => this.exitPhotoMode(),
      onFreeCamMap: () => this.toggleInspectorMap(),
      onFreeCamSpawn: () => this.spawnAircraftAt(
        this.freeCam.position.x,
        this.freeCam.position.z,
        camYawToHeadingDeg(this.freeCam.yaw),
      ),
      onFreeCamExit: () => this.exitFreeCam(),
    });

    // Feature 41: paint the saved pills and adopt their values *before* the
    // time / weather systems read this.ui.hour and this.ui.weather below.
    this.ui.applySettings(savedSettings);

    this.time = new TimeSystem();
    this.time.setHour(this.ui.hour);
    this.weather = new WeatherSystem(this.ui.weather, this.ui.wind);
    this.sky = new SkySystem(this.scene, this.renderer);
    // Feature 41: the sky builds its shadow map at 2048²; match the preset that
    // was actually restored (medium/low must drop back to 1024² / off).
    this.sky.setShadowQuality?.(this.preset.name);

    this.spawn = this.chooseSpawn();
    // Kept so switching back from a baked theater restores the procedural start.
    this._proceduralSpawn = this.spawn;
    this.world = new World(this.scene, this.preset);
    // Offshore carrier group. Its deck elevation is published through
    // world.heightAt() so the jet lands, taxis and catapults like any runway.
    this.carrier = new CarrierGroup(this.scene);
    this.carrier.placeNear(this.spawn.x, this.spawn.z);
    this.world.carrier = this.carrier;
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
    this.replay = new ReplaySystem();
    this.hud = new HUD(document.getElementById('hud'));
    this.hud.setVisible(false);

    // Hold-H Smart Autopilot Command Prompt + live flight-plan strip. The
    // callbacks are the only action surface: the module owns its own DOM and
    // never installs a global key hook (main.js routes keys to it).
    this.autopilotPrompt = new AutopilotPromptUI({
      onSelectLand: (ap) => this._startAutoLand(ap),
      onSelectRefuel: () => this._startAutoRefuel(),
      onSelectHold: () => this._startCruiseHold(),
      onDisengage: () => this._disengageAutopilot(),
      onClose: () => {
        if (this.mode === 'fly' && !this.freeCam.active && !this.terrainEditor.active) {
          this.input.requestPointerLock();
        }
      },
    });

    // Feature 30/32 runtime systems: Soča canyon gates, selective bloom,
    // flight juice, weapon follow-cam and the frozen-photo camera.
    this.canyonRun = new CanyonRunSystem(this.scene);
    this.postfx = new PostFXSystem(this.renderer, this.scene, this.aircraft.camera, {
      enabled: this.preset.name !== 'low',
    });
    this.juice = new FlightJuiceSystem();
    this.weaponCam = new WeaponCamSystem();
    this.photoMode = new PhotoModeController();
    this.freeCam = new FreeCamController();
    this._freeCamReturnMode = 'fly';
    this._freeCamBarTimer = 0;
    // Feature 41: throttle for the last-view autosave, and the theater that is
    // actually loaded right now (so a restore knows whether to switch).
    this._lastViewTimer = 0;
    this._activeTheater = null;
    // Reused smart-autopilot context: one object for the whole flight so the
    // per-frame computeCommand call allocates nothing.
    this._apContext = {
      airport: null,
      tanker: null,
      fuel: null,
      terrainHeight: (x, z) => this.world.heightAt(x, z),
    };
    this._vipavaRoads = [];
    this._vipavaWater = null;
    this._vipavaLandmarks = null;
    // Throttle clock for mid-stroke object re-grounding in the F9 editor.
    this._lastRegroundAt = 0;
    this.inspectorMap = new InspectorMap({
      onTeleport: (x, z, agl, closeMap) => {
        const ground = this.world.heightAt(x, z);
        this.freeCam.teleport(x, ground + agl, z, this.freeCam.yaw, -0.38);
        if (closeMap) {
          this.inspectorMap.hide();
        } else {
          this.inspectorMap.render(this._inspectorState());
        }
        this.ui.toast(`TELEPORT · (${Math.round(x)}, ${Math.round(z)}) · AGL ${agl} M`);
        this._saveLastView();
      },
      onSpawnAircraft: (x, z, heading) => this.spawnAircraftAt(x, z, heading),
      onTime: (h) => {
        this.time.setHour(h);
        this._saveLastView();
      },
      onWeather: (w) => {
        this.weather.setPreset(w, true);
        this._saveLastView();
      },
      onClose: () => {
        if (this.freeCam.active) this.input.requestPointerLock();
      },
    });
    this.inspectorMap.attach(document.getElementById('inspector-map'));

    // F9 Terrain & Color Paint Editor: sparse height deltas + an RGBA tint grid
    // over the live Vipava DEM. Headless/Node-safe; the panel and the 3D brush
    // ring are only built once the editor is actually shown.
    this.terrainEdits = new TerrainEdits();
    this._terrainEditsLoaded = false;
    this._editorOpenedFreeCam = false;
    this.terrainEditor = new TerrainEditorUI({
      scene: this.scene,
      edits: this.terrainEdits,
      onHeightChanged: (bounds) => this._onTerrainEditsHeightChanged(bounds),
      onStrokeEnd: (ev) => this._onTerrainEditsStrokeEnd(ev),
      onSaveProject: (jsonObj) => this._saveTerrainEditsToProject(jsonObj),
      onTeleport: (spot) => this._teleportTerrainEditor(spot),
      onExit: () => this.exitTerrainEditor(),
      onToast: (msg) => this.ui.toast(msg),
    });

    // Painting needs the OS cursor: capture-phase canvas handlers, so neither
    // the camera nor Input._onMouseDown can grab the pointer lock mid-stroke.
    window.addEventListener('pointerdown', (e) => {
      if (!this.terrainEditor.active) return;
      if (e.target !== this.canvas) return;
      if (this.terrainEditor.isPointerOverUI(e.target)) return;
      this.terrainEditor.onPointerDown(
        e, this.camera, this.canvas, (x, z) => this.world.heightAt(x, z),
      );
      e.stopPropagation();
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (!this.terrainEditor.active) return;
      const res = this.terrainEditor.onPointerMove(
        e, this.camera, this.canvas, (x, z) => this.world.heightAt(x, z),
      );
      // Right-drag look: the editor owns the deltas, the free camera applies them.
      if (res && (res.lookDx || res.lookDy)) this.freeCam.look(res.lookDx, res.lookDy);
    }, true);
    window.addEventListener('pointerup', (e) => {
      if (this.terrainEditor.active) this.terrainEditor.onPointerUp(e);
    });
    window.addEventListener('contextmenu', (e) => {
      if (this.terrainEditor.active) e.preventDefault();
    });
    // The canvas mousedown handler inside Input (src/core/input.js) is what
    // actually requests the pointer lock; swallow it at capture time instead.
    window.addEventListener('mousedown', (e) => {
      if (this.terrainEditor.active && e.target === this.canvas) e.stopPropagation();
    }, true);
    this._canyonState = null;
    this._juiceState = null;
    // AERO-2: reusable loadout scratch — live fuel/ordnance pushed into the
    // flight model each frame without allocating a fresh object.
    this._loadoutScratch = { fuelLb: 0, aim9: 0, mk82: 0, bffg: 0 };
    // VIPER-OPTICS: one reusable optics scratch, written every frame in the
    // render loop so the helmet-cam lens never allocates.
    this._opticsScratch = {
      cockpitView: false,
      speedNorm: 0,
      gLoad: 1,
      afterburner: false,
      machPulse: 0,
      aglNorm: 0,
      freeCam: false,
      menu: false,
      night: 0,
      sunScreenX: 0.5,
      sunScreenY: 0.5,
      sunFlare: 0,
      sunColor: null,
    };
    this._weaponCamState = null;
    this._canyonFinishAnnounced = false;
    this._photoDrag = null;
    this.postfx.resize(window.innerWidth, window.innerHeight, this._pixelRatio());

    // Feature 33: Photo Mode drag-orbit. Capture phase, so the canvas never
    // grabs the pointer lock while the simulation is frozen for the shot.
    window.addEventListener('mousedown', (e) => {
      if (!this.photoMode.active || e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('#photo-bar')) return;
      e.preventDefault();
      e.stopPropagation();
      this._photoDrag = { x: e.clientX, y: e.clientY };
    }, true);
    window.addEventListener('mousemove', (e) => {
      if (!this._photoDrag) return;
      const dx = e.clientX - this._photoDrag.x;
      const dy = e.clientY - this._photoDrag.y;
      this._photoDrag.x = e.clientX;
      this._photoDrag.y = e.clientY;
      this.photoMode.orbit(dx, dy);
    }, true);
    window.addEventListener('mouseup', () => { this._photoDrag = null; }, true);

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));

    // Feature 41: flush the Free Cam pose on tab hide / reload. Guarded so a
    // headless import of this module never touches a missing global.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this._saveLastView());
      window.addEventListener('pagehide', () => this._saveLastView());
      // Tab switch / mobile backgrounding: pagehide does not always fire, so
      // flush as soon as the document is hidden.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this._saveLastView();
      });
    }
    window.addEventListener('mousedown', (e) => {
      if (this.mode === 'fly' && this.kneeboard.visible && e.button === 0) {
        const f = this.aircraft.flight;
        const picked = this.kneeboard.pickAirportAt(
          e.clientX, e.clientY, window.innerWidth, window.innerHeight,
          f, this._kneeboardAirports(f),
        );
        if (picked) {
          this._divertAirport = picked;
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

      // Feature 33: Vipava Valley is the default showcase — stream the real
      // DEM + OSM extract (traffic included) during boot so the menu opens
      // over Ajdovščina instead of the procedural placeholder.
      if (this.ui.theater === 'vipava') {
        this.ui.setBootProgress(0.96, 'STREAMING VIPAVA VALLEY');
        await raf();
        await this.setTheater('vipava');
        this.aircraft.reset(this.spawn);
        this._syncAircraftModel();
      } else if (this.ui.theater !== 'temperate' && THEATERS[this.ui.theater]) {
        // Feature 41: a saved theater (desert, …) must be loaded now too, or
        // the menu would advertise a map the camera is not actually over.
        this.ui.setBootProgress(0.96, 'STREAMING ' + THEATERS[this.ui.theater].label);
        await raf();
        await this.setTheater(this.ui.theater);
        this.aircraft.reset(this.spawn);
        this._syncAircraftModel();
      }

      this.ui.setBootProgress(1, 'READY');
      await new Promise((r) => setTimeout(r, 260));
      this.ui.hideBoot();
      this.aircraft.setMode('cockpit');
      this.mode = 'menu';
      this.ready = true;
      this.ui.showMenu();
      this.last = performance.now();
      // Feature 41: if the last session ended inside Free Cam, drop straight
      // back onto that pose. No pointer lock here — it needs a user gesture,
      // and clicking the canvas already grabs it while Free Cam is active.
      await this._restoreLastView();
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

  /** Effective device pixel ratio under the active quality preset. */
  _pixelRatio() {
    // PERF-19: the dynamic scale multiplies the preset cap so heavy scenes can
    // shed fillrate on the GPU. `window` is guarded for headless Node imports.
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(dpr, this.preset.pixelRatio) * this._dynScale;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(this._pixelRatio());
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Feature 32: bloom render targets follow the canvas or the glare smears.
    this.postfx.resize(w, h, this._pixelRatio());
  }

  setQuality(name) {
    const q = QUALITY[name];
    if (!q) return;
    this.preset = q;
    // PERF-19: a quality switch starts fresh at full dynamic scale.
    this._dynScale = 1.0;
    this._dynSlowSec = 0;
    this._dynFastSec = 0;
    this.renderer.setPixelRatio(this._pixelRatio());
    this.renderer.shadowMap.enabled = !!q.shadows;
    this.sky.setShadowQuality?.(q.name);
    this.renderer.shadowMap.needsUpdate = true;
    this.world.setPreset(q);
    this.postfx.setEnabled(q.name !== 'low');
    this.resize();
    this.ui.toast('QUALITY · ' + name.toUpperCase());
    // Feature 41: keep the menu pill in sync and persist the choice so the next
    // page load starts on the same preset.
    this.ui?.applySettings?.({ quality: name });
    this._saveSettings();
    this._saveLastView();
  }

  /**
   * Switch theater. `vipava` streams the baked real-world DEM + OSM extract and
   * re-grounds every system on it; `temperate` / `desert` drop the baked data
   * and restore the exact procedural terrain and spawn.
   */
  async setTheater(name) {
    const th = THEATERS[name];
    if (!th) return;
    this._activeTheater = name;
    this.sky.setTheater(name);
    this.world.setTheater(name);
    // Feature 33: the canyon course belongs to the Vipava height field; tear it
    // down on every theater switch (startFlight re-arms it after the DEM loads).
    this.canyonRun.stop();
    this._canyonState = null;

    if (name === 'vipava') {
      let dem = null;
      let osm = null;
      let buildingsBin = null;
      let water = null;
      try {
        [dem, osm, buildingsBin, water] = await Promise.all([
          loadVipavaDEM(
            th.demUrl || './media/vipava_dem.png',
            th.metaUrl || './media/vipava_meta.json',
          ).catch((err) => {
            console.warn('VIPAVA · DEM load failed, keeping procedural terrain', err);
            return null;
          }),
          loadVipavaOSM().catch(() => null),
          loadVipavaBuildings().catch(() => null),
          loadVipavaWater().catch(() => null),
        ]);
      } catch (err) {
        console.warn('VIPAVA · dataset load failed, keeping procedural terrain', err);
      }

      const customAirports = dem?.meta?.airports || null;
      if (dem) {
        setActiveDEM(dem);
        // Procedural site caches may hold settlements chosen against the old
        // procedural land (now open sea); rebuild them on the real terrain.
        clearSettlementCaches();
        // The real fields (LJAJ, LJPO, LJDI, LIPQ, LJPZ) replace the procedural
        // grid, so the terrain flattens and runways are paved where they are.
        setCustomAirports(customAirports);
        // Feature 38/39/41: full 53k binary OSM buildings + urban ground zones,
        // falling back seamlessly to the compact JSON list if needed.
        this.world.buildings.setCustomBuildings(
          buildingsBin?.records || osm?.buildings || null,
          osm?.urbanZones || null,
        );
        this.world.roads.setCustomRoads(osm?.roads || null);
        // Feature 31/33/40: hand the H4 + valley arteries (with bridge tags)
        // to the traffic pools so head/tail-light streaks ride over viaducts.
        this.world.roadTraffic.setCustomRoads(
          osm?.roads || [],
          (x, z) => this.world.heightAt(x, z),
        );
        // Real OSM rivers/lakes are draped on the freshly active HD DEM, so the
        // water has to be built after setActiveDEM/setCustomAirports above.
        this.world.inlandWater.setWaterData(water);
        // Iconic landmarks are re-grounded per-pier & per-corner on the HD DEM.
        this.world.landmarks.setLandmarks(osm?.landmarks || null);
        this._vipavaRoads = osm?.roads || [];
        this._vipavaWater = water || null;
        this._vipavaLandmarks = osm?.landmarks || null;
        // Kneeboard map origin: the DEM centre is Ajdovščina (LJAJ).
        this._vipavaGeoOrigin = dem.meta
          ? { lat0: dem.meta.lat0, lon0: dem.meta.lon0 }
          : { lat0: 45.8878, lon0: 13.8869 };
        this._vipavaPlaces = [
          { name: 'Ajdovscina', x: 0, z: 0, kind: 'city' },
          { name: 'Vipava', x: 5380, z: 4150, kind: 'town' },
          { name: 'Nova Gorica', x: -18700, z: -7500, kind: 'city' },
          { name: 'Gorizia', x: -21000, z: -6200, kind: 'city' },
          { name: 'Solkan', x: -18200, z: -10000, kind: 'town' },
          { name: 'Dornberk', x: -11660, z: -90, kind: 'town' },
          { name: 'Branik', x: -7590, z: 3820, kind: 'town' },
          { name: 'Sempas', x: -11100, z: -4730, kind: 'town' },
          { name: 'Crnice', x: -8360, z: -2350, kind: 'town' },
          { name: 'Rence', x: -16890, z: -270, kind: 'town' },
          { name: 'Miren', x: -21650, z: -940, kind: 'town' },
          { name: 'Podnanos', x: 7000, z: 10150, kind: 'town' },
          { name: 'Tolmin', x: -12600, z: -32900, kind: 'town' },
          { name: 'Trieste', x: -8300, z: 26400, kind: 'city' },
          { name: 'Koper', x: -12200, z: 37800, kind: 'city' },
          { name: 'Izola', x: -17430, z: 39060, kind: 'town' },
          { name: 'Piran', x: -24800, z: 39800, kind: 'town' },
          { name: 'Postojna', x: 25400, z: 12600, kind: 'town' },
          { name: 'Sezana', x: -1100, z: 19800, kind: 'town' },
          { name: 'Idrija', x: 10700, z: -12800, kind: 'town' },
          { name: 'Monfalcone', x: -27500, z: 8900, kind: 'city' },
          { name: 'Grado', x: -39000, z: 23500, kind: 'town' },
          { name: 'Stanjel', x: -3200, z: 7100, kind: 'town' },
          { name: 'Nanos', x: 12900, z: 12900, kind: 'landmark' },
          ...(this.world.landmarks?.landmarks || []).map((l) => ({ name: l.name, x: l.x, z: l.z, kind: 'landmark' })),
        ];
        this.inspectorMap.setTheaterData({
          places: this._vipavaPlaces,
          landmarks: this.world.landmarks?.landmarks || [],
          roads: this._vipavaRoads,
          water: this._vipavaWater,
          geoOrigin: this._vipavaGeoOrigin,
        });
        // Ajdovscina Airfield (LJAJ) sits at the DEM centre and runs East-West:
        // start on the RWY 09 threshold, nose east into the sunrise.
        const ljaj = customAirports?.find((ap) => ap.id === 'LJAJ' || ap.code === 'LJAJ')
          || customAirports?.[0]
          || null;
        this.spawn = ljaj
          ? this.spawnForAirport(ljaj)
          : {
            x: 0,
            z: 0,
            y: terrainHeight(0, 0) + CONFIG.aircraft.gearHeight + 0.02,
            heading: 90,
            airport: null,
          };
        // Gulf of Trieste is ~28 km south of the valley, well offshore.
        this.carrier.placeNear(-24000, 28000);

        // F9 painter: bind the colour grid to the terrain shader and install the
        // height-delta singleton, so strokes land on the real Vipava DEM.
        setActiveTerrainEdits(this.terrainEdits);
        this.world.terrain.setEditColorTexture(
          this.terrainEdits.createColorTexture(),
          this.terrainEdits.bounds,
        );
        if (!this._terrainEditsLoaded) {
          this._terrainEditsLoaded = true;
          const proj = await TerrainEdits.fetchProjectEdits('./media/vipava_edits.json');
          if (proj) this.terrainEdits.importJSON(proj);
          // Layer the in-progress draft (strokes since the last project save)
          // over the shipped edits instead of losing the user's work.
          this.terrainEdits.loadFromLocalStorage();
        }
      } else {
        setActiveDEM(null);
        setCustomAirports(null);
        this.world.buildings.setCustomBuildings(null);
        this.world.roads.setCustomRoads(null);
        this.world.roadTraffic.clear();
        this.world.inlandWater.setWaterData(null);
        this.world.landmarks.setLandmarks(null);
        this._vipavaGeoOrigin = null;
        this._vipavaPlaces = null;
        this._vipavaLandmarks = null;
        if (this._proceduralSpawn) this.spawn = this._proceduralSpawn;
      }
    } else {
      setActiveDEM(null);
      setCustomAirports(null);
      this.world.buildings.setCustomBuildings(null);
      this.world.roads.setCustomRoads(null);
      this.world.roadTraffic.clear();
      this.world.inlandWater.setWaterData(null);
      this.world.landmarks.setLandmarks(null);
      this._vipavaGeoOrigin = null;
      this._vipavaPlaces = null;
      this._vipavaLandmarks = null;
      if (this._proceduralSpawn) this.spawn = this._proceduralSpawn;
      this.carrier.placeNear(this.spawn.x, this.spawn.z);
    }

    // Only the baked Vipava field carries user paint: drop the delta hook and
    // hide the overlay on every other theater.
    if (name !== 'vipava') {
      setActiveTerrainEdits(null);
      this.world.terrain.clearEditColorTexture();
    }

    // Terrain, forests, cities and asphalt were all built for the previous
    // height field: repaint them around the new start point.
    this.camera.position.set(this.spawn.x, this.spawn.y + 8, this.spawn.z);
    this.world.terrain.refresh(this.camera.position, 16);
    this.world.buildings.rebuild(this.camera);
    this.world.roads.update(this.camera);
    this.world.vegetation.rebuild(this.camera);
    // Swap the runway set as well: drop the old theater's asphalt, then let
    // the system build whichever fields this theater now reports near us.
    this.world.airports.clear();
    this.world.airports.update(0.016, this.camera, this.weather, this.sky);
    this.ui.toast('THEATER · ' + th.label);
  }

  /** Airports shown on / pickable from the kneeboard: nearest fields + carrier deck. */
  _kneeboardAirports(flight) {
    const airports = this.world.airportsNear(flight.position.x, flight.position.z, 3);
    const deck = this.carrier ? this.carrier.getDeckPoint() : null;
    if (deck) airports.push(deck);
    return airports;
  }

  _startActiveMission(spawn) {
    this.weapons.reset();
    this.vfx.reset();
    this.targets.clear();
    this.world.buildings.resetDamage();
    this.autopilot.disengage();
    this.fuel.reset();
    this.tanker.reset(spawn);
    this.ejection.reset();
    this.traffic.reset(this.aircraft.flight);
    this.kneeboard.clearTrack();
    this._divertAirport = null;
    this.replay.reset();
    this._playerHits = 0;
    this._flameoutNotified = false;
    this._lockedTarget = null;
    this._rwrContacts = [];
    // Feature 30: the canyon course only exists for the Soča Canyon Run.
    this._canyonFinishAnnounced = false;
    if (this.ui.mission === 'soca_run') this.canyonRun.start(this.world);
    else this.canyonRun.stop();
    this._canyonState = this.canyonRun.active ? this.canyonRun.getState() : null;
    const specs = this.missions.startMission(this.ui.mission || 'free', spawn, this.world);
    if (specs.length > 0) this.targets.spawnScenario(specs, this.world);
    this._missionSnap = this.missions.update(0, this.aircraft.flight, this.targets.targets, []);
    this._lastRadioCount = this._missionSnap?.radio?.length || 0;
  }

  onKey(e) {
    const code = e.code;
    // Smart Autopilot Command Prompt owns 1-5 / 0 / Esc while it is open, so
    // digits never reach the camera views and Esc never pauses the sim.
    if (this.autopilotPrompt && this.autopilotPrompt.open) {
      if (this.autopilotPrompt.handleKey(code)) {
        e.preventDefault();
        return;
      }
    }
    // F9: in-game Terrain & Color Paint Editor (works from flight and Free Cam).
    if (code === 'F9' && this.ready) {
      e.preventDefault();
      this.toggleTerrainEditor();
      return;
    }
    const isFreeCamToggle = (e.ctrlKey && !e.shiftKey && !e.altKey && code === 'KeyF') || code === 'F7';
    if (isFreeCamToggle && this.ready) {
      e.preventDefault();
      this.toggleFreeCam();
      return;
    }
    if (this.freeCam.active) {
      if (this.terrainEditor.active) {
        if ((e.ctrlKey || e.metaKey) && code === 'KeyZ') {
          e.preventDefault();
          this.terrainEditor.triggerUndo();
          return;
        }
        if (code === 'BracketLeft') {
          e.preventDefault();
          this.terrainEditor.adjustRadius(0.82);
          return;
        }
        if (code === 'BracketRight') {
          e.preventDefault();
          this.terrainEditor.adjustRadius(1.22);
          return;
        }
        if (code === 'Escape') {
          this.exitTerrainEditor();
          return;
        }
      }
      if (code === 'KeyM' || code === 'Tab') {
        e.preventDefault();
        this.toggleInspectorMap();
        return;
      }
      if (code === 'Escape') {
        if (this.inspectorMap.visible) {
          this.inspectorMap.hide();
        } else {
          this.exitFreeCam();
        }
        return;
      }
      if (this.inspectorMap.visible) return;
      if (code === 'BracketLeft') {
        this.time.addHours(-1);
        this.ui.toast('TIME ' + this.time.clock);
        return;
      }
      if (code === 'BracketRight') {
        this.time.addHours(1);
        this.ui.toast('TIME ' + this.time.clock);
        return;
      }
      if (code === 'KeyY') {
        const names = Object.keys(WEATHER);
        const idx = names.indexOf(this.weather.presetName);
        const next = names[(idx + 1) % names.length];
        this.weather.setPreset(next, true);
        this.ui.toast('WEATHER · ' + WEATHER[next].label);
        return;
      }
      if (code === 'Equal' || code === 'NumpadAdd') {
        this.freeCam.adjustSpeed(2);
        return;
      }
      if (code === 'Minus' || code === 'NumpadSubtract') {
        this.freeCam.adjustSpeed(-2);
        return;
      }
      if (code === 'F3') {
        this.debug = !this.debug;
        if (!this.debug) this.ui.setDebug('', false);
        return;
      }
      if (/^Digit[0-9]$/.test(code)) {
        this._freeCamTeleport(Number(code.slice(5)));
        return;
      }
      return;
    }
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
    if (code === 'F5') {
      e.preventDefault();
      this.toggleWeaponCam();
      return;
    }
    if (code === 'F6') {
      e.preventDefault();
      this.togglePhotoMode();
      return;
    }
    if (this.photoMode.active) {
      // Simulation is frozen: only the photo rig listens.
      if (code === 'Escape') { this.exitPhotoMode(); return; }
      if (code === 'KeyS') { this._savePhoto(); return; }
      if (code === 'BracketLeft') {
        this.photoMode.adjustFov(-2);
        this.ui.toast('FOV · ' + Math.round(this.photoMode.fov) + '°');
        return;
      }
      if (code === 'BracketRight') {
        this.photoMode.adjustFov(2);
        this.ui.toast('FOV · ' + Math.round(this.photoMode.fov) + '°');
        return;
      }
      e.preventDefault();
      return;
    }
    if (code === 'F1') {
      this.uiHidden = !this.uiHidden;
      this.hud.setVisible(!this.uiHidden);
      if (this.uiHidden) this.ui.setATC('');
      return;
    }
    if (code === 'F2') {
      e.preventDefault();
      this.toggleReplay();
      return;
    }
    if (code === 'F4') {
      if (!this.replay.playing) return;
      e.preventDefault();
      this.ui.toast('REPLAY SPEED · ' + this.replay.cycleSpeed() + '×');
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
      // Quick tap toggles help on keyup; holding hands over to the smart
      // autopilot from update(). Never toggle here.
      if (e.repeat) return;
      this._keyHDownAt = performance.now();
      this._keyHHeldFired = false;
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

  /** Keyup companion for press-and-hold H: a quick tap toggles Controls Help. */
  onKeyUp(e) {
    if (e.code !== 'KeyH') return;
    if (!this._keyHHeldFired && this._keyHDownAt > 0) this.ui.toggleHelp();
    this._keyHDownAt = 0;
    this._keyHHeldFired = false;
  }

  /**
   * Press-and-hold H: open (or close) the Smart Autopilot Command Prompt. The
   * pilot then clicks an option OR presses 1-5 / 0 / Esc. The prompt releases
   * the pointer lock so the OS cursor can hit the rows.
   */
  _engageSmartHoldH() {
    const f = this.aircraft.flight;
    if (!f || f.crashed) return;

    // Holding H again closes the prompt (onClose re-locks the pointer).
    if (this.autopilotPrompt.open) {
      this.autopilotPrompt.hide(true);
      this.audio.click();
      return;
    }

    const fuelPct = this._fuelState
      ? (Number.isFinite(this._fuelState.pct) ? this._fuelState.pct : this._fuelState.fraction ?? 1)
      : 1;

    // Up to three nearest airbases, closest first, with the distance/bearing
    // the prompt renders. The procedural grid can report nothing, so fall back
    // to the airport system's nearest().
    let airports = this.world.airportsNear(f.position.x, f.position.z, 6) || [];
    if (!airports.length && this.world.airports && typeof this.world.airports.nearest === 'function') {
      const near = this.world.airports.nearest(f.position.x, f.position.z, 120000);
      if (near) airports = [near];
    }
    airports = airports
      .filter((ap) => ap && Number.isFinite(ap.x) && Number.isFinite(ap.z))
      .map((ap) => {
        const dx = ap.x - f.position.x;
        const dz = ap.z - f.position.z;
        return Object.assign({}, ap, {
          distM: Math.hypot(dx, dz),
          bearingDeg: (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360,
        });
      })
      .sort((a, b) => a.distM - b.distM)
      .slice(0, 3);

    // Tanker summary: orbit kinematics live on this.tanker, so read it directly.
    let tanker = null;
    if (this.tanker && this.tanker.position) {
      const dx = this.tanker.position.x - f.position.x;
      const dz = this.tanker.position.z - f.position.z;
      tanker = {
        distanceM: Math.hypot(dx, dz),
        distM: Math.hypot(dx, dz),
        bearingDeg: (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360,
        position: this.tanker.position,
        speed: this.tanker.speed,
        altitude: this.tanker.orbitAltitude,
        altitudeM: this.tanker.orbitAltitude,
        altM: this.tanker.orbitAltitude,
        fuelPct,
      };
    }

    this.input.releasePointerLock();
    this.autopilotPrompt.show({
      airports,
      tanker,
      fuelPct,
      onGround: !!f.onGround,
      apMode: this.autopilot.mode,
      apTarget: this.autopilot.targetLabel,
      apPhase: this.autopilot.phase,
    });
  }

  /** Prompt row 1-3: engage the multi-leg auto-land computer for `ap`. */
  _startAutoLand(ap) {
    if (!ap) return;
    if (this.autopilot.engageAutoLand(this.aircraft.flight, ap)) {
      this._autoLandAirport = ap;
      this.audio.click();
      this.ui.toast('AUTO-LAND · ' + (ap.code || ap.name) + ' · PLAN ENGAGED');
    } else {
      this.ui.toast('AUTO-LAND · UNAVAILABLE');
    }
    if (this.mode === 'fly' && !this.freeCam.active && !this.terrainEditor.active) {
      this.input.requestPointerLock();
    }
  }

  /** Prompt row 4: join the KC-135 polar orbit (full tanker kinematics). */
  _startAutoRefuel() {
    if (this.autopilot.engageAutoRefuel(this.aircraft.flight, this.tanker)) {
      this.audio.click();
      this.ui.toast('AUTO-REFUEL · KC-135 PLAN ENGAGED');
    } else {
      this.ui.toast('TANKER UNAVAILABLE');
    }
    if (this.mode === 'fly' && !this.freeCam.active && !this.terrainEditor.active) {
      this.input.requestPointerLock();
    }
  }

  /** Prompt row 5: latch the current altitude + heading as a cruise hold. */
  _startCruiseHold() {
    if (this.autopilot.mode !== 'ALT_HDG') {
      this.autopilot.mode = 'OFF';
      this.autopilot.cycleMode(this.aircraft.flight);
      this.audio.click();
      this.ui.toast('AUTOPILOT · ALT & HDG HOLD');
    }
    if (this.mode === 'fly' && !this.freeCam.active && !this.terrainEditor.active) {
      this.input.requestPointerLock();
    }
  }

  /** Prompt row 0: hand stick and throttle back to the pilot. */
  _disengageAutopilot() {
    this.autopilot.disengage();
    this.audio.click();
    this.ui.toast('AUTOPILOT · MANUAL CONTROL');
    if (this.mode === 'fly' && !this.freeCam.active && !this.terrainEditor.active) {
      this.input.requestPointerLock();
    }
  }

  /**
   * A brush stroke touched this world rectangle: drop only the cached tiles that
   * overlap it, then rebuild the nearest few synchronously so the sculpt reads
   * live under the cursor at 60 FPS (no blink, no hole).
   */
  _onTerrainEditsHeightChanged(bounds) {
    if (!bounds || !this.world?.terrain) return;
    const t = this.world.terrain;
    if (typeof t.invalidateBounds !== 'function') return;
    t.invalidateBounds(bounds.xMin, bounds.xMax, bounds.zMin, bounds.zMax);
    if (typeof t._buildPending === 'function') t._buildPending(6, 8);
    // Live object re-grounding: houses, quays, roads, bridges and trees follow
    // the sculpt. Throttled so a fast drag still paints at 60 FPS.
    const now = performance.now();
    if (now - this._lastRegroundAt >= 160) {
      this._lastRegroundAt = now;
      this._regroundTerrainFeatures(false);
    }
  }

  /**
   * Re-ground every world object that samples terrainHeight(): buildings,
   * roads + bridge piers and 3D trees on every call; landmarks, highway traffic
   * and inland water only on a full pass (stroke end / undo / reset / import).
   */
  _regroundTerrainFeatures(full = false) {
    if (!this.world || !this.camera) return;
    // Re-ground buildings (houses, roofs, harbor quays, street lamps)
    this.world.buildings?.invalidateGroundCache?.();
    this.world.buildings?.rebuild?.(this.camera);
    // Re-drape roads and bridge piers
    this.world.roads?.invalidate?.();
    this.world.roads?.update?.(this.camera);
    // Re-ground 3D trees
    this.world.vegetation?.clearCaches?.();
    this.world.vegetation?.clearCellCache?.();
    this.world.vegetation?.rebuild?.(this.camera);
    if (full) {
      // Re-ground landmarks, highway traffic, and inland water after stroke end / undo / reset / import
      if (this._vipavaLandmarks) this.world.landmarks?.setLandmarks?.(this._vipavaLandmarks);
      if (this._vipavaRoads?.length) {
        this.world.roadTraffic?.setCustomRoads?.(this._vipavaRoads, (x, z) => this.world.heightAt(x, z));
      }
      if (this._vipavaWater) this.world.inlandWater?.setWaterData?.(this._vipavaWater);
    }
  }

  /**
   * A height stroke committed (stroke end / undo / reset / import): rebuild the
   * touched tiles properly, then do a full re-ground of every dependent object.
   */
  _onTerrainEditsStrokeEnd(ev) {
    if (ev && ev.bounds && this.world?.terrain) {
      const t = this.world.terrain;
      if (typeof t.invalidateBounds === 'function') {
        t.invalidateBounds(ev.bounds.xMin, ev.bounds.xMax, ev.bounds.zMin, ev.bounds.zMax);
      }
      if (typeof t._buildPending === 'function') t._buildPending(12, 16);
    }
    this._regroundTerrainFeatures(true);
    this._lastRegroundAt = performance.now();
  }

  /**
   * Persist the edit grid: localStorage always, plus the dev-only
   * `POST /__dev/save-edits` route (vite.config.js) that writes
   * `public/media/vipava_edits.json` during `npm run dev`.
   */
  async _saveTerrainEditsToProject(jsonObj) {
    this.terrainEdits.saveToLocalStorage();
    try {
      const res = await fetch('/__dev/save-edits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jsonObj),
      });
      if (res && res.ok) {
        return { ok: true, message: 'SAVED TO public/media/vipava_edits.json' };
      }
    } catch (err) {
      // Static build / preview server: the dev route does not exist.
    }
    return { ok: false, message: 'SAVED TO BROWSER (DEV SERVER REQUIRED FOR PROJECT FILE)' };
  }

  /** Quick-jump button in the F9 panel: park the free camera over a landmark. */
  _teleportTerrainEditor(spot) {
    if (!spot) return;
    const ground = Math.max(0, this.world.heightAt(spot.x, spot.z));
    this.freeCam.teleport(
      spot.x,
      ground + (spot.agl ?? 320),
      spot.z,
      spot.yaw ?? 0,
      spot.pitch ?? -0.42,
    );
    this.ui.toast('EDITOR · ' + (spot.name || 'JUMP'));
  }

  /**
   * F9: open/close the Terrain & Color Paint Editor. The painter rides on Free
   * Cam (top-down streaming camera) but with the pointer UNLOCKED, so the brush
   * follows the real OS cursor instead of a hidden, warped one.
   */
  toggleTerrainEditor() {
    if (!this.ready) return;
    this.autopilotPrompt?.hide(false);
    this.autopilotPrompt?.updatePlanStrip(null);
    if (this.terrainEditor.active) {
      this.exitTerrainEditor();
      return;
    }
    // Remember whether WE opened Free Cam, so exiting only closes what we opened.
    this._editorOpenedFreeCam = !this.freeCam.active;
    if (!this.freeCam.active) this.toggleFreeCam();
    // Unlock immediately after Free Cam grabs it: the brush needs the OS cursor.
    this.input.releasePointerLock();
    if (this.inspectorMap.visible) this.inspectorMap.hide();
    this.terrainEditor.show();
    this.ui.toast(
      'TERRAIN & COLOR PAINTER (F9) · L-DRAG PAINT · R-DRAG LOOK · [ ] SIZE · CTRL+Z UNDO',
    );
  }

  exitTerrainEditor() {
    if (!this.terrainEditor.active) return;
    this.terrainEditor.hide();
    if (this._editorOpenedFreeCam) {
      this._editorOpenedFreeCam = false;
      this.exitFreeCam();
    } else {
      this.ui.toast('TERRAIN PAINTER · OFF');
    }
  }

  /** F7: detached 6-DOF spectator camera for fast world inspection without flying. */
  toggleFreeCam() {
    this.autopilotPrompt?.hide(false);
    this.autopilotPrompt?.updatePlanStrip(null);
    if (this.freeCam.active) {
      // Leaving Free Cam also closes the painter: it cannot paint without a
      // streaming camera under the cursor.
      if (this.terrainEditor.active) this.exitTerrainEditor();
      this.exitFreeCam();
      return;
    }
    if (this.photoMode.active) this.exitPhotoMode(true);
    this._freeCamReturnMode = this.mode === 'menu' ? 'menu' : 'fly';

    // Start from the current camera (or slightly above Ajdovščina if in menu).
    const startPos = this.camera.position.clone();
    if (this._freeCamReturnMode === 'menu') {
      const ground = this.world.heightAt(this.spawn.x, this.spawn.z);
      startPos.set(this.spawn.x - 180, ground + 180, this.spawn.z + 240);
      this.ui.hideMenu();
    } else {
      startPos.y = Math.max(startPos.y, this.world.heightAt(startPos.x, startPos.z) + 12);
    }
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.freeCam.enter(startPos, euler.y, clamp(euler.x, -1.2, 0.8));

    this.audio.setPaused(true);
    this.hud.setVisible(false);
    this.ui.hidePause();
    if (this.kneeboard.visible) this.kneeboard.toggle();
    this.ui.showFreeCamBar(true);
    this.input.requestPointerLock();
    this.ui.toast('FREE CAM (CTRL+F) · WASD/QE MOVE · M BIG MAP · WHEEL SPEED · SHIFT ×4 · 1-9 JUMP');
    this._saveLastView();
  }

  /** Toggle the big click-to-teleport Environment Inspector Map while in Free Cam. */
  toggleInspectorMap() {
    if (!this.freeCam.active) return;
    if (this.inspectorMap.visible) {
      this.inspectorMap.hide();
    } else {
      this.input.releasePointerLock();
      this.inspectorMap.show(this._inspectorState());
    }
  }

  _inspectorState() {
    const bStats = this.world.buildings.stats;
    const lod = bStats.lod || {};
    const info = this.renderer.info;
    return {
      aircraftPos: this.aircraft.flight.position,
      camPos: this.freeCam.position,
      camYaw: this.freeCam.yaw,
      hour: this.time.hour,
      weather: this.weather.presetName,
      debugStats: {
        fps: Math.round(this.fps),
        calls: info.render.calls,
        tris: Math.round(info.render.triangles / 1000),
        tiles: this.world.terrain.tiles.size,
        buildings: bStats.buildings || 0,
        lodClose: lod.close || 0,
        lodMid: lod.mid || 0,
        lodFar: lod.far || 0,
        roofs: lod.roofs || 0,
        plinths: lod.plinths || 0,
      },
    };
  }

  /** Leave Free Cam and return cleanly to the jet (or menu). */
  exitFreeCam(silent = false) {
    if (!this.freeCam.active) return;
    if (this.inspectorMap.visible) this.inspectorMap.hide();
    this.freeCam.exit();
    this.ui.showFreeCamBar(false);
    this.camera.up.set(0, 1, 0);
    this.aircraft.setMode(this.aircraft.mode);

    if (this._freeCamReturnMode === 'menu') {
      this.mode = 'menu';
      this.input.releasePointerLock();
      this.ui.showMenu();
    } else {
      this.hud.setVisible(!this.uiHidden);
      this.audio.setPaused(false);
      if (!silent) {
        this.ui.toast('FREE CAM · OFF');
        this.input.requestPointerLock();
      }
    }
    // Feature 41: keep the pose but mark Free Cam inactive, so the next reload
    // opens the menu instead of snapping back onto the camera.
    this._saveLastView();
    this.last = performance.now();
  }

  /**
   * Spawn the F-16 airborne at any map / Free Cam point: 5,000 ft, 300 kts,
   * pointing exactly where the Free Camera was looking. Used by the Inspector
   * Map (left-click in SPAWN mode, right-click, "SPAWN HERE") and by the
   * Free Cam bar's SPAWN F-16 button.
   */
  async spawnAircraftAt(x, z, headingDeg = null) {
    if (!this.ready || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const heading = Number.isFinite(headingDeg)
      ? ((headingDeg % 360) + 360) % 360
      : camYawToHeadingDeg(this.freeCam.yaw);

    // 5,000 ft MSL, but never closer than ~1,000 ft to the ridge under us.
    const ground = this.world.heightAt(x, z);
    const altM = Number.isFinite(ground)
      ? Math.max(MAP_SPAWN_ALT_M, ground + MAP_SPAWN_MIN_AGL_M)
      : MAP_SPAWN_ALT_M;

    // Leave Free Cam FIRST, then hide the map: InspectorMap.hide() fires
    // onClose, which only re-grabs the pointer lock while Free Cam is active.
    // startFlight() asks for the lock itself once the jet exists.
    this.freeCam.exit();
    this._freeCamReturnMode = 'fly';
    this.ui.showFreeCamBar(false);
    if (this.inspectorMap.visible) this.inspectorMap.hide();

    await this.startFlight({
      spawn: {
        x,
        y: altM,
        z,
        alt: altM,
        heading,
        speed: MAP_SPAWN_SPEED_MS,
        throttle: 0.72,
        airborne: true,
      },
    });

    // Snap the chase camera onto the jet immediately, then restream the world
    // around it so the first frame is not floating over empty terrain.
    this.aircraft._updateCamera(0, this.input, true);
    this.world.terrain?.refresh?.(this.camera.position, 24);
    this.world.update(0.016, this.camera, this.sky, this.weather);
    this._saveLastView();
    this.ui.toast(
      `SPAWN F-16 · ${Math.round(altM / 0.3048)} FT · 300 KT · ` +
      `HDG ${String(Math.round(heading)).padStart(3, '0')}°`,
    );
  }

  /** Quick-jump presets (`1`–`9` Vipava highlights, `0` back to aircraft). */
  _freeCamTeleport(slot) {
    if (slot === 0) {
      const p = this.aircraft.flight.position;
      this.freeCam.teleport(p.x - 40, p.y + 30, p.z + 60, -0.5, -0.35);
      this.ui.toast('FREE CAM · AIRCRAFT');
      this._saveLastView();
      return;
    }
    const spots = [
      null,
      { name: 'AJDOVŠČINA & LJAJ', x: -450, z: -130, agl: 220, yaw: -1.2, pitch: -0.35 },
      { name: 'VIPAVA & H4 VIADUCT', x: 5150, z: 4550, agl: 240, yaw: 0.4, pitch: -0.38 },
      { name: 'SOLKAN BRIDGE & GORGE', x: -18325, z: -10035, agl: 190, yaw: 0.8, pitch: -0.42 },
      { name: 'SVETA GORA BASILICA', x: -17930, z: -12391, agl: 140, yaw: 2.4, pitch: -0.38 },
      { name: 'NOVA GORICA & GORIZIA', x: -19400, z: -7000, agl: 340, yaw: 0.3, pitch: -0.36 },
      { name: 'ŠTANJEL HILLTOP VILLAGE', x: -3226, z: 7135, agl: 160, yaw: -0.5, pitch: -0.38 },
      { name: 'NANOS PLATEAU & TOWER', x: 12904, z: 12902, agl: 220, yaw: 0.9, pitch: -0.35 },
      { name: 'VOGRŠČEK DAM & LAKE', x: -12487, z: -1990, agl: 180, yaw: -1.1, pitch: -0.40 },
      { name: 'PIRAN & ADRIATIC COAST', x: -24661, z: 39852, agl: 240, yaw: 0.6, pitch: -0.35 },
    ];
    const s = spots[slot];
    if (!s) return;
    const ground = this.world.heightAt(s.x, s.z);
    this.freeCam.teleport(s.x, ground + s.agl, s.z, s.yaw, s.pitch);
    this.ui.toast('FREE CAM · ' + s.name);
    this._saveLastView();
  }

  /** Step Free Cam controls while keeping terrain/buildings/water streaming. */
  _updateFreeCam(dt) {
    const simDt = Math.min(dt, 0.05);
    const i = this.input;
    const mapOpen = this.inspectorMap.visible;
    // F9 painter: while the editor is open, right-drag owns camera look (the
    // pointerdown/move handlers feed freeCam.look), so the raw locked-pointer
    // deltas must not double-apply.
    const painting = this.terrainEditor.active;
    if (!mapOpen) {
      if (!painting && (i.mouse.dx || i.mouse.dy)) {
        this.freeCam.look(i.mouse.dx, i.mouse.dy);
      }
      if (i.mouse.wheel) {
        // Scroll up (negative deltaY -> wheel = -1) speeds up; scroll down slows down.
        this.freeCam.adjustSpeed(-i.mouse.wheel);
      }
    }

    const move = mapOpen ? {} : {
      forward: (i.isDown('KeyW') ? 1 : 0) - (i.isDown('KeyS') ? 1 : 0),
      right: (i.isDown('KeyD') ? 1 : 0) - (i.isDown('KeyA') ? 1 : 0),
      up: ((i.isDown('KeyE') || i.isDown('Space')) ? 1 : 0) - ((i.isDown('KeyQ') || i.isDown('KeyC')) ? 1 : 0),
      boost: i.anyDown('ShiftLeft', 'ShiftRight'),
      slow: i.anyDown('AltLeft', 'AltRight'),
      lookX: (i.isDown('ArrowRight') ? 1 : 0) - (i.isDown('ArrowLeft') ? 1 : 0),
      lookY: (i.isDown('ArrowUp') ? 1 : 0) - (i.isDown('ArrowDown') ? 1 : 0),
    };
    this.freeCam.update(simDt, this.camera, move, (x, z) => this.world.heightAt(x, z));

    // F9 painter tick: re-pick under the cursor, apply the held brush, and let
    // onHeightChanged rebuild the touched tiles in the same frame.
    if (painting) {
      this.terrainEditor.update(
        simDt, this.camera, this.canvas, (x, z) => this.world.heightAt(x, z),
      );
    }

    // Keep sky, terrain quadtree, 53k OSM buildings, roads, bridges, traffic
    // and clouds streaming live around the free camera!
    this.sky.update(simDt, this.time, this.weather, this.camera, this.weather.flash);
    this.world.update(simDt, this.camera, this.sky, this.weather);
    this.clouds.update(simDt, this.camera, this.weather, this.sky);

    // Feature 41: autosave the Free Cam pose roughly twice a second, so a tab
    // crash or a hard reload still lands close to where the user was.
    this._lastViewTimer -= simDt;
    if (this._lastViewTimer <= 0) {
      this._lastViewTimer = 0.5;
      this._saveLastView();
    }

    this._freeCamBarTimer -= simDt;
    if (this._freeCamBarTimer <= 0) {
      this._freeCamBarTimer = 0.12;
      const p = this.freeCam.position;
      const agl = Math.max(0, Math.round(p.y - this.world.heightAt(p.x, p.z)));
      const spd = Math.round(this.freeCam.speed * (move.boost ? 4 : move.slow ? 0.2 : 1));
      const bStats = this.world.buildings.stats;
      this.ui.setFreeCamInfo(
        `${spd} M/S · AGL ${agl} M · (${Math.round(p.x)}, ${Math.round(p.z)}) · ` +
        `BLD ${bStats.buildings} · FPS ${Math.round(this.fps)}`,
      );
      if (mapOpen) this.inspectorMap.render(this._inspectorState());
    }
  }

  /**
   * Feature 41: write the Free Cam pose (or the live airframe) plus the active
   * environment into localStorage so a reload can drop the user back where they
   * were. `kind` tags the record: 'freecam' for the spectator camera, 'flight'
   * for a live jet (with a full airframe snapshot) and 'none' for a clean menu
   * start (crash, menu, boot). Everything is inside try/catch — private mode,
   * disabled storage, a quota error or a headless run must never break a frame.
   */
  _saveLastView() {
    // Never write while a restore is in progress, and never write before the
    // app is ready: a reload during boot would otherwise overwrite the record
    // _restoreLastView() has not read yet with a blank 'none' snapshot.
    if (this._restoringLastView || !this.ready || this.mode === 'boot') return;
    try {
      const fc = this.freeCam;
      if (!fc) return;
      const p = fc.position;
      const f = this.aircraft?.flight;
      let kind = 'none';
      let flight = null;
      if (fc.active) {
        kind = 'freecam';
      } else if ((this.mode === 'fly' || this.mode === 'pause') && f && !f.crashed && !this.ejection?.active) {
        kind = 'flight';
        flight = {
          px: f.position.x, py: f.position.y, pz: f.position.z,
          qx: f.quaternion.x, qy: f.quaternion.y, qz: f.quaternion.z, qw: f.quaternion.w,
          vx: f.velocity.x, vy: f.velocity.y, vz: f.velocity.z,
          rx: f.rates.x, ry: f.rates.y, rz: f.rates.z,
          throttle: f.throttle, targetThrottle: f.targetThrottle,
          gearDown: !!f.gearDown, gearPos: f.gearPos, gearTarget: f.gearTarget,
          flapsIndex: f.flapsIndex, flapPos: f.flapPos,
          brake: !!f.brake, onGround: !!f.onGround, afterburner: !!f.afterburner,
          cameraMode: this.aircraft.mode || 'cockpit',
          mission: this.ui?.mission || 'free',
          fuelInternal: this.fuel?.internal ?? this.fuel?.fuelLb,
          fuelExternal: this.fuel?.external,
        };
      }
      const record = {
        active: kind !== 'none',
        kind,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: fc.yaw,
        pitch: fc.pitch,
        speed: fc.speed,
        theater: this._activeTheater || this.ui.theater || 'vipava',
        hour: this.time.hour,
        weather: this.weather.presetName,
        quality: this.preset.name,
      };
      if (flight) record.flight = flight;
      localStorage.setItem(LAST_VIEW_KEY, JSON.stringify(record));
    } catch {
      // Storage unavailable (private mode, Safari, headless) — persistence is optional.
    }
  }

  /** Feature 41: read back the saved view, or null when absent / corrupt. */
  _loadLastView() {
    try {
      const raw = localStorage.getItem(LAST_VIEW_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      return saved && typeof saved === 'object' ? saved : null;
    } catch {
      return null;
    }
  }

  /**
   * Feature 41: read the sticky menu choices. Every field is validated against
   * the live preset tables, so a stale or hand-edited record can never inject
   * an unknown quality / theater / mission into the boot path.
   */
  _loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return {};
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return {};
      const out = {};
      if (QUALITY[saved.quality]) out.quality = saved.quality;
      if (THEATERS[saved.theater]) out.theater = saved.theater;
      if (MISSIONS[saved.mission]) out.mission = saved.mission;
      if (WEATHER[saved.weather]) out.weather = saved.weather;
      if (WIND[saved.wind]) out.wind = saved.wind;
      if (Number.isFinite(saved.hour) && saved.hour >= 0 && saved.hour <= 24) out.hour = saved.hour;
      return out;
    } catch {
      return {};
    }
  }

  /** Feature 41: persist the sticky menu choices after every menu pick. */
  _saveSettings() {
    try {
      const settings = {
        quality: this.preset?.name || this.ui?.quality || 'medium',
        theater: this.ui?.theater || this._activeTheater || 'vipava',
        mission: this.ui?.mission || 'free',
        weather: this.ui?.weather || 'few',
        wind: this.ui?.wind || 'auto',
        hour: Number.isFinite(this.ui?.hour) ? this.ui.hour : 17.6,
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      this._savedSettings = settings;
    } catch {
      // Private mode / headless: sticky settings are a nicety, not a contract.
    }
  }

  /**
   * Feature 41: after boot, put the user straight back into the Free Cam pose
   * they reloaded from. Returns true when a restore actually happened.
   */
  async _restoreLastView() {
    const saved = this._loadLastView();
    if (!saved || saved.active !== true) return false;
    const flightRestore = saved.kind === 'flight' && !!saved.flight;
    if (!flightRestore && ![saved.x, saved.y, saved.z].every((v) => Number.isFinite(v))) return false;

    // Suppress autosaves until the camera is actually in place, so the
    // setTheater/setQuality calls below cannot overwrite the saved pose.
    this._restoringLastView = true;
    try {
      // Environment first, using exactly the calls the Inspector Map makes.
      // Sticky settings win over a stale last-view record: a session that has
      // already moved to `high` (or another theater) must not be dragged back
      // by an older autosave.
      const sticky = this._savedSettings || {};
      const wantTheater = THEATERS[sticky.theater] ? sticky.theater : saved.theater;
      if (THEATERS[wantTheater] && wantTheater !== (this._activeTheater || this.ui.theater)) {
        await this.setTheater(wantTheater);
      }
      if (THEATERS[wantTheater]) this.ui.applySettings({ theater: wantTheater });
      const stickyQuality = this._savedSettings?.quality;
      const wantQuality = QUALITY[stickyQuality] ? stickyQuality : saved.quality;
      if (QUALITY[wantQuality] && wantQuality !== this.preset.name) {
        this.setQuality(wantQuality);
      }
      this.ui.applySettings({ quality: this.preset.name });
      const restoredHour = Number.isFinite(saved.hour) ? saved.hour : null;
      if (restoredHour !== null) this.time.setHour(saved.hour);
      if (restoredHour !== null) this.ui.applySettings({ hour: restoredHour });
      if (saved.weather && WEATHER[saved.weather]) {
        this.weather.setPreset(saved.weather, true);
        this.ui.applySettings({ weather: saved.weather });
      }

      if (flightRestore) {
        // Validate the airframe snapshot before touching any live system.
        const fl = saved.flight;
        const required = ['px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw', 'vx', 'vy', 'vz'];
        if (!required.every((k) => Number.isFinite(fl[k]))) return false;
        const qLen = Math.hypot(fl.qx, fl.qy, fl.qz, fl.qw);
        if (!(qLen > 1e-6)) return false;

        // Mission + theater must match the instant the jet was saved.
        if (fl.mission && MISSIONS[fl.mission]) this.ui.mission = fl.mission;
        // Menu pill must match if the player later returns to the menu.
        this.ui.applySettings?.({ mission: this.ui.mission });
        this.ui.theater = THEATERS[saved.theater] ? saved.theater : this.ui.theater;

        const ground = this.world.heightAt(fl.px, fl.pz);
        const safeY = fl.onGround
          ? Math.max(fl.py, ground + 1.8)
          : Math.max(fl.py, ground + 12);

        // Enter flight through the normal path so HUD, mission, targets,
        // weapons, autopilot, fuel and replay all initialise — flagged as a
        // restore so it never steals a pointer lock (needs a user gesture) and
        // never re-runs setTheater over the environment applied above.
        await this.startFlight({
          restore: true,
          spawn: { x: fl.px, y: safeY, z: fl.pz, heading: 0 },
        });

        // Overwrite the freshly placed airframe with the saved instant.
        const f = this.aircraft.flight;
        f.position.set(fl.px, safeY, fl.pz);
        f.quaternion.set(fl.qx / qLen, fl.qy / qLen, fl.qz / qLen, fl.qw / qLen).normalize();
        f.velocity.set(fl.vx, fl.vy, fl.vz);
        if ([fl.rx, fl.ry, fl.rz].every((v) => Number.isFinite(v))) {
          f.rates.set(fl.rx, fl.ry, fl.rz);
        }
        f.speed = f.velocity.length();
        if (Number.isFinite(fl.throttle)) f.throttle = clamp(fl.throttle, 0, 1);
        if (Number.isFinite(fl.targetThrottle)) f.targetThrottle = clamp(fl.targetThrottle, 0, 1);
        f.gearDown = !!fl.gearDown;
        if (Number.isFinite(fl.gearPos)) f.gearPos = clamp(fl.gearPos, 0, 1);
        if (Number.isFinite(fl.gearTarget)) f.gearTarget = clamp(fl.gearTarget, 0, 1);
        if (Number.isFinite(fl.flapsIndex)) f.flapsIndex = clamp(Math.round(fl.flapsIndex), 0, 2);
        if (Number.isFinite(fl.flapPos)) f.flapPos = clamp(fl.flapPos, 0, 1);
        f.brake = !!fl.brake;
        f.onGround = !!fl.onGround;
        // f.reset() inside startFlight() leaves _lastOnGround true; sync it to
        // the restored state so an airborne restore does not read as a landing.
        f._lastOnGround = f.onGround;
        f.afterburner = !!fl.afterburner;
        f.crashed = false;
        f.crashReason = '';
        f.agl = Math.max(0, f.position.y - ground);

        // Fuel load: internal (+ modelled external) tanks survive the reload.
        const fuelLb = Number.isFinite(fl.fuelInternal)
          ? fl.fuelInternal + (Number.isFinite(fl.fuelExternal) ? fl.fuelExternal : 0)
          : NaN;
        if (Number.isFinite(fuelLb)) this.fuel.reset(fuelLb);

        const camModes = ['cockpit', 'chase', 'wing', 'orbit', 'flyby'];
        this.aircraft.setMode(camModes.includes(fl.cameraMode) ? fl.cameraMode : 'cockpit');
        this._syncAircraftModel();
        this.aircraft._updateCamera(0, this.input, true);

        // Re-ground the world around the restored jet before the first frame.
        this.world.terrain?.refresh?.(this.camera.position, 24);
        this.world.update(0.016, this.camera, this.sky, this.weather);
        this.sky.update(0.016, this.time, this.weather, this.camera, this.weather.flash,
          this.aircraft.mode === 'cockpit');
        this.clouds.update(0.016, this.camera, this.weather, this.sky);

        this.mode = 'fly';
        this.audio.setPaused(false);
        this.ui.hideBoot();
        this.ui.hideMenu();
        this.hud.setVisible(!this.uiHidden);
        this.ui.toast('RESTORED LAST FLIGHT · CLICK TO CONTROL · ESC PAUSE');
        this._lastViewTimer = 0.5;
      } else {
        // Camera pose, lifted clear of the height field so it never starts buried.
        const ground = this.world.heightAt(saved.x, saved.z);
        const y = Number.isFinite(ground) ? Math.max(saved.y, ground + 4) : saved.y;
        this.freeCam.enter(new THREE.Vector3(saved.x, y, saved.z), saved.yaw, saved.pitch);
        if (Number.isFinite(saved.speed)) {
          this.freeCam.speed = clamp(saved.speed, LAST_VIEW_SPEED_MIN, LAST_VIEW_SPEED_MAX);
        }
        this._freeCamReturnMode = 'menu';
        this.freeCam.update(0, this.camera, {}, (x, z) => this.world.heightAt(x, z));

        // Re-ground the world around the restored camera before the first frame.
        this.world.terrain?.refresh?.(this.camera.position, 24);
        this.world.update(0.016, this.camera, this.sky, this.weather);
        this.sky.update(0.016, this.time, this.weather, this.camera, this.weather.flash);
        this.clouds.update(0.016, this.camera, this.weather, this.sky);

        this.mode = 'menu';
        this.audio.setPaused(true);
        this.ui.hideBoot();
        this.ui.hideMenu();
        this.hud.setVisible(false);
        this.ui.showFreeCamBar(true);
        this.ui.toast('RESTORED LAST POSITION · CLICK TO LOOK · CTRL+F / ESC TO EXIT');
        this._lastViewTimer = 0.5;
      }
    } catch (err) {
      console.warn('LAST VIEW · restore failed, opening menu', err);
      this.freeCam.exit();
      this.mode = 'menu';
      this.hud.setVisible(false);
      this.ui.showMenu();
      return false;
    } finally {
      this._restoringLastView = false;
    }
    return true;
  }

  /** F5: weapon follow-cam rides the last live round to its impact. */
  toggleWeaponCam() {
    if (this.mode !== 'fly') {
      this.ui.toast('WEAPON CAM · AVAILABLE IN FLIGHT');
      return;
    }
    const on = this.weaponCam.toggle();
    this.audio.click();
    this.ui.toast(on ? 'WEAPON CAM · ON — F5 TO RELEASE' : 'WEAPON CAM · OFF');
  }

  /** F6: freeze the sim and orbit a detached camera for the snapshot. */
  togglePhotoMode() {
    if (this.photoMode.active) {
      this.exitPhotoMode();
      return;
    }
    if (this.mode !== 'fly') return;
    const f = this.aircraft.flight;
    const cam = this.camera;
    const dx = cam.position.x - f.position.x;
    const dz = cam.position.z - f.position.z;
    const horiz = Math.hypot(dx, dz);
    const yaw = horiz > 1e-3 ? Math.atan2(dx, dz) : 0;
    const pitch = Math.atan2(cam.position.y - f.position.y, Math.max(horiz, 1e-3));
    this.photoMode.enter(f.position, yaw, clamp(pitch, -1.3, 1.3));
    this.photoMode.dist = clamp(horiz, 18, 90);
    this.photoMode.fov = cam.fov;
    cam.up.set(0, 1, 0);
    this.input.releasePointerLock();
    this._photoDrag = null;
    if (this.kneeboard.visible) this.kneeboard.toggle();
    this.hud.setVisible(false);
    this.ui.showPhotoBar(true);
    this.audio.click();
    this.ui.toast('PHOTO MODE · DRAG ORBIT · SCROLL ZOOM · [ ] FOV · S SNAPSHOT');
  }

  /** Leave Photo Mode, restore the live view and hand the jet back. */
  exitPhotoMode(silent = false) {
    if (!this.photoMode.active) return;
    this.photoMode.exit();
    this._photoDrag = null;
    this.camera.up.set(0, 1, 0);
    // Restore the FOV / near plane of the active chase or cockpit view.
    this.aircraft.setMode(this.aircraft.mode);
    this.ui.showPhotoBar(false);
    this.hud.setVisible(!this.uiHidden);
    if (!silent) {
      this.audio.click();
      this.ui.toast('PHOTO MODE · OFF');
      this.input.requestPointerLock();
    }
    this.last = performance.now();
  }

  /** Wheel-zoom the photo rig and re-place its camera on the orbit shell. */
  _updatePhotoMode(dt) {
    const wheel = this.input.mouse.wheel;
    if (wheel) this.photoMode.zoom(-wheel * 0.6);
    this.photoMode.updateCamera(this.camera, dt);
  }

  /**
   * Snapshot the frozen frame. The WebGL drawing buffer is cleared when the
   * browser presents, so the scene is rendered synchronously here and the
   * canvas is read in the same task — the PNG is never blank.
   */
  _savePhoto() {
    if (!this.photoMode.active) return null;
    this.postfx.render(this.scene, this.camera);
    const n = this.photoMode.snapshotCount + 1;
    const url = this.photoMode.captureSnapshot(this.canvas, `falcon-infinite-vipava-${n}.png`);
    this.audio.click();
    this.ui.toast(url ? 'SNAPSHOT · PNG SAVED' : 'SNAPSHOT · FAILED');
    return url;
  }

  /** F2: start / stop the instant replay. F4 cycles its playback rate. */
  toggleReplay() {
    if (this.replay.playing) {
      const snap = this.replay.stopPlayback();
      this._replayActive = false;
      // Restore the live airframe exactly where it was when playback started.
      if (snap) this.replay.applyToFlight(this.aircraft.flight, snap);
      this._syncAircraftModel();
      this.ui.toast('REPLAY · LIVE');
      return;
    }
    if (this.mode !== 'fly') return;
    if (!this.replay.startPlayback(30, this.aircraft.flight)) {
      this.ui.toast('REPLAY · NO HISTORY YET');
      return;
    }
    this._replayActive = true;
    // A cockpit view replays inside the pilot's head; switch out so the run is visible.
    if (this.aircraft.mode === 'cockpit') this.aircraft.setMode('chase');
    this.ui.toast('REPLAY · 30s (F2 EXIT · F4 SPEED)');
  }

  _stepReplay(simDt) {
    const sample = this.replay.stepPlayback(simDt);
    if (!sample) return;
    const f = this.aircraft.flight;
    this.replay.applyToFlight(f, sample);
    // Replay bypasses flight.update(), so refresh the derived values the HUD
    // and visual layer read every frame.
    f.agl = Math.max(0, f.position.y - this.world.heightAt(f.position.x, f.position.z));
    f.verticalSpeed = f.velocity.y;
    this._syncAircraftModel();
    updateF16Visual(this.aircraft.model, f, simDt, this.aircraft.mode, this.ready);
    this.aircraft._updateCamera(simDt, this.input, true);
    // Loop the recorded window until F2 exits.
    if (sample.done) this.replay.playTime = 0;
  }

  _syncAircraftModel() {
    this.aircraft.model.position.copy(this.aircraft.flight.position);
    this.aircraft.model.quaternion.copy(this.aircraft.flight.quaternion);
  }

  async startFlight(opts = {}) {
    if (!this.ready) return;
    // A reload restore enters flight without a user gesture, so it must never
    // ask for the pointer lock (the browser would reject it anyway) — the
    // first canvas click grabs it as usual.
    const restore = opts?.restore === true;
    if (!restore) this.input.requestPointerLock();
    this.audio.start().then(() => {
      if (this.audio.ctx && this.audio.nodes?.sfxBus) {
        this.combatAudio.attach(this.audio.ctx, this.audio.nodes.sfxBus);
      }
    });
    this.audio.resetEngine();
    this.audio.setPaused(false);
    // Wait for the baked theater (DEM + OSM) so the spawn is the real runway.
    // A restore already applied its theater through setTheater(), and reloading
    // the DEM again would only stall boot and churn the world.
    if (!(restore && this._activeTheater === (this.ui.theater || 'vipava'))) {
      await this.setTheater(this.ui.theater || 'vipava');
    }
    this.aircraft.setMode('cockpit');
    // Feature 30: the Soča Canyon Run starts airborne right outside Gate 1.
    // A restore passes its own origin so mission targets/steerpoints sit around
    // the recovered jet instead of the default runway.
    const spawn = opts?.spawn || (this.ui.mission === 'soca_run' ? this._socaRunSpawn() : this.spawn);
    this._placeAtSpawn(spawn);
    this._startActiveMission(spawn);
    this.ui.hideMenu();
    this.ui.hidePause();
    this.ui.hideCrash();
    this.hud.setVisible(true);
    this.mode = 'fly';
    this.weather.night = this.sky.night;
    if (!restore) {
      // Persist the fresh spawn right away, so a reload before the first
      // autosave tick still resumes into flight.
      this._saveLastView();
      const mLabel = MISSIONS[this.ui.mission]?.label || 'FREE FLIGHT';
      this.ui.toast(`${mLabel} · SHIFT THROTTLE · SPACE FIRE · TAB WEAPON`);
    }
    this.last = performance.now();
  }

  pause() {
    if (this.mode !== 'fly') return;
    // The prompt/strip are flight-only glass: never linger over the pause card.
    this.autopilotPrompt?.hide(false);
    this.autopilotPrompt?.updatePlanStrip(null);
    this.mode = 'pause';
    // ESC unlocks the pointer so the player can click Reload — persist the
    // exact flight pose here, before the unload flush can see 'pause' mode.
    this._saveLastView();
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

  /**
   * Feature 30/33: flying start for the Soča Canyon Run. Spawns already
   * airborne west of LJAJ, 185 m/s, heading 270 so Gate 1 is dead ahead.
   */
  _socaRunSpawn() {
    return {
      x: 200,
      y: 230,
      z: 0,
      alt: 230,
      heading: 270,
      speed: 185,
      airborne: true,
    };
  }

  /**
   * Place the jet on any spawn point. Airborne spawns arrive clean: gear up,
   * throttle set, and the velocity vector pointing down the nose.
   */
  _placeAtSpawn(sp) {
    const spawn = Number.isFinite(sp.y)
      ? sp
      : { ...sp, y: (sp.alt ?? 0) + CONFIG.aircraft.gearHeight };
    const f = this.aircraft.flight;
    this.aircraft.reset(spawn);
    if (sp.airborne) {
      const throttle = Number.isFinite(sp.throttle) ? sp.throttle : 0.85;
      f.gearDown = false;
      f.gearPos = 0;
      f.gearTarget = 0;
      f.onGround = false;
      f._lastOnGround = false;
      // Clean wing: a 5,000 ft / 300 kt map spawn must not take off with flaps.
      f.flapsIndex = 0;
      f.flapPos = 0;
      f.throttle = throttle;
      f.targetThrottle = throttle;
      f.speed = sp.speed;
      f.velocity.copy(f.forward).multiplyScalar(sp.speed);
      this._syncAircraftModel();
    }
    return f;
  }

  /**
   * Feature 30: steerpoint snapshot for the next canyon gate, shaped exactly
   * like the mission steerpoint the HUD / tactical overlay already consume.
   */
  _gateSteerpoint(gate, f, t = null) {
    const dx = gate.x - f.position.x;
    const dz = gate.z - f.position.z;
    const distM = Math.hypot(dx, dz);
    const heading = Number.isFinite(t?.heading) ? t.heading : f.heading;
    const brg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
    const idx = (this._canyonState?.gateIndex ?? 0) + 1;
    const total = this._canyonState?.totalGates ?? 8;
    return {
      label: 'GATE ' + Math.min(idx, total) + ' · ' + (gate.name || 'SKY GATE'),
      kind: 'GATE',
      x: gate.x,
      y: gate.y,
      z: gate.z,
      bearingDeg: brg,
      relBearingDeg: ((brg - heading + 540) % 360) - 180,
      distanceM: distM,
      distanceNm: distM / 1852,
      etaSec: distM / Math.max(f.speed, 40),
    };
  }

  respawn() {
    const f = this.aircraft.flight;
    const socaRun = this.ui.mission === 'soca_run';
    const ap = socaRun ? null : airportNear(f.position.x, f.position.z, 80000);
    const sp = socaRun ? this._socaRunSpawn() : this.spawnForAirport(ap);
    this._placeAtSpawn(sp);
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
    this.ui.toast('RESET · ' + (socaRun
      ? 'SOČA CANYON START'
      : (ap ? ap.name.toUpperCase() : 'RUNWAY')));
  }

  returnToMenu() {
    this.autopilotPrompt?.hide(false);
    this.autopilotPrompt?.updatePlanStrip(null);
    this.mode = 'menu';
    this.audio.setPaused(true);
    // Feature 30/32/33: tear down every in-flight overlay system before the
    // menu flyover takes the camera back.
    this.canyonRun.stop();
    this._canyonState = null;
    this._canyonFinishAnnounced = false;
    this.exitPhotoMode(true);
    this.exitFreeCam(true);
    this.weaponCam.reset();
    this._weaponCamState = null;
    this.juice.reset();
    this._juiceState = null;
    this.ui.showMenu();
    this.ui.hidePause();
    this.ui.hideCrash();
    this.hud.setVisible(false);
    this.input.releasePointerLock();
    this._placeAtSpawn(this.spawn);
    this.aircraft.setMode('cockpit');
    // Feature 41: reloading from the menu must reopen the menu, not the jet.
    this._saveLastView();
  }

  buildCommand() {
    const i = this.input;
    // Alt+arrows drive the camera, so they must never nudge the throttle.
    const alt = i.anyDown('AltLeft', 'AltRight');
    const up = i.anyDown('ShiftLeft', 'ShiftRight') || (!alt && i.isDown('ArrowUp'));
    const down = i.anyDown('ControlLeft', 'ControlRight') || (!alt && i.isDown('ArrowDown'));
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
      const res = this.aircraft.snapFollowCamera();
      const m = res.mode;
      // Legacy toast line is asserted by tests/cinematic_juice_test.mjs and must
      // sit immediately before _saveLastView(); the rich preset toast is emitted
      // last so it is the one the player actually sees.
      this.ui.toast('VIEW · ' + m.toUpperCase());
      this._saveLastView();
      this.ui.toast(`FOLLOW ${res.index + 1}/${res.count} · ${res.preset.label} · ${res.preset.dist}M · ${res.preset.elevLabel}`);
    }
    if (i.wasPressed('KeyC')) {
      const m = this.aircraft.nextMode();
      this.ui.toast('CAMERA · ' + m.toUpperCase());
      this._saveLastView();
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
    if (i.wasPressed('Digit4')) { this.weapons.selectWeapon('BFFG'); this.audio.click(); this.ui.toast('WEAPON · BFFG-9000'); }
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
    // Feature 32: Photo Mode freezes the whole simulation — only the orbit rig
    // and the render loop keep running.
    if (this.photoMode.active) {
      this._updatePhotoMode(dt);
      return;
    }

    // Free Camera (F7): aircraft stays parked/frozen while the world streams
    // live around the detached 6-DOF spectator camera.
    if (this.freeCam.active) {
      this._updateFreeCam(dt);
      return;
    }

    const simDt = Math.min(dt, 0.05);
    const fly = this.mode === 'fly';
    const menu = this.mode === 'menu';

    if (fly || menu) {
      this.time.update(menu ? simDt * 0.25 : simDt);
      this.weather.update(menu ? simDt * 0.5 : simDt);
    }

    let cmd = NEUTRAL_CMD;
    if (fly) {
      // Press-and-hold H: after 380 ms the Smart Autopilot Prompt opens.
      if (!this.ejection.active && this._keyHDownAt > 0 && !this._keyHHeldFired
        && (performance.now() - this._keyHDownAt) >= 380) {
        this._keyHHeldFired = true;
        this._engageSmartHoldH();
      }
      cmd = this.ejection.active ? NEUTRAL_CMD : this.buildCommand();
      this.handleFlightKeys(cmd);
      if (!this.ejection.active) {
        const apCtx = this._apContext;
        apCtx.airport = this._autoLandAirport;
        // The LIVE tanker object is the only one carrying the orbit kinematics
        // (velocity, _omega, radius, anchor) the polar-orbit bank feedforward
        // needs — `_tankerState` is its flat telemetry snapshot.
        apCtx.tanker = this.tanker;
        apCtx.fuel = this._fuelState;
        cmd = this.autopilot.computeCommand(this.aircraft.flight, cmd, apCtx);
        const apNotice = this.autopilot.consumeNotice();
        if (apNotice) {
          this.audio.click();
          this.ui.toast(apNotice);
        }
      }
      if (this._fuelState && this._fuelState.empty) {
        this.aircraft.flight.targetThrottle = 0;
      }

      // Live flight-plan strip: AUTO_LAND / AUTO_REFUEL only, rebuilt only when
      // the printed markup changes (safe to call every frame).
      if (!this.ejection.active && typeof this.autopilot.getPlanSummary === 'function') {
        const fuelPct = this._fuelState
          ? (Number.isFinite(this._fuelState.pct) ? this._fuelState.pct : this._fuelState.fraction ?? 1)
          : 1;
        this.autopilotPrompt.updatePlanStrip(this.autopilot.getPlanSummary(), { fuelPct });
      } else {
        this.autopilotPrompt.updatePlanStrip(null);
      }
    } else {
      // Menu / pause / crash: the plan strip is flight-only glass.
      this.autopilotPrompt.updatePlanStrip(null);
    }

    this._replayActive = fly && this.replay.playing && this.replay.count >= 2;

    if (fly) {
      const f = this.aircraft.flight;
      if (this._replayActive) {
        // Playback drives the airframe; live physics, weapons and damage are
        // skipped so the recorded run plays back untouched.
        this._stepReplay(simDt);
      } else {
        const alerts = {
          night: this.sky.night,
          rain: this.weather.state.rain,
          lowFuel: !!this._fuelState?.bingo,
          rwrThreat: this._rwrHighest === 'LOCK' || this._rwrHighest === 'LAUNCH',
          flameout: !!this._fuelState?.empty,
          time: this.time.hour,
        };
        // AERO-2: live fuel + ordnance loadout drives mass, drag and CAT mode.
        // Scratch object reused every frame so the update loop allocates nothing.
        if (typeof f.setLoadout === 'function') {
          const lo = this._loadoutScratch;
          lo.fuelLb = Number.isFinite(this.fuel?.fuelLb) ? this.fuel.fuelLb : 0;
          lo.aim9 = this.weapons?.ammo?.AIM9 ?? 0;
          lo.mk82 = this.weapons?.ammo?.MK82 ?? 0;
          lo.bffg = this.weapons?.ammo?.BFFG ?? 0;
          f.setLoadout(lo);
        }
        // Weather mirrors the sky for this frame. The sun direction/colour are
        // handed over *before* the flight model integrates so anything that
        // follows the sun (cockpit sun-shadow rig, lighting consumers in
        // aircraft.js) reads this frame's sun instead of last frame's.
        this.weather.night = this.sky.night;
        this.weather.sunDir = this.sky.sunDir;
        this.weather.sunColor = this.sky.sunColor;
        this.aircraft.update(simDt, cmd, this.weather, this.input, true, alerts);

        // Carrier operations: arresting wires, steam catapult, FLOLS meatball.
        const cRes = this.carrier.update(simDt, f, this.weather);
        this._meatballState = cRes.meatball;
        if (cRes.newlyCaughtWire > 0) {
          this.ui.toast(`CARRIER · OK ${cRes.newlyCaughtWire}-WIRE!`);
          this.audio.thump(0.75);
        }
        if (cRes.catapultLaunched) {
          this.ui.toast('CATAPULT · LAUNCH!');
          this.vfx.spawnTireSmoke(f.position, 1.4);
          this.juice.addImpulse(0.42, 0.35);
        }

        if (f.touchdown > 0.2) {
          this.audio.thump(clamp(f.touchdown / 5, 0.15, 1));
          this.vfx.spawnTireSmoke(
            { x: f.position.x, y: f.position.y - 1.4, z: f.position.z },
            clamp(f.touchdown / 3, 0.5, 1.4),
          );
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
      }

      // Feature 32: flight juice — G-LOC, G-strain, Mach crossing and recoil.
      // AERO-2: true ISA Mach so the shockwave pulse fires at M 1.0 at altitude,
      // plus the airframe buffet so high-AoA / transonic shudder is felt.
      const mach = Number.isFinite(f.mach) ? f.mach : f.speed / 340.3;
      this._juiceState = this.juice.update(simDt, {
        gLoad: f.gLoad,
        mach,
        buffet: f.buffet || 0,
        afterburner: f.afterburner,
        onGround: f.onGround,
        speed: f.speed,
      });
      if (this._juiceState.shockwaveCrossed) {
        this.postfx.pulseBloom(0.45);
        const boom = this.combatAudio.playSonicBoom || this.combatAudio.sonicBoom;
        boom?.call(this.combatAudio);
      }

      // Feature 30: Soča Canyon gates — one pass per frame, gate index to HUD.
      if (this.canyonRun.active) {
        const cr = this.canyonRun.update(simDt, f.position, f.speed);
        this._canyonState = this.canyonRun.getState();
        if (cr.gatePassed) {
          this.audio.click();
          this.ui.toast('GATE ' + this._canyonState.gateIndex + '/'
            + this._canyonState.totalGates + ' · ' + cr.gatePassed.name);
          this.postfx.pulseBloom(0.28);
        }
        if (cr.finished && !this._canyonFinishAnnounced) {
          this._canyonFinishAnnounced = true;
          this.ui.toast('COURSE COMPLETE · ' + cr.medal + ' MEDAL');
          this.betty.announce('Course complete, ' + cr.medal + ' medal');
          this.postfx.pulseBloom(0.5);
        }
      }
    } else if (menu) {
      this.aircraft.update(simDt, NEUTRAL_CMD, this.weather, this.input, false);
    } else if (this.mode === 'crash') {
      this.aircraft.update(simDt, NEUTRAL_CMD, this.weather, this.input, true);
    }

    // atmosphere and streaming keep running (frozen during pause)
    if (this.mode !== 'pause' || !this.ready) {
      this.sky.update(simDt, this.time, this.weather, this.camera, this.weather.flash, fly && this.aircraft.mode === 'cockpit');
      this.world.update(simDt, this.camera, this.sky, this.weather);
      this.clouds.update(simDt, this.camera, this.weather, this.sky);
    }

    if (fly) {
      const f = this.aircraft.flight;
      // Combat updates: target lock, firing, ballistics, SAM AI, missions, VFX
      if (!this._replayActive) {
        this._lockedTarget = this.targets.findLockTarget(f, this.weapons.selected);
        const triggerHeld = this.input.isDown('Space')
          || (this.aircraft.mode === 'cockpit' && this.input.pointerLocked && (this.input.mouse.buttons & 1));
        if (triggerHeld && !f.crashed) {
          const fired = this.weapons.fire(f, this._lockedTarget);
          if (fired.fired) {
            if (fired.type === 'GUN') {
              this.combatAudio.cannonShot();
              this.vfx.triggerMuzzleFlash(f);
              this.juice.addImpulse(0.16, 0.14);
            } else if (fired.type === 'AIM9') {
              this.combatAudio.missileLaunch();
              this.juice.addImpulse(0.28, 0.22);
              this.ui.toast('FOX 2 · AIM-9 AWAY');
            } else if (fired.type === 'MK82') {
              this.combatAudio.bombRelease();
              this.juice.addImpulse(0.28, 0.22);
              this.ui.toast('PICKLE · MK-82 AWAY');
            } else if (fired.type === 'BFFG') {
              this.combatAudio.bffgFire();
              this.juice.addImpulse(0.48, 0.35);
              this.postfx.pulseBloom(0.5);
              this.ui.toast('BFFG AWAY — BRACE FOR IMPACT!!');
            }
          }
        }

        const wEvents = this.weapons.update(simDt, f, this.world, this.targets.targets, this._lockedTarget);
        for (const ev of wEvents) {
          if (ev.kind === 'trail') {
            this.vfx.spawnTrail(ev.position, ev.color, ev.size);
          } else if (ev.kind === 'impact') {
            const isBffg = ev.weapon === 'BFFG';
            const scale = isBffg ? 14 : (ev.weapon === 'MK82' ? 4.5 : (ev.weapon === 'AIM9' ? 2.8 : 0.65));
            this.vfx.spawnExplosion(ev.position, scale);
            // Feature 21/24: rising smoke columns that linger after the fireball.
            if (isBffg) {
              this.vfx.spawnSmokePlume(ev.position, 75);
            } else if (ev.weapon === 'MK82') {
              this.vfx.spawnSmokePlume(ev.position, 28);
            } else if (ev.weapon === 'AIM9') {
              this.vfx.spawnSmokePlume(ev.position, 12);
            }
            const dist = Math.hypot(
              ev.position.x - f.position.x,
              ev.position.y - f.position.y,
              ev.position.z - f.position.z,
            );
            // Feature 32: distance-scaled blast shake plus a bloom spike.
            this.juice.addImpulse(clamp(1 - dist / 900, 0, 1) * 0.9, 0.38);
            this.postfx.pulseBloom(isBffg ? 0.75 : 0.45);
            if (isBffg) this.combatAudio.megaExplosion(dist);
            else if (ev.weapon !== 'GUN' || ev.hitTargetId) this.combatAudio.explosion(dist);
            const destroyed = this.targets.applyImpact(ev);
            // Feature 20/21/23: the same blast levels any city in the kill zone.
            const bRes = this.world.buildings.applyBlast(ev.position, ev.splashRadius, ev.damage);
            const plumeCount = isBffg ? 6 : 3;
            const plumeDuration = isBffg ? 70 : 55;
            for (let i = 0; i < Math.min(plumeCount, bRes.positions.length); i++) {
              this.vfx.spawnSmokePlume(bRes.positions[i], plumeDuration);
            }
            if (isBffg) {
              this.ui.toast(bRes.destroyedCount > 0
                ? 'WOOPS · ' + bRes.destroyedCount + ' STRUCTURES VAPORIZED!!'
                : 'WOOPS · BFFG DETONATION!!');
            } else if (bRes.destroyedCount > 0 && destroyed.length === 0) {
              this.ui.toast('IMPACT · ' + bRes.destroyedCount
                + (bRes.destroyedCount > 1 ? ' STRUCTURES DESTROYED' : ' STRUCTURE DESTROYED'));
            }
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

        // Feature 22/24: burning buildings visibly belch flame + smoke while they
        // collapse. Throttled to ~7 Hz so the puff pool is not starved.
        this._collapseFxT = (this._collapseFxT || 0) + simDt;
        if (this._collapseFxT >= 0.14) {
          this._collapseFxT = 0;
          const bld = this.world.buildings;
          if (bld && typeof bld.getCollapsingFirePoints === 'function') {
            const firePoints = bld.getCollapsingFirePoints();
            const n = Math.min(6, firePoints.length);
            for (let i = 0; i < n; i++) this.vfx.spawnFirePuff(firePoints[i], 1.3);
          }
        }

        // Feature 26: levelled blocks keep smouldering for 75 s. Poll the ruin
        // emitters on a 0.35 s timer and feed up to 5 of the freshest into the
        // fire-puff pool so devastated city blocks glow and smoke long after
        // the fireball has gone.
        this._ruinFxT = (this._ruinFxT || 0) + simDt;
        if (this._ruinFxT >= 0.35) {
          this._ruinFxT = 0;
          const bld = this.world.buildings;
          if (bld && typeof bld.getRuinFirePoints === 'function') {
            const ruins = bld.getRuinFirePoints();
            const start = Math.max(0, ruins.length - 5);
            for (let i = start; i < ruins.length; i++) this.vfx.spawnFirePuff(ruins[i], 0.85);
          }
        }
      }

      const vfxState = this.vfx.update(simDt, f, this.weather, this.camera);
      if (vfxState.sonicBoom) {
        this.combatAudio.sonicBoom();
        this.ui.toast('MACH 1.0 · SONIC BOOM');
      }

      const glocState = this.tactical.update(simDt, f);

      if (!this._replayActive) {
        // Wave 3 systems: Tanker, Fuel, Traffic/Wingman, ILS, Kneeboard & Bitching Betty
        const wasTankerContact = !!this._tankerState?.contact;
        this._tankerState = this.tanker.update(simDt, f);
        if (this._tankerState?.contact && !wasTankerContact) {
          this.combatAudio.boomContact();
          this.ui.toast('TANKER · BOOM CONTACT — FUEL FLOWING');
        }
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
      }
      this.replay.record(simDt, f);

      let rwrHighest = 'NONE';
      const rank = { NONE: 0, SEARCH: 1, LOCK: 2, LAUNCH: 3 };
      for (const c of this._rwrContacts) {
        const st = c.isMissile ? 'LAUNCH' : (c.state || 'SEARCH');
        if ((rank[st] || 0) > rank[rwrHighest]) rwrHighest = st;
      }
      this._rwrHighest = rwrHighest;
      this.combatAudio.update(simDt, {
        weapon: this.weapons.selected,
        hasLock: !!this._lockedTarget,
        rwrHighest,
        gStrain: glocState.gStrain,
        paused: false,
      });

      const t = this.aircraft.telemetry(this.weather, this.time, this.sky);
      this._ilsState = this.ils.update(simDt, f, this._divertAirport || t.airport);
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
      if (this.autopilot.mode === 'AUTO_LAND') {
        const label = this._autoLandAirport?.code || this._autoLandAirport?.name
          || this.autopilot.targetLabel || 'AIRBASE';
        t.autopilot = 'AUTO_LAND · ' + label;
      } else if (this.autopilot.mode === 'AUTO_REFUEL') {
        t.autopilot = 'AUTO_REFUEL';
      } else {
        t.autopilot = this.autopilot.mode;
      }
      t.ils = this._ilsState;
      t.meatball = this._meatballState;
      t.cloudMist = this._cloudMist;
      t.replaying = this._replayActive;
      t.replayRate = this.replay.playbackRate;
      t.replayTime = this.replay.playTime;
      t.replayDuration = this.replay.duration;
      // Feature 32/30: juice vignettes, canyon strip and weapon-cam banner.
      t.juice = this._juiceState;
      t.canyon = this._canyonState;
      t.weaponCam = this._weaponCamState;

      // Kneeboard diversion: a picked airport becomes the active steerpoint on
      // free flight (or whenever the mission has none of its own).
      const divert = this._divertAirport
        && (!this._missionSnap?.steerpoint || this._missionSnap.status === 'FREE')
        ? {
          x: this._divertAirport.x,
          z: this._divertAirport.z,
          label: 'DIV ' + this._divertAirport.code,
          kind: 'DIVERT',
        }
        : null;
      // Feature 30: while the canyon run is live the steerpoint box rides the
      // next sky gate instead of the mission objective.
      const canyonSteer = (this._canyonState?.active && this._canyonState.nextGate)
        ? this._gateSteerpoint(this._canyonState.nextGate, f, t)
        : null;
      const steerpoint = canyonSteer || divert || this._missionSnap?.steerpoint || null;
      const missionState = (canyonSteer || divert)
        ? { ...this._missionSnap, steerpoint }
        : this._missionSnap;

      // Cloud-entry mist washes the view; smooth it so deck entry is not a pop.
      const mistTarget = this.clouds.getCloudDensity(this.camera.position, this.weather);
      this._cloudMist += (mistTarget - this._cloudMist) * (1 - Math.exp(-2.5 * simDt));
      if (mistTarget === 0 && this._cloudMist < 0.002) this._cloudMist = 0;

      // Feature 32: the weapon follow-cam takes the camera AFTER the aircraft
      // camera has placed it this frame; otherwise it reports idle.
      if (this.weaponCam.active) {
        this._weaponCamState = this.weaponCam.update(simDt, this.camera, this.weapons, f.position);
      } else {
        this._weaponCamState = null;
      }

      // Recoil / G / Mach shake, never applied in Photo Mode (handled above).
      const juice = this._juiceState;
      if (juice) {
        this.camera.position.x += juice.shakeX * 1.6;
        this.camera.position.y += juice.shakeY * 1.6;
        this.camera.rotation.z += juice.shakeRoll;
      }

      this.camera.updateMatrixWorld();

      // Feature 41: autosave the live airframe roughly twice a second, so a
      // hard reload resumes the exact position, attitude, speed and controls.
      if (!this._replayActive) {
        this._lastViewTimer -= simDt;
        if (this._lastViewTimer <= 0) {
          this._lastViewTimer = 0.5;
          this._saveLastView();
        }
      }

      this.hud.update(simDt, t, {
        overlay: this.tactical,
        kneeboard: this.kneeboard,
        kneeboardState: this.kneeboard.visible ? {
          flight: f,
          heading: t.heading,
          heightAt: (x, z) => this.world.heightAt(x, z),
          airports: this._kneeboardAirports(f),
          targets: this.targets.targets,
          tanker: this._tankerState,
          steerpoint,
          windDir: t.windDir,
          windKts: t.windKts,
          geoOrigin: this._vipavaGeoOrigin,
          places: this._vipavaPlaces || settlementsNear(f.position.x, f.position.z, this.kneeboard.rangeM)
            .filter((s) => s.type !== 'hamlet')
            .map((s) => ({ name: s.name, x: s.x, z: s.z, kind: s.type })),
        } : null,
        telemetry: t,
        camera: this.camera,
        weapons: this.weapons,
        lockedTarget: this._lockedTarget,
        targets: this.targets.targets,
        rwrContacts: this._rwrContacts,
        mission: missionState,
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
        doppler: this.aircraft.dopplerRatio,
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
    this.autopilotPrompt?.hide(false);
    this.autopilotPrompt?.updatePlanStrip(null);
    this.mode = 'crash';
    this._crashTimer = 0;
    this.aircraft.setMode('chase');
    this.audio.crash();
    this.input.releasePointerLock();
    this.hud.setVisible(false);
    this.ui.showCrash(this.aircraft.flight.crashReason || 'IMPACT');
    // Feature 41: a crashed jet must never reload back into the crash — the
    // record flips to kind 'none' so a reload opens the menu instead.
    this._saveLastView();
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    const raw = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(0.1, Math.max(0.0001, raw));
    this.fps = this.fps * 0.94 + (1 / dt) * 0.06;

    // PERF-19: dynamic resolution. Only steer while actually flying or in Free
    // Cam — boot, menu and pause are not representative loads. Clamp the
    // single-frame spike so a tab switch or a long stall cannot look like
    // sustained slowness and yank the resolution down.
    if (!this.paused && (this.mode === 'fly' || this.mode === 'freecam')) {
      const rawMs = Math.min(100, Math.max(4, raw * 1000));
      this._frameEmaMs += (rawMs - this._frameEmaMs) * (1 - Math.exp(-dt * 2.5));
      this._dynClockSec += dt;

      if (this._frameEmaMs > 18.5) {
        this._dynSlowSec += dt;
        this._dynFastSec = 0;
      } else if (this._frameEmaMs < 14.0) {
        this._dynFastSec += dt;
        this._dynSlowSec = 0;
      } else {
        this._dynSlowSec = 0;
        this._dynFastSec = 0;
      }

      const sinceResize = this._dynClockSec - this._dynLastResizeSec;
      if (this._dynSlowSec >= 2.0 && sinceResize >= 1.0 && this._dynScale > 0.75) {
        this._dynScale = Math.max(0.75, Math.round((this._dynScale - 0.1) * 100) / 100);
        this._dynSlowSec = 0;
        this._dynLastResizeSec = this._dynClockSec;
        this.resize();
      } else if (this._dynFastSec >= 4.0 && sinceResize >= 1.0 && this._dynScale < 1.0) {
        this._dynScale = Math.min(1.0, Math.round((this._dynScale + 0.05) * 100) / 100);
        this._dynFastSec = 0;
        this._dynLastResizeSec = this._dynClockSec;
        this.resize();
      }
    }

    if (this.ready) this.update(dt);
    this.postfx.setNight(this.sky.night);

    // VIPER-OPTICS: hand the helmet-cam lens this frame's flight state. One
    // preallocated scratch object is reused, so the render loop allocates
    // nothing. setOptics() only writes targets; update() glides and uploads.
    {
      const fl = this.aircraft && this.aircraft.flight;
      const opt = this._opticsScratch;
      if (fl) {
        const speed = Number.isFinite(fl.speed) ? fl.speed : 0;
        const agl = Number.isFinite(fl.agl) ? fl.agl : 1000;
        opt.cockpitView = this.aircraft.mode === 'cockpit' && this.mode === 'fly';
        opt.speedNorm = clamp(speed / 350, 0, 1.4);
        opt.gLoad = Number.isFinite(fl.gForce) ? fl.gForce : 1;
        opt.afterburner = !!fl.afterburner;
        opt.machPulse = this._juiceState?.machPulse || 0;
        // Low altitude + speed is the classic "ground rush" cue.
        opt.aglNorm = 1 - smoothstep(15, 220, agl);
        opt.freeCam = !!(this.freeCam && this.freeCam.active);
        // Menu/boot only: the frozen pause frame and crash cam keep the lens
        // they had, so pausing never pops the image back to rectilinear.
        opt.menu = !opt.freeCam && (this.mode === 'menu' || this.mode === 'boot');
        opt.night = this.sky.night;
      }

      // VIPER-OPTICS sun flare: project sky.sunDir through the live camera so
      // the analytical starburst / anamorphic streak / bokeh ghosts in the
      // optics shader sit exactly on the sun disc. Scratch vectors only — the
      // render loop still allocates nothing.
      const sun = this.sky && this.sky.sunDir;
      const cam = this.camera;
      if (sun && cam) {
        // Refresh the camera matrices so the projection matches this frame's
        // pose (the renderer would otherwise only update them in render()).
        cam.updateWorldMatrix(true, false);
        const e = cam.matrixWorld.elements;
        // World-space point 10 km down the sun ray, then project to NDC.
        _sunProj.set(e[12], e[13], e[14]).addScaledVector(sun, 10000).project(cam);
        const ndcX = Number.isFinite(_sunProj.x) ? _sunProj.x : 0;
        const ndcY = Number.isFinite(_sunProj.y) ? _sunProj.y : 0;

        cam.getWorldDirection(_camFwd);
        const sunFacing = _camFwd.dot(sun);
        const sunElev = sun.y;
        const overcast = this.weather?.state?.overcast ?? 0;

        // Only a sun that is actually in front of the camera, above the
        // horizon and not buried in overcast (or Free Cam / menu) flares. The
        // NDC term fades the flare smoothly as the disc leaves the frame.
        let sunFlare = 0;
        if (!opt.freeCam && this.mode !== 'menu' && this.mode !== 'boot' &&
            sunFacing > 0.12 && sunElev > -0.02) {
          sunFlare = smoothstep(0.12, 0.55, sunFacing)
            * smoothstep(-0.02, 0.18, sunElev)
            * (1 - overcast * 0.85)
            * (1 - Math.min(1, Math.hypot(ndcX, ndcY) * 0.55));
        }

        opt.sunScreenX = ndcX * 0.5 + 0.5;
        opt.sunScreenY = ndcY * 0.5 + 0.5;
        opt.sunFlare = sunFlare;
        opt.sunColor = this.sky.sunColor;
      } else {
        opt.sunFlare = 0;
      }

      this.postfx.setOptics(this._opticsScratch);
    }

    this.postfx.update(dt);
    this.postfx.render(this.scene, this.camera);
    this.input.endFrame();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  window.__falcon = app;
  attachMcpBridge(app);
});