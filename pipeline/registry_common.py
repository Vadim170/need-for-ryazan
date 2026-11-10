"""Общие функции для fetch_registry.py / match_registry.py: чтение зданий OSM, нормализация адресов."""
import re
import xml.etree.ElementTree as ET

from shapely.geometry import Polygon

from config import BBOX, DATA_RAW, to_world

OSM = DATA_RAW / "osm" / "ryazan.osm"
MARGIN = 0.002  # градусов вокруг bbox: здания на границе не теряем


# ---------- OSM ----------

def load_osm_buildings(path=OSM):
    """Здания-ways (замкнутые) внутри BBOX. Возвращает список dict:
    id, tags, poly (shapely, мировые метры), area, lat, lon.
    Файл ryazan.osm может содержать данные вне bbox (оверпасс-зеркала отдавали «всю страну») — фильтруем сами."""
    s, w, n, e = BBOX
    s, w, n, e = s - MARGIN, w - MARGIN, n + MARGIN, e + MARGIN
    nodes = {}
    out = []
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag == "node":
            lat, lon = float(el.get("lat")), float(el.get("lon"))
            if s <= lat <= n and w <= lon <= e:
                nodes[int(el.get("id"))] = (lon, lat)
            el.clear()
        elif el.tag == "way":
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if "building" in tags:
                refs = [int(nd.get("ref")) for nd in el.findall("nd")]
                if len(refs) >= 4 and refs[0] == refs[-1] and all(r in nodes for r in refs):
                    pts = [to_world.transform(*nodes[r]) for r in refs]
                    poly = Polygon(pts)
                    if poly.is_valid and poly.area > 1:
                        lon, lat = nodes[refs[0]]
                        out.append({"id": int(el.get("id")), "tags": tags, "poly": poly, "area": poly.area,
                                    "lat": lat, "lon": lon})
            el.clear()
    return out


# ---------- нормализация ----------

_HOMO = str.maketrans("abcekmhopxyt", "авсекмнорхут")  # латинские двойники -> кириллица
STREET_TYPES = {
    "улица", "ул", "проспект", "пр-кт", "пр-т", "просп", "пр", "переулок", "пер", "проезд", "пр-д", "пр-зд",
    "шоссе", "ш", "площадь", "пл", "бульвар", "б-р", "бул", "набережная", "наб", "тупик", "туп", "линия", "лин",
    "микрорайон", "мкр", "поселок", "посёлок", "п", "аллея", "ал", "квартал", "кв-л", "территория", "тер",
    "город", "г", "район", "р-н", "обл", "область", "рязань", "рязанская", "дорога", "дор",
}
_ORD = re.compile(r"^(\d+)-?(?:й|я|е|ое|ая|ый|го|ой|и|ые)?$")


def _base(s):
    return s.lower().replace("ё", "е")


def street_key(name):
    """Ключ улицы: без типа (улица/пр-кт/пер. ...), порядок слов не важен, '1-й' == '1'."""
    s = _base(name or "")
    s = re.sub(r"[.,()«»\"']", " ", s)
    toks = []
    for t in s.split():
        if t in STREET_TYPES:
            continue
        m = _ORD.match(t)
        if m:
            t = m.group(1)
        toks.append(t)
    return " ".join(sorted(toks))


_NUM = re.compile(
    r"^(?P<n>\d+)\s*(?P<l>[а-я])?"
    r"(?:\s*(?:/|-)\s*(?P<f>\d+)\s*(?P<fl>[а-я])?)?"
    r"(?:\s*,?\s*(?:к|корп|корпус)\.?\s*(?P<k>[0-9а-я]+))?"
    r"(?:\s*,?\s*(?:с|стр|строение)\.?\s*(?P<s>[0-9а-я]+))?"
    r"(?:\s*,?\s*(?:лит|литера|литер|л)\.?\s*(?P<lit>[а-я]))?$"
)


def house_key(raw):
    """'12А', '12/1', 'д. 95, к. 1', '10 к А' -> канонический ключ '12а' / '12/1' / '95/1' / '10а'.
    '/' и 'к' считаем эквивалентными (в реестрах «6/1» и «6 к.1» — одно и то же). Строение — суффикс 'с<N>'.
    Возвращает None для нераспознанного."""
    s = _base(raw or "").translate(_HOMO)
    s = re.sub(r"^\s*(?:д|дом)\.?\s*", "", s)
    s = re.sub(r"\s+", " ", s).strip(" .,")
    m = _NUM.match(s)
    if not m:
        return None
    n = m.group("n")
    letter = m.group("l") or ""
    k = m.group("k")
    f = m.group("f")
    lit = m.group("lit") or ""
    key = n + letter
    sub = k or f
    if sub:
        # «10 к А» — это просто литера А
        if re.fullmatch(r"[а-я]", sub) and not letter:
            key = n + sub
        else:
            key += "/" + sub + (m.group("fl") or "")
    if m.group("s"):
        key += "с" + m.group("s")
    key += lit
    return key


def split_housenumbers(raw):
    """OSM addr:housenumber может быть '12;14' или '12, 14'. Возвращает список ключей."""
    if not raw:
        return []
    keys = []
    for part in re.split(r"[;]|,(?!\s*(?:к|корп|с|стр)\b)", _base(raw)):
        k = house_key(part)
        if k:
            keys.append(k)
    return keys


def osm_street_keys(buildings):
    return {street_key(b["tags"]["addr:street"]) for b in buildings if b["tags"].get("addr:street")}


def parse_registry_address(addr):
    """'обл. Рязанская, г. Рязань, ул. Бабушкина, д. 7/4' / 'ул. Ленинского Комсомола, д. 95, к. 1'
    -> (street_name, house_raw) или (None, None)."""
    parts = [p.strip() for p in addr.split(",")]
    di = next((i for i, p in enumerate(parts) if re.match(r"^(?:д|дом)\.?\s", p, re.I) or re.match(r"^д\.?\d", p, re.I)), None)
    if di is None or di == 0:
        return None, None
    street = parts[di - 1]
    house = ", ".join(parts[di:])
    return street, house
