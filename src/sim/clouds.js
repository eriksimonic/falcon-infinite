// Volumetric-ish cumulus field: clusters of instanced, camera-facing puffs.
// No horizontal cloud planes: every cloud has vertical structure and you can
// always see through the gaps between them.
//
// Each puff carries a normalised height inside its cumulus cluster (aHeight),
// so the fragment shader can shade a cool shadowed base under a warm sunlit
// cauliflower crown, add Henyey-Greenstein silver linings toward the sun, and
// blend far clouds into the Rayleigh-blue horizon. Puffs are billboarded in
// world space so the fragment stage knows the real world position of every
// vertex it lights.
import * as THREE from 'three';
import { clamp, smoothstep, hashU32, hash2, mulberry32 } from '../world/noise.js';

const CELL = 2200;

/**
 * Procedural cumulus puff sprite. Four-octave billowy fBm turns the old fuzzy
 * circles into organic cauliflower lobes. Two data channels plus alpha are
 * packed so the shader can light each sprite as a small volume:
 *   R = internal density / depth thickness (bright bulbous core)
 *   G = vertical top-lobe lighting bias (brighter on upper billowy bumps)
 *   A = crisp, lacy cumulus alpha silhouette
 * Headless-safe: never touches `document` unless it actually exists.
 */
function makePuffTexture(size = 192) {
  const data = new Uint8Array(size * size * 4);

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

  // Ridged ("billowy") fBm: inverting |2n-1| gives the rounded lobes of a
  // cumulus rather than the smooth blobs of plain value noise.
  const billow = (x, y, seed, octaves) => {
    let sum = 0, norm = 0, amp = 0.5, freq = 1;
    for (let o = 0; o < octaves; o++) {
      const n = n2(x * freq, y * freq, seed + o * 131);
      sum += (1 - Math.abs(n * 2 - 1)) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  };

  const P = 5.5; // base-octave lattice cells across the sprite
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const r = Math.hypot(u, v);
      const uvY = 1 - (y + 0.5) / size; // 1 at the sprite top, 0 at the base

      const wx = ((x + 0.5) / size) * P;
      const wy = ((y + 0.5) / size) * P;
      // Domain warp the low octaves so lobes roll into each other.
      const warp = billow(wx * 0.55 + 3.1, wy * 0.55 + 7.4, 991, 2);
      const lobe = billow(wx + warp * 1.6, wy + warp * 1.2, 1193, 4);
      // Detail octave kept at a few pixels per cell: any finer and the
      // silhouette breaks up into alias-level pixel noise.
      const fine = billow(wx * 1.55 + 5.0, wy * 1.55 + 1.0, 1417, 3);

      // Lacy cumulus silhouette: lobe displacement on the radius, a crisp rim
      // against the sky, and thin wispy lobes only near the edge.
      const edgeR = r + (lobe - 0.5) * 0.62 + (fine - 0.5) * 0.07;
      const edge = 1 - smoothstep(0.62, 0.96, edgeR);
      const lace = smoothstep(0.06, 0.42, lobe * 0.80 + fine * 0.30);
      // Solid interior (real cumulus are opaque) with a thin lacy rim, so
      // overlapping puffs stack into white mass instead of translucent haze.
      const alpha = clamp(edge * (0.88 + 0.14 * lace), 0, 1);

      // Density: bulbous bright core, thinning toward the rim.
      const core = 1 - smoothstep(0.05, 0.98, r * (0.86 + 0.22 * (lobe - 0.5)));
      const density = clamp(core * (0.50 + 0.80 * lobe) + 0.10 * fine, 0, 1);

      // Top-lobe bias: a strong vertical gradient (shadowed base -> bright
      // crown) modulated by lobe curvature so upper bumps catch the sun.
      const upperBump = smoothstep(-0.55, 0.85, uvY + (lobe - 0.5) * 0.30);
      const topBias = clamp(0.06 + 0.94 * upperBump * (0.70 + 0.30 * lobe), 0, 1);

      const i = (y * size + x) * 4;
      data[i] = Math.floor(density * 255);
      data[i + 1] = Math.floor(topBias * 255);
      data[i + 2] = 255;
      data[i + 3] = Math.floor(Math.pow(alpha, 1.08) * 255);
    }
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(size, size);
      img.data.set(data);
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = 2;
      return tex;
    }
  }

  // Headless (Node tests / tooling): no DOM — upload the same bytes directly.
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export class CloudSystem {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset;
    this.group = new THREE.Group();
    this.group.name = 'clouds';
    scene.add(this.group);

    this.tex = makePuffTexture(192);
    this.capacity = preset.clouds * 6;
    this._clusterCap = preset.clouds;
    this._lastX = Infinity;
    this._lastZ = Infinity;
    this._lastCoverage = -1;
    this._lastBase = -1;
    // Weather severity drives the cloud morphology as much as coverage does:
    // fair-weather popcorn clusters and storm cumulonimbus are different
    // geometries, so a preset swap has to force a rebuild.
    this._lastOvercast = -1;
    this._lastStorm = -1;
    this._time = 0;
    this._weather = null;
    this._driftX = 0;
    this._driftZ = 0;
    this._inCloud = 0;
    this.stats = { puffs: 0, clusters: 0 };

    const geo = new THREE.PlaneGeometry(1, 1);
    this.seeds = new Float32Array(this.capacity);
    this.heights = new Float32Array(this.capacity);
    this.shades = new Float32Array(this.capacity);

    const seedAttr = new THREE.InstancedBufferAttribute(this.seeds, 1);
    seedAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSeed', seedAttr);

    // Normalised vertical position inside the cumulus cluster: 0 = flat
    // shadowed base, 1 = sunlit cauliflower top dome.
    const heightAttr = new THREE.InstancedBufferAttribute(this.heights, 1);
    heightAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aHeight', heightAttr);

    // Cluster-scale illumination: puffs on the sunward flank (and higher up)
    // are brighter than the lee-side / under-shelf puffs, which fakes the
    // self-shadowing that makes a cluster read as one solid volume.
    const shadeAttr = new THREE.InstancedBufferAttribute(this.shades, 1);
    shadeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aShade', shadeAttr);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTex: { value: this.tex },
        uSunColor: { value: new THREE.Color(0xfff4e0) },
        uSkyColor: { value: new THREE.Color(0x9fc0d8) },
        uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.4) },
        uNight: { value: 0 },
        uOpacity: { value: 1 },
        uDark: { value: 0 },
        uFlash: { value: 0 },
        uTime: { value: 0 },
        uDrift: { value: new THREE.Vector2() },
      },
      vertexShader: /* glsl */`
        attribute float aSeed;
        attribute float aHeight;
        attribute float aShade;
        uniform vec2 uDrift;
        uniform float uTime;
        uniform vec3 uSunDir;
        varying vec2 vUv;
        varying float vDist;
        varying float vSeed;
        varying float vHeight;
        varying float vShade;
        varying vec3 vWorldPos;
        varying vec3 vSunView;
        void main() {
          // Per-instance UV scale spread so puffs never look like the same
          // stamp repeated across the deck.
          vec2 uvJ = (uv - 0.5) * (0.88 + 0.12 * fract(aSeed * 19.37));
          vUv = uvJ + 0.5;
          vSeed = aSeed;
          vHeight = aHeight;
          vShade = aShade;

          // Sun direction in view space for per-puff form shading.
          vec3 sd = uSunDir;
          if (dot(sd, sd) < 1e-6) sd = vec3(0.0, 1.0, 0.0);
          vSunView = (viewMatrix * vec4(normalize(sd), 0.0)).xyz;

          vec4 worldCenter = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          worldCenter.xz += uDrift;

          // Non-uniform instance scale: wide flat base puffs, lofted turrets.
          float sx = length(instanceMatrix[0].xyz);
          float sy = length(instanceMatrix[1].xyz);

          // Small in-plane rotation keeps the sprite variety while the baked
          // top-lobe lighting bias stays roughly upright.
          float ang = (fract(aSeed * 7.31) - 0.5) * 0.9;
          vec2 p = vec2(position.x * sx, position.y * sy);
          p = vec2(p.x * cos(ang) - p.y * sin(ang), p.x * sin(ang) + p.y * cos(ang));
          p.y *= 0.72;
          // Slow per-puff breathing so the deck never looks frozen.
          p *= 1.0 + 0.02 * sin(uTime * 0.35 + aSeed * 37.0);

          // Billboard in world space so the fragment stage gets true world
          // positions for sun/view alignment and Rayleigh distance blending.
          vec3 toCam = cameraPosition - worldCenter.xyz;
          float cl = length(toCam);
          vec3 fwd = cl > 0.001 ? toCam / cl : vec3(0.0, 0.0, 1.0);
          vec3 right = cross(vec3(0.0, 1.0, 0.0), fwd);
          if (dot(right, right) < 1e-6) right = vec3(1.0, 0.0, 0.0);
          right = normalize(right);
          vec3 up = cross(fwd, right);

          vec3 worldPos = worldCenter.xyz + right * p.x + up * p.y;
          vec4 center = viewMatrix * vec4(worldPos, 1.0);

          vWorldPos = worldPos;
          vDist = length(center.xyz);
          gl_Position = projectionMatrix * center;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uTex;
        uniform vec3 uSunColor, uSkyColor, uSunDir;
        uniform float uNight, uOpacity, uDark, uFlash;
        varying vec2 vUv;
        varying float vDist;
        varying float vSeed;
        varying float vHeight;
        varying float vShade;
        varying vec3 vWorldPos;
        varying vec3 vSunView;

        void main() {
          vec2 uv = vUv;
          if (vSeed > 0.5) uv.x = 1.0 - uv.x;
          vec4 t = texture2D(uTex, uv);

          float a = t.a * uOpacity;
          // Close-range fly-through: silky feathering instead of the old hard
          // 120..420 m pop, plus extra opacity softening under 110 m so puffs
          // drift past the wings and canopy without snapping.
          a *= smoothstep(18.0, 130.0, vDist);
          a *= 0.72 + 0.28 * smoothstep(10.0, 120.0, vDist);
          a *= 1.0 - smoothstep(21000.0, 31000.0, vDist);
          if (a < 0.004) discard;

          // --- Height-based ambient occlusion & sunlit crown ---------------
          // Cool shadowed underside, lifting to slate in a storm and deep
          // twilight blue at night.
          // Fully night-adjusted factor: at nightT == 1 the deck is a dark
          // moonlit silhouette, never a sunlit white sheet.
          float nightT = clamp(uNight, 0.0, 1.0);

          vec3 baseCol = vec3(0.44, 0.50, 0.60);
          // Overcast and storm undersides sink all the way to brooding,
          // blue-black charcoal so a heavy deck never reads as pale puffballs.
          float darkT = clamp(uDark, 0.0, 1.0);
          baseCol = mix(baseCol, vec3(0.11, 0.13, 0.18), darkT);
          // 100% at full night so no residual lit base survives: encodes to
          // roughly 8-13% sRGB (dark slate-navy).
          baseCol = mix(baseCol, vec3(0.006, 0.009, 0.017), nightT);

          // Warm creamy crown lit by the sun (natural daylight, not clipped white).
          vec3 topCol = mix(vec3(0.92, 0.94, 0.97), vec3(0.98, 0.95, 0.90), clamp(uSunColor.r, 0.0, 1.0));
          // Moody pewter-slate storm domes: heavy weather never gets a flat
          // bright white top, even with the sun straight overhead.
          topCol = mix(topCol, vec3(0.36, 0.39, 0.45), darkT);
          // Subtle indigo-slate ridge catching moonlight: ~15-23% sRGB, never white.
          topCol = mix(topCol, vec3(0.020, 0.028, 0.048), nightT);

          vec3 sunDir = normalize(uSunDir);
          vec3 viewVec = vWorldPos - cameraPosition;
          float viewLen = length(viewVec);
          vec3 viewDir = viewLen > 0.001 ? viewVec / viewLen : vec3(0.0, 0.0, 1.0);
          float sunDot = dot(viewDir, sunDir);

          float topLit = clamp(vHeight * 0.75 + t.g * 0.35 + 0.12 * smoothstep(-0.2, 0.8, uSunDir.y), 0.0, 1.0);
          vec3 col = mix(baseCol, topCol, smoothstep(0.08, 0.88, topLit));

          // Per-puff form shading: treat the sprite as a lit dome so each lobe
          // gets a bright sun side and a shaded back side instead of the flat
          // two-tone card look. q is the un-mirrored sprite coordinate so the
          // light direction is identical for every puff.
          vec2 q = vUv * 2.0 - 1.0;
          float rr = clamp(length(q), 0.0, 1.0);
          vec3 nrm = normalize(vec3(q * 0.92, sqrt(max(0.0, 1.0 - rr * rr)) + 0.30));
          vec3 sunView = normalize(vSunView + vec3(0.0, 0.0, 1e-5));
          float form = smoothstep(-0.70, 0.85, dot(nrm, sunView));
          // Per-lobe brightness spread: without it, stacked puffs saturate into
          // one flat white sheet instead of a field of individually lit lobes.
          float lobeVar = 0.86 + 0.26 * fract(vSeed * 13.73);
          // Sunlit crowns must still read brighter than the sky, but only just:
          // keeping the daytime linear peak near ~1.1 stays under the bloom
          // threshold (1.05 sRGB-ish knee, softened below) so cream-white tops
          // never sprout a white bloom halo. Night/storm attenuate the gain.
          // At night there is no sun on the deck: the gain drops to a gentle
          // ~0.6-1.15 moonlight range so night tops can never clip white.
          float dayGain = mix(0.32, 1.12, pow(form, 1.35)) * (1.0 - uDark * 0.30);
          float nightGain = mix(0.60, 1.15, form) * (1.0 - uDark * 0.35);
          float sunGain = mix(dayGain, nightGain, nightT);
          col *= sunGain * lobeVar * vShade;
          // Skylight fill on the shadowed side keeps shadows cool and blue
          // rather than neutral grey. baseCol is already night-dark, so this
          // fill can keep its normal strength at night without lifting the deck.
          col = mix(col, baseCol * 0.75, (1.0 - form) * 0.45);

          // Fake intra-puff occlusion from the density channel: keeps each
          // sprite reading as a volume rather than a flat lit card.
          col *= mix(0.74, 1.0, smoothstep(0.08, 0.72, t.r));
          // Storm-density self-shadowing: a towering cumulonimbus base swallows
          // its own skylight long before any sun gets under the shelf.
          float underDark = (1.0 - smoothstep(0.06, 0.72, vHeight)) * smoothstep(0.30, 1.0, uDark);
          col *= 1.0 - underDark * 0.30;
          // Thin rims pick up a cooler attenuation tint.
          col = mix(col, baseCol * 0.94, (1.0 - smoothstep(0.05, 0.45, t.a)) * 0.35 * (1.0 - uNight * 0.5));

          // --- Henyey-Greenstein forward-scattered silver lining -------------
          if (sunDot > 0.0) {
            float g = 0.72;
            float hg = (1.0 - g * g) / pow(max(0.08, 1.0 + g * g - 2.0 * g * sunDot), 1.5);
            float edgeThin = (1.0 - smoothstep(0.15, 0.85, t.r)) * smoothstep(0.05, 0.45, t.a);
            // Silver lining is pure daytime sun scattering: fully off at night.
            float silver = clamp(hg * 0.14, 0.0, 1.4) * (0.35 + 0.65 * edgeThin) * (1.0 - nightT) * (1.0 - uDark * 0.65);
            col += uSunColor * silver * 0.22;
          }

          // Soft-knee daylight ceiling: compress anything above ~0.95 so a
          // stacked deck of sunlit lobes settles at creamy white instead of
          // stacking into HDR >1 that the bloom pass turns into a white halo.
          // Night clouds skip it entirely (they are already verified dark).
          float dayMask = 1.0 - smoothstep(0.35, 0.65, nightT);
          vec3 knee = col / (1.0 + max(col - 0.95, 0.0) * 0.85);
          col = mix(col, knee, dayMask);

          // --- Rayleigh horizon blend ---------------------------------------
          // Distant night clouds sink into a darkened sky tint so the horizon
          // deck stays navy instead of glowing pale against the night sky.
          // The blend band tracks the extended fragment reach so the massive
          // storm deck dissolves into the horizon instead of ending on a rim.
          vec3 horizonCol = uSkyColor * mix(1.0, 0.45, nightT);
          vec2 farBand = mix(vec2(14000.0, 27000.0), vec2(21000.0, 31000.0), darkT);
          col = mix(col, horizonCol, smoothstep(farBand.x, farBand.y, vDist) * 0.76);

          // Lightning glow from deep inside the thunderhead: only in a heavy
          // deck (uDark-driven mask) and only while weather.flash is lit.
          float inner = smoothstep(0.45, 1.0, uDark)
            * (0.35 + 0.65 * smoothstep(0.10, 0.85, t.r)) * (0.40 + 0.60 * vHeight);
          col += vec3(0.80, 0.86, 1.0) * uFlash * inner * 0.42;

          gl_FragColor = vec4(col, a * 0.95);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
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

  /**
   * Upload only the live instance range: the arrays are sized to `capacity`
   * but a rebuild typically fills far fewer entries.
   */
  _uploadLiveRange(n) {
    const iMat = this.mesh.instanceMatrix;
    if (iMat.clearUpdateRanges) iMat.clearUpdateRanges();
    if (iMat.addUpdateRange) iMat.addUpdateRange(0, n * 16);
    iMat.needsUpdate = true;

    const attrs = this.mesh.geometry.attributes;
    for (const key of ['aSeed', 'aHeight', 'aShade']) {
      const attr = attrs[key];
      if (!attr) continue;
      if (attr.clearUpdateRanges) attr.clearUpdateRanges();
      if (attr.addUpdateRange) attr.addUpdateRange(0, n);
      attr.needsUpdate = true;
    }
  }

  _refresh(camera, weather) {
    const st = weather.state;
    const base = st.cloudBase;
    const coverage = clamp(st.coverage, 0, 1);
    // Weather severity: 0 in fair weather, ~0.6..1.0 in overcast, and
    // (overcast 1, storm ~0.75..1) in a storm. Drives cloud morphology.
    const overcast = clamp(
      st.overcast ?? Math.max(0, (coverage - 0.35) / 0.65), 0, 1,
    );
    const storm = clamp(st.rain ?? 0, 0, 1);
    // A heavy deck has to reach further so the storm shelf runs to the
    // horizon instead of ending in a visible circle.
    const R = 19000 + overcast * 5000;

    const cx0 = Math.floor((camera.position.x - this._driftX - R) / CELL);
    const cx1 = Math.floor((camera.position.x - this._driftX + R) / CELL);
    const cz0 = Math.floor((camera.position.z - this._driftZ - R) / CELL);
    const cz1 = Math.floor((camera.position.z - this._driftZ + R) / CELL);
    const cells = [];
    // Merging: once the deck thickens, alternate lattice cells are dropped and
    // the much larger clusters span the gap, so banks knit into one continuous
    // sheet instead of a grid of separated fair-weather dots.
    const merge = overcast > 0.35 || storm > 0.3;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        if (merge && ((cx + cz) & 1) === 1) continue;
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

    const n = this._fillClusters(cells, base, overcast, storm);

    this.mesh.count = n;
    this._uploadLiveRange(n);

    this._lastX = camera.position.x - this._driftX;
    this._lastZ = camera.position.z - this._driftZ;
    this._lastCoverage = coverage;
    this._lastBase = base;
    this._lastOvercast = overcast;
    this._lastStorm = storm;
    this.stats = { puffs: n, clusters: Math.min(this._clusterCap, cells.length) };
    return n;
  }

  /**
   * Lay out one cluster per cell: a flat, wide, shadowed base with a billowy
   * rising dome. Low puffs are spread out and squashed flat (aHeight
   * 0.05..0.30) while turret puffs climb the crown, tighten toward the centre
   * and shrink with height (aHeight 0.55..1.0).
   *
   * `overcast` (0..1) and `storm` (0..1) rescale the whole morphology: fair
   * weather keeps small scattered cumulus, overcast grows wide flat
   * stratocumulus banks that overlap into one deck, and a storm towers into
   * 2.2-4 km cumulonimbus with a heavy shelf base and a wide anvil crown.
   * Flying at 19,000 ft looking down then sees real 3D cauliflower tops under
   * scattered skies and a continuous dark storm deck under a storm.
   */
  _fillClusters(cells, base, overcast = 0, storm = 0) {
    const dummy = new THREE.Object3D();
    let n = 0;
    const clusters = Math.min(this._clusterCap, cells.length);

    // Sun direction for cluster-scale self-shadowing (XZ component only).
    const sun = this.material.uniforms.uSunDir.value;
    let sunX = sun.x, sunZ = sun.z;
    const sunLen = Math.hypot(sunX, sunZ);
    if (sunLen > 1e-4) { sunX /= sunLen; sunZ /= sunLen; } else { sunX = 0; sunZ = 0; }

    // Weather severity -> morphology. Fair weather keeps the small scattered
    // cumulus; overcast knits broad, flat stratocumulus banks; a storm towers
    // into cumulonimbus with a hard dark shelf and a wide anvil crown. Radius
    // grows far faster than the CELL lattice so banks overlap instead of
    // floating as isolated popcorn dots.
    const weatherScale = 1.0 + overcast * 1.15 + storm * 0.75;
    const stormMix = smoothstep(0.30, 0.75, storm);
    const deckScale = 0.85 + overcast * 0.35;
    const towerScale = 1.0 + storm * 1.25;
    const heightScale = deckScale + (towerScale - deckScale) * stormMix;
    // A tighter base band under a heavy deck forms one cohesive low ceiling.
    const baseJitter = 700 * (1.0 - overcast * 0.65);
    const baseExtra = Math.round(overcast * 2 + storm * 2);
    // Spread the fixed instance budget over every cluster. Filling the near
    // cells until capacity runs out would truncate the far half of a storm
    // deck; budgeting per cluster keeps every bank and never exceeds capacity.
    const puffBudget = clusters > 0 ? Math.max(4, Math.floor(this.capacity / clusters)) : 0;

    for (let ci = 0; ci < clusters && n < this.capacity; ci++) {
      const cell = cells[ci];
      const rng = mulberry32(hashU32(cell.cx, cell.cz, 1171));
      const centerX = cell.x + (rng() - 0.5) * CELL * 0.7;
      const centerZ = cell.z + (rng() - 0.5) * CELL * 0.7;
      const cloudBase = base + (rng() - 0.5) * baseJitter;
      const radius = (420 + rng() * 620) * weatherScale;
      let height = radius * (0.9 + rng() * 0.6) * heightScale;
      // Cumulonimbus depth: 2200..4000 m of stacked tower over the shelf base.
      if (stormMix > 0) {
        const depth = 2200 + rng() * 1800;
        height += (depth - height) * stormMix;
      }
      const total = Math.min(puffBudget, 6 + Math.floor(rng() * 3) + baseExtra);
      // Heavy weather is base-heavy: a continuous rolling shelf under turrets.
      const baseCount = Math.max(3, Math.round(total * (0.5 + overcast * 0.12)));

      for (let p = 0; p < total && n < this.capacity; p++) {
        const isBase = p < baseCount;
        // Base puffs sit low on a flat shelf, turrets stack up to the crown.
        // In a storm the turret puffs also start low so the column is solid.
        const h = isBase
          ? 0.05 + rng() * 0.25
          : (0.55 - stormMix * 0.15) + rng() * 0.45;

        // Radius tapers toward the dome so the cluster silhouette is a
        // cauliflower (wide shelf, narrowing turret) instead of a cylinder.
        // The overcast shelf stays wide so neighbouring banks overlap.
        const taper = 1.0 - 0.62 * smoothstep(0.30, 1.0, h);
        const spread = isBase
          ? Math.pow(rng(), 0.35) * radius * (1.02 + overcast * 0.15)
          : Math.pow(rng(), 0.90) * radius * 0.72 * taper;

        const ang = rng() * Math.PI * 2;
        const px = centerX + Math.cos(ang) * spread;
        const pz = centerZ + Math.sin(ang) * spread;
        const py = cloudBase + h * height + (rng() - 0.5) * height * 0.06;

        let size = radius * (isBase ? 0.82 + rng() * 0.75 : 0.62 + rng() * 0.66)
          * (0.86 + 0.14 * taper);
        // Heavy weather widens the puffs so they fuse into rolling banks
        // rather than a field of small round lobes.
        size *= 1.0 + (isBase ? overcast * 0.45 + storm * 0.25 : storm * 0.30);
        // Flat, wide base lobes; rounder, taller turret lobes. Overcast bases
        // flatten further and knit together into one continuous deck.
        let squash = isBase
          ? (0.52 - overcast * 0.14) + rng() * 0.20
          : 0.88 + rng() * 0.32;
        // Mature thunderheads spread a wide, flat anvil over the tower.
        const anvil = stormMix * smoothstep(0.72, 1.0, h);
        size *= 1.0 + anvil * 0.9;
        squash *= 1.0 - anvil * 0.45;

        dummy.position.set(px, py, pz);
        dummy.rotation.set(0, rng() * Math.PI * 2, 0);
        dummy.scale.set(size, size * squash, 1);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(n, dummy.matrix);
        this.seeds[n] = rng();
        this.heights[n] = h;

        // Sunward flank + lofted puffs catch more light; lee-side and
        // under-shelf puffs fall into the cluster's own shadow. A storm deck
        // swallows far more of its own light from the base upward.
        const dx = px - centerX;
        const dz = pz - centerZ;
        const dl = Math.hypot(dx, dz);
        const sunSide = dl > 1e-3 ? (dx * sunX + dz * sunZ) / dl : 0;
        const shade = (0.80 + 0.16 * sunSide + 0.20 * (h - 0.5))
          * (1.0 - stormMix * 0.20 * (1.0 - h));
        this.shades[n] = clamp(shade, 0.55 - stormMix * 0.13, 1.06);
        n++;
      }
    }
    return n;
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

    // Weather severity, resolved exactly like _refresh does, so a preset swap
    // (few -> overcast -> storm) rebuilds the cloud geometry immediately
    // instead of leaving fair-weather popcorn under a storm sky.
    const overcast = clamp(
      st.overcast ?? Math.max(0, (st.coverage - 0.35) / 0.65), 0, 1,
    );
    const storm = clamp(st.rain ?? 0, 0, 1);

    if (this._lastX === Infinity || moved > 1300
      || Math.abs(st.coverage - this._lastCoverage) > 0.035
      || Math.abs(st.cloudBase - this._lastBase) > 120
      || Math.abs(overcast - this._lastOvercast) > 0.08
      || Math.abs(storm - this._lastStorm) > 0.08) {
      this._refresh(camera, weather);
    }

    const u = this.material.uniforms;
    u.uSunColor.value.copy(sky.sunColor);
    u.uSkyColor.value.copy(sky.horizonColor);
    if (sky.sunDir) u.uSunDir.value.copy(sky.sunDir);
    else if (weather.sunDir) u.uSunDir.value.copy(weather.sunDir);
    u.uNight.value = sky.night;
    u.uTime.value = this._time;
    u.uDrift.value.set(this._driftX, this._driftZ);
    u.uOpacity.value = clamp(0.70 + st.density * 0.42, 0.45, 1.0);
    u.uDark.value = clamp((st.coverage - 0.42) / 0.52, 0, 1) * (0.55 + st.rain * 0.55);
    // Thunderhead interior glow: WeatherSystem.flash spikes for ~0.2 s per
    // strike; the shader masks it to heavy decks so fair weather is untouched.
    u.uFlash.value = clamp(weather.flash || 0, 0, 1.5);
    this.mesh.visible = st.coverage > 0.015;

    const rainU = this.rain.mat.uniforms;
    rainU.uTime.value = this._time;
    rainU.uCamPos.value.copy(camera.position);
    rainU.uRain.value = st.rain;
    rainU.uWind.value.set(st.windX, st.windZ);
    this.rain.points.visible = st.rain > 0.02;

    // In-cloud mist at the camera. Cheap smoothed field lookup; the value is
    // still the public 0..1 density (main.js keeps driving its own wash).
    this._inCloud = this.getCloudDensity(camera.position, weather);

    // Subtle airborne wind-mote wisps drifting along the wind vector. Inside a
    // cloud the streaks brighten and thicken so wispy vapour visibly whips
    // past the jet while punching through the deck.
    const ws = this.windStreaks;
    const wMag = Math.hypot(st.windX, st.windZ);
    ws.drift.x += st.windX * dt * 1.8;
    ws.drift.z += st.windZ * dt * 1.8;
    ws.drift.y += Math.sin(this._time * 0.9) * (st.gust || 0) * dt * 2.5;
    const wInt = clamp((wMag - 2.5) / 14 + (st.gust || 0) * 0.45, 0, 1);
    const mistBoost = this._inCloud > 0.15
      ? Math.min(1, (this._inCloud - 0.15) / 0.85) * 0.9
      : 0;
    ws.mat.uniforms.uCamPos.value.copy(camera.position);
    ws.mat.uniforms.uDrift.value.copy(ws.drift);
    ws.mat.uniforms.uIntensity.value = clamp(
      wInt * (1 - sky.night * 0.55) * (1 + mistBoost) + this._inCloud * 0.4,
      0, 1,
    );
    ws.points.visible = ws.mat.uniforms.uIntensity.value > 0.06;
  }
}