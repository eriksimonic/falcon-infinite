"""Bake hydrological riverbed depressions into the Vipava Valley DEMs.

The raw terrarium/OSM bake leaves riverbeds bumpy and occasionally uphill:
a river flowing down a valley can hit a noisy DEM bump and sit *above* the
ground downstream, so the water sheet dives under the terrain upstream and
floats in the air further down. Wide OSM `natural=water` riverbanks (Tolmin
Soča Lake, Solkan) make it worse: they are long, narrow and drop tens of
metres along their length, but `buildInlandWaterGeometry()` would flatten each
one to a single height.

This script carves a smooth, strictly-downhill trough into both DEMs so the
rivers have somewhere to sit. It is deterministic: every target is derived from
the current DEM, and terrain is only ever lowered (`newH = min(oldH, targetH)`).
It is meant to run once against the freshly baked DEMs (a second run would
re-derive the profile from the already-carved bed and deepen it again).

Inputs / outputs (16-bit RG packed, as decoded by src/world/dem.js):
    elev = offset + ((R << 8) | G) / scale
    public/media/vipava_dem.png     (outer 100 x 100 km, 2048^2)
    public/media/vipava_dem_hd.png  (HD inset 40 x 30 km, 2048^2)

Run: python3 scripts/carve_vipava_rivers.py
"""

import array
import json
import math
import sys
import time

from PIL import Image

ROOT = "public/media"

RIVER_STEP_M = 15.0            # centreline resample interval
AIRPORT_KEEPOUT_M = 220.0      # never carve inside an airfield wedge
SEA_EPS_M = 0.1                # never alter sea pixels
DEPTH_MIN_M = 1.4
DEPTH_MAX_M = 3.0
DEPTH_FADE_HI_M = 4.0          # full depth at/above this river elevation
DEPTH_FADE_LO_M = 0.5          # depth fully faded out at/below this
# Where an OSM centreline disagrees with the coarse DEM (a 20-50 m pixel
# cannot resolve a 15 m gorge, so the sampled path can sit on a canyon rim),
# the monotonic profile may be hundreds of metres below the local terrain.
# Never gouge more than this below the original surface: real beds are only
# 1.4-3 m deep, so anything deeper is a resolution artifact, not a channel.
MAX_CARVE_M = 30.0


# ---------------------------------------------------------------------------
# 16-bit RG DEM <-> elevation
# ---------------------------------------------------------------------------

class Dem:
    """A 16-bit RG-encoded elevation grid with world-space bounds."""

    def __init__(self, path, grid, x_min, x_max, z_min, z_max, offset, scale):
        self.path = path
        self.grid = grid
        self.x_min, self.x_max = float(x_min), float(x_max)
        self.z_min, self.z_max = float(z_min), float(z_max)
        self.offset, self.scale = float(offset), float(scale)
        self.span_x = self.x_max - self.x_min
        self.span_z = self.z_max - self.z_min
        self.px_x = self.span_x / (grid - 1)
        self.px_z = self.span_z / (grid - 1)
        self.pixel_m = max(self.px_x, self.px_z)

        img = Image.open(path)
        if img.mode != "RGB":
            img = img.convert("RGB")
        if img.size != (grid, grid):
            raise SystemExit(f"{path}: got {img.size}, expected {grid}x{grid}")

        raw = img.tobytes()  # RGB RGB ... row-major, row 0 = zMin
        n = grid * grid
        # Pack R (high byte) and G (low byte) into native uint16.
        buf = bytearray(2 * n)
        buf[0::2] = raw[1::3]  # low byte first (little-endian friendly)
        buf[1::2] = raw[0::3]  # high byte
        vals = array.array("H")
        vals.frombytes(bytes(buf))
        if sys.byteorder == "big":
            vals.byteswap()
        self.vals = vals
        self.out = array.array("H", vals)
        self.raw = raw  # keep for the untouched blue channel

    def elev(self, idx):
        return self.offset + self.vals[idx] / self.scale

    def contains(self, x, z):
        return (self.x_min <= x <= self.x_max) and (self.z_min <= z <= self.z_max)

    def sample(self, x, z, use_out=False):
        """Bilinear elevation in metres at world (x, z), or None if outside."""
        if not self.contains(x, z):
            return None
        grid_vals = self.out if use_out else self.vals
        u = (x - self.x_min) / self.span_x * (self.grid - 1)
        v = (z - self.z_min) / self.span_z * (self.grid - 1)
        u = min(max(u, 0.0), self.grid - 1.0)
        v = min(max(v, 0.0), self.grid - 1.0)
        i0 = int(math.floor(u))
        j0 = int(math.floor(v))
        i1 = min(i0 + 1, self.grid - 1)
        j1 = min(j0 + 1, self.grid - 1)
        fx = u - i0
        fy = v - j0
        g = self.grid
        row0 = j0 * g
        row1 = j1 * g
        v00 = grid_vals[row0 + i0]
        v10 = grid_vals[row0 + i1]
        v01 = grid_vals[row1 + i0]
        v11 = grid_vals[row1 + i1]
        top = v00 + (v10 - v00) * fx
        bot = v01 + (v11 - v01) * fx
        return self.offset + (top + (bot - top) * fy) / self.scale

    def encode(self):
        """Write the (possibly lowered) grid back out, keeping the blue channel."""
        g = self.grid
        n = g * g
        tmp = self.out.tobytes()  # native byte order, [low, high] on LE
        if sys.byteorder != "big":
            hi, lo = tmp[1::2], tmp[0::2]
        else:
            hi, lo = tmp[0::2], tmp[1::2]
        raw = bytearray(self.raw)
        raw[0::3] = hi
        raw[1::3] = lo
        Image.frombytes("RGB", (g, g), bytes(raw)).save(self.path, optimize=True)


def load_dems(meta):
    outer = Dem(
        f"{ROOT}/vipava_dem.png",
        int(meta["grid"]),
        -meta["sizeM"] * 0.5,
        meta["sizeM"] * 0.5,
        -meta["sizeM"] * 0.5,
        meta["sizeM"] * 0.5,
        float(meta["offset"]),
        float(meta["scale"]),
    )
    hd = meta["hd"]
    inset = Dem(
        f"{ROOT}/vipava_dem_hd.png",
        int(hd["grid"]),
        hd["xMin"],
        hd["xMax"],
        hd["zMin"],
        hd["zMax"],
        float(hd["offset"]),
        float(hd["scale"]),
    )
    return outer, inset


# ---------------------------------------------------------------------------
# River profile
# ---------------------------------------------------------------------------

def resample(pts, step):
    """Evenly resample a polyline every `step` metres, keeping both ends."""
    out = [pts[0]]
    prev = pts[0]
    since = 0.0
    for p in pts[1:]:
        seg = math.hypot(p[0] - prev[0], p[1] - prev[1])
        if seg <= 1e-6:
            continue
        d = step - since
        while d <= seg:
            t = d / seg
            out.append([prev[0] + (p[0] - prev[0]) * t,
                        prev[1] + (p[1] - prev[1]) * t])
            d += step
        since = seg - (d - step)
        prev = p
    if math.hypot(prev[0] - out[-1][0], prev[1] - out[-1][1]) > 1.0:
        out.append([prev[0], prev[1]])
    return out


def depth_for_width(w):
    return min(DEPTH_MAX_M, max(DEPTH_MIN_M, 1.2 + 0.04 * w))


def depth_fade(elev):
    """Smoothstep fade of the carve depth near the sea datum."""
    t = (elev - DEPTH_FADE_LO_M) / (DEPTH_FADE_HI_M - DEPTH_FADE_LO_M)
    t = min(1.0, max(0.0, t))
    return t * t * (3.0 - 2.0 * t)


def smooth5(hs):
    n = len(hs)
    out = [0.0] * n
    for i in range(n):
        lo = max(0, i - 2)
        hi = min(n - 1, i + 2)
        out[i] = sum(hs[lo:hi + 1]) / (hi - lo + 1)
    return out


def river_profile(river, height_at):
    """Return [(x, z, bedY), ...] upstream -> downstream, or None."""
    pts = river.get("pts")
    w = float(river.get("w", 15.0))
    if not isinstance(pts, list) or len(pts) < 2:
        return None
    pts = [[float(p[0]), float(p[1])] for p in pts
           if isinstance(p, (list, tuple)) and len(p) >= 2
           and math.isfinite(p[0]) and math.isfinite(p[1])]
    if len(pts) < 2:
        return None

    samples = resample(pts, RIVER_STEP_M)
    hs = [height_at(x, z) for x, z in samples]
    finite = [(samples[i][0], samples[i][1], hs[i])
              for i in range(len(samples)) if hs[i] is not None]
    if len(finite) < 2:
        return None

    n0 = min(4, len(finite))
    start = sum(p[2] for p in finite[:n0]) / n0
    end = sum(p[2] for p in finite[-n0:]) / n0
    if start < end:
        finite.reverse()  # index 0 is now upstream

    zs = [p[2] for p in finite]
    zs = smooth5(zs)
    mono = [0.0] * len(zs)
    for i, h in enumerate(zs):
        mono[i] = h if i == 0 else min(mono[i - 1], h)

    depth = depth_for_width(w)
    out = []
    prev_bed = None
    for (x, z, _), h in zip(finite, mono):
        bed = h - depth * depth_fade(h)
        # Near the sea datum the depth fades out, which can nudge the bed a few
        # millimetres uphill again. Clamp so the riverbed itself is monotonic.
        if prev_bed is not None:
            bed = min(prev_bed, bed)
        prev_bed = bed
        out.append((x, z, bed))
    return out


# ---------------------------------------------------------------------------
# Rasterise a downward-only cosine trough
# ---------------------------------------------------------------------------

def carve_dem(dem, profiles, airports):
    total_segments = 0
    changed_pixels = 0
    clamped_pixels = 0
    g = dem.grid
    ox, oz = dem.x_min, dem.z_min
    pxx, pxz = dem.px_x, dem.px_z
    offset, scale = dem.offset, dem.scale
    vals, out = dem.vals, dem.out
    keep2 = AIRPORT_KEEPOUT_M * AIRPORT_KEEPOUT_M

    for profile in profiles:
        if len(profile) < 2:
            continue
        w = profile[0][3] if len(profile[0]) > 3 else 15.0
        r_in = max(w * 0.5, dem.pixel_m * 0.75)
        r_out = r_in + max(32.0, dem.pixel_m * 1.5)
        inv_blend = 1.0 / max(1e-6, r_out - r_in)
        r_out2 = r_out * r_out

        for k in range(len(profile) - 1):
            x0, z0, b0 = profile[k][0], profile[k][1], profile[k][2]
            x1, z1, b1 = profile[k + 1][0], profile[k + 1][1], profile[k + 1][2]
            seg_dx = x1 - x0
            seg_dz = z1 - z0
            seg_len2 = seg_dx * seg_dx + seg_dz * seg_dz
            if seg_len2 <= 1e-9:
                continue
            inv_len2 = 1.0 / seg_len2

            i0 = int(math.floor((min(x0, x1) - r_out - ox) / pxx)) - 1
            i1 = int(math.ceil((max(x0, x1) + r_out - ox) / pxx)) + 1
            j0 = int(math.floor((min(z0, z1) - r_out - oz) / pxz)) - 1
            j1 = int(math.ceil((max(z0, z1) + r_out - oz) / pxz)) + 1
            i0 = max(0, i0)
            j0 = max(0, j0)
            i1 = min(g - 1, i1)
            j1 = min(g - 1, j1)
            if i0 > i1 or j0 > j1:
                continue
            total_segments += 1

            for j in range(j0, j1 + 1):
                pz = oz + j * pxz
                row = j * g
                for i in range(i0, i1 + 1):
                    px = ox + i * pxx
                    dx = px - x0
                    dz = pz - z0
                    d2 = dx * dx + dz * dz
                    if d2 > r_out2:
                        continue

                    skip = False
                    for ax, az in airports:
                        ex = px - ax
                        ez = pz - az
                        if ex * ex + ez * ez < keep2:
                            skip = True
                            break
                    if skip:
                        continue

                    idx = row + i
                    old_h = offset + vals[idx] / scale
                    if old_h <= SEA_EPS_M:
                        continue

                    d = math.sqrt(d2)
                    # Project onto the segment for the bed height at this pixel.
                    t = (dx * seg_dx + dz * seg_dz) * inv_len2
                    t = min(1.0, max(0.0, t))
                    bed = b0 + (b1 - b0) * t
                    if d <= r_in:
                        target = bed
                    else:
                        s = 0.5 - 0.5 * math.cos(math.pi * (d - r_in) * inv_blend)
                        target = bed + (old_h - bed) * s
                    floor_h = old_h - MAX_CARVE_M
                    if target < floor_h:
                        target = floor_h
                        clamped_pixels += 1
                    # Downward-only against the *current* carved height: a later
                    # overlapping segment with a shallow bank blend must never
                    # overwrite an earlier segment's deep channel bottom.
                    cur_h = offset + out[idx] / scale
                    if target >= cur_h:
                        continue
                    v = int(round((target - offset) * scale))
                    if v < 0:
                        v = 0
                    elif v > 65535:
                        v = 65535
                    out[idx] = v
                    changed_pixels += 1

    return total_segments, changed_pixels, clamped_pixels


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    t0 = time.time()
    with open(f"{ROOT}/vipava_meta.json") as f:
        meta = json.load(f)
    with open(f"{ROOT}/vipava_water.json") as f:
        water = json.load(f)

    outer, inset = load_dems(meta)
    airports = [(float(a["x"]), float(a["z"])) for a in meta.get("airports", [])
                if "x" in a and "z" in a]

    def height_at(x, z):
        h = inset.sample(x, z)
        if h is not None:
            return h
        return outer.sample(x, z)

    profiles = []
    raw_profiles = 0
    for river in water.get("rivers", []):
        prof = river_profile(river, height_at)
        if not prof:
            continue
        w = float(river.get("w", 15.0))
        # Tag the width so the rasteriser can size the trough per DEM.
        profiles.append([(x, z, bed, w) for (x, z, bed) in prof])
        raw_profiles += 1

    # Post-carve sanity on the actual DEM: a riverbed should now be smooth and
    # downhill, and the flat-bank ribbon (terrain + 0.35 m) should not sit under
    # the ground. Both are what src/world/water.js samples at runtime.
    o_seg, o_px, o_clamped = carve_dem(outer, profiles, airports)
    h_seg, h_px, h_clamped = carve_dem(inset, profiles, airports)

    def height_after(x, z):
        h = inset.sample(x, z, use_out=True)
        if h is not None:
            return h
        return outer.sample(x, z, use_out=True)

    post_uphill = 0
    post_total = 0
    post_buried = 0
    worst_burial = 0.0
    for prof in profiles:
        prev_h = None
        mono = None
        for (x, z, _bed, _w) in prof:
            hh = height_after(x, z)
            if hh is None:
                continue
            post_total += 1
            if prev_h is not None and hh > prev_h + 1e-4:
                post_uphill += 1
            prev_h = hh
            mono = hh if mono is None else min(mono, hh)
            burial = hh - (mono + 0.35)
            if burial > 0.05:
                post_buried += 1
                worst_burial = max(worst_burial, burial)

    outer.encode()
    inset.encode()

    print(f"carve_vipava_rivers: {raw_profiles} rivers, "
          f"{sum(len(p) - 1 for p in profiles)} centreline segments")
    print(f"  outer DEM: {o_seg} segments, {o_px} pixel writes "
          f"({o_clamped} clamped at {MAX_CARVE_M:.0f} m)")
    print(f"  HD DEM   : {h_seg} segments, {h_px} pixel writes "
          f"({h_clamped} clamped at {MAX_CARVE_M:.0f} m)")
    print(f"  post-carve centreline: {post_total} samples, "
          f"{post_uphill} uphill steps, {post_buried} buried "
          f"({100.0 * post_buried / max(1, post_total):.1f}%, "
          f"worst {worst_burial:.2f} m)")
    print(f"  done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()