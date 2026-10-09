#!/usr/bin/env python3
"""Miliadex build for Cloudflare Workers.

Copies the site from the repository root into dist/ and prepares the Outfits Showcase:
  dist/showcase/index.json   list of outfits (read from the data each Miliadex image carries)
  dist/showcase/_t/*.webp    square thumbnails for the gallery cards (~30-50 KB)
  dist/showcase/_v/*.webp    lighter full images for the detail page (~150-250 KB)
The original PNGs are published untouched: they are what Download / Edit / Add to My Outfits read.
Runs without Pillow too (no thumbnails then: the site falls back to the original images).
"""
import base64, hashlib, json, os, shutil, struct, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DIST = os.path.join(ROOT, "dist")
SHOW = "showcase"
SKIP = {".git", ".github", ".gitignore", ".gitattributes", "dist", "tools", "node_modules", ".wrangler",
        "wrangler.jsonc", "wrangler.json", "wrangler.toml", "package.json", "package-lock.json",
        "CNAME", "README.md", "readme.md", ".DS_Store", "Thumbs.db"}
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


def outfit_of(data):
    """The outfit a Miliadex image carries ("mlDx" chunk): look code, name, wear, screenshot or not."""
    for ty, d in png_chunks(data):
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


if __name__ == "__main__":
    copy_site()
    n = showcase()
    total = sum(len(fs) for _, _, fs in os.walk(DIST))
    print(f"build: dist/ ready, {total} files, {n} showcase images")
