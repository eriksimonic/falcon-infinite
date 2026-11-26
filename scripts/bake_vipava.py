import math, io, json, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

# Center: Ajdovscina Airfield (LJAJ), Vipava Valley, Slovenia
LAT0 = 45.8878
LON0 = 13.8869
SIZE_M = 100000.0   # 100 km x 100 km (-50km..+50km)
GRID = 1024         # 1024 x 1024 (~97.7 m/sample, bilinear in sim)
ZOOM = 10           # ~100 m/px at 45.9 deg N -> crisp match for 100 km @ 1024

M_PER_DEG_LAT = 111132.92
M_PER_DEG_LON = 111412.84 * math.cos(math.radians(LAT0))

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

# Determine required tiles
lat_min, lon_min = world_to_latlon(-SIZE_M / 2, SIZE_M / 2)
lat_max, lon_max = world_to_latlon(SIZE_M / 2, -SIZE_M / 2)
x0, y0 = latlon_to_tile_xy(lat_max, lon_min, ZOOM)
x1, y1 = latlon_to_tile_xy(lat_min, lon_max, ZOOM)
tx_min, tx_max = int(math.floor(x0)), int(math.floor(x1))
ty_min, ty_max = int(math.floor(y0)), int(math.floor(y1))

tile_coords = [(tx, ty) for tx in range(tx_min, tx_max + 1) for ty in range(ty_min, ty_max + 1)]
print(f"Downloading {len(tile_coords)} Terrarium tiles at z={ZOOM} ({tx_min}..{tx_max}, {ty_min}..{ty_max})...")

def fetch_tile(coord):
    tx, ty = coord
    url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{ZOOM}/{tx}/{ty}.png"
    req = urllib.request.Request(url, headers={"User-Agent": "falcon-infinite-dem-baker/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        img = Image.open(io.BytesIO(resp.read())).convert("RGB")
    return coord, img

tiles = {}
with ThreadPoolExecutor(max_workers=8) as ex:
    for coord, img in ex.map(fetch_tile, tile_coords):
        tiles[coord] = img

# Stitch into one big RGB image
tw = (tx_max - tx_min + 1) * 256
th = (ty_max - ty_min + 1) * 256
mosaic = Image.new("RGB", (tw, th))
for (tx, ty), img in tiles.items():
    mosaic.paste(img, ((tx - tx_min) * 256, (ty - ty_min) * 256))
m_pix = mosaic.load()

def sample_terrarium(lat, lon):
    xt, yt = latlon_to_tile_xy(lat, lon, ZOOM)
    px = (xt - tx_min) * 256.0
    py = (yt - ty_min) * 256.0
    ix = max(0, min(tw - 2, int(math.floor(px))))
    iy = max(0, min(th - 2, int(math.floor(py))))
    fx = max(0.0, min(1.0, px - ix))
    fy = max(0.0, min(1.0, py - iy))
    def h_at(x, y):
        r, g, b = m_pix[x, y]
        return (r * 256.0 + g + b / 256.0) - 32768.0
    h00 = h_at(ix, iy)
    h10 = h_at(ix + 1, iy)
    h01 = h_at(ix, iy + 1)
    h11 = h_at(ix + 1, iy + 1)
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy

# Encode as 16-bit RG PNG: val = round((h + 200.0) * 16.0), clamped 0..65535
out_img = Image.new("RGB", (GRID, GRID))
out_pix = out_img.load()
min_h, max_h = 1e9, -1e9
sea_cells = 0

for j in range(GRID):
    # j=0 is North (-SIZE_M/2), j=GRID-1 is South (+SIZE_M/2)
    z_m = -SIZE_M * 0.5 + (j / (GRID - 1)) * SIZE_M
    for i in range(GRID):
        x_m = -SIZE_M * 0.5 + (i / (GRID - 1)) * SIZE_M
        lat, lon = world_to_latlon(x_m, z_m)
        h = sample_terrarium(lat, lon)
        if h < min_h: min_h = h
        if h > max_h: max_h = h
        if h <= 0.5: sea_cells += 1
        q = max(0, min(65535, int(round((h + 200.0) * 16.0))))
        out_pix[i, j] = (q >> 8, q & 255, 0)

out_img.save("public/media/vipava_dem.png", optimize=True)

# Real landmarks & airports converted to world (x, z) metres
def ll_to_xz(lat, lon):
    return round((lon - LON0) * M_PER_DEG_LON), round(-(lat - LAT0) * M_PER_DEG_LAT)

airports = [
    {"id": "LJAJ", "code": "LJAJ", "name": "Ajdovscina Airfield", "ll": (45.8878, 13.8869), "heading": 74, "length": 1800, "width": 36},
    {"id": "LJPO", "code": "LJPO", "name": "Postojna Airfield", "ll": (45.7544, 14.1939), "heading": 100, "length": 1600, "width": 34},
    {"id": "LJDI", "code": "LJDI", "name": "Divaca Airfield", "ll": (45.6761, 13.9947), "heading": 120, "length": 1500, "width": 32},
    {"id": "LIPQ", "code": "LIPQ", "name": "Trieste Friuli Intl", "ll": (45.8275, 13.4722), "heading": 90, "length": 3000, "width": 45},
    {"id": "LJPZ", "code": "LJPZ", "name": "Portoroz Airport", "ll": (45.4733, 13.6150), "heading": 146, "length": 1800, "width": 36},
]
for ap in airports:
    x, z = ll_to_xz(*ap["ll"])
    ap["x"], ap["z"] = x, z
    ap["elevation"] = round(sample_terrarium(*ap["ll"]), 1)
    del ap["ll"]

meta = {
    "name": "Vipava Valley (100x100 km)",
    "lat0": LAT0,
    "lon0": LON0,
    "sizeM": SIZE_M,
    "grid": GRID,
    "offset": -200.0,
    "scale": 16.0,
    "minElevation": round(min_h, 1),
    "maxElevation": round(max_h, 1),
    "seaFraction": round(sea_cells / (GRID * GRID), 4),
    "airports": airports,
}
with open("public/media/vipava_meta.json", "w") as f:
    json.dump(meta, f, indent=2)

print(f"Baked public/media/vipava_dem.png: min={min_h:.1f}m max={max_h:.1f}m sea={meta['seaFraction']*100:.1f}%")
for ap in airports:
    print(f"  {ap['code']} {ap['name']}: ({ap['x']}, {ap['z']}) elev={ap['elevation']}m")
