"""Минимальный писатель GLB (glTF 2.0): ноды с именами, примитивы по материалам, extras."""
import json
import struct

import numpy as np

# простые PBR-цвета; текстуры игра подставит по имени материала
MATERIALS = {
    "terrain": ([0.40, 0.47, 0.30, 1.0], 0.95, 0.0),
    "road_asphalt": ([0.20, 0.20, 0.21, 1.0], 0.9, 0.0),
    "road_junction": ([0.20, 0.20, 0.21, 1.0], 0.9, 0.0),
    "sidewalk": ([0.55, 0.55, 0.53, 1.0], 0.9, 0.0),
    "curb": ([0.68, 0.68, 0.66, 1.0], 0.85, 0.0),
    "road_marking": ([0.92, 0.92, 0.90, 1.0], 0.7, 0.0),
    "bridge_concrete": ([0.58, 0.57, 0.55, 1.0], 0.85, 0.0),
    "water": ([0.18, 0.30, 0.40, 1.0], 0.15, 0.0),
    "building_apartments": ([0.80, 0.76, 0.70, 1.0], 0.85, 0.0),
    "building_house": ([0.78, 0.62, 0.48, 1.0], 0.85, 0.0),
    "building_commercial": ([0.62, 0.68, 0.74, 1.0], 0.6, 0.0),
    "building_garage": ([0.55, 0.55, 0.55, 1.0], 0.9, 0.0),
    "building_other": ([0.70, 0.70, 0.68, 1.0], 0.85, 0.0),
    "building": ([1.0, 1.0, 1.0, 1.0], 0.85, 0.0),   # v2: цвет в COLOR_0, архетип в _ARCH (docs/world-format.md)
    "collider": ([1.0, 0.0, 1.0, 1.0], 1.0, 0.0),
}


class Prim:
    """Накопитель геометрии одного материала."""
    def __init__(self):
        self.pos, self.nrm, self.uv, self.idx = [], [], [], []
        self.n = 0

    def add(self, pos, idx, nrm=None, uv=None, attrs=None):
        """attrs: доп. атрибуты glTF {имя: массив (n, k)} — COLOR_0, TEXCOORD_1, _ARCH… (dtype сохраняется:
        uint8 -> UNSIGNED_BYTE; у COLOR_0 — normalized). Должны быть у каждого add этого примитива."""
        pos = np.asarray(pos, np.float32)
        if len(pos) == 0 or len(idx) == 0:
            return
        self.pos.append(pos)
        if nrm is not None: self.nrm.append(np.asarray(nrm, np.float32))
        if uv is not None: self.uv.append(np.asarray(uv, np.float32))
        if attrs:
            if not hasattr(self, "attrs"):
                self.attrs = {}
            for k, v in attrs.items():
                self.attrs.setdefault(k, []).append(np.asarray(v))
        self.idx.append(np.asarray(idx, np.int64).ravel() + self.n)
        self.n += len(pos)

    def extra_arrays(self):
        return {k: np.concatenate(v) for k, v in getattr(self, "attrs", {}).items() if len(v) == len(self.pos)}

    def empty(self):
        return self.n == 0

    def arrays(self):
        P = np.concatenate(self.pos)
        N = np.concatenate(self.nrm) if self.nrm and len(self.nrm) == len(self.pos) else None
        U = np.concatenate(self.uv) if self.uv and len(self.uv) == len(self.pos) else None
        I = np.concatenate(self.idx)
        return P, N, U, I


def write_glb(path, nodes):
    """nodes: [(name, {material: Prim}, extras|None)] — пустые ноды пропускаются."""
    bin_parts, views, accessors, meshes, gnodes = [], [], [], [], []
    mat_index, materials = {}, []
    offset = 0

    def add_view(data, target):
        nonlocal offset
        b = data.tobytes()
        pad = (-len(b)) % 4
        bin_parts.append(b + b"\0" * pad)
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(b), "target": target})
        offset += len(b) + pad
        return len(views) - 1

    def add_acc(data, ctype, typ, target, minmax=False):
        v = add_view(data, target)
        a = {"bufferView": v, "componentType": ctype, "count": int(data.shape[0]), "type": typ}
        if minmax:
            a["min"] = data.min(axis=0).tolist(); a["max"] = data.max(axis=0).tolist()
        accessors.append(a)
        return len(accessors) - 1

    for name, prims, extras in nodes:
        gprims = []
        for mname, pr in prims.items():
            if pr is None or pr.empty():
                continue
            P, N, U, I = pr.arrays()
            attrs = {"POSITION": add_acc(P, 5126, "VEC3", 34962, True)}
            if N is not None: attrs["NORMAL"] = add_acc(N, 5126, "VEC3", 34962)
            if U is not None: attrs["TEXCOORD_0"] = add_acc(U, 5126, "VEC2", 34962)
            for an, A in pr.extra_arrays().items():
                A = A.reshape(len(A), -1)
                ct = 5121 if A.dtype == np.uint8 else 5126
                A = A.astype(np.uint8 if ct == 5121 else np.float32)
                attrs[an] = add_acc(A, ct, "SCALAR" if A.shape[1] == 1 else f"VEC{A.shape[1]}", 34962)
                if an == "COLOR_0" and ct == 5121:
                    accessors[attrs[an]]["normalized"] = True
            if len(P) < 65536:
                ia = add_acc(I.astype(np.uint16), 5123, "SCALAR", 34963)
            else:
                ia = add_acc(I.astype(np.uint32), 5125, "SCALAR", 34963)
            gp = {"attributes": attrs, "indices": ia, "mode": getattr(pr, "mode", 4)}   # mode 0 — точки (инстансы)
            if mname:
                if mname not in mat_index:
                    col, rough, metal = MATERIALS.get(mname, ([0.7, 0.7, 0.7, 1.0], 0.9, 0.0))
                    mat_index[mname] = len(materials)
                    materials.append({"name": mname, "pbrMetallicRoughness": {
                        "baseColorFactor": col, "roughnessFactor": rough, "metallicFactor": metal}})
                gp["material"] = mat_index[mname]
            gprims.append(gp)
        if not gprims:
            continue
        meshes.append({"name": name, "primitives": gprims})
        nd = {"name": name, "mesh": len(meshes) - 1}
        if extras:
            nd["extras"] = extras
            meshes[-1]["extras"] = extras
        gnodes.append(nd)

    gltf = {"asset": {"version": "2.0", "generator": "need-for-ryazan pipeline/build_world.py"},
            "scene": 0, "scenes": [{"nodes": list(range(len(gnodes)))}]}
    if gnodes:  # пустой тайл: валидный glTF без буферов (byteLength 0 запрещён спецификацией)
        gltf.update({"nodes": gnodes, "meshes": meshes, "accessors": accessors, "bufferViews": views,
                     "buffers": [{"byteLength": offset}]})
    if materials:
        gltf["materials"] = materials
    js = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    js += b" " * ((-len(js)) % 4)
    binb = b"".join(bin_parts)
    total = 12 + 8 + len(js) + (8 + len(binb) if binb else 0)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        if binb:
            f.write(struct.pack("<II", len(binb), 0x004E4942)); f.write(binb)
    return total


def fix_winding(pos, idx, up_hint):
    """Переворачивает треугольники, чья нормаль смотрит против up_hint (массив (T,3) или (3,))."""
    idx = np.asarray(idx, np.int64).reshape(-1, 3)
    p = np.asarray(pos, np.float64)
    n = np.cross(p[idx[:, 1]] - p[idx[:, 0]], p[idx[:, 2]] - p[idx[:, 0]])
    flip = (n * up_hint).sum(axis=1) < 0
    idx[flip] = idx[flip][:, [0, 2, 1]]
    return idx


def smooth_normals(pos, idx):
    idx = np.asarray(idx, np.int64).reshape(-1, 3)
    p = np.asarray(pos, np.float64)
    fn = np.cross(p[idx[:, 1]] - p[idx[:, 0]], p[idx[:, 2]] - p[idx[:, 0]])
    vn = np.zeros_like(p)
    for k in range(3):
        np.add.at(vn, idx[:, k], fn)
    l = np.linalg.norm(vn, axis=1, keepdims=True)
    l[l == 0] = 1
    vn = vn / l
    vn[np.linalg.norm(vn, axis=1) == 0] = (0, 1, 0)
    return vn.astype(np.float32)
