#!/usr/bin/env python3
"""頭部還原測試：本機架站，用真瀏覽器跑 headRestore，輸出 qa-live/head_*.jpg。"""
import os, base64, json
from playwright.sync_api import sync_playwright
SITE = os.environ.get('SITE_URL', 'http://localhost:8765/index.html'); os.makedirs('qa-live', exist_ok=True)
uri = lambda f: 'data:image/jpeg;base64,' + base64.b64encode(open(f, 'rb').read()).decode()
pairs = [('qa/hr2_person.jpg', 'qa/hr2_result.jpg', 'plus'), ('qa/hr_person.jpg', 'qa/hr_result.jpg', 'demo'), ('qa/hr_person.jpg', 'qa/hr_result_shift.jpg', 'shift'), ('qa/hr_person.jpg', 'qa/hr_result_zoom.jpg', 'zoom')]
rep = {}
with sync_playwright() as pw:
  b = pw.chromium.launch(channel='chrome'); pg = b.new_page(); logs = []
  pg.on('console', lambda m: logs.append(m.text[:200])); pg.on('pageerror', lambda e: logs.append('ERR ' + str(e)[:200]))
  pg.add_init_script("try{localStorage.setItem('tryon.debug','1');localStorage.setItem('tryon.onb','1')}catch(e){}")
  pg.goto(SITE + '#tryon'); pg.wait_for_timeout(3000)
  for a, r, tag in pairs:
    out = pg.evaluate("async([a,r])=>{ try{ return await window.__tryon.headRestore(a,r); }catch(e){ return 'FAIL '+e.message; } }", [uri(a), uri(r)])
    rep[tag] = out[:60]
    if out.startswith('data:'): open(f'qa-live/head_{tag}.jpg', 'wb').write(base64.b64decode(out.split(',')[1]))
  b.close()
rep['logs'] = logs[-8:]; json.dump(rep, open('qa-live/head.json', 'w'), ensure_ascii=False, indent=1); print(rep)
