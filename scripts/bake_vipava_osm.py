import json, math, urllib.request, urllib.parse

LAT0 = 45.8878
LON0 = 13.8869
M_PER_DEG_LAT = 111132.92
M_PER_DEG_LON = 111412.84 * math.cos(math.radians(LAT0))

def ll_to_xz(lat, lon):
    return round((lon - LON0) * M_PER_DEG_LON, 1), round(-(lat - LAT0) * M_PER_DEG_LAT, 1)

# 1. Fetch major roads across the ~60x60 km core (H4, A1, A3, primary, secondary)
#    plus buildings in the central Vipava Valley (Ajdovscina + Vipava + surrounding villages)
query = """
[out:json][timeout:45];
(
  way["highway"~"^(motorway|trunk|primary)$"](45.55,13.45,46.20,14.30);
  way["building"](45.82,13.84,45.92,13.98);
);
out body;
>;
out skel qt;
"""

urls = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]
data = urllib.parse.urlencode({"data": query}).encode("utf-8")
osm = None
for url in urls:
    try:
        print("Trying", url)
        req = urllib.request.Request(url, data=data, headers={"User-Agent": "falcon-infinite-osm-baker/1.0"})
        with urllib.request.urlopen(req, timeout=45) as resp:
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

roads = []
buildings = []
for w in ways:
    tags = w.get("tags", {})
    nds = w.get("nodes", [])
    pts = [ll_to_xz(*nodes[nid]) for nid in nds if nid in nodes]
    if len(pts) < 2:
        continue
    if "highway" in tags:
        hw = tags["highway"]
        width = 16 if hw == "motorway" else 13 if hw == "trunk" else 10
        # Simplify polyline by keeping points >= 45m apart
        simp = [pts[0]]
        for p in pts[1:-1]:
            if math.hypot(p[0] - simp[-1][0], p[1] - simp[-1][1]) >= 45:
                simp.append(p)
        simp.append(pts[-1])
        if len(simp) >= 2:
            roads.append({"w": width, "pts": simp})
    elif "building" in tags and len(pts) >= 3:
        # Compute centroid + bounding box + dominant edge orientation
        xs = [p[0] for p in pts[:-1]] if pts[0] == pts[-1] else [p[0] for p in pts]
        zs = [p[1] for p in pts[:-1]] if pts[0] == pts[-1] else [p[1] for p in pts]
        if not xs:
            continue
        cx = sum(xs) / len(xs)
        cz = sum(zs) / len(zs)
        # Estimate orientation from longest edge
        best_len = 0
        rot = 0.0
        for i in range(len(pts) - 1):
            dx = pts[i + 1][0] - pts[i][0]
            dz = pts[i + 1][1] - pts[i][1]
            L = math.hypot(dx, dz)
            if L > best_len:
                best_len = L
                rot = math.atan2(dx, dz)
        c, s = math.cos(-rot), math.sin(-rot)
        us = [(x - cx) * c - (z - cz) * s for x, z in zip(xs, zs)]
        vs = [(x - cx) * s + (z - cz) * c for x, z in zip(xs, zs)]
        bw = max(5.0, min(90.0, max(us) - min(us)))
        bd = max(5.0, min(90.0, max(vs) - min(vs)))
        if bw * bd < 28:
            continue
        lvls = tags.get("building:levels")
        try:
            levels = max(1, min(14, int(float(lvls)))) if lvls else None
        except Exception:
            levels = None
        btype = tags.get("building", "yes")
        if btype in ("industrial", "warehouse", "commercial", "retail"):
            kind = "industrial"
            h = (levels * 3.8) if levels else 8.5
        elif btype in ("apartments", "office", "public", "school", "hospital"):
            kind = "apartment"
            h = (levels * 3.3) if levels else 13.0
        elif btype in ("church", "cathedral"):
            kind = "tower"
            h = 24.0
        else:
            kind = "house"
            h = (levels * 3.0) if levels else 6.5
        # Compact array format: [x, z, w, d, h, rot, kindCode]
        # kindCode: 0=house, 1=apartment, 2=industrial, 3=tower
        kc = 0 if kind == "house" else 1 if kind == "apartment" else 2 if kind == "industrial" else 3
        buildings.append([round(cx, 1), round(cz, 1), round(bw, 1), round(bd, 1), round(h, 1), round(rot, 3), kc])

# Cap buildings to 2800 largest footprints if huge so JSON stays fast & compact
if len(buildings) > 2800:
    buildings.sort(key=lambda b: -(b[2] * b[3] * b[4]))
    buildings = buildings[:2800]

out = {"roads": roads, "buildings": buildings}
with open("public/media/vipava_osm.json", "w") as f:
    json.dump(out, f, separators=(",", ":"))

print(f"Baked public/media/vipava_osm.json: {len(roads)} major highway ways, {len(buildings)} real OSM buildings!")
