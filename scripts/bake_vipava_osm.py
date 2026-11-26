import json, math, urllib.request, urllib.parse

LAT0 = 45.8878
LON0 = 13.8869
M_PER_DEG_LAT = 111132.92
M_PER_DEG_LON = 111412.84 * math.cos(math.radians(LAT0))

def ll_to_xz(lat, lon):
    return round((lon - LON0) * M_PER_DEG_LON, 1), round(-(lat - LAT0) * M_PER_DEG_LAT, 1)

URLS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

def query_overpass(q):
    data = urllib.parse.urlencode({"data": q}).encode("utf-8")
    for url in URLS:
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "falcon-infinite-osm-baker/2.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print("  mirror failed:", url, e)
    return None

# Keep existing baked highways if already present so we don't re-fetch 2933 highways unnecessarily
try:
    existing = json.load(open("public/media/vipava_osm.json"))
    roads = existing.get("roads", [])
    print(f"Reusing {len(roads)} existing highway ways from vipava_osm.json")
except Exception:
    roads = []

# Fetch buildings across all major cities & towns in the 100x100 km Vipava region
CITIES = [
    ("Ajdovscina+Vipava", (45.82, 13.84, 45.92, 13.98), 1400),
    ("NovaGorica+Gorizia+Solkan", (45.92, 13.59, 45.99, 13.68), 1400),
    ("Tolmin+MostNaSoci", (46.14, 13.71, 46.20, 13.76), 550),
    ("Trieste", (45.62, 13.74, 45.68, 13.82), 1400),
    ("Koper", (45.535, 13.71, 45.56, 13.76), 650),
    ("Izola+Piran", (45.515, 13.56, 45.545, 13.68), 550),
    ("Postojna", (45.76, 14.19, 45.79, 14.23), 550),
    ("Sezana+Divaca", (45.67, 13.85, 45.72, 13.99), 500),
    ("Idrija", (45.99, 14.01, 46.02, 14.05), 400),
    ("Monfalcone", (45.79, 13.51, 45.83, 13.56), 500),
    ("Stanjel+Kras", (45.81, 13.83, 45.84, 13.87), 220),
]

all_buildings = []
for name, (s, w, n, e), cap in CITIES:
    print(f"Fetching OSM buildings for {name}...")
    q = f"[out:json][timeout:45];(way[\"building\"]({s},{w},{n},{e}););out body;>;out skel qt;"
    osm = query_overpass(q)
    if osm is None:
        print(f"  !! skipped {name} after mirror timeout")
        continue
    nodes = {}
    ways = []
    for el in osm.get("elements", []):
        if el["type"] == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])
        elif el["type"] == "way":
            ways.append(el)
    city_b = []
    for way in ways:
        tags = way.get("tags", {})
        nds = way.get("nodes", [])
        pts = [ll_to_xz(*nodes[nid]) for nid in nds if nid in nodes]
        if len(pts) < 3:
            continue
        xs = [p[0] for p in pts[:-1]] if pts[0] == pts[-1] else [p[0] for p in pts]
        zs = [p[1] for p in pts[:-1]] if pts[0] == pts[-1] else [p[1] for p in pts]
        if not xs:
            continue
        cx = sum(xs) / len(xs)
        cz = sum(zs) / len(zs)
        best_len = 0
        rot = 0.0
        for i in range(len(pts) - 1):
            dx = pts[i + 1][0] - pts[i][0]
            dz = pts[i + 1][1] - pts[i][1]
            L = math.hypot(dx, dz)
            if L > best_len:
                best_len = L
                rot = math.atan2(dx, dz)
        c, sn = math.cos(-rot), math.sin(-rot)
        us = [(x - cx) * c - (z - cz) * sn for x, z in zip(xs, zs)]
        vs = [(x - cx) * sn + (z - cz) * c for x, z in zip(xs, zs)]
        bw = max(5.0, min(110.0, max(us) - min(us)))
        bd = max(5.0, min(110.0, max(vs) - min(vs)))
        if bw * bd < 32:
            continue
        lvls = tags.get("building:levels")
        try:
            levels = max(1, min(18, int(float(lvls)))) if lvls else None
        except Exception:
            levels = None
        btype = tags.get("building", "yes")
        if btype in ("industrial", "warehouse", "commercial", "retail"):
            kc = 2
            h = (levels * 3.8) if levels else 9.0
        elif btype in ("apartments", "office", "public", "school", "hospital", "hotel"):
            kc = 1
            h = (levels * 3.4) if levels else 15.0
        elif btype in ("church", "cathedral", "chapel", "basilica"):
            kc = 3
            h = 28.0
        else:
            kc = 0
            h = (levels * 3.0) if levels else 7.0
        city_b.append([round(cx, 1), round(cz, 1), round(bw, 1), round(bd, 1), round(h, 1), round(rot, 3), kc])
    if len(city_b) > cap:
        # Always keep churches (kc==3), then largest volume buildings
        churches = [b for b in city_b if b[6] == 3]
        others = [b for b in city_b if b[6] != 3]
        others.sort(key=lambda b: -(b[2] * b[3] * b[4]))
        city_b = churches[:120] + others[:max(0, cap - min(120, len(churches)))]
    print(f"  -> kept {len(city_b)} buildings for {name}")
    all_buildings.extend(city_b)

# Iconic handcrafted landmarks (real GPS coordinates!)
RAW_LANDMARKS = [
    {"id": "sveta-gora", "name": "Sveta Gora Basilica", "kind": "church", "ll": (45.9953, 13.6584), "rot": 0.4, "scale": 1.35},
    {"id": "solkan-bridge", "name": "Solkan Stone Arch Bridge", "kind": "bridge", "ll": (45.9781, 13.6522), "rot": 1.48, "length": 220, "height": 36},
    {"id": "solkan-dam", "name": "Solkan Hydro Dam", "kind": "dam", "ll": (45.9794, 13.6538), "rot": 0.25, "length": 115, "height": 24},
    {"id": "vogrscek-dam", "name": "Vogrscek Dam", "kind": "dam", "ll": (45.9016, 13.7192), "rot": 0.65, "length": 280, "height": 32},
    {"id": "nanos-tower", "name": "Nanos Broadcast Tower (Plesa)", "kind": "tower", "ll": (45.7717, 14.0533), "rot": 0, "height": 95},
    {"id": "gorizia-castle", "name": "Gorizia Castle", "kind": "castle", "ll": (45.9439, 13.6281), "rot": 0.3, "scale": 1.25},
    {"id": "kostanjevica", "name": "Kostanjevica Monastery", "kind": "church", "ll": (45.9467, 13.6386), "rot": 0.8, "scale": 1.05},
    {"id": "faro-vittoria", "name": "Faro della Vittoria (Trieste)", "kind": "lighthouse", "ll": (45.6753, 13.7575), "rot": 0, "height": 68},
    {"id": "piran-belltower", "name": "St. George Bell Tower (Piran)", "kind": "church", "ll": (45.5292, 13.5689), "rot": 0.2, "scale": 1.15},
    {"id": "predjama-castle", "name": "Predjama Castle", "kind": "castle", "ll": (45.8156, 14.1267), "rot": 1.1, "scale": 1.15},
    {"id": "stanjel-castle", "name": "Stanjel Hilltop Village", "kind": "castle", "ll": (45.8236, 13.8453), "rot": 0.5, "scale": 1.1},
    {"id": "vipava-bridge", "name": "Vipava H4 Viaduct", "kind": "bridge", "ll": (45.8475, 13.9460), "rot": 1.15, "length": 340, "height": 28},
]

landmarks = []
for lm in RAW_LANDMARKS:
    x, z = ll_to_xz(*lm["ll"])
    entry = {k: v for k, v in lm.items() if k != "ll"}
    entry["x"] = x
    entry["z"] = z
    landmarks.append(entry)

out = {"roads": roads, "buildings": all_buildings, "landmarks": landmarks}
with open("public/media/vipava_osm.json", "w") as f:
    json.dump(out, f, separators=(",", ":"))

print(f"DONE! Baked {len(roads)} highways, {len(all_buildings)} real buildings across {len(CITIES)} cities, and {len(landmarks)} iconic landmarks!")
