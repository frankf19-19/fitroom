#!/usr/bin/env python3
"""真實瀏覽器測試量身（需要網路載入 MediaPipe）：用首頁示範的真人全身照，記錄量測結果與截圖。"""
import os, json, time
from playwright.sync_api import sync_playwright
SITE = os.environ.get('SITE_URL', 'https://frankf19-19.github.io/fitroom/')
OUT = 'qa-live'; os.makedirs(OUT, exist_ok=True)
rep = {'runs': [], 'errors': []}
CASES = [('real_f.jpg', 168, 52, 'f'), ('real_m.jpg', 178, 72, 'm')]
with sync_playwright() as pw:
  b = pw.chromium.launch(channel='chrome', args=['--enable-unsafe-swiftshader','--use-gl=angle'])
  for img, h, w, g in CASES:
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2, locale='zh-TW')
    pg = ctx.new_page(); logs = []
    pg.on('pageerror', lambda e: rep['errors'].append(str(e)[:300]))
    pg.on('console', lambda m: logs.append([m.type, m.text[:200]]))
    pg.add_init_script("try{localStorage.setItem('tryon.onb','1');localStorage.setItem('tryon.noprefetch','1')}catch(e){}")
    pg.goto(SITE + '?v=' + str(int(time.time())) + '#tryon', wait_until='load'); pg.wait_for_timeout(2500)
    pg.set_input_files('#filePerson', 'qa/' + img); pg.wait_for_timeout(2000)
    pg.evaluate("location.hash='#body'"); pg.wait_for_timeout(1500)
    # 訪客會被導去登入：直接把身形頁打開測量（量身在本機進行，不需要登入）
    try:
      pg.evaluate("document.querySelectorAll('.view').forEach(v=>v.classList.toggle('on',v.id==='view-body'))")
      pg.evaluate("document.querySelector('#pickmenu')&&document.querySelector('#pickmenu').classList.remove('on')")
    except Exception: pass
    pg.fill('#bHeight', str(h)); pg.fill('#bWeight', str(w))
    pg.evaluate(f"(()=>{{const c=document.querySelector('#bodyGender .chip[data-g=\"{g}\"]'); if(c) c.click();}})()")
    pg.evaluate("document.getElementById('btnMeasure').disabled=false")
    t0 = time.time(); pg.click('#btnMeasure')
    for _ in range(90):
      pg.wait_for_timeout(1000)
      st = pg.inner_text('#measureStatus') if pg.query_selector('#measureStatus') else ''
      card = pg.inner_text('#measureCard') if pg.query_selector('#measureCard') else ''
      if ('cm' in card and '±' in card) or ('失敗' in st or '無法' in st or '請' in st and '量' not in st): break
    m = pg.evaluate("(()=>{try{return JSON.parse(localStorage.getItem('tryon.measure'))}catch(e){return null}})()")
    rep['runs'].append({'img': img, 'height': h, 'weight': w, 'secs': round(time.time() - t0, 1), 'status': st, 'card': card[:800], 'measure': m, 'console': [l for l in logs if l[0] in ('error', 'warning')][:10]})
    pg.screenshot(path=f'{OUT}/measure_{img}.png', full_page=True)
    ctx.close()
  b.close()
json.dump(rep, open(f'{OUT}/report.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(rep, ensure_ascii=False)[:3000])
