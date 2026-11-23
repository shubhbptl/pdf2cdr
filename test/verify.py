#!/usr/bin/env python3
"""Round-trip check: PDF --(our converter)--> CDR --(libcdr cdr2xhtml)--> SVG --> PNG,
compared with poppler's rendering of the original PDF.

Usage: verify.py original.pdf converted.cdr outdir
Prints one line per page with the share of differing pixels and writes side-by-side images.
"""
import base64
import io
import os
import re
import subprocess
import sys

from PIL import Image, ImageChops

pdf, cdr, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
DPI = 50

xhtml = subprocess.run(["cdr2xhtml", cdr], capture_output=True, text=True, check=True).stdout
svgs = re.findall(r"<svg:svg.*?</svg:svg>", xhtml, re.S)
subprocess.run(["pdftoppm", "-r", str(DPI), "-png", pdf, os.path.join(out, "ref")], check=True)
refs = sorted(f for f in os.listdir(out) if f.startswith("ref-") and f.endswith(".png"))

worst = 0.0
for i, svg in enumerate(svgs):
    svg = svg.replace("svg:", "")
    svg = re.sub(r'\s+xmlns(:\w+)?="[^"]*"', "", svg)
    svg = svg.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ', 1)
    # cdr2xhtml sizes pages in inches; render at the same DPI as poppler on a white page.
    def bmp_to_png(m):
        data = base64.b64decode(m.group(2))
        buf = io.BytesIO()
        w, h = int.from_bytes(data[18:22], "little", signed=True), int.from_bytes(data[22:26], "little", signed=True)
        if int.from_bytes(data[28:30], "little") == 32:
            # libcdr writes 32-bit BMPs whose 4th byte is alpha (PIL would ignore it).
            off = int.from_bytes(data[10:14], "little")
            img = Image.frombuffer("RGBA", (w, abs(h)), data[off:off + w * abs(h) * 4], "raw", "BGRA", 0, -1 if h > 0 else 1)
            if img.getchannel("A").getextrema()[1] == 0:  # no mask: libcdr leaves alpha 0 = opaque
                img = img.convert("RGB")
        else:
            img = Image.open(io.BytesIO(data))
        img.save(buf, "PNG")
        return m.group(1) + "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    svg = re.sub(r'((?:xlink:)?href=")data:image/bmp;base64,([A-Za-z0-9+/=]+)', bmp_to_png, svg)
    path = os.path.join(out, f"cdr-{i + 1}.svg")
    open(path, "w").write(svg)
    png = os.path.join(out, f"cdr-{i + 1}.png")
    subprocess.run(["rsvg-convert", "-b", "white", "-d", str(DPI), "-p", str(DPI), path, "-o", png], check=True)
    if i >= len(refs):
        print(f"page {i + 1}: no reference page")
        continue
    a = Image.open(os.path.join(out, refs[i])).convert("RGB")
    b = Image.open(png).convert("RGB")
    if b.size != a.size:
        b = b.resize(a.size)
    diff = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 48 else 0)
    share = sum(diff.histogram()[255:]) / (a.size[0] * a.size[1])
    worst = max(worst, share)
    side = Image.new("RGB", (a.size[0] * 2 + 10, a.size[1]), "white")
    side.paste(a, (0, 0))
    side.paste(b, (a.size[0] + 10, 0))
    side.save(os.path.join(out, f"compare-{i + 1}.png"))
    print(f"page {i + 1}: {share * 100:.2f}% pixels differ")
print(f"pages in CDR: {len(svgs)}, pages in PDF: {len(refs)}, worst: {worst * 100:.2f}%")
