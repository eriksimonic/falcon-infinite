#!/usr/bin/env python3
"""Bake real OpenStreetMap data for the Vipava Valley theater (Feature 38).

Outputs:
  * public/media/vipava_buildings.bin  -- compact FBLD v1 building records
  * public/media/vipava_osm.json       -- roads (with bridge flags), legacy
                                          fallback buildings, landmarks and
                                          urban zones.

The script queries Overpass across tiled regions, caches raw responses in
/tmp/vipava_osm_cache (never committed), and is fully deterministic: reruns
reuse the cache and produce byte-identical output.

Geometry convention (must match Three.js `rotation.y = rot`):
  world_x = cx + u * cos(rot) + v * sin(rot)
  world_z = cz - u * sin(rot) + v * cos(rot)
therefore the inverse is
  u = dx * cos(rot) - dz * sin(rot)
  v = dx * sin(rot) + dz * cos(rot)
"""

import argparse
import json
import math
import os
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_BIN = ROOT / "public" / "media" / "vipava_buildings.bin"
OUT_JSON = ROOT / "public" / "media" / "vipava_osm.json"
CACHE_DIR = Path("/tmp/vipava_osm_cache")
CACHE_VERSION = "v4"

LAT0 = 45.8878
LON0 = 13.8869
M_PER_DEG_LAT = 111132.92
M_PER_DEG_LON = 111412.84 * math.cos(math.radians(LAT0))

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------
CORE_BUDGET = 35000          # spec: keep all core buildings >= 24 m2, up to ~35k
CORE_MIN_AREA = 24.0
CORE_BBOX = (45.78, 13.56, 46.02, 14.02)
CORE_TILE = (0.06, 0.08)     # lat height, lon width (~6.7 x 6.3 km)

# Regional theatre (outside the dense valley corridor). Caps keep the whole
# theater inside the 35k-55k target while preserving every town center.
REGIONAL_CAPS = {
    "Trieste": 6000,
    "Monfalcone+Ronchi": 2500,
    "Koper": 2600,
    "Izola": 1300,
    "Piran+Portoroz": 1300,
    "Postojna": 1000,
    "Sezana+Divaca": 1600,
    "Idrija": 800,
    "Tolmin+MostNaSoci": 700,
    "Grado": 700,
}
REGIONAL_BOXES = {
    "Trieste": (45.61, 13.73, 45.69, 13.84),
    "Monfalcone+Ronchi": (45.78, 13.49, 45.84, 13.58),
    "Koper": (45.52, 13.70, 45.57, 13.78),
    "Izola": (45.50, 13.55, 45.55, 13.62),
    "Piran+Portoroz": (45.50, 13.62, 45.55, 13.68),
    "Postojna": (45.75, 14.18, 45.80, 14.24),
    "Sezana+Divaca": (45.66, 13.84, 45.73, 14.00),
    "Idrija": (45.98, 14.00, 46.03, 14.06),
    "Tolmin+MostNaSoci": (46.14, 13.70, 46.20, 13.77),
    "Grado": (45.67, 13.37, 45.70, 13.42),
}
BRIDGE_BBOX = (45.50, 13.37, 46.20, 14.24)

MIRRORS = [
    ("https://overpass-api.de/api/interpreter", 150),
    ("https://maps.mail.ru/osm/tools/overpass/api/interpreter", 45),
    ("https://overpass.kumi.systems/api/interpreter", 60),
]
USER_AGENT = "falcon-infinite-osm-baker/3.1 (+feature-38)"

FALLBACK_BUILDINGS = 1500

# Towns the bake must cover (lat, lon) -- used for the coverage report and by
# tests/osm_bake_audit_test.mjs.
TOWN_PROBES = {
    "Ajdovscina": (45.8869, 13.9093),
    "Vipava": (45.8466, 13.9622),
    "NovaGorica": (45.9551, 13.6493),
    "Gorizia": (45.9417, 13.6222),
    "Solkan": (45.9778, 13.6511),
    "Dornberk": (45.8294, 13.7625),
    "Branik": (45.8575, 13.7864),
    "Sempas": (45.9308, 13.7433),
    "Crnice": (45.9019, 13.7719),
    "Rence": (45.8897, 13.6775),
    "Stanjel": (45.8236, 13.8453),
    "Izola": (45.5361, 13.6603),
    "Piran": (45.5285, 13.5685),
    "Koper": (45.5481, 13.7302),
    "Trieste": (45.6495, 13.7768),
    "Postojna": (45.7749, 14.2075),
    "Sezana": (45.7078, 13.8703),
    # Extra valley villages that were missing before Feature 38.
    "Miren": (45.8961, 13.6078),
    "Bilje": (45.8878, 13.6275),
    "Prvacina": (45.8653, 13.7183),
    "Ozeljan": (45.9219, 13.7414),
    "Batuje": (45.8858, 13.8425),
    "Lokavec": (45.8664, 13.8775),
    "Slap": (45.8417, 13.9322),
    "Goce": (45.8131, 13.9231),
    "Podnanos": (45.8222, 13.9386),
    "Col": (45.8813, 14.0020),
    "Bukovica": (45.9100, 13.6408),
    "VolcjaDraga": (45.9036, 13.6383),
}

# ---------------------------------------------------------------------------
# Coordinates / deterministic hashing
# ---------------------------------------------------------------------------

def ll_to_xz(lat, lon):
    return ((lon - LON0) * M_PER_DEG_LON, -(lat - LAT0) * M_PER_DEG_LAT)


def hash01(x, z, salt=0):
    """Deterministic 0..1 hash of a world position (stable across runs)."""
    n = (int(round(x)) * 374761393 + int(round(z)) * 668265263 + salt * 2246822519) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n ^= n >> 16
    return (n & 0xFFFFFF) / 16777216.0


def color_seed(cx, cz):
    n = (int(round(cx)) * 73856093 ^ int(round(cz)) * 19349663) & 0xFFFFFFFF
    n = ((n ^ (n >> 15)) * 2246822519) & 0xFFFFFFFF
    n ^= n >> 13
    return n & 0xFF


# ---------------------------------------------------------------------------
# Overpass access with cache + mirror failover
# ---------------------------------------------------------------------------
_last_request = [0.0]


def _polite_sleep():
    dt = time.time() - _last_request[0]
    if dt < 0.5:
        time.sleep(0.5 - dt)
    _last_request[0] = time.time()


def query_overpass(query, cache_name, timeout=180):
    """Return parsed Overpass JSON, using /tmp cache when available."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{cache_name}_{CACHE_VERSION}.json"
    if cache_path.exists():
        try:
            with open(cache_path, "r") as f:
                data = json.load(f)
            if "elements" in data and not _fatal_remark(data):
                return data
        except Exception:
            pass

    payload = urllib.parse.urlencode({"data": query}).encode("utf-8")
    for attempt in range(3):
        for url in MIRRORS:
            _polite_sleep()
            try:
                req = urllib.request.Request(
                    url, data=payload, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                if "elements" not in data or _fatal_remark(data):
                    print(f"    mirror {url.split('/')[2]} returned incomplete data")
                    continue
                with open(cache_path, "w") as f:
                    json.dump(data, f)
                return data
            except Exception as exc:  # noqa: BLE001 - mirrors fail in many ways
                print(f"    mirror {url.split('/')[2]} failed: {type(exc).__name__} {exc}")
        time.sleep(2.0 + attempt * 2.0)
    return None


def _fatal_remark(data):
    remark = str(data.get("remark", "")).lower()
    return "timed out" in remark or "error" in remark or "out of memory" in remark


def _split_bbox(bbox):
    s, w, n, e = bbox
    mlat, mlon = (s + n) * 0.5, (w + e) * 0.5
    return [
        (s, w, mlat, mlon), (s, mlon, mlat, e),
        (mlat, w, n, mlon), (mlat, mlon, n, e),
    ]


def fetch_ways(tag, bbox, query_builder, depth=0, max_depth=3):
    """Fetch OSM ways for a bbox; subdivide the tile when Overpass struggles."""
    cache_name = f"{tag}_{bbox[0]:.5f}_{bbox[1]:.5f}_{bbox[2]:.5f}_{bbox[3]:.5f}"
    data = query_overpass(query_builder(bbox), cache_name)
    if data is None:
        if depth >= max_depth:
            print(f"  !! giving up on {tag} {bbox} after {depth} splits")
            return []
        print(f"  .. splitting {tag} {bbox}")
        out = []
        for sub in _split_bbox(bbox):
            out.extend(fetch_ways(tag, sub, query_builder, depth + 1, max_depth))
        return out
    ways = [el for el in data["elements"] if el.get("type") == "way"]
    print(f"  {tag} {bbox[0]:.3f},{bbox[1]:.3f}..{bbox[2]:.3f},{bbox[3]:.3f}: "
          f"{len(ways)} ways")
    return data["elements"]


def buildings_query(bbox):
    s, w, n, e = bbox
    return (
        f'[out:json][timeout:120];'
        f'(way["building"]({s},{w},{n},{e});way["man_made"="tower"]({s},{w},{n},{e}););'
        f'out body;>;out skel qt;'
    )


def bridges_query(bbox):
    s, w, n, e = bbox
    return (
        f'[out:json][timeout:120];'
        f'way["highway"~"^(motorway|trunk|primary|secondary)$"]'
        f'["bridge"~"^(yes|viaduct)$"]({s},{w},{n},{e});'
        f'out body;>;out skel qt;'
    )


# ---------------------------------------------------------------------------
# Polygon geometry: true minimum-area OBB in the Three.js rotation frame
# ---------------------------------------------------------------------------
OBB_STATS = {"buildings": 0, "max_forward_err": 0.0, "max_outside": 0.0}


def polygon_area(pts):
    s = 0.0
    for i in range(len(pts) - 1):
        x1, z1 = pts[i]
        x2, z2 = pts[i + 1]
        s += x1 * z2 - x2 * z1
    return abs(s) * 0.5


def obb_min_area(pts):
    """Minimum-area oriented bounding box matching `rotation.y = rot`.

    Candidate rotations come from every polygon edge (rot = atan2(dx, dz)),
    which aligns local +Z with the edge. Returns
    (cx, cz, bw, bd, rot, u_extent, v_extent).
    """
    best = None
    seen_angles = set()
    for i in range(len(pts) - 1):
        dx = pts[i + 1][0] - pts[i][0]
        dz = pts[i + 1][1] - pts[i][1]
        if dx == 0.0 and dz == 0.0:
            continue
        rot = math.atan2(dx, dz)
        key = round(rot, 4)
        if key in seen_angles:
            continue
        seen_angles.add(key)
        c, s = math.cos(rot), math.sin(rot)
        us = [x * c - z * s for x, z in pts]
        vs = [x * s + z * c for x, z in pts]
        u_min, u_max = min(us), max(us)
        v_min, v_max = min(vs), max(vs)
        area = (u_max - u_min) * (v_max - v_min)
        if best is None or area < best[0] - 1e-9:
            best = (area, rot, u_min, u_max, v_min, v_max)
    if best is None:
        return None

    _, rot, u_min, u_max, v_min, v_max = best
    c, s = math.cos(rot), math.sin(rot)
    u_mid = 0.5 * (u_min + u_max)
    v_mid = 0.5 * (v_min + v_max)
    cx = u_mid * c + v_mid * s          # x_ref = z_ref = 0 (absolute coords)
    cz = -u_mid * s + v_mid * c
    u_ext = u_max - u_min
    v_ext = v_max - v_min

    # Self-check: rebuild every vertex from (cx, cz, u, v) with the exact
    # Three.js forward formula and confirm it lands on the original point.
    max_err = 0.0
    max_outside = 0.0
    for x, z in pts:
        dx, dz = x - cx, z - cz
        u = dx * c - dz * s
        v = dx * s + dz * c
        rx = cx + u * c + v * s
        rz = cz - u * s + v * c
        max_err = max(max_err, abs(rx - x), abs(rz - z))
        max_outside = max(max_outside,
                          abs(u) - 0.5 * (u_max - u_min),
                          abs(v) - 0.5 * (v_max - v_min))
    OBB_STATS["buildings"] += 1
    OBB_STATS["max_forward_err"] = max(OBB_STATS["max_forward_err"], max_err)
    OBB_STATS["max_outside"] = max(OBB_STATS["max_outside"], max_outside)

    bw = max(4.0, min(120.0, u_ext))
    bd = max(4.0, min(120.0, v_ext))
    return cx, cz, bw, bd, rot, u_ext, v_ext


# ---------------------------------------------------------------------------
# Building classification
# ---------------------------------------------------------------------------
CHURCH = {"church", "cathedral", "chapel", "basilica", "monastery", "shrine"}
INDUSTRIAL = {"industrial", "warehouse", "commercial", "retail", "supermarket",
              "hangar", "manufacture"}
APARTMENT = {"apartments", "office", "public", "school", "hospital", "hotel",
             "civic", "university", "dormitory"}
SHED = {"shed", "garage", "garages", "greenhouse", "hut", "outbuilding",
        "farm_auxiliary"}
FLOOR_H = {0: 3.0, 1: 3.3, 2: 4.2, 3: 3.3, 4: 4.5, 5: 2.4}
DEFAULT_H = {0: (6.0, 8.5), 1: (13.0, 22.0), 2: (7.5, 11.0),
             3: (26.0, 40.0), 4: (14.0, 22.0), 5: (3.5, 4.8)}


def parse_float(value):
    if value is None:
        return None
    try:
        text = str(value).strip().lower().replace("m", "").replace(",", ".")
        text = text.split(";")[0].strip()
        return float(text)
    except Exception:
        return None


def classify(tags, area, cx, cz):
    btype = (tags.get("building") or "yes").strip().lower()
    man_made = (tags.get("man_made") or "").strip().lower()
    levels = parse_float(tags.get("building:levels"))
    levels = max(1, min(25, int(levels))) if levels and levels > 0 else None
    height_tag = parse_float(tags.get("height"))

    if btype in CHURCH:
        kind = 4
    elif man_made == "tower" or (height_tag is not None and height_tag >= 24.0) \
            or (height_tag is None and levels is not None and levels * 3.3 >= 24.0):
        kind = 3
    elif btype in INDUSTRIAL or (btype == "barn" and area > 200.0):
        kind = 2
    elif btype in APARTMENT or (levels is not None and levels >= 4):
        kind = 1
    elif btype in SHED or (btype == "yes" and area < 50.0 and not tags.get("name")):
        kind = 5
    else:
        kind = 0

    if height_tag is not None:
        h = height_tag
    elif levels is not None:
        h = levels * FLOOR_H[kind]
    else:
        lo, hi = DEFAULT_H[kind]
        h = lo + (hi - lo) * hash01(cx, cz, 5 + kind)
    h = max(2.5, min(120.0, h))

    roof_shape = (tags.get("roof:shape") or "").strip().lower()
    aspect = 1.0  # filled by caller once w/d are known
    return kind, h, roof_shape, aspect, btype


def roof_code(kind, h, roof_shape, aspect, cx, cz):
    if kind == 4:
        return 4
    if kind == 2:
        return 3
    if roof_shape == "flat" or kind == 3 or (kind == 1 and h >= 14.0):
        return 2
    if roof_shape in ("hipped", "pyramidal"):
        return 1
    if kind == 0 and aspect < 1.25 and hash01(cx, cz, 11) < 0.45:
        return 1
    return 0


def tier_code(kind, h, area):
    if kind in (3, 4) or h >= 12.0 or area >= 320.0:
        return 2
    if kind == 5 or area < 55.0:
        return 0
    return 1


# ---------------------------------------------------------------------------
# Fetch + parse buildings
# ---------------------------------------------------------------------------
def parse_buildings(elements, seen_ids, out, core, box=None):
    nodes = {}
    ways = []
    for el in elements:
        if el.get("type") == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])
        elif el.get("type") == "way":
            ways.append(el)

    missing = 0
    kept = 0
    for way in ways:
        wid = way.get("id")
        if wid in seen_ids:
            continue
        tags = way.get("tags") or {}
        if "building" not in tags and tags.get("man_made") != "tower":
            continue
        coords = []
        for nid in way.get("nodes", []):
            p = nodes.get(nid)
            if p is None:
                missing += 1
                continue
            coords.append(ll_to_xz(*p))
        if len(coords) >= 2 and coords[0] == coords[-1]:
            coords = coords[:-1]
        if len(coords) < 3:
            continue
        area = polygon_area(coords + [coords[0]])
        if core and area < CORE_MIN_AREA:
            continue
        if area < 12.0:  # ignore slivers everywhere else
            continue
        obb = obb_min_area(coords + [coords[0]])
        if obb is None:
            continue
        cx, cz, bw, bd, rot, u_ext, v_ext = obb
        kind, h, roof_shape, _, btype = classify(tags, area, cx, cz)
        aspect = max(u_ext, v_ext) / max(1e-6, min(u_ext, v_ext))
        roof = roof_code(kind, h, roof_shape, aspect, cx, cz)
        tier = tier_code(kind, h, area)
        out.append({
            "id": wid,
            "x": cx, "z": cz, "w": bw, "d": bd, "h": h, "rot": rot,
            "kind": kind, "roof": roof, "tier": tier,
            "seed": color_seed(cx, cz), "area": area, "core": core,
            "box": box,
        })
        seen_ids.add(wid)
        kept += 1
    return kept, missing, len(ways)


def load_buildings(force):
    seen_ids = set()
    core_buildings = []
    regional_buildings = []
    total_ways = 0

    core_tiles = []
    lat = CORE_BBOX[0]
    while lat < CORE_BBOX[2] - 1e-9:
        nlat = min(lat + CORE_TILE[0], CORE_BBOX[2])
        lon = CORE_BBOX[1]
        while lon < CORE_BBOX[3] - 1e-9:
            nlon = min(lon + CORE_TILE[1], CORE_BBOX[3])
            core_tiles.append((round(lat, 5), round(lon, 5), round(nlat, 5), round(nlon, 5)))
            lon += CORE_TILE[1]
        lat += CORE_TILE[0]

    print(f"Core valley: {len(core_tiles)} tiles")
    for bbox in core_tiles:
        elements = fetch_ways("bld_core", bbox, buildings_query)
        kept, missing, nways = parse_buildings(elements, seen_ids, core_buildings, True)
        total_ways += nways
        print(f"    -> kept {kept} (nos/ways {missing}/{nways})")

    for name, bbox in REGIONAL_BOXES.items():
        print(f"Regional: {name} {bbox}")
        elements = fetch_ways(f"bld_reg_{name.replace('+', '_')}", bbox, buildings_query)
        kept, missing, nways = parse_buildings(
            elements, seen_ids, regional_buildings, False, box=name)
        total_ways += nways
        print(f"    -> kept {kept} (nos/ways {missing}/{nways})")

    print(f"Raw: core={len(core_buildings)} regional={len(regional_buildings)} "
          f"deduped={len(seen_ids)}/{total_ways} ways")
    return core_buildings, regional_buildings


# ---------------------------------------------------------------------------
# Density-preserving selection
# ---------------------------------------------------------------------------

def stratified_pick(items, budget, cell=150.0):
    """Keep all churches + evenly distributed buildings across 150 m cells."""
    churches = [b for b in items if b["kind"] == 4]
    rest = [b for b in items if b["kind"] != 4]
    if len(churches) + len(rest) <= budget:
        return items

    buckets = {}
    for b in rest:
        key = (int(math.floor(b["x"] / cell)), int(math.floor(b["z"] / cell)))
        buckets.setdefault(key, []).append(b)
    order = []
    for key, bucket in buckets.items():
        bucket.sort(key=lambda b: (-b["area"], -b["h"], b["id"]))
        order.append((sum(b["area"] for b in bucket), key))
    order.sort(reverse=True)

    chosen = []
    remaining = max(0, budget - len(churches))
    cursor = [0] * len(order)
    streams = [buckets[key] for _, key in order]
    exhausted = 0
    while remaining > 0 and exhausted < len(streams):
        exhausted = 0
        for i, stream in enumerate(streams):
            if cursor[i] >= len(stream):
                exhausted += 1
                continue
            chosen.append(stream[cursor[i]])
            cursor[i] += 1
            remaining -= 1
            if remaining <= 0:
                break
    return churches + chosen


# ---------------------------------------------------------------------------
# Roads: reuse existing network, flag real OSM bridge spans
# ---------------------------------------------------------------------------
BRIDGE_WIDTH = {"motorway": 22, "trunk": 16, "primary": 12, "secondary": 9}


class SegmentIndex:
    """Rough spatial index of road segments for bridge matching."""

    def __init__(self, cell=200.0):
        self.cell = cell
        self.grid = {}

    def _cells(self, x1, z1, x2, z2):
        c = self.cell
        return {(int(math.floor(x / c)), int(math.floor(z / c)))
                for x in (x1, x2) for z in (z1, z2)}

    def add(self, road_index, x1, z1, x2, z2):
        for key in self._cells(x1, z1, x2, z2):
            self.grid.setdefault(key, []).append((road_index, x1, z1, x2, z2))

    def candidates(self, x, z):
        c = self.cell
        key = (int(math.floor(x / c)), int(math.floor(z / c)))
        return self.grid.get(key, [])


def point_seg_dist(px, pz, x1, z1, x2, z2):
    dx, dz = x2 - x1, z2 - z1
    l2 = dx * dx + dz * dz
    if l2 == 0.0:
        return math.hypot(px - x1, pz - z1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (pz - z1) * dz) / l2))
    return math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz))


def load_roads(force):
    try:
        existing = json.loads(OUT_JSON.read_text())
    except Exception:
        existing = {}
    base = []
    kept_by_pts = {}
    for road in existing.get("roads", []):
        clean = {k: v for k, v in road.items() if k not in ("b",)}
        pts = clean.get("pts")
        if not isinstance(pts, list) or len(pts) < 2:
            continue
        key = json.dumps(pts)
        if key in kept_by_pts:
            continue
        kept_by_pts[key] = len(base)
        base.append(clean)
    print(f"Reusing {len(base)} existing road ways")

    elements = fetch_ways("roads_bridges", BRIDGE_BBOX, bridges_query)
    nodes = {}
    ways = []
    for el in elements:
        if el.get("type") == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])
        elif el.get("type") == "way":
            ways.append(el)

    index = SegmentIndex()
    road_segments = []
    for ri, road in enumerate(base):
        pts = road["pts"]
        for i in range(len(pts) - 1):
            x1, z1 = pts[i]
            x2, z2 = pts[i + 1]
            road_segments.append((ri, x1, z1, x2, z2))
            index.add(ri, x1, z1, x2, z2)

    def road_length(road):
        pts = road["pts"]
        return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
                   for i in range(len(pts) - 1))

    base_lengths = [road_length(r) for r in base]
    base_mids = [((r["pts"][0][0] + r["pts"][-1][0]) * 0.5,
                  (r["pts"][0][1] + r["pts"][-1][1]) * 0.5) for r in base]
    base_headers = []
    for r in base:
        p0, p1 = r["pts"][0], r["pts"][-1]
        base_headers.append(math.atan2(p1[0] - p0[0], p1[1] - p0[1]))

    added = 0
    flagged = set()
    bridge_ways = 0
    for way in ways:
        coords = []
        for nid in way.get("nodes", []):
            p = nodes.get(nid)
            if p is not None:
                coords.append(ll_to_xz(*p))
        if len(coords) < 2:
            continue
        tags = way.get("tags") or {}
        hw = tags.get("highway", "secondary")
        seg_len = sum(math.hypot(coords[i + 1][0] - coords[i][0],
                                 coords[i + 1][1] - coords[i][1])
                      for i in range(len(coords) - 1))
        if seg_len < 6.0:
            continue
        bridge_ways += 1
        mid_x = (coords[0][0] + coords[-1][0]) * 0.5
        mid_z = (coords[0][1] + coords[-1][1]) * 0.5
        header = math.atan2(coords[-1][0] - coords[0][0], coords[-1][1] - coords[0][1])

        match = None
        for ri, x1, z1, x2, z2 in index.candidates(mid_x, mid_z):
            ratio = base_lengths[ri] / max(1e-6, seg_len)
            if not (0.75 <= ratio <= 1.4):
                continue
            dh = abs((base_headers[ri] - header + math.pi / 2) % math.pi - math.pi / 2)
            if dh > math.radians(30):
                continue
            if point_seg_dist(mid_x, mid_z, x1, z1, x2, z2) > 25.0:
                continue
            dm = math.hypot(base_mids[ri][0] - mid_x, base_mids[ri][1] - mid_z)
            if dm > 0.35 * max(base_lengths[ri], seg_len) + 20.0:
                continue
            match = ri
            break

        if match is not None:
            if "b" not in base[match]:
                base[match]["b"] = 1
                flagged.add(match)
            continue
        base.append({
            "w": BRIDGE_WIDTH.get(hw, 10),
            "pts": [[round(x, 1), round(z, 1)] for x, z in coords],
            "b": 1,
        })
        added += 1

    marked = sum(1 for r in base if r.get("b") == 1)
    print(f"Bridges: {bridge_ways} OSM bridge ways -> {marked} b:1 roads "
          f"({added} new segments, {len(flagged)} matched existing)")
    return base


# ---------------------------------------------------------------------------
# Urban zones from actual building distribution
# ---------------------------------------------------------------------------

def build_urban_zones(buildings, cell=700.0):
    """One zone per 700 m neighborhood cell occupied by real buildings.

    Fixed cells (instead of adjacency-chain clustering) keep every town and
    village centered on its own footprint -- ribbon development along valley
    roads would otherwise merge the whole valley into a few giant blobs.
    """
    buckets = {}
    for b in buildings:
        key = (int(math.floor(b["x"] / cell)), int(math.floor(b["z"] / cell)))
        buckets.setdefault(key, []).append(b)

    zones = []
    for members in buckets.values():
        if len(members) < 5:
            continue
        cx = sum(b["x"] for b in members) / len(members)
        cz = sum(b["z"] for b in members) / len(members)
        dists = sorted(math.hypot(b["x"] - cx, b["z"] - cz) for b in members)
        p90 = dists[min(len(dists) - 1, int(len(dists) * 0.9))]
        radius = max(80.0, min(900.0, p90 * 1.35))
        density = len(members) / max(1e-6, math.pi * radius * radius / 10000.0)
        zones.append({
            "count": len(members),
            "x": round(cx, 1),
            "z": round(cz, 1),
            "r": round(radius, 1),
            "d": round(min(99.0, density), 2),
        })
    zones.sort(key=lambda z: -z["count"])
    zones = zones[:800]
    print(f"Urban zones: {len(zones)} clusters from {len(buildings)} buildings")
    return zones


# ---------------------------------------------------------------------------
# Verified landmarks (real OSM / survey coordinates, Feature 38)
# ---------------------------------------------------------------------------
# Bridge/dam axis convention: model length runs along local X, i.e. world
# direction (cos(rot), -sin(rot)).  For a bridge crossing a river the local X
# azimuth = 90 deg - rot.
RAW_LANDMARKS = [
    # Sveta Gora basilica: true 681 m peak summit (45.9993°N, 13.6557°E).
    {"id": "sveta-gora", "name": "Sveta Gora Basilica", "kind": "church",
     "ll": (45.9993, 13.6557), "rot": 0.4, "scale": 1.35},
    # Solkan stone arch bridge, real center 45.9781,13.6506.  The Soča runs
    # WSW through the gorge here, so the bank-to-bank normal (dz/dx 0.718/0.696)
    # is local X at 135.8 deg azimuth -> rot -0.80.  Centre sits on the river
    # at x ~ -18325, not 120 m east on the Solkan town road.
    {"id": "solkan-bridge", "name": "Solkan Stone Arch Bridge", "kind": "bridge",
     "ll": (45.9781, 13.6506), "rot": -0.80, "length": 220, "height": 36},
    # HE Solkan dam (OSM way 427961750, 45.98436,13.65479); dam wall axis
    # az ~60 deg, perpendicular to the south-flowing Soča.
    {"id": "solkan-dam", "name": "Solkan Hydro Dam", "kind": "dam",
     "ll": (45.98436, 13.65479), "rot": 0.517, "length": 115, "height": 24},
    # Pregrada Vogršček (OSM way 407464561, 45.90571,13.72588); real crest is
    # ~170 m long running N-S (az ~4 deg) along the reservoir's east side.
    {"id": "vogrscek-dam", "name": "Vogrscek Dam", "kind": "dam",
     "ll": (45.90571, 13.72588), "rot": 1.504, "length": 170, "height": 32},
    {"id": "nanos-tower", "name": "Nanos Broadcast Tower (Plesa)", "kind": "tower",
     "ll": (45.7717, 14.0533), "rot": 0, "height": 95},
    {"id": "gorizia-castle", "name": "Gorizia Castle", "kind": "castle",
     "ll": (45.9442, 13.6295), "rot": 0.3, "scale": 1.25},
    {"id": "kostanjevica", "name": "Kostanjevica Monastery", "kind": "church",
     "ll": (45.9467, 13.6386), "rot": 0.8, "scale": 1.05},
    {"id": "faro-vittoria", "name": "Faro della Vittoria (Trieste)",
     "kind": "lighthouse", "ll": (45.6753, 13.7575), "rot": 0, "height": 68},
    {"id": "piran-belltower", "name": "St. George Bell Tower (Piran)",
     "kind": "church", "ll": (45.5292, 13.5689), "rot": 0.2, "scale": 1.15},
    {"id": "predjama-castle", "name": "Predjama Castle", "kind": "castle",
     "ll": (45.8156, 14.1267), "rot": 1.1, "scale": 1.15},
    {"id": "stanjel-castle", "name": "Stanjel Hilltop Village", "kind": "castle",
     "ll": (45.8236, 13.8453), "rot": 0.5, "scale": 1.1},
    # H4 viaduct over the Vipava river (OSM trunk bridges 121820005/121820009,
    # center 45.8448,13.9507).  The H4 runs az ~340 deg there => rot -1.222.
    {"id": "vipava-bridge", "name": "Vipava H4 Viaduct", "kind": "bridge",
     "ll": (45.8448, 13.9507), "rot": -1.222, "length": 170, "height": 26},
]


def build_landmarks():
    landmarks = []
    for lm in RAW_LANDMARKS:
        x, z = ll_to_xz(*lm["ll"])
        entry = {k: v for k, v in lm.items() if k != "ll"}
        entry["x"] = round(x, 1)
        entry["z"] = round(z, 1)
        landmarks.append(entry)
    print(f"Landmarks: {len(landmarks)} verified entries")
    return landmarks


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_binary(buildings):
    records = sorted(buildings, key=lambda b: (round(b["z"], 1), round(b["x"], 1),
                                               b["kind"]))
    out = bytearray()
    out.extend(struct.pack("<4sIII", b"FBLD", 1, len(records), 20))
    rot_min = rot_max = records[0]["rot"] if records else 0.0
    for b in records:
        # Keep the quantized int16 rotation strictly inside (-pi, pi); 31414
        # is the largest safe magnitude (quantization step 1e-4 rad).
        rot = max(-3.1414, min(3.1414, b["rot"]))
        rot_min, rot_max = min(rot_min, rot), max(rot_max, rot)
        out.extend(struct.pack(
            "<ffHHHhBBBB",
            b["x"], b["z"],
            int(round(b["w"] * 10)), int(round(b["d"] * 10)),
            int(round(b["h"] * 10)), int(round(rot * 10000)),
            b["kind"], b["roof"], b["tier"], b["seed"],
        ))
    OUT_BIN.write_bytes(bytes(out))
    print(f"Wrote {OUT_BIN.relative_to(ROOT)}: {len(records)} records, "
          f"{len(out)} bytes, rot range {rot_min:.3f}..{rot_max:.3f}")
    return records


def write_json(roads, buildings, landmarks, zones):
    fallback = sorted(buildings, key=lambda b: (-b["tier"],
                                                -(b["area"] * b["h"]),
                                                b["kind"]))[:FALLBACK_BUILDINGS]
    legacy = [[round(b["x"], 1), round(b["z"], 1), round(b["w"], 1),
               round(b["d"], 1), round(b["h"], 1), round(b["rot"], 3), b["kind"]]
              for b in fallback]
    payload = {
        "roads": roads,
        "buildings": legacy,
        "landmarks": landmarks,
        "urbanZones": [[z["x"], z["z"], z["r"], z["d"]] for z in zones],
    }
    OUT_JSON.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {OUT_JSON.relative_to(ROOT)}: {len(roads)} roads, "
          f"{len(legacy)} fallback buildings, {len(zones)} urban zones, "
          f"{len(landmarks)} landmarks")


def coverage_report(buildings):
    print("\nCoverage (buildings within 2.5 km):")
    rows = []
    for name, (lat, lon) in TOWN_PROBES.items():
        x, z = ll_to_xz(lat, lon)
        n = sum(1 for b in buildings if (b["x"] - x) ** 2 + (b["z"] - z) ** 2 <= 2500 ** 2)
        rows.append((name, n))
    rows.sort(key=lambda r: r[1], reverse=True)
    for name, n in rows:
        print(f"  {name:14s} {n:6d}")
    low = [f"{name}({n})" for name, n in rows if n <= 30]
    if low:
        print("  !! LOW COVERAGE:", ", ".join(low))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true",
                        help="ignore the /tmp Overpass cache")
    args = parser.parse_args()
    if args.force:
        for path in CACHE_DIR.glob(f"*_{CACHE_VERSION}.json"):
            path.unlink()
        print("Cache cleared")

    t0 = time.time()
    core, regional = load_buildings(args.force)

    core_sel = stratified_pick(core, CORE_BUDGET)
    print(f"Core selection: {len(core_sel)}/{len(core)} (budget {CORE_BUDGET})")

    regional_sel = []
    for name, _bbox in REGIONAL_BOXES.items():
        items = [b for b in regional if b["box"] == name]
        picked = stratified_pick(items, REGIONAL_CAPS[name])
        print(f"  {name}: {len(picked)}/{len(items)} (cap {REGIONAL_CAPS[name]})")
        regional_sel.extend(picked)

    buildings = core_sel + regional_sel
    print(f"Selected buildings: {len(buildings)} "
          f"(core {len(core_sel)}, regional {len(regional_sel)})")

    roads = load_roads(args.force)
    zones = build_urban_zones(buildings)
    landmarks = build_landmarks()

    records = write_binary(buildings)
    write_json(roads, records, landmarks, zones)
    coverage_report(records)

    print("\nOBB self-check: %d buildings, max forward error %.3e m, "
          "max vertex outside %.3e m" %
          (OBB_STATS["buildings"], OBB_STATS["max_forward_err"],
           OBB_STATS["max_outside"]))
    print("Elapsed: %.1f s" % (time.time() - t0))


if __name__ == "__main__":
    main()