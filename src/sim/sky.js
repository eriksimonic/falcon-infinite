// Sky dome, sun/moon, stars, atmospheric lighting and fog.
import * as THREE from 'three';
import { CONFIG, THEATERS } from '../config.js';
import { clamp, smoothstep, lerp } from '../world/noise.js';

const _sun = new THREE.Vector3();
const _moon = new THREE.Vector3();
const _zeroPos = new THREE.Vector3();

function sunDirection(hour, out) {
  // Hour 12 = high south, hour 6 = east, hour 18 = west.
  const phi = ((hour - 12) / 24) * Math.PI * 2;
  const y = Math.cos(phi) * 0.94;
  const x = -Math.sin(phi) * 0.9;
  const z = 0.36;
  return out.set(x, y, z).normalize();
}

export class SkySystem {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.sunColor = new THREE.Color(0xfff3dd);
    this.skyColor = new THREE.Color(0x8fb8d8);
    this.horizonColor = new THREE.Color(0xbcd4e4);
    this.night = 0;
    this.sunElevation = 1;

    this.hemi = new THREE.HemisphereLight(0xbcd8f0, 0x3d4432, 1.1);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff2d8, 2.4);
    this.sun.position.set(3000, 8000, 2000);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Real-time shadow caster. The ortho frustum is re-centred (and texel
    // snapped) on the camera every frame in update(), so a ±1.4 km box is
    // plenty for buildings, trees, landmarks and the aircraft.
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 100;
    this.sun.shadow.camera.far = 14000;
    const S = 1400;
    this.sun.shadow.camera.left = -S;
    this.sun.shadow.camera.right = S;
    this.sun.shadow.camera.top = S;
    this.sun.shadow.camera.bottom = -S;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 1.4;
    this._shadowEnabled = true;

    this.moon = new THREE.DirectionalLight(0x9fb8ff, 0.0);
    this.scene.add(this.moon);
    this.scene.add(this.moon.target);

    this.scene.fog = new THREE.FogExp2(0x9fbed4, CONFIG.render.fogDensity);

    this.dome = this._makeDome();
    this.scene.add(this.dome);
    this._flash = 0;
    this._lastFlash = 0;
    this.flash = 0;
    this.theater = 'temperate';
  }

  setTheater(name) {
    this.theater = THEATERS[name] ? name : 'temperate';
  }

  /**
   * Shadow quality follows the render preset: off on `low`, 1024² on
   * `medium`, 2048² on `high`. Resizing the map needs the old target freed
   * and rebuilt, otherwise WebGL keeps the previous resolution.
   */
  setShadowQuality(name) {
    this._shadowEnabled = name !== 'low';
    const size = name === 'high' ? 2048 : 1024;
    this.sun.castShadow = this._shadowEnabled;
    if (this.sun.shadow.mapSize.x !== size || this.sun.shadow.mapSize.y !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  _makeDome() {
    const geo = new THREE.SphereGeometry(62000, 40, 24);
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunColor: { value: new THREE.Color(0xfff1d6) },
      uZenith: { value: new THREE.Color(0x2f6fa8) },
      uHorizon: { value: new THREE.Color(0xc4d9e6) },
      uGround: { value: new THREE.Color(0x5a6157) },
      uNight: { value: 0 },
      uOvercast: { value: 0 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform vec3 uSunDir, uMoonDir, uSunColor, uZenith, uHorizon, uGround;
        uniform float uNight, uOvercast, uTime, uFlash;
        varying vec3 vDir;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          vec3 dir = normalize(vDir);
          float h = clamp(dir.y, -1.0, 1.0);
          float up = max(h, 0.0);

          vec3 sky = mix(uHorizon, uZenith, pow(up, 0.62));
          sky = mix(sky, uGround, smoothstep(0.0, -0.12, h));

          // overcast flattens the sky toward pale grey
          vec3 grey = mix(vec3(0.56, 0.60, 0.63), vec3(0.78, 0.81, 0.83), up);
          sky = mix(sky, grey, uOvercast * 0.86);

          // sun glow + disc
          float sd = max(dot(dir, uSunDir), 0.0);
          float horizonGlow = pow(1.0 - abs(uSunDir.y), 2.0) * pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 4.0);
          sky += uSunColor * pow(sd, 6.0) * 0.18 * (1.0 - uOvercast * 0.85);
          sky += uSunColor * horizonGlow * 0.10 * (1.0 - uOvercast * 0.6);
          float disc = smoothstep(0.99955, 0.99988, sd) * smoothstep(-0.03, 0.05, uSunDir.y);
          sky += uSunColor * disc * 6.0;

          // moon
          float md = max(dot(dir, uMoonDir), 0.0);
          float moonDisc = smoothstep(0.99972, 0.99992, md);
          float crater = 0.82 + 0.18 * hash21(floor(dir.xz * 240.0));
          sky += vec3(0.85, 0.9, 1.0) * moonDisc * 3.2 * crater * (1.0 - uOvercast * 0.9);
          sky += vec3(0.4, 0.5, 0.8) * pow(md, 24.0) * 0.08 * (1.0 - uOvercast);

          // stars
          if (uNight > 0.01 && h > 0.0) {
            vec2 sph = vec2(atan(dir.z, dir.x) / 6.28318, asin(clamp(dir.y, -1.0, 1.0)) / 3.14159);
            vec2 g = sph * vec2(620.0, 320.0);
            vec2 id = floor(g);
            vec2 f = fract(g) - 0.5;
            float rnd = hash21(id);
            float star = smoothstep(0.09, 0.0, length(f)) * step(0.982, rnd);
            float twinkle = 0.65 + 0.35 * sin(uTime * (2.0 + rnd * 7.0) + rnd * 30.0);
            float mag = 0.35 + pow(rnd, 9.0) * 2.2;
            sky += vec3(0.85, 0.92, 1.0) * star * twinkle * mag * uNight * smoothstep(0.0, 0.2, up) * (1.0 - uOvercast);
          }

          // lightning flash
          sky += vec3(0.75, 0.82, 1.0) * uFlash * 1.4;

          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    return mesh;
  }

  update(dt, time, weather, camera, stormFlash = 0) {
    const hour = time.hour;
    // Headless tests may hand us a stub (or no) camera: fall back to origin so
    // the light rig still resolves instead of throwing.
    const camPos = camera && camera.position ? camera.position : _zeroPos;
    sunDirection(hour, _sun);
    // moon opposite-ish
    sunDirection(hour + 12.4, _moon);
    this.sunDir.copy(_sun);
    this.moonDir.copy(_moon);
    this.sunElevation = _sun.y;

    const dayT = smoothstep(-0.16, 0.22, _sun.y);
    const duskT = 1 - smoothstep(0.04, 0.38, Math.abs(_sun.y));
    this.night = 1 - dayT;

    // sun colour: deep orange at horizon → warm white
    const warm = new THREE.Color(0xff6a2e);
    const noon = new THREE.Color(0xfff4e2);
    const sunCol = warm.clone().lerp(noon, smoothstep(0.02, 0.5, _sun.y));
    this.sunColor.copy(sunCol);

    const zenithDay = new THREE.Color(0x2c6ba4);
    const zenithDusk = new THREE.Color(0x25365f);
    const zenithNight = new THREE.Color(0x030711);
    const horizonDay = new THREE.Color(0xc3dceb);
    const horizonDusk = new THREE.Color(0xe08a51);
    const horizonNight = new THREE.Color(0x0a1220);

    const zen = zenithNight.clone().lerp(zenithDusk, smoothstep(-0.28, 0.05, _sun.y))
      .lerp(zenithDay, smoothstep(0.02, 0.45, _sun.y));
    const hor = horizonNight.clone().lerp(horizonDusk, smoothstep(-0.25, 0.0, _sun.y))
      .lerp(horizonDay, smoothstep(0.02, 0.32, _sun.y));

    // overcast pushes colours toward grey; desert theater adds warm dust-haze tint
    const overcast = weather.state.overcast;
    const grey = new THREE.Color(0x8a9299);
    zen.lerp(grey, overcast * 0.7);
    hor.lerp(grey, overcast * 0.55);

    const th = THEATERS[this.theater] || THEATERS.temperate;
    if (th.zenithTint != null && dayT > 0.05) {
      // Crisp, deep blue Mediterranean / Adriatic sky.
      zen.lerp(new THREE.Color(th.zenithTint), 0.32 * dayT * (1 - overcast * 0.5));
    }
    if (th.horizonTint != null && dayT > 0.05) {
      hor.lerp(new THREE.Color(th.horizonTint), 0.34 * dayT * (1 - overcast * 0.4));
    }

    this.skyColor.copy(zen);
    this.horizonColor.copy(hor);

    this.uniforms.uSunDir.value.copy(_sun);
    this.uniforms.uMoonDir.value.copy(_moon);
    this.uniforms.uSunColor.value.copy(sunCol);
    this.uniforms.uZenith.value.copy(zen);
    this.uniforms.uHorizon.value.copy(hor);
    this.uniforms.uGround.value.copy(hor).multiplyScalar(0.35);
    this.uniforms.uNight.value = this.night;
    this.uniforms.uOvercast.value = overcast;
    this.uniforms.uTime.value += dt;
    this.uniforms.uFlash.value = stormFlash;

    // lighting
    this.sun.color.copy(sunCol);
    this.sun.intensity = 2.25 * smoothstep(-0.08, 0.22, _sun.y) * (1 - overcast * 0.62);
    // Sun and moon rides stay far outside the world so the light stays
    // directional; the shadow frustum follows the camera below.
    this.sun.position.copy(camPos).addScaledVector(_sun, 6000);
    this.sun.target.position.copy(camPos);
    this.sun.target.updateMatrixWorld();

    // Real-time shadows. `castShadow` is gated on the preset, sun elevation and
    // cloud cover so the shadow pass costs nothing at night or overcast. The
    // shadow target is snapped to a 12 m world grid: without it the ortho
    // frustum slides sub-texel every frame and shadow edges crawl.
    const activeShadow = this._shadowEnabled && _sun.y > 0.05 && overcast < 0.85;
    this.sun.castShadow = activeShadow;
    if (activeShadow) {
      const SNAP = 12;
      const tx = Math.round(camPos.x / SNAP) * SNAP;
      const ty = Math.round(camPos.y / SNAP) * SNAP;
      const tz = Math.round(camPos.z / SNAP) * SNAP;
      this.sun.target.position.set(tx, ty, tz);
      this.sun.position.set(tx, ty, tz).addScaledVector(_sun, 6000);
      this.sun.target.updateMatrixWorld();
      this.sun.shadow.camera.updateProjectionMatrix();
    }

    this.moon.intensity = 0.35 * this.night * (1 - overcast * 0.5);
    this.moon.color.setHex(0x9fb8ff);
    this.moon.position.copy(camPos).addScaledVector(_moon, 8000);
    this.moon.target.position.copy(camPos);
    this.moon.target.updateMatrixWorld();

    const dayAmb = new THREE.Color(0xb4d6f2);
    const nightAmb = new THREE.Color(0x1b2b4a);
    const amb = nightAmb.clone().lerp(dayAmb, dayT);
    const groundAmb = new THREE.Color(0x363e34).lerp(new THREE.Color(th.groundAmb || 0x767864), dayT);
    this.hemi.color.copy(amb);
    this.hemi.groundColor.copy(groundAmb);
    this.hemi.intensity = lerp(0.42, 1.75, dayT) * (1 - overcast * 0.10);

    // fog color = horizon, warmer at dusk, warm desert dust haze in desert theater
    const fogCol = hor.clone().lerp(sunCol, duskT * 0.18);
    if (th.fogTint != null && dayT > 0.05) {
      fogCol.lerp(new THREE.Color(th.fogTint), 0.28 * dayT);
    }
    this.scene.fog.color.copy(fogCol);
    this.scene.fog.density = weather.state.fog * (1 + overcast * 0.6) * (th.hazeBoost || 1.0);

    this.dome.position.copy(camPos);
    this.dome.rotation.y = 0;

    // bloom-free exposure adaptation
    this.renderer.toneMappingExposure = CONFIG.render.exposure * (0.95 + 0.22 * dayT);

    return {
      sunDir: _sun,
      moonDir: _moon,
      sunColor: sunCol,
      skyColor: zen,
      horizonColor: hor,
      night: this.night,
    };
  }
}