#!/usr/bin/env python3
"""Builds js/data/mel.json from the FAA Boeing 737 MMEL PDF.

Two steps, because the PDF is a table and plain text extraction scrambles it:

  swift tools/mel_words.swift MMEL_B-737.pdf words.tsv   (macOS; lists every word with its position)
  python3 tools/build_mel.py words.tsv

Only items that can apply to a passenger 737-800 are kept.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'js' / 'data' / 'mel.json'

# Left edge of each table column, in PDF points.
COLS = [('seq', 0), ('item', 130), ('cat', 268), ('inst', 292), ('req', 318), ('rem', 337), ('bar', 527)]
SEQ = re.compile(r'^\d{2,3}(-\d\d)*[A-Z]?$')
BULLET = re.compile(r'^(\(?[a-z]\)|\(?\d{1,2}\)|NOTES?:?|NOTE)$')
MODEL = re.compile(r'-\s?(\d00[A-Z]*)\b')
CARGO = re.compile(r'all-cargo|combi\b|cargo configuration|737C|\bQC\b|freighter', re.I)


def column(x):
    name = COLS[0][0]
    for col, left in COLS:
        if x >= left:
            name = col
    return name


def read_pages(path):
    pages = defaultdict(list)
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        page, x0, x1, top, bottom, text = line.split('\t')
        pages[int(page)].append((float(top), float(x0), text))
    return pages


def lines_of(words):
    """Group a page's words into lines: [(top, {column: [(x0, text)]})]."""
    lines = []
    for top, x0, text in sorted(words):
        if not lines or top - lines[-1][0] > 2.5:
            lines.append((top, defaultdict(list)))
        lines[-1][1][column(x0)].append((x0, text))
    for _, cells in lines:
        for col in cells:
            cells[col].sort()
    return lines


def text_of(cell):
    return ' '.join(t for _, t in cell)


def parse(pages):
    entries = {}  # key "21-01-02A" -> entry
    order = []
    chapters = {}
    warnings = []
    for number in sorted(pages):
        lines = lines_of(pages[number])
        head = next((i for i, (_, c) in enumerate(lines) if text_of(c['seq']) == 'Sequence No.'), None)
        if head is None:
            continue
        # The line above the column headings names the chapter: "21. Air Conditioning".
        full = ' '.join(text_of(lines[head - 1][1][col]) for col, _ in COLS).strip()
        m = re.match(r'^(\d\d)\.\s+(.*)$', full)
        if not m:
            warnings.append(f'page {number}: no chapter heading ({full!r})')
            continue
        ata = m.group(1)
        chapters.setdefault(ata, m.group(2).strip())
        current = None
        repeat = False  # inside a "(Cont'd)" heading repeated from the page before
        for top, cells in lines[head + 1:]:
            # "***" marks equipment the rules do not require; it is not part of the number.
            seq = text_of(cells['seq']).replace('***', '').strip()
            item = text_of(cells['item'])
            if top - lines[head][0] < 10 and item == '' and text_of(cells['bar']) == 'Bar':
                continue
            if seq:
                if not SEQ.match(seq):
                    warnings.append(f'page {number}: odd sequence text {seq!r}')
                    continue
                key = f'{ata}-{seq}'
                repeat = key in entries
                if not repeat:
                    entries[key] = {'id': key, 'title': [], 'cat': '', 'inst': '', 'req': '', 'rem': [], 'page': number}
                    order.append(key)
                current = entries[key]
            if current is None:
                continue
            if item and not repeat:
                current['title'].append(item)
            for col in ('cat', 'inst', 'req'):
                value = text_of(cells[col])
                if value:
                    if current[col] and not repeat:
                        warnings.append(f'page {number}: {current["id"]} has a second {col} value {value!r}')
                    elif not current[col]:
                        current[col] = '0' if value == 'O' else value
            if cells['rem']:
                current['rem'].append((cells['rem'][0][0], text_of(cells['rem'])))
    return chapters, [entries[k] for k in order], warnings


def remarks(lines):
    """Join wrapped lines; keep provisos (a, b, 1, 2) and NOTEs on their own lines."""
    out = []
    prev_x = None
    for x0, text in lines:
        if text in ('(Continued)', '(Cont’d)'):
            continue
        first = text.split(' ', 1)[0]
        new = not out or BULLET.match(first) or text.startswith('(M)') or text.startswith('(O)') or x0 < prev_x - 5
        if new:
            out.append(text)
        else:
            out[-1] += ' ' + text
        # Text after "a)" sits further right than the marker; measure from the marker.
        prev_x = x0
    return out


def tidy(e):
    title = ' '.join(e['title']).replace('(Cont’d)', '').strip()
    title = re.sub(r'\s+', ' ', title).replace('( ', '(').replace('/ -', '/-')
    paras = remarks(e['rem'])
    text = '\n'.join(paras).replace('’', "'").replace('“', '"').replace('”', '"')
    text = re.sub(r'\s*\|\s*', ' ', text).strip()
    flags = re.match(r'^((?:\((?:M|O)\))+)\s*', text)
    m = o = False
    if flags:
        m, o = '(M)' in flags.group(1), '(O)' in flags.group(1)
        text = text[flags.end():]
    return {'id': e['id'], 'title': title.replace('’', "'"), 'cat': e['cat'], 'inst': e['inst'], 'req': e['req'],
            'm': m, 'o': o, 'rem': text}


def parent(key):
    if key[-1].isalpha():
        return key[:-1]
    return key.rsplit('-', 1)[0] if key.count('-') > 1 else None


def applies(title):
    """False when a title limits the item to other 737 models or to freighters."""
    if CARGO.search(title):
        return False
    models = MODEL.findall(title)
    through = re.search(r'-(\d)00\w* (?:through|thru) -(\d)00', title)
    if through:
        return int(through.group(1)) <= 8 <= int(through.group(2))
    onward = re.search(r'-(\d)00\w*,? and (?:subsequent|on)\b', title)
    if onward:
        return int(onward.group(1)) <= 8
    if models:
        return '800' in models
    return True


def main():
    chapters, raw, warnings = parse(read_pages(sys.argv[1]))
    items = [tidy(e) for e in raw]
    by_id = {e['id']: e for e in items}
    kept = []
    dropped = 0
    for e in items:
        chain, key = [], e['id']
        while key:
            if key in by_id:
                chain.append(by_id[key])
            key = parent(key)
        if 'deleted' in e['rem'].lower()[:40] or not all(applies(x['title']) for x in chain):
            dropped += 1
            continue
        kept.append(e)
    out = {
        'source': 'FAA MMEL Boeing 737, Revision 62 (draft)',
        'chapters': [{'ata': a, 'title': t} for a, t in sorted(chapters.items())],
        'items': kept,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    for w in warnings:
        print('WARN', w)
    print(f'{len(chapters)} chapters, {len(items)} entries read, {dropped} dropped, {len(kept)} kept, {OUT.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
