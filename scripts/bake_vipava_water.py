import json, math, urllib.request, urllib.parse

LAT0 = 45.8878
LON0 = 13.8869
M_PER_DEG_LAT = 111132.92
M_PER_DEG_LON = 111412.84 * math.cos(math.radians(LAT0))

def ll_to_xz(lat, lon):
    return round((lon - LON0) * M_PER_DEG_LON, 1), round(-(lat - LAT0) * M_PER_DEG_LAT, 1)

# Fetch rivers, canals, and inland lakes/reservoirs across the 100x100 km Vipava/Soca/Karst region
query = """
[out:json][timeout:50];
(
  way["waterway"~"^(river|canal)$"](45.45,13.30,46.30,14.50);
  way["natural"="water"](45.45,13.30,46.30,14.50);
  way["waterway"="riverbank"](45.45,13.30,46.30,14.50);
);
out body;
>;
out skel qt;
"""

urls = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
data = urllib.parse.urlencode({"data": query}).encode("utf-8")
osm = None
for url in urls:
    try:
        print("Trying", url)
        req = urllib.request.Request(url, data=data, headers={"User-Agent": "falcon-infinite-water-baker/1.0"})
        with urllib.request.urlopen(req, timeout=55) as resp:
            osm = json.loads(resp.read().decode("utf-8"))
        break
    except Exception as e:
        print("  failed:", e)
if osm is None:
    raise SystemExit("All Overpass mirrors failed")

nodes = {}
ways = []
for el in osm.get("elements", []):
    if el["type"] == "node":
        nodes[el["id"]] = (el["lat"], el["lon"])
    elif el["type"] == "way":
        ways.append(el)

rivers = []
lakes = []

def poly_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % n]
        a += x1 * z2 - x2 * z1
    return abs(a) * 0.5

for w in ways:
    tags = w.get("tags", {})
    nds = w.get("nodes", [])
    pts = [ll_to_xz(*nodes[nid]) for nid in nds if nid in nodes]
    if len(pts) < 2:
        continue
    ww = tags.get("waterway", "")
    nat = tags.get("natural", "")
    if ww in ("river", "canal"):
        name = tags.get("name", "")
        width = 34 if ("Soča" in name or "Isonzo" in name) else 22 if ("Vipava" in name or "Idrijca" in name) else 15
        simp = [pts[0]]
        for p in pts[1:-1]:
            if math.hypot(p[0] - simp[-1][0], p[1] - simp[-1][1]) >= 35:
                simp.append(p)
        simp.append(pts[-1])
        if len(simp) >= 2:
            rivers.append({"w": width, "pts": simp})
    elif (nat == "water" or ww == "riverbank") and len(pts) >= 4:
        # Remove closing duplicate vertex for polygon triangulation
        ring = pts[:-1] if pts[0] == pts[-1] else pts
        if len(ring) < 3:
            continue
        area = poly_area(ring)
        if area < 2500:  # skip tiny ponds < 50x50 m
            continue
        simp = [ring[0]]
        for p in ring[1:]:
            if math.hypot(p[0] - simp[-1][0], p[1] - simp[-1][1]) >= 25:
                simp.append(p)
        if len(simp) >= 3:
            lakes.append({"pts": simp, "area": round(area)})

# Keep largest 350 lakes/riverbanks so JSON stays compact and fast
if len(lakes) > 350:
    lakes.sort(key=lambda l: -l["area"])
    lakes = lakes[:350]
lakes_out = [l["pts"] for l in lakes]

out = {"rivers": rivers, "lakes": lakes_out}
with open("public/media/vipava_water.json", "w") as f:
    json.dump(out, f, separators=(",", ":"))

print(f"Baked public/media/vipava_water.json: {len(rivers)} river ways, {len(lakes_out)} lakes/riverbanks!")
