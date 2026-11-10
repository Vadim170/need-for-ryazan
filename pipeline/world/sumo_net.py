"""Дорожная сеть через SUMO netconvert: полосы, ширины, формы перекрёстков."""
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

# ширина полосы по классу, м (SUMO по умолчанию 3.2 и игнорирует класс)
LANE_WIDTH = {
    "primary": 3.5, "primary_link": 3.5, "secondary": 3.5, "secondary_link": 3.5,
    "tertiary": 3.25, "tertiary_link": 3.25, "unclassified": 3.0, "residential": 3.0,
    "living_street": 2.75, "service": 2.75,
}
WORLD_PROJ = "+proj=tmerc +lat_0={lat} +lon_0={lon} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"


def netconvert_bin():
    p = Path(sys.executable).parent / "netconvert"
    if p.exists():
        return str(p)
    import sumo  # noqa: пакет eclipse-sumo
    return str(Path(sumo.SUMO_HOME) / "bin" / "netconvert")


def write_typemap(path):
    import sumo
    src = Path(sumo.SUMO_HOME) / "data" / "typemap" / "osmNetconvert.typ.xml"
    txt = src.read_text()
    for hw, w in LANE_WIDTH.items():
        txt = re.sub(rf'(<type id="highway\.{re.escape(hw)}(?:\|[^"]*)?"\s)', rf'\1width="{w}" ', txt)
    Path(path).write_text(txt)


def run_netconvert(osm_path, out_path, typemap_path, lat, lon):
    write_typemap(typemap_path)
    cmd = [netconvert_bin(), "--osm-files", str(osm_path), "--type-files", str(typemap_path),
           "--proj", WORLD_PROJ.format(lat=lat, lon=lon), "--offset.disable-normalization",
           "--junctions.join", "--osm.turn-lanes", "--junctions.corner-detail", "5",
           "--roundabouts.guess", "--ramps.guess", "--tls.guess-signals", "--no-turnarounds",
           "--osm.layer-elevation", "0", "--no-warnings",
           "-o", str(out_path)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("netconvert failed:\n" + r.stderr[-3000:])
    return r


def _shape(s):
    return np.array([[float(v) for v in p.split(",")[:2]] for p in s.split()], dtype=np.float64)


class Net:
    def __init__(self, path):
        self.edges = {}       # id -> dict
        self.junctions = {}   # id -> dict
        for _, el in ET.iterparse(path):
            if el.tag == "edge":
                if el.get("function") in ("internal", "walkingarea", "crossing"):
                    el.clear(); continue
                lanes = []
                for ln in el.iter("lane"):
                    lanes.append({"index": int(ln.get("index")), "width": float(ln.get("width", 3.2)),
                                  "shape": _shape(ln.get("shape")), "allow": ln.get("allow"), "disallow": ln.get("disallow")})
                lanes.sort(key=lambda l: l["index"])
                eid = el.get("id")
                m = re.match(r"-?(\d+)", eid)
                piece = int(m.group(1)) if m else -1
                self.edges[eid] = {"id": eid, "from": el.get("from"), "to": el.get("to"), "type": el.get("type", ""),
                                   "name": el.get("name", ""), "lanes": lanes,
                                   "osmId": piece // 100 if piece >= 0 else None,
                                   "spread": el.get("spreadType", "right")}
                el.clear()
            elif el.tag == "junction":
                if el.get("type") == "internal":
                    el.clear(); continue
                shp = el.get("shape")
                self.junctions[el.get("id")] = {"id": el.get("id"), "x": float(el.get("x")), "y": float(el.get("y")),
                                                "type": el.get("type"),
                                                "shape": _shape(shp) if shp else None}
                el.clear()
