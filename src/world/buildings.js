// Instanced buildings and roads for every nearby settlement.
import * as THREE from 'three';
import { settlementsNear } from './settlements.js';
import { terrainHeight } from './terrain.js';
import { hash2, clamp } from './noise.js';
import { CONFIG } from '../config.js';

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

function makeBuildingMaterial() {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
        uSunColor: { value: new THREE.Color(0xfff2d8) },
        uAmbient: { value: new THREE.Color(0x334455) },
        uNight: { value: 0 },
      },
    ]),
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec3 vCol;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(instanceMatrix) * normal);
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(0.7);
        #endif
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunColor, uAmbient;
      uniform float uNight;
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec3 vCol;
      #include <common>
      #include <fog_pars_fragment>

      float h21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        vec3 n = normalize(vN);
        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = max(dot(n, uSunDir) * 0.5 + 0.5, 0.0);
        vec3 col = vCol * (uAmbient + uSunColor * (ndl * 0.9 + wrap * 0.14)) + vCol * 0.06;

        float vertical = 1.0 - smoothstep(0.55, 0.85, abs(n.y));
        vec2 wuv = vec2((vWorld.x + vWorld.z) * 0.30, vWorld.y / 3.4);
        vec2 g = fract(wuv);
        float win = step(0.22, g.x) * step(g.x, 0.80) * step(0.30, g.y) * step(g.y, 0.82);
        vec2 cell = floor(wuv);
        float rnd = h21(cell + floor(vCol.xy * 97.0));
        float lit = step(0.55, rnd) * win * vertical;

        vec3 warm = vec3(1.0, 0.66, 0.30);
        col += warm * lit * uNight * 2.6;
        col += vec3(0.10, 0.13, 0.16) * win * vertical * (1.0 - uNight) * 0.7;

        // roofs get a dusty tone
        float roof = smoothstep(0.65, 0.95, abs(n.y));
        col = mix(col, col * vec3(0.72, 0.70, 0.66), roof);

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }
    `,
  });
}

function makeRoadMaterial() {
  return new THREE.MeshLambertMaterial({
    color: 0x30322f,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

// Mottled urban ground patch with a soft radial edge.
function makeUrbanTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#5a5d56';
  ctx.fillRect(0, 0, S, S);
  const rng = (() => { let a = 987654321; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; })();
  for (let i = 0; i < 2600; i++) {
    const v = 62 + Math.floor(rng() * 44);
    ctx.fillStyle = `rgba(${v},${v + 2},${v - 2},${0.1 + rng() * 0.35})`;
    ctx.fillRect(rng() * S, rng() * S, 2 + rng() * 14, 2 + rng() * 10);
  }
  // fade the edge so the patch blends into terrain
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.18, S / 2, S / 2, S * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class BuildingSystem {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    this.material = makeBuildingMaterial();
    this.mesh = new THREE.InstancedMesh(geo, this.material, preset.buildingLimit);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = 'buildings';
    scene.add(this.mesh);

    const roadGeo = new THREE.PlaneGeometry(1, 1);
    roadGeo.rotateX(-Math.PI / 2);
    this.roadMaterial = makeRoadMaterial();
    this.roadMesh = new THREE.InstancedMesh(roadGeo, this.roadMaterial, 9000);
    this.roadMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.roadMesh.frustumCulled = false;
    this.roadMesh.count = 0;
    this.roadMesh.name = 'roads';
    scene.add(this.roadMesh);

    const bulbGeo = new THREE.SphereGeometry(0.9, 5, 4);
    this.lightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc46b, toneMapped: false, transparent: true, opacity: 0,
      depthWrite: false,
    });
    this.lightMesh = new THREE.InstancedMesh(bulbGeo, this.lightMaterial, 5000);
    this.lightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lightMesh.frustumCulled = false;
    this.lightMesh.count = 0;
    this.lightMesh.name = 'streetlights';
    this.lightMesh.visible = false;
    scene.add(this.lightMesh);

    this.groundMaterial = new THREE.MeshLambertMaterial({
      map: makeUrbanTexture(),
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.grounds = new Map();
    this._groundUse = new Set();

    this._lastX = Infinity;
    this._lastZ = Infinity;
    this._lastAlt = Infinity;
    this._needsRebuild = true;
    this._colorInit = false;
    this.stats = { buildings: 0, roads: 0, settlements: 0, lights: 0 };
  }

  update(dt, camera, sky) {
    this.material.uniforms.uSunDir.value.copy(sky.sunDir);
    this.material.uniforms.uSunColor.value.copy(sky.sunColor);
    this.material.uniforms.uAmbient.value.copy(sky.skyColor).multiplyScalar(0.55).addScalar(0.12);
    this.material.uniforms.uNight.value = sky.night;
    this.lightMaterial.opacity = clamp(sky.night * 1.3, 0, 0.95);
    this.lightMesh.visible = sky.night > 0.12 && this.lightMesh.count > 0;

    const dx = camera.position.x - this._lastX;
    const dz = camera.position.z - this._lastZ;
    const dAlt = Math.abs(camera.position.y - this._lastAlt);
    if (dx * dx + dz * dz > 500 * 500 || dAlt > 900 || this._needsRebuild) {
      this.rebuild(camera);
    }
    // keep instance colors uploaded only when changed
  }

  rebuild(camera) {
    const alt = Math.max(0, camera.position.y);
    const radius = clamp(this.preset.buildingRadius + alt * 5, this.preset.buildingRadius, 30000);
    const settlements = settlementsNear(camera.position.x, camera.position.z, radius);
    this._groundUse.clear();
    for (const s of settlements) {
      if (s.type === 'metro' || s.type === 'town') {
        this._ensureGround(s);
        this._groundUse.add(s.id);
      }
    }
    for (const [id, mesh] of this.grounds) {
      if (this._groundUse.has(id)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.grounds.delete(id);
    }
    let n = 0;
    let rn = 0;
    let ln = 0;
    let colorDirty = false;

    const limit = this.preset.buildingLimit;
    const roadLimit = this.roadMesh.instanceMatrix.count;
    const lightLimit = this.lightMesh.instanceMatrix.count;

    const addBox = (x, baseY, z, w, h, d, rot, color) => {
      if (n >= limit) return;
      _p.set(x, baseY, z);
      _e.set(0, rot || 0, 0);
      _q.setFromEuler(_e);
      _s.set(w, h, d);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(n, _m);
      _c.setHex(color).convertSRGBToLinear();
      this.mesh.setColorAt(n, _c);
      n++;
      colorDirty = true;
    };

    for (const s of settlements) {
      if (n >= limit) break;
      for (const b of s.buildings) {
        if (n >= limit) break;
        const y = (b.y ?? terrainHeight(b.x, b.z)) - 0.35;
        addBox(b.x, y, b.z, b.w, b.h, b.d, b.rot, b.color);

        // Tall buildings get a stepped crown and a rooftop plant room; this
        // breaks up the "one extruded box" look of the skyline.
        if (b.h > 55) {
          const tierH = b.h * 0.13;
          const tw = b.w * 0.72, td = b.d * 0.72;
          addBox(b.x, y + b.h, b.z, tw, tierH, td, b.rot, b.color);
          addBox(b.x, y + b.h + tierH, b.z, tw * 0.34, 2.6, td * 0.34, b.rot + 0.2, 0x545a5c);
          if (b.h > 85 && n < limit) {
            addBox(b.x, y + b.h + tierH + 2.6, b.z, 0.7, 7, 0.7, b.rot, 0x6b7072);
          }
        } else if (b.h > 14 && b.w > 8 && b.d > 8) {
          addBox(b.x, y + b.h, b.z, b.w * 0.32, 2.0, b.d * 0.32, b.rot + 0.3, 0x5a5e5c);
        }
      }
    }

    if (this.preset.roadDetail) {
      const segments = [];
      for (const s of settlements) {
        if (rn >= roadLimit) break;
        for (const r of s.roads) {
          const dx = r.x2 - r.x1;
          const dz = r.z2 - r.z1;
          const len = Math.hypot(dx, dz);
          if (len < 1) continue;
          const pieces = Math.max(1, Math.ceil(len / 90));
          for (let i = 0; i < pieces; i++) {
            if (rn >= roadLimit) break;
            const t0 = i / pieces;
            const t1 = (i + 1) / pieces;
            const mx = r.x1 + dx * (t0 + t1) * 0.5;
            const mz = r.z1 + dz * (t0 + t1) * 0.5;
            const sl = len / pieces;
            const y = terrainHeight(mx, mz) + 0.75;
            _p.set(mx, y, mz);
            _e.set(0, Math.atan2(dx, dz), 0);
            _q.setFromEuler(_e);
            _s.set(r.width, 1, sl + 0.6);
            _m.compose(_p, _q, _s);
            this.roadMesh.setMatrixAt(rn++, _m);

            // street lamps every ~180 m, alternating sides
            if (i % 2 === 0 && ln < lightLimit) {
              const side = (i % 4 === 0) ? 1 : -1;
              const nx = -dz / len, nz = dx / len;
              const lx = mx + nx * (r.width * 0.5 + 4.5) * side;
              const lz = mz + nz * (r.width * 0.5 + 4.5) * side;
              const ly = terrainHeight(lx, lz) + 6.2;
              _p.set(lx, ly, lz);
              _e.set(0, 0, 0);
              _q.setFromEuler(_e);
              _s.set(1.4, 1.4, 1.4);
              _m.compose(_p, _q, _s);
              this.lightMesh.setMatrixAt(ln++, _m);
            }
          }
        }
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.roadMesh.count = rn;
    this.roadMesh.instanceMatrix.needsUpdate = true;
    this.lightMesh.count = ln;
    this.lightMesh.instanceMatrix.needsUpdate = true;

    this._lastX = camera.position.x;
    this._lastZ = camera.position.z;
    this._lastAlt = camera.position.y;
    this._needsRebuild = false;
    this.stats.buildings = n;
    this.stats.roads = rn;
    this.stats.settlements = settlements.length;
    this.stats.lights = ln;
  }

  _ensureGround(s) {
    if (this.grounds.has(s.id)) return this.grounds.get(s.id);
    const geo = new THREE.CircleGeometry(s.radius * 1.14, 36);
    geo.rotateX(-Math.PI / 2);
    const baseY = terrainHeight(s.x, s.z);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = s.x + pos.getX(i);
      const wz = s.z + pos.getZ(i);
      pos.setY(i, terrainHeight(wx, wz) - baseY + 0.16);
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.groundMaterial);
    mesh.position.set(s.x, baseY, s.z);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.grounds.set(s.id, mesh);
    return mesh;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.roadMesh.geometry.dispose();
    this.roadMaterial.dispose();
    this.lightMesh.geometry.dispose();
    this.lightMaterial.dispose();
    for (const g of this.grounds.values()) {
      this.scene.remove(g);
      g.geometry.dispose();
    }
    this.grounds.clear();
    this.groundMaterial.map?.dispose();
    this.groundMaterial.dispose();
    this.mesh.removeFromParent();
    this.roadMesh.removeFromParent();
    this.lightMesh.removeFromParent();
  }
}