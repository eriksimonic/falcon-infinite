"""Bake real satellite ortho-imagery for the Vipava Valley theater.

Feature 38: three identical-frame RGB tiers, pixel-for-pixel aligned to the
three baked DEM tiers produced by scripts/bake_vipava.py:

  * HD valley   -> public/media/vipava_ortho_hd.jpg    40 x 30 km, 4096x3072, z13
  * Regional    -> public/media/vipava_ortho.jpg       100 x 100 km, 2048^2, z11
  * Macro       -> public/media/vipava_ortho_macro.jpg 500 x 500 km, 2048^2, z9

Source: Esri World Imagery (note the /{z}/{y}/{x} tile scheme, y before x!).

World projection is shared with the DEM baker:
    +X = East, -Z = North
    lat = LAT0 - z / M_PER_DEG_LAT
    lon = LON0 + x / M_PER_DEG_LON

Texture orientation (must stay in lockstep with src/world/terrainview.js):
    texel (0, 0)              = (xMin, zMin)  = NORTH-WEST
    texel (W-1, H-1)          = (xMax, zMax)  = SOUTH-EAST
    sampled with THREE.Texture.flipY = false and
    uv = ((x - xMin) / (xMax - xMin), (z - zMin) / (zMax - zMin))

Why per-row sampling: Web Mercator y is nonlinear over 500 km, so a plain
uniform resize would drift by tens of metres at the top/bottom edges. Mapping
every output row through the exact Mercator latitude keeps alignment sub-pixel,
while the horizontal axis is affine in Mercator and therefore exact as a single
bilinear scale. No numpy is required (not installed on this machine).

Run:
    python3 scripts/bake_vipava_ortho.py
"""

import io
import json
import math
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

# Center: Ajdovscina Airfield (LJAJ), Vipava Valley, Slovenia
LAT0 = 45.8878
LON0 = 13.8869

M_PER_DEG_LAT = 111132.92
M_PER_DEG_LON = 111412.84 * math.cos(math.radians(LAT0))

WORKERS = 8
RETRIES = 4
TILE_SIZE = 256
UA = ("Mozilla/5.0 (X11; Linux x86_64) falcon-infinite-ortho-baker/1.0 "
      "(+https://falcon-infinite.local)")
TILE_URL = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
            "World_Imagery/MapServer/tile/{z}/{y}/{x}")

OUT_DIR = "public/media"

# name, path, xMin, xMax, zMin, zMax, zoom, width, height, jpeg quality, blendM
TIERS = [
    ("hd", "vipava_ortho_hd.jpg",
     -25000.0, 15000.0, -15000.0, 15000.0, 13, 4096, 3072, 84, 1500.0),
    ("regional", "vipava_ortho.jpg",
     -50000.0, 50000.0, -50000.0, 50000.0, 11, 2048, 2048, 82, 6000.0),
    ("macro", "vipava_ortho_macro.jpg",
     -250000.0, 250000.0, -250000.0, 250000.0, 9, 2048, 2048, 80, 20000.0),
]


# ---------------------------------------------------------------------------
# Projection helpers (world metres <-> WGS84 <-> Mercator tile pixels)
# ---------------------------------------------------------------------------

def latlon_to_tile_xy(lat, lon, z):
    n = 2.0 ** z
    lat_rad = math.radians(lat)
    xt = (lon + 180.0) / 360.0 * n
    yt = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return xt, yt


def world_to_latlon(x_m, z_m):
    lat = LAT0 - z_m / M_PER_DEG_LAT
    lon = LON0 + x_m / M_PER_DEG_LON
    return lat, lon


def latlon_to_world(lat, lon):
    return (lon - LON0) * M_PER_DEG_LON, -(lat - LAT0) * M_PER_DEG_LAT


# ---------------------------------------------------------------------------
# Esri World Imagery mosaic
# ---------------------------------------------------------------------------

class EsriMosaic:
    """Downloads and stitches the Esri tile window covering a world rectangle."""

    def __init__(self, zoom, x_min, x_max, z_min, z_max, label=""):
        self.zoom = zoom
        self.label = label

        self.lat_n, self.lon_w = world_to_latlon(x_min, z_min)
        self.lat_s, self.lon_e = world_to_latlon(x_max, z_max)

        x0, y0 = latlon_to_tile_xy(self.lat_n, self.lon_w, zoom)
        x1, y1 = latlon_to_tile_xy(self.lat_s, self.lon_e, zoom)
        self.tx_min = int(math.floor(x0))
        self.tx_max = int(math.floor(x1))
        self.ty_min = int(math.floor(y0))
        self.ty_max = int(math.floor(y1))

        coords = [
            (tx, ty)
            for ty in range(self.ty_min, self.ty_max + 1)
            for tx in range(self.tx_min, self.tx_max + 1)
        ]
        print(f"[{label}] fetching {len(coords)} Esri imagery tiles at z={zoom} "
              f"(x {self.tx_min}..{self.tx_max}, y {self.ty_min}..{self.ty_max}) ...")
        t0 = time.time()
        tiles = {}
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for coord, img in ex.map(self._fetch, coords):
                tiles[coord] = img
        print(f"[{label}] downloaded in {time.time() - t0:.1f}s")

        self.tw = (self.tx_max - self.tx_min + 1) * TILE_SIZE
        self.th = (self.ty_max - self.ty_min + 1) * TILE_SIZE
        self.mosaic = Image.new("RGB", (self.tw, self.th), (12, 24, 36))
        for (tx, ty), img in tiles.items():
            self.mosaic.paste(img, ((tx - self.tx_min) * TILE_SIZE,
                                    (ty - self.ty_min) * TILE_SIZE))

        self._px_base = self.tx_min * TILE_SIZE
        self._py_base = self.ty_min * TILE_SIZE

    def _fetch(self, coord):
        tx, ty = coord
        url = TILE_URL.format(z=self.zoom, y=ty, x=tx)
        last_err = None
        for attempt in range(RETRIES):
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": UA, "Accept": "image/jpeg,image/*"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    body = resp.read()
                if not body:
                    raise ValueError("empty response body")
                img = Image.open(io.BytesIO(body)).convert("RGB")
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


def bake_tier(mosaic, x_min, x_max, z_min, z_max, width, height, label=""):
    """Resample the mosaic into an exact world-rect RGB image.

    Row j maps through the *actual* Mercator latitude for its world z, so the
    vertical axis is exact at every row; the horizontal axis is affine in
    Mercator, so one bilinear affine transform covers it exactly.
    """
    t0 = time.time()
    tw, th, src = mosaic.tw, mosaic.th, mosaic.mosaic

    # Vertical pass: one exact blended source row per output row.
    vertical = Image.new("RGB", (tw, height))
    for j in range(height):
        z = z_min + (j / (height - 1)) * (z_max - z_min)
        lat = LAT0 - z / M_PER_DEG_LAT
        py = mosaic.lat_to_py(lat)
        if py < 0.0:
            py = 0.0
        elif py > th - 1.0:
            py = th - 1.0
        iy = int(math.floor(py))
        if iy > th - 2:
            iy = max(0, th - 2)
        fy = py - iy
        row = src.crop((0, iy, tw, iy + 1))
        if fy > 1e-4 and iy + 1 < th:
            row2 = src.crop((0, iy + 1, tw, iy + 2))
            row = Image.blend(row, row2, fy)
        vertical.paste(row, (0, j))

    # Horizontal pass: single exact affine scale (Mercator x is linear in lon).
    px0 = mosaic.lon_to_px(LON0 + x_min / M_PER_DEG_LON)
    px1 = mosaic.lon_to_px(LON0 + x_max / M_PER_DEG_LON)
    px1 = min(px1, tw - 1.0)
    scale = (px1 - px0) / (width - 1)
    out = vertical.transform(
        (width, height), Image.Transform.AFFINE,
        (scale, 0.0, px0, 0.0, 1.0, 0.0),
        resample=Image.Resampling.BILINEAR,
    )
    print(f"[{label}] resampled {tw}x{th} mosaic -> {width}x{height} "
          f"in {time.time() - t0:.1f}s")
    return out


# ---------------------------------------------------------------------------
# Bake all three tiers
# ---------------------------------------------------------------------------

def sample_tier(img, tier, lat, lon):
    """RGB at a geographic point, using the same uv convention as the shader."""
    x, z = latlon_to_world(lat, lon)
    x_min, x_max = tier["xMin"], tier["xMax"]
    z_min, z_max = tier["zMin"], tier["zMax"]
    if not (x_min <= x <= x_max and z_min <= z <= z_max):
        return None
    u = (x - x_min) / (x_max - x_min)
    v = (z - z_min) / (z_max - z_min)
    px = min(img.width - 1, max(0, int(round(u * (img.width - 1)))))
    py = min(img.height - 1, max(0, int(round(v * (img.height - 1)))))
    return img.getpixel((px, py))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    meta = {}
    baked = {}
    summary = []

    for (key, fname, x_min, x_max, z_min, z_max, zoom,
         width, height, quality, blend_m) in TIERS:
        mosaic = EsriMosaic(zoom, x_min, x_max, z_min, z_max, label=key)
        img = bake_tier(mosaic, x_min, x_max, z_min, z_max, width, height, label=key)
        out_path = os.path.join(OUT_DIR, fname)
        img.save(out_path, format="JPEG", quality=quality, optimize=True,
                 progressive=False)
        size = os.path.getsize(out_path)
        print(f"[{key}] wrote {out_path} ({img.width}x{img.height} RGB, "
              f"q{quality}, {size / 1e6:.2f} MB)")

        meta[key] = {
            "url": f"./media/{fname}",
            "xMin": int(x_min),
            "xMax": int(x_max),
            "zMin": int(z_min),
            "zMax": int(z_max),
            "blendM": int(blend_m),
        }
        baked[key] = (img, meta[key], out_path, size)

    meta_path = os.path.join(OUT_DIR, "vipava_ortho_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
    print(f"wrote {meta_path}")

    # ------------------------------------------------------------------
    # Verification: non-blank, geographically sane RGB at named landmarks
    # ------------------------------------------------------------------
    print("\nLandmark colour checks (uv identical to the shader's mapping):")
    landmarks = [
        # name, lat, lon, expected surface
        ("Ajdovscina town", 45.8869, 13.9090, "town"),
        ("Gulf of Trieste", 45.7000, 13.5500, "water"),
        ("Nanos forest", 45.8330, 14.0200, "forest"),
        ("Triglav / Julian Alps", 46.3783, 13.8364, "rock"),
        ("Venice city", 45.4408, 12.3155, "town"),
        ("N. Adriatic", 45.3000, 12.4500, "water"),
    ]
    failures = []
    checked = 0
    for key, (img, tier_meta, out_path, size) in baked.items():
        extrema = img.convert("RGB").getextrema()
        spread = max(hi - lo for lo, hi in extrema)
        blank = spread < 16
        if blank:
            failures.append(f"{key}: image looks blank (channel spread {spread})")
        print(f"  {key:8s} {img.width}x{img.height} spread={spread:3d} "
              f"blank={blank} size={size / 1e6:.2f} MB")
        for name, lat, lon, kind in landmarks:
            rgb = sample_tier(img, tier_meta, lat, lon)
            if rgb is None:
                continue
            r, g, b = rgb
            lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            if kind == "water":
                ok = b > r + 12 and b >= g and lum < 110
            elif kind == "forest":
                ok = g >= r and g > b and lum < 120
            elif kind == "rock":
                ok = lum > 80 and abs(r - b) < 60
            else:  # town: warm sunlit roofs / limestone, never blue
                ok = lum > 55 and r >= b and r < 235
            checked += 1
            print(f"    {name:24s} RGB={str(rgb):16s} lum={lum:5.1f} "
                  f"{kind:6s} {'OK' if ok else 'SUSPECT'}")
            if not ok:
                failures.append(f"{key}: {name} RGB={rgb} unexpected for {kind}")
    print(f"  landmark samples: {checked}")

    for key, (img, tier_meta, out_path, size) in baked.items():
        print(f"SIZE {tier_meta['url']}: {size} bytes ({size / 1e6:.2f} MB)")

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print("  - " + f)
        raise SystemExit(1)
    print("\nALL ORTHO BAKES VERIFIED")


if __name__ == "__main__":
    main()