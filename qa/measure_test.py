#!/usr/bin/env python3
"""真實瀏覽器測試量身（需要網路載入 MediaPipe）：qa/measure_cases.json 裡每張全身照都量一次，
和合理範圍比對（PASS／WARN），並輸出除錯資料（原始關節點＋遮罩 pose_*.json、量測過程 dbg_*.json）與檢查圖 overlay_*.png。"""
import os, sys, json, time, shutil, urllib.request
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from measure_overlay import render

SITE = os.environ.get('SITE_URL', 'http://localhost:8765/index.html')
OUT = 'qa-live'; os.makedirs(OUT, exist_ok=True)
CASES = json.load(open('qa/measure_cases.json', encoding='utf-8'))['cases']
ONLY = os.environ.get('ONLY', '')
if ONLY: CASES = [c for c in CASES if c['img'] in ONLY.split(',')]
rep = {'site': SITE, 'runs': [], 'errors': []}

def fetch(c):
    p = 'qa/' + c['img']
    if not os.path.exists(p) and c.get('src'):
        req = urllib.request.Request(c['src'], headers={'User-Agent': 'Mozilla/5.0 (fitroom qa)'})
        with urllib.request.urlopen(req, timeout=60) as r, open(p, 'wb') as f: f.write(r.read())
    return p if os.path.exists(p) else None

with sync_playwright() as pw:
    b = pw.chromium.launch(channel='chrome', args=['--enable-unsafe-swiftshader', '--use-gl=angle'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2, locale='zh-TW')
    pg = ctx.new_page(); logs = []
    pg.on('pageerror', lambda e: rep['errors'].append(str(e)[:300]))
    pg.on('console', lambda m: logs.append([m.type, m.text[:200]]))
    pg.add_init_script("try{localStorage.setItem('tryon.onb','1');localStorage.setItem('tryon.noprefetch','1');localStorage.setItem('tryon.debug','1')}catch(e){}")
    pg.goto(SITE + '?v=' + str(int(time.time())) + '#tryon', wait_until='load'); pg.wait_for_timeout(2500)
    for c in CASES:
        img = c['img']; run = {'img': img, 'height': c['height'], 'weight': c['weight'], 'g': c['g'], 'note': c.get('note', ''), 'credit': c.get('credit', '')}
        rep['runs'].append(run)
        try:
            path = fetch(c)
        except Exception as e:
            run['status'] = 'download failed: ' + str(e)[:200]; continue
        if not path: run['status'] = 'missing image'; continue
        shutil.copy(path, f'{OUT}/{img}')
        logs.clear(); t0 = time.time()
        pg.set_input_files('#filePerson', path); pg.wait_for_timeout(1500)
        pg.evaluate("location.hash='#body'"); pg.wait_for_timeout(800)
        # 訪客會被導去登入：直接把身形頁打開測量（量身在本機進行，不需要登入）
        try:
            pg.evaluate("document.querySelectorAll('.view').forEach(v=>v.classList.toggle('on',v.id==='view-body'))")
            pg.evaluate("document.querySelector('#pickmenu')&&document.querySelector('#pickmenu').classList.remove('on')")
        except Exception: pass
        pg.fill('#bHeight', str(c['height'])); pg.fill('#bWeight', str(c['weight']))
        pg.evaluate(f"(()=>{{const c=document.querySelector('#bodyGender .chip[data-g=\"{c['g']}\"]'); if(c) c.click();}})()")
        pg.evaluate("(()=>{try{localStorage.removeItem('tryon.measure')}catch(e){} const t=window.__tryon; if(t){ t.resetMeasureCache&&t.resetMeasureCache(); t.lastPose=null; t.lastMeasure=null; } document.getElementById('measureStatus').textContent=''; document.getElementById('btnMeasure').disabled=false; })()")
        pg.click('#btnMeasure'); st = ''
        for _ in range(150):
            pg.wait_for_timeout(1000)
            st = pg.inner_text('#measureStatus')
            busy = pg.evaluate("document.getElementById('btnMeasure').disabled")
            if st and not busy and not st.startswith('正在') and not st.startswith('準備'): break
        m = pg.evaluate("(()=>{try{return JSON.parse(localStorage.getItem('tryon.measure'))}catch(e){return null}})()")
        pose = pg.evaluate("window.__tryon&&window.__tryon.lastPose")
        dbg = pg.evaluate("window.__tryon&&window.__tryon.lastMeasure")
        stem = img.rsplit('.', 1)[0]
        if pose: json.dump(pose, open(f'{OUT}/pose_{stem}.json', 'w'))
        if dbg: json.dump(dbg, open(f'{OUT}/dbg_{stem}.json', 'w'), ensure_ascii=False, indent=1)
        try:
            if pose: render(path, pose, dbg, f'{OUT}/overlay_{stem}.png')
        except Exception as e: run['overlay_err'] = str(e)[:200]
        vals = (m or {}).get('vals') if (m or {}).get('src') == 'photo' else None
        res = {}
        for k, rg in (c.get('targets') or {}).items():
            v = (vals or {}).get(k)
            res[k] = {'got': v, 'target': rg, 'ok': ('PASS' if v is not None and rg[0] - 1 <= v <= rg[1] + 1 else 'WARN')}
        run.update({'secs': round(time.time() - t0, 1), 'status': st, 'vals': vals, 'unc': (m or {}).get('unc'), 'flags': (m or {}).get('flags'), 'meta': (m or {}).get('meta'), 'check': res,
                    'console': [l for l in logs if l[0] in ('error', 'warning')][:10]})
        pg.screenshot(path=f'{OUT}/measure_{stem}.png', full_page=True)
    ctx.close(); b.close()
json.dump(rep, open(f'{OUT}/report.json', 'w'), ensure_ascii=False, indent=1)
for r in rep['runs']:
    ck = r.get('check') or {}
    print(r['img'], r.get('status', '')[:60], ' '.join(f"{k}:{v['got']}[{v['target'][0]}-{v['target'][1]}]{'' if v['ok']=='PASS' else '!'}" for k, v in ck.items()) or r.get('vals'))
if rep['errors']: print('page errors:', rep['errors'][:5])
