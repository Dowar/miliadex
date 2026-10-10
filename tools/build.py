#!/usr/bin/env python3
"""Miliadex build for Cloudflare Workers.

Copies the site from the repository root into dist/ and prepares the Outfits Showcase:
  dist/showcase/index.json   list of outfits (read from the data each Miliadex image carries)
  dist/showcase/_t/*.webp    square thumbnails for the gallery cards (~30-50 KB)
  dist/showcase/_v/*.webp    lighter full images for the detail page (~150-250 KB)
The original images (JPEG, or PNG for the older ones) are published untouched: they are what Download / Edit / Add to My Outfits read.
Runs without Pillow too (no thumbnails then: the site falls back to the original images).

It also writes worker/embed-data.json: the catalog read from index.html, which the Worker (worker/index.js)
uses to describe share links in Discord previews. It is rebuilt at every deploy, so it always matches the site.
"""
import base64, hashlib, json, os, re, shutil, struct, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DIST = os.path.join(ROOT, "dist")
SHOW = "showcase"
SKIP = {".git", ".github", ".gitignore", ".gitattributes", "dist", "tools", "node_modules", ".wrangler",
        "wrangler.jsonc", "wrangler.json", "wrangler.toml", "package.json", "package-lock.json",
        "CNAME", "README.md", "readme.md", ".DS_Store", "Thumbs.db", "worker"}
IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif")
THUMB, VIEW_W = 480, 1080

try:
    from PIL import Image
except Exception:  # thumbnails are a bonus: the site still works with the original files
    Image = None
    print("build: Pillow not available, showcase thumbnails skipped", file=sys.stderr)


def copy_site():
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST)
    for name in os.listdir(ROOT):
        if name in SKIP or name.startswith("."):
            continue
        src, dst = os.path.join(ROOT, name), os.path.join(DIST, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".*", "Thumbs.db"))
        else:
            shutil.copy2(src, dst)


def png_chunks(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return
    p = 8
    while p + 12 <= len(data):
        n = struct.unpack(">I", data[p:p + 4])[0]
        if p + 12 + n > len(data):
            return
        yield data[p + 4:p + 8].decode("latin-1"), data[p + 8:p + 8 + n]
        p += 12 + n


def jpeg_data(data):
    """The outfit data of a Miliadex JPEG: APP15 segments "MLDX" · part (u16) · parts (u16) · bytes."""
    if data[:2] != b"\xff\xd8":
        return None
    p, got, n = 2, {}, 0
    while p + 4 <= len(data) and data[p] == 0xFF:
        m = data[p + 1]
        if m == 0xFF:
            p += 1
            continue
        if m == 0x01 or 0xD0 <= m <= 0xD8:
            p += 2
            continue
        if m in (0xDA, 0xD9):
            break
        size = struct.unpack(">H", data[p + 2:p + 4])[0]
        d = data[p + 4:p + 2 + size]
        if m == 0xEF and len(d) > 8 and d[:4] == b"MLDX":
            i, n = struct.unpack(">HH", d[4:8])
            got[i] = d[8:]
        p += 2 + size
    if not n or any(i not in got for i in range(n)):
        return None
    return b"".join(got[i] for i in range(n))


def outfit_of(data):
    """The outfit a Miliadex image carries (JPEG APP15 segments, or the "mlDx" chunk of older PNGs): look code, name, wear, screenshot or not."""
    j = jpeg_data(data)
    for ty, d in ([("mlDx", j)] if j else png_chunks(data)):
        if ty != "mlDx" or len(d) < 9 or d[:4] != b"MLDX" or d[4] != 1:
            continue
        n = struct.unpack(">I", d[5:9])[0]
        meta = json.loads(d[9:9 + n].decode("utf-8"))
        code = meta.get("look")
        if not code:
            return None
        look = json.loads(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4)).decode("utf-8"))
        return {"look": code, "name": str(look.get("n") or "")[:60], "g": "m" if look.get("g") == "m" else "f",
                "pic": any(b.get("k") == "cut" for b in meta.get("b") or [])}
    return None


def webp(im, path, q):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, "WEBP", quality=q, method=6)


def showcase():
    src = os.path.join(ROOT, SHOW)
    items = []
    for name in (sorted(os.listdir(src)) if os.path.isdir(src) else []):
        if name.startswith(".") or not name.lower().endswith(IMG_EXT):
            continue
        data = open(os.path.join(src, name), "rb").read()
        it = {"file": name, "v": hashlib.sha1(data).hexdigest()[:10], "size": len(data)}
        try:
            o = outfit_of(data)
        except Exception as e:
            o = None
            print(f"build: {name}: outfit data unreadable ({e})", file=sys.stderr)
        if o:
            it.update(o)
        if Image:
            try:
                im = Image.open(os.path.join(src, name))
                im.load()
                im = im.convert("RGBA") if im.mode in ("P", "LA") else im
                if im.mode == "RGBA":
                    bg = Image.new("RGB", im.size, (20, 13, 51)); bg.paste(im, mask=im.split()[3]); im = bg
                else:
                    im = im.convert("RGB")
                w, h = im.size
                it["w"], it["h"] = w, h
                base = os.path.splitext(name)[0]
                # card: a square that keeps the bottom of a Miliadex image (its own title band stays out), centred otherwise
                s = min(w, h)
                box = ((w - s) // 2, h - s, (w - s) // 2 + s, h) if o else ((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s)
                webp(im.crop(box).resize((THUMB, THUMB), Image.LANCZOS), os.path.join(DIST, SHOW, "_t", base + ".webp"), 80)
                k = min(1, VIEW_W / w)
                vw = im.resize((round(w * k), round(h * k)), Image.LANCZOS) if k < 1 else im
                webp(vw, os.path.join(DIST, SHOW, "_v", base + ".webp"), 86)
                it["thumb"], it["view"] = f"_t/{base}.webp", f"_v/{base}.webp"
            except Exception as e:
                print(f"build: {name}: no thumbnail ({e})", file=sys.stderr)
        items.append(it)
    out = {"v": 1, "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "items": items}
    os.makedirs(os.path.join(DIST, SHOW), exist_ok=True)
    with open(os.path.join(DIST, SHOW, "index.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    return len(items)


ALL_SLOTS = ["Hairstyle", "Headwear", "Top", "Bottom", "Footwear", "Earrings", "Eye Accessory", "Face Accessory", "Neck Accessory",
             "Back Accessory", "Wrist Accessory", "Leg Accessory", "Pendant 1", "Pendant 2", "Tail Accessory",
             "Skin Tone", "Eye Shape", "Iris", "Eyebrows", "Eye Makeup", "Facial Makeup", "Lipstick"]


def js_value(src, name):
    """The JSON literal assigned to `const NAME =` in the page (SETS, COMP, ODEB, SHX, VER)."""
    m = re.search(r"\bconst\s+" + name + r"\s*=\s*", src)
    if not m:
        raise ValueError(name + " not found")
    return json.JSONDecoder().raw_decode(src, m.end())[0]


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def first_slot(cat, mc):
    """First outfit slot of a cosmetic (slotsOf in index.html), "" when it can't be worn in an outfit."""
    if cat == "Multi":
        if mc == "All":
            return "Headwear"
        for x in (mc or "").split(";"):
            x = x.strip()
            x = "Pendant 1" if x.startswith("Pendant") else x
            if x in ALL_SLOTS:
                return x
        return "Top"
    if cat == "Pendant":
        return "Pendant 1"
    return cat if cat in ALL_SLOTS else ""


def embed_data():
    """Catalog for the share-link Worker, in the same shape the site builds from its data (SET_ITEMS / COMP_ITEMS)."""
    out = os.path.join(ROOT, "worker", "embed-data.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    try:
        src = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
        SETS, COMP, ODEB, SHX = (js_value(src, k) for k in ("SETS", "COMP", "ODEB", "SHX"))
        vorder = list(js_value(src, "VER").keys())
        vi = lambda v: vorder.index(v) if v in vorder else -1
        free = {}
        for five, fours in ODEB:
            F = next((i for i, r in enumerate(SETS) if r[0] == five), None)
            if F is None:
                continue
            for n in fours:
                k = next((i for i, r in enumerate(SETS) if r[0] == n), None)
                if k is not None:
                    free.setdefault(k, []).append(F)
        sets = []
        for i, r in enumerate(SETS):
            r = list(r) + [None] * (17 - len(r))
            en, fr, rar, v, f, m, pr, vv = r[0], r[1], r[2], r[3], r[7], r[8], r[15], r[16] or [0, 0]
            pr = pr or [0, "", 0, ""]
            sets.append([en, fr or en, rar, vi(v), f or "", m or "", pr[0] or 0, pr[1] or "", pr[2] or 0, pr[3] or "",
                         vv[0] or 0, vv[1] or 0, SHX[0][i] if isinstance(SHX, list) else None, free.get(i, [])])
        comp, used = [], set()
        for j, r in enumerate(COMP):
            r = list(r) + [None] * (16 - len(r))
            en, fr, q, g, ty, cat, s_, raw, v, p, si, key, mc, np_, pr, vv = r
            cid = "c-" + slug(key or en)
            while cid in used:
                cid += "-x"
            used.add(cid)
            if cat == "Top;Bottom":
                cat, mc = "Multi", mc or "Top;Bottom"
            comp.append([cid[2:], en, fr or en, q, g, si if isinstance(si, int) and si >= 0 else -1, vv or 0,
                         (pr[0] or 0) if pr else 0, (pr[1] or "") if pr else "", p or "",
                         SHX[1][j] if isinstance(SHX, list) else None, first_slot(cat, mc), vi(v)])
        cid = re.search(r'const CID="([^"/][^"]*)"', src)   # the site's Google sign-in client: the admin check accepts only its tokens
        data = {"v": vorder, "s": sets, "c": comp, "g": cid.group(1) if cid else ""}
        print(f"build: share previews ready ({len(sets)} sets, {len(comp)} cosmetics)")
    except Exception as e:  # previews fall back to plain links; the site itself is unaffected
        data = {"v": [], "s": [], "c": []}
        print(f"build: share previews without catalog ({e})", file=sys.stderr)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    copy_site()
    embed_data()
    n = showcase()
    total = sum(len(fs) for _, _, fs in os.walk(DIST))
    print(f"build: dist/ ready, {total} files, {n} showcase images")
