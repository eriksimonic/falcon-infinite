// World aggregate: terrain, airports, settlements, vegetation.
import * as THREE from 'three';
import { TerrainView } from './terrainview.js';
import { AirportSystem } from './airports.js';
import { BuildingSystem } from './buildings.js';
import { VegetationSystem } from './vegetation.js';
import { RoadNetwork } from './roadnet.js';
import { terrainHeight, slopeAt, airportNear, airportsNear } from './terrain.js';

export class World {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset;
    this.terrain = new TerrainView(scene, preset);
    this.airports = new AirportSystem(scene, preset);
    this.buildings = new BuildingSystem(scene, preset);
    this.vegetation = new VegetationSystem(scene, preset);
    this.roads = new RoadNetwork(scene, preset);
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
  }

  heightAt(x, z) {
    return terrainHeight(x, z);
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