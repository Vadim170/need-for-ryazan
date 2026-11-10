"""Чтение OSM-снимка: узлы в мировой СК, пути, отношения; выборка зданий, воды и автодорог."""
import re
import xml.etree.ElementTree as ET
from xml.sax.saxutils import quoteattr

import numpy as np
from shapely.geometry import LineString, Polygon
from shapely.ops import polygonize, unary_union
from shapely.validation import make_valid

from config import to_world

# классы автодорог, которые попадают в мир (порядок = приоритет)
CAR_HIGHWAYS = ["primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
                "unclassified", "residential", "living_street", "service"]
SERVICE_SKIP = {"parking_aisle", "drive-through", "emergency_access"}


class OsmData:
    def __init__(self, path):
        node_ids, lons, lats = [], [], []
        self.node_tags = {}
        self.ways = {}          # id -> (np.array node ids, tags)
        self.rels = []          # (id, tags, [(type, ref, role)])
        for _, el in ET.iterparse(path):
            t = el.tag
            if t == "node":
                nid = int(el.get("id"))
                node_ids.append(nid); lons.append(float(el.get("lon"))); lats.append(float(el.get("lat")))
                if len(el):
                    tg = {c.get("k"): c.get("v") for c in el.iter("tag")}
                    if tg.get("highway") in ("traffic_signals", "crossing", "stop", "give_way"):
                        self.node_tags[nid] = tg
                el.clear()
            elif t == "way":
                self.ways[int(el.get("id"))] = (np.array([int(n.get("ref")) for n in el.iter("nd")], dtype=np.int64),
                                                {c.get("k"): c.get("v") for c in el.iter("tag")})
                el.clear()
            elif t == "relation":
                self.rels.append((int(el.get("id")), {c.get("k"): c.get("v") for c in el.iter("tag")},
                                  [(m.get("type"), int(m.get("ref")), m.get("role") or "") for m in el.iter("member")]))
                el.clear()
        self.node_ids = np.array(node_ids, dtype=np.int64)
        self.lonlat = np.c_[lons, lats]
        x, y = to_world.transform(np.array(lons), np.array(lats))
        self.xy = np.c_[x, y]
        order = np.argsort(self.node_ids)
        self.node_ids, self.xy, self.lonlat = self.node_ids[order], self.xy[order], self.lonlat[order]

    def node_index(self, ids):
        i = np.searchsorted(self.node_ids, ids)
        i = np.clip(i, 0, len(self.node_ids) - 1)
        ok = self.node_ids[i] == ids
        return i, ok

    def way_xy(self, wid):
        refs, _ = self.ways[wid]
        i, ok = self.node_index(refs)
        return self.xy[i[ok]]

    # ---------------- полигоны
    def way_polygon(self, wid):
        pts = self.way_xy(wid)
        if len(pts) < 4 or not np.allclose(pts[0], pts[-1]):
            return None
        return _valid(Polygon(pts))

    def rel_polygon(self, members):
        outs, ins = [], []
        for typ, ref, role in members:
            if typ != "way" or ref not in self.ways:
                continue
            pts = self.way_xy(ref)
            if len(pts) < 2:
                continue
            (ins if role == "inner" else outs).append(LineString(pts))
        if not outs:
            return None
        po = unary_union(list(polygonize(unary_union(outs))))
        if ins:
            hole = unary_union(list(polygonize(unary_union(ins))))
            po = po.difference(hole)
        return _valid(po)

    def buildings(self):
        """[(polygon, tags)] — пути building=* и мультиполигоны building."""
        out = []
        for wid, (refs, tg) in self.ways.items():
            if tg.get("building", "no") != "no" and refs[0] == refs[-1]:
                p = self.way_polygon(wid)
                if p is not None:
                    out.append((p, tg, wid))
        for rid, tg, mem in self.rels:
            if tg.get("type") == "multipolygon" and tg.get("building", "no") != "no":
                p = self.rel_polygon(mem)
                if p is not None:
                    out.append((p, tg, rid))
        return out

    def water(self):
        """[(polygon, tags)] водные поверхности (natural=water, waterway=riverbank, landuse=reservoir/basin)."""
        def is_water(tg):
            return (tg.get("natural") == "water" or tg.get("waterway") in ("riverbank", "dock")
                    or tg.get("landuse") in ("reservoir", "basin"))
        out = []
        for wid, (refs, tg) in self.ways.items():
            if is_water(tg) and refs[0] == refs[-1]:
                p = self.way_polygon(wid)
                if p is not None:
                    out.append((p, tg))
        for rid, tg, mem in self.rels:
            if tg.get("type") == "multipolygon" and is_water(tg):
                p = self.rel_polygon(mem)
                if p is not None:
                    out.append((p, tg))
        return out

    # ---------------- дороги
    def car_ways(self):
        out = {}
        for wid, (refs, tg) in self.ways.items():
            hw = tg.get("highway")
            if hw not in CAR_HIGHWAYS or tg.get("area") == "yes":
                continue
            if hw == "service" and tg.get("service") in SERVICE_SKIP:
                continue
            if tg.get("access") in ("no",) or tg.get("motor_vehicle") == "no":
                continue
            out[wid] = (refs, tg)
        return out

    def write_filtered_osm(self, path, ways, inside_fn):
        """Пишет OSM-файл только с автодорогами, разрезанными по границе мира (для netconvert).
        Новый id куска пути = osm_id * 100 + k (k — номер непрерывного куска внутри границы)."""
        used = set()
        lines = []
        for wid, (refs, tg) in ways.items():
            i, ok = self.node_index(refs)
            ins = inside_fn(self.xy[i]) & ok
            runs, cur = [], []
            for r, f in zip(refs, ins):
                if f:
                    cur.append(r)
                else:
                    if len(cur) >= 2: runs.append(cur)
                    cur = []
            if len(cur) >= 2: runs.append(cur)
            for k, run in enumerate(runs[:100]):
                used.update(run)
                body = "".join(f'<nd ref="{r}"/>' for r in run)
                skip = ("est_width",) if "nfr:width" in tg else ("width", "est_width")   # width — только из data/overrides
                body += "".join(f"<tag k={quoteattr(a)} v={quoteattr(b)}/>" for a, b in tg.items() if a not in skip)
                lines.append(f'<way id="{wid * 100 + k}" version="1">{body}</way>')
        used = np.array(sorted(used), dtype=np.int64)
        idx, _ = self.node_index(used)
        nl = []
        for nid, (lon, lat) in zip(used, self.lonlat[idx]):
            tg = self.node_tags.get(int(nid))
            if tg:
                t = "".join(f"<tag k={quoteattr(a)} v={quoteattr(b)}/>" for a, b in tg.items())
                nl.append(f'<node id="{nid}" version="1" lat="{lat:.8f}" lon="{lon:.8f}">{t}</node>')
            else:
                nl.append(f'<node id="{nid}" version="1" lat="{lat:.8f}" lon="{lon:.8f}"/>')
        with open(path, "w", encoding="utf-8") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6">\n')
            f.write("\n".join(nl)); f.write("\n"); f.write("\n".join(lines)); f.write("\n</osm>\n")


def _valid(p):
    if p is None or p.is_empty:
        return None
    if not p.is_valid:
        p = make_valid(p)
        polys = [g for g in getattr(p, "geoms", [p]) if g.geom_type in ("Polygon", "MultiPolygon")]
        if not polys:
            return None
        p = unary_union(polys)
    return p if p.area > 1.0 else None


_num = re.compile(r"\d+(?:\.\d+)?")


def parse_numbers(s):
    if not s:
        return []
    return [float(m) for m in _num.findall(s)]
