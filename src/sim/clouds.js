// Volumetric-ish cumulus field: clusters of instanced, camera-facing puffs.
// No horizontal cloud planes: every cloud has vertical structure and you can
// always see through the gaps between them.
import * as THREE from 'three';
import { clamp, smoothstep, hashU32, hash2, mulberry32 } from '../world/noise.js';

const CELL = 2200;

function makePuffTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  const n2 = (x, y, seed) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const h = (ix, iy) => hash2(ix, iy, seed);
    const a = h(xi, yi), b = h(xi + 1, yi);
    const cc = h(xi, yi + 1), dd = h(xi + 1, yi + 1);
    const ab = a + (b - a) * u;
    const cd = cc + (dd - cc) * u;
    return ab + (cd - ab) * v;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 2 - 1;
      const v = (y / size) * 2 - 1;
      const r = Math.hypot(u, v);
      const n = n2(x * 0.055, y * 0.055, 991) * 0.55
        + n2(x * 0.13 + 9, y * 0.13 + 4, 1193) * 0.30
        + n2(x * 0.31 + 2, y * 0.31 + 7, 1319) * 0.15;
      const edge = 1 - smoothstep(0.28, 1.0, r + (n - 0.5) * 0.5);
      const a = clamp(edge * (0.45 + n * 0.7), 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.floor(a * a * 235);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 2;
  return tex;
}

export class CloudSystem {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset;
    this.group = new THREE.Group();
    this.group.name = 'clouds';
    scene.add(this.group);

    this.tex = makePuffTexture(128);
    this.capacity = preset.clouds * 6;
    this._clusterCap = preset.clouds;
    this._lastX = Infinity;
    this._lastZ = Infinity;
    this._lastCoverage = -1;
    this._lastBase = -1;
    this._time = 0;
    this._weather = null;
    this._driftX = 0;
    this._driftZ = 0;
    this.stats = { puffs: 0, clusters: 0 };

    const geo = new THREE.PlaneGeometry(1, 1);
    this.seeds = new Float32Array(this.capacity);
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(this.seeds, 1));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTex: { value: this.tex },
        uSunColor: { value: new THREE.Color(0xfff4e0) },
        uSkyColor: { value: new THREE.Color(0x9fc0d8) },
        uNight: { value: 0 },
        uOpacity: { value: 1 },
        uDark: { value: 0 },
        uTime: { value: 0 },
        uDrift: { value: new THREE.Vector2() },
      },
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform vec2 uDrift;
        varying vec2 vUv;
        varying float vDist;
        varying float vSeed;
        void main() {
          vUv = uv;
          vSeed = aSeed;
          vec4 worldCenter = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          worldCenter.xz += uDrift;
          vec4 center = modelViewMatrix * worldCenter;
          float scale = length(instanceMatrix[0].xyz);
          float ang = aSeed * 6.28318;
          vec2 p = position.xy * scale;
          p = vec2(p.x * cos(ang) - p.y * sin(ang), p.x * sin(ang) + p.y * cos(ang));
          p.y *= 0.72;
          center.xy += p;
          vDist = length(center.xyz);
          gl_Position = projectionMatrix * center;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uTex;
        uniform vec3 uSunColor, uSkyColor;
        uniform float uNight, uOpacity, uDark;
        varying vec2 vUv;
        varying float vDist;
        varying float vSeed;

        void main() {
          vec2 uv = vUv;
          if (vSeed > 0.5) uv.x = 1.0 - uv.x;
          vec4 t = texture2D(uTex, uv);
          float a = t.a * uOpacity;
          a *= smoothstep(120.0, 420.0, vDist);
          a *= 1.0 - smoothstep(19000.0, 27000.0, vDist);
          if (a < 0.004) discard;

          float shade = smoothstep(0.05, 0.75, t.a);
          vec3 col = mix(vec3(0.50, 0.54, 0.60), vec3(0.98, 0.985, 0.99), shade);
          col = mix(col, vec3(0.18, 0.20, 0.23), uDark * 0.85);
          col = mix(col, vec3(0.16, 0.20, 0.30), uNight * 0.82);
          col = mix(col, uSkyColor, smoothstep(13000.0, 26000.0, vDist) * 0.72);
          col *= 0.88 + 0.12 * clamp(uSunColor.r, 0.0, 1.0);
          gl_FragColor = vec4(col, a * 0.78);
        }
      `,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.count = 0;
    this.group.add(this.mesh);

    this.rain = this._makeRain();
    this.windStreaks = this._makeWindStreaks();
  }

  _makeWindStreaks() {
    const count = 260;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const rng = mulberry32(44109);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rng() - 0.5) * 160;
      pos[i * 3 + 1] = (rng() - 0.5) * 90;
      pos[i * 3 + 2] = (rng() - 0.5) * 160;
      seed[i] = rng();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uCamPos: { value: new THREE.Vector3() },
        uDrift: { value: new THREE.Vector3() },
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Color(0xdce8f0) },
      },
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform vec3 uCamPos;
        uniform vec3 uDrift;
        varying float vA;
        void main() {
          vec3 box = vec3(160.0, 90.0, 160.0);
          vec3 worldOff = position + uDrift * (0.75 + aSeed * 0.55) - uCamPos;
          vec3 p = mod(worldOff + box * 0.5, box) - box * 0.5;
          float d = length(p);
          vA = smoothstep(5.0, 18.0, d) * (1.0 - smoothstep(42.0, 78.0, d));
          vec4 mv = viewMatrix * vec4(uCamPos + p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((320.0 + aSeed * 240.0) / max(4.0, -mv.z), 1.5, 5.5);
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uIntensity;
        uniform vec3 uColor;
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c * vec2(1.0, 2.2));
          float soft = smoothstep(0.5, 0.05, r);
          float a = soft * vA * uIntensity * 0.34;
          if (a < 0.008) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 5;
    this.group.add(points);
    return { points, mat, drift: new THREE.Vector3() };
  }

  _makeRain() {
    const count = 5000;
    const pos = new Float32Array(count * 3);
    const speed = new Float32Array(count);
    const rng = mulberry32(99123);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rng() - 0.5) * 340;
      pos[i * 3 + 1] = rng() * 320;
      pos[i * 3 + 2] = (rng() - 0.5) * 340;
      speed[i] = 35 + rng() * 30;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
        uRain: { value: 0 },
        uWind: { value: new THREE.Vector2() },
        uColor: { value: new THREE.Color(0xaec7d8) },
      },
      vertexShader: /* glsl */`
        attribute float aSpeed;
        uniform float uTime;
        uniform vec3 uCamPos;
        uniform vec2 uWind;
        varying float vA;
        void main() {
          vec3 p = position;
          p.y = mod(p.y - uTime * aSpeed, 320.0);
          p.x = mod(p.x + uWind.x * 0.4 * uTime, 340.0) - 170.0;
          p.z = mod(p.z + uWind.y * 0.4 * uTime, 340.0) - 170.0;
          float dist = length(p - vec3(0.0, 160.0, 0.0));
          vA = 1.0 - smoothstep(40.0, 180.0, dist);
          vec4 mv = viewMatrix * vec4(uCamPos + vec3(0.0, -160.0, 0.0) + p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(1400.0 / max(1.0, -mv.z), 1.5, 7.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uRain;
        uniform vec3 uColor;
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float streak = smoothstep(0.10, 0.0, abs(c.x)) * smoothstep(0.5, 0.1, abs(c.y));
          float a = streak * vA * uRain * 0.85;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 6;
    this.group.add(points);
    return { points, mat };
  }

  _refresh(camera, weather) {
    const st = weather.state;
    const base = st.cloudBase;
    const coverage = clamp(st.coverage, 0, 1);
    const R = 19000;

    const cx0 = Math.floor((camera.position.x - this._driftX - R) / CELL);
    const cx1 = Math.floor((camera.position.x - this._driftX + R) / CELL);
    const cz0 = Math.floor((camera.position.z - this._driftZ - R) / CELL);
    const cz1 = Math.floor((camera.position.z - this._driftZ + R) / CELL);
    const cells = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const r = hash2(cx, cz, 7331);
        if (r > coverage) continue;
        const x = cx * CELL + CELL * 0.5;
        const z = cz * CELL + CELL * 0.5;
        const d = Math.hypot(x + this._driftX - camera.position.x, z + this._driftZ - camera.position.z);
        if (d > R) continue;
        cells.push({ cx, cz, x, z, d });
      }
    }
    cells.sort((a, b) => a.d - b.d);

    const dummy = new THREE.Object3D();
    let n = 0;
    const clusters = Math.min(this._clusterCap, cells.length);

    for (let ci = 0; ci < clusters && n < this.capacity; ci++) {
      const cell = cells[ci];
      const rng = mulberry32(hashU32(cell.cx, cell.cz, 1171));
      const centerX = cell.x + (rng() - 0.5) * CELL * 0.7;
      const centerZ = cell.z + (rng() - 0.5) * CELL * 0.7;
      const cloudBase = base + (rng() - 0.5) * 700;
      const radius = 420 + rng() * 620;
      const height = radius * (0.9 + rng() * 0.6);
      const total = 6 + Math.floor(rng() * 3);
      for (let p = 0; p < total && n < this.capacity; p++) {
        const ang = rng() * Math.PI * 2;
        const rad = Math.pow(rng(), 0.55) * radius;
        const px = centerX + Math.cos(ang) * rad;
        const pz = centerZ + Math.sin(ang) * rad;
        const py = cloudBase + rng() * height;
        const size = radius * (0.75 + rng() * 0.95);
        dummy.position.set(px, py, pz);
        dummy.rotation.set(0, rng() * Math.PI * 2, 0);
        dummy.scale.set(size, size, 1);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(n, dummy.matrix);
        this.seeds[n] = rng();
        n++;
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.aSeed.needsUpdate = true;

    this._lastX = camera.position.x - this._driftX;
    this._lastZ = camera.position.z - this._driftZ;
    this._lastCoverage = coverage;
    this._lastBase = base;
    this.stats = { puffs: n, clusters };
  }

  /**
   * Smooth deterministic horizontal density field (0..1) used for the
   * cloud-entry mist wash. Bilinear value noise over the hash2 lattice so the
   * transition into and out of cloud is never steppy.
   */
  _mistNoise(x, z) {
    const scale = 1 / 850;
    const fx = x * scale;
    const fz = z * scale;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const ux = fx - ix;
    const uz = fz - iz;
    const sx = ux * ux * (3 - 2 * ux);
    const sz = uz * uz * (3 - 2 * uz);
    const a = hash2(ix, iz, 4242);
    const b = hash2(ix + 1, iz, 4242);
    const c = hash2(ix, iz + 1, 4242);
    const d = hash2(ix + 1, iz + 1, 4242);
    const ab = a + (b - a) * sx;
    const cd = c + (d - c) * sx;
    return ab + (cd - ab) * sz;
  }

  /**
   * Cloud-entry mist density at a world position: 0 in clear air or outside the
   * cloud deck, smoothly rising to 1 inside a thick overcast band.
   */
  getCloudDensity(pos, weather) {
    if (!pos) return 0;
    const st = weather && weather.state ? weather.state : null;
    if (!st) return 0;
    const coverage = clamp(st.clouds ?? st.coverage ?? 0, 0, 1);
    if (coverage <= 0.02) return 0;

    const base = clamp(st.cloudBase ?? 1600, 1150, 2100);
    const thickness = 750;
    const t = ((pos.y || 0) - base) / thickness;
    if (t <= 0 || t >= 1) return 0;

    const vert = smoothstep(0, 0.22, t) * (1 - smoothstep(0.78, 1, t));
    if (vert <= 0) return 0;

    const wisp = this._mistNoise(pos.x || 0, pos.z || 0);
    return clamp(coverage * vert * (0.55 + 0.75 * wisp), 0, 1);
  }

  update(dt, camera, weather, sky) {
    this._weather = weather;
    this._time += dt;
    const st = weather.state;
    // Advect clouds smoothly with the wind field.
    this._driftX += st.windX * dt * 1.35;
    this._driftZ += st.windZ * dt * 1.35;
    const moved = Math.hypot(
      (camera.position.x - this._driftX) - this._lastX,
      (camera.position.z - this._driftZ) - this._lastZ,
    );

    if (this._lastX === Infinity || moved > 1300
      || Math.abs(st.coverage - this._lastCoverage) > 0.035
      || Math.abs(st.cloudBase - this._lastBase) > 120) {
      this._refresh(camera, weather);
    }

    const u = this.material.uniforms;
    u.uSunColor.value.copy(sky.sunColor);
    u.uSkyColor.value.copy(sky.horizonColor);
    u.uNight.value = sky.night;
    u.uTime.value = this._time;
    u.uDrift.value.set(this._driftX, this._driftZ);
    u.uOpacity.value = clamp(0.24 + st.density * 0.95, 0.12, 1.0);
    u.uDark.value = clamp((st.coverage - 0.42) / 0.52, 0, 1) * (0.55 + st.rain * 0.55);
    this.mesh.visible = st.coverage > 0.015;

    const rainU = this.rain.mat.uniforms;
    rainU.uTime.value = this._time;
    rainU.uCamPos.value.copy(camera.position);
    rainU.uRain.value = st.rain;
    rainU.uWind.value.set(st.windX, st.windZ);
    this.rain.points.visible = st.rain > 0.02;

    // Subtle airborne wind-mote wisps drifting along the wind vector
    const ws = this.windStreaks;
    const wMag = Math.hypot(st.windX, st.windZ);
    ws.drift.x += st.windX * dt * 1.8;
    ws.drift.z += st.windZ * dt * 1.8;
    ws.drift.y += Math.sin(this._time * 0.9) * (st.gust || 0) * dt * 2.5;
    const wInt = clamp((wMag - 2.5) / 14 + (st.gust || 0) * 0.45, 0, 1);
    ws.mat.uniforms.uCamPos.value.copy(camera.position);
    ws.mat.uniforms.uDrift.value.copy(ws.drift);
    ws.mat.uniforms.uIntensity.value = wInt * (1 - sky.night * 0.55);
    ws.points.visible = wInt > 0.06;
  }
}