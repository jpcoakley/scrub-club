"""Builds og-image.png, the 1200x630 card shown when the site's link is shared (iMessage, Slack, etc.).

The soap logo sits centered on the site's burgundy (#7A2842) with a lighter radial glow behind it
that fades out toward the edges and a shade darker into the corners.

    python3 scripts/og-image.py "<path to Scrub Club Soap.png>"

The source logo lives in My Drive/Hockey/Scrub Club/Logo/Soap/. Pillow only, no numpy.
"""
import math, random, sys
from PIL import Image

W, H = 1200, 630
LOGO_W = 572
# (distance from center, where 1.0 is the edge of the ellipse; color)
STOPS = [(0.00, (0xB0, 0x56, 0x72)), (0.55, (0x96, 0x3F, 0x5A)), (0.95, (0x7A, 0x28, 0x42)), (1.25, (0x5A, 0x1C, 0x31))]

def color(r):
    if r <= STOPS[0][0]:
        return STOPS[0][1]
    for (a, ca), (b, cb) in zip(STOPS, STOPS[1:]):
        if r <= b:
            t = (r - a) / (b - a)
            t = t * t * (3 - 2 * t)  # smoothstep, so the stops don't show as rings
            return tuple(ca[i] + (cb[i] - ca[i]) * t for i in range(3))
    return STOPS[-1][1]

def main(src, out="og-image.png"):
    rng = random.Random(7)
    bg = Image.new("RGB", (W, H))
    px = bg.load()
    for y in range(H):
        for x in range(W):
            # An ellipse the card's shape, so the glow reaches the sides and the top and bottom evenly
            r = math.hypot((x - W / 2) / (W * 0.62), (y - H / 2) / (H * 0.62))
            c = color(r)
            # half a level of noise keeps the soft gradient from banding
            px[x, y] = tuple(max(0, min(255, int(v + rng.uniform(-0.5, 0.5) + 0.5))) for v in c)
    logo = Image.open(src).convert("RGBA")
    logo = logo.crop(logo.getchannel("A").getbbox())
    h = round(logo.height * LOGO_W / logo.width)
    logo = logo.resize((LOGO_W, h), Image.LANCZOS)
    bg.paste(logo, ((W - LOGO_W) // 2, (H - h) // 2), logo)
    bg.save(out, optimize=True)

if __name__ == "__main__":
    main(*sys.argv[1:])
