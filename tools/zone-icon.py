#!/usr/bin/env python3
"""
Draws the icon of a zone device: a person standing in a dashed area on the floor, in the same slanted
view and line style as the FP300/FP400 icons (960 x 960, colour #231f20, round line ends). The part of
the dashed line behind the person is removed geometrically (shapely), so the SVG needs no masks.
Usage: pip install shapely && python3 tools/zone-icon.py
"""
import math, os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
from shapely.geometry import LineString, Polygon, Point
from shapely.ops import unary_union

COL = '#231f20'
# zone on the floor, slanted like the sensor icons (2:1)
C, HW, HH = (480, 715), 385, 192
rhombus = [(C[0], C[1]-HH), (C[0]+HW, C[1]), (C[0], C[1]+HH), (C[0]-HW, C[1]), (C[0], C[1]-HH)]
# person: head and a rounded body (bust), standing in the middle of the zone
head_c, head_r = (480, 250), 84
bx0, bx1, btop, bbot = 345, 615, 505, 690
r = (bx1 - bx0) / 2
body = [(bx0, bbot)] + [(480 - r * math.cos(t), btop - r * math.sin(t) + 0) for t in [math.pi * i / 40 for i in range(41)]] + [(bx1, bbot)]
bottom = [(bx0 + (bx1 - bx0) * i / 30, bbot + 55 * math.sin(math.pi * i / 30)) for i in range(31)]
silhouette = unary_union([Polygon(body + bottom[::-1]).buffer(0), Point(head_c).buffer(head_r)]).buffer(42)

def dashes(points, dash=64, gap=56):
    line = LineString(points); out = []; pos = 0.0
    while pos < line.length:
        seg = [line.interpolate(pos), line.interpolate(min(pos + dash, line.length))]
        out.append(LineString(seg)); pos += dash + gap
    return out
parts = []
for d in dashes(rhombus):
    v = d.difference(silhouette)              # the zone line behind the person is hidden
    for g in getattr(v, 'geoms', [v]):
        if not g.is_empty and g.length > 8: parts.append(list(g.coords))
dpath = ' '.join('M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in p) for p in parts)
bpath = 'M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in body) + ' ' + ' '.join(f'L{x:.1f} {y:.1f}' for x, y in bottom[::-1][1:])
svg = (f'<svg viewBox="0 0 960 960" xmlns="http://www.w3.org/2000/svg">'
       f'<g fill="none" stroke="{COL}" stroke-linecap="round" stroke-linejoin="round">'
       f'<path d="{dpath}" stroke-width="34"/>'
       f'<circle cx="{head_c[0]}" cy="{head_c[1]}" r="{head_r}" stroke-width="40"/>'
       f'<path d="{bpath} Z" stroke-width="40"/>'
       '</g></svg>')
open(os.path.join(ROOT, 'drivers/fp400_zone/assets/icon.svg'), 'w').write(svg)
print('Zone icon written')
