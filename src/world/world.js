// World aggregate: terrain, airports, settlements, vegetation.
import * as THREE from 'three';
import { TerrainView } from './terrainview.js';
import { AirportSystem } from './airports.js';
import { BuildingSystem } from './buildings.js';
import { VegetationSystem } from './vegetation.js';
import { RoadNetwork } from './roadnet.js';
import { InlandWaterSystem } from './water.js';
import { LandmarkSystem } from './landmarks.js';
import { RoadTrafficSystem } from './traffic_roads.js';
import { terrainHeight, slopeAt, airportNear, airportsNear } from './terrain.js';

// Vehicle budget per quality preset (mirrors traffic_roads.js).
const TRAFFIC_BUDGET = { low: 120, medium: 220, high: 320 };

export class World {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset;
    this.terrain = new TerrainView(scene, preset);
    this.airports = new AirportSystem(scene, preset);
    this.buildings = new BuildingSystem(scene, preset);
    this.vegetation = new VegetationSystem(scene, preset);
    this.roads = new RoadNetwork(scene, preset);
    // Real OSM rivers & lakes, draped over the active terrain (Vipava theater).
    this.inlandWater = new InlandWaterSystem(scene);
    // Iconic real-world landmarks (churches, bridges, dams, masts, castles,
    // lighthouses) re-grounded on the active DEM when the theater is Vipava.
    this.landmarks = new LandmarkSystem(scene);
    // Feature 31: two instanced pools of headlight/taillight streaks that keep
    // the H4 expressway and valley arteries alive at night. Roads are handed
    // over by main.js once the baked OSM extract has loaded.
    this.roadTraffic = new RoadTrafficSystem(scene, preset);
    // Optional offshore carrier group; main.js attaches one once it is placed.
    this.carrier = null;
  }

  setPreset(preset) {
    this.preset = preset;
    this.terrain.preset = preset;
    this.airports.preset = preset;
    this.buildings.preset = preset;
    this.vegetation.preset = preset;
    this.roads.preset = preset;
    this.buildings._needsRebuild = true;
    this.vegetation._lastX = Infinity;
    // Traffic pools are sized once; follow the new budget without ever
    // exceeding the allocated instance slots (a smaller quality stays safe).
    const traffic = this.roadTraffic;
    if (traffic) {
      traffic.preset = preset;
      const pool = traffic.headMesh ? traffic.headMesh.instanceMatrix.count : Infinity;
      const budget = TRAFFIC_BUDGET[String(preset.name || 'medium').toLowerCase()] || 220;
      traffic.maxVehicles = Math.min(budget, pool);
      if (traffic.roads.length > 0) traffic._spawnVehicles();
    }
  }

  setTheater(name) {
    this.terrain.setTheater(name);
    if (this.vegetation && this.vegetation.group) {
      // Sparse arid theater: dim vegetation slightly in desert mode
      this.vegetation.group.visible = name !== 'desert';
    }
  }

  update(dt, camera, sky, weather) {
    this.terrain.update(dt, camera);
    this.terrain.setAtmosphere(sky.sunDir, sky.sunColor, sky.skyColor);
    this.airports.update(dt, camera, weather, sky);
    this.buildings.update(dt, camera, sky);
    this.roads.update(camera);
    this.vegetation.update(dt, camera, sky);
    this.inlandWater.update(dt, sky);
    this.landmarks.update(dt, sky.night);
    // Feature 31: night lights on the H4/Vipava arteries, culled at 22 km.
    this.roadTraffic.update(dt, camera.position, sky.night);
  }

  heightAt(x, z) {
    const h = terrainHeight(x, z);
    // A carrier deck is walkable/landable ground wherever it floats above the sea.
    if (this.carrier) {
      const deck = this.carrier.getDeckElevation(x, z);
      if (deck !== null && deck > h) return deck;
    }
    return h;
  }

  slopeAt(x, z) {
    return slopeAt(x, z);
  }

  nearestAirport(x, z, maxDist = 60000) {
    return airportNear(x, z, maxDist);
  }

  airportsNear(x, z, radius = 2) {
    return airportsNear(x, z, radius);
  }
}