#!/usr/bin/env python3
"""Builds js/data/mel.json from the team's Boeing 737-800 MEL PDF.

Two steps, because the PDF is a table and plain text extraction scrambles it:

  swift tools/mel_words.swift "B737 MEL.pdf" words.tsv   (macOS; lists every word with its position)
  python3 tools/build_mel.py words.tsv

The first half of the document is the list itself (one table per chapter); the
second half holds the (O) operations and (M) maintenance procedures per item.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'js' / 'data' / 'mel.json'
SOURCE = 'Boeing 737-800 operator MEL, Revision 8 (16 September 2021), derived from FAA MMEL Revision 61. For flight simulation only.'

# Left edge of each table column, in PDF points.
COLS = [('seq', 0), ('item', 62), ('cat', 255), ('inst', 278), ('req', 302), ('rem', 327)]
SEQ = re.compile(r'^\d\d[A-Z]?(-\d\d[A-Z]?)*$')
CHAPTER = re.compile(r'^(\d\d)\.?\s*([A-Z][A-Za-z/ ]+)$')
KEY = re.compile(r'^(AIRCRAFT:|(Boeing )?B-737)?\s*(TABLE KEY|1\. REPAIR CATEGORY|2\. NO\. INSTALLED|3\. NO\. REQUIRED FOR DISPATCH|4\. REMARKS OR EXCEPTIONS)?$')
BULLET = re.compile(r'^(\(?[a-z]\)|[A-F]\.|\(?\d{1,2}\)|\d\.|NOTE\b.*|Note:?)$')
CONTD = re.compile(r'\(cont(’|\')?d?\)|\(Continued\)', re.I)
LINE = 19  # the most two lines of one paragraph are apart

# Procedures
PROC_ID = re.compile(r'^\d\d-\d\d[A-Z]?(-\d\d[A-Z]?)*$')
SECTION = re.compile(r'^(OPERATIONS|MAINTENANCE) ?(\(O\)|\(M\)|NOTE)?:?\s*(.*)$')
MARKER = re.compile(r'^(\d{1,2}[.)]|[A-Za-z][.)]|\([a-z0-9]{1,2}\)|NOTE\b.*|CAUTION:?|WARNING:?)$')

# The crew oxygen table is a picture in the PDF, so it is typed in here.
OXYGEN = """Flight crew oxygen: required pressure (psi) for a 114/115 cubic ft cylinder
Bottle temp °C | 2 crew | 3 crew | 4 crew
50 | 530 | 735 | 945
45 | 520 | 725 | 930
40 | 510 | 715 | 915
35 | 505 | 700 | 900
30 | 495 | 690 | 885
25 | 485 | 680 | 870
20 | 480 | 670 | 860
15 | 470 | 655 | 840
10 | 460 | 645 | 830
5 | 455 | 635 | 815
0 | 445 | 620 | 800
-5 | 440 | 610 | 785
-10 | 430 | 600 | 770"""


def read_pages(path):
    pages = defaultdict(list)
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        page, x0, x1, top, bottom, text = line.split('\t')
        pages[int(page)].append((float(top), float(x0), float(x1), text))
    return pages


def lines_of(words):
    """Group a page's words into lines: [(top, [(x0, x1, text)])], skipping the page header."""
    lines = []
    for top, x0, x1, text in sorted(words):
        if top < 40:
            continue
        if not lines or top - lines[-1][0] > 4:
            lines.append((top, []))
        lines[-1][1].append((x0, x1, text))
    for _, ws in lines:
        ws.sort()
    return lines


def plain(ws):
    return ' '.join(w[2] for w in ws)


def column(x):
    name = COLS[0][0]
    for col, left in COLS:
        if x >= left:
            name = col
    return name


# ---------------------------------------------------------------- the list

def parse_list(pages, first_page, last_page):
    entries, order, chapters, warnings = {}, [], {}, []
    ata = None
    carry = None  # the entry a page ends on, for remarks that run over the page

    def entry(key, page):
        if key not in entries:
            entries[key] = {'id': key, 'title': [], 'cat': '', 'inst': '', 'req': '', 'rem': [], 'page': page}
            order.append(key)
        return entries[key]

    for number in sorted(pages):
        if number > last_page:
            break
        lines = [l for l in lines_of(pages[number]) if not KEY.match(plain(l[1]))]
        # The column headings; "Sequence No." is sometimes wrapped over two lines.
        for i in range(len(lines) - 1, 0, -1):
            if plain(lines[i - 1][1]) == 'Sequence' and lines[i][1][0][2] == 'No.':
                lines[i - 1:i + 1] = [(lines[i][0], lines[i - 1][1] + lines[i][1])]
        heads = [i for i, (_, ws) in enumerate(lines) if ws[0][2] == 'Sequence' and ws[-1][2] == '4']
        if not heads:
            if number >= first_page and any(w[3] == 'KEY' for w in pages[number]):
                warnings.append(f'page {number}: no table found')
            continue
        skip = set(heads)
        for h in heads:
            for i in (h - 1, h - 2):
                m = i >= 0 and CHAPTER.match(plain(lines[i][1]))
                if m and (i == h - 1 or (h - 1) in skip):
                    skip.add(i)
                    if i == h - 1:
                        ata = m.group(1)
                        chapters.setdefault(ata, m.group(2).strip())
        body = [l for i, l in enumerate(lines) if i not in skip and i > heads[0]]

        anchors = []  # [top, entry, repeat]
        cats = []  # [top, cat, inst, req]
        rems = []  # (top, x0, text)
        for top, ws in body:
            cells = defaultdict(list)
            for x0, x1, text in ws:
                cells[column(x0)].append((x0, text))
            seq = cells['seq'][0][1].replace('***', '') if cells['seq'] else ''
            title = cells['seq'][1:] + cells['item'] if SEQ.match(seq) else cells['seq'] + cells['item']
            if SEQ.match(seq):
                if ata == '46' and seq.startswith('46-'):
                    seq = seq[3:]  # this chapter alone repeats its own number
                key = f'{ata}-{seq}'
                anchors.append([top, entry(key, number), key in entries and entries[key]['page'] != number])
            elif cells['seq'] and not anchors and not title:
                warnings.append(f'page {number}: stray text {plain(ws)!r}')
            text = ' '.join(t for _, t in title)
            if text and anchors and not anchors[-1][2]:
                anchors[-1][1]['title'].append(text)
            cat = ' '.join(t for _, t in cells['cat'])
            if cat:
                if cat not in 'ABCD-':
                    warnings.append(f'page {number}: odd category {cat!r}')
                cats.append([top, cat.replace('-', ''), ' '.join(t for _, t in cells['inst']), ' '.join(t for _, t in cells['req'])])
            if cells['rem']:
                rems.append((top, cells['rem'][0][0], ' '.join(t for _, t in cells['rem'])))

        # Each category belongs to the nearest item number, in order.
        rows = []  # [top, entry]
        taken = set()
        low = 0
        for c in cats:
            near = [(abs(a[0] - c[0]), i) for i, a in enumerate(anchors) if i >= low and i not in taken and abs(a[0] - c[0]) <= 30]
            if not near:
                if not rows:
                    warnings.append(f'page {number}: category at {c[0]:.0f} has no item')
                    continue
                # A second relief for the item above, which has no number of its own.
                base = rows[-1][1]
                extra = entry(f'{base["id"]}#{len([k for k in entries if k.startswith(base["id"] + "#")]) + 2}', number)
                extra.update(cat=c[1], inst=c[2], req=c[3])
                rows.append([c[0], extra])
                warnings.append(f'page {number}: {base["id"]} has a second relief without a number')
                continue
            gap, i = min(near)
            taken.add(i)
            low = i
            e = anchors[i][1]
            if not anchors[i][2]:
                if e['cat']:
                    warnings.append(f'page {number}: {e["id"]} has a second category')
                e.update(cat=c[1], inst=c[2], req=c[3])
            rows.append([c[0], e])
        bare = [[a[0], a[1]] for i, a in enumerate(anchors) if i not in taken]

        # Remarks: blocks of lines, each given to the row it sits beside.
        blocks = []
        for r in rems:
            if blocks and r[0] - blocks[-1][-1][0] <= LINE:
                blocks[-1].append(r)
            else:
                blocks.append([r])
        last = carry
        for block in blocks:
            top, bottom = block[0][0], block[-1][0]
            inside = sorted((r for r in rows if top - LINE <= r[0] <= bottom + 3), key=lambda r: r[0])
            if not inside:
                inside = [r for r in bare if top - LINE <= r[0] <= bottom + 3][:1]
            if not inside:
                if last is None:
                    warnings.append(f'page {number}: remarks with no item: {block[0][2]!r}')
                    continue
                last['rem'].append((number, None, ''))
                last['rem'] += [(number, x, t) for _, x, t in block]
                continue
            if inside[0][0] - top > LINE and last is not None:
                inside = [[top, last]] + inside  # the block starts with the end of the item above
            cuts = []
            for r in inside[1:]:
                i = next((k for k, l in enumerate(block) if l[0] >= r[0] - 2), len(block))
                if 1 < i <= len(block) and block[i - 2][2].endswith('.') and not block[i - 1][2].endswith(('.', ':', ',')):
                    i -= 1
                cuts.append(i)
                warnings.append(f'page {number}: remarks split between {inside[0][1]["id"]} and {r[1]["id"]} at {block[min(i, len(block) - 1)][2]!r}')
            for k, r in enumerate(inside):
                part = block[([0] + cuts)[k]:(cuts + [len(block)])[k]]
                if part:
                    r[1]['rem'].append((number, None, ''))
                    r[1]['rem'] += [(number, x, t) for _, x, t in part]
                    last = r[1]
        every = sorted(rows + bare, key=lambda r: r[0])
        if every:
            carry = last if last is not None and blocks and blocks[-1][-1][0] >= every[-1][0] - LINE else every[-1][1]
    return chapters, [entries[k] for k in order], warnings


def remarks(lines):
    """Join wrapped lines; keep provisos (a, b, 1, 2) and NOTEs on their own lines."""
    out = []
    prev_x = None
    fresh = True
    for _, x0, text in lines:
        if x0 is None:
            fresh = True
            continue
        if CONTD.fullmatch(text.strip()) or text.strip() == '.':
            continue
        first = text.split(' ', 1)[0]
        if fresh or BULLET.match(first) or text.startswith(('(M)', '(O)')) or x0 < prev_x - 5:
            out.append(text)
        else:
            out[-1] += ' ' + text
        prev_x = x0
        fresh = False
    return out


def straight(text):
    return text.replace('’', "'").replace('‘', "'").replace('“', '"').replace('”', '"').replace('', '•')


def tidy(e):
    title = CONTD.sub('', ' '.join(e['title']))
    title = re.sub(r'\s+', ' ', title).replace('( ', '(').replace('Headphon es', 'Headphones').strip()
    text = straight('\n'.join(remarks(e['rem']))).strip()
    m = bool(re.search(r'(^|\n)(\(O\))?\(M\)', text))
    o = bool(re.search(r'(^|\n)(\(M\))?\(O\)', text))
    text = re.sub(r'^((\(M\)|\(O\))\s*)+', '', text)
    return {'id': e['id'], 'title': straight(title), 'cat': e['cat'], 'inst': e['inst'], 'req': e['req'], 'm': m, 'o': o, 'rem': text}


def top_of(key):
    return re.sub(r'[A-Z]$', '', '-'.join(key.split('-')[:2]))


def finish(items):
    """Give every relief an item heading to hang under, and number the unnumbered ones."""
    by_id = {e['id']: e for e in items}
    out = []
    for e in items:
        first = by_id.get(e['id'] + 'A')
        if e['cat'] and first and not first['cat'] and not first['rem']:
            # The category was printed between a heading and its option A; it is A's.
            first.update(cat=e['cat'], inst=e['inst'], req=e['req'], m=e['m'], o=e['o'], rem=e['rem'])
            e.update(cat='', inst='', req='', m=False, o=False, rem='')
    for e in items:
        if '#' in e['id']:
            base = by_id[e['id'].split('#')[0]]
            if base['cat']:
                # "25-04" with two reliefs becomes the heading 25-04 with options A and B.
                first = dict(base, id=base['id'] + 'A', title='')
                base.update(cat='', inst='', req='', m=False, o=False, rem='')
                out.append(first)
            e['id'] = base['id'] + chr(ord('A') + int(e['id'].split('#')[1]) - 1)
        above = by_id.get(e['id'][:-1])
        if above and e['title'] and above['title'].endswith(e['title']):
            e['title'] = ''  # the end of the heading above, wrapped onto this row
        top = top_of(e['id'])
        if e['cat'] and top not in by_id:
            head = {'id': top, 'title': e['title'], 'cat': '', 'inst': '', 'req': '', 'm': False, 'o': False, 'rem': ''}
            by_id[top] = head
            out.append(head)
            e['title'] = ''
        out.append(e)
    return out


# ---------------------------------------------------------- the procedures

def numbers(text):
    words = text.split()
    return len(words) >= 2 and sum(bool(re.match(r'^[-+(]?\d[\d,.]*[%)]?$', w)) for w in words) >= len(words) * 0.6


def parse_procedures(pages, first_page):
    procs = {}  # id -> [[kind, [paragraph]]]
    warnings = []
    current = None
    prev = None  # (top, x0, x1, text_x) of the line before, on this page
    for number in sorted(pages):
        if number < first_page:
            continue
        prev = None
        for top, ws in lines_of(pages[number]):
            text = straight(plain(ws))
            x0, x1 = ws[0][0], ws[-1][1]
            if re.match(r'^(Chapter \d\d|11 B737-800 OMEL|Figure \d)', text):
                continue
            head = text.replace(' (Reserved)', '')
            if PROC_ID.match(head) and x0 < 100:
                current = procs.setdefault(head, [])
                prev = None
                continue
            if current is None:
                warnings.append(f'page {number}: text before any item: {text!r}')
                continue
            m = SECTION.match(text)
            if m and x0 < 100 and (m.group(2) or not m.group(3)):
                kind = {'(O)': 'o', '(M)': 'm'}.get(m.group(2), m.group(1)[0].lower() + 'n')
                current.append([kind, [m.group(3)] if m.group(3) else []])
                prev = None
                continue
            if not current:
                current.append(['n', []])
            paras = current[-1][1]
            marked = MARKER.match(ws[0][2]) and len(ws) > 1
            text_x = ws[1][0] if marked else x0
            gappy = len(ws) > 2 and not marked and max(b[0] - a[1] for a, b in zip(ws, ws[1:])) > 30
            wraps = (
                prev is not None and paras and not marked and not gappy and not prev[4]
                and top - prev[0] <= LINE and prev[2] > 470
                and (abs(x0 - prev[3]) < 4 or abs(x0 - prev[1]) < 4 or (prev[5] and prev[1] < x0 < prev[1] + 70))
                and not numbers(text) and not numbers(paras[-1].rsplit('\n', 1)[-1])
            )
            if wraps:
                paras[-1] += ' ' + text
            elif numbers(text) or gappy:
                # A table row: keep the cells apart.
                cells = [ws[0][2]]
                for a, b in zip(ws, ws[1:]):
                    if b[0] - a[1] > 12:
                        cells.append(b[2])
                    else:
                        cells[-1] += ' ' + b[2]
                paras.append(' | '.join(cells))
            else:
                paras.append(text)
            prev = (top, x0, x1, x0 if wraps else text_x, gappy, prev[5] if wraps else bool(marked))
    out = {}
    for key, sections in procs.items():
        kept = [[kind, '\n'.join(p for p in paras if p).strip()] for kind, paras in sections]
        kept = [s for s in kept if s[1]]
        if kept:
            out[key] = kept
    return out, warnings


def main():
    pages = read_pages(sys.argv[1])
    # The procedures start on the page headed "11 B737-800 OMEL (O) & (M) Procedures".
    split = min(n for n in pages if n > 30 and any(t == 'OMEL' for _, _, _, t in pages[n]) and
                any(t == 'Procedures' and top < 60 for top, _, _, t in pages[n]))
    # The list starts at the first chapter table, after the contents and preamble.
    first = min(n for n in pages if any(t == 'Sequence' for _, _, _, t in pages[n]))
    chapters, raw, warnings = parse_list(pages, first, split - 1)
    items = finish([tidy(e) for e in raw])
    procs, more = parse_procedures(pages, split)
    procs.setdefault('35-01', []).append(['n', OXYGEN])
    for key in ('35-03-01', '35-03-02', '35-03-04'):
        procs.setdefault(key, []).append(['n', OXYGEN])
    out = {
        'source': SOURCE,
        'chapters': [{'ata': a, 'title': t} for a, t in sorted(chapters.items())],
        'items': items,
        'procs': procs,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    for w in warnings + more:
        print('WARN', w)
    reliefs = [e for e in items if e['cat']]
    print(f'{len(chapters)} chapters, {len(items)} entries, {len(reliefs)} reliefs, {len(procs)} procedures, {OUT.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
