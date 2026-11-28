"""Bake the 500 x 500 km macro AWS Terrarium DEM ring for the Vipava theater.

Feature 42 (elevation side of "Option C"): a third, coarser tier that lets the
world keep real-world elevation out to 250 km in every direction, on top of the
existing pair baked by scripts/bake_vipava.py:

  * outer regional DEM -> public/media/vipava_dem.png     (100 x 100 km, 2048^2, z=12)
  * inner HD inset     -> public/media/vipava_dem_hd.png  (40 x 30 km,   2048^2, z=13)
  * macro ring         -> public/media/vipava_dem_macro.png (500 x 500 km, 1024^2, z=9)

Everything uses the exact same projection and 16-bit RG encoding consumed by
src/world/dem.js:

    lat = LAT0 - z_m / M_PER_DEG_LAT
    lon = LON0 + x_m / M_PER_DEG_LON
    val = clamp(round((h - offset) * scale), 0, 65535), offset = -200, scale = 16

Beyond the macro ring the browser streams z=9 Terrarium tiles on demand
(StreamingTerrariumDEM in src/world/dem.js), so this bake only has to cover the
+-250 km square.

Run: python3 scripts/bake_vipava_macro.py
"""

import io
import json
import math
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

# --- Identical projection to scripts/bake_vipava.py -------------------------
# Center: Ajdovscina Airfield (LJAJ), Vipava Valley, Slovenia
LAT0 = 45.8878
LON0 = 13.8869

OFFSET = -200.0
SCALE = 16.0

M_PER_DEG_LAT = 111132.92
M_PER_DEG_LON = 111412.84 * math.cos(math.radians(LAT0))

# --- Macro ring: 500 x 500 km at z=9 (~213 m/px at 45.9 deg N) --------------
SIZE_M = 500000.0
X_MIN, X_MAX = -250000.0, 250000.0
Z_MIN, Z_MAX = -250000.0, 250000.0
GRID = 1024
ZOOM = 9

OUT_PNG = "public/media/vipava_dem_macro.png"
META_PATH = "public/media/vipava_meta.json"

TILE_URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"
WORKERS = 12
RETRIES = 5
TILE_SIZE = 256


# ---------------------------------------------------------------------------
# Projection helpers (world metres <-> WGS84), identical to bake_vipava.py
# ---------------------------------------------------------------------------

def latlon_to_tile_xy(lat, lon, z):
    n = 2.0 ** z
    lat_rad = math.radians(lat)
    xt = (lon + 180.0) / 360.0 * n
    yt = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return xt, yt


def world_to_latlon(x_m, z_m):
    # World: +X = East, -Z = North (+Z = South)
    lat = LAT0 - z_m / M_PER_DEG_LAT
    lon = LON0 + x_m / M_PER_DEG_LON
    return lat, lon


def ll_to_xz(lat, lon):
    return round((lon - LON0) * M_PER_DEG_LON), round(-(lat - LAT0) * M_PER_DEG_LAT)


# ---------------------------------------------------------------------------
# Terrarium tile sampler: downloads + stitches a tile window, bilinear reads
# (same algorithm as bake_vipava.py so all three tiers agree pixel-for-pixel)
# ---------------------------------------------------------------------------

class TerrariumSampler:
    def __init__(self, zoom, x_min, x_max, z_min, z_max, label=""):
        self.zoom = zoom
        self.label = label

        lat_n, lon_w = world_to_latlon(x_min, z_min)   # north-west corner
        lat_s, lon_e = world_to_latlon(x_max, z_max)   # south-east corner
        self.lat_n, self.lon_w = lat_n, lon_w
        self.lat_s, self.lon_e = lat_s, lon_e

        x0, y0 = latlon_to_tile_xy(lat_n, lon_w, zoom)
        x1, y1 = latlon_to_tile_xy(lat_s, lon_e, zoom)
        self.tx_min = int(math.floor(x0))
        self.tx_max = int(math.floor(x1))
        self.ty_min = int(math.floor(y0))
        self.ty_max = int(math.floor(y1))

        coords = [
            (tx, ty)
            for tx in range(self.tx_min, self.tx_max + 1)
            for ty in range(self.ty_min, self.ty_max + 1)
        ]
        print(f"[{label}] downloading {len(coords)} Terrarium tiles at z={zoom} "
              f"(x {self.tx_min}..{self.tx_max}, y {self.ty_min}..{self.ty_max}) ...")
        t0 = time.time()
        tiles = {}
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for coord, img in ex.map(self._fetch, coords):
                tiles[coord] = img
        print(f"[{label}] downloaded {len(tiles)} tiles in {time.time() - t0:.1f}s")
        self.tile_count = len(tiles)

        self.tw = (self.tx_max - self.tx_min + 1) * TILE_SIZE
        self.th = (self.ty_max - self.ty_min + 1) * TILE_SIZE
        self.mosaic = Image.new("RGB", (self.tw, self.th))
        for (tx, ty), img in tiles.items():
            self.mosaic.paste(img, ((tx - self.tx_min) * TILE_SIZE,
                                    (ty - self.ty_min) * TILE_SIZE))

        self._px_base = self.tx_min * TILE_SIZE
        self._py_base = self.ty_min * TILE_SIZE

    def _fetch(self, coord):
        tx, ty = coord
        url = TILE_URL.format(z=self.zoom, x=tx, y=ty)
        last_err = None
        for attempt in range(RETRIES):
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": "falcon-infinite-dem-baker/1.2"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    img = Image.open(io.BytesIO(resp.read())).convert("RGB")
                if img.size != (TILE_SIZE, TILE_SIZE):
                    raise ValueError(f"tile {coord} is {img.size}, expected 256x256")
                return coord, img
            except Exception as err:  # noqa: BLE001 - retry any transport failure
                last_err = err
                time.sleep(0.4 * (attempt + 1))
        raise RuntimeError(f"failed to fetch {url}: {last_err}")

    # -- coordinate helpers --------------------------------------------------
    def lon_to_px(self, lon):
        px = (lon + 180.0) / 360.0 * (2.0 ** self.zoom) * TILE_SIZE
        return px - self._px_base

    def lat_to_py(self, lat):
        lat_rad = math.radians(lat)
        py = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 \
            * (2.0 ** self.zoom) * TILE_SIZE
        return py - self._py_base

    def _row_heights(self, iy):
        """Decode two mosaic rows (iy, iy+1) into terrarium elevations."""
        tw = self.tw
        raw = memoryview(self.mosaic.crop((0, iy, tw, iy + 2)).tobytes())

        def decode(off):
            return [(raw[o] * 256 + raw[o + 1] + raw[o + 2] / 256.0) - 32768.0
                    for o in range(off, off + tw * 3, 3)]

        return decode(0), decode(tw * 3)

    def sample(self, lat, lon):
        """Bilinear terrarium elevation (metres) at (lat, lon)."""
        px = self.lon_to_px(lon)
        py = self.lat_to_py(lat)
        ix = max(0, min(self.tw - 2, int(math.floor(px))))
        iy = max(0, min(self.th - 2, int(math.floor(py))))
        fx = max(0.0, min(1.0, px - ix))
        fy = max(0.0, min(1.0, py - iy))
        top, bot = self._row_heights(iy)
        a = top[ix] + (top[ix + 1] - top[ix]) * fx
        b = bot[ix] + (bot[ix + 1] - bot[ix]) * fx
        return a + (b - a) * fy

    # -- baked grid ----------------------------------------------------------
    def bake(self, x_min, x_max, z_min, z_max, grid, label=""):
        """Resample the mosaic into a `grid` x `grid` 16-bit RG PNG."""
        t0 = time.time()
        cols = []
        for i in range(grid):
            x = x_min + (i / (grid - 1)) * (x_max - x_min)
            px = self.lon_to_px(LON0 + x / M_PER_DEG_LON)
            ix = max(0, min(self.tw - 2, int(math.floor(px))))
            fx = max(0.0, min(1.0, px - ix))
            cols.append((ix, fx))

        buf = bytearray(grid * grid * 3)
        row_bytes = grid * 3
        min_h, max_h, sea_cells = 1e9, -1e9, 0

        for j in range(grid):
            z = z_min + (j / (grid - 1)) * (z_max - z_min)
            py = self.lat_to_py(LAT0 - z / M_PER_DEG_LAT)
            iy = max(0, min(self.th - 2, int(math.floor(py))))
            fy = max(0.0, min(1.0, py - iy))
            top, bot = self._row_heights(iy)

            ti = [top[ix] + (top[ix + 1] - top[ix]) * fx for ix, fx in cols]
            bi = [bot[ix] + (bot[ix + 1] - bot[ix]) * fx for ix, fx in cols]

            row = bytearray(row_bytes)
            lo_h, hi_h, sea_row = 1e9, -1e9, 0
            for i, (a, b) in enumerate(zip(ti, bi)):
                h = a + (b - a) * fy
                if h < lo_h:
                    lo_h = h
                if h > hi_h:
                    hi_h = h
                if h <= 0.5:
                    sea_row += 1
                v = int(round((h - OFFSET) * SCALE))
                if v < 0:
                    v = 0
                elif v > 65535:
                    v = 65535
                o = i * 3
                row[o] = v >> 8
                row[o + 1] = v & 255

            base = j * row_bytes
            buf[base:base + row_bytes] = row
            if lo_h < min_h:
                min_h = lo_h
            if hi_h > max_h:
                max_h = hi_h
            sea_cells += sea_row

            if j % 128 == 0:
                print(f"[{label}] row {j:4d}/{grid}  h {lo_h:8.1f} .. {hi_h:8.1f} m")

        img = Image.frombytes("RGB", (grid, grid), bytes(buf))
        stats = {
            "min": min_h,
            "max": max_h,
            "sea": sea_cells / (grid * grid),
            "seconds": time.time() - t0,
        }
        return img, stats


# ---------------------------------------------------------------------------
# Bake the macro ring
# ---------------------------------------------------------------------------
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

sampler = TerrariumSampler(ZOOM, X_MIN, X_MAX, Z_MIN, Z_MAX, label="macro")
macro_img, macro_stats = sampler.bake(X_MIN, X_MAX, Z_MIN, Z_MAX, GRID, label="macro")
macro_img.save(OUT_PNG, optimize=True)
size_bytes = os.path.getsize(OUT_PNG)
spacing = SIZE_M / (GRID - 1)
print(f"Baked {OUT_PNG}: min={macro_stats['min']:.1f}m max={macro_stats['max']:.1f}m "
      f"sea={macro_stats['sea'] * 100:.1f}% {spacing:.1f} m/px "
      f"({size_bytes / 1e6:.2f} MB, {sampler.tile_count} tiles, "
      f"{macro_stats['seconds']:.1f}s)")


# ---------------------------------------------------------------------------
# Read side of the baked PNG (bilinear on the 16-bit RG grid) for the audit
# ---------------------------------------------------------------------------

class BakedReader:
    def __init__(self, path, x_min, x_max, z_min, z_max, offset, scale):
        self.img = Image.open(path).convert("RGB")
        self.grid = self.img.width
        self.raw = self.img.tobytes()  # 3 bytes per pixel, row-major
        self.x_min, self.x_max = x_min, x_max
        self.z_min, self.z_max = z_min, z_max
        self.offset, self.scale = offset, scale

    def _val(self, ix, iy):
        o = (iy * self.grid + ix) * 3
        return ((self.raw[o] << 8) | self.raw[o + 1]) / self.scale + self.offset

    def sample_xz(self, x, z):
        u = (x - self.x_min) / (self.x_max - self.x_min) * (self.grid - 1)
        v = (z - self.z_min) / (self.z_max - self.z_min) * (self.grid - 1)
        u = max(0.0, min(self.grid - 1, u))
        v = max(0.0, min(self.grid - 1, v))
        x0, y0 = int(math.floor(u)), int(math.floor(v))
        x1, y1 = min(x0 + 1, self.grid - 1), min(y0 + 1, self.grid - 1)
        fx, fy = u - x0, v - y0
        a = self._val(x0, y0) + (self._val(x1, y0) - self._val(x0, y0)) * fx
        b = self._val(x0, y1) + (self._val(x1, y1) - self._val(x0, y1)) * fx
        return a + (b - a) * fy

    def sample_ll(self, lat, lon):
        x, z = ll_to_xz(lat, lon)
        return self.sample_xz(x, z)


reader = BakedReader(OUT_PNG, X_MIN, X_MAX, Z_MIN, Z_MAX, OFFSET, SCALE)

LANDMARKS = [
    # name, lat, lon, expected predicate + description
    ("Venice lagoon (0 m)", 45.4300, 12.3400, lambda h: -3.0 <= h <= 8.0),
    ("Marmolada / Dolomites (>2200 m)", 46.4343, 11.8506, lambda h: h > 2200.0),
    ("Triglav (>2200 m)", 46.3785, 13.8364, lambda h: h > 2200.0),
    ("Grossglockner (>3000 m)", 47.0745, 12.6943, lambda h: h > 3000.0),
    ("Adriatic open sea (<=0 m)", 44.8000, 13.2000, lambda h: h <= 0.5),
    ("Wiener Neustadt / E Alps (~200-400 m)", 47.8100, 16.2500, lambda h: 100.0 <= h <= 700.0),
]

print("\nMacro ring landmark audit:")
landmark_failures = []
for name, lat, lon, ok in LANDMARKS:
    h = reader.sample_ll(lat, lon)
    x, z = ll_to_xz(lat, lon)
    status = "ok " if ok(h) else "BAD"
    print(f"  [{status}] {name:44s} {h:8.1f} m  at world ({x}, {z}) m")
    if not ok(h):
        landmark_failures.append(name)


# ---------------------------------------------------------------------------
# Metadata: add ONLY the "macro" block, preserving every existing key
# ---------------------------------------------------------------------------
with open(META_PATH) as f:
    meta = json.load(f)

meta["macro"] = {
    "url": "./media/vipava_dem_macro.png",
    "grid": GRID,
    "xMin": X_MIN,
    "xMax": X_MAX,
    "zMin": Z_MIN,
    "zMax": Z_MAX,
    "blendM": 20000.0,
    "offset": OFFSET,
    "scale": SCALE,
}
with open(META_PATH, "w") as f:
    json.dump(meta, f, indent=2)

print(f"\nUpdated {META_PATH}: keys = {sorted(meta.keys())}")
print(f"Macro tier: {GRID}x{GRID} @ {spacing:.1f} m/px, {SIZE_M / 1000:.0f} km square, "
      f"z={ZOOM}, {size_bytes / 1e6:.2f} MB")

if landmark_failures:
    raise SystemExit("Macro DEM landmark audit failed: " + ", ".join(landmark_failures))
print("Macro DEM landmark audit passed.")