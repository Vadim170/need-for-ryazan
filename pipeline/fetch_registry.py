"""Сбор атрибутов многоквартирных домов Рязани из публичных реестров (без логина).

Источники (проверено 2026-10-13):
  domreestr  — domreestr.ru: год, этажность (мин/макс), подъезды, квартиры, серия, КООРДИНАТЫ дома.
  mkdbase    — mkdbase.ru:   год, этажность, подъезды, лифты, серия, материал несущих стен, форма крыши, тип кровли.
Не работают: dom.mingkh.ru (антибот-«капча» на всех страницах), reformagkh.ru (403), dom.gosuslugi.ru (нет ответа).

Вежливо: User-Agent с контактом, ~1.4 запроса/с, ретраи с backoff, кэш каждой страницы в data/raw/registry/<source>/
(повторный запуск ничего не перекачивает). Только Рязань и только адреса, которые есть в OSM bbox
(пара «улица + номер дома» после нормализации).

Запуск:  cd pipeline && uv run python fetch_registry.py [domreestr|mkdbase|all] [--limit N]
Выход:   data/raw/registry/domreestr.json, data/raw/registry/mkdbase.json
"""
import hashlib
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from html import unescape
from urllib.parse import urljoin

import requests

from config import DATA_RAW
from registry_common import (house_key, load_osm_buildings, parse_registry_address, split_housenumbers,
                             street_key)

HEADERS = {"User-Agent": "need-for-ryazan-pipeline/0.1 (personal non-commercial project; v.makarov@dodobrands.io)"}
MIN_INTERVAL = 0.7  # с между запросами
CACHE = DATA_RAW / "registry"

_last = [0.0]
_lock = threading.Lock()
WORKERS = 3  # запросы идут ~1.5-2 с; 3 потока + общий лимитер ≈ 1.4 запроса/с суммарно
_sess = requests.Session()
_sess.headers.update(HEADERS)


def get(source, url, tries=4, data=None):
    """GET с кэшем на диске, троттлингом и ретраями. Возвращает текст или None (404)."""
    d = CACHE / source
    d.mkdir(parents=True, exist_ok=True)
    f = d / (hashlib.sha1((url + (str(data) if data else "")).encode()).hexdigest()[:16] + ".html")
    if f.exists():
        return f.read_text(encoding="utf8") or None
    for attempt in range(tries):
        with _lock:  # общий лимитер на все потоки: резервируем слот
            slot = max(time.time(), _last[0] + MIN_INTERVAL)
            _last[0] = slot
        time.sleep(max(0, slot - time.time()))
        try:
            r = _sess.post(url, data=data, timeout=30) if data else _sess.get(url, timeout=30)
        except requests.RequestException as ex:
            print("  error", url, repr(ex)[:100], flush=True)
            time.sleep(5 * (attempt + 1))
            continue
        if r.status_code == 200:
            f.write_text(r.text, encoding="utf8")
            return r.text
        if r.status_code == 404:
            f.write_text("", encoding="utf8")
            return None
        print("  status", r.status_code, url, flush=True)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"не удалось скачать {url}")


def text_pipes(html):
    t = re.sub(r"<script.*?</script>|<style.*?</style>", "", html, flags=re.S)
    t = re.sub(r"<[^>]+>", "|", t)
    return unescape(re.sub(r"[\s|]*\|[\s|]*", " | ", t))


def after(t, label, n=1):
    """Значение после «label | » в плоском тексте страницы."""
    m = re.search(re.escape(label) + r" \| ([^|]*)", t)
    return m.group(1).strip() if m else None


def to_int(s):
    m = re.search(r"\d+", s or "")
    return int(m.group()) if m else None


def clean_none(s):
    return None if (s is None or s.strip().lower() in ("", "нет", "нет данных", "данных нет")) else s.strip()


# ---------------- OSM: что нам нужно ----------------

def osm_wanted():
    """{street_key: {house_key,...}} для адресных зданий в bbox."""
    want = {}
    for b in load_osm_buildings():
        st, hn = b["tags"].get("addr:street"), b["tags"].get("addr:housenumber")
        if st and hn:
            for k in split_housenumbers(hn):
                want.setdefault(street_key(st), set()).add(k)
    return want


# ---------------- domreestr ----------------
DR = "https://domreestr.ru"
DR_CITY = "/ryazanskaya-oblast/ryazan/"
DR_SKIP = {"novostroiki", "avariynie", "upravliayuschie-kompanii", "ulitsi"}


def dr_streets():
    f = CACHE / "domreestr_streets.json"
    if f.exists():
        return json.loads(f.read_text())
    slugs = set()
    idx = get("domreestr", DR + "/sitemap.xml")
    for sm in re.findall(r"<loc>([^<]*sitemap\d+\.xml)</loc>", idx):
        x = get("domreestr_sitemaps", sm)  # ~4.6 МБ на файл, 27 файлов, один раз
        for s in re.findall(r"/ryazanskaya-oblast/ryazan/([^/<]+)/<", x or ""):
            if s not in DR_SKIP and not re.fullmatch(r"[0-9a-z]{6}", s):
                slugs.add(s)
    f.write_text(json.dumps(sorted(slugs)))
    return sorted(slugs)


def _dr_rows(h):
    rows = []
    for m in re.finditer(r'<tr data-id="(\w+)">(.*?)</tr>', h, flags=re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", m.group(2), flags=re.S)
        if len(tds) < 6:
            continue
        addr = unescape(re.sub(r"<[^>]+>", "", tds[1])).strip()
        rows.append({"id": m.group(1), "url": f"{DR}{DR_CITY}{m.group(1)}/", "address": addr,
                     "year": to_int(tds[2]), "floors_max": to_int(tds[3]),
                     "entrances": to_int(tds[4]), "flats": to_int(tds[5])})
    return rows


def dr_street_rows(slug):
    """Страница улицы показывает по 10 домов; остальные — AJAX-пагинация сайта (POST на тот же URL:
    tmpl=module&mid=<data-id>&key=<data-key>&mp=<страница>), как делает их собственный JS."""
    url = f"{DR}{DR_CITY}{slug}/"
    h = get("domreestr", url)
    if not h:
        return []
    rows = _dr_rows(h)
    tot = re.search(r"Показано \d+ - \d+ из (\d+)", h)
    area = re.search(r'class="table-area[^"]*" data-id="(\d+)" data-key="(\w+)"(?: data-lim="(\d+)")?', h)
    if tot and area:
        lim = int(area.group(3) or 10)
        for mp in range(2, -(-int(tot.group(1)) // lim) + 1):
            data = {"tmpl": "module", "mid": area.group(1), "key": area.group(2), "mp": mp, "lim": lim}
            hp = get("domreestr", url, data=data)
            rows += _dr_rows(hp or "")
    return rows


def dr_house(row):
    h = get("domreestr", row["url"])
    if not h:
        return row
    t = text_pipes(h)
    m = re.search(r'data-lat="([\d.]+)" data-lon="([\d.]+)"', h)
    if m:
        row["lat"], row["lon"] = float(m.group(1)), float(m.group(2))
    row["floors_min"] = to_int(after(t, "Наименьшее количество этажей"))
    mx = to_int(after(t, "Наибольшее количество этажей"))
    if mx:
        row["floors_max"] = mx
    row["series"] = clean_none(after(t, "Серия, тип постройки"))
    row["year_built"] = to_int(after(t, "Год постройки"))
    return row


def run_domreestr(limit=None):
    want = osm_wanted()
    slugs = dr_streets()
    print(f"domreestr: {len(slugs)} улиц в sitemap; OSM-улиц в bbox {len(want)}", flush=True)
    rows = []
    with ThreadPoolExecutor(WORKERS) as ex:
        for i, rs in enumerate(ex.map(dr_street_rows, slugs)):
            rows += rs
            if i % 25 == 0:
                print(f"  улицы {i}/{len(slugs)}, домов {len(rows)}", flush=True)
    sel = []
    for r in rows:
        st, hn = parse_registry_address(r["address"])
        r["street"], r["house"] = st, hn
        sk, hk = (street_key(st) if st else None), (house_key(hn) if hn else None)
        r["street_key"], r["house_key"] = sk, hk
        if sk in want and hk in want[sk]:
            sel.append(r)
    print(f"domreestr: домов всего {len(rows)}, совпало с адресами OSM {len(sel)} -> скачиваем страницы домов", flush=True)
    if limit:
        sel = sel[:limit]
    with ThreadPoolExecutor(WORKERS) as ex:
        for i, _ in enumerate(ex.map(dr_house, sel)):
            if i % 100 == 0:
                print(f"  дома {i}/{len(sel)}", flush=True)
    out = [r for r in rows if "lat" in r or r in sel] if limit else sel
    (CACHE / "domreestr.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print("domreestr: записано", len(out))


# ---------------- mkdbase ----------------
MK = "https://mkdbase.ru"
MK_CITY = "/mkd/62-ryazanskaya/g-ryazan/"


def mk_streets():
    """[(url, name)] — улицы Рязани (списком ~13 страниц)."""
    out, seen = [], set()
    h = get("mkdbase", MK + MK_CITY)
    pages = sorted({int(p) for p in re.findall(r"\?page=(\d+)", h)}) or [1]
    for p in range(1, max(pages) + 1):
        h = get("mkdbase", MK + MK_CITY + (f"?page={p}" if p > 1 else ""))
        for href, title in re.findall(r'<a[^>]*href="(/mkd/62-ryazanskaya/g-ryazan/[^"?#]+/)"[^>]*>(.*?)</a>', h, flags=re.S):
            if href in seen:
                continue
            seen.add(href)
            out.append((MK + href, unescape(re.sub(r"<[^>]+>", "", title)).strip()))
    return out


def mk_house(url, address):
    h = get("mkdbase", url)
    if not h:
        return None
    t = text_pipes(h)
    r = {"url": url, "address": address,
         "year_built": to_int(after(t, "Год постройки")),
         "entrances": to_int(after(t, "Количество подъездов")),
         "lifts": to_int(after(t, "Количество лифтов")),
         "floors_max": to_int(after(t, "Наибольшее количество этажей")),
         "floors_min": to_int(after(t, "Наименьшее количество этажей")),
         "series": clean_none(after(t, "Серия, тип постройки здания")),
         "wall_material": clean_none(after(t, "Материал несущих стен")),
         "wall_type": clean_none(after(t, "Тип наружных стен")),
         "roof_shape": clean_none(after(t, "Форма крыши")),
         "roof_type": clean_none(after(t, "Тип кровли")),
         "floor_type": clean_none(after(t, "Тип перекрытий"))}
    for f in ("floors_max", "floors_min", "entrances", "year_built"):
        if not r[f]:
            r[f] = None  # 0 = «нет данных» (частный сектор, пустые карточки)
    return r


def run_mkdbase(limit=None):
    want = osm_wanted()
    # mkdbase перечисляет и частные дома без данных (4.7k страниц) — качаем только адреса, которые есть
    # в domreestr (реестр МКД, 1k дов с адресом OSM). Нет domreestr.json -> без этого фильтра.
    dr = CACHE / "domreestr.json"
    if dr.exists():
        keep = {(r["street_key"], r["house_key"]) for r in json.loads(dr.read_text())}
        want = {sk: {h for h in hs if (sk, h) in keep} for sk, hs in want.items()}
        want = {sk: hs for sk, hs in want.items() if hs}
    streets = mk_streets()
    sel_streets = [(u, n) for u, n in streets if street_key(n) in want]
    print(f"mkdbase: улиц {len(streets)}, из них в OSM bbox {len(sel_streets)}", flush=True)
    def street_houses(un):
        u, name = un
        h = get("mkdbase", u)
        sk = street_key(name)
        res = []
        for href, label in re.findall(r'<a[^>]*href="([^"/]+/)"[^>]*>(.*?)</a>', h or "", flags=re.S):
            label = unescape(re.sub(r"<[^>]+>", "", label)).strip()
            hk = house_key(label)
            if hk and hk in want[sk]:
                res.append((urljoin(u, href), label, sk, hk))
        return res

    todo = []
    with ThreadPoolExecutor(WORKERS) as ex:
        for i, rs in enumerate(ex.map(street_houses, sel_streets)):
            todo += rs
            if i % 25 == 0:
                print(f"  улицы {i}/{len(sel_streets)}, домов к загрузке {len(todo)}", flush=True)
    if limit:
        todo = todo[:limit]

    def one(t):
        rec = mk_house(t[0], t[1])
        if rec:
            rec["street_key"], rec["house_key"] = t[2], t[3]
        return rec

    out = []
    with ThreadPoolExecutor(WORKERS) as ex:
        for i, rec in enumerate(ex.map(one, todo)):
            if rec:
                out.append(rec)
            if i % 100 == 0:
                print(f"  дома {i}/{len(todo)}", flush=True)
    (CACHE / "mkdbase.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print("mkdbase: записано", len(out))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    if limit:
        args = [a for a in args if a != str(limit)]
    which = args[0] if args else "all"
    if which in ("domreestr", "all"):
        run_domreestr(limit)
    if which in ("mkdbase", "all"):
        run_mkdbase(limit)
