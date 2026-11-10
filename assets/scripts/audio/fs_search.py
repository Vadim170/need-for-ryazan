"""Freesound HTML search (no API token). Usage: python fs_search.py "query words" [pages] [sort]
Prints: id | user | dur | license | downloads | title | desc(120)."""
import html, re, sys, urllib.parse, urllib.request

UA = {"User-Agent": "Mozilla/5.0"}

def search(q, pages=1, sort="Downloads desc"):
    out = []
    for p in range(1, pages + 1):
        url = "https://freesound.org/search/?" + urllib.parse.urlencode({"q": q, "s": sort, "page": p})
        h = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf8", "replace")
        blocks = h.split('data-similar-sounds-modal-url="')[1:]
        for b in blocks:
            m = re.match(r"/people/([^/]+)/sounds/(\d+)/", b)
            if not m: continue
            dur = re.search(r'data-duration="([\d.]+)"', b)
            title = re.search(r'data-title="([^"]*)"', b)
            dl = re.search(r'data-num-downloads="(\d+)"', b)
            lic = re.search(r'title="License: ([^"]*)"', b)
            desc = re.search(r'overflow-hidden v-spacing-1" title="([^"]*)"', b, re.S)
            out.append((m.group(2), m.group(1), float(dur.group(1)) if dur else 0, lic.group(1) if lic else "?",
                        int(dl.group(1)) if dl else 0, html.unescape(title.group(1)) if title else "",
                        re.sub(r"\s+", " ", html.unescape(desc.group(1)))[:160] if desc else ""))
    return out

if __name__ == "__main__":
    q = sys.argv[1]; pages = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    sort = sys.argv[3] if len(sys.argv) > 3 else "Downloads desc"
    for r in search(q, pages, sort):
        if "Noncommercial" in r[3] or "Sampling" in r[3]: continue
        print(f"{r[0]:>7} | {r[1][:16]:16} | {r[2]:6.1f}s | {r[3][:22]:22} | {r[4]:6} | {r[5][:50]} | {r[6]}")
