#!/usr/bin/env python3
"""Lift the Grado / Marano lagoon polders above sea level in vipava_dem.png.

Background
----------
The baked regional DEM (`public/media/vipava_dem.png`, 2048x2048, 16-bit value
packed as R = high byte, G = low byte, B = 0) reproduces the lagoon as open
water: Grado island, the Grado SR352 causeway, Grado Pineta, Fossalon, Barbana
and the Lignano barrier beaches all sit at or below 0.00 m.  Buildings and roads
baked from OSM therefore stand in the sea.

This script repairs the DEM itself, so every downstream consumer (terrain mesh,
building grounding, road ribbons, satellite ortho) picks the fix up for free:

  1. embankment pads along every OSM road and building pad in the lagoon zone,
  2. satellite-guided detection of dry lagoon land (Grado ortho imagery),
  3. a hard safety guard: land is only ever raised, never lowered, and nothing
     outside the lagoon box is touched.

Encoding (from vipava_meta.json):  h = raw / 16.0 - 200.0, so
    0.00 m -> 3200,   0.75 m -> 3212,   1.15 m -> 3218.4,   1.35 m -> 3221.6

Idempotency
-----------
The pristine DEM is cached once at /tmp/vipava_dem_orig.png.  Every run reads
that copy and rewrites `public/media/vipava_dem.png`, so repeated runs are
byte-for-byte deterministic.

Pure Python + Pillow only (numpy is not installed on this machine).
"""

from __future__ import annotations

import json
import math
import os
import shutil
import struct
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "public" / "media"
DEM_PATH = MEDIA / "vipava_dem.png"
ORIG_PATH = Path("/tmp/vipava_dem_orig.png")
META_PATH = MEDIA / "vipava_meta.json"
ORTHO_PATH = MEDIA / "vipava_ortho.jpg"
OSM_PATH = MEDIA / "vipava_osm.json"
BLD_PATH = MEDIA / "vipava_buildings.bin"

# ---------------------------------------------------------------------------
# DEM encoding helpers
# ---------------------------------------------------------------------------
OFFSET = -200.0
SCALE = 16.0


def raw_of(height_m: float) -> int:
    """Metres -> stored 16-bit value."""
    return int(round((height_m - OFFSET) * SCALE))


def height_of(raw: int) -> float:
    """Stored 16-bit value -> metres."""
    return raw / SCALE + OFFSET


# Lift targets (quantisation is 1/16 m = 0.0625 m).
ROAD_CORE = raw_of(1.35)
ROAD_SHOULDER = raw_of(0.75)
BLD_CORE = raw_of(1.30)
BLD_SHOULDER = ROAD_SHOULDER
ISLAND_CORE = raw_of(1.10)
ISLAND_EDGE = raw_of(0.55)

# "DEM is wet" threshold used to decide whether a road/building needs a pad.
LOW_LAND_RAW = raw_of(1.15)        # 3218
# Satellite pass only classifies genuinely flat pixels (h <= 0.75 m).
FLAT_RAW_MAX = raw_of(0.75)        # 3212
# "already solid ground" for the noise filter (h >= 0.5 m).
SOLID_RAW = raw_of(0.50)           # 3208

# ---------------------------------------------------------------------------
# World boxes
# ---------------------------------------------------------------------------
# Region that may be modified at all (Grado / Marano / Monfalcone lagoon).
ZONE_X = (-50000.0, -18000.0)
ZONE_Z = (4000.0, 34000.0)
# Satellite-guided dry-land detection sub-box (Grado + Pineta + Fossalon +
# Barbana + Lignano barrier beaches).
DET_X = (-50000.0, -23000.0)
DET_Z = (11000.0, 31000.0)

# Ortho sampling boxes for the printed RGB statistics.
SEA_BOX = ((-28000.0, -20000.0), (26000.0, 34000.0))
GRADO_BOX = ((-41000.0, -36500.0), (21500.0, 24500.0))

EMBANKMENT_R2_CORE = 1.5 * 1.5      # ~73 m centre
EMBANKMENT_R2_SHOULDER = 2.5 * 2.5  # one extra pixel of shoulder

ROAD_STEP_M = 20.0


# ---------------------------------------------------------------------------
# Load / decode
# ---------------------------------------------------------------------------
def bytecode_to_grid(buf: bytes, width: int, c0: int, c1: int, r0: int, r1: int):
    """Decode the RGB-packed 16-bit values of one rectangular window."""
    rows = []
    for r in range(r0, r1 + 1):
        base = r * width * 3
        seg = buf[base + 3 * c0: base + 3 * c1 + 3]
        rows.append([(seg[i] << 8) | seg[i + 1] for i in range(0, len(seg), 3)])
    return rows


def grid_bounds(x_min, x_max, z_min, z_max, width, height):
    """World box -> inclusive integer pixel window (clamped)."""
    c0 = max(0, min(width - 1, int(math.floor((x_min + 50000.0) / ANTI_M * (width - 1)))))
    c1 = max(0, min(width - 1, int(math.ceil((x_max + 50000.0) / ANTI_M * (width - 1)))))
    r0 = max(0, min(height - 1, int(math.floor((z_min + 50000.0) / ANTI_M * (height - 1)))))
    r1 = max(0, min(height - 1, int(math.ceil((z_max + 50000.0) / ANTI_M * (height - 1)))))
    return c0, c1, r0, r1


ANTI_M = 100000.0  # sizeM: x,z both span [-50000, 50000]


def world_to_col(x: float, width: int) -> int:
    return int(round((x + 50000.0) / ANTI_M * (width - 1)))


def world_to_row(z: float, height: int) -> int:
    return int(round((z + 50000.0) / ANTI_M * (height - 1)))


def col_to_world(col: int, width: int) -> float:
    return col / (width - 1) * ANTI_M - 50000.0


def row_to_world(row: int, height: int) -> float:
    return row / (height - 1) * ANTI_M - 50000.0


# ---------------------------------------------------------------------------
# Raster helpers (all coordinates are LOCAL to the zone window)
# ---------------------------------------------------------------------------
def stamp(lift, cols, rows, cc: int, rr: int, core: int, shoulder: int) -> None:
    """Raise a disc of radius 1.5 px plus a 1-px shoulder around (cc, rr)."""
    for dy in range(-2, 3):
        r = rr + dy
        if r < 0 or r >= rows:
            continue
        row = lift[r]
        for dx in range(-2, 3):
            c = cc + dx
            if c < 0 or c >= cols:
                continue
            d2 = dx * dx + dy * dy
            if d2 <= EMBANKMENT_R2_CORE:
                if row[c] < core:
                    row[c] = core
            elif d2 <= EMBANKMENT_R2_SHOULDER:
                if row[c] < shoulder:
                    row[c] = shoulder


def polyline_samples(pts, step_m: float):
    """Yield interior points of a polyline every `step_m` metres."""
    for i in range(len(pts) - 1):
        x1, z1 = pts[i]
        x2, z2 = pts[i + 1]
        dx = x2 - x1
        dz = z2 - z1
        length = math.hypot(dx, dz)
        n = max(1, int(math.ceil(length / step_m)))
        for k in range(n):
            t = k / n
            yield x1 + dx * t, z1 + dz * t


def inside(x: float, z: float, box_x, box_z) -> bool:
    return box_x[0] <= x <= box_x[1] and box_z[0] <= z <= box_z[1]


# ---------------------------------------------------------------------------
# Load buildings (FBLD v1: header 16 B, then 20 B records)
# ---------------------------------------------------------------------------
def load_buildings(path: Path):
    blob = path.read_bytes()
    if len(blob) < 16 or blob[0:4] != b"FBLD":
        raise SystemExit(f"{path} is not an FBLD payload")
    count, stride = struct.unpack_from("<II", blob, 8)
    if stride != 20:
        raise SystemExit(f"unexpected FBLD stride {stride}")
    out = []
    off = 16
    for _ in range(count):
        x, z = struct.unpack_from("<ff", blob, off)
        out.append((x, z))
        off += 20
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    if not ORIG_PATH.exists():
        shutil.copy2(DEM_PATH, ORIG_PATH)
        print(f"[backup] cached pristine DEM -> {ORIG_PATH}")
    else:
        print(f"[backup] reusing pristine DEM {ORIG_PATH}")

    meta = json.loads(META_PATH.read_text())
    if abs(meta["scale"] - SCALE) > 1e-9 or abs(meta["offset"] - OFFSET) > 1e-9:
        raise SystemExit("vipava_meta.json scale/offset changed; update this script")
    if abs(meta["sizeM"] - ANTI_M) > 1e-6:
        raise SystemExit("vipava_meta.json sizeM changed; update this script")

    orig = Image.open(ORIG_PATH).convert("RGB")
    width, height = orig.size
    src = orig.tobytes()

    c0, c1, r0, r1 = grid_bounds(ZONE_X[0], ZONE_X[1], ZONE_Z[0], ZONE_Z[1], width, height)
    cols = c1 - c0 + 1
    rows = r1 - r0 + 1
    print(f"[dem] {width}x{height}, zone cols {c0}..{c1} rows {r0}..{r1} "
          f"({cols}x{rows} px = {cols * 48.85:.0f} x {rows * 48.85:.0f} m)")

    zone = bytecode_to_grid(src, width, c0, c1, r0, r1)
    lift = [row[:] for row in zone]

    def zone_raw(col: int, row: int) -> int:
        """Original height at a global pixel, or -1 outside the zone window."""
        lc = col - c0
        lr = row - r0
        if 0 <= lc < cols and 0 <= lr < rows:
            return zone[lr][lc]
        return -1

    # --- 1a. OSM road embankments -----------------------------------------
    osm = json.loads(OSM_PATH.read_text())
    road_hits = 0
    road_samples = 0
    road_segments = 0
    for road in osm.get("roads", []):
        pts = road.get("pts") or []
        if len(pts) < 2:
            continue
        touched = False
        for x, z in polyline_samples(pts, ROAD_STEP_M):
            if not (ZONE_X[0] <= x <= ZONE_X[1] and ZONE_Z[0] <= z <= ZONE_Z[1]):
                continue
            road_samples += 1
            col = world_to_col(x, width)
            row = world_to_row(z, height)
            h = zone_raw(col, row)
            if h < 0 or h >= LOW_LAND_RAW:
                continue
            stamp(lift, cols, rows, col - c0, row - r0, ROAD_CORE, ROAD_SHOULDER)
            road_hits += 1
            touched = True
        if touched:
            road_segments += 1
    print(f"[roads] {road_segments} roads touched, {road_hits} wet samples of "
          f"{road_samples} inside zone -> 1.35 m embankment (0.75 m shoulder)")

    # --- 1b. Building pads -------------------------------------------------
    buildings = load_buildings(BLD_PATH)
    bld_hits = 0
    bld_in_zone = 0
    for x, z in buildings:
        if not (ZONE_X[0] <= x <= ZONE_X[1] and ZONE_Z[0] <= z <= ZONE_Z[1]):
            continue
        bld_in_zone += 1
        col = world_to_col(x, width)
        row = world_to_row(z, height)
        h = zone_raw(col, row)
        if h < 0 or h >= LOW_LAND_RAW:
            continue
        stamp(lift, cols, rows, col - c0, row - r0, BLD_CORE, BLD_SHOULDER)
        bld_hits += 1
    print(f"[buildings] {bld_in_zone} in zone, {bld_hits} sat in water -> "
          f"1.30 m pad (0.75 m shoulder)")

    # --- 2. Satellite-guided dry lagoon land ------------------------------
    ortho = Image.open(ORTHO_PATH).convert("RGB")
    o_w, o_h = ortho.size
    o_px = ortho.load()

    def ortho_at(x: float, z: float):
        c = min(o_w - 1, max(0, world_to_col(x, o_w)))
        r = min(o_h - 1, max(0, world_to_row(z, o_h)))
        return o_px[c, r]

    def region_stats(name, box):
        (x0, x1), (z0, z1) = box
        step = max(1, int(round((x1 - x0) / 160.0)))
        n = 0
        sr = sg = sb = swarm = slum = 0.0
        min_lum = min_warm = 1e9
        max_lum = max_warm = -1e9
        for z in range(int(z0), int(z1) + 1, step):
            for x in range(int(x0), int(x1) + 1, step):
                r, g, b = ortho_at(x, z)
                warm = (r + g) * 0.5 - b
                lum = (r + g + b) / 3.0
                sr += r
                sg += g
                sb += b
                swarm += warm
                slum += lum
                min_lum = min(min_lum, lum)
                max_lum = max(max_lum, lum)
                min_warm = min(min_warm, warm)
                max_warm = max(max_warm, warm)
                n += 1
        print(f"[ortho] {name}: n={n} mean RGB=({sr / n:.1f}, {sg / n:.1f}, {sb / n:.1f}) "
              f"warm={(swarm / n):.1f} lum={(slum / n):.1f} "
              f"lum range {min_lum:.0f}..{max_lum:.0f} warm range {min_warm:.0f}..{max_warm:.0f}")
        return sr / n, sg / n, sb / n

    region_stats("open Gulf of Trieste", SEA_BOX)
    region_stats("Grado town / beach", GRADO_BOX)

    # Classifier tuned from the numbers above: the open Adriatic in this mosaic
    # is a flat dark blue (R 12, G 30, B 44 -> warm -23, lum 29), so land is any
    # pixel that is clearly warmer/greener/brighter than that.
    def is_dry_land(r: int, g: int, b: int) -> bool:
        warm = (r + g) * 0.5 - b
        lum = (r + g + b) / 3.0
        if warm >= 14.0:                        # bright sand, fields, rooftops
            return True
        if g - b >= 8 and lum >= 40.0:          # grey-green urban roofs/tarmac
            return True
        if lum >= 55.0 and r >= 45 and b <= 110:  # very bright bare ground
            return True
        return False

    d_c0, d_c1 = max(c0, world_to_col(DET_X[0], width)), min(c1, world_to_col(DET_X[1], width))
    d_r0, d_r1 = max(r0, world_to_row(DET_Z[0], height)), min(r1, world_to_row(DET_Z[1], height))
    dc = d_c1 - d_c0 + 1
    dr = d_r1 - d_r0 + 1

    dry = [[False] * dc for _ in range(dr)]
    flat = 0
    for lr in range(dr):
        r_glob = d_r0 + lr
        zrow = zone[r_glob - r0]
        for lc in range(dc):
            c_glob = d_c0 + lc
            if zrow[c_glob - c0] > FLAT_RAW_MAX:
                continue
            flat += 1
            r, g, b = ortho_at(col_to_world(c_glob, width), row_to_world(r_glob, height))
            if is_dry_land(r, g, b):
                dry[lr][lc] = True

    # Speckle filter: keep only pixels supported by >= 2 of the 8 neighbours.
    solid = [[False] * dc for _ in range(dr)]
    for lr in range(dr):
        r_glob = d_r0 + lr
        zrow = zone[r_glob - r0]
        for lc in range(dc):
            solid[lr][lc] = zrow[d_c0 + lc - c0] >= SOLID_RAW

    clean = [[False] * dc for _ in range(dr)]
    for lr in range(dr):
        for lc in range(dc):
            if not dry[lr][lc]:
                continue
            support = 0
            for dy in (-1, 0, 1):
                rr = lr + dy
                if rr < 0 or rr >= dr:
                    continue
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    cc = lc + dx
                    if cc < 0 or cc >= dc:
                        continue
                    if dry[rr][cc] or solid[rr][cc]:
                        support += 1
            clean[lr][lc] = support >= 2

    island_core = 0
    island_edge = 0
    for lr in range(dr):
        zrow_l = lift[d_r0 + lr - r0]
        for lc in range(dc):
            if not clean[lr][lc]:
                continue
            if zrow_l[d_c0 + lc - c0] < ISLAND_CORE:
                zrow_l[d_c0 + lc - c0] = ISLAND_CORE
            island_core += 1
    for lr in range(dr):
        for lc in range(dc):
            if not clean[lr][lc]:
                continue
            for dy in (-1, 0, 1):
                rr = lr + dy
                if rr < 0 or rr >= dr:
                    continue
                zrow_l = lift[d_r0 + rr - r0]
                for dx in (-1, 0, 1):
                    cc = lc + dx
                    if cc < 0 or cc >= dc:
                        continue
                    idx = d_c0 + cc - c0
                    if zrow_l[idx] < ISLAND_EDGE:
                        zrow_l[idx] = ISLAND_EDGE
                        island_edge += 1

    print(f"[lagoon] {flat} flat pixels (h <= 0.75 m) in detection box, "
          f"{island_core} dry-land cores -> 1.10 m, {island_edge} feathered edge cells -> 0.55 m")

    # --- 3. Safety guard: never lower, never leave the zone ---------------
    changed = 0
    raised_max = 0
    out = bytearray(src)
    for lr in range(rows):
        r_glob = r0 + lr
        base = r_glob * width * 3
        zsrc = zone[lr]
        zlift = lift[lr]
        for lc in range(cols):
            old = zsrc[lc]
            new = zlift[lc]
            if new <= old:
                continue
            if new > 65535:
                raise SystemExit("16-bit overflow while lifting")
            changed += 1
            raised_max = max(raised_max, new - old)
            o = base + 3 * (c0 + lc)
            out[o] = new >> 8
            out[o + 1] = new & 0xFF
            out[o + 2] = 0

    print(f"[write] {changed} pixels raised (max +{raised_max / SCALE:.2f} m), "
          f"0 lowered, {rows * cols - changed} zone pixels untouched")

    tmp_path = MEDIA / ".vipava_dem.png.tmp"
    patched = Image.frombytes("RGB", (width, height), bytes(out))
    patched.save(tmp_path, format="PNG")
    os.replace(tmp_path, DEM_PATH)
    print(f"[write] {DEM_PATH} ({DEM_PATH.stat().st_size} bytes)")

    # -----------------------------------------------------------------------
    # Verification (reads the file back off disk)
    # -----------------------------------------------------------------------
    check = Image.open(DEM_PATH).convert("RGB")
    if check.size != (width, height):
        raise SystemExit("written DEM has the wrong size")
    cpx = check.load()

    def probe(x: float, z: float) -> float:
        c = world_to_col(x, width)
        r = world_to_row(z, height)
        red, green, _ = cpx[c, r]
        return height_of((red << 8) | green)

    def orig_probe(x: float, z: float) -> float:
        c = world_to_col(x, width)
        r = world_to_row(z, height)
        o = (r * width + c) * 3
        return height_of((src[o] << 8) | src[o + 1])

    print("\n[elevation] point                          before     after")
    points = [
        ("Grado town centre", -39000, 23500),
        ("Grado town NW", -39800, 24000),
        ("Grado town E", -38200, 23300),
        ("Grado town S (harbour)", -39000, 22800),
        ("Grado Pineta", -39500, 16500),
        ("Fossalon embankment", -31500, 16500),
        ("Barbana islet", -30000, 19500),
        ("Lignano barrier beach", -25000, 21500),
        ("SR352 causeway midpoint", -39000, 19000),
        ("SR352 causeway N", -38400, 20500),
        ("SR352 causeway S", -39400, 17500),
        ("Monfalcone port road", -21000, 14500),
        ("open Adriatic (-24000,28000)", -24000, 28000),
        ("open Adriatic (-35000,30000)", -35000, 30000),
        ("open Adriatic (-27000,31000)", -27000, 31000),
        ("open Adriatic (-22000,25000)", -22000, 25000),
        ("LJAJ runway", -450, -130),
        ("Sveta Gora", -17929.7, -12391.3),
        ("Nanos plateau", 12904.4, 12902.5),
        ("Trieste city", -8500, 26500),
        ("Koper", -12000, 29000),
        ("Piran", -21000, 44000),
    ]
    failures = []
    for name, x, z in points:
        before = orig_probe(x, z)
        after = probe(x, z)
        flag = ""
        if after < before - 1e-9:
            flag = "  !! LOWERED"
            failures.append(f"{name} was lowered {before:.2f} -> {after:.2f}")
        print(f"  {name:32s} {before:8.2f} m {after:8.2f} m{flag}")

    for name, x, z in points:
        if "open Adriatic" in name or name in ("LJAJ runway", "Sveta Gora", "Nanos plateau",
                                              "Trieste city", "Koper", "Piran"):
            if abs(probe(x, z) - orig_probe(x, z)) > 1e-9:
                failures.append(f"protected point {name} changed")

    for tx, tz in ((-24000, 28000), (-35000, 30000)):
        if abs(probe(tx, tz)) > 1e-9:
            failures.append(f"open sea at ({tx}, {tz}) is {probe(tx, tz):.2f} m, want 0.00 m")

    if probe(-39000, 23500) < 1.0:
        failures.append("Grado town centre still below 1.0 m")
    if probe(-39000, 19000) < 0.75:
        failures.append("Grado causeway still below 0.75 m")

    # Coarse ASCII overview of where the DEM was raised.
    print("\n[map] raised footprint in the lagoon zone (each cell ~1.6 x 1.6 km):")
    mx, mz = 40, 18
    cw = cols / mx
    ch = rows / mz
    for gy in range(mz):
        line = []
        for gx in range(mx):
            got = 0
            for lr in range(int(gy * ch), min(rows, int((gy + 1) * ch))):
                for lc in range(int(gx * cw), min(cols, int((gx + 1) * cw))):
                    if lift[lr][lc] > zone[lr][lc]:
                        got += 1
            line.append("#" if got > cw * ch * 0.35 else "+" if got > 0 else ".")
        print("   " + "".join(line))

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print("  - " + f)
        return 1
    print("\nOK: Grado polders lifted, protected terrain and open sea unchanged.")
    return 0


if __name__ == "__main__":
    sys.exit(main())