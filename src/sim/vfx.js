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
const RIBBON_SEGMENTS = 36;
const RIBBON_ALPHA = 0.55;
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
const GUN_PORT = new THREE.Vector3(-0.75, 0.25, -2.5);
const WINGTIP_LOCAL = [
  new THREE.Vector3(4.95, 0.02, 2.25),
  new THREE.Vector3(-4.95, 0.02, 2.25),
];

const _head = new THREE.Vector3();
const _right = new THREE.Vector3();
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
    this.cursor = (i + 1) % this.capacity;
    return i;
  }

  update(dt, windX, windZ) {
    if (this.count <= 0) {
      this.points.visible = false;
      return 0;
    }
    const drag = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.capacity; i++) {
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

    this.posAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
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
    this.points.visible = false;
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
    this.ribbons = [];
    this._buildRibbons();

    // --- transonic Mach cone ---------------------------------------------
    this.machIntensity = 0;
    this.sonicCooldown = 0;
    this._wasSupersonic = false;
    this.lastSonicBoom = false;
    this.mach = this._buildMachCone();

    // --- explosion pool ---------------------------------------------------
    this._coreGeo = new THREE.SphereGeometry(1, 16, 12);
    this._ringGeo = new THREE.RingGeometry(0.82, 1, 48, 1);
    this._ringGeo.rotateX(-Math.PI / 2);
    this.explosions = [];
    this._explosionCursor = 0;
    this._buildExplosions();

    // --- Feature 25: dynamic blast flash --------------------------------
    // A single shared warm-orange point light, preallocated and simply
    // repositioned/re-pulsed on detonation, so nearby skyscrapers, streets
    // and terrain catch the muzzle of the fireball.
    this._blastLight = new THREE.PointLight(0xff9b42, 0, 450, 1.5);
    this._blastLight.position.set(0, 0, 0);
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
    for (let w = 0; w < 2; w++) {
      const positions = new Float32Array(RIBBON_SEGMENTS * 2 * 3);
      const alphas = new Float32Array(RIBBON_SEGMENTS * 2);
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
      geo.setAttribute('position', posAttr);
      geo.setAttribute('aAlpha', alphaAttr);
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      geo.setDrawRange(0, 0);

      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */`
          attribute float aAlpha;
          varying float vA;
          void main() {
            vA = aAlpha;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */`
          precision mediump float;
          uniform vec3 uColor;
          varying float vA;
          void main() {
            if (vA < 0.003) discard;
            gl_FragColor = vec4(uColor, vA);
          }
        `,
        uniforms: {
          uColor: { value: new THREE.Color(0xf3f8ff) },
        },
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      mesh.visible = false;
      this.group.add(mesh);

      this.ribbons.push({
        mesh,
        geo,
        posAttr,
        alphaAttr,
        positions,
        alphas,
        hist: new Float32Array(RIBBON_SEGMENTS * 3),
        filled: 0,
        local: WINGTIP_LOCAL[w],
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
      // sky; this one is normal-blended so the blast reads in daylight too.
      const fireballMat = new THREE.MeshBasicMaterial({
        color: 0xff5a18,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.NormalBlending,
      });
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
        const lobeMat = new THREE.MeshBasicMaterial({
          color: LOBE_COLORS[L],
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.NormalBlending,
        });
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
    for (let L = 0; L < slot.lobes.length; L++) {
      const lobe = slot.lobes[L];
      lobe.visible = true;
      lobe.position.copy(slot.pos);
      lobe.scale.setScalar(0.001);
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
    if (flight) {
      const g = Number.isFinite(flight.gForce) ? Math.abs(flight.gForce) : 1;
      const aoa = Number.isFinite(flight.aoa) ? Math.abs(flight.aoa) : 0;
      const humid = state
        ? clamp(
          (state.coverage || 0) * 0.5 + (state.density || 0) * 0.3 + (state.rain || 0) * 0.45,
          0, 1,
        )
        : 0.15;
      const condition = !flight.onGround
        && speed > 90
        && (Math.abs(g) > 3.4 || Math.abs(aoa) > 0.17);
      if (condition) {
        const gPull = smoothstep(3.4, 6.0, Math.abs(g));
        const aoaPull = smoothstep(0.17, 0.30, Math.abs(aoa));
        const severity = Math.max(gPull, aoaPull);
        vaporTarget = clamp((0.55 + 0.45 * severity) * (0.82 + humid * 0.35), 0, 1);
      }
    }
    const vaporRate = vaporTarget > this.vaporIntensity ? 6.0 : 2.4;
    this.vaporIntensity += (vaporTarget - this.vaporIntensity)
      * (1 - Math.exp(-vaporRate * dt));
    if (this.vaporIntensity < 0.002 && vaporTarget === 0) this.vaporIntensity = 0;

    for (let w = 0; w < this.ribbons.length; w++) {
      this._updateRibbon(this.ribbons[w], this.vaporIntensity, flight, camera);
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

    // --- explosions -------------------------------------------------------
    let activeExplosions = 0;
    for (let i = 0; i < this.explosions.length; i++) {
      const e = this.explosions[i];
      if (!e.active) continue;

      e.t += dt;
      const t = e.t;

      // Incandescent core: additive white-yellow, expands to ~11x scale.
      // Mega-blasts keep it burning for 2.8 s instead of 1.8 s.
      const coreT = t / (e.coreTime || CORE_TIME);
      if (coreT < 1) {
        const ease = 1 - (1 - coreT) * (1 - coreT);
        e.core.visible = true;
        e.core.position.copy(e.pos);
        const cs = e.scale * (0.9 + 10.1 * ease);
        e.core.scale.set(cs, cs, cs);
        e.coreMat.opacity = 0.95 * Math.pow(1 - coreT, 1.55);
      } else {
        e.core.visible = false;
        e.coreMat.opacity = 0;
      }

      // Normal-blended orange-red fireball shell, slightly slower to bloom and
      // the part that stays readable against a bright daytime sky.
      const fbT = t / (e.fireballTime || FIREBALL_TIME);
      if (fbT < 1) {
        const ease = 1 - Math.pow(1 - fbT, 1.7);
        const rise = fbT < 0.12 ? fbT / 0.12 : 1;
        e.fireball.visible = true;
        e.fireball.position.set(e.pos.x, e.pos.y + (e.mega ? 0.32 : 0.08) * e.scale * ease, e.pos.z);
        const fs = e.scale * (0.7 + 10.3 * ease);
        e.fireball.scale.set(fs, fs, fs);
        e.fireballMat.opacity = 0.92 * rise * Math.pow(1 - fbT, 1.25);
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
          lobe.material.opacity = 0.6 * fadeIn * Math.pow(1 - lt, 1.15);
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
    if (instances > 0 || d.rendered > 0) d.mesh.instanceMatrix.needsUpdate = true;
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
    for (let i = 0; i < this.ribbons.length; i++) {
      const r = this.ribbons[i];
      r.filled = 0;
      r.hist.fill(0);
      r.geo.setDrawRange(0, 0);
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
      e.lobeSeed = 0;
      for (let L = 0; L < e.lobes.length; L++) {
        e.lobes[L].visible = false;
        e.lobes[L].material.opacity = 0;
      }
    }
    this._explosionCursor = 0;

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
    const d = this.debris;
    d.active.fill(0);
    d.bounced.fill(0);
    d.life.fill(0);
    d.maxLife.fill(0);
    d.cursor = 0;
    d.rendered = 0;
    d.activeDebris = 0;
    d.mesh.count = 0;
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

  _updateRibbon(ribbon, level, flight, camera) {
    if (level <= 0.004 || !hasPose(flight)) {
      ribbon.mesh.visible = false;
      ribbon.filled = 0;
      return;
    }

    _head.copy(ribbon.local).applyQuaternion(flight.quaternion).add(flight.position);
    const hist = ribbon.hist;
    if (ribbon.filled < RIBBON_SEGMENTS) {
      hist.copyWithin(3, 0, ribbon.filled * 3);
      ribbon.filled++;
    } else {
      hist.copyWithin(3, 0, (RIBBON_SEGMENTS - 1) * 3);
    }
    hist[0] = _head.x;
    hist[1] = _head.y;
    hist[2] = _head.z;

    const filled = ribbon.filled;
    _right.set(1, 0, 0).applyQuaternion(flight.quaternion);
    const cam = camera && camera.position ? camera.position : null;

    const positions = ribbon.positions;
    const alphas = ribbon.alphas;
    for (let i = 0; i < filled; i++) {
      const i0 = Math.max(0, i - 1) * 3;
      const i1 = Math.min(filled - 1, i + 1) * 3;
      _tan.set(hist[i0] - hist[i1], hist[i0 + 1] - hist[i1 + 1], hist[i0 + 2] - hist[i1 + 2]);

      if (cam) {
        _toCam.set(cam.x - hist[i * 3], cam.y - hist[i * 3 + 1], cam.z - hist[i * 3 + 2]);
        _side.crossVectors(_tan, _toCam);
      } else {
        _side.copy(_right);
      }
      if (_side.lengthSq() < 1e-9) _side.copy(_right);
      _side.normalize();

      const u = filled > 1 ? i / (RIBBON_SEGMENTS - 1) : 0;
      const width = 0.30 * (1 - u * 0.65) * (0.55 + 0.45 * level);
      const p = i * 6;
      positions[p] = hist[i * 3] + _side.x * width;
      positions[p + 1] = hist[i * 3 + 1] + _side.y * width;
      positions[p + 2] = hist[i * 3 + 2] + _side.z * width;
      positions[p + 3] = hist[i * 3] - _side.x * width;
      positions[p + 4] = hist[i * 3 + 1] - _side.y * width;
      positions[p + 5] = hist[i * 3 + 2] - _side.z * width;

      const a = level * RIBBON_ALPHA * Math.pow(1 - u, 1.7);
      alphas[i * 2] = a;
      alphas[i * 2 + 1] = a;
    }

    ribbon.geo.setDrawRange(0, Math.max(0, (filled - 1) * 6));
    ribbon.posAttr.needsUpdate = true;
    ribbon.alphaAttr.needsUpdate = true;
    ribbon.mesh.visible = filled > 1;
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
      launched++;
    }
    return launched;
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