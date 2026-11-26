// Offshore Nimitz-class aircraft carrier group (CVN-71).
//
// Zero-asset and headless-safe: the module builds real THREE geometry when a
// scene is supplied and stays a pure simulation object when `scene === null`.
// World conventions follow ARCHITECTURE.md: Y up, north = -Z, east = +X,
// heading degrees clockwise from north, forward = (sin h, 0, -cos h).
import * as THREE from 'three';
import { baseHeight } from './terrain.js';

const DEG = Math.PI / 180;

export const DECK_HEIGHT = 18.5;
export const DECK_LENGTH = 330;
export const DECK_WIDTH = 76;
export const GLIDESLOPE_DEG = 3.5;
export const CATAPULT_SPEED_MS = 82;
export const CATAPULT_DURATION = 2.2;

// Wire centres (carrier-local `along`) from abaft the island to the ramp.
const WIRE_ALONG = [-115, -95, -75, -55];
const WIRE_ZONE_MIN = -125;
const WIRE_ZONE_MAX = -45;
const WIRE_STOP_TIME = 2.0;
const CATCH_MAX_Y = 3.2;
const CATAPULT_ZONE_MIN = 20;
const CATAPULT_ZONE_MAX = 130;
const CATAPULT_MAX_Y = 2.6;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap180 = (deg) => ((deg + 540) % 360) - 180;

const _fwd = new THREE.Vector3();

function forwardFor(headingDeg, out) {
  const r = headingDeg * DEG;
  return out.set(Math.sin(r), 0, -Math.cos(r));
}

// Write velocity without assuming a THREE.Vector3: plain {x,y,z} flight mocks
// (and Vector3 instances) both work.
function setVelocity(flight, fx, fz, speed) {
  if (!flight.velocity) return;
  flight.velocity.x = fx * speed;
  flight.velocity.y = 0;
  flight.velocity.z = fz * speed;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

function cylinder(rt, rb, h, seg, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material);
  m.position.set(x, y, z);
  return m;
}

function sphere(r, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), material);
  m.position.set(x, y, z);
  return m;
}

// Flat deck stripe between two carrier-local XZ points. Boxes keep the yaw
// math simple and render the same from either side.
function stripe(x1, z1, x2, z2, width, material, y) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const m = box(width, 0.04, len, material, (x1 + x2) / 2, y, (z1 + z2) / 2);
  m.rotation.y = Math.atan2(dx, dz);
  return m;
}

// Lofted hull: deck-edge outline tapering to the waterline, plus a narrow bow.
function buildHullGeometry() {
  const deckY = DECK_HEIGHT;
  const keelY = -1.4;
  const stations = [
    { z: -165, wDeck: 4, wKeel: 1.2 },
    { z: -150, wDeck: 24, wKeel: 7 },
    { z: -120, wDeck: 34, wKeel: 13 },
    { z: -60, wDeck: 38, wKeel: 19 },
    { z: 40, wDeck: 38, wKeel: 21 },
    { z: 130, wDeck: 38, wKeel: 21 },
    { z: 165, wDeck: 34, wKeel: 18 },
  ];

  const verts = [];
  const push = (x, y, z) => verts.push(x, y, z);

  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    // Port side (+ counter-clockwise winding when seen from outside).
    push(-a.wDeck, deckY, a.z); push(-a.wKeel, keelY, a.z); push(-b.wKeel, keelY, b.z);
    push(-a.wDeck, deckY, a.z); push(-b.wKeel, keelY, b.z); push(-b.wDeck, deckY, b.z);
    // Starboard side.
    push(a.wDeck, deckY, a.z); push(b.wKeel, keelY, b.z); push(a.wKeel, keelY, a.z);
    push(a.wDeck, deckY, a.z); push(b.wDeck, deckY, b.z); push(b.wKeel, keelY, b.z);
    // Bottom.
    push(-a.wKeel, keelY, a.z); push(a.wKeel, keelY, a.z); push(b.wKeel, keelY, b.z);
    push(-a.wKeel, keelY, a.z); push(b.wKeel, keelY, b.z); push(-b.wKeel, keelY, b.z);
  }

  // Stern transom.
  const s = stations[stations.length - 1];
  push(-s.wDeck, deckY, s.z); push(s.wKeel, keelY, s.z); push(-s.wKeel, keelY, s.z);
  push(-s.wDeck, deckY, s.z); push(s.wDeck, deckY, s.z); push(s.wKeel, keelY, s.z);
  // Bow cap.
  const b0 = stations[0];
  push(-b0.wDeck, deckY, b0.z); push(b0.wKeel, keelY, b0.z); push(-b0.wKeel, keelY, b0.z);
  push(-b0.wDeck, deckY, b0.z); push(b0.wDeck, deckY, b0.z); push(b0.wKeel, keelY, b0.z);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// CarrierGroup
// ---------------------------------------------------------------------------
export class CarrierGroup {
  constructor(scene = null, options = {}) {
    // Constants are exposed both as module exports and instance properties.
    this.DECK_HEIGHT = DECK_HEIGHT;
    this.DECK_LENGTH = DECK_LENGTH;
    this.DECK_WIDTH = DECK_WIDTH;
    this.GLIDESLOPE_DEG = GLIDESLOPE_DEG;
    this.CATAPULT_SPEED_MS = CATAPULT_SPEED_MS;
    this.CATAPULT_DURATION = CATAPULT_DURATION;

    this.scene = scene;
    this.x = options.x ?? 0;
    this.z = options.z ?? 0;
    this.heading = options.heading ?? 0;
    this.deckHeight = DECK_HEIGHT;
    this.name = 'USS THEODORE ROOSEVELT';
    this.code = 'CVN71';

    this.wireCaught = 0;
    this.wireTimer = 0;
    this.catapultActive = false;
    this.catapultTimer = 0;

    this.group = null;
    this._flolsBall = null;
    this._flolsBaseY = 0;
    this._radar = null;
    this._wireEntrySpeed = 0;
    this._catapultStartSpeed = 0;
    this._catapultLaunched = false;

    if (scene) {
      this._build();
      this._syncGroup();
    }
  }

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------
  // Expand rings from 6 km to 36 km looking for deep water (baseHeight < -6).
  // Fully deterministic; the fixed fallback matches the feature contract.
  placeNear(originX = 0, originZ = 0) {
    let px = originX + 18000;
    let pz = originZ - 18000;
    let found = false;

    for (let radius = 6000; radius <= 36000 && !found; radius += 2000) {
      const count = Math.max(8, Math.round((2 * Math.PI * radius) / 2500));
      const phase = radius * 0.000173;
      for (let i = 0; i < count; i++) {
        const a = phase + (i / count) * Math.PI * 2;
        const x = originX + Math.cos(a) * radius;
        const z = originZ + Math.sin(a) * radius;
        if (baseHeight(x, z) < -6) {
          px = x;
          pz = z;
          found = true;
          break;
        }
      }
    }

    this.x = px;
    this.z = pz;
    this._syncGroup();
    return { x: this.x, z: this.z, heading: this.heading, deckHeight: this.deckHeight };
  }

  _syncGroup() {
    if (!this.group) return;
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = -this.heading * DEG;
  }

  // World (x, z) -> carrier-local { along, right }.
  // along > 0 is toward the bow, right > 0 is starboard.
  worldToDeck(x, z) {
    const r = this.heading * DEG;
    const s = Math.sin(r);
    const c = Math.cos(r);
    const dx = x - this.x;
    const dz = z - this.z;
    return {
      along: dx * s - dz * c,
      right: dx * c + dz * s,
    };
  }

  // Carrier-local { along, right } -> world (x, z).
  deckToWorld(along, right) {
    const r = this.heading * DEG;
    const s = Math.sin(r);
    const c = Math.cos(r);
    return {
      x: this.x + right * c + along * s,
      z: this.z + right * s - along * c,
    };
  }

  isOverDeck(x, z) {
    const { along, right } = this.worldToDeck(x, z);
    return Math.abs(along) <= DECK_LENGTH * 0.5 && Math.abs(right) <= DECK_WIDTH * 0.5;
  }

  getDeckElevation(x, z) {
    return this.isOverDeck(x, z) ? this.deckHeight : null;
  }

  getDeckPoint() {
    return {
      id: this.code,
      code: this.code,
      name: this.name,
      x: this.x,
      z: this.z,
      elevation: this.deckHeight,
      heading: this.heading,
      length: DECK_LENGTH,
      width: DECK_WIDTH,
      kind: 'carrier',
    };
  }

  // -------------------------------------------------------------------------
  // FLOLS
  // -------------------------------------------------------------------------
  getMeatball(flight) {
    const result = {
      active: false,
      ballOffset: 0,
      glideslopeErrorDeg: 0,
      lineupErrorM: 0,
      distNm: 0,
      bearing: 0,
      deckHeading: this.heading,
    };
    if (!flight || !flight.position) return result;

    const px = flight.position.x;
    const pz = flight.position.z;
    const py = flight.position.y;
    if (!Number.isFinite(px) || !Number.isFinite(pz) || !Number.isFinite(py)) return result;
    const dx = px - this.x;
    const dz = pz - this.z;
    const dist = Math.hypot(dx, dz);
    const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
    const { along, right } = this.worldToDeck(px, pz);

    result.lineupErrorM = right;
    result.distNm = dist / 1852;
    result.bearing = (bearing + 360) % 360;

    // Must be approaching from aft, inside 8 km and within 30 deg of the
    // stern approach axis.
    if (along >= 0 || dist > 8000 || dist < 25) return result;
    if (Math.abs(wrap180(result.bearing - (this.heading + 180))) > 30) return result;

    const heightAboveDeck = py - this.deckHeight;
    const pathDeg = (Math.atan2(heightAboveDeck, dist) * 180) / Math.PI;
    const error = pathDeg - GLIDESLOPE_DEG;

    result.active = true;
    result.glideslopeErrorDeg = error;
    // +/-0.7 deg of path error fills the ball/cut-light range.
    result.ballOffset = clamp(error / 0.7, -1, 1);
    return result;
  }

  // -------------------------------------------------------------------------
  // Catapult
  // -------------------------------------------------------------------------
  triggerCatapult(flight) {
    if (!flight || !flight.position) return false;
    if (!this.isOverDeck(flight.position.x, flight.position.z)) return false;
    if ((flight.speed ?? 0) >= 25) return false;

    this.catapultActive = true;
    this.catapultTimer = 0;
    this._catapultStartSpeed = Math.max(0, flight.speed || 0);
    this._catapultLaunched = false;
    this.wireCaught = 0;
    this.wireTimer = 0;
    return true;
  }

  // -------------------------------------------------------------------------
  // Per-frame simulation + 3D animation
  // -------------------------------------------------------------------------
  update(dt, flight, weather = null) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    let newlyCaughtWire = 0;
    let catapultLaunched = false;

    const meatball = this.getMeatball(flight);
    let onDeck = false;
    let local = null;

    if (flight && flight.position) {
      onDeck = this.isOverDeck(flight.position.x, flight.position.z);
      local = this.worldToDeck(flight.position.x, flight.position.z);

      // ---- arresting wires -------------------------------------------------
      if (
        !this.catapultActive &&
        this.wireCaught === 0 &&
        onDeck &&
        flight.position.y <= this.deckHeight + CATCH_MAX_Y &&
        (flight.gearPos ?? 1) > 0.5 &&
        (flight.speed ?? 0) > 28 &&
        local.along >= WIRE_ZONE_MIN &&
        local.along <= WIRE_ZONE_MAX
      ) {
        let wire;
        if (local.along < -105) wire = 1;
        else if (local.along < -85) wire = 2;
        else if (local.along < -65) wire = 3;
        else wire = 4;

        this.wireCaught = wire;
        this.wireTimer = 0;
        this._wireEntrySpeed = Math.max(flight.speed, 0);
        newlyCaughtWire = wire;
      }

      if (this.wireCaught > 0) {
        this.wireTimer += step;
        const t = clamp(this.wireTimer / WIRE_STOP_TIME, 0, 1);
        const speed = this._wireEntrySpeed * (1 - t);

        forwardFor(this.heading, _fwd);
        setVelocity(flight, _fwd.x, _fwd.z, speed);
        flight.speed = speed;
        flight.onGround = true;
        // The recorded position is the CG; rest the wheels on the deck instead
        // of sinking the airframe into it.
        const gearHeight = Number.isFinite(flight.gearHeight) ? flight.gearHeight : 1.55;
        flight.position.y = this.deckHeight + gearHeight;

        if (speed < 1.5 || t >= 1) {
          this.wireCaught = 0;
          this.wireTimer = 0;
        }
      }

      // ---- steam catapult --------------------------------------------------
      if (!this.catapultActive) {
        const inCatZone = local.along >= CATAPULT_ZONE_MIN && local.along <= CATAPULT_ZONE_MAX;
        const onBowDeck = flight.onGround || flight.position.y <= this.deckHeight + CATAPULT_MAX_Y;
        if (
          inCatZone &&
          onBowDeck &&
          (flight.speed ?? 0) < 12 &&
          (flight.throttle ?? 0) > 0.92
        ) {
          this.catapultActive = true;
          this.catapultTimer = 0;
          this._catapultStartSpeed = Math.max(0, flight.speed || 0);
          this._catapultLaunched = false;
          this.wireCaught = 0;
          this.wireTimer = 0;
        }
      }

      if (this.catapultActive) {
        this.catapultTimer += step;
        const t = clamp(this.catapultTimer / CATAPULT_DURATION, 0, 1);
        const speed = Math.max(this._catapultStartSpeed, CATAPULT_SPEED_MS * t);

        forwardFor(this.heading, _fwd);
        setVelocity(flight, _fwd.x, _fwd.z, speed);
        flight.speed = speed;
        flight.onGround = false;
        if (flight.position.y < this.deckHeight) flight.position.y = this.deckHeight;

        const after = this.worldToDeck(flight.position.x, flight.position.z);
        if (this.catapultTimer >= CATAPULT_DURATION || after.along > DECK_LENGTH * 0.5) {
          this.catapultActive = false;
          this.catapultLaunched = true;
          catapultLaunched = true;
        }
      }
    }

    // ---- 3D animation (scene-backed only) ---------------------------------
    if (this.group) {
      if (this._flolsBall) {
        this._flolsBall.position.y = this._flolsBaseY + (meatball.active ? meatball.ballOffset * 1.5 : 0);
      }
      if (this._radar) {
        this._radar.rotation.y += step * 1.1;
      }
      this.group.position.set(this.x, 0, this.z);
    }

    return {
      onDeck,
      meatball,
      wireCaught: this.wireCaught,
      newlyCaughtWire,
      catapultActive: this.catapultActive,
      catapultLaunched,
    };
  }

  // -------------------------------------------------------------------------
  // 3D model
  // -------------------------------------------------------------------------
  _build() {
    const g = new THREE.Group();
    g.name = 'CarrierGroup';

    const hullMat = new THREE.MeshLambertMaterial({ color: 0x555c62 });
    const hullDarkMat = new THREE.MeshLambertMaterial({ color: 0x3e444a });
    const deckMat = new THREE.MeshLambertMaterial({ color: 0x3a3e42 });
    const islandMat = new THREE.MeshLambertMaterial({ color: 0x6b7278 });
    const islandDarkMat = new THREE.MeshLambertMaterial({ color: 0x4d545a });
    const metalMat = new THREE.MeshLambertMaterial({ color: 0x9aa1a6 });
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xdfe3dc, toneMapped: false });
    const hazardMat = new THREE.MeshBasicMaterial({ color: 0xd8b441, toneMapped: false });
    const trackMat = new THREE.MeshBasicMaterial({ color: 0x24272a });
    const wireMat = new THREE.MeshLambertMaterial({ color: 0x1c1e20 });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x8fe8ff, toneMapped: false });
    const redMat = new THREE.MeshBasicMaterial({ color: 0xff3b2f, toneMapped: false });
    const greenMat = new THREE.MeshBasicMaterial({ color: 0x39ff88, toneMapped: false });

    // Hull + flight deck.
    g.add(new THREE.Mesh(buildHullGeometry(), hullMat));
    g.add(box(DECK_WIDTH, 2.2, DECK_LENGTH, deckMat, 0, DECK_HEIGHT - 1.1, 0));
    // Deck edge lips.
    g.add(box(1.2, 0.9, DECK_LENGTH, hullDarkMat, -DECK_WIDTH / 2 + 0.6, DECK_HEIGHT + 0.45, 0));
    g.add(box(1.2, 0.9, DECK_LENGTH, hullDarkMat, DECK_WIDTH / 2 - 0.6, DECK_HEIGHT + 0.45, 0));

    const yMark = DECK_HEIGHT + 0.05;

    // Angled landing area: centreline + edge lines.
    const ax1 = 16;
    const az1 = 158;
    const ax2 = -18;
    const az2 = -58;
    const adx = ax2 - ax1;
    const adz = az2 - az1;
    const alen = Math.hypot(adx, adz);
    const px = adz / alen;
    const pz = -adx / alen;
    g.add(stripe(ax1, az1, ax2, az2, 0.9, lineMat, yMark));
    for (const off of [-18, 18]) {
      g.add(stripe(ax1 + px * off, az1 + pz * off, ax2 + px * off, az2 + pz * off, 0.35, lineMat, yMark));
    }
    // Bow centreline.
    g.add(stripe(0, -30, 0, -152, 0.6, lineMat, yMark));

    // Landing zone touchdown blocks.
    for (let i = 0; i < 4; i++) {
      const z = 140 - i * 18;
      g.add(box(2.2, 0.05, 9, lineMat, ax1 + (adx * (158 - z)) / Math.abs(adz) + 6, yMark, z));
      g.add(box(2.2, 0.05, 9, lineMat, ax1 + (adx * (158 - z)) / Math.abs(adz) - 6, yMark, z));
    }

    // 4 arresting wires spanning the landing area.
    for (const along of WIRE_ALONG) {
      const z = -along;
      const wire = cylinder(0.14, 0.14, 58, 6, wireMat, 0, DECK_HEIGHT + 0.55, z);
      wire.rotation.z = Math.PI / 2;
      g.add(wire);
      // Sheave boxes at each deck edge.
      g.add(box(2.2, 1.1, 1.6, metalMat, -29, DECK_HEIGHT + 0.4, z));
      g.add(box(2.2, 1.1, 1.6, metalMat, 29, DECK_HEIGHT + 0.4, z));
    }

    // Bow catapult tracks + shuttles and blast deflectors.
    for (const x of [-14, 14]) {
      const track = box(1.3, 0.06, 118, trackMat, x, yMark, -91);
      g.add(track);
      g.add(box(2.6, 0.35, 4.4, hazardMat, x, DECK_HEIGHT + 0.2, -32));
      const deflector = box(7, 2.2, 0.5, islandDarkMat, x, DECK_HEIGHT + 1.1, -28);
      deflector.rotation.x = 1.05;
      g.add(deflector);
    }
    // Waist catapult track (port side, angled deck).
    g.add(box(1.1, 0.06, 92, trackMat, -24, yMark, 30));

    // Deck elevators (darker plates on the starboard edge).
    g.add(box(18, 0.08, 26, hullDarkMat, 28, yMark, -38));
    g.add(box(18, 0.08, 26, hullDarkMat, 28, yMark, 8));
    g.add(box(18, 0.12, 0.5, hazardMat, 28, yMark + 0.02, -51));
    g.add(box(18, 0.12, 0.5, hazardMat, 28, yMark + 0.02, -25));

    // Island superstructure (starboard, aft of the elevators).
    const islandZ = 62;
    const islandTop = DECK_HEIGHT + 19;
    g.add(box(17, 19, 58, islandMat, 24, DECK_HEIGHT + 9.5, islandZ));
    g.add(box(19, 2.2, 44, islandDarkMat, 24, islandTop + 0.6, islandZ + 4));
    // Bridge with lit windows.
    g.add(box(15, 5.2, 20, islandMat, 23.5, islandTop + 2.6, islandZ - 12));
    g.add(box(13.6, 1.5, 0.4, glowMat, 23.5, islandTop + 3.7, islandZ - 22.1));
    // Funnel.
    g.add(box(10, 7, 13, islandDarkMat, 26, islandTop + 3.5, islandZ + 18));
    // Main mast with rotating radar.
    const mastBase = islandTop + 5.2;
    g.add(cylinder(0.7, 0.9, 16, 8, metalMat, 24, mastBase + 8, islandZ - 6));
    g.add(cylinder(0.25, 0.25, 9, 6, metalMat, 24, mastBase + 20, islandZ - 6));
    const radar = new THREE.Group();
    radar.position.set(24, mastBase + 15, islandZ - 6);
    radar.add(box(13, 2.6, 0.6, metalMat, 0, 0, 0));
    radar.add(box(5, 0.5, 0.7, islandDarkMat, 0, 1.5, 0));
    g.add(radar);
    this._radar = radar;
    // Yardarms.
    for (const dx of [-7, 7]) {
      g.add(box(0.35, 0.35, 8, metalMat, 24 + dx, mastBase + 11, islandZ - 6));
    }
    // CIWS / Sea Sparrow boxes.
    g.add(cylinder(2.2, 2.6, 2.4, 8, metalMat, 26, DECK_HEIGHT + 1.2, islandZ - 36));
    g.add(box(3.2, 2.2, 3.6, islandDarkMat, 24, DECK_HEIGHT + 1.1, islandZ + 32));
    g.add(cylinder(1.6, 1.8, 1.2, 8, metalMat, -30, DECK_HEIGHT + 0.6, 132));

    // FLOLS housing on the port side, facing aft over the ramp.
    const flolsX = -31;
    const flolsZ = 150;
    const flolsY = DECK_HEIGHT + 3.0;
    g.add(box(1.4, 3.2, 1.4, metalMat, flolsX, DECK_HEIGHT + 1.6, flolsZ));
    g.add(box(11, 4.2, 1.6, islandDarkMat, flolsX, flolsY, flolsZ));
    // Green datum light rows.
    for (let i = 0; i < 5; i++) {
      const x = flolsX - 4 + i * 2;
      g.add(sphere(0.28, greenMat, x, flolsY, flolsZ - 0.95));
    }
    // Moving amber "meatball".
    const ballMat = new THREE.MeshBasicMaterial({ color: 0xffb020, toneMapped: false });
    const ball = sphere(0.42, ballMat, flolsX, flolsY, flolsZ - 1.0);
    g.add(ball);
    this._flolsBall = ball;
    this._flolsBaseY = flolsY;

    // Navigation lights.
    g.add(sphere(0.7, redMat, -DECK_WIDTH / 2 + 2, DECK_HEIGHT + 1.2, -160));
    g.add(sphere(0.7, greenMat, DECK_WIDTH / 2 - 2, DECK_HEIGHT + 1.2, -160));
    g.add(sphere(0.5, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
      24, mastBase + 26, islandZ - 6));

    // Wake: two pale translucent strips trailing from the stern.
    const wakeMat = new THREE.MeshBasicMaterial({
      color: 0xdfeef5,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const sx of [-20, 20]) {
      const wake = new THREE.Mesh(new THREE.PlaneGeometry(26, 340), wakeMat);
      wake.rotation.x = -Math.PI / 2;
      wake.position.set(sx, 0.06, DECK_LENGTH / 2 + 170);
      g.add(wake);
    }

    // Bow number plate ("71") built from bars, no canvas/texture needed.
    const numMat = lineMat;
    const nz = -140;
    g.add(box(1.6, 0.05, 10, numMat, -8, yMark, nz)); // 7 top
    g.add(box(5, 0.05, 1.6, numMat, -10.5, yMark, nz - 4.2)); // 7 diagonal
    g.add(box(1.6, 0.05, 10, numMat, 0, yMark, nz)); // 1 stem
    g.add(box(4, 0.05, 1.6, numMat, -1.2, yMark, nz + 4.2)); // 1 base

    this.group = g;
    if (this.scene && typeof this.scene.add === 'function') this.scene.add(g);
  }
}

export default CarrierGroup;