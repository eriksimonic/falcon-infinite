"""Bake the Vipava Valley terrain assets.

Feature 37: a dual-resolution nested DEM.

  * outer regional DEM  -> public/media/vipava_dem.png     (100 x 100 km, 2048^2, z=12)
  * inner HD inset      -> public/media/vipava_dem_hd.png  (40 x 30 km,   2048^2, z=13)

Both use the lossless 16-bit RG encoding consumed by src/world/dem.js:
    val = clamp(round((h - offset) * scale), 0, 65535), offset = -200, scale = 16
"""

import io
import json
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

# Center: Ajdovscina Airfield (LJAJ), Vipava Valley, Slovenia
LAT0 = 45.8878
LON0 = 13.8869

# --- Outer regional DEM: 100 x 100 km, zoom 12 (~26.6 m/px at 45.9 deg N) ----
SIZE_M = 100000.0
GRID = 2048
ZOOM = 12

# --- Feature 37 HD inset: Vipava Valley + Soca gorge + Nanos + Stanjel -------
# 40 km East-West x 30 km North-South at 2048^2 -> ~19.5 m x 14.6 m per sample.
HD_XMIN, HD_XMAX = -25000.0, 15000.0
HD_ZMIN, HD_ZMAX = -15000.0, 15000.0
HD_GRID = 2048
HD_ZOOM = 13

OFFSET = -200.0
SCALE = 16.0

M_PER_DEG_LAT = 111132.92
M_PER_DEG_LON = 111412.84 * math.cos(math.radians(LAT0))

WORKERS = 12
RETRIES = 4
TILE_SIZE = 256


# ---------------------------------------------------------------------------
# Projection helpers (world metres <-> WGS84)
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
        print(f"[{label}] downloaded in {time.time() - t0:.1f}s")

        self.tw = (self.tx_max - self.tx_min + 1) * TILE_SIZE
        self.th = (self.ty_max - self.ty_min + 1) * TILE_SIZE
        self.mosaic = Image.new("RGB", (self.tw, self.th))
        for (tx, ty), img in tiles.items():
            self.mosaic.paste(img, ((tx - self.tx_min) * TILE_SIZE,
                                    (ty - self.ty_min) * TILE_SIZE))

        # Precompute the horizontal pixel coordinate for every output column is
        # done per-bake (it depends on the target bounds), so keep the mosaic
        # raw here.
        self._px_base = self.tx_min * TILE_SIZE
        self._py_base = self.ty_min * TILE_SIZE

    def _fetch(self, coord):
        tx, ty = coord
        url = (f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/"
               f"{self.zoom}/{tx}/{ty}.png")
        last_err = None
        for attempt in range(RETRIES):
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": "falcon-infinite-dem-baker/1.1"})
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

            if grid >= 1024 and j % 256 == 0:
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
# Outer regional DEM
# ---------------------------------------------------------------------------
outer = TerrariumSampler(ZOOM, -SIZE_M / 2, SIZE_M / 2, -SIZE_M / 2, SIZE_M / 2,
                         label="outer")
outer_img, outer_stats = outer.bake(-SIZE_M / 2, SIZE_M / 2, -SIZE_M / 2,
                                    SIZE_M / 2, GRID, label="outer")
outer_img.save("public/media/vipava_dem.png", optimize=True)
print(f"Baked public/media/vipava_dem.png: min={outer_stats['min']:.1f}m "
      f"max={outer_stats['max']:.1f}m sea={outer_stats['sea'] * 100:.1f}% "
      f"({outer_stats['seconds']:.1f}s)")

# ---------------------------------------------------------------------------
# Inner HD inset DEM
# ---------------------------------------------------------------------------
hd = TerrariumSampler(HD_ZOOM, HD_XMIN, HD_XMAX, HD_ZMIN, HD_ZMAX, label="hd")
hd_img, hd_stats = hd.bake(HD_XMIN, HD_XMAX, HD_ZMIN, HD_ZMAX, HD_GRID, label="hd")
hd_img.save("public/media/vipava_dem_hd.png", optimize=True)
spacing_x = (HD_XMAX - HD_XMIN) / (HD_GRID - 1)
spacing_z = (HD_ZMAX - HD_ZMIN) / (HD_GRID - 1)
print(f"Baked public/media/vipava_dem_hd.png: min={hd_stats['min']:.1f}m "
      f"max={hd_stats['max']:.1f}m ({spacing_x:.1f}m x {spacing_z:.1f}m/sample, "
      f"{hd_stats['seconds']:.1f}s)")

# ---------------------------------------------------------------------------
# Real landmarks & airports, elevations from the highest-res DEM available
# ---------------------------------------------------------------------------

def best_elevation(lat, lon):
    """Sample the HD inset when the point falls inside it, else the outer DEM."""
    x, z = ll_to_xz(lat, lon)
    if HD_XMIN <= x <= HD_XMAX and HD_ZMIN <= z <= HD_ZMAX:
        return hd.sample(lat, lon)
    return outer.sample(lat, lon)


airports = [
    # LJAJ sits in the open airfield west of downtown Ajdovščina (RWY 08/26, ~1100 m).
    {"id": "LJAJ", "code": "LJAJ", "name": "Ajdovscina Airfield", "ll": (45.8890, 13.8811), "heading": 84, "length": 1100, "width": 28},
    {"id": "LJPO", "code": "LJPO", "name": "Postojna Airfield", "ll": (45.7544, 14.1939), "heading": 100, "length": 1600, "width": 34},
    {"id": "LJDI", "code": "LJDI", "name": "Divaca Airfield", "ll": (45.6761, 13.9947), "heading": 120, "length": 1500, "width": 32},
    {"id": "LIPQ", "code": "LIPQ", "name": "Trieste Friuli Intl", "ll": (45.8275, 13.4722), "heading": 90, "length": 3000, "width": 45},
    {"id": "LJPZ", "code": "LJPZ", "name": "Portoroz Airport", "ll": (45.4733, 13.6150), "heading": 146, "length": 1800, "width": 36},
]
for ap in airports:
    x, z = ll_to_xz(*ap["ll"])
    ap["x"], ap["z"] = x, z
    ap["elevation"] = round(best_elevation(*ap["ll"]), 1)
    del ap["ll"]

meta = {
    "name": "Vipava Valley (100x100 km)",
    "lat0": LAT0,
    "lon0": LON0,
    "sizeM": SIZE_M,
    "grid": GRID,
    "offset": OFFSET,
    "scale": SCALE,
    "minElevation": round(outer_stats["min"], 1),
    "maxElevation": round(outer_stats["max"], 1),
    "seaFraction": round(outer_stats["sea"], 4),
    "hd": {
        "url": "./media/vipava_dem_hd.png",
        "grid": HD_GRID,
        "xMin": HD_XMIN,
        "xMax": HD_XMAX,
        "zMin": HD_ZMIN,
        "zMax": HD_ZMAX,
        "blendM": 1500.0,
        "offset": OFFSET,
        "scale": SCALE,
    },
    "airports": airports,
}
with open("public/media/vipava_meta.json", "w") as f:
    json.dump(meta, f, indent=2)

print(f"HD inset bounds: x {HD_XMIN}..{HD_XMAX} m, z {HD_ZMIN}..{HD_ZMAX} m, "
      f"{HD_GRID}x{HD_GRID} ({spacing_x:.2f} x {spacing_z:.2f} m/sample)")
for ap in airports:
    print(f"  {ap['code']} {ap['name']}: ({ap['x']}, {ap['z']}) elev={ap['elevation']}m")