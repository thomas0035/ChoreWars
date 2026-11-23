"""Draws the ChoreWars app icon candidates and writes the chosen one into public/.

  python design/make_icons.py preview          -> design/icon-options.png (all candidates side by side)
  python design/make_icons.py apply house      -> overwrites the PNG icons in public/ (house | knob | butter)

Needs Pillow. Everything is drawn at 4x and scaled down for clean edges.
"""
import sys, os
from PIL import Image, ImageDraw

BLACK = (22, 22, 20)        # warm black, a touch lighter than the app background so the edge shows
BUTTER = (235, 217, 138)
ON_BUTTER = (27, 23, 7)
TRACK = (46, 46, 42)
TRAIL = (104, 98, 72)
SS = 4                      # supersampling factor
U = 512                     # design units


def _house(d, s, fg, bg):
    """House silhouette with an arched door and a round window. Sits inside the maskable safe zone."""
    pts = [(256, 112), (372, 218), (372, 400), (140, 400), (140, 218)]
    P = [(x * s, y * s) for x, y in pts]
    d.polygon(P, fill=fg)
    d.line(P + [P[0]], fill=fg, width=int(12 * s), joint='curve')
    r = 6 * s
    for x, y in P:
        d.ellipse([x - r, y - r, x + r, y + r], fill=fg)
    d.rectangle([218 * s, 340 * s, 294 * s, 410 * s], fill=bg)
    d.ellipse([218 * s, 302 * s, 294 * s, 378 * s], fill=bg)
    d.ellipse([238 * s, 168 * s, 274 * s, 204 * s], fill=bg)


def _knob(d, s):
    """The slide-to-clean control: a track, a butter trail and the knob at the finished end."""
    d.rounded_rectangle([72 * s, 188 * s, 440 * s, 324 * s], radius=68 * s, fill=TRAIL)
    d.rounded_rectangle([72 * s, 188 * s, 440 * s, 324 * s], radius=68 * s, outline=TRACK, width=int(1 * s))
    cx, cy, r = 372, 256, 68
    d.ellipse([(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s], fill=BUTTER)
    chev = [((cx - 12) * s, (cy - 26) * s), ((cx + 14) * s, cy * s), ((cx - 12) * s, (cy + 26) * s)]
    d.line(chev, fill=ON_BUTTER, width=int(15 * s), joint='curve')
    cr = 7.5 * s
    for x, y in (chev[0], chev[2]):
        d.ellipse([x - cr, y - cr, x + cr, y + cr], fill=ON_BUTTER)


def draw(kind, size, rounded):
    """kind: house | knob | butter. rounded=True gives transparent rounded corners; False is full-bleed."""
    n = size * SS
    s = n / U
    bg = BUTTER if kind == 'butter' else BLACK
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=112 * s, fill=bg)
    else:
        d.rectangle([0, 0, n, n], fill=bg)
    if kind == 'house':
        _house(d, s, BUTTER, bg)
    elif kind == 'butter':
        _house(d, s, ON_BUTTER, bg)
    else:
        _knob(d, s)
    return img.resize((size, size), Image.LANCZOS)


def svg(kind):
    bg = '#ebd98a' if kind == 'butter' else '#161614'
    fg = '#1b1707' if kind == 'butter' else '#ebd98a'
    if kind == 'knob':
        body = ('  <rect x="72" y="188" width="368" height="136" rx="68" fill="#68624a"/>\n'
                '  <circle cx="372" cy="256" r="68" fill="#ebd98a"/>\n'
                '  <path d="M360 230 L386 256 L360 282" fill="none" stroke="#1b1707" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>\n')
    else:
        body = ('  <path d="M256 112 L372 218 L372 400 L294 400 L294 340 A38 38 0 0 0 218 340 L218 400 L140 400 L140 218 Z"\n'
                '        fill="%s" stroke="%s" stroke-width="12" stroke-linejoin="round"/>\n'
                '  <circle cx="256" cy="186" r="18" fill="%s"/>\n' % (fg, fg, bg))
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n'
            '  <rect width="512" height="512" rx="112" fill="%s"/>\n%s</svg>\n' % (bg, body))


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'preview'
    if cmd == 'preview':
        kinds = ['house', 'knob', 'butter']
        sheet = Image.new('RGB', (3 * 300 + 60, 2 * 300 + 60), (42, 42, 40))
        for i, k in enumerate(kinds):
            sheet.paste(draw(k, 240, True), (60 + i * 300, 60), draw(k, 240, True))
            # how a launcher that masks to a circle would show it
            full = draw(k, 240, False)
            mask = Image.new('L', (240 * SS, 240 * SS), 0)
            ImageDraw.Draw(mask).ellipse([0, 0, 240 * SS - 1, 240 * SS - 1], fill=255)
            sheet.paste(full, (60 + i * 300, 360), mask.resize((240, 240), Image.LANCZOS))
        out = os.path.join(root, 'design', 'icon-options.png')
        sheet.save(out)
        print('wrote', out)
    elif cmd == 'apply':
        kind = sys.argv[2]
        pub = os.path.join(root, 'public')
        draw(kind, 512, True).save(os.path.join(pub, 'pwa-512x512.png'))
        draw(kind, 192, True).save(os.path.join(pub, 'pwa-192x192.png'))
        draw(kind, 512, False).convert('RGB').save(os.path.join(pub, 'maskable-icon-512x512.png'))
        draw(kind, 192, False).convert('RGB').save(os.path.join(pub, 'maskable-icon-192x192.png'))
        draw(kind, 180, False).convert('RGB').save(os.path.join(pub, 'apple-touch-icon.png'))
        with open(os.path.join(pub, 'icon.svg'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(svg(kind))
        print('applied', kind)


if __name__ == '__main__':
    main()
