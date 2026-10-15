#!/usr/bin/env python3
"""
Draws the FP400 icons in the style of the FP300 icons: 960 x 960, colour #231f20, round line ends,
thick (40) outer lines and thin (18) inner lines. Like the FP300 icon, a round base (the wall plate)
sits behind the device; the FP400 disc is drawn over it. The grey sensor window starts at the top
edge of the disc and runs over the rim onto its side (product photo). Hidden lines are removed geometrically (shapely), so the SVG needs
no masks. The Matter version takes the Matter logo from the FP300 Matter icon and keeps the drawing
50 px clear of it.   Usage: pip install shapely && python3 tools/fp400-icon.py
"""
import math, os, re
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
from shapely.geometry import Polygon, LineString, MultiLineString
from shapely.ops import unary_union
TH, TN = 40, 18
COL = '#231f20'
rot = math.radians(22)
A = (math.cos(rot), math.sin(rot))       # axis, wall -> front (screen direction of the minor axis)
U = (-math.sin(rot), math.cos(rot))      # vertical on the faces

def add(p,v,s): return (p[0]+v[0]*s, p[1]+v[1]*s)
def ell(c, rx, ry, n=360):
    return [(c[0]+rx*math.cos(t)*A[0]+ry*math.sin(t)*U[0], c[1]+rx*math.cos(t)*A[1]+ry*math.sin(t)*U[1])
            for t in (2*math.pi*i/n for i in range(n))]
def solid(*rings): return unary_union([Polygon(r).convex_hull for r in rings]).convex_hull

def visible(line_pts, closed, occluders):
    ls = LineString(line_pts + ([line_pts[0]] if closed else []))
    for o in occluders: ls = ls.difference(o)
    if ls.is_empty: return []
    geoms = getattr(ls, 'geoms', [ls])
    return [list(g.coords) for g in geoms if g.length > 2]

def d_of(parts): return ' '.join('M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in p) for p in parts)

# ---- geometry (screen units of a 960 canvas)
F = (640, 520); rx, ry = 170, 300; depth = 80           # device (disc): front face and thickness
B = add(F, A, -depth)
k = rx / ry
def face(c, v, w): return add(add(c, U, v), A, w * k)  # point on a face: v down, w across (compressed)
# Wall plate, like the round base of the FP300 icon: a thick ring behind the disc, a bit smaller and
# slightly higher (product photo). The clip between plate and disc is hidden behind the disc.
P1 = face(add(B, A, -95), -40, 0); prx, pry = 150, 262; pt = 34
P2 = add(P1, A, -pt)
dev_front, dev_back = ell(F, rx, ry), ell(B, rx, ry)
plate_front, plate_back = ell(P1, prx, pry), ell(P2, prx, pry)
DEV = solid(dev_front, dev_back)
PLATE = solid(plate_front, plate_back)

thick, thin = [], []
# plate first: everything of it behind the disc is hidden
thick += visible(list(PLATE.exterior.coords), True, [DEV])
thin += visible(plate_front, True, [DEV])
# disc: outline thick, front face thin
thick += [list(DEV.exterior.coords)]
# Sensor window, in the style of the window on the FP300 icon: a rounded "tongue" that hangs from the
# outline at the top edge of the disc and runs over the rim. Its two sides flare out into the outline
# with small curves; drawn a bit heavier than the inner lines. The thin rim line of the face stops at
# the window; the thick outline stays whole.
TW = 26                                                 # line weight of the window (between TN and TH)
win_w, win_len, flare = 40, 125, 40                     # half width, length on the face, size of the flares
def rim_v(w): return -math.sqrt(ry * ry - w * w)       # top edge of the face circle at offset w
def qbez(p0, p1, p2, n=12):
    return [((1-t)**2*p0[0]+2*(1-t)*t*p1[0]+t*t*p2[0], (1-t)**2*p0[1]+2*(1-t)*t*p1[1]+t*t*p2[1])
            for t in (i/n for i in range(n+1))]
L_top = face(F, rim_v(-win_w - flare), -win_w - flare)  # where the left flare meets the outline
R_top = face(F, rim_v(win_w + flare), win_w + flare)
L_mid = face(F, rim_v(-win_w) + flare, -win_w)
R_mid = face(F, rim_v(win_w) + flare, win_w)
bottom_v = rim_v(0) + win_len - win_w
window = qbez(L_top, face(F, rim_v(-win_w), -win_w), L_mid)
window += [face(F, bottom_v, -win_w)]
for i in range(1, 24):
    t = math.radians(180 - 180 * i / 24)
    window.append(face(F, bottom_v + win_w * math.sin(t), win_w * math.cos(t)))
window += [face(F, bottom_v, win_w)]
window += qbez(R_mid, face(F, rim_v(win_w), win_w), R_top)
WIN_AREA = Polygon(window).buffer(0)
thin += visible(dev_front, True, [WIN_AREA])            # the face rim line stops at the window
medium = [window]
# (A second slot on the side, like the FP300 icon has, does not fit: the FP400 disc is so thin that the
# side band at the top is only a few pixels wide; tried in 0.6.27 and it only cluttered the outline.)

def fit(parts_list, box=(70, 70, 890, 890)):
    xs = [x for parts in parts_list for p in parts for x, _ in p]; ys = [y for parts in parts_list for p in parts for _, y in p]
    s = min((box[2]-box[0]) / (max(xs)-min(xs)), (box[3]-box[1]) / (max(ys)-min(ys)))
    ox = box[0] + ((box[2]-box[0]) - (max(xs)-min(xs)) * s) / 2 - min(xs) * s
    oy = box[1] + ((box[3]-box[1]) - (max(ys)-min(ys)) * s) / 2 - min(ys) * s
    return s, ox, oy

def svg(matter=False):
    s, ox, oy = fit([thick, thin, medium], (70, 70, 890, 890))
    T = lambda parts: [[(x*s+ox, y*s+oy) for x, y in p] for p in parts]
    th, tn, md = T(thick), T(thin), T(medium)
    if matter:
        # keep the drawing clear of the Matter logo (bottom right), without SVG masks
        from shapely.geometry import Point
        hole = [Point(792, 794).buffer(150).union(Point(792, 794).buffer(1).buffer(0))]
        from shapely.geometry import box
        hole = [box(636, 642, 949, 947).buffer(50)]
        cutp = lambda parts: [q for p in parts for q in visible(p, False, hole)]
        th, tn, md = cutp(th), cutp(tn), cutp(md)
    g = (f'<g fill="none" stroke="{COL}" stroke-linecap="round" stroke-linejoin="round">'
         f'<path d="{d_of(tn)}" stroke-width="{TN}"/>'
         f'<path d="{d_of(md)}" stroke-width="{TW}"/>'
         f'<path d="{d_of(th)}" stroke-width="{TH}"/>'
         '</g>')
    if not matter:
        return f'<svg viewBox="0 0 960 960" xmlns="http://www.w3.org/2000/svg">{g}</svg>'
    m = open(os.path.join(ROOT, 'drivers/fp300_matter/assets/icon.svg')).read()
    logo = ''.join(re.findall(r'<path\b[^>]*?/>', m)[1:])
    return f'<svg viewBox="0 0 960 960" xmlns="http://www.w3.org/2000/svg">{g}<g fill="#000">{logo}</g></svg>'

for rel, matter in (('drivers/fp400/assets/icon.svg', False), ('drivers/fp400_matter/assets/icon.svg', True), ('drivers/fp400_matter/assets/learn.svg', True)):
    open(os.path.join(ROOT, rel), 'w').write(svg(matter))
print('FP400 icons written')
