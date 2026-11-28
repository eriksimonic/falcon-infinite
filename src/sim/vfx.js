// Combat VFX — wingtip/LEX high-G vapor ribbons, transonic Mach cone,
// pooled explosions with shockwave rings and sparks, burning wreck smoke
// plumes, missile/flare smoke trails and the M61A1 muzzle flash.
//
// Everything is preallocated: geometry attributes and particle state live in
// typed arrays owned by the pools. spawn*() only writes into free slots, so a
// busy battlefield produces no per-frame garbage. `scene` may be null in
// headless tests: the pools then update without being attached to a scene.
import * as THREE from 'three';
import { clamp, smoothstep, mulberry32 } from '../world/noise.js';
import { terrainHeight } from '../world/terrain.js';

const SPEED_OF_SOUND = 340;
// Render mesh resolution of a vortex ribbon. The trail itself is captured at
// RIBBON_HISTORY nodes (one per simulated frame) and resampled onto these 64
// segments with a Catmull-Rom spline, so a 9G pull-up reads as a smooth curve
// instead of a faceted polyline. Keep the two separate: the trail depth is part
// of the acceptance contract in tests/vfx_test.mjs (r.filled === 36).
const RIBBON_SEGMENTS = 64;
const RIBBON_HISTORY = 36;
const RIBBON_ALPHA = 0.55;
// Condensation core half-width at the emitter (glassy, tight) and at the far
// tail (a billowing turbulent plume), in metres.
const RIBBON_W_TIP = 0.10;
const RIBBON_W_TAIL = 0.70;
const BOOM_COOLDOWN = 4;
const MAX_EXPLOSIONS = 12;
// Feature 21: explosions are a multi-stage effect, not a 0.45 s flash.
// A big fire is unmistakable from 5 km away: a normal-blended orange fireball
// shell (the part that survives daylight), an additive incandescent core, an
// expanding condensation ring, and a rising charcoal/orange smoke column.
const EXPLOSION_DURATION = 5.5;
const CORE_TIME = 1.8;
const FIREBALL_TIME = 1.8;
const RING_TIME = 1.35;
const SMOKE_COLUMN_TIME = 2.4;
const INITIAL_SMOKE_PUFFS = 14;
const HOT_SMOKE_PUFFS = 5; // of the initial burst, ember-lit
const SPARK_MIN = 20;
const SPARK_MAX = 28;
// Feature 24: the BFFG mega-blast (scale = 14) is a different animal — an
// 8.5 s apocalyptic mushroom with a ~336 m shockwave ring (scale * 24), a
// dense 26-puff plasma/fireball burst and 32-40 high-velocity embers.
const MEGA_SCALE = 10;
const MEGA_DURATION = 8.5;
const MEGA_CORE_TIME = 2.8;
const MEGA_FIREBALL_TIME = 2.8;
const MEGA_RING_TIME = 2.2;
const MEGA_SMOKE_TIME = 6.5;
const MEGA_INITIAL_PUFFS = 26;
const MEGA_SPARK_MIN = 32;
const MEGA_SPARK_MAX = 40;
const MAX_PLUMES = 16; // a single Mk-82 blast can claim 4 (impact + 3 rubble columns)
const PUFF_CAPACITY = 1400;
const SPARK_CAPACITY = 420;

// Feature 25: the blast is a five-lobe fireball cluster, a dynamic flash light
// and a ballistic field of tumbling 3D chunks. Every lobe/chunk lives in a
// preallocated pool, so a busy battlefield still allocates nothing per frame.
const TAU = Math.PI * 2;
const LOBE_COUNT = 4;
const LOBE_COLORS = [0xff6e1a, 0xff4410, 0xff9926, 0x3a241a];
// Fixed per-lobe geometry: radius factor, rise factor, size factor, churn rate.
// Deterministic, so the cluster has a recognisable, non-spherical silhouette.
const LOBE_ANGLE = [0.35, 2.25, 4.05, 5.55];
const LOBE_RADIUS = [0.44, 0.68, 0.52, 0.8];
const LOBE_RISE = [1.0, 0.52, 0.82, 0.3];
const LOBE_SIZE = [0.62, 0.48, 0.56, 0.72];
const LOBE_SPIN = [0.85, -1.3, 1.65, -0.55];
const DEBRIS_CAPACITY = 160;
const DEBRIS_GRAVITY = -9.81;
// Debris trail smoke. The fastest third of every burst is modelled as a burning
// wing/fuselage shard: it drags a dark arcing smoke streamer behind it while it
// is still fast and young, exactly like the shrapnel in a real aircraft kill.
const DEBRIS_SMOKING_FRACTION = 0.35;
const DEBRIS_SMOKE_PERIOD = 0.045;
const DEBRIS_SMOKE_AGE = 1.5;
const DEBRIS_SMOKE_SPEED = 12;
const GUN_PORT = new THREE.Vector3(-0.75, 0.25, -2.5);
// Condensation vortex emitters in airframe-local metres (x right, y up, z aft).
// Wingtip pair: the tips of the F-16C Block 50 LAU-129 missile rails, where the
// strongest tip vortex sheds. LERX pair: the strake shoulder ahead of the wing
// root, which only condenses hard once the jet is genuinely loaded (>10 deg AoA
// or >3.5G) and is otherwise dry.
const WINGTIP_LOCAL = [
  new THREE.Vector3(4.96, 0.04, 2.95),
  new THREE.Vector3(-4.96, 0.04, 2.95),
];
const LERX_LOCAL = [
  new THREE.Vector3(1.08, 0.14, -0.75),
  new THREE.Vector3(-1.08, 0.14, -0.75),
];

const _head = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _side = new THREE.Vector3();
const _local = new THREE.Vector3();

// Scratch objects for the instanced debris matrices (never reallocated).
const _dMat = new THREE.Matrix4();
const _dPos = new THREE.Vector3();
const _dScale = new THREE.Vector3();
const _dQuat = new THREE.Quaternion();
const _dEuler = new THREE.Euler();
// Scratch list of the pool slots launched by one burst, so _spawnDebris() can
// pick out the fastest chunks without allocating (a burst is at most 44).
const _debrisBatch = new Int16Array(DEBRIS_CAPACITY);

function hasPose(flight) {
  return !!(
    flight
    && flight.position
    && flight.position.x !== undefined
    && flight.quaternion
    && flight.quaternion.w !== undefined
  );
}

// ---------------------------------------------------------------- particles
// Soft round billboard puffs/sparks. One pool per blending mode, all state in
// flat typed arrays so update() never allocates.
class ParticlePool {
  constructor(capacity, blending, drag, gravity, renderOrder) {
    this.capacity = capacity;
    this.drag = drag;
    this.gravity = gravity;
    this.count = 0;
    this.cursor = 0;
    // Highest slot that has been used at least once. update() only walks and
    // uploads the prefix [0, _hi]; -1 means the pool has never spawned.
    this._hi = -1;

    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.alpha = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.opacity = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.buoy = new Float32Array(capacity);
    this.windF = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.active = new Uint8Array(capacity);

    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.pos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(this.col, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    const alphaAttr = new THREE.BufferAttribute(this.alpha, 1);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    const sizeAttr = new THREE.BufferAttribute(this.size, 1);
    sizeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('aColor', colAttr);
    geo.setAttribute('aAlpha', alphaAttr);
    geo.setAttribute('aSize', sizeAttr);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      vertexShader: /* glsl */`
        attribute float aAlpha;
        attribute float aSize;
        attribute vec3 aColor;
        varying float vA;
        varying vec3 vC;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vA = aAlpha;
          vC = aColor;
          gl_PointSize = clamp(aSize * 420.0 / max(6.0, -mv.z), 1.5, 240.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision mediump float;
        varying float vA;
        varying vec3 vC;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          float a = smoothstep(0.5, 0.06, r) * vA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vC, a);
        }
      `,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = renderOrder;
    points.visible = false;

    this.geo = geo;
    this.points = points;
    this.posAttr = posAttr;
    this.colAttr = colAttr;
    this.alphaAttr = alphaAttr;
    this.sizeAttr = sizeAttr;
  }

  spawn(x, y, z, vx, vy, vz, life, size, r, g, b, opacity, buoy, windF, grow) {
    let i = this.cursor;
    let guard = 0;
    while (this.active[i] && guard < this.capacity) {
      i = (i + 1) % this.capacity;
      guard++;
    }
    if (!this.active[i]) this.count++;

    this.active[i] = 1;
    const p = i * 3;
    this.pos[p] = x;
    this.pos[p + 1] = y;
    this.pos[p + 2] = z;
    this.col[p] = r;
    this.col[p + 1] = g;
    this.col[p + 2] = b;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.buoy[i] = buoy;
    this.windF[i] = windF;
    this.grow[i] = grow;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
    this.size[i] = size;
    this.opacity[i] = opacity;
    this.alpha[i] = opacity * 0.2;

    this.colAttr.needsUpdate = true;
    if (i > this._hi) this._hi = i;
    this.cursor = (i + 1) % this.capacity;
    return i;
  }

  update(dt, windX, windZ) {
    if (this.count <= 0) {
      this.points.visible = false;
      return 0;
    }
    // Walk only the slots that have ever been touched, not the full capacity.
    const hi = this._hi;
    const drag = Math.exp(-this.drag * dt);
    for (let i = 0; i <= hi; i++) {
      if (!this.active[i]) continue;

      const life = this.life[i] - dt;
      this.life[i] = life;
      if (life <= 0) {
        this.active[i] = 0;
        this.alpha[i] = 0;
        this.size[i] = 0;
        this.count--;
        continue;
      }

      const p = i * 3;
      this.pos[p] += (this.vx[i] + windX * this.windF[i]) * dt;
      this.pos[p + 1] += (this.vy[i] + this.buoy[i]) * dt;
      this.pos[p + 2] += (this.vz[i] + windZ * this.windF[i]) * dt;

      this.vy[i] += this.gravity * dt;
      this.vx[i] *= drag;
      this.vy[i] *= drag;
      this.vz[i] *= drag;

      const t = 1 - life / this.maxLife[i];
      this.size[i] = Math.max(0.05, this.baseSize[i] * (1 + this.grow[i] * t));
      const fadeIn = t < 0.05 ? t / 0.05 : 1;
      this.alpha[i] = this.opacity[i] * fadeIn * Math.pow(1 - t, 1.35);
    }

    // Compact the high-water mark down to the last slot still alive, so a
    // short burst does not keep the loop and the uploads at full width.
    let newHi = hi;
    while (newHi >= 0 && !this.active[newHi]) newHi--;
    this._hi = newHi;

    // Upload only the live prefix. `hi` (this frame's highest slot) is used as
    // the end marker, because slots that expired during this update must still
    // push their zeroed alpha/size, or they would linger on the GPU.
    const uploadCount = hi + 1;
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(0, uploadCount * 3);
    this.posAttr.needsUpdate = true;
    this.alphaAttr.clearUpdateRanges();
    this.alphaAttr.addUpdateRange(0, uploadCount);
    this.alphaAttr.needsUpdate = true;
    this.sizeAttr.clearUpdateRanges();
    this.sizeAttr.addUpdateRange(0, uploadCount);
    this.sizeAttr.needsUpdate = true;
    this.points.visible = this.count > 0;
    return this.count;
  }

  clear() {
    this.active.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    this.count = 0;
    this.cursor = 0;
    this._hi = -1;
    this.points.visible = false;
    this.alphaAttr.clearUpdateRanges();
    this.sizeAttr.clearUpdateRanges();
    this.alphaAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }
}

// ------------------------------------------------------------------- CombatVFX
export class CombatVFX {
  constructor(scene) {
    this.scene = scene || null;
    this.group = new THREE.Group();
    this.group.name = 'combat-vfx';
    if (this.scene && typeof this.scene.add === 'function') this.scene.add(this.group);

    this.seed = 0x5f356495;
    this.rng = mulberry32(this.seed);

    // --- wingtip vapor ribbons -------------------------------------------
    this.vaporIntensity = 0;
    // LERX/strake vortices are a separate, later-arriving effect: the strake
    // only squeezes the air hard enough to condense at high AoA or high G.
    this.lerxIntensity = 0;
    // Shared shader clock, advanced once per update() so every ribbon material
    // samples the same uTime and the turbulence churns instead of strobing.
    this.vaporTime = 0;
    this.ribbons = [];
    this._buildRibbons();

    // --- transonic Mach cone ---------------------------------------------
    this.machIntensity = 0;
    this.sonicCooldown = 0;
    this._wasSupersonic = false;
    this.lastSonicBoom = false;
    this.mach = this._buildMachCone();

    // --- explosion pool ---------------------------------------------------
    // The fireball shader displaces this sphere along its own normal, so the
    // shell needs enough vertices for the cauliflower billows to read as
    // turbulence rather than as a lumpy low-poly blob.
    this._coreGeo = new THREE.SphereGeometry(1, 48, 34);
    this._ringGeo = new THREE.RingGeometry(0.82, 1, 48, 1);
    this._ringGeo.rotateX(-Math.PI / 2);
    this.explosions = [];
    this._explosionCursor = 0;
    // Shared shader clock for every fireball/lobe material, so the noise field
    // churns continuously instead of restarting with each detonation.
    this.explosionTime = 0;
    this._buildExplosions();

    // --- Feature 25: dynamic blast flash --------------------------------
    // A single shared warm-orange point light, preallocated and simply
    // repositioned/re-pulsed on detonation, so nearby skyscrapers, streets
    // and terrain catch the muzzle of the fireball.
    this._blastLight = new THREE.PointLight(0xff9b42, 0, 450, 1.5);
    this._blastLight.position.set(0, 0, 0);
    // Starts dark, so keep it out of every lit program's light loop.
    this._blastLight.visible = false;
    this.group.add(this._blastLight);
    this._blastPeak = 0;
    this._blastTimer = 0;
    this._blastDuration = 0.7;
    this._blastPhase = 0;

    // --- Feature 25: tumbling 3D debris field ---------------------------
    this.debris = this._buildDebris();
    this.activeDebris = 0;

    // --- persistent burning wreck plumes ----------------------------------
    this.plumes = [];
    this._plumeCursor = 0;
    for (let i = 0; i < MAX_PLUMES; i++) {
      this.plumes.push({
        active: false,
        pos: new THREE.Vector3(),
        remaining: 0,
        duration: 0,
        emitTimer: 0,
        seed: 0,
        rate: 4.2,
      });
    }

    // --- particle pools ---------------------------------------------------
    this.puffs = new ParticlePool(PUFF_CAPACITY, THREE.NormalBlending, 0.22, 0, 4);
    this.sparks = new ParticlePool(SPARK_CAPACITY, THREE.AdditiveBlending, 0.85, -14, 5);
    this.group.add(this.puffs.points);
    this.group.add(this.sparks.points);

    // --- cannon muzzle flash ----------------------------------------------
    this.muzzleTimer = 0;
    this._muzzlePhase = 0;
    this.muzzle = this._buildMuzzleFlash();

    this.activeParticles = 0;
    this.activeExplosions = 0;
    this.activePlumes = 0;
    this.activeDebris = 0;
    this.stats = {
      sonicBoom: false,
      activeParticles: 0,
      activeExplosions: 0,
      activePlumes: 0,
      activeDebris: 0,
    };
  }

  // ------------------------------------------------------------- construction
  _buildRibbons() {
    // Four emitters: the wingtip pair always condenses at high G/AoA, the LERX
    // pair only once the wing is really loaded (see update()).
    const emitters = [
      { local: WINGTIP_LOCAL[0], kind: 'tip', widthScale: 1.0, alphaScale: 1.0 },
      { local: WINGTIP_LOCAL[1], kind: 'tip', widthScale: 1.0, alphaScale: 1.0 },
      { local: LERX_LOCAL[0], kind: 'lerx', widthScale: 0.82, alphaScale: 0.72 },
      { local: LERX_LOCAL[1], kind: 'lerx', widthScale: 0.82, alphaScale: 0.72 },
    ];

    for (let w = 0; w < emitters.length; w++) {
      const em = emitters[w];
      const vertCount = RIBBON_SEGMENTS * 2;
      const positions = new Float32Array(vertCount * 3);
      const alphas = new Float32Array(vertCount);
      // u runs 0..1 along the trail, v is 0 or 1 across the width. The fragment
      // shader turns that into a cylindrical vapour profile instead of a strip.
      const uvs = new Float32Array(vertCount * 2);
      for (let i = 0; i < RIBBON_SEGMENTS; i++) {
        const u = RIBBON_SEGMENTS > 1 ? i / (RIBBON_SEGMENTS - 1) : 0;
        uvs[i * 4] = u;
        uvs[i * 4 + 1] = 0;
        uvs[i * 4 + 2] = u;
        uvs[i * 4 + 3] = 1;
      }
      const indices = new Uint16Array((RIBBON_SEGMENTS - 1) * 6);
      for (let i = 0; i < RIBBON_SEGMENTS - 1; i++) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        const o = i * 6;
        indices[o] = a;
        indices[o + 1] = b;
        indices[o + 2] = c;
        indices[o + 3] = b;
        indices[o + 4] = d;
        indices[o + 5] = c;
      }

      const geo = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(positions, 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      const alphaAttr = new THREE.BufferAttribute(alphas, 1);
      alphaAttr.setUsage(THREE.DynamicDrawUsage);
      const uvAttr = new THREE.BufferAttribute(uvs, 2);
      uvAttr.setUsage(THREE.DynamicDrawUsage);
      uvAttr.needsUpdate = true;
      geo.setAttribute('position', posAttr);
      geo.setAttribute('aAlpha', alphaAttr);
      geo.setAttribute('uv', uvAttr);
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      geo.setDrawRange(0, 0);

      const seed = 1.7 + w * 2.31;
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        // fog: true + the merged fog uniforms make <fog_fragment> legal; without
        // both, USE_FOG is undefined and the chunk compiles to nothing.
        fog: true,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uColor: { value: new THREE.Color(0xf5faff) },
            uTime: { value: 0 },
            uSeed: { value: seed },
            uTurb: { value: 0 },
            uNight: { value: 0 },
          },
        ]),
        vertexShader: /* glsl */`
          attribute float aAlpha;
          varying float vA;
          varying vec2 vUv;
          #include <fog_pars_vertex>
          void main() {
            vA = aAlpha;
            vUv = uv;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }
        `,
        fragmentShader: /* glsl */`
          precision highp float;
          uniform vec3 uColor;
          uniform float uTime;
          uniform float uSeed;
          uniform float uTurb;
          uniform float uNight;
          varying float vA;
          varying vec2 vUv;
          #include <fog_pars_fragment>

          float hash21(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
          }

          // Value noise: smooth, cheap, and enough for a 2-octave vapour fBM.
          float vnoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float a = hash21(i);
            float b = hash21(i + vec2(1.0, 0.0));
            float c = hash21(i + vec2(0.0, 1.0));
            float d = hash21(i + vec2(1.0, 1.0));
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
          }

          void main() {
            float u = clamp(vUv.x, 0.0, 1.0);
            float v = clamp(vUv.y, 0.0, 1.0);

            // Helical twist: the vortex spins faster and wider toward the tail.
            float grow = smoothstep(0.02, 0.45, u);
            float twist = sin(u * 30.0 - uTime * 16.0 + uSeed) * 0.22 * grow;
            float vw = v + twist;

            // Soft cylindrical profile: a dense core plus a wispy outer mist.
            float dv = (vw - 0.5) * 3.8;
            float core = exp(-dv * dv);
            float mist = smoothstep(0.0, 0.35, 1.0 - abs(vw * 2.0 - 1.0));

            // Two octaves of scrolling turbulence carve the vapour apart.
            float nFar = vnoise(vec2(u * 14.0 - uTime * 5.5, vw * 3.2 + uSeed));
            float nNear = vnoise(vec2(u * 34.0 - uTime * 11.0, vw * 7.5 + uSeed * 2.1));
            float turb = nFar * 0.64 + nNear * 0.36;

            // u < 0.08: tight, continuous and silky. From 0.15 -> 1.0 the noise
            // eats growing lace gaps into the plume.
            float breakup = smoothstep(0.15, 1.0, u) * clamp(uTurb, 0.0, 1.0);
            float lacy = smoothstep(0.30, 0.82, turb);
            float carve = mix(1.0, lacy, breakup);

            float density = (core * 0.92 + mist * 0.30) * carve;
            density = mix(core, density, smoothstep(0.05, 0.20, u));

            float a = vA * density * (1.0 - 0.55 * uNight);
            if (a < 0.004) discard;

            // Bright sunlit white-blue core -> cooler misty grey-blue rim.
            vec3 col = mix(vec3(0.76, 0.83, 0.90), uColor, smoothstep(0.12, 0.85, core));
            col *= (0.90 + 0.18 * nFar) * (1.0 - 0.30 * uNight);

            gl_FragColor = vec4(col, a);
            #include <fog_fragment>
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      mesh.visible = false;
      this.group.add(mesh);

      this.ribbons.push({
        mesh,
        geo,
        mat,
        posAttr,
        alphaAttr,
        uvAttr,
        positions,
        alphas,
        uvs,
        // Captured trail, one node per simulated frame, oldest last.
        hist: new Float32Array(RIBBON_HISTORY * 3),
        // Age (s) of each captured node. Allocated at the render resolution so
        // no allocation is ever needed at runtime; only RIBBON_HISTORY entries
        // are live.
        ages: new Float32Array(RIBBON_SEGMENTS),
        // Half-width of each render segment, refreshed every frame.
        widths: new Float32Array(RIBBON_SEGMENTS),
        filled: 0,
        local: em.local,
        kind: em.kind,
        // Left tip (x < 0) spins the opposite way to the right tip.
        side: em.local.x < 0 ? -1 : 1,
        seed: seed * 3.17,
        widthScale: em.widthScale,
        alphaScale: em.alphaScale,
      });
    }
  }

  _buildMachCone() {
    const profile = [
      new THREE.Vector2(0.001, 7.0),
      new THREE.Vector2(0.85, 3.5),
      new THREE.Vector2(1.5, 0.3),
      new THREE.Vector2(1.35, -1.5),
      new THREE.Vector2(0.6, -3.6),
      new THREE.Vector2(0.001, -5.5),
    ];
    const geo = new THREE.LatheGeometry(profile, 28);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color(0xeaf4ff) },
      },
      vertexShader: /* glsl */`
        varying vec3 vN;
        varying vec3 vView;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision mediump float;
        uniform float uOpacity;
        uniform vec3 uColor;
        varying vec3 vN;
        varying vec3 vView;
        void main() {
          float rim = 1.0 - abs(dot(normalize(vN), normalize(vView)));
          float a = uOpacity * (0.16 + 0.84 * rim * rim);
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 2;
    this.group.add(mesh);
    return { mesh, mat, geo };
  }

  /**
   * Turbulent procedural fireball. A flat MeshBasicMaterial sphere reads as a
   * plastic orange balloon, so the fireball shell and its four lobes share this
   * ShaderMaterial instead:
   *
   *  - the vertex stage displaces the sphere along its own normal with a
   *    multi-octave billow field, breaking the perfect silhouette into a
   *    churning, asymmetrical cauliflower mass and rebuilding the shading
   *    normal from the displaced surface (finite differences);
   *  - the fragment stage lays a temperature ramp over two octaves of noise
   *    scrolled upward through the fireball: incandescent white-yellow core ->
   *    roaring orange flames -> crimson embers -> charcoal soot crust, with the
   *    crevices between billows staying hot long after the shells crust over;
   *  - the silhouette is eroded by that same turbulence, so the shell never
   *    shows a hard plastic sphere outline.
   *
   * `opacity` and `color` are re-exposed as accessors over uOpacity/uColor, so
   * every existing caller — and tests/vfx_test.mjs — keeps reading and writing
   * them exactly as it did on the MeshBasicMaterial this replaces.
   */
  _fireballMaterial(color, seed, soot = 0) {
    const uniforms = {
      uTime: { value: 0 },
      uAge: { value: 0 },
      uSeed: { value: seed },
      uSoot: { value: soot },
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(color) },
    };

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms,
      vertexShader: /* glsl */`
        uniform float uTime;
        uniform float uAge;
        uniform float uSeed;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying vec3 vLocalPos;
        varying float vNoise;

        float hash31(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        // Trilinear value noise: cheap, smooth, and enough for two octaves of
        // gas turbulence.
        float noise3(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float n000 = hash31(i);
          float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
          float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
          float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
          float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
          float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
          float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
          float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
          float nx00 = mix(n000, n100, f.x);
          float nx10 = mix(n010, n110, f.x);
          float nx01 = mix(n001, n101, f.x);
          float nx11 = mix(n011, n111, f.x);
          return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
        }

        // Radial billow: how far the shell bulges in a given direction. Deliberately
        // low frequency and smooth — the mesh only has ~36 segments, so the fine
        // cauliflower detail is carried by the per-pixel erosion in the fragment
        // stage instead. High-frequency displacement here would alias into
        // per-vertex normal noise and make the shell look like cut glass.
        float billow(vec3 dir) {
          float n1 = noise3(dir * 2.2 + vec3(uSeed, -uTime * 0.45, uSeed * 0.7));
          float n2 = noise3(dir * 4.2 + vec3(uTime * 0.28, -uTime * 0.62, uSeed * 1.7));
          float n = n1 * 0.72 + n2 * 0.28;
          // The shell churns harder as it cools and drags soot, but stays
          // anchored to its radius so the pooled mesh scale still means
          // "fireball radius".
          float amp = 0.28 + 0.30 * clamp(uAge, 0.0, 1.0);
          return (n - 0.5) * amp * 2.0;
        }

        void main() {
          vec3 dir = normalize(position);
          // Tangent frame for a finite-difference normal of the displaced shell.
          // mix/step instead of a ternary keeps this branchless on WebGL1.
          vec3 up = mix(vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0), step(0.985, abs(dir.y)));
          vec3 t1 = normalize(cross(up, dir));
          vec3 t2 = cross(dir, t1);

          float eps = 0.09;
          vec3 d1 = normalize(dir + t1 * eps);
          vec3 d2 = normalize(dir + t2 * eps);
          float b0 = billow(dir);
          float b1 = billow(d1);
          float b2 = billow(d2);

          vec3 p0 = dir * (1.0 + b0);
          vec3 p1 = d1 * (1.0 + b1);
          vec3 p2 = d2 * (1.0 + b2);
          vec3 nrm = normalize(cross(p1 - p0, p2 - p0));

          vec4 mv = modelViewMatrix * vec4(p0, 1.0);
          vNormal = normalize(normalMatrix * nrm);
          vViewDir = normalize(-mv.xyz);
          vLocalPos = p0;
          vNoise = b0;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime;
        uniform float uAge;
        uniform float uSeed;
        uniform float uSoot;
        uniform float uOpacity;
        uniform vec3 uColor;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying vec3 vLocalPos;
        varying float vNoise;

        float hash31(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        float noise3(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float n000 = hash31(i);
          float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
          float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
          float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
          float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
          float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
          float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
          float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
          float nx00 = mix(n000, n100, f.x);
          float nx10 = mix(n010, n110, f.x);
          float nx01 = mix(n001, n101, f.x);
          float nx11 = mix(n011, n111, f.x);
          return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
        }

        void main() {
          vec3 N = normalize(vNormal);
          vec3 V = normalize(vViewDir);
          float rim = pow(1.0 - abs(dot(N, V)), 1.6);

          // Two octaves of turbulence scrolled upward through the fireball: the
          // noise field rises with the gas, so the pattern churns rather than
          // sliding past.
          vec3 q = vLocalPos * (4.2 + 2.6 * uAge);
          q.y -= uTime * (1.1 + 1.3 * uAge);
          float f1 = noise3(q + vec3(uSeed * 1.3));
          float f2 = noise3(q * 2.3 + vec3(-uTime * 1.7, uSeed * 2.1, uTime * 1.0));
          // Value noise clusters around 0.5, so stretch it back to a full 0..1
          // range and give it contrast: that is what turns a gentle cloud into
          // distinct billows with deep crevices between them.
          float f = smoothstep(0.30, 0.72, f1 * 0.70 + f2 * 0.30);

          // Temperature. "hot" is the global cooling curve (white-hot at birth,
          // cold soot at the end of the fireball's life); "crev" is the sharpened
          // crevice network between the billows, which stays incandescent long
          // after the exposed shells crust over. The base term is deliberately
          // high so a young fireball is roaring orange everywhere, with white
          // heat only in the cracks; the top of the mass runs cooler than the
          // ground-hugging base, where the fuel is densest.
          float heat = clamp(1.0 - f, 0.0, 1.0);
          float crev = smoothstep(0.40, 0.86, heat);
          float age = clamp(uAge + uSoot * 0.35, 0.0, 1.0);
          float hot = 1.0 - smoothstep(0.10, 1.05, age);
          float temp = hot * (0.55 + 0.45 * crev)
            + vLocalPos.y * 0.16
            - rim * 0.22
            - vNoise * 1.2;
          // Detonation flash: the first ~0.25 of the life is white-heat.
          temp += (1.0 - smoothstep(0.0, 0.25, age)) * 0.30 * (0.5 + 0.5 * crev);
          temp = clamp(temp, 0.0, 1.0);

          vec3 sootCol = vec3(0.06, 0.055, 0.05);
          vec3 crimson = vec3(0.42, 0.08, 0.02);
          vec3 orange = vec3(1.25, 0.42, 0.06);
          vec3 whiteHot = vec3(1.85, 1.35, 0.55);

          vec3 col = sootCol;
          col = mix(col, crimson, smoothstep(0.05, 0.26, temp));
          col = mix(col, orange, smoothstep(0.24, 0.52, temp));
          col = mix(col, whiteHot, smoothstep(0.66, 0.92, temp));

          // Hot crevices glow brighter than the billow faces; the fresnel rim
          // glows while the shell is young, then thickens into a soot crust.
          col *= 1.0 + crev * 0.25;
          col += orange * rim * 0.40 * hot;
          float crust = smoothstep(0.30, 1.0, age) * (0.40 + 0.60 * rim);
          col = mix(col, sootCol * (0.85 + 0.5 * f), crust * 0.8);

          // Per-lobe palette: the fiery lobes warm their flames, the dark lobe
          // pulls its cooling crust toward soot so it ties into the rising plume.
          col = mix(col, col * (0.5 + 1.25 * uColor), 0.30 * (1.0 - temp));

          // Eroded, turbulent edge: no hard sphere outline anywhere. The base
          // erosion term is cut further by the turbulence at the silhouette, so
          // the boundary is a torn, noisy skin instead of a polygonal arc.
          float edge = smoothstep(0.15, 0.72, (1.0 - rim * 0.55) * (0.55 + 0.65 * f));
          edge *= smoothstep(0.30, 0.62, f + (1.0 - rim) * 0.30);
          // Burning gas is densely opaque. A soft rim gradient would leave a
          // pale annulus around a dense middle — i.e. a glass bubble with a
          // shell — so the body is thresholded into a solid mass whose boundary
          // is the noise contour, then it thins into a wispy veil as it cools.
          float density = mix(1.95, 0.75, smoothstep(0.15, 1.0, age));
          float solid = smoothstep(0.26, 0.50, edge * density);
          // Where the gas thins, darken it toward soot instead of opening a
          // window onto the sky: real holes in a fireball are smoke, and a
          // see-through gap is what makes a shell read as glass.
          float thin = 1.0 - smoothstep(0.26, 0.50, edge * density);
          col = mix(col, vec3(0.16, 0.10, 0.07) * (0.7 + 0.5 * f), thin * 0.55);
          float a = solid * uOpacity;
          if (a < 0.004) discard;

          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    // Backwards compatibility: the pools (and the tests) treat this material
    // exactly like the MeshBasicMaterial it replaced.
    Object.defineProperty(mat, 'opacity', {
      configurable: true,
      enumerable: true,
      get() { return uniforms.uOpacity.value; },
      set(v) { uniforms.uOpacity.value = v; },
    });
    Object.defineProperty(mat, 'color', {
      configurable: true,
      enumerable: true,
      get() { return uniforms.uColor.value; },
      set(v) {
        if (v && typeof v === 'object' && typeof v.r === 'number') {
          uniforms.uColor.value.copy(v);
        } else {
          uniforms.uColor.value.set(v);
        }
      },
    });

    return mat;
  }

  _buildExplosions() {
    for (let i = 0; i < MAX_EXPLOSIONS; i++) {
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0xfff0b8,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const core = new THREE.Mesh(this._coreGeo, coreMat);
      core.frustumCulled = false;
      core.visible = false;
      core.renderOrder = 6;
      this.group.add(core);

      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffa64d,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(this._ringGeo, ringMat);
      ring.frustumCulled = false;
      ring.visible = false;
      ring.renderOrder = 6;
      this.group.add(ring);

      // Opaque-ish orange-red shell. Additive fire vanishes against a bright
      // sky; this one is normal-blended so the blast reads in daylight too, and
      // it shades as turbulent incandescent gas rather than a flat orange ball.
      const fireballMat = this._fireballMaterial(0xff5a18, 1.7 + i * 1.13, 0);
      const fireball = new THREE.Mesh(this._coreGeo, fireballMat);
      fireball.frustumCulled = false;
      fireball.visible = false;
      fireball.renderOrder = 5;
      this.group.add(fireball);

      // Feature 25: four extra fireball lobes per slot, each with its own
      // material so it can billow, churn and fade independently. Index 3 is a
      // dark, nearly-blackened lobe that drags the cluster into the smoke
      // column; the rest are fiery orange shades.
      const lobes = [];
      for (let L = 0; L < LOBE_COUNT; L++) {
        // Index LOBE_COUNT - 1 is the soot lobe: uSoot fast-forwards its cooling
        // curve so it crusts over into charcoal while the others still roar.
        const lobeMat = this._fireballMaterial(
          LOBE_COLORS[L],
          4.3 + i * 2.07 + L * 1.71,
          L === LOBE_COUNT - 1 ? 1 : 0,
        );
        const lobe = new THREE.Mesh(this._coreGeo, lobeMat);
        lobe.frustumCulled = false;
        lobe.visible = false;
        lobe.renderOrder = L === LOBE_COUNT - 1 ? 4 : 5;
        this.group.add(lobe);
        lobes.push(lobe);
      }

      this.explosions.push({
        active: false,
        t: 0,
        duration: EXPLOSION_DURATION,
        scale: 1,
        smokeTimer: 0,
        mega: false,
        lobeSeed: 0,
        // Per-slot stage timings: a mega-blast stretches every one of them.
        coreTime: CORE_TIME,
        fireballTime: FIREBALL_TIME,
        ringTime: RING_TIME,
        smokeTime: SMOKE_COLUMN_TIME,
        pos: new THREE.Vector3(),
        core,
        coreMat,
        ring,
        ringMat,
        fireball,
        fireballMat,
        lobes,
      });
    }
  }

  _buildDebris() {
    const geo = new THREE.BoxGeometry(1, 0.7, 0.85);
    // Concrete/steel rubble: lit by the scene's sun + our own blast flash, so
    // a Lambert material is enough and stays cheap with 160 instances.
    const mat = new THREE.MeshLambertMaterial({ color: 0x4a4540 });
    const mesh = new THREE.InstancedMesh(geo, mat, DEBRIS_CAPACITY);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = 5;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);

    return {
      capacity: DEBRIS_CAPACITY,
      mesh,
      cursor: 0,
      rendered: 0,
      activeDebris: 0,
      // Flat state, one entry per chunk: position, velocity, Euler angles,
      // angular velocity, size, lifetime, ground plane and occupancy.
      px: new Float32Array(DEBRIS_CAPACITY),
      py: new Float32Array(DEBRIS_CAPACITY),
      pz: new Float32Array(DEBRIS_CAPACITY),
      vx: new Float32Array(DEBRIS_CAPACITY),
      vy: new Float32Array(DEBRIS_CAPACITY),
      vz: new Float32Array(DEBRIS_CAPACITY),
      rx: new Float32Array(DEBRIS_CAPACITY),
      ry: new Float32Array(DEBRIS_CAPACITY),
      rz: new Float32Array(DEBRIS_CAPACITY),
      avx: new Float32Array(DEBRIS_CAPACITY),
      avy: new Float32Array(DEBRIS_CAPACITY),
      avz: new Float32Array(DEBRIS_CAPACITY),
      sx: new Float32Array(DEBRIS_CAPACITY),
      sy: new Float32Array(DEBRIS_CAPACITY),
      sz: new Float32Array(DEBRIS_CAPACITY),
      life: new Float32Array(DEBRIS_CAPACITY),
      maxLife: new Float32Array(DEBRIS_CAPACITY),
      floorY: new Float32Array(DEBRIS_CAPACITY),
      active: new Uint8Array(DEBRIS_CAPACITY),
      bounced: new Uint8Array(DEBRIS_CAPACITY),
      // Ember trail state: `smoking` flags the fastest chunks of a burst as
      // burning shards, `trailTimer` counts down to their next smoke puff.
      smoking: new Uint8Array(DEBRIS_CAPACITY),
      trailTimer: new Float32Array(DEBRIS_CAPACITY),
    };
  }

  _buildMuzzleFlash() {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd07a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const coneGeo = new THREE.ConeGeometry(0.22, 1.1, 8, 1, true);
    coneGeo.rotateX(-Math.PI / 2);
    const cone = new THREE.Mesh(coneGeo, mat);
    cone.position.z = -0.45;
    cone.frustumCulled = false;

    const coreGeo = new THREE.SphereGeometry(0.16, 8, 6);
    const core = new THREE.Mesh(coreGeo, mat);
    core.position.z = -0.05;
    core.frustumCulled = false;

    const mesh = new THREE.Group();
    mesh.add(cone);
    mesh.add(core);
    mesh.visible = false;
    mesh.renderOrder = 7;
    this.group.add(mesh);
    return { mesh, mat };
  }

  // ---------------------------------------------------------------- spawning
  spawnExplosion(pos, scale = 1) {
    const s = clamp(scale || 1, 0.15, 30);
    let slot = null;
    for (let n = 0; n < MAX_EXPLOSIONS; n++) {
      const idx = (this._explosionCursor + n) % MAX_EXPLOSIONS;
      if (!this.explosions[idx].active) {
        slot = this.explosions[idx];
        this._explosionCursor = (idx + 1) % MAX_EXPLOSIONS;
        break;
      }
    }
    if (!slot) {
      slot = this.explosions[this._explosionCursor];
      this._explosionCursor = (this._explosionCursor + 1) % MAX_EXPLOSIONS;
    }

    slot.active = true;
    slot.t = 0;
    // Feature 24: a mega-blast lingers for 8.5 s with a long-burning core and
    // fireball plus a slow 336 m shockwave; everything smaller keeps the exact
    // Feature 21 timings (5.5 s / 1.8 s / 1.35 s).
    const mega = s >= MEGA_SCALE;
    slot.mega = mega;
    slot.duration = mega ? MEGA_DURATION : EXPLOSION_DURATION;
    slot.coreTime = mega ? MEGA_CORE_TIME : CORE_TIME;
    slot.fireballTime = mega ? MEGA_FIREBALL_TIME : FIREBALL_TIME;
    slot.ringTime = mega ? MEGA_RING_TIME : RING_TIME;
    slot.smokeTime = mega ? MEGA_SMOKE_TIME : SMOKE_COLUMN_TIME;
    slot.scale = s;
    slot.smokeTimer = 0;
    slot.pos.set(pos.x || 0, pos.y || 0, pos.z || 0);
    slot.core.visible = true;
    slot.ring.visible = true;
    slot.fireball.visible = true;
    // Feature 25: give the lobe cluster its own churn phase and start every
    // lobe at the blast centre (update() then throws them outward).
    slot.lobeSeed = this.rng() * TAU;
    // Fresh noise seed (and restart the cooling clock) per detonation, so no
    // two fireballs churn identically out of the shared material pool.
    slot.fireballMat.uniforms.uSeed.value = slot.lobeSeed * 2.3;
    slot.fireballMat.uniforms.uAge.value = 0;
    slot.fireballMat.opacity = 0;
    for (let L = 0; L < slot.lobes.length; L++) {
      const lobe = slot.lobes[L];
      lobe.visible = true;
      lobe.position.copy(slot.pos);
      lobe.scale.setScalar(0.001);
      lobe.material.uniforms.uSeed.value = slot.lobeSeed * 3.7 + L * 1.9;
      lobe.material.uniforms.uAge.value = 0;
      lobe.material.opacity = 0;
    }

    // 20–28 gravity-arcing hot embers and debris (32–40, much faster, for the
    // BFFG mega-blast).
    const sparks = mega
      ? MEGA_SPARK_MIN + Math.floor(this.rng() * (MEGA_SPARK_MAX - MEGA_SPARK_MIN + 1))
      : SPARK_MIN + Math.floor(this.rng() * (SPARK_MAX - SPARK_MIN + 1));
    const megaBoost = Math.pow(s, 0.35);
    for (let i = 0; i < sparks; i++) {
      const theta = this.rng() * Math.PI * 2;
      const phi = this.rng() * 2 - 1;
      const rho = Math.sqrt(Math.max(0, 1 - phi * phi));
      const spd = mega
        ? (22 + this.rng() * 52) * megaBoost
        : (8 + this.rng() * 28) * Math.sqrt(s);
      const sparkSize = mega
        ? (0.16 + this.rng() * 0.2) * Math.min(s, 8)
        : (0.16 + this.rng() * 0.2) * Math.min(s, 3);
      this.sparks.spawn(
        slot.pos.x, slot.pos.y + 0.4 * s, slot.pos.z,
        Math.cos(theta) * rho * spd,
        Math.abs(phi) * spd * 0.8 + 5,
        Math.sin(theta) * rho * spd,
        mega ? 0.9 + this.rng() * 1.2 : 0.55 + this.rng() * 0.85,
        sparkSize,
        1.0, 0.55 + this.rng() * 0.3, 0.12,
        0.95, 0, 0.25, -0.55,
      );
    }

    // Dense detonation burst; the rest of the column is emitted while the
    // fireball is still hot (see update()).
    if (mega) {
      for (let i = 0; i < MEGA_INITIAL_PUFFS; i++) this._emitMegaBurstPuff(slot, i);
    } else {
      for (let i = 0; i < INITIAL_SMOKE_PUFFS; i++) {
        this._emitExplosionSmoke(slot, true, i >= INITIAL_SMOKE_PUFFS - HOT_SMOKE_PUFFS);
      }
    }

    // White-hot multi-core ground fireball plus a thick charcoal soot collar.
    this._emitBlastCorePuffs(slot);

    // Feature 25: pulse the shared blast light and throw the debris field.
    this._fireBlastFlash(slot.pos, s);
    this._spawnDebris(slot.pos, s);

    return slot;
  }

  /**
   * Feature 24: one building-fire pulse — a bright flickering flame puff plus a
   * thick dark smoke puff. Headless-safe, allocation-free (only writes into the
   * preallocated puff pool). Returns the number of puffs emitted.
   */
  spawnFirePuff(pos, scale = 1) {
    const p = pos && typeof pos === 'object' ? pos : null;
    const sc = clamp(Number.isFinite(scale) ? scale : 1, 0.2, 6);
    const px = p && Number.isFinite(p.x) ? p.x : 0;
    const py = p && Number.isFinite(p.y) ? p.y : 0;
    const pz = p && Number.isFinite(p.z) ? p.z : 0;
    const jitter = 0.4 * sc;

    // Flame: #ff6e1a -> #ffb43a, short and violently buoyant.
    const lr = 1 - this.rng() * 0.1;
    this.puffs.spawn(
      px + (this.rng() - 0.5) * jitter,
      py + this.rng() * 0.5 * sc,
      pz + (this.rng() - 0.5) * jitter,
      (this.rng() - 0.5) * 1.6 * sc,
      (5.5 + this.rng() * 4.5) * sc,
      (this.rng() - 0.5) * 1.6 * sc,
      0.6 + this.rng() * 0.5,
      (0.9 + this.rng() * 0.8) * sc,
      1.0, (0.43 + this.rng() * 0.24) * lr, (0.10 + this.rng() * 0.10) * lr,
      0.86, 2.2, 0.55, 1.8,
    );

    // Soot: #1e1d1c, long-lived, drifting downwind with the weather system.
    this.puffs.spawn(
      px + (this.rng() - 0.5) * jitter,
      py + 0.7 * sc + this.rng() * 0.6 * sc,
      pz + (this.rng() - 0.5) * jitter,
      (this.rng() - 0.5) * 1.0 * sc,
      (2.0 + this.rng() * 2.2) * sc,
      (this.rng() - 0.5) * 1.0 * sc,
      2.8 + this.rng() * 1.7,
      (1.6 + this.rng() * 1.4) * sc,
      0.118, 0.114, 0.110,
      0.62, 1.6, 0.9, 2.2,
    );

    return 2;
  }

  // Incandescent multi-core ground fireball: three to five white-hot blobs at
  // the blast centre (bright enough for the tonemapper to bloom them) buried in
  // a wide, slowly expanding charcoal-brown soot cloud, so the detonation has a
  // molten heart wrapped in rolling black smoke instead of one flat orange dome.
  _emitBlastCorePuffs(e) {
    const s = clamp(e.scale, 0.4, 6);
    const cores = e.mega ? 5 : 4;
    for (let i = 0; i < cores; i++) {
      const ang = (i / cores) * TAU + e.lobeSeed;
      const rad = (0.22 + this.rng() * 0.42) * s;
      const k = 0.9 + this.rng() * 0.1; // warm yellow-white, HDR-bright
      this.puffs.spawn(
        e.pos.x + Math.cos(ang) * rad,
        e.pos.y + (0.3 + this.rng() * 0.45) * s,
        e.pos.z + Math.sin(ang) * rad,
        Math.cos(ang) * (1.0 + this.rng() * 2.4) * s,
        (7 + this.rng() * 6) * s,
        Math.sin(ang) * (1.0 + this.rng() * 2.4) * s,
        0.55 + this.rng() * 0.5,
        (1.8 + this.rng() * 1.6) * s,
        1.0 * k, 0.86 * k, 0.42 * k,
        0.92, 3.8, 0.55, 2.4,
      );
    }

    // Thick soot collar: dark, brown-black, wide and slow, expanding as it
    // climbs so the fire sits inside a turbulent charcoal cloud.
    const soot = e.mega ? 9 : 6;
    for (let i = 0; i < soot; i++) {
      const ang = this.rng() * TAU;
      const rad = (0.5 + this.rng() * 1.6) * s;
      const shade = 0.085 + this.rng() * 0.05;
      this.puffs.spawn(
        e.pos.x + Math.cos(ang) * rad,
        e.pos.y + (0.4 + this.rng() * 1.4) * s,
        e.pos.z + Math.sin(ang) * rad,
        Math.cos(ang) * (1.6 + this.rng() * 3.2) * s,
        (3.2 + this.rng() * 4.0) * s,
        Math.sin(ang) * (1.6 + this.rng() * 3.2) * s,
        2.6 + this.rng() * 2.4,
        (2.6 + this.rng() * 2.6) * s,
        shade, shade * 0.93, shade * 0.82,
        0.66, 2.6, 0.7, 2.3,
      );
    }
  }

  spawnSmokePlume(pos, duration = 60) {
    let slot = null;
    for (let n = 0; n < MAX_PLUMES; n++) {
      const idx = (this._plumeCursor + n) % MAX_PLUMES;
      if (!this.plumes[idx].active) {
        slot = this.plumes[idx];
        this._plumeCursor = (idx + 1) % MAX_PLUMES;
        break;
      }
    }
    if (!slot) {
      slot = this.plumes[this._plumeCursor];
      this._plumeCursor = (this._plumeCursor + 1) % MAX_PLUMES;
    }

    const d = Math.max(0.1, duration);
    slot.active = true;
    slot.pos.set(pos.x || 0, pos.y || 0, pos.z || 0);
    slot.remaining = d;
    slot.duration = d;
    slot.emitTimer = 0;
    slot.seed = this.rng() * 1000;
    // Fat column at first, thinner once the fire is fully involved.
    slot.rate = 4.2;
    return slot;
  }

  /**
   * Tire touchdown / catapult steam puffs: 6-10 expanding off-white puffs
   * sprayed outward from the contact point. Headless-safe and allocation-free
   * (only writes into the preallocated puff pool).
   */
  spawnTireSmoke(position, intensity = 1) {
    const p = position || { x: 0, y: 0, z: 0 };
    const amt = clamp(Number.isFinite(intensity) ? intensity : 1, 0.15, 2.5);
    const count = 6 + Math.floor(this.rng() * 5); // 6..10 puffs
    const px = p.x || 0;
    const py = p.y || 0;
    const pz = p.z || 0;

    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + (this.rng() - 0.5) * 0.9;
      const rad = 0.25 + this.rng() * 0.95;
      const spd = (1.1 + this.rng() * 2.6) * amt;
      // 0xd8dde2 scaled by a little per-puff shading variation.
      const shade = 0.82 + this.rng() * 0.08;
      this.puffs.spawn(
        px + Math.cos(ang) * rad,
        py + this.rng() * 0.4,
        pz + Math.sin(ang) * rad,
        Math.cos(ang) * spd,
        0.5 + this.rng() * 1.5,
        Math.sin(ang) * spd,
        0.9 + this.rng() * 0.6,
        (0.55 + this.rng() * 0.55) * (0.7 + amt * 0.4),
        shade * 0.945, shade * 0.965, shade,
        0.5, 0.6, 0.75, 2.4,
      );
    }
    return count;
  }

  spawnTrail(pos, color = 0xe8eef2, size = 1.6) {
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    const jitter = 0.35;
    this.puffs.spawn(
      (pos.x || 0) + (this.rng() - 0.5) * jitter,
      (pos.y || 0) + (this.rng() - 0.5) * jitter,
      (pos.z || 0) + (this.rng() - 0.5) * jitter,
      (this.rng() - 0.5) * 1.2,
      (this.rng() - 0.2) * 1.0,
      (this.rng() - 0.5) * 1.2,
      1.4 + this.rng() * 1.1,
      size * (0.8 + this.rng() * 0.4),
      r, g, b,
      0.52, 0.25, 0.85, 1.1,
    );
  }

  triggerMuzzleFlash(flight) {
    this.muzzleTimer = 0.06;
    if (hasPose(flight)) {
      this._placeMuzzle(flight);
      this.muzzle.mesh.visible = true;
    }
  }

  // ------------------------------------------------------------------ update
  update(dt, flight, weather, camera) {
    if (!(dt > 0)) dt = 0;
    const state = weather && weather.state ? weather.state : null;
    const windX = state && state.windX ? state.windX : 0;
    const windZ = state && state.windZ ? state.windZ : 0;

    this.sonicCooldown = Math.max(0, this.sonicCooldown - dt);

    // --- Mach cone & sonic boom ------------------------------------------
    let sonicBoom = false;
    const speed = this._flightSpeed(flight);
    const machNow = speed / SPEED_OF_SOUND;
    if (flight) {
      if (machNow >= 1.0) {
        if (!this._wasSupersonic && this.sonicCooldown <= 0) {
          sonicBoom = true;
          this.sonicCooldown = BOOM_COOLDOWN;
        }
        this._wasSupersonic = true;
      } else {
        this._wasSupersonic = false;
      }
    }

    let machTarget = 0;
    if (machNow >= 0.95 && machNow <= 1.06) {
      machTarget = machNow < 1
        ? smoothstep(0.95, 1.0, machNow)
        : 1 - smoothstep(1.0, 1.06, machNow);
    }
    const machRate = machTarget > this.machIntensity ? 16 : 7;
    this.machIntensity += (machTarget - this.machIntensity) * (1 - Math.exp(-machRate * dt));
    if (this.machIntensity < 0.002 && machTarget === 0) this.machIntensity = 0;

    if (this.machIntensity > 0.002 && hasPose(flight)) {
      this.mach.mesh.visible = true;
      this.mach.mesh.position.copy(flight.position);
      this.mach.mesh.quaternion.copy(flight.quaternion);
      const k = 0.94 + this.machIntensity * 0.12;
      this.mach.mesh.scale.set(k, k, k);
      this.mach.mat.uniforms.uOpacity.value = 0.42 * this.machIntensity;
    } else {
      this.mach.mesh.visible = false;
    }

    // --- high-G wingtip vapor ribbons ------------------------------------
    let vaporTarget = 0;
    let lerxTarget = 0;
    if (flight) {
      const g = Number.isFinite(flight.gForce) ? Math.abs(flight.gForce) : 1;
      const aoa = Number.isFinite(flight.aoa) ? Math.abs(flight.aoa) : 0;
      const humid = state
        ? clamp(
          (state.coverage || 0) * 0.5 + (state.density || 0) * 0.3 + (state.rain || 0) * 0.45,
          0, 1,
        )
        : 0.15;
      const airborne = !flight.onGround && speed > 90;
      const condition = airborne && (g > 3.4 || aoa > 0.17);
      if (condition) {
        const gPull = smoothstep(3.4, 6.0, g);
        const aoaPull = smoothstep(0.17, 0.30, aoa);
        const severity = Math.max(gPull, aoaPull);
        vaporTarget = clamp((0.55 + 0.45 * severity) * (0.82 + humid * 0.35), 0, 1);
      }
      // LERX/strake vortices: the strake pair only condenses hard once the jet
      // is genuinely loaded — above 10 deg AoA or 3.5G.
      if (airborne && (aoa > 0.1745 || g > 3.5)) {
        const aoaPull = smoothstep(0.1745, 0.32, aoa);
        const gPull = smoothstep(3.5, 7.0, g);
        lerxTarget = clamp(
          (0.5 + 0.5 * Math.max(aoaPull, gPull)) * (0.86 + humid * 0.28), 0, 1,
        );
      }
    }
    const vaporRate = vaporTarget > this.vaporIntensity ? 6.0 : 2.4;
    this.vaporIntensity += (vaporTarget - this.vaporIntensity)
      * (1 - Math.exp(-vaporRate * dt));
    if (this.vaporIntensity < 0.002 && vaporTarget === 0) this.vaporIntensity = 0;

    const lerxRate = lerxTarget > this.lerxIntensity ? 5.0 : 2.2;
    this.lerxIntensity += (lerxTarget - this.lerxIntensity)
      * (1 - Math.exp(-lerxRate * dt));
    if (this.lerxIntensity < 0.002 && lerxTarget === 0) this.lerxIntensity = 0;

    // One shared clock for every ribbon shader, so the turbulence churns.
    this.vaporTime += dt;
    const night = weather && Number.isFinite(weather.night) ? clamp(weather.night, 0, 1) : 0;
    for (let w = 0; w < this.ribbons.length; w++) {
      const ribbon = this.ribbons[w];
      const level = ribbon.kind === 'lerx' ? this.lerxIntensity : this.vaporIntensity;
      ribbon.mat.uniforms.uTime.value = this.vaporTime;
      ribbon.mat.uniforms.uTurb.value = level;
      ribbon.mat.uniforms.uNight.value = night;
      this._updateRibbon(ribbon, level, flight, camera, dt, windX, windZ);
    }

    // --- muzzle flash -----------------------------------------------------
    if (this.muzzleTimer > 0) {
      this.muzzleTimer = Math.max(0, this.muzzleTimer - dt);
      this._muzzlePhase += dt;
      if (hasPose(flight)) this._placeMuzzle(flight);
      const flicker = 0.65 + 0.35 * Math.sin(this._muzzlePhase * 140) * Math.sin(this._muzzlePhase * 61);
      const on = this.muzzleTimer > 0;
      this.muzzle.mesh.visible = on;
      this.muzzle.mat.opacity = on ? 0.9 * clamp(flicker, 0.25, 1) : 0;
      const k = on ? 0.85 + 0.3 * flicker : 1;
      this.muzzle.mesh.scale.setScalar(k);
    } else {
      this.muzzle.mesh.visible = false;
      this.muzzle.mat.opacity = 0;
    }

    // Shared clock for every fireball/lobe shader, advanced once per frame so the
    // gas churns continuously instead of restarting with each detonation.
    this.explosionTime += dt;

    // --- explosions -------------------------------------------------------
    let activeExplosions = 0;
    for (let i = 0; i < this.explosions.length; i++) {
      const e = this.explosions[i];
      if (!e.active) continue;

      e.t += dt;
      const t = e.t;

      // Incandescent core: additive white-yellow flash. It grows to ~9x scale and
      // is deliberately kept *inside* the fireball shell (which blooms to 11x),
      // so the white heat reads as the heart of the fire rather than a milky
      // dome swallowing it. Mega-blasts keep it burning for 2.8 s instead of 1.8 s.
      const coreT = t / (e.coreTime || CORE_TIME);
      if (coreT < 1) {
        const ease = 1 - (1 - coreT) * (1 - coreT);
        e.core.visible = true;
        e.core.position.copy(e.pos);
        const cs = e.scale * (0.9 + 8.0 * ease);
        e.core.scale.set(cs, cs, cs);
        // The core is a *flash*, not a second fireball: it burns white-hot for
        // the first few tenths of a second and then drops to a whisper, so it
        // cannot show through the fireball's eroded gaps as a pale sphere.
        e.coreMat.opacity = 0.85 * Math.pow(1 - coreT, 4.2);
      } else {
        e.core.visible = false;
        e.coreMat.opacity = 0;
      }

      // Normal-blended orange-red fireball shell, slightly slower to bloom and
      // the part that stays readable against a bright daytime sky. The shader's
      // uAge drives the temperature ramp (white-hot -> orange -> crimson soot).
      const fbT = t / (e.fireballTime || FIREBALL_TIME);
      e.fireballMat.uniforms.uTime.value = this.explosionTime;
      e.fireballMat.uniforms.uAge.value = clamp(fbT, 0, 1);
      if (fbT < 1) {
        const ease = 1 - Math.pow(1 - fbT, 1.7);
        const rise = fbT < 0.12 ? fbT / 0.12 : 1;
        e.fireball.visible = true;
        e.fireball.position.set(e.pos.x, e.pos.y + (e.mega ? 0.32 : 0.08) * e.scale * ease, e.pos.z);
        const fs = e.scale * (0.7 + 10.3 * ease);
        e.fireball.scale.set(fs, fs, fs);
        // The shader runs its own cooling fade (temperature ramp + thinning
        // density), so the pool only has to keep the burning mass fully solid —
        // any alpha below 1 here reads as a see-through bubble — and then let it
        // collapse into smoke over the last 40% of the fireball's life.
        const burnT = fbT < 0.6 ? 1 : (1 - fbT) / 0.4;
        e.fireballMat.opacity = rise * Math.pow(burnT, 1.3);
      } else {
        e.fireball.visible = false;
        e.fireballMat.opacity = 0;
      }

      // Feature 25: four churning lobes orbit out of the core on independent
      // phases, rise at different rates and squeeze/stretch as they billow.
      // They outlive the main shell slightly and dissolve into the smoke.
      const lobeSpan = e.fireballTime || FIREBALL_TIME;
      for (let L = 0; L < e.lobes.length; L++) {
        const lobe = e.lobes[L];
        const lt = t / (lobeSpan * (0.9 + 0.06 * L));
        lobe.material.uniforms.uTime.value = this.explosionTime;
        lobe.material.uniforms.uAge.value = clamp(lt, 0, 1);
        if (lt < 1) {
          const ease = 1 - Math.pow(1 - lt, 1.6);
          const ang = LOBE_ANGLE[L] + e.lobeSeed + lt * LOBE_SPIN[L];
          const rad = e.scale * LOBE_RADIUS[L] * (0.8 + 5.0 * ease);
          const rise = e.scale * LOBE_RISE[L] * (0.1 + 1.05 * ease);
          // Non-negative churn so a lobe never dips through the blast centre.
          const wobble = (0.5 + 0.5 * Math.sin(lt * 9.0 + LOBE_ANGLE[L])) * e.scale * 0.2;
          const ls = e.scale * LOBE_SIZE[L] * (0.55 + 5.4 * ease);
          const fadeIn = lt < 0.08 ? lt / 0.08 : 1;
          lobe.visible = true;
          lobe.position.set(
            e.pos.x + Math.cos(ang) * rad,
            e.pos.y + rise + wobble,
            e.pos.z + Math.sin(ang) * rad,
          );
          lobe.rotation.set(ang * 0.6, ang, ang * 0.35);
          lobe.scale.set(ls, ls * (0.84 + 0.16 * Math.sin(ang * 1.7)), ls);
          lobe.material.opacity = 0.78 * fadeIn * Math.pow(1 - lt, 0.85);
        } else {
          lobe.visible = false;
          lobe.material.opacity = 0;
        }
      }

      // Ground-hugging condensation shockwave ring: scale * 24 at full expansion,
      // so a BFFG mega-blast (scale 14) throws a ~336 m ring over 2.2 s.
      const ringT = t / (e.ringTime || RING_TIME);
      if (ringT < 1) {
        const ease = 1 - (1 - ringT) * (1 - ringT);
        e.ring.visible = true;
        e.ring.position.set(e.pos.x, e.pos.y + 0.6, e.pos.z);
        const rs = e.scale * (0.5 + 23.5 * ease);
        e.ring.scale.set(rs, rs, rs);
        e.ringMat.opacity = 0.82 * (1 - ringT) * (1 - ringT);
      } else {
        e.ring.visible = false;
        e.ringMat.opacity = 0;
      }

      // Bolling smoke column while the fireball is still hot. A mega-blast
      // keeps boiling for 6.5 s and every puff is a 20-40 m mushroom lobe.
      if (t < e.smokeTime) {
        e.smokeTimer -= dt;
        while (e.smokeTimer <= 0 && t < e.smokeTime) {
          e.smokeTimer += e.mega ? 0.1 : 0.085;
          if (e.mega) {
            this._emitMegaColumnSmoke(e, clamp(t / e.smokeTime, 0, 1));
          } else {
            this._emitExplosionSmoke(e, false, false);
          }
        }
      }

      if (t >= e.duration) {
        e.active = false;
        e.core.visible = false;
        e.ring.visible = false;
        e.fireball.visible = false;
        e.coreMat.opacity = 0;
        e.ringMat.opacity = 0;
        e.fireballMat.opacity = 0;
        for (let L = 0; L < e.lobes.length; L++) {
          e.lobes[L].visible = false;
          e.lobes[L].material.opacity = 0;
        }
        continue;
      }
      activeExplosions++;
    }

    // --- Feature 25: blast flash decay ------------------------------------
    if (this._blastTimer > 0) {
      this._blastTimer = Math.max(0, this._blastTimer - dt);
      this._blastPhase += dt;
      const k = this._blastDuration > 0 ? this._blastTimer / this._blastDuration : 0;
      // Fast initial flash with a slight fire flicker, then a smooth falloff.
      const flicker = 0.84 + 0.16 * Math.sin(this._blastPhase * 44.0 + 1.3);
      this._blastLight.intensity = this._blastTimer > 0
        ? this._blastPeak * k * k * flicker
        : 0;
    } else if (this._blastLight.intensity !== 0) {
      this._blastLight.intensity = 0;
    }
    // A dark light still costs a full light evaluation in every lit shader:
    // hide it instead of leaving it in the loop at intensity 0.
    this._blastLight.visible = this._blastLight.intensity > 0;

    // --- Feature 25: tumbling 3D debris -----------------------------------
    const d = this.debris;
    let activeDebris = 0;
    let instances = 0;
    for (let i = 0; i < DEBRIS_CAPACITY; i++) {
      if (!d.active[i]) continue;

      const life = d.life[i] - dt;
      if (life <= 0) {
        d.active[i] = 0;
        continue;
      }
      d.life[i] = life;

      d.vy[i] += DEBRIS_GRAVITY * dt;
      d.px[i] += d.vx[i] * dt;
      d.py[i] += d.vy[i] * dt;
      d.pz[i] += d.vz[i] * dt;
      d.rx[i] += d.avx[i] * dt;
      d.ry[i] += d.avy[i] * dt;
      d.rz[i] += d.avz[i] * dt;

      const floorY = d.floorY[i];
      if (d.py[i] <= floorY) {
        d.py[i] = floorY;
        if (!d.bounced[i]) {
          // First contact: lively bounce that flips and damps vertical speed.
          d.bounced[i] = 1;
          d.vy[i] = -d.vy[i] * 0.35;
          d.vx[i] *= 0.55;
          d.vz[i] *= 0.55;
          d.avx[i] *= 0.6;
          d.avy[i] *= 0.6;
          d.avz[i] *= 0.6;
        } else {
          // Settled: scrub the remaining slide and spin.
          d.vy[i] = 0;
          d.vx[i] *= 0.86;
          d.vz[i] *= 0.86;
          d.avx[i] *= 0.8;
          d.avy[i] *= 0.8;
          d.avz[i] *= 0.8;
        }
      }

      // Burning shards drag a dark, arcing smoke streamer behind them: while the
      // chunk is young and still fast, it peels off a compact soot puff (ember
      // tinted for the first 0.4 s) every ~45 ms at its exact position, so the
      // trail curves with the ballistic arc instead of following the chunk.
      if (d.smoking[i] && life > d.maxLife[i] - DEBRIS_SMOKE_AGE) {
        const fast = Math.abs(d.vy[i]) > DEBRIS_SMOKE_SPEED
          || d.vx[i] * d.vx[i] + d.vz[i] * d.vz[i]
            > DEBRIS_SMOKE_SPEED * DEBRIS_SMOKE_SPEED;
        if (fast) {
          d.trailTimer[i] -= dt;
          let guard = 0;
          while (d.trailTimer[i] <= 0 && guard < 3) {
            this._emitDebrisSmoke(d, i, d.maxLife[i] - life);
            d.trailTimer[i] += DEBRIS_SMOKE_PERIOD;
            guard++;
          }
          if (d.trailTimer[i] <= 0) d.trailTimer[i] = DEBRIS_SMOKE_PERIOD;
        }
      }

      // Fade the chunk out by shrinking it over its last ~35% of life.
      const fade = clamp(life / (d.maxLife[i] * 0.35), 0, 1);
      _dPos.set(d.px[i], d.py[i], d.pz[i]);
      _dQuat.setFromEuler(_dEuler.set(d.rx[i], d.ry[i], d.rz[i]));
      _dScale.set(d.sx[i] * fade, d.sy[i] * fade, d.sz[i] * fade);
      _dMat.compose(_dPos, _dQuat, _dScale);
      d.mesh.setMatrixAt(instances, _dMat);
      instances++;
      activeDebris++;
    }
    d.mesh.count = instances;
    if (instances > 0) {
      // Upload only the live instances (16 floats per matrix), not the pool.
      d.mesh.instanceMatrix.clearUpdateRanges();
      d.mesh.instanceMatrix.addUpdateRange(0, instances * 16);
      d.mesh.instanceMatrix.needsUpdate = true;
    }
    d.rendered = instances;
    d.activeDebris = activeDebris;
    this.activeDebris = activeDebris;

    // --- burning wreck plumes --------------------------------------------
    let activePlumes = 0;
    for (let i = 0; i < this.plumes.length; i++) {
      const p = this.plumes[i];
      if (!p.active) continue;

      p.remaining -= dt;
      if (p.remaining <= 0) {
        p.active = false;
        continue;
      }

      p.emitTimer -= dt;
      while (p.emitTimer <= 0) {
        p.emitTimer += 1 / p.rate;
        this._emitPlumeSmoke(p);
      }
      activePlumes++;
    }

    // --- particle pools ---------------------------------------------------
    const puffCount = this.puffs.update(dt, windX, windZ);
    const sparkCount = this.sparks.update(dt, windX, windZ);

    this.lastSonicBoom = sonicBoom;
    this.activeParticles = puffCount + sparkCount;
    this.activeExplosions = activeExplosions;
    this.activePlumes = activePlumes;
    this.stats.sonicBoom = sonicBoom;
    this.stats.activeParticles = this.activeParticles;
    this.stats.activeExplosions = activeExplosions;
    this.stats.activePlumes = activePlumes;
    this.stats.activeDebris = activeDebris;

    return {
      sonicBoom,
      activeParticles: this.activeParticles,
      activeExplosions,
      activePlumes,
      activeDebris,
    };
  }

  reset() {
    this.vaporIntensity = 0;
    this.lerxIntensity = 0;
    this.vaporTime = 0;
    for (let i = 0; i < this.ribbons.length; i++) {
      const r = this.ribbons[i];
      r.filled = 0;
      r.hist.fill(0);
      r.ages.fill(0);
      r.widths.fill(0);
      r.mat.uniforms.uTime.value = 0;
      r.mat.uniforms.uTurb.value = 0;
      r.mat.uniforms.uNight.value = 0;
      r.geo.setDrawRange(0, 0);
      r.posAttr.clearUpdateRanges();
      r.alphaAttr.clearUpdateRanges();
      r.mesh.visible = false;
    }

    this.machIntensity = 0;
    this.mach.mesh.visible = false;
    this.mach.mat.uniforms.uOpacity.value = 0;
    this.sonicCooldown = 0;
    this._wasSupersonic = false;
    this.lastSonicBoom = false;

    for (let i = 0; i < this.explosions.length; i++) {
      const e = this.explosions[i];
      e.active = false;
      e.t = 0;
      e.mega = false;
      e.duration = EXPLOSION_DURATION;
      e.coreTime = CORE_TIME;
      e.fireballTime = FIREBALL_TIME;
      e.ringTime = RING_TIME;
      e.smokeTime = SMOKE_COLUMN_TIME;
      e.smokeTimer = 0;
      e.core.visible = false;
      e.ring.visible = false;
      e.fireball.visible = false;
      e.coreMat.opacity = 0;
      e.ringMat.opacity = 0;
      e.fireballMat.opacity = 0;
      e.fireballMat.uniforms.uAge.value = 0;
      e.lobeSeed = 0;
      for (let L = 0; L < e.lobes.length; L++) {
        e.lobes[L].visible = false;
        e.lobes[L].material.opacity = 0;
        e.lobes[L].material.uniforms.uAge.value = 0;
      }
    }
    this._explosionCursor = 0;
    this.explosionTime = 0;

    for (let i = 0; i < this.plumes.length; i++) {
      this.plumes[i].active = false;
      this.plumes[i].remaining = 0;
    }
    this._plumeCursor = 0;

    this.puffs.clear();
    this.sparks.clear();

    this.muzzleTimer = 0;
    this.muzzle.mesh.visible = false;
    this.muzzle.mat.opacity = 0;

    // Feature 25: clear the blast flash and every debris chunk.
    this._blastTimer = 0;
    this._blastPeak = 0;
    this._blastPhase = 0;
    this._blastLight.intensity = 0;
    this._blastLight.visible = false;
    const d = this.debris;
    d.active.fill(0);
    d.bounced.fill(0);
    d.smoking.fill(0);
    d.trailTimer.fill(0);
    d.life.fill(0);
    d.maxLife.fill(0);
    d.cursor = 0;
    d.rendered = 0;
    d.activeDebris = 0;
    d.mesh.count = 0;
    d.mesh.instanceMatrix.clearUpdateRanges();
    d.mesh.instanceMatrix.needsUpdate = true;
    this.activeDebris = 0;

    this.rng = mulberry32(this.seed);
    this.activeParticles = 0;
    this.activeExplosions = 0;
    this.activePlumes = 0;
    this.stats.sonicBoom = false;
    this.stats.activeParticles = 0;
    this.stats.activeExplosions = 0;
    this.stats.activePlumes = 0;
    this.stats.activeDebris = 0;
  }

  // ----------------------------------------------------------------- helpers
  _flightSpeed(flight) {
    if (!flight) return 0;
    if (Number.isFinite(flight.speed)) return Math.max(0, flight.speed);
    if (flight.velocity && typeof flight.velocity.length === 'function') {
      return flight.velocity.length();
    }
    return 0;
  }

  // One condensation vortex trail: advect the captured nodes, resample them onto
  // the dense render mesh with a Catmull-Rom spline, then billboard every
  // segment against the camera so the ribbon never turns edge-on.
  _updateRibbon(ribbon, level, flight, camera, dt, windX, windZ) {
    if (level <= 0.004 || !hasPose(flight)) {
      ribbon.mesh.visible = false;
      ribbon.filled = 0;
      return;
    }

    _head.copy(ribbon.local).applyQuaternion(flight.quaternion).add(flight.position);
    _right.set(1, 0, 0).applyQuaternion(flight.quaternion);
    _up.set(0, 1, 0).applyQuaternion(flight.quaternion);

    const hist = ribbon.hist;
    const ages = ribbon.ages;

    // 1. Advect the trail that already exists: ambient wind, the wingtip's own
    //    downwash and a counter-rotating helical swirl plus multi-frequency curl
    //    turbulence, all growing with node age (age^1.3).
    if (dt > 0) {
      const spin = ribbon.side;
      const seed = ribbon.seed;
      const load = 0.35 + 0.65 * level;
      const filledNow = ribbon.filled;
      for (let i = 0; i < filledNow; i++) {
        const age = ages[i] + dt;
        ages[i] = age;
        const grown = Math.pow(age, 1.3);
        const p = i * 3;

        let dx = windX * dt;
        let dy = -0.65 * dt * level; // gentle wingtip downwash
        let dz = windZ * dt;

        // Helical vortex: tangential velocity in the local X/Y plane. The left
        // tip (side -1) turns the opposite way to the right tip (side +1). The
        // angular rate is deliberately low (a little over a quarter turn over
        // the trail's life) so the helix reads as a corkscrew rather than a
        // high-frequency writhing wobble.
        const sw = age * 4.2 * spin + seed;
        const swirl = 8.5 * grown * load;
        const cs = Math.cos(sw);
        const sn = Math.sin(sw);
        dx += (_right.x * cs + _up.x * sn) * swirl * dt;
        dy += (_right.y * cs + _up.y * sn) * swirl * dt;
        dz += (_right.z * cs + _up.z * sn) * swirl * dt;

        // Two octaves of smooth curl: strongest at the tail, where the vortex
        // has had time to break down into wandering turbulent air.
        const curl = (0.35 + 1.80 * (grown < 1 ? grown : 1)) * load;
        const t1 = age * 3.1 + seed;
        const t2 = age * 7.4 + seed * 2.1;
        dx += (Math.sin(t1) + 0.5 * Math.sin(t2 * 1.7)) * curl * dt;
        dy += (Math.cos(t1 * 1.3) + 0.5 * Math.cos(t2)) * curl * dt;
        dz += (Math.sin(t2) + 0.5 * Math.cos(t1 * 0.8)) * curl * dt;

        hist[p] += dx;
        hist[p + 1] += dy;
        hist[p + 2] += dz;
      }
    }

    // 2. Shift one node aft and pin node 0 exactly on the emitter: the vapour is
    //    born at the wingtip, so the head must never jitter.
    if (ribbon.filled < RIBBON_HISTORY) {
      hist.copyWithin(3, 0, ribbon.filled * 3);
      ages.copyWithin(1, 0, ribbon.filled);
      ribbon.filled++;
    } else {
      hist.copyWithin(3, 0, (RIBBON_HISTORY - 1) * 3);
      ages.copyWithin(1, 0, RIBBON_HISTORY - 1);
    }
    hist[0] = _head.x;
    hist[1] = _head.y;
    hist[2] = _head.z;
    ages[0] = 0;

    const filled = ribbon.filled;
    if (filled < 2) {
      ribbon.geo.setDrawRange(0, 0);
      ribbon.mesh.visible = false;
      return;
    }

    // 3. Resample the captured nodes onto RIBBON_SEGMENTS render segments. The
    //    drawn span grows with the trail so a young trail stays short instead of
    //    being stretched across the whole mesh.
    const positions = ribbon.positions;
    const alphas = ribbon.alphas;
    const widths = ribbon.widths;
    const cam = camera && camera.position ? camera.position : null;
    const last = filled - 1;
    const drawSegs = Math.max(
      1,
      Math.round((RIBBON_SEGMENTS - 1) * (last / (RIBBON_HISTORY - 1))),
    );

    for (let s = 0; s <= drawSegs; s++) {
      const t = (s / drawSegs) * last;
      const i0 = Math.min(last, Math.floor(t));
      const i1 = Math.min(last, i0 + 1);
      const f = t - i0;
      const iA = i0 > 0 ? i0 - 1 : i0;
      const iB = i1 < last ? i1 + 1 : i1;
      const a0 = iA * 3;
      const a1 = i0 * 3;
      const a2 = i1 * 3;
      const a3 = iB * 3;

      const f2 = f * f;
      const f3 = f2 * f;
      // Uniform Catmull-Rom: the captured nodes are one simulated frame apart.
      const k0 = -0.5 * f3 + f2 - 0.5 * f;
      const k1 = 1.5 * f3 - 2.5 * f2 + 1;
      const k2 = -1.5 * f3 + 2 * f2 + 0.5 * f;
      const k3 = 0.5 * f3 - 0.5 * f2;

      const px = hist[a0] * k0 + hist[a1] * k1 + hist[a2] * k2 + hist[a3] * k3;
      const py = hist[a0 + 1] * k0 + hist[a1 + 1] * k1 + hist[a2 + 1] * k2 + hist[a3 + 1] * k3;
      const pz = hist[a0 + 2] * k0 + hist[a1 + 2] * k1 + hist[a2 + 2] * k2 + hist[a3 + 2] * k3;

      // Analytic spline tangent, so the billboard frame follows the curve.
      const d0 = -0.5 + 2 * f - 1.5 * f2;
      const d1 = -5 * f + 4.5 * f2;
      const d2 = 0.5 + 4 * f - 4.5 * f2;
      const d3 = -f + 1.5 * f2;
      _tan.set(
        hist[a0] * d0 + hist[a1] * d1 + hist[a2] * d2 + hist[a3] * d3,
        hist[a0 + 1] * d0 + hist[a1 + 1] * d1 + hist[a2 + 1] * d2 + hist[a3 + 1] * d3,
        hist[a0 + 2] * d0 + hist[a1 + 2] * d1 + hist[a2 + 2] * d2 + hist[a3 + 2] * d3,
      );

      // Segment axis: perpendicular to both the view ray and the trail, so the
      // ribbon presents its face from chase, cockpit, wing, orbit and flyby.
      if (cam) {
        _toCam.set(cam.x - px, cam.y - py, cam.z - pz);
        _side.crossVectors(_tan, _toCam);
      } else {
        _side.copy(_right);
      }
      if (_side.lengthSq() < 1e-9) _side.copy(_right);
      _side.normalize();

      // Tight glassy core at the emitter, billowing plume at the tail.
      const wNorm = s / drawSegs;
      const spread = Math.pow(wNorm, 1.25);
      const half = (RIBBON_W_TIP + (RIBBON_W_TAIL - RIBBON_W_TIP) * spread)
        * (0.78 + 0.22 * level)
        * ribbon.widthScale;
      widths[s] = half;

      const p = s * 6;
      positions[p] = px + _side.x * half;
      positions[p + 1] = py + _side.y * half;
      positions[p + 2] = pz + _side.z * half;
      positions[p + 3] = px - _side.x * half;
      positions[p + 4] = py - _side.y * half;
      positions[p + 5] = pz - _side.z * half;

      // Alpha thins toward the tail but never snaps to zero exactly where the
      // plume is widest: the shader's lacy noise finishes the dissipation.
      const a = level * RIBBON_ALPHA * ribbon.alphaScale
        * (0.10 + 0.90 * Math.pow(1 - wNorm, 1.15));
      alphas[s * 2] = a;
      alphas[s * 2 + 1] = a;
    }

    const drawVerts = (drawSegs + 1) * 2;
    ribbon.geo.setDrawRange(0, drawSegs * 6);
    ribbon.posAttr.clearUpdateRanges();
    ribbon.posAttr.addUpdateRange(0, drawVerts * 3);
    ribbon.posAttr.needsUpdate = true;
    ribbon.alphaAttr.clearUpdateRanges();
    ribbon.alphaAttr.addUpdateRange(0, drawVerts);
    ribbon.alphaAttr.needsUpdate = true;
    ribbon.mesh.visible = true;
  }

  _placeMuzzle(flight) {
    _local.copy(GUN_PORT).applyQuaternion(flight.quaternion).add(flight.position);
    this.muzzle.mesh.position.copy(_local);
    this.muzzle.mesh.quaternion.copy(flight.quaternion);
  }

  // Feature 25: re-pulse the shared blast light. Intensity and range scale
  // with the ordnance; the decay window stretches 0.7 s -> 1.4 s.
  _fireBlastFlash(pos, scale) {
    const light = this._blastLight;
    if (!light) return;
    light.position.set(pos.x, pos.y + Math.max(4, scale * 2), pos.z);
    light.distance = clamp(scale * 45, 90, 900);
    this._blastPeak = clamp(scale * 18, 12, 260);
    this._blastDuration = clamp(0.7 + scale * 0.05, 0.7, 1.4);
    this._blastTimer = this._blastDuration;
    this._blastPhase = 0;
    light.intensity = this._blastPeak;
    light.visible = light.intensity > 0;
  }

  // Ground plane for a chunk: real terrain when it lies below the blast,
  // otherwise the blast point itself (airburst over water/ridge).
  _groundBelow(pos) {
    const ground = terrainHeight(pos.x, pos.z);
    if (!Number.isFinite(ground) || ground > pos.y) return pos.y;
    return ground;
  }

  _allocDebris() {
    const d = this.debris;
    if (!d) return -1;
    for (let n = 0; n < DEBRIS_CAPACITY; n++) {
      const i = (d.cursor + n) % DEBRIS_CAPACITY;
      if (!d.active[i]) {
        d.cursor = (i + 1) % DEBRIS_CAPACITY;
        return i;
      }
    }
    // Saturated: recycle the oldest slot rather than growing the pool.
    const i = d.cursor;
    d.cursor = (i + 1) % DEBRIS_CAPACITY;
    return i;
  }

  // Feature 25: ballistic debris burst. 4 chips for cannon hits, 12 shrapnel
  // chunks for an AIM-9 kill, 22 rubble blocks for a Mk-82, 44 massive slabs
  // for the BFFG mega-blast — all written into the fixed 160-chunk pool.
  _spawnDebris(pos, scale) {
    const d = this.debris;
    if (!d) return 0;
    const mega = scale >= 10;
    const count = mega ? 44 : scale >= 3.5 ? 22 : scale >= 1.5 ? 12 : 4;
    const floorY = this._groundBelow(pos);
    const sizeK = 0.75 + Math.min(scale, 14) * 0.2;
    const speedK = Math.sqrt(scale);
    let launched = 0;

    for (let n = 0; n < count; n++) {
      const i = this._allocDebris();
      if (i < 0) break;

      const ang = this.rng() * TAU;
      const outward = (5 + this.rng() * 17) * speedK * (mega ? 1.2 : 1);
      const spread = 0.45 + this.rng() * 0.55;
      const base = (0.35 + this.rng() * 0.85) * sizeK;

      d.active[i] = 1;
      d.bounced[i] = 0;
      // A recycled slot must never inherit the previous chunk's ember trail.
      d.smoking[i] = 0;
      d.trailTimer[i] = 0;
      d.px[i] = pos.x + Math.cos(ang) * 0.8 * scale;
      d.py[i] = pos.y + 0.4 * scale + this.rng() * scale;
      d.pz[i] = pos.z + Math.sin(ang) * 0.8 * scale;
      d.vx[i] = Math.cos(ang) * outward * spread;
      d.vy[i] = (6 + this.rng() * 14) * speedK * (mega ? 1.35 : 1) + 4;
      d.vz[i] = Math.sin(ang) * outward * spread;
      d.rx[i] = this.rng() * TAU;
      d.ry[i] = this.rng() * TAU;
      d.rz[i] = this.rng() * TAU;
      d.avx[i] = (this.rng() - 0.5) * 11;
      d.avy[i] = (this.rng() - 0.5) * 11;
      d.avz[i] = (this.rng() - 0.5) * 11;
      d.sx[i] = base * (0.75 + this.rng() * 0.6);
      d.sy[i] = base * (0.5 + this.rng() * 0.5);
      d.sz[i] = base * (0.75 + this.rng() * 0.6);
      const life = mega ? 7 + this.rng() * 3 : 4 + this.rng() * 3;
      d.life[i] = life;
      d.maxLife[i] = life;
      d.floorY[i] = floorY;
      _debrisBatch[launched] = i;
      launched++;
    }

    // The fastest third of the burst is a burning wing/fuselage shard dragging
    // an arcing soot streamer behind it (see the debris update loop).
    this._markSmokingDebris(launched);
    return launched;
  }

  // Pick the fastest ~35% of a fresh burst and flag them as burning shards.
  // A plain O(n^2) sweep over the preallocated scratch list: n is at most 44
  // and it allocates nothing, which keeps the spawn path garbage-free.
  _markSmokingDebris(count) {
    const d = this.debris;
    const want = Math.max(1, Math.round(count * DEBRIS_SMOKING_FRACTION));
    for (let m = 0; m < want; m++) {
      let best = -1;
      let bestSpd = -1;
      for (let k = 0; k < count; k++) {
        const i = _debrisBatch[k];
        if (d.smoking[i]) continue;
        const spd = d.vx[i] * d.vx[i] + d.vy[i] * d.vy[i] + d.vz[i] * d.vz[i];
        if (spd > bestSpd) {
          bestSpd = spd;
          best = i;
        }
      }
      if (best < 0) break;
      d.smoking[best] = 1;
      // Stagger the first puff so the streamers do not pulse in lockstep.
      d.trailTimer[best] = this.rng() * DEBRIS_SMOKE_PERIOD;
    }
  }

  // One compact charcoal-brown puff peeling off a burning shard. Almost zero
  // inherited velocity, so the trail hangs where the chunk has been instead of
  // riding along with it; the first 0.4 s carry an ember tint.
  _emitDebrisSmoke(d, i, age) {
    const ember = age < 0.4 ? 1 - age / 0.4 : 0;
    const shade = 0.075 + this.rng() * 0.045;
    this.puffs.spawn(
      d.px[i], d.py[i], d.pz[i],
      d.vx[i] * 0.05 + (this.rng() - 0.5) * 0.6,
      d.vy[i] * 0.04 + 0.4 + this.rng() * 0.6,
      d.vz[i] * 0.05 + (this.rng() - 0.5) * 0.6,
      0.55 + this.rng() * 0.55,
      0.8 + this.rng() * 0.8 + ember * 0.5,
      shade + 0.62 * ember,
      shade * 0.95 + 0.24 * ember,
      shade * 0.86 + 0.04 * ember,
      0.78, 0.9 + 0.6 * ember, 0.85, 2.6,
    );
  }

  // Feature 24: the BFFG detonation burst is a three-way mix — fiery
  // orange-gold fireball lobes, cyan-white plasma flash and dense charcoal
  // mushroom smoke — all at mega scale.
  _emitMegaBurstPuff(e, i) {
    const s = Math.min(e.scale, 12);
    const k = s / 12;
    const ang = this.rng() * Math.PI * 2;
    const rad = this.rng() * 3.2 * s * 0.5;
    const x = e.pos.x + Math.cos(ang) * rad;
    const z = e.pos.z + Math.sin(ang) * rad;
    const y = e.pos.y + 0.5 * s + this.rng() * 2.2 * s;
    const out = Math.cos(ang) * (6 + this.rng() * 10) * k;
    const outZ = Math.sin(ang) * (6 + this.rng() * 10) * k;

    if (i < 10) {
      // Liquid-fire lobes: bright orange-gold, blooming outward.
      const f = 0.88 + this.rng() * 0.12;
      this.puffs.spawn(
        x, y, z, out, 8 + this.rng() * 9, outZ,
        1.6 + this.rng() * 1.4,
        (5 + this.rng() * 5) * k,
        1.0 * f, (0.52 + this.rng() * 0.14) * f, 0.06 * f,
        0.85, 2.4, 0.6, 2.8,
      );
    } else if (i < 15) {
      // Cyan-white plasma flash: the warhead's thermobaric core igniting.
      const f = 0.9 + this.rng() * 0.1;
      this.puffs.spawn(
        x, y, z, out * 1.6, 14 + this.rng() * 10, outZ * 1.6,
        0.7 + this.rng() * 0.6,
        (4 + this.rng() * 5) * k,
        0.62 * f, 0.95 * f, 1.0,
        0.9, 5.5, 0.5, 3.4,
      );
    } else {
      // Dense charcoal mushroom smoke, already climbing hard at t = 0.
      const shade = 0.10 + this.rng() * 0.08;
      this.puffs.spawn(
        x, y, z, out, 10 + this.rng() * 12, outZ,
        4.5 + this.rng() * 3.0,
        (7 + this.rng() * 6) * k,
        shade, shade * 0.97, shade * 0.92,
        0.8, 4.2, 0.7, 2.4,
      );
    }
  }

  // The stem-and-cap column of a lingering mega mushroom: emissions start
  // higher and rise harder as the cloud billows up.
  _emitMegaColumnSmoke(e, column) {
    const s = Math.min(e.scale, 12);
    const k = s / 12;
    const ang = this.rng() * Math.PI * 2;
    const spread = (2.5 + 7.5 * column) * s * 0.5;
    const rad = this.rng() * spread;
    const shade = 0.09 + this.rng() * 0.08;
    this.puffs.spawn(
      e.pos.x + Math.cos(ang) * rad,
      e.pos.y + (1.2 + 9.5 * column) * s * 0.5 + this.rng() * 2.0 * s * 0.5,
      e.pos.z + Math.sin(ang) * rad,
      Math.cos(ang) * (2 + this.rng() * 3),
      4.0 + this.rng() * 4.0 + 4.0 * column,
      Math.sin(ang) * (2 + this.rng() * 3),
      4.0 + this.rng() * 3.0,
      (6 + this.rng() * 6) * k,
      shade, shade * 0.97, shade * 0.92,
      0.72, 3.0 + 2.0 * column, 0.7, 2.2,
    );
  }

  _emitExplosionSmoke(e, initial = false, hot = false) {
    const s = Math.min(e.scale, 4);
    const spread = (initial ? 1.6 : 2.6) * s;
    const ang = this.rng() * Math.PI * 2;
    const rad = this.rng() * spread;
    const life = 3.0 + this.rng() * 2.5;

    if (hot) {
      // Ember-lit puff at the fireball surface: burning fuel, not soot.
      const k = 0.82 + this.rng() * 0.18;
      this.puffs.spawn(
        e.pos.x + Math.cos(ang) * rad * 0.55,
        e.pos.y + 0.7 * s + this.rng() * 1.2 * s,
        e.pos.z + Math.sin(ang) * rad * 0.55,
        Math.cos(ang) * (1.5 + this.rng() * 2.2),
        3.0 + this.rng() * 3.0,
        Math.sin(ang) * (1.5 + this.rng() * 2.2),
        life * 0.62,
        (2.2 + this.rng() * 2.4) * Math.max(0.6, s),
        1.0 * k, 0.38 * k, 0.08 * k,
        0.7, 3.4, 0.7, 2.2,
      );
      return;
    }

    // Charcoal puffs. Emissions later in the column start higher and rise
    // harder, which builds the classic stem-and-cap mushroom.
    const column = initial ? 0 : clamp(e.t / SMOKE_COLUMN_TIME, 0, 1);
    const base = initial ? 0.8 * s : (1.2 + 5.5 * column) * s;
    const shade = 0.09 + this.rng() * 0.07;
    this.puffs.spawn(
      e.pos.x + Math.cos(ang) * rad,
      e.pos.y + base + this.rng() * 1.6 * s,
      e.pos.z + Math.sin(ang) * rad,
      Math.cos(ang) * (1 + this.rng() * 1.5),
      2.2 + this.rng() * 2.4 + (initial ? 0 : 2.0 * column),
      Math.sin(ang) * (1 + this.rng() * 1.5),
      life,
      (2.0 + this.rng() * 2.2) * Math.max(0.6, s),
      shade, shade * 0.97, shade * 0.92,
      0.62, 2.4 + 1.6 * column, 0.7, 2.1,
    );
  }

  _emitPlumeSmoke(p) {
    const scale = clamp(p.duration / 60, 0.35, 1.4);
    const ang = this.rng() * Math.PI * 2;
    const rad = this.rng() * 2.2 * scale;
    const shade = 0.07 + this.rng() * 0.07;
    this.puffs.spawn(
      p.pos.x + Math.cos(ang) * rad,
      p.pos.y + this.rng() * 2.5 * scale,
      p.pos.z + Math.sin(ang) * rad,
      Math.cos(ang) * (0.4 + this.rng() * 1.1),
      3.0 + this.rng() * 3.2,
      Math.sin(ang) * (0.4 + this.rng() * 1.1),
      6.5 + this.rng() * 4.5,
      (3.5 + this.rng() * 3.0) * scale,
      shade, shade * 0.96, shade * 0.94,
      0.6, 1.8, 0.8, 2.0,
    );
  }
}