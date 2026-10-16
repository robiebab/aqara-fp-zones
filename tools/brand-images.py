#!/usr/bin/env python3
"""
Makes the app images (App Store) and the driver images ("Add device") from the SVG icons, in the
app's minimal look. Run after changing an icon:  pip install cairosvg pillow && python3 tools/brand-images.py

  app images     a flat graphite surface (the brand colour), the app icon in white, the name and one line
  driver images  the driver's own line icon in its own colour on white, no colour added
Sizes follow the Homey guidelines: app 250x175 / 500x350 / 1000x700, drivers 75x75 / 500x500 / 1000x1000.
"""
import io, os
import cairosvg
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
BRAND = (31, 35, 40)          # #1F2328, also brandColor in .homeycompose/app.json
SUBTLE = (170, 177, 186)      # second line of text
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'


def svg_png(path, size, colour=None):
    svg = open(path).read()
    if colour:
        for old in ('#231f20', '#000000', '#000'):
            svg = svg.replace(old, '#%02x%02x%02x' % colour)
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size))).convert('RGBA')


def app_image(w, h):
    img = Image.new('RGBA', (w, h), BRAND + (255,))
    icon = svg_png(os.path.join(ROOT, 'assets/icon.svg'), int(h * 0.46), (255, 255, 255))
    img.alpha_composite(icon, (int(w * 0.10), (h - icon.height) // 2))
    d = ImageDraw.Draw(img)
    x, room = int(w * 0.50), int(w * 0.45)

    def fit(text, size):
        font = ImageFont.truetype(FONT, size)
        while d.textlength(text, font=font) > room:
            size -= 1
            font = ImageFont.truetype(FONT, size)
        return font
    d.text((x, int(h * 0.37)), 'FP Zones', font=fit('FP Zones', int(h * 0.13)), fill=(255, 255, 255))
    d.text((x + int(h * 0.005), int(h * 0.56)), 'Aqara FP300 · FP400', font=fit('Aqara FP300 · FP400', int(h * 0.055)), fill=SUBTLE)
    return img.convert('RGB')


def driver_image(icon_path, size):
    img = Image.new('RGB', (size, size), (255, 255, 255))
    icon = svg_png(icon_path, int(size * 0.80))
    img.paste(icon, ((size - icon.width) // 2, (size - icon.height) // 2), icon)
    return img


for name, (w, h) in {'small': (250, 175), 'large': (500, 350), 'xlarge': (1000, 700)}.items():
    app_image(w * 2, h * 2).resize((w, h), Image.LANCZOS).save(os.path.join(ROOT, f'assets/images/{name}.png'))
for drv in ('fp300', 'fp400', 'fp400_zone'):
    for name, size in {'small': 75, 'large': 500, 'xlarge': 1000}.items():
        driver_image(os.path.join(ROOT, f'drivers/{drv}/assets/icon.svg'), size * 2).resize((size, size), Image.LANCZOS) \
            .save(os.path.join(ROOT, f'drivers/{drv}/assets/images/{name}.png'))
print('App and driver images written')
