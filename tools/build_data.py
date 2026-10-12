#!/usr/bin/env python3
"""Builds src/data/*.json|js from A's resources: the icon paths, and the English and Japanese
tables (A:Resources/en.json, ja.json) with the strings A adds in L10n.swift.

    python3 tools/build_data.py [path to A, default ref/A]
"""
import json
import os
import re
import sys

here = os.path.dirname(os.path.abspath(__file__))
a = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', 'ref', 'A'))
out = os.path.join(here, '..', 'src', 'data')
os.makedirs(out, exist_ok=True)

res = os.path.join(a, 'Inkpad', 'Resources')
icons = json.load(open(os.path.join(res, 'icons.json'), encoding='utf-8'))
with open(os.path.join(out, 'icons.js'), 'w', encoding='utf-8') as f:
    f.write('// Lucide icon paths (https://lucide.dev, ISC licence), from A:Resources/icons.json.\n'
            '// Built by tools/build_data.py - do not edit.\n')
    f.write('export default ' + json.dumps(icons, ensure_ascii=False, separators=(',', ':')) + ';\n')

swift = open(os.path.join(a, 'Inkpad', 'L10n.swift'), encoding='utf-8').read()
lit = r'"((?:[^"\\]|\\.)*)"'


def unescape(s):
    return re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t'}.get(m.group(1), m.group(1)), s)


def extras(name):
    body = swift.split('static let %s: [String: String] = [' % name, 1)[1].split('\n    ]', 1)[0]
    return {unescape(k): unescape(v) for k, v in re.findall(lit + r'\s*:\s*' + lit, body)}


for lang, name in (('en', 'extraEN'), ('ja', 'extraJA')):
    table = json.load(open(os.path.join(res, lang + '.json'), encoding='utf-8'))
    for k, v in extras(name).items():
        table.setdefault(k, v)       # A: load(...).merging(extra) { a, _ in a } - the file's entry wins
    with open(os.path.join(out, lang + '.json'), 'w', encoding='utf-8') as f:
        json.dump(table, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    print(lang, len(table), 'strings')
print('icons:', len(icons['icons']), 'glyphs:', len(icons['glyphs']))
