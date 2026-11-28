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
import { InspectorMap } from './ui/inspector_map.js';
import { UI } from './ui/menu.js';
import { spawnPoint, airportNear, airportsNear, setActiveDEM, setCustomAirports, terrainHeight } from './world/terrain.js';
import { loadVipavaDEM, loadVipavaOSM, loadVipavaBuildings, loadVipavaWater } from './world/dem.js';
import { settlementsNear, clearSettlementCaches } from './world/settlements.js';
import { clamp } from './world/noise.js';

const NEUTRAL_CMD = {
  pitch: 0, roll: 0, yaw: 0, throttleDelta: 0,
  gearToggle: false, flapsToggle: false, brake: false,
};

// Feature 41: localStorage slot holding the last Free Cam pose + environment.
const LAST_VIEW_KEY = 'falcon.lastView.v1';
// FreeCamController clamps its speed to 15..5000 m/s; mirror that on restore.
const LAST_VIEW_SPEED_MIN = 15;
const LAST_VIEW_SPEED_MAX = 5000;

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
      // Feature 33: floating Photo Mode bar buttons.
      onPhotoSave: () => this._savePhoto(),
      onPhotoExit: () => this.exitPhotoMode(),
      onFreeCamMap: () => this.toggleInspectorMap(),
      onFreeCamExit: () => this.exitFreeCam(),
    });

    this.time = new TimeSystem();
    this.time.setHour(this.ui.hour);
    this.weather = new WeatherSystem(this.ui.weather, this.ui.wind);
    this.sky = new SkySystem(this.scene, this.renderer);

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
    this._vipavaRoads = [];
    this._vipavaWater = null;
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
    this._canyonState = null;
    this._juiceState = null;
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

    // Feature 41: flush the Free Cam pose on tab hide / reload. Guarded so a
    // headless import of this module never touches a missing global.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this._saveLastView());
      window.addEventListener('pagehide', () => this._saveLastView());
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
    return Math.min(window.devicePixelRatio || 1, this.preset.pixelRatio);
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
    this.renderer.setPixelRatio(this._pixelRatio());
    this.world.setPreset(q);
    this.postfx.setEnabled(q.name !== 'low');
    this.resize();
    this.ui.toast('QUALITY · ' + name.toUpperCase());
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
      if (this._proceduralSpawn) this.spawn = this._proceduralSpawn;
      this.carrier.placeNear(this.spawn.x, this.spawn.z);
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
    const isFreeCamToggle = (e.ctrlKey && !e.shiftKey && !e.altKey && code === 'KeyF') || code === 'F7';
    if (isFreeCamToggle && this.ready) {
      e.preventDefault();
      this.toggleFreeCam();
      return;
    }
    if (this.freeCam.active) {
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

  /** F7: detached 6-DOF spectator camera for fast world inspection without flying. */
  toggleFreeCam() {
    if (this.freeCam.active) {
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
    if (!mapOpen) {
      if (i.mouse.dx || i.mouse.dy) {
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
   * Feature 41: write the Free Cam pose plus the active environment into
   * localStorage so a reload can drop the user back where they were.
   * Everything is inside try/catch — private mode, disabled storage, a quota
   * error or a headless run must never break the frame.
   */
  _saveLastView() {
    if (this._restoringLastView) return;
    try {
      const fc = this.freeCam;
      if (!fc) return;
      const p = fc.position;
      localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({
        active: !!fc.active,
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
      }));
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
   * Feature 41: after boot, put the user straight back into the Free Cam pose
   * they reloaded from. Returns true when a restore actually happened.
   */
  async _restoreLastView() {
    const saved = this._loadLastView();
    if (!saved || saved.active !== true) return false;
    if (![saved.x, saved.y, saved.z].every((v) => Number.isFinite(v))) return false;

    // Suppress autosaves until the camera is actually in place, so the
    // setTheater/setQuality calls below cannot overwrite the saved pose.
    this._restoringLastView = true;
    try {
      // Environment first, using exactly the calls the Inspector Map makes.
      if (THEATERS[saved.theater] && saved.theater !== (this._activeTheater || this.ui.theater)) {
        await this.setTheater(saved.theater);
      }
      if (saved.quality && QUALITY[saved.quality] && saved.quality !== this.preset.name) {
        this.setQuality(saved.quality);
      }
      if (Number.isFinite(saved.hour)) this.time.setHour(saved.hour);
      if (saved.weather && WEATHER[saved.weather]) this.weather.setPreset(saved.weather, true);

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
    } catch (err) {
      console.warn('LAST VIEW · restore failed, opening menu', err);
      this.freeCam.exit();
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

  async startFlight() {
    if (!this.ready) return;
    this.input.requestPointerLock();
    this.audio.start().then(() => {
      if (this.audio.ctx && this.audio.nodes?.sfxBus) {
        this.combatAudio.attach(this.audio.ctx, this.audio.nodes.sfxBus);
      }
    });
    this.audio.resetEngine();
    this.audio.setPaused(false);
    // Wait for the baked theater (DEM + OSM) so the spawn is the real runway.
    await this.setTheater(this.ui.theater || 'vipava');
    this.aircraft.setMode('cockpit');
    // Feature 30: the Soča Canyon Run starts airborne right outside Gate 1.
    const spawn = this.ui.mission === 'soca_run' ? this._socaRunSpawn() : this.spawn;
    this._placeAtSpawn(spawn);
    this._startActiveMission(spawn);
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
      f.gearDown = false;
      f.gearPos = 0;
      f.gearTarget = 0;
      f.onGround = false;
      f.throttle = 0.85;
      f.targetThrottle = 0.85;
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
      cmd = this.ejection.active ? NEUTRAL_CMD : this.buildCommand();
      this.handleFlightKeys(cmd);
      if (!this.ejection.active) {
        cmd = this.autopilot.computeCommand(this.aircraft.flight, cmd);
      }
      if (this._fuelState && this._fuelState.empty) {
        this.aircraft.flight.targetThrottle = 0;
      }
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
        this.aircraft.update(simDt, cmd, this.weather, this.input, true, alerts);
        this.weather.night = this.sky.night;

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
      const mach = Number.isFinite(f.mach) ? f.mach : f.speed / 340.3;
      this._juiceState = this.juice.update(simDt, {
        gLoad: f.gLoad,
        mach,
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
      this.sky.update(simDt, this.time, this.weather, this.camera, this.weather.flash);
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
      t.autopilot = this.autopilot.mode;
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
    this.postfx.setNight(this.sky.night);
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