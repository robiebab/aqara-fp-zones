#!/usr/bin/env python3
"""
Makes the app images (App Store) and the driver images ("Add device") from the SVG icons, in the
app's fresh teal look. Run after changing an icon:  pip install cairosvg pillow && python3 tools/brand-images.py

  app images     teal gradient with soft radar rings, the app icon in white and the app name
  driver images  a light mint background with the driver's icon in dark teal lines
Sizes follow the Homey guidelines: app 250x175 / 500x350 / 1000x700, drivers 75x75 / 500x500 / 1000x1000.
"""
import io, os
import cairosvg
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
BRAND = (13, 148, 136)        # #0D9488, also brandColor in .homeycompose/app.json
BRAND_DARK = (15, 92, 86)     # bottom of the gradient
MINT = (236, 253, 249)        # driver image background
INK = (19, 78, 74)            # driver icon lines
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'


def svg_png(path, size, colour):
    svg = open(path).read()
    for old in ('#231f20', '#000000', '#000', '#54565a'):
        svg = svg.replace(old, '#%02x%02x%02x' % colour)
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size))).convert('RGBA')


def app_image(w, h):
    img = Image.new('RGB', (w, h))
    px = img.load()
    for y in range(h):                                   # soft diagonal gradient
        for x in range(w):
            t = (x / w * 0.35 + y / h * 0.65)
            px[x, y] = tuple(int(BRAND[i] + (BRAND_DARK[i] - BRAND[i]) * t) for i in range(3))
    rings = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(rings)
    cx, cy = int(w * 0.80), int(h * 1.05)
    for i, r in enumerate((0.35, 0.58, 0.81, 1.04)):     # radar rings, very light
        rr = int(h * r)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(255, 255, 255, 34 - i * 6), width=max(2, h // 120))
    img = Image.alpha_composite(img.convert('RGBA'), rings)
    icon = svg_png(os.path.join(ROOT, 'assets/icon.svg'), int(h * 0.56), (255, 255, 255))
    img.alpha_composite(icon, (int(w * 0.07), (h - icon.height) // 2))
    d = ImageDraw.Draw(img)
    x, room = int(w * 0.45), int(w * 0.50)                # text column, never wider than this

    def fit(text, size):
        font = ImageFont.truetype(FONT, size)
        while d.textlength(text, font=font) > room:
            size -= 1
            font = ImageFont.truetype(FONT, size)
        return font
    big, line1, line2 = fit('FP Zones', int(h * 0.15)), fit('Aqara FP300 & FP400', int(h * 0.06)), fit('zones · presence · distance', int(h * 0.06))
    d.text((x, int(h * 0.30)), 'FP Zones', font=big, fill=(255, 255, 255))
    d.text((x, int(h * 0.53)), 'Aqara FP300 & FP400', font=line1, fill=(255, 255, 255))
    d.text((x, int(h * 0.63)), 'zones · presence · distance', font=line2, fill=(204, 251, 241))
    return img.convert('RGB')


def driver_image(icon_path, size):
    img = Image.new('RGB', (size, size), MINT)
    d = ImageDraw.Draw(img)
    r = int(size * 0.40)                                  # soft disc behind the device
    d.ellipse([size // 2 - r, size // 2 - r, size // 2 + r, size // 2 + r], fill=(204, 251, 241))
    icon = svg_png(icon_path, int(size * 0.62), INK)
    img.paste(icon, ((size - icon.width) // 2, (size - icon.height) // 2), icon)
    return img


for name, (w, h) in {'small': (250, 175), 'large': (500, 350), 'xlarge': (1000, 700)}.items():
    app_image(w * 2, h * 2).resize((w, h), Image.LANCZOS).save(os.path.join(ROOT, f'assets/images/{name}.png'))
for drv in ('fp300', 'fp400', 'fp400_zone'):
    for name, size in {'small': 75, 'large': 500, 'xlarge': 1000}.items():
        driver_image(os.path.join(ROOT, f'drivers/{drv}/assets/icon.svg'), size * 2).resize((size, size), Image.LANCZOS) \
            .save(os.path.join(ROOT, f'drivers/{drv}/assets/images/{name}.png'))
print('App and driver images written')
