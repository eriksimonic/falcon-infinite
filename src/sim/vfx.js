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
const MAX_PLUMES = 16; // a single Mk-82 blast can claim 4 (impact + 3 rubble columns)
const PUFF_CAPACITY = 1400;
const SPARK_CAPACITY = 420;
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
    this.stats = {
      sonicBoom: false,
      activeParticles: 0,
      activeExplosions: 0,
      activePlumes: 0,
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

      this.explosions.push({
        active: false,
        t: 0,
        duration: EXPLOSION_DURATION,
        scale: 1,
        smokeTimer: 0,
        pos: new THREE.Vector3(),
        core,
        coreMat,
        ring,
        ringMat,
        fireball,
        fireballMat,
      });
    }
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
    slot.duration = EXPLOSION_DURATION;
    slot.scale = s;
    slot.smokeTimer = 0;
    slot.pos.set(pos.x || 0, pos.y || 0, pos.z || 0);
    slot.core.visible = true;
    slot.ring.visible = true;
    slot.fireball.visible = true;

    // 20–28 gravity-arcing hot embers and debris.
    const sparks = SPARK_MIN + Math.floor(this.rng() * (SPARK_MAX - SPARK_MIN + 1));
    for (let i = 0; i < sparks; i++) {
      const theta = this.rng() * Math.PI * 2;
      const phi = this.rng() * 2 - 1;
      const rho = Math.sqrt(Math.max(0, 1 - phi * phi));
      const spd = (8 + this.rng() * 28) * Math.sqrt(s);
      this.sparks.spawn(
        slot.pos.x, slot.pos.y + 0.4 * s, slot.pos.z,
        Math.cos(theta) * rho * spd,
        Math.abs(phi) * spd * 0.8 + 5,
        Math.sin(theta) * rho * spd,
        0.55 + this.rng() * 0.85,
        (0.16 + this.rng() * 0.2) * Math.min(s, 3),
        1.0, 0.55 + this.rng() * 0.3, 0.12,
        0.95, 0, 0.25, -0.55,
      );
    }

    // Dense detonation burst; the rest of the column is emitted while the
    // fireball is still hot (see update()).
    for (let i = 0; i < INITIAL_SMOKE_PUFFS; i++) {
      this._emitExplosionSmoke(slot, true, i >= INITIAL_SMOKE_PUFFS - HOT_SMOKE_PUFFS);
    }

    return slot;
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
      const coreT = t / CORE_TIME;
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
      const fbT = t / FIREBALL_TIME;
      if (fbT < 1) {
        const ease = 1 - Math.pow(1 - fbT, 1.7);
        const rise = fbT < 0.12 ? fbT / 0.12 : 1;
        e.fireball.visible = true;
        e.fireball.position.set(e.pos.x, e.pos.y + 0.08 * e.scale * ease, e.pos.z);
        const fs = e.scale * (0.7 + 10.3 * ease);
        e.fireball.scale.set(fs, fs, fs);
        e.fireballMat.opacity = 0.92 * rise * Math.pow(1 - fbT, 1.25);
      } else {
        e.fireball.visible = false;
        e.fireballMat.opacity = 0;
      }

      // Ground-hugging condensation shockwave ring.
      const ringT = t / RING_TIME;
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

      // Bolling smoke column while the fireball is still hot.
      if (t < SMOKE_COLUMN_TIME) {
        e.smokeTimer -= dt;
        while (e.smokeTimer <= 0 && t < SMOKE_COLUMN_TIME) {
          e.smokeTimer += 0.085;
          this._emitExplosionSmoke(e, false, false);
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
        continue;
      }
      activeExplosions++;
    }

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

    return {
      sonicBoom,
      activeParticles: this.activeParticles,
      activeExplosions,
      activePlumes,
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
      e.core.visible = false;
      e.ring.visible = false;
      e.fireball.visible = false;
      e.coreMat.opacity = 0;
      e.ringMat.opacity = 0;
      e.fireballMat.opacity = 0;
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

    this.rng = mulberry32(this.seed);
    this.activeParticles = 0;
    this.activeExplosions = 0;
    this.activePlumes = 0;
    this.stats.sonicBoom = false;
    this.stats.activeParticles = 0;
    this.stats.activeExplosions = 0;
    this.stats.activePlumes = 0;
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