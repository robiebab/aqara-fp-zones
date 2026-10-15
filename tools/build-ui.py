#!/usr/bin/env python3
"""
Builds the two web pages of the app from the sources in ui-src/:
  settings/index.html              app settings page (zones, ignore spots, outside room)
  drivers/fp400_zone/pair/wizard.html   pairing wizard for a zone device
Run from the project root:  python3 tools/build-ui.py
Never edit the two generated files by hand; edit ui-src/ and build again.
"""
import os, re, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, 'ui-src')
read = lambda n: open(os.path.join(src, n), encoding='utf-8').read()
css, js, wiz, st = read('theme.css'), read('map.js'), read('wizard.body.html'), read('settings.body.html')

with open(os.path.join(root, 'drivers/fp400_zone/pair/wizard.html'), 'w', encoding='utf-8') as f:
    f.write("<style>\n" + css + "</style>\n<script>\n" + js + "</script>\n" + wiz)

with open(os.path.join(root, 'settings/index.html'), 'w', encoding='utf-8') as f:
    f.write("""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script type="text/javascript" src="/homey.js" data-origin="settings"></script>
  <style>
""" + css + """  </style>
  <script>
""" + js + """  </script>
</head>
<body>
""" + st + """
</body>
</html>
""")

# Safety net: every element the scripts look up with $('id') must exist in the page.
for name, html in [('settings', st), ('wizard', wiz)]:
    used = set(re.findall(r"\$\('([A-Za-z0-9_-]+)'\)", html))
    present = set(re.findall(r'id="([A-Za-z0-9_-]+)"', html))
    missing = sorted(used - present)
    if missing:
        sys.exit(f'{name}: missing elements {missing}')
print('UI built; all referenced elements exist')
