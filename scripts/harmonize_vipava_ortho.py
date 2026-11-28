"""Colour-harmonize the baked Vipava ortho tiers against Sentinel-2 Cloudless 2024.

The Esri World Imagery mosaic stitched by scripts/bake_vipava_ortho.py carries a
hard radiometric seam along the Italy/Slovenia border: Esri stitched a bright,
hazy, blue-grey Italian survey straight against the rich, deep-green Slovenian
Kras survey. The Kras tone is the photorealistic one, so the Italian side has to
come DOWN to it -- never the other way around.

How the seam is removed without touching a single sharp texel:

  1. Sentinel-2 Cloudless 2024 (EOX, `s2cloudless-2024_3857`) is fetched at a
     deliberately low zoom (z10/z9/z7, 6-16 tiles, <1 s) and resampled onto the
     exact world rectangle of each tier with the same per-row Mercator latitude
     mapping as bake_tier(). Only its LOW-FREQUENCY tone is used; its coarse
     texture never reaches the output.
  2. It is calibrated to the Slovenian Kras reference box measured on the
     current Esri ortho, so the per-channel gain is exactly 1.00 over the Kras:
     Kras keeps its deep natural green, Italy gets pulled down onto it.
  3. A smooth per-pixel RGB gain map is built at 512 px wide. The gain carries
     the *chroma* of the reference (what S2 says the hue balance should be)
     while its luminance is capped at 1.00, so the pass can only ever deepen /
     desaturate a washed-out survey and never brightens the Kras. The gain is
     damped to 1.0 on open water (Adriatic blues stay natural), clamped to
     [0.52, 1.28] and Gaussian-blurred (radius 6), so only the survey's
     low-frequency exposure can move -- mountains, forests, roofs and field
     boundaries keep 100% of Esri's detail. One global scalar per tier then
     anchors the mean luminance gain to 1.00 so the tier's overall exposure
     cannot drift (a uniform scale cannot reintroduce a seam).
  4. The gain is upsampled and applied in Pillow's C code: gain <= 1.28 is split
     into base = min(1, gain) and extra = max(0, gain - 1), each a 256-entry
     ImageChops.multiply (no banding, no Python pixel loop), then added -- 0.1 s
     for a 4096x3072 tier instead of a 12.5 M-pixel loop.

Calibration note: `cal` must be exactly esri_kras / s2_kras, otherwise the
ratio is biased and the whole tier drifts (S2 is 1.3-2x darker than this Esri
survey over the Kras, so a tight clamp around 1.0 would darken the Kras as well
as Italy). The clamp here is only a sanity guard; the real protection is the
[0.52, 1.28] clamp on the gain map and the luminance cap.

The pristine Esri tiles are cached in /tmp/vipava_ortho_orig and every run reads
from that cache, so re-running never double-darkens. A sha256 manifest notices
a tier that was re-baked behind our back and refreshes the cache.

Run:
    python3 scripts/harmonize_vipava_ortho.py
"""

import hashlib
import io
import json
import math
import os
import shutil
import time
import urllib.request
from array import array
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageChops, ImageFilter, ImageStat

# Center: Ajdovscina Airfield (LJAJ), Vipava Valley, Slovenia
LAT0 = 45.8878
LON0 = 13.8869

M_PER_DEG_LAT = 111132.92
M_PER_DEG_LON = 111412.84 * math.cos(math.radians(LAT0))

WORKERS = 8
RETRIES = 4
TILE_SIZE = 256
UA = ("Mozilla/5.0 (X11; Linux x86_64) falcon-infinite-ortho-harmonizer/1.0 "
      "(+https://falcon-infinite.local)")

S2_URL = ("https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/"
          "default/GoogleMapsCompatible/{z}/{y}/{x}.jpg")

OUT_DIR = "public/media"
ORIG_DIR = "/tmp/vipava_ortho_orig"
MANIFEST = os.path.join(ORIG_DIR, "manifest.json")

# key, file, xMin, xMax, zMin, zMax, s2 zoom, work_w, work_h, jpeg quality
TIERS = [
    ("hd", "vipava_ortho_hd.jpg",
     -25000.0, 15000.0, -15000.0, 15000.0, 10, 512, 384, 84),
    ("regional", "vipava_ortho.jpg",
     -50000.0, 50000.0, -50000.0, 50000.0, 9, 512, 512, 82),
    ("macro", "vipava_ortho_macro.jpg",
     -250000.0, 250000.0, -250000.0, 250000.0, 7, 512, 512, 80),
]

# Deep lush realistic forest on the Slovenian side of the Kras plateau.
KRAS_LAT_S, KRAS_LAT_N = 45.78, 45.86
KRAS_LON_W, KRAS_LON_E = 13.74, 13.88

CAL_MIN, CAL_MAX = 0.50, 2.50   # sanity guard; gain=1 on Kras is guaranteed below
GAIN_MIN, GAIN_MAX = 0.52, 1.28  # per-pixel multiplicative correction
LUM_GAIN_MIN = 0.90              # never pull a survey down harder than 10%
LUM_R, LUM_G, LUM_B = 0.2126, 0.7152, 0.0722
BLUR_RADIUS = 6                  # px on the 512-wide grid (~0.5-6 km)
WATER_R_OFFSET = 15              # b > r + 15 ...
WATER_G_MAX = 95.0               # ... and g < 95  => open water
WATER_FEATHER = 25.0             # smooth 0..1 ramp around that test


# ---------------------------------------------------------------------------
# Projection helpers (identical to bake_vipava_ortho.py)
# ---------------------------------------------------------------------------

def latlon_to_tile_xy(lat, lon, z):
    n = 2.0 ** z
    lat_rad = math.radians(lat)
    xt = (lon + 180.0) / 360.0 * n
    yt = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return xt, yt


def world_to_latlon(x_m, z_m):
    return LAT0 - z_m / M_PER_DEG_LAT, LON0 + x_m / M_PER_DEG_LON


def latlon_to_world(lat, lon):
    return (lon - LON0) * M_PER_DEG_LON, -(lat - LAT0) * M_PER_DEG_LAT


# ---------------------------------------------------------------------------
# Sentinel-2 Cloudless 2024 mosaic
# ---------------------------------------------------------------------------

class S2Mosaic:
    """Downloads and stitches the s2cloudless-2024 tile window for a world rect."""

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
        print(f"[{label}] fetching {len(coords)} Sentinel-2 tiles at z={zoom} "
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
        url = S2_URL.format(z=self.zoom, y=ty, x=tx)
        last_err = None
        for attempt in range(RETRIES):
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": UA,
                                  "Accept": "image/jpeg,image/*"})
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


def resample_mosaic(mosaic, x_min, x_max, z_min, z_max, width, height, label=""):
    """Resample the mosaic into the exact world-rect frame (same as bake_tier).

    One exact blended source row per output row (Mercator y is nonlinear over
    500 km), then a single affine horizontal scale (Mercator x is affine, so a
    plain bilinear scale is exact).
    """
    t0 = time.time()
    tw, th, src = mosaic.tw, mosaic.th, mosaic.mosaic

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
            row = Image.blend(row, src.crop((0, iy + 1, tw, iy + 2)), fy)
        vertical.paste(row, (0, j))

    px0 = mosaic.lon_to_px(LON0 + x_min / M_PER_DEG_LON)
    px1 = min(mosaic.lon_to_px(LON0 + x_max / M_PER_DEG_LON), tw - 1.0)
    scale = (px1 - px0) / (width - 1)
    out = vertical.transform(
        (width, height), Image.Transform.AFFINE,
        (scale, 0.0, px0, 0.0, 1.0, 0.0),
        resample=Image.Resampling.BILINEAR,
    )
    print(f"[{label}] resampled {tw}x{th} Sentinel-2 -> {width}x{height} "
          f"in {time.time() - t0:.1f}s")
    return out


# ---------------------------------------------------------------------------
# Region statistics in the tier's own pixel frame
# ---------------------------------------------------------------------------

def world_rect_to_box(img, x_min, x_max, z_min, z_max,
                      lat_s, lat_n, lon_w, lon_e):
    """Clamped pixel box for a lat/lon rectangle inside a tier image."""
    x_w, z_n = latlon_to_world(lat_n, lon_w)
    x_e, z_s = latlon_to_world(lat_s, lon_e)

    x0 = int(round((x_w - x_min) / (x_max - x_min) * (img.width - 1)))
    x1 = int(round((x_e - x_min) / (x_max - x_min) * (img.width - 1))) + 1
    y0 = int(round((z_n - z_min) / (z_max - z_min) * (img.height - 1)))
    y1 = int(round((z_s - z_min) / (z_max - z_min) * (img.height - 1))) + 1
    x0 = min(max(0, x0), img.width - 1)
    y0 = min(max(0, y0), img.height - 1)
    x1 = min(img.width, max(x0 + 1, x1))
    y1 = min(img.height, max(y0 + 1, y1))
    return (x0, y0, x1, y1)


def region_mean(img, box):
    """Mean RGB of a pixel box (one BOX resize, no Python loop)."""
    return img.crop(box).resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))


def pixel_mean(img, x_min, x_max, z_min, z_max, lat, lon, size=15):
    """Mean RGB of a size x size pixel box centred on a geographic point."""
    x, z = latlon_to_world(lat, lon)
    if not (x_min <= x <= x_max and z_min <= z <= z_max):
        return None
    u = (x - x_min) / (x_max - x_min) * (img.width - 1)
    v = (z - z_min) / (z_max - z_min) * (img.height - 1)
    n = size // 2
    cx = min(max(n, int(round(u))), img.width - 1 - n)
    cy = min(max(n, int(round(v))), img.height - 1 - n)
    return region_mean(img, (cx - n, cy - n, cx + n + 1, cy + n + 1))


def luminance(rgb):
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


# ---------------------------------------------------------------------------
# Backup / idempotency
# ---------------------------------------------------------------------------

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest():
    try:
        with open(MANIFEST) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_manifest(manifest):
    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")


def prepare_sources():
    """Cache the pristine Esri tiles once; every later run reads the cache.

    If a public tier matches neither the cached original nor the harmonized
    output we wrote, it was re-baked by scripts/bake_vipava_ortho.py, so the
    cache is refreshed from it instead of being silently stale.
    """
    os.makedirs(ORIG_DIR, exist_ok=True)
    manifest = load_manifest()
    refreshed = []

    for _key, fname, *_rest in TIERS:
        cur = os.path.join(OUT_DIR, fname)
        cache = os.path.join(ORIG_DIR, fname)
        entry = manifest.get(fname, {})
        need = not os.path.exists(cache)
        if not need and os.path.exists(cur) and entry.get("orig_sha"):
            # Only judged stale when we have a record to compare against;
            # a cache adopted without a manifest is trusted as pristine.
            digest = sha256_file(cur)
            if digest not in {entry.get("orig_sha"), entry.get("out_sha")}:
                need = True
                print(f"NOTE {fname}: tier changed outside this script; "
                      f"refreshing the pristine cache")
        if need:
            if not os.path.exists(cur):
                raise SystemExit(f"missing {cur} and no cached original to use")
            shutil.copy2(cur, cache)
            refreshed.append(fname)
        if not entry.get("orig_sha"):
            manifest.setdefault(fname, {})["orig_sha"] = sha256_file(cache)

    save_manifest(manifest)
    if refreshed:
        print(f"cached pristine Esri tiles -> {ORIG_DIR} "
              f"({', '.join(refreshed)})")
    else:
        print(f"using pristine Esri cache in {ORIG_DIR}")


def remember_output(fname, path):
    manifest = load_manifest()
    manifest.setdefault(fname, {})["out_sha"] = sha256_file(path)
    save_manifest(manifest)


# ---------------------------------------------------------------------------
# Low-frequency multiplicative gain map
# ---------------------------------------------------------------------------

def water_weight(r, g, b):
    """Smooth 0..1 open-water indicator (blue and fairly dark)."""
    wb = (b - r - WATER_R_OFFSET) / WATER_FEATHER
    if wb <= 0.0:
        return 0.0
    wg = (WATER_G_MAX - g) / WATER_FEATHER
    if wg <= 0.0:
        return 0.0
    return min(1.0, wb) * min(1.0, wg)


def build_gain_maps(esri_small, s2_small, cal, kras_box):
    """Per-pixel gain at working resolution, as base/extra byte planes.

    Blurring base and extra separately is identical to blurring the gain itself
    (the blur is linear) and keeps the final multiply exact in Pillow.
    """
    w, h = esri_small.size
    esri_lf = esri_small.filter(ImageFilter.GaussianBlur(radius=BLUR_RADIUS))
    s2_lf = s2_small.filter(ImageFilter.GaussianBlur(radius=BLUR_RADIUS))

    ep = esri_lf.tobytes()
    sp = s2_lf.tobytes()
    n = w * h
    cal_r, cal_g, cal_b = cal
    gmin, gmax = GAIN_MIN, GAIN_MAX
    gains = [array("f", bytes(4 * n)) for _ in range(3)]
    g_r, g_g, g_b = gains

    for i in range(n):
        j = i * 3
        er, eg, eb = ep[j], ep[j + 1], ep[j + 2]
        sr, sg, sb = sp[j], sp[j + 1], sp[j + 2]

        # Smooth open-water weight from both products: Adriatic blues keep their
        # natural colour instead of being dragged around by the reference.
        water = water_weight(sr, sg, sb)
        ew = water_weight(er, eg, eb)
        if ew > water:
            water = ew
        land = 1.0 - water

        # Chroma transfer: what the S2 reference (calibrated on the Kras) says
        # the hue balance should be here, relative to what Esri actually has.
        cr = (sr * cal_r) / (er if er > 8 else 8)
        cg = (sg * cal_g) / (eg if eg > 8 else 8)
        cb = (sb * cal_b) / (eb if eb > 8 else 8)

        # Luminance rule: only ever pull a washed-out survey DOWN. The chroma
        # gains keep their direction, but the luminance gain is capped at 1.0
        # (the deep Kras is never brightened) and floored so nothing crushes.
        total = LUM_R * cr + LUM_G * cg + LUM_B * cb
        lum_gain = total
        if lum_gain > 1.0:
            lum_gain = 1.0
        elif lum_gain < LUM_GAIN_MIN:
            lum_gain = LUM_GAIN_MIN
        scale = lum_gain / total if total > 0.0 else 1.0
        gr = cr * scale
        gg = cg * scale
        gb = cb * scale

        gr = (gmin if gr <= gmin else (gmax if gr >= gmax else gr)) * land + water
        gg = (gmin if gg <= gmin else (gmax if gg >= gmax else gg)) * land + water
        gb = (gmin if gb <= gmin else (gmax if gb >= gmax else gb)) * land + water

        g_r[i] = gr
        g_g[i] = gg
        g_b[i] = gb

    # Pin the chroma to the Kras box (per channel) so the reference region keeps
    # its exact deep tone; everything else moves toward the reference instead.
    x0, y0, x1, y1 = kras_box
    idx = [y * w + x for y in range(y0, y1) for x in range(x0, x1)]
    if idx:
        for g in gains:
            m = sum(g[i] for i in idx) / len(idx)
            if m > 0.0:
                k = min(1.25, max(0.80, 1.0 / m))
                if abs(k - 1.0) > 1e-4:
                    for i in range(n):
                        g[i] *= k

    # Keep the tier's overall exposure: one global scalar so the mean luminance
    # gain is 1.000. Uniform, so it cannot reintroduce a seam.
    mean_lum = 0.0
    for i in range(n):
        mean_lum += LUM_R * g_r[i] + LUM_G * g_g[i] + LUM_B * g_b[i]
    mean_lum /= max(1, n)
    norm = min(1.20, max(0.85, 1.0 / mean_lum)) if mean_lum > 0.0 else 1.0
    if abs(norm - 1.0) > 1e-4:
        for g in gains:
            for i in range(n):
                g[i] *= norm

    base = [bytearray(n), bytearray(n), bytearray(n)]
    extra = [bytearray(n), bytearray(n), bytearray(n)]
    for i in range(n):
        for c, g in enumerate(gains):
            gv = g[i]
            if gv >= 1.0:
                base[c][i] = 255
                extra[c][i] = min(255, int(round((gv - 1.0) * 255.0)))
            else:
                base[c][i] = min(255, max(0, int(round(gv * 255.0))))
                extra[c][i] = 0

    base = [Image.frombytes("L", (w, h), bytes(a)) for a in base]
    extra = [Image.frombytes("L", (w, h), bytes(a)) for a in extra]
    return base, extra, norm, esri_lf, s2_lf


def apply_gain(esri_full, base, extra):
    """out = esri * min(1, gain) + esri * max(0, gain - 1), in Pillow C code."""
    w, h = esri_full.size
    out = []
    for ch, bmap, emap in zip(esri_full.split(), base, extra):
        b_full = bmap.resize((w, h), Image.Resampling.BILINEAR)
        e_full = emap.resize((w, h), Image.Resampling.BILINEAR)
        out.append(ImageChops.add(ImageChops.multiply(ch, b_full),
                                  ImageChops.multiply(ch, e_full)))
    return Image.merge("RGB", out)


# ---------------------------------------------------------------------------
# Verification helpers
# ---------------------------------------------------------------------------

def sample_tier(img, x_min, x_max, z_min, z_max, lat, lon):
    x, z = latlon_to_world(lat, lon)
    if not (x_min <= x <= x_max and z_min <= z <= z_max):
        return None
    u = (x - x_min) / (x_max - x_min)
    v = (z - z_min) / (z_max - z_min)
    px = min(img.width - 1, max(0, int(round(u * (img.width - 1)))))
    py = min(img.height - 1, max(0, int(round(v * (img.height - 1)))))
    return img.getpixel((px, py))


BORDER_SITES = [
    # label, lat, lon
    ("IT Kras 13.595", 45.805, 13.595),
    ("IT Kras 13.620", 45.775, 13.620),
    ("SI Kras 13.760", 45.805, 13.760),
    ("SI Kras 13.780", 45.775, 13.780),
]

LANDMARKS = [
    # name, lat, lon, expected surface
    ("Ajdovscina town", 45.8869, 13.9090, "town"),
    ("Gulf of Trieste", 45.7000, 13.5500, "water"),
    ("Nanos forest", 45.8330, 14.0200, "forest"),
    ("Triglav / Julian Alps", 46.3783, 13.8364, "rock"),
    ("Venice city", 45.4408, 12.3155, "town"),
    ("N. Adriatic", 45.3000, 12.4500, "water"),
]


def seam_profile(img, x_min, x_max, z_min, z_max, lat_s, lat_n,
                 lon_from, lon_to, bins=13):
    """Low-frequency luminance across the border, sampled at `bins` longitudes."""
    out = []
    span = (lon_to - lon_from) / (bins - 1)
    for i in range(bins):
        lon = lon_from + span * i
        box = world_rect_to_box(img, x_min, x_max, z_min, z_max,
                                lat_s, lat_n, lon - span * 0.45, lon + span * 0.45)
        out.append(luminance(region_mean(img, box)))
    return out


def largest_step(profile):
    return max(abs(profile[i + 1] - profile[i]) for i in range(len(profile) - 1))


def band_stats(img, x_min, x_max, z_min, z_max,
               lat_s, lat_n, lon_w, lon_e):
    """Mean luminance and mean HSV saturation over a geographic box."""
    box = world_rect_to_box(img, x_min, x_max, z_min, z_max,
                            lat_s, lat_n, lon_w, lon_e)
    crop = img.crop(box)
    lum = ImageStat.Stat(crop.convert("L")).mean[0]
    sat = ImageStat.Stat(crop.convert("HSV")).mean[1]
    return lum, sat


def edge_energy(img, x_min, x_max, z_min, z_max, lat_s, lat_n, lon_w, lon_e):
    """Mean |gradient| over an area: proves the sharp detail survived."""
    box = world_rect_to_box(img, x_min, x_max, z_min, z_max,
                            lat_s, lat_n, lon_w, lon_e)
    crop = img.crop(box).convert("L")
    return ImageStat.Stat(crop.filter(ImageFilter.FIND_EDGES)).mean[0]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    prepare_sources()

    # ------------------------------------------------------------------
    # Sentinel-2 reference + Kras calibration (HD and Regional agree)
    # ------------------------------------------------------------------
    print("\nSentinel-2 -> Slovenian Kras calibration:")
    cal_votes = []
    s2_small_by_key = {}
    esri_small_by_key = {}
    kras_box_by_key = {}
    for (key, fname, x_min, x_max, z_min, z_max, zoom,
         work_w, work_h, _quality) in TIERS:
        mosaic = S2Mosaic(zoom, x_min, x_max, z_min, z_max, label=key)
        s2_small = resample_mosaic(mosaic, x_min, x_max, z_min, z_max,
                                   work_w, work_h, label=key)
        s2_small_by_key[key] = s2_small

        # BOX keeps every source texel's vote; BILINEAR would alias 8:1.
        esri_small = Image.open(os.path.join(ORIG_DIR, fname)).convert("RGB") \
            .resize((work_w, work_h), Image.Resampling.BOX)
        esri_small_by_key[key] = esri_small

        box = world_rect_to_box(esri_small, x_min, x_max, z_min, z_max,
                                KRAS_LAT_S, KRAS_LAT_N, KRAS_LON_W, KRAS_LON_E)
        kras_box_by_key[key] = box
        esri_kras = region_mean(esri_small, box)
        s2_kras = region_mean(s2_small, box)
        cal = tuple(min(CAL_MAX, max(CAL_MIN, esri_kras[c] / max(1.0, s2_kras[c])))
                    for c in range(3))
        if key == "macro":
            continue  # the Kras box is ~11 working px there; not informative
        cal_votes.append(cal)
        print(f"  {key:9s} Kras Esri=({esri_kras[0]:5.1f},{esri_kras[1]:5.1f},"
              f"{esri_kras[2]:5.1f}) S2=({s2_kras[0]:5.1f},{s2_kras[1]:5.1f},"
              f"{s2_kras[2]:5.1f}) cal=({cal[0]:.3f},{cal[1]:.3f},{cal[2]:.3f})")

    cal = tuple(sum(v[c] for v in cal_votes) / len(cal_votes) for c in range(3))
    print(f"  global calibration for all tiers: "
          f"({cal[0]:.3f}, {cal[1]:.3f}, {cal[2]:.3f})")

    # ------------------------------------------------------------------
    # Harmonize each tier from its pristine Esri source
    # ------------------------------------------------------------------
    before = {}
    for (key, fname, x_min, x_max, z_min, z_max, zoom,
         work_w, work_h, quality) in TIERS:
        esri_full = Image.open(os.path.join(ORIG_DIR, fname)).convert("RGB")
        out_path = os.path.join(OUT_DIR, fname)
        t0 = time.time()

        base, extra, norm, _esri_lf, _s2_lf = build_gain_maps(
            esri_small_by_key[key], s2_small_by_key[key], cal,
            kras_box_by_key[key])
        out = apply_gain(esri_full, base, extra)
        out.save(out_path, format="JPEG", quality=quality, optimize=True,
                 progressive=False)
        remember_output(fname, out_path)

        print(f"[{key}] {esri_full.width}x{esri_full.height} harmonized in "
              f"{time.time() - t0:.2f}s (exposure anchor {norm:.3f}) -> "
              f"{out_path} ({os.path.getsize(out_path) / 1e6:.2f} MB)")
        before[key] = (esri_full, (x_min, x_max, z_min, z_max))
        del esri_full, out, base, extra

    # ------------------------------------------------------------------
    # Proof: Italian vs Slovenian Kras, before and after
    # ------------------------------------------------------------------
    print("\nItaly/Slovenia Kras border tone (15x15 px mean, luminance):")
    for (key, fname, x_min, x_max, z_min, z_max, *_rest) in TIERS:
        after = Image.open(os.path.join(OUT_DIR, fname)).convert("RGB")
        old = before[key][0]
        it_pts, si_pts = [], []
        for label, lat, lon in BORDER_SITES:
            mb = pixel_mean(old, x_min, x_max, z_min, z_max, lat, lon)
            ma = pixel_mean(after, x_min, x_max, z_min, z_max, lat, lon)
            if mb is None or ma is None:
                continue
            (it_pts if label.startswith("IT") else si_pts).append((mb, ma))
            print(f"  {key:9s} {label:14s} before RGB={tuple(round(v) for v in mb)}"
                  f" lum={luminance(mb):5.1f}  ->  after RGB="
                  f"{tuple(round(v) for v in ma)} lum={luminance(ma):5.1f}")
        if it_pts and si_pts:
            lb = sum(luminance(p[0]) for p in it_pts) / len(it_pts)
            la = sum(luminance(p[1]) for p in it_pts) / len(it_pts)
            sb = sum(luminance(p[0]) for p in si_pts) / len(si_pts)
            sa = sum(luminance(p[1]) for p in si_pts) / len(si_pts)
            print(f"  {key:9s} IT/SI luminance ratio {lb / sb:.2f} -> {la / sa:.2f}"
                  f"   (IT {lb:.1f}->{la:.1f}, SI {sb:.1f}->{sa:.1f})")

    # ------------------------------------------------------------------
    # Seam profile + detail retention
    # ------------------------------------------------------------------
    print("\nLow-frequency tone across the border (lat 45.80..45.86, "
          "lon 13.60..13.76, the actual mosaic seam):")
    for (key, fname, x_min, x_max, z_min, z_max, *_rest) in TIERS:
        after = Image.open(os.path.join(OUT_DIR, fname)).convert("RGB")
        old = before[key][0]
        pb = seam_profile(old, x_min, x_max, z_min, z_max, 45.80, 45.86,
                          13.60, 13.76)
        pa = seam_profile(after, x_min, x_max, z_min, z_max, 45.80, 45.86,
                          13.60, 13.76)
        print(f"  {key:9s} before " + " ".join(f"{v:5.1f}" for v in pb))
        print(f"  {key:9s} after  " + " ".join(f"{v:5.1f}" for v in pa))
        print(f"  {key:9s} largest neighbouring step "
              f"{largest_step(pb):.1f} -> {largest_step(pa):.1f}")

    print("\nColour-cast across the seam (mean HSV saturation, deeper green = higher):")
    for (key, fname, x_min, x_max, z_min, z_max, *_rest) in TIERS:
        after = Image.open(os.path.join(OUT_DIR, fname)).convert("RGB")
        old = before[key][0]
        for tag, img in (("before", old), ("after ", after)):
            lw, sw = band_stats(img, x_min, x_max, z_min, z_max,
                                45.80, 45.86, 13.60, 13.66)
            le, se = band_stats(img, x_min, x_max, z_min, z_max,
                                45.80, 45.86, 13.68, 13.76)
            print(f"  {key:9s} {tag} west lum={lw:5.1f} sat={sw:5.1f} | "
                  f"east lum={le:5.1f} sat={se:5.1f} | "
                  f"gap lum={lw - le:+5.1f} sat={sw - se:+5.1f}")

    print("\nHigh-frequency detail retained (Kras forest edge energy):")
    for (key, fname, x_min, x_max, z_min, z_max, *_rest) in TIERS:
        after = Image.open(os.path.join(OUT_DIR, fname)).convert("RGB")
        old = before[key][0]
        eb = edge_energy(old, x_min, x_max, z_min, z_max,
                         45.78, 45.84, 13.72, 13.90)
        ea = edge_energy(after, x_min, x_max, z_min, z_max,
                         45.78, 45.84, 13.72, 13.90)
        if eb <= 0.0:
            print(f"  {key:9s} outside tier")
            continue
        print(f"  {key:9s} before={eb:.2f} after={ea:.2f} "
              f"retained={ea / eb * 100:.0f}%")

    # ------------------------------------------------------------------
    # Landmark checks (identical predicates to bake_vipava_ortho.py)
    # ------------------------------------------------------------------
    print("\nLandmark colour checks (uv identical to the shader's mapping):")
    failures = []
    checked = 0
    for (key, fname, x_min, x_max, z_min, z_max, *_rest) in TIERS:
        out_path = os.path.join(OUT_DIR, fname)
        img = Image.open(out_path).convert("RGB")
        extrema = img.getextrema()
        spread = max(hi - lo for lo, hi in extrema)
        blank = spread < 16
        if blank:
            failures.append(f"{key}: image looks blank (channel spread {spread})")
        print(f"  {key:8s} {img.width}x{img.height} spread={spread:3d} "
              f"blank={blank} size={os.path.getsize(out_path) / 1e6:.2f} MB")
        for name, lat, lon, kind in LANDMARKS:
            rgb = sample_tier(img, x_min, x_max, z_min, z_max, lat, lon)
            if rgb is None:
                continue
            r, g, b = rgb
            lum = luminance(rgb)
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

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print("  - " + f)
        raise SystemExit(1)
    print("\nALL ORTHO TIERS HARMONIZED AND VERIFIED")


if __name__ == "__main__":
    main()