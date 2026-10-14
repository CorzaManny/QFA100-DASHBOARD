#!/usr/bin/env python3
"""Build native QRH checklist blocks and navigation from PDF text positions.
Requires pymupdf: python3 tools/build_qrh.py '/path/B737 QRH.pdf'
Branch choices remain explicit; extraction is not operationally validated.
"""
import hashlib
import json
import re
import sys
from pathlib import Path
import fitz

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'js/data/non-normal.js'


def slug(text):
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def lines(page):
    result = []
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            x, y, right, bottom = line['bbox']
            text = ''.join(s['text'] for s in line['spans']).strip()
            if x < 25 or y < 50 or y > 735 or not text or re.fullmatch(r'[:\s]+', text):
                continue
            if text.startswith('▼') or text.strip() == 'continued▼' or text in ['Intentionally', 'Blank']:
                continue
            result.append((y, x, right, bottom, text))
    groups = []
    for row in sorted(result):
        if groups and row[0] - groups[-1][0][0] <= 3:
            groups[-1].append(row)
        else:
            groups.append([row])
    merged = []
    for group in groups:
        ordered = sorted(group, key=lambda row: row[1])
        y, x, right, bottom, text = ordered[0]
        texts = [text]
        for yy, xx, rr, bb, tt in ordered[1:]:
            if tt not in texts:
                texts.append(tt)
            right, bottom = max(right, rr), max(bottom, bb)
        merged.append(dict(y=min(row[0] for row in group), x=x, right=right, bottom=bottom, text=' '.join(texts)))

    return merged


NOTE_MARKER = re.compile(r'\b(?:Note\s*:|Caution\s*[!:]|Warning\s*[!:])', re.I)
EXPLANATION = re.compile(
    r'^(?:This (?:allows|ensures|prevents|provides|reduces|increases|disables|means)|'
    r'To manually unlock|Use momentary actuation|Flight crew must use oxygen|'
    r'Maximum flap extension altitude|'
    r'(?:The|Individual|Emergency|Automatic|Nose wheel) .+? '
    r'(?:is|are|will|can|may|must|has|have|supply)\b)', re.I)


def classify_notes(procedure):
    """Keep stable block IDs and progress keys when separating explanatory text."""
    result = []
    for block in procedure['blocks']:
        text = block['text']
        markers = list(NOTE_MARKER.finditer(text))
        if markers:
            first = markers[0].start()
            if first:
                block['text'] = text[:first].strip()
                result.append(block)
            for i, marker in enumerate(markers):
                end = markers[i+1].start() if i+1 < len(markers) else len(text)
                note = {**block, 'id': block['id'] if not first and i == 0 else f"{block['id']}-note-{i}",
                        'text': text[marker.start():end].strip(), 'type': 'note', 'links': []}
                if first or i:
                    note['number'] = None
                    note.pop('check_index', None)
                result.append(note)
            continue
        if block['type'] == 'action' and block['number'] is None and EXPLANATION.match(text):
            # Keep an instruction that follows explanatory prose checkable.
            if text.endswith('Continue normal operation.'):
                info = text.removesuffix('Continue normal operation.').strip()
                result.append({**block, 'id': f"{block['id']}-info", 'text': info, 'type': 'note', 'links': []})
                block['text'] = 'Continue normal operation.'
            else:
                block['type'] = 'note'
        result.append(block)
    procedure['blocks'] = result


def build(source):
    pdf = fitz.open(source)
    toc = pdf.get_toc(False)
    previous = json.loads(OUT.read_text().split('export const NON_NORMAL_QRH = ', 1)[1].rstrip(';\n')) if OUT.exists() else {'source': {'title': 'B737 Quick Reference Handbook', 'document_id': 'D6-27370-800-RE1(P2)'}, 'procedures': []}
    old_ids = {(p['source_pages'][0], slug(p['title'])): p['id'] for p in previous['procedures']}
    old_indices = {}
    for procedure in previous['procedures']:
        index = 0
        for block in procedure.get('blocks', []):
            if block['type'] == 'action' or 'check_index' in block:
                old_indices[(procedure['id'], block['id'])] = block.get('check_index', index)
                index += block['type'] == 'action'

    entries = []
    section = ''
    for level, title, first, dest in toc:
        if level == 1:
            section = re.sub(r'^NNC\.\d+-', '', title)
        if level > 1 and (23 <= first <= 272 or first in (428, 430)) and title.lower() != 'table of contents':
            entries.append(dict(title=title, first=first, top=pdf[first-1].rect.height-dest['to'].y,
                                section=section, id=old_ids.get((first, slug(title)), f'{slug(title)}-{first}')))
    chapter_starts = {r[2] for r in toc if r[0] == 1}
    procedures = []
    for i, entry in enumerate(entries):
        first = entry['first']
        following = entries[i+1] if i+1 < len(entries) else None
        end_page = following['first'] if following else len(pdf)+1
        chapter = min((n for n in chapter_starts if n > first), default=len(pdf)+1)
        if chapter <= end_page:
            end_page, end_top = chapter, 0
        else:
            end_top = following['top'] - 20 if following and end_page == first else 0
            if following and end_page != first:
                # Include a shared continuation page only when another procedure starts lower down.
                end_top = following['top'] - 20 if following['top'] > 130 else 0
        blocks = []
        used_pages = []
        for n in range(first, min(end_page, len(pdf)) + 1):
            if n == end_page and end_top <= 0:
                break
            content = [line for line in lines(pdf[n-1])
                       if (n != first or line['y'] >= entry['top'] - 8)
                       and (n != end_page or line['y'] < end_top)]
            # Skip title/annunciator artwork before the first condition.
            if n == first:
                start = next((j for j,l in enumerate(content) if 'Condition:' in l['text']), 0)
                content = content[start:]
            if not content:
                continue
            used_pages.append(n)
            base = 45 if int(round(pdf[n-1].rect.width)) > 400 and n % 2 else 27
            # Step numbers align at either 27 or 45 points, depending on page margins.
            numbered = [l['x'] for l in content if re.match(r'^\d{1,3}(?:\s|$)', l['text']) and l['x'] <= 46]
            if numbered:
                base = min(numbered)
            current = None
            last_y = -100
            annotations = pdf[n-1].get_links()
            for line in content:
                text = line['text']
                match = re.match(r'^(\d{1,3})(?:\s+(.*)|$)', text) if line['x'] <= base+2 else None
                number = int(match[1]) if match else None
                if match:
                    text = match[2] or ''
                new = current is None or match or line['y'] - last_y > 17 or bool(re.fullmatch(r'[■\s]+', text))
                if new:
                    current = dict(id=f'b{len(blocks)}', text=text, number=number,
                                   source_pdf_page=n, x=round(line['x']-base), links=[])
                    blocks.append(current)
                else:
                    current['text'] += ' ' + text
                last_y = line['y']
                for link in annotations:
                    rect = link['from']
                    if rect.y0 <= line['bottom']+2 and rect.y1 >= line['y']-2 and 'page' in link:
                        dest_page = link['page']+1
                        if not (first <= dest_page <= (used_pages[-1] if used_pages else first)):
                            current['links'].append({'page': dest_page, 'y': pdf[dest_page-1].rect.height-link['to'].y})
            for b in blocks:
                t = b['text']
                if b.get('type'):
                    continue
                if re.fullmatch(r'[■\s]+', t): b['type'] = 'end'; b['text'] = 'Checklist complete for this branch'
                elif re.fullmatch(r'[-\s]+', t): b['type'] = 'divider'; b['text'] = 'Continue below'
                elif re.match(r'^(Note:|Caution!|WARNING|Warning)', t): b['type'] = 'note'
                elif 'Condition:' in t or t.startswith('Objective:'): b['type'] = 'context'
                elif '►' in t or re.search(r'Go to (?:the |step )', t): b['type'] = 'jump'
                elif t.endswith(':') or t in ['Deferred Items', 'Descent Checklist', 'Approach Checklist', 'Landing Checklist', 'Below 5000 feet', 'At Pattern Altitude', 'After Impact Procedure Review']: b['type'] = 'branch'
                else: b['type'] = 'action'
                b['text'] = re.sub(r'(?:\s*\.\s*){3,}', ' — ', b['text']).strip()
        procedures.append(dict(id=entry['id'], title=entry['title'], section=entry['section'],
                               source_pages=used_pages, condition=' '.join(b['text'] for b in blocks if b['type']=='context'),
                               blocks=blocks, verification_status='requires_manual_review'))
    unresolved = []
    for p in procedures:
        for b in p['blocks']:
            targets = []
            if b['type'] in ('end', 'context', 'divider', 'note', 'branch'):
                b['links'] = []
            for number in re.findall(r'Go to step\s+(\d+)', b['text'], re.I):
                target = next((x for x in p['blocks'] if x['number']==int(number)), None)
                if target:
                    targets.append({'label':f'Go to step {number}', 'checklist':p['id'], 'block':target['id']})
                else:
                    unresolved.append({'procedure':p['id'], 'text':b['text'], 'reason':'missing step'})
            below = re.search(r'Go to (.+?) below', b['text'])
            if below:
                target = next((x for x in p['blocks'] if x is not b and slug(x['text']) == slug(below[1])), None)
                if target:
                    targets.append({'label': f'Go to {below[1]}', 'checklist': p['id'], 'block': target['id']})
            if not targets:
                for dest in b['links']:
                    candidates = [e for e in entries if e['first'] == dest['page']]
                    if candidates:
                        target = min(candidates, key=lambda e: abs(e['top']-dest['y']))
                        if target['id'] != p['id']:
                            targets.append({'label':f'Open {target["title"]}', 'checklist':target['id']})
            b['links'] = list({json.dumps(t,sort_keys=True): t for t in targets}.values())
            if 'Go to' in b['text'] and not b['links']:
                unresolved.append({'procedure':p['id'], 'text':b['text'], 'reason':'unresolved reference'})
            b['indent'] = max(0, min(4, round(b.pop('x', 0) / 18)))
    for procedure in procedures:
        next_index = max((index for (pid, bid), index in old_indices.items() if pid == procedure['id']), default=-1) + 1
        for block in procedure['blocks']:
            if block['type'] == 'action':
                key = (procedure['id'], block['id'])
                block['check_index'] = old_indices.get(key, next_index)
                if key not in old_indices:
                    next_index += 1
        classify_notes(procedure)
    data = dict(schema_version='4.0-native-checklists' , source=previous['source'], procedures=procedures,
                verification=dict(procedure_count=len(procedures), block_count=sum(len(p['blocks']) for p in procedures),
                                  unresolved_references=unresolved, method='Position-aware PDF extraction; explicit navigation, no inferred automatic branching'))
    data['source']['sha256'] = hashlib.sha256(Path(source).read_bytes()).hexdigest()
    OUT.write_text('// Generated by tools/build_qrh.py from the source PDF.\nexport const NON_NORMAL_QRH = '+json.dumps(data,ensure_ascii=False,indent=2)+';\n')
    print(f'Built {len(procedures)} native checklists; {len(unresolved)} unresolved references.')

if __name__ == '__main__':
    build(sys.argv[1])
