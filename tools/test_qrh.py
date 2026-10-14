#!/usr/bin/env python3
"""Validate native QRH data and, on macOS, checklist rendering/navigation."""
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
source = (ROOT / 'js/data/non-normal.js').read_text()
data = json.loads(source.split('export const NON_NORMAL_QRH = ', 1)[1].rstrip(';\n'))
procedures = {p['id']: p for p in data['procedures']}
assert len(procedures) == len(data['procedures']) == 147
assert not data['verification']['unresolved_references']
link_count = 0
for p in procedures.values():
    assert p['blocks'] and p['source_pages']
    numbers = [b['number'] for b in p['blocks'] if b['number'] is not None]
    assert len(numbers) == len(set(numbers)), p['id']
    assert set(numbers) == set(range(1, max(numbers, default=0) + 1)), p['id']
    for block in p['blocks']:
        assert block['source_pdf_page'] in p['source_pages']
        for link in block['links']:
            target = procedures[link['checklist']]
            if link.get('block'):
                assert any(b['id'] == link['block'] for b in target['blocks'])
            link_count += 1
bomb = procedures['suspicious-article-bomb-procedure-26']
assert [b['number'] for b in bomb['blocks'] if b['number']] == list(range(1, 20))
assert procedures['elt-36']['blocks'][-1]['type'] == 'end'
assert procedures['cabin-altitude-warning-or-rapid-depressurization-51']['source_pages'] == [51, 52]
print(f'PASS: 147 checklists; contiguous source step numbers; {link_count} valid navigation links.')

if not shutil.which('swift'):
    print('SKIP: JavaScriptCore interaction checks require macOS Swift.')
    raise SystemExit(0)
parts = ['''const state={checks:{}}; let saved=''; let renders=0;
const save=()=>{saved=JSON.stringify(state.checks)};const rerender=()=>{renders++};
const icon=()=>''; const esc=s=>String(s??'').replaceAll('<','&lt;');
const location={hash:''}; let focused='';
const document={getElementById:id=>({scrollIntoView(){focused=id},focus(){}})};
''']
for filename in ['js/data/non-normal.js', 'js/data/checklists.js', 'js/views/checklists.js']:
    code = (ROOT / filename).read_text()
    code = re.sub(r'^import .*;\n', '', code, flags=re.M)
    code = re.sub(r'^export \{.*\};\n', '', code, flags=re.M)
    parts.append(code.replace('export ', ''))
parts.append('''
function assert(ok,msg){if(!ok)throw Error(msg)}
for(const cl of NON_NORMAL_CHECKLISTS){
 const html=render([cl.id]); assert(!html.includes('<img'),'no PDF images');
 assert((html.match(/data-act="toggle"/g)||[]).length===cl.items.length,'checkable actions');
 for(const block of cl.blocks) assert(html.includes(`id="qrh-${block.id}"`),'block anchors');
}
const fire=NON_NORMAL_CHECKLISTS.find(c=>c.name==='Engine Fire on the Ground');
location.hash=`#/checklists/${fire.id}`;
actions.toggle({dataset:{i:'0',block:'b1'}});
assert(state.checks[fire.id][0] && JSON.parse(saved)[fire.id][0],'saved check mark');
assert(render([fire.id]).includes('aria-pressed="true"'),'checked rendering');
const local=fire.blocks.flatMap(b=>b.links).find(l=>l.block);
actions.follow({dataset:{checklist:fire.id,block:local.block,from:'b0'}});
assert(focused===`qrh-${local.block}`,'local step jump');
const cross=fire.blocks.flatMap(b=>b.links).find(l=>l.checklist==='evacuation-430');
actions.follow({dataset:{checklist:`qrh-${cross.checklist}`,block:'',from:'b10'}});
assert(location.hash==='#/checklists/qrh-evacuation-430','cross checklist navigation');
assert(render(['qrh-evacuation-430']).includes('Return to Engine Fire on the Ground'),'return control');
actions.returnChecklist(); assert(location.hash===`#/checklists/${fire.id}/b10`,'return position');
assert(state.checks[fire.id][0],'progress preserved across navigation');
actions.finishBranch(); assert(JSON.parse(saved)[fire.id].branchComplete,'branch completion persisted');
actions.toggle({dataset:{i:'0',block:'b1'}});assert(!state.checks[fire.id].branchComplete,'changing actions clears completion');
actions.reset(); assert(!state.checks[fire.id],'reset checklist');
assert(nextIncomplete().id==='preflight','normal resume');
state.checks.preflight=Array(7).fill(true);
assert(render(['preflight']).includes('PREFLIGHT CHECKLIST COMPLETE'),'normal completion');
assert(nextIncomplete().id==='before-start','normal resume advances');
'PASS: all native renders; check-off persistence; step jumps; cross checklist return; branch completion; resets; normal checklist regression.';
''')
with tempfile.TemporaryDirectory(prefix='qfa100-qrh-test-') as tmp:
    script = Path(tmp) / 'test.swift'
    script.write_text('import JavaScriptCore\nlet context = JSContext()!\ncontext.exceptionHandler = { _, error in print("FAIL: \\(error!)"); exit(1) }\nprint(context.evaluateScript(' + json.dumps('\n'.join(parts), ensure_ascii=False) + ')!.toString()!)\n')
    subprocess.run(['swift', '-module-cache-path', '/tmp/qfa100-swift-cache', str(script)], check=True)
