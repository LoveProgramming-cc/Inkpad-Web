#!/usr/bin/env python3
"""Lists the interface strings in src/ that have no English or Japanese translation yet.

    python3 tools/missing_strings.py [--json]
"""
import json
import os
import re
import sys

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
data = os.path.join(root, 'src', 'data')
tables = {l: json.load(open(os.path.join(data, l + '.json'), encoding='utf-8')) for l in ('en', 'ja')}
web = os.path.join(data, 'web.json')
if os.path.exists(web):
    extra = json.load(open(web, encoding='utf-8'))
    for l in ('en', 'ja'):
        tables[l].update(extra.get(l, {}))
found = {}
pat = re.compile(r"""\btrf?\(\s*(['"`])((?:\\.|(?!\1).)*)\1""", re.S)
for base, dirs, names in os.walk(os.path.join(root, 'src')):
    dirs[:] = [d for d in dirs if d != 'vendor']
    for n in names:
        if not n.endswith('.js') or n == 'icons.js':
            continue
        text = open(os.path.join(base, n), encoding='utf-8').read()
        for m in pat.finditer(text):
            s = m.group(2).encode().decode('unicode_escape', 'ignore') if '\\' in m.group(2) and False else m.group(2).replace("\\'", "'").replace('\\n', '\n')
            if re.search(r'[一-鿿]', s):
                found.setdefault(s, os.path.relpath(os.path.join(base, n), root))
missing = {l: sorted(s for s in found if s not in tables[l]) for l in ('en', 'ja')}
if '--json' in sys.argv:
    print(json.dumps(missing['en'], ensure_ascii=False, indent=1))
else:
    print('strings in the source:', len(found), ' missing en:', len(missing['en']), ' missing ja:', len(missing['ja']))
    for s in missing['en']:
        print(' ', json.dumps(s, ensure_ascii=False))
