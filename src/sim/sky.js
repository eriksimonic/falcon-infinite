// Sky dome, sun/moon, stars, atmospheric lighting and fog.
import * as THREE from 'three';
import { CONFIG, THEATERS } from '../config.js';
import { clamp, smoothstep, lerp } from '../world/noise.js';

const _sun = new THREE.Vector3();
const _moon = new THREE.Vector3();
const _zeroPos = new THREE.Vector3();

// Constant palette. Allocated once at module load so update() never builds
// colours per frame (PERF-20).
const SUN_WARM = new THREE.Color(0xff6a2e);
const SUN_NOON = new THREE.Color(0xfff4e2);
const ZENITH_DAY = new THREE.Color(0x2c6ba4);
const ZENITH_DUSK = new THREE.Color(0x25365f);
const ZENITH_NIGHT = new THREE.Color(0x030711);
const HORIZON_DAY = new THREE.Color(0xc3dceb);
const HORIZON_DUSK = new THREE.Color(0xe08a51);
const HORIZON_NIGHT = new THREE.Color(0x0a1220);
const OVERCAST_GREY = new THREE.Color(0x8a9299);
const DAY_AMB = new THREE.Color(0xb4d6f2);
const NIGHT_AMB = new THREE.Color(0x1b2b4a);
const GROUND_AMB = new THREE.Color(0x363e34);

// Per-frame scratch colours. update() writes into these and reuses the result
// object, so a steady-state frame allocates zero THREE.Color instances.
const _sunCol = new THREE.Color();
const _zen = new THREE.Color();
const _hor = new THREE.Color();
const _amb = new THREE.Color();
const _groundAmb = new THREE.Color();
const _fogCol = new THREE.Color();
const _thTint = new THREE.Color();
const _result = {
  sunDir: _sun,
  moonDir: _moon,
  sunColor: _sunCol,
  skyColor: _zen,
  horizonColor: _hor,
  night: 0,
};

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
    // snapped) on the camera every frame in update(), so a ±1.05 km box is
    // plenty for buildings, trees, landmarks and the aircraft (~1.02 m/texel
    // on the 2048² High map, ~2.05 m/texel at 1024²).
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    // Depth range is centred tightly on the 6000 m sun offset: 7600 m of depth
    // instead of the old 13900 m nearly doubles depth precision, which lets the
    // bias stay tiny and keeps shadows anchored to their casters.
    this.sun.shadow.camera.near = 2200;
    this.sun.shadow.camera.far = 9800;
    const S = 1050;
    this.sun.shadow.camera.left = -S;
    this.sun.shadow.camera.right = S;
    this.sun.shadow.camera.top = S;
    this.sun.shadow.camera.bottom = -S;
    this.sun.shadow.bias = -0.00012;
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.radius = 2.0;
    // PERF-11 prerequisite: the shadow pass also draws layer-1 proxies
    // (buildings). Layer 0 stays enabled, so ordinary casters are unaffected.
    this.sun.shadow.camera.layers.enable(1);
    this._shadowEnabled = true;
    // PERF-12 altitude cut-off, with hysteresis between 3500 m and 4000 m.
    this._altShadowOff = false;

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
    // Radius stays comfortably inside CONFIG.render.far (160 km); the dome is
    // pinned to the far plane in the vertex shader anyway.
    const geo = new THREE.SphereGeometry(140000, 40, 24);
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
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // Pin the dome to the far plane so opaque geometry always wins the
          // depth test and the sky shader only shades visible sky pixels.
          gl_Position.z = gl_Position.w;
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

          // Sun glow + disc. Two Mie aureole lobes (a broad 5th-power bloom plus
          // a tight 32nd-power core) seat the sun inside a soft luminous
          // atmospheric halo, while the disc still pops on top of it.
          float sd = max(dot(dir, uSunDir), 0.0);
          float horizonGlow = pow(1.0 - abs(uSunDir.y), 2.0) * pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 4.0);
          sky += uSunColor * (pow(sd, 5.0) * 0.24 + pow(sd, 32.0) * 0.38) * (1.0 - uOvercast * 0.85);
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
    // Draw last within the opaque list (PERF-14). Transparent effects still
    // render after it, since three.js sorts the transparent list separately.
    mesh.renderOrder = 900;
    return mesh;
  }

  update(dt, time, weather, camera, stormFlash = 0, cockpitView = false) {
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
    _sunCol.copy(SUN_WARM).lerp(SUN_NOON, smoothstep(0.02, 0.5, _sun.y));
    this.sunColor.copy(_sunCol);

    _zen.copy(ZENITH_NIGHT).lerp(ZENITH_DUSK, smoothstep(-0.28, 0.05, _sun.y))
      .lerp(ZENITH_DAY, smoothstep(0.02, 0.45, _sun.y));
    _hor.copy(HORIZON_NIGHT).lerp(HORIZON_DUSK, smoothstep(-0.25, 0.0, _sun.y))
      .lerp(HORIZON_DAY, smoothstep(0.02, 0.32, _sun.y));

    // overcast pushes colours toward grey; desert theater adds warm dust-haze tint
    const overcast = weather.state.overcast;
    _zen.lerp(OVERCAST_GREY, overcast * 0.7);
    _hor.lerp(OVERCAST_GREY, overcast * 0.55);

    const th = THEATERS[this.theater] || THEATERS.temperate;
    if (th.zenithTint != null && dayT > 0.05) {
      // Crisp, deep blue Mediterranean / Adriatic sky.
      _zen.lerp(_thTint.setHex(th.zenithTint), 0.32 * dayT * (1 - overcast * 0.5));
    }
    if (th.horizonTint != null && dayT > 0.05) {
      _hor.lerp(_thTint.setHex(th.horizonTint), 0.34 * dayT * (1 - overcast * 0.4));
    }

    this.skyColor.copy(_zen);
    this.horizonColor.copy(_hor);

    this.uniforms.uSunDir.value.copy(_sun);
    this.uniforms.uMoonDir.value.copy(_moon);
    this.uniforms.uSunColor.value.copy(_sunCol);
    this.uniforms.uZenith.value.copy(_zen);
    this.uniforms.uHorizon.value.copy(_hor);
    this.uniforms.uGround.value.copy(_hor).multiplyScalar(0.35);
    this.uniforms.uNight.value = this.night;
    this.uniforms.uOvercast.value = overcast;
    this.uniforms.uTime.value += dt;
    this.uniforms.uFlash.value = stormFlash;

    // lighting
    this.sun.color.copy(_sunCol);
    this.sun.intensity = 2.95 * smoothstep(-0.08, 0.22, _sun.y) * (1 - overcast * 0.56);
    // Sun and moon rides stay far outside the world so the light stays
    // directional; the shadow frustum follows the camera below.
    this.sun.position.copy(camPos).addScaledVector(_sun, 6000);
    this.sun.target.position.copy(camPos);
    this.sun.target.updateMatrixWorld();

    // Real-time shadows. `castShadow` is gated on the preset, sun elevation and
    // cloud cover so the shadow pass costs nothing at night or overcast. The
    // shadow target is snapped to an 8 m world grid: without it the ortho
    // frustum slides sub-texel every frame and shadow edges crawl.
    const activeShadow = this._shadowEnabled && _sun.y > 0.05 && overcast < 0.85;
    this.sun.castShadow = activeShadow;
    if (activeShadow) {
      const SNAP = 8;
      const tx = Math.round(camPos.x / SNAP) * SNAP;
      const ty = Math.round(camPos.y / SNAP) * SNAP;
      const tz = Math.round(camPos.z / SNAP) * SNAP;
      this.sun.target.position.set(tx, ty, tz);
      this.sun.position.set(tx, ty, tz).addScaledVector(_sun, 6000);
      this.sun.target.updateMatrixWorld();
      this.sun.shadow.camera.updateProjectionMatrix();
    }

    // PERF-12: above 4 km the shadow box covers a sliver of the view, so the
    // whole caster set still renders into the 2048² map for nothing. Turn the
    // shadow result off via `shadow.intensity` (never `castShadow`, which would
    // recompile every lit material) and stop the shadow pass entirely.
    // Hysteresis (off above 4000 m, back on below 3500 m) stops flicker when
    // the camera skims the threshold.
    if (!this._altShadowOff && camPos.y > 4000) this._altShadowOff = true;
    else if (this._altShadowOff && camPos.y < 3500) this._altShadowOff = false;
    this.sun.shadow.intensity = this._altShadowOff ? 0 : 1;
    if (this.renderer && this.renderer.shadowMap) {
      // Above 4 km the global sun's shadow pass is worthless, but the cockpit
      // has its own `cockpitSun` at 2.4 mm/texel driving the interior shadows —
      // freezing `autoUpdate` starves it. Keep the pass alive for cockpit view.
      this.renderer.shadowMap.autoUpdate = !this._altShadowOff || !!cockpitView;
    }

    this.moon.intensity = 0.35 * this.night * (1 - overcast * 0.5);
    this.moon.color.setHex(0x9fb8ff);
    this.moon.position.copy(camPos).addScaledVector(_moon, 8000);
    this.moon.target.position.copy(camPos);
    this.moon.target.updateMatrixWorld();

    _amb.copy(NIGHT_AMB).lerp(DAY_AMB, dayT);
    _groundAmb.copy(GROUND_AMB).lerp(_thTint.setHex(th.groundAmb || 0x767864), dayT);
    this.hemi.color.copy(_amb);
    this.hemi.groundColor.copy(_groundAmb);
    // Daylight fill is deliberately well below the sun key: a hemisphere this
    // strong used to wash out shadow contrast and flatten terrain relief.
    this.hemi.intensity = lerp(0.38, 1.05, dayT) * (1 - overcast * 0.10);

    // fog color = horizon, warmer at dusk, blue-leaning toward the zenith in
    // daylight so it blends seamlessly with the bluish Rayleigh aerial
    // perspective on distant terrain, warm desert dust haze in desert theater
    _fogCol.copy(_hor).lerp(_sunCol, duskT * 0.18);
    _fogCol.lerp(_zen, 0.16 * dayT * (1 - overcast * 0.6));
    if (th.fogTint != null && dayT > 0.05) {
      _fogCol.lerp(_thTint.setHex(th.fogTint), 0.28 * dayT);
    }
    if (this.scene.fog) {
      this.scene.fog.color.copy(_fogCol);
      this.scene.fog.density = weather.state.fog * (1 + overcast * 0.6) * (th.hazeBoost || 1.0);
    }

    this.dome.position.copy(camPos);
    this.dome.rotation.y = 0;

    // bloom-free exposure adaptation
    if (this.renderer) {
      this.renderer.toneMappingExposure = CONFIG.render.exposure * (0.95 + 0.22 * dayT);
    }

    _result.night = this.night;
    return _result;
  }
}