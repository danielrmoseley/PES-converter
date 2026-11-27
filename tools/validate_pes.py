#!/usr/bin/env python3
"""Independent check of a generated .pes file using pyembroidery.

    pip install pyembroidery pillow
    python3 tools/validate_pes.py design.pes [render.png] [scale_px_per_mm]

Parses the file with pyembroidery (a separate implementation of the format),
prints structure/statistics, sanity-checks stitch lengths, and optionally
renders the stitches it read to a PNG for visual inspection.
"""
import math
import sys

import pyembroidery as pe


def main():
    path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    scale = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0

    raw = open(path, "rb").read()
    assert raw[:8] == b"#PES0001", "bad signature"
    pec = int.from_bytes(raw[8:12], "little")
    assert raw[pec:pec + 3] == b"LA:", "PEC offset does not point at the PEC header"

    p = pe.read(path)
    assert p is not None, "pyembroidery could not read the file"
    counts = {}
    for s in p.stitches:
        name = pe.get_common_name_dictionary().get(s[2] & pe.COMMAND_MASK, str(s[2]))
        counts[name] = counts.get(name, 0) + 1
    print("threads:", [(t.description, t.hex_color()) for t in p.threadlist])
    print("commands:", counts)
    x0, y0, x1, y1 = p.bounds()
    print("size: %.1f x %.1f mm" % ((x1 - x0) / 10, (y1 - y0) / 10))

    longest, tiny, prev = 0, 0, None
    for s in p.stitches:
        cmd = s[2] & pe.COMMAND_MASK
        if cmd == pe.STITCH and prev is not None:
            d = math.hypot(s[0] - prev[0], s[1] - prev[1]) / 10
            longest = max(longest, d)
            if 0 < d < 0.3:
                tiny += 1
        if cmd in (pe.STITCH, pe.JUMP):
            prev = s
    print("longest stitch: %.2f mm, stitches < 0.3mm: %d" % (longest, tiny))
    assert longest <= 12.7, "stitch longer than machine maximum"

    if out:
        from PIL import Image, ImageDraw

        W = int((x1 - x0) / 10 * scale) + 20
        H = int((y1 - y0) / 10 * scale) + 20
        img = Image.new("RGB", (W, H), (250, 250, 245))
        d = ImageDraw.Draw(img)
        ci = 0
        color = p.threadlist[0].color if p.threadlist else 0
        prev = None
        lw = max(1, int(scale * 0.12))
        for s in p.stitches:
            cmd = s[2] & pe.COMMAND_MASK
            X = (s[0] - x0) / 10 * scale + 10
            Y = (s[1] - y0) / 10 * scale + 10
            if cmd == pe.COLOR_CHANGE:
                ci += 1
                color = p.threadlist[min(ci, len(p.threadlist) - 1)].color
                prev = None
                continue
            if cmd == pe.STITCH:
                if prev is not None:
                    rgb = ((color >> 16) & 255, (color >> 8) & 255, color & 255)
                    d.line([prev, (X, Y)], fill=rgb, width=lw)
                prev = (X, Y)
            elif cmd == pe.JUMP:
                if prev is not None:
                    d.line([prev, (X, Y)], fill=(255, 0, 255), width=1)
                prev = (X, Y)
            elif cmd == pe.TRIM:
                prev = None
        img.save(out)
        print("rendered", out)


if __name__ == "__main__":
    main()
