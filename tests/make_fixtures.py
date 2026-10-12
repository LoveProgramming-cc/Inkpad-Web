#!/usr/bin/env python3
"""Writes tests/fixtures/*.json from B's own code, for the JS tests to compare against.

    python3 tests/make_fixtures.py [path to B, default ref/B]
"""
import json
import math
import os
import random
import sys
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from stubs import load  # noqa: E402

app = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', 'ref', 'B')
model, geom = load(os.path.abspath(app), tempfile.mkdtemp())
out = os.path.join(here, 'fixtures')
os.makedirs(out, exist_ok=True)
rnd = random.Random(20261011)


def dump(name, value):
    with open(os.path.join(out, name), 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, separators=(',', ':'))


def rpts(n, x0=100.0, y0=100.0, spread=200.0, pressure=True):
    pts, x, y = [], x0, y0
    for _ in range(n):
        x += rnd.uniform(-spread, spread) / 20
        y += rnd.uniform(-spread, spread) / 20
        pts.append((round(x, 3), round(y, 3), round(rnd.random(), 3) if pressure else 0.5))
    return pts


# -- pack ---------------------------------------------------------------------
packs = []
cases = [
    [],
    [(10.0, 20.0, 0.5)],
    [(0.0, 0.0, 0.0), (0.01, -0.01, 1.0)],
    [(-5.25, 7.125, 0.25), (-5.26, 7.13, 0.75), (300.5, -200.75, 0.33)],
    # whiteboard magnitudes: x * 100 is far beyond 2**31
    [(5e7, 5e7, 0.5), (5e7 + 0.37, 5e7 - 12.55, 0.6), (5e7 + 1500.04, 5e7 + 99.99, 0.1)],
    [(-5e7, 4.9999e7, 0.5), (-5e7 + 3, 4.9999e7 - 8, 0.9)],
    [(1e8, 1e8, 1.0), (0.0, 0.0, 0.0)],
]
for n in (2, 40, 400):
    cases.append(rpts(n))
cases.append(rpts(60, 5e7, 5e7, 40))
for pts in cases:
    text = model.pack_points(pts)
    back = model.unpack_points(text)
    packs.append({'pts': pts, 'q': text, 'back': back})
dump('pack.json', packs)

# -- geom ---------------------------------------------------------------------
G = {}


def circle(cx, cy, rx, ry, n, jitter=0.0, closed=True):
    pts = []
    for i in range(n + (1 if closed else 0)):
        a = 2 * math.pi * i / n
        pts.append((cx + rx * math.cos(a) + rnd.uniform(-jitter, jitter),
                    cy + ry * math.sin(a) + rnd.uniform(-jitter, jitter), 0.5))
    return pts


def rectangle(x0, y0, x1, y1, n_side=12, jitter=0.0):
    pts = []
    for (ax, ay), (bx, by) in zip([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], [(x1, y0), (x1, y1), (x0, y1), (x0, y0)]):
        for i in range(n_side):
            t = i / n_side
            pts.append((ax + (bx - ax) * t + rnd.uniform(-jitter, jitter),
                        ay + (by - ay) * t + rnd.uniform(-jitter, jitter), 0.5))
    pts.append(pts[0])
    return pts


def zigzag(n, w, h, jitter=0.5):
    return [(100 + (i % 2) * w + rnd.uniform(-jitter, jitter), 100 + i * h / n, 0.5) for i in range(n)]


shape_cases = [
    rpts(5), rpts(30), circle(200, 200, 50, 30, 30), circle(200, 200, 50, 30, 30, 2.0),
    circle(200, 200, 60, 60, 40, 5.0), rectangle(100, 100, 220, 180), rectangle(100, 100, 220, 180, 12, 2.0),
    [(0.0, 0.0, 0.5), (10.0, 1.0, 0.5), (20.0, 0.0, 0.5), (30.0, 1.0, 0.5), (40.0, 0.0, 0.5), (60.0, 2.0, 0.5)],
    [(0.0, 0.0, 0.5)] * 8, circle(50, 50, 1, 1, 12), circle(50, 50, 80, 2, 30, 0.1),
    [(i * 3.0, (i * 3.0) ** 1.3 / 8, 0.5) for i in range(20)],
    [(100.0 + 10 * math.cos(a / 7), 100.0 + 40 * math.sin(a / 7), 0.5) for a in range(20)],
]
G['shapes'] = [{'pts': p, 'shape': geom.recognize_shape(p)} for p in shape_cases]

scribble_cases = [zigzag(20, 60, 40), zigzag(40, 80, 30), zigzag(9, 60, 40), rpts(50), rpts(50, spread=400),
                  circle(100, 100, 40, 40, 30), zigzag(30, 3, 2), [(100 + i * 4.0, 100.0, 0.5) for i in range(30)],
                  zigzag(14, 100, 10, 2.0), [(100 + (i % 4) * 30 - (i // 4) * 2.0, 100 + i * 3.0, 0.5) for i in range(32)]]
G['scribbles'] = [{'pts': p, 'is': geom.is_scribble(p)} for p in scribble_cases]


def snapshot(it):
    return {'kind': it.kind, 'bbox': list(it.bbox), 'polyline': it.polyline(), 'sample': it.sample()}


items = [
    model.Stroke('ball', (0, 0, 0), 1.5, [(100 + i * 3.0, 110 + math.sin(i / 3) * 12, 0.5) for i in range(30)]),
    model.Stroke('fountain', (0, 0, 0), 2.0, rpts(80, 120, 120, 120)),
    model.Stroke('hl', (1, 1, 0), 12.0, [(80 + i * 5.0, 140.0, 0.5) for i in range(20)]),
    model.Stroke('ball', (0, 0, 0), 1.0, [(150.0, 150.0, 0.5)]),
    model.Stroke('ball', (0, 0, 0), 1.0, [(400.0, 400.0, 0.5), (420.0, 410.0, 0.5)]),
    model.Shape('rect', 90, 90, 160, 150, (1, 0, 0), 2.0),
    model.Shape('ellipse', 120, 100, 220, 190, (0, 1, 0), 2.0),
    model.Shape('arrow', 300, 300, 340, 280, (0, 0, 1), 2.0),
    model.Shape('line', 100, 100, 250, 250, (0, 0, 1), 2.0),
    model.Text(130.0, 130.0, 'hello world', 18.0, (0, 0, 0), 0.0),
    model.Text(500.0, 500.0, 'far away', 18.0, (0, 0, 0), 100.0),
    model.Text(105.0, 105.0, 'note', 13.0, (0, 0, 0), 170.0, (1, 0.9, 0.5)),
    model.Image(140.0, 140.0, 80.0, 60.0, b'png'),
    model.Image(600.0, 600.0, 80.0, 60.0, b'png'),
]
G['items'] = [snapshot(it) for it in items]


def idx(found):
    return [next(i for i, it in enumerate(items) if it is f) for f in found]


G['scribble_targets'] = []
for sc in (zigzag(30, 120, 100, 1.0), [(90 + (i % 2) * 140, 95 + i * 3.0, 0.5) for i in range(40)],
           circle(130, 130, 90, 90, 40), [(300 + (i % 2) * 40.0, 270 + i * 2.0, 0.5) for i in range(30)]):
    G['scribble_targets'].append({'pts': sc, 'hits': idx(geom.scribble_targets(sc, items))})

G['lasso'] = []
for poly in (circle(130, 130, 60, 60, 24), circle(130, 130, 5, 5, 8), [(80, 80, 0), (230, 80, 0), (230, 200, 0)],
             circle(400, 400, 40, 40, 16), [(90, 90, 0), (230, 90, 0), (230, 200, 0), (90, 200, 0)],
             [(0, 0, 0), (700, 0, 0), (700, 700, 0), (0, 700, 0)], [(10, 10, 0), (20, 10, 0)]):
    G['lasso'].append({'poly': poly, 'hits': idx(geom.lasso_pick(poly, items))})
G['rect'] = []
for box in ((80, 80, 230, 200), (0, 0, 50, 50), (390, 390, 430, 420), (135, 135, 145, 145), (-10, -10, 800, 800)):
    G['rect'].append({'box': list(box), 'hits': idx(geom.rect_pick(box, items))})

G['erase'] = []
for pts in (items[0].pts, items[1].pts, items[2].pts, items[4].pts, [(100.0, 100.0, 0.5), (100.0, 100.0, 0.5)]):
    for (ax, ay, bx, by, r) in ((150, 105, 150, 120, 9), (110, 100, 300, 130, 4), (0, 0, 10, 10, 4), (100, 100, 100, 100, 18),
                                (400, 400, 420, 410, 4), (170, 112, 175, 112, 0.5)):
        G['erase'].append({'pts': pts, 'seg': [ax, ay, bx, by], 'r': r, 'out': geom.erase_runs(pts, ax, ay, bx, by, r)})

G['hull'] = []
for pts in (rpts(60), rpts(3), [(1.0, 1.0, 0)] * 4, [(0.0, 0.0, 0), (1.0, 1.0, 0), (2.0, 2.0, 0), (3.0, 3.0, 0)], circle(0, 0, 10, 10, 12)):
    G['hull'].append({'pts': pts, 'hull': geom.convex_hull(pts)})
G['decimate'] = [{'n': n, 'limit': k, 'idx': [p[0] for p in geom.decimate([(float(i), 0, 0) for i in range(n)], k)]}
                 for n, k in ((10, 20), (100, 40), (101, 40), (1000, 150), (7, 3))]
G['densify'] = [{'pts': pts, 'step': s, 'out': geom.densify(pts, s)}
                for pts, s in ((items[0].pts, 3.0), ([(0.0, 0.0), (10.0, 0.0)], 3.0), ([(0.0, 0.0, 0.2), (10.0, 5.0, 0.8)], 2.5), ([(1.0, 1.0)], 3.0))]
dump('geom.json', G)
print('fixtures written to', out)

# -- a whole notebook written by B --------------------------------------------
from dump_doc import dump  # noqa: E402

model.Document.cover = lambda self: b'\x89PNG\r\n\x1a\nfake cover'   # no cairo here
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf5000000401010000d1b6f4c00000000049454e44ae426082')
doc = model.Document({'w': 595.0, 'h': 842.0, 'paper': 'grid', 'color': (0.976, 0.965, 0.902)})
page = doc.pages[0]
image = model.Image(100.0, 500.0, 80.0, 60.0, PNG)
tape = model.Stroke('tape', (0.96, 0.82, 0.36), 16.0, [(50.0, 300.0, 0.5), (200.0, 300.0, 0.5)])
tape.open = True
doc.add_items(page, [
    model.Stroke('fountain', (0.1, 0.2, 0.3), 1.6, [(10.0, 10.0, 0.2), (60.0, 40.0, 0.8), (120.0, 30.0, 0.5)], 1.2), tape,
    model.Shape('arrow', 20.0, 100.0, 200.0, 180.0, (1.0, 0.0, 0.0), 2.0),
    model.Text(40.0, 400.0, '你好 Inkpad', 18.0, (0.0, 0.0, 0.0), 300.0),
    model.Text(300.0, 400.0, 'note 😀', 13.0, (0.16, 0.15, 0.12), 170.0, (1.0, 0.93, 0.55)),
    image, model.Image(300.0, 500.0, 40.0, 30.0, PNG),
    model.Stroke('brush', (0, 0, 0), 2.4, [(5e7 + i * 1.37, 5e7 - i * 0.61, (i % 7) / 7) for i in range(50)], 1.0, 2)])
second = page.blank_like()
second.bookmark, second.outline = True, '第二页'
doc.do(('pages', [], [(1, second)]))
doc.add_items(second, [model.Stroke('hl', (1.0, 0.88, 0.3), 14.0, [(5.0, 5.0, 0.5), (100.0, 5.0, 0.5)], 1.0, 1)])
pdf = model.PdfDoc(b'%PDF-1.4 not really a pdf, but it is the same one twice')
third = model.Page(300.0, 400.0, 'blank', pdf=pdf, pdf_page=0)
fourth = model.Page(300.0, 400.0, 'blank', pdf=pdf, pdf_page=1)
fourth.rot = 3
board = model.Page(1e8, 1e8, 'dots', board=True)
doc.do(('pages', [], [(2, third), (3, fourth), (4, board)]))
doc.add_items(board, [model.Stroke('ball', (0, 0, 0), 1.0, [(5e7, 5e7, 0.5), (5e7 + 3, 5e7 + 4, 0.5)])])
doc.remove_items(page, [page.items[2]])           # a tombstone
doc.cover_spec = ('band', (0.17, 0.27, 0.45))
doc.stamp()
doc.save(os.path.join(out, 'b-sample.inkpad'))
dump_it = dump(model, model.Document.load(os.path.join(out, 'b-sample.inkpad')))
dump_it['id'] = doc.id
dump_file = os.path.join(out, 'b-sample.json')
with open(dump_file, 'w', encoding='utf-8') as f:
    json.dump(dump_it, f, ensure_ascii=False, separators=(',', ':'))

# Two versions of the sample, changed on both sides, merged by B: what JS has to arrive at too.
mine = model.Document.load(os.path.join(out, 'b-sample.inkpad'))
theirs = model.Document.load(os.path.join(out, 'b-sample.inkpad'))
mine.remove_items(mine.pages[0], [mine.pages[0].items[0]])
mine.add_items(mine.pages[0], [model.Stroke('ball', (0, 0, 0), 1.0, [(1.0, 1.0, 0.5), (2.0, 2.0, 0.5)])])
mine.pages[1].outline = 'mine'
theirs.remove_items(theirs.pages[0], [theirs.pages[0].items[1]])
theirs.add_items(theirs.pages[0], [model.Text(9.0, 9.0, 'theirs', 18.0, (0, 0, 0), 0.0)])
theirs.pages[1].bookmark = False
theirs.pages[1].outline = 'theirs'
theirs.stamp()
extra = theirs.pages[0].blank_like()
theirs.do(('pages', [], [(1, extra)]))
theirs.do(('pages', [(3, theirs.pages[3])], []))
for d_ in (mine, theirs):
    d_.cover = lambda self=d_: b'x'
mine.save(os.path.join(out, 'merge-mine.inkpad'))
theirs.save(os.path.join(out, 'merge-theirs.inkpad'))
counts = model.merge(mine, theirs)
mine.save(os.path.join(out, 'merge-result.inkpad'))
with open(os.path.join(out, 'merge-result.json'), 'w', encoding='utf-8') as f:
    json.dump({'counts': list(counts), 'doc': dump(model, model.Document.load(os.path.join(out, 'merge-result.inkpad')))}, f, ensure_ascii=False, separators=(',', ':'))
print('notebooks written')
