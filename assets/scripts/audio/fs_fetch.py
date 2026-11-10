"""Download Freesound HQ previews (no login) + verify license from the sound page.
Usage: python fs_fetch.py sources.txt   (lines: "<category> <user> <id>", '#' comments)
Output: assets/audio/sources/<category>/<id>/ {preview.ogg|preview.mp3, meta.json}. CC BY-NC / Sampling+ are rejected."""
import html, json, pathlib, re, sys, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2] / "audio" / "sources"
UA = {"User-Agent": "Mozilla/5.0"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()

def fetch(cat, user, sid):
    d = ROOT / cat / sid
    if (d / "meta.json").exists():
        return json.loads((d / "meta.json").read_text())
    r = urllib.request.urlopen(urllib.request.Request(f"https://freesound.org/s/{sid}/", headers=UA), timeout=60)
    page_url = r.geturl()
    h = r.read().decode("utf8", "replace")
    user = urllib.parse.unquote(page_url.split("/people/")[1].split("/")[0])
    lic = re.findall(r'creativecommons\.org/(publicdomain/zero/1\.0|licenses/[a-z-]+/[\d.]+)/?', h)
    lic = lic[0] if lic else "?"
    if "nc" in lic.split("/")[1:2][0] if lic.startswith("licenses") else False:
        print("REJECT (NC)", sid, lic); return None
    if not (lic.startswith("publicdomain/zero") or re.match(r"licenses/by/", lic)):
        print("REJECT license", sid, lic); return None
    title = html.unescape(re.search(r"<title>Freesound - (.*?) by ", h, re.S).group(1)).strip()
    prev = sorted(set(re.findall(r"https://cdn\.freesound\.org/previews/[^\"']+-hq\.mp3", h)))[0]
    d.mkdir(parents=True, exist_ok=True)
    data, fn = None, None
    try:
        data = get(prev.replace("-hq.mp3", "-hq.ogg")); fn = "preview.ogg"
    except Exception:
        data = get(prev); fn = "preview.mp3"
    (d / fn).write_bytes(data)
    meta = {"id": int(sid), "title": title, "author": user, "url": page_url,
            "license": "CC0 1.0" if lic.startswith("publicdomain") else "CC BY " + lic.split("/")[-1],
            "license_url": "https://creativecommons.org/" + lic + "/", "file": fn, "preview_url": prev, "category": cat}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(f"ok {cat:10} {sid:>7} {meta['license']:9} {len(data)//1024:5}KB {fn} {title[:60]}")
    return meta

if __name__ == "__main__":
    for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
        line = line.split("#")[0].strip()
        if not line: continue
        cat, user, sid = line.split()
        try: fetch(cat, user, sid)
        except Exception as e: print("FAIL", cat, user, sid, e)
