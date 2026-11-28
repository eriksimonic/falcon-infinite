export const CONFIG = {
  seed: 20261125,
  version: '1.0.0',

  render: {
    fov: 62,
    near: 0.3,
    far: 70000,
    fogDensity: 0.000016,
    exposure: 1.18,
  },

  world: {
    seaLevel: 0,
    terrainRootSize: 32768,
    terrainMinSize: 128,
    terrainMaxLevel: 8,
    terrainDetailDistance: 1.55,
    tileCacheLimit: 900,
    waterSize: 260000,
  },

  aircraft: {
    mass: 10800,          // kg, half fuel
    wingArea: 27.87,      // m^2
    maxThrust: 76000,     // N dry
    afterburner: 127000,  // N
    vne: 700,             // m/s
    gearHeight: 1.58,
    bellyHeight: 0.72,
    spawnSpeed: 0,
  },

  time: {
    startHour: 15.5,
    dayLengthSeconds: 1500, // one full 24h at time scale 1
    scales: [1, 5, 20, 60, 300],
    scaleIndex: 0,
  },

  camera: {
    chaseDistance: 26,
    chaseHeight: 7.5,
    wingOffset: [7.5, 1.6, 4.0],
    cockpitFov: 52,
    externalFov: 50,
    mouseSensitivity: 0.0022,
  },

  hud: {
    color: '#8dffb4',
    dim: 'rgba(141,255,180,0.55)',
  },
};

export const QUALITY = {
  low: {
    name: 'low',
    pixelRatio: 0.8,
    antialias: false,
    segmentsNear: 24,
    segmentsFar: 12,
    clouds: 130,
    cloudLayers: 2,
    buildingRadius: 5000,
    buildingLimit: 6000,
    treeRadius: 2200,
    treeLimit: 900,
    airportRadius: 28000,
    roadDetail: false,
    shadows: false,
  },
  medium: {
    name: 'medium',
    pixelRatio: 1.0,
    antialias: true,
    segmentsNear: 32,
    segmentsFar: 16,
    clouds: 240,
    cloudLayers: 3,
    buildingRadius: 8000,
    buildingLimit: 16000,
    treeRadius: 3200,
    treeLimit: 2200,
    airportRadius: 45000,
    roadDetail: true,
    shadows: false,
  },
  high: {
    name: 'high',
    pixelRatio: 1.35,
    antialias: true,
    segmentsNear: 40,
    segmentsFar: 20,
    clouds: 340,
    cloudLayers: 4,
    buildingRadius: 11000,
    buildingLimit: 26000,
    treeRadius: 4200,
    treeLimit: 3800,
    airportRadius: 60000,
    roadDetail: true,
    shadows: false,
  },
};

export const WEATHER = {
  clear: {
    label: 'CLEAR', coverage: 0.04, density: 0.0, rain: 0, fog: 0.000008,
    wind: [2, 1], turbulence: 0.12, visibility: 1.0, cloudBase: 2500,
    windSpeed: 3,
  },
  few: {
    label: 'FEW', coverage: 0.22, density: 0.18, rain: 0, fog: 0.000012,
    wind: [4, 2], turbulence: 0.3, visibility: 0.98, cloudBase: 2000,
    windSpeed: 6,
  },
  scattered: {
    label: 'SCATTERED', coverage: 0.44, density: 0.4, rain: 0, fog: 0.000017,
    wind: [7, 3], turbulence: 0.55, visibility: 0.92, cloudBase: 1600,
    windSpeed: 9,
  },
  overcast: {
    label: 'OVERCAST', coverage: 0.82, density: 0.72, rain: 0, fog: 0.000026,
    wind: [9, 4], turbulence: 0.8, visibility: 0.82, cloudBase: 900,
    windSpeed: 12,
  },
  storm: {
    label: 'STORM', coverage: 0.96, density: 0.95, rain: 0.85, fog: 0.00011,
    wind: [14, 7], turbulence: 1.4, visibility: 0.62, cloudBase: 700,
    windSpeed: 18,
  },
};

export const WIND = {
  auto: { label: 'AUTO (WEATHER)', speed: null, gustiness: null, turbulence: null },
  calm: { label: 'CALM · 3 KT', speed: 1.5, gustiness: 0.12, turbulence: 0.10 },
  breeze: { label: 'BREEZE · 12 KT', speed: 6.2, gustiness: 0.35, turbulence: 0.32 },
  windy: { label: 'WINDY · 24 KT', speed: 12.4, gustiness: 0.65, turbulence: 0.72 },
  gale: { label: 'GALE · 40 KT', speed: 20.5, gustiness: 1.0, turbulence: 1.35 },
  // Feature 30: Vipava burja, the NE katabatic wind that pours off the Nanos
  // plateau. It keeps a fixed heading instead of veering with time.
  // Blows FROM NE (045 deg) TOWARD SW (225 deg): windX < 0, windZ > 0.
  burja: {
    label: 'BURJA · 42 KT NE',
    speed: 21.6,
    gustiness: 1.0,
    turbulence: 1.55,
    dirRad: Math.PI * 0.75,
  },
};

export const THEATERS = {
  temperate: {
    label: 'TEMPERATE',
    fogTint: null,
    hazeBoost: 1.0,
    horizonTint: null,
    groundAmb: 0x5d5b45,
  },
  desert: {
    label: 'DESERT STRIKE',
    fogTint: 0xd9b88c,
    hazeBoost: 1.35,
    horizonTint: 0xe6c79c,
    groundAmb: 0x8a6d48,
  },
  vipava: {
    label: 'VIPAVA VALLEY',
    demUrl: './media/vipava_dem.png',
    metaUrl: './media/vipava_meta.json',
    // Crisp Adriatic blue zenith, warm limestone haze at the horizon.
    zenithTint: 0x2b74b8,
    horizonTint: 0xe9d7b4,
    fogTint: 0xe2d1b2,
    hazeBoost: 1.14,
    groundAmb: 0x60624a,
  },
};