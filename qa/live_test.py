#!/usr/bin/env python3
"""對正式站做端到端測試（在 GitHub Actions 跑）：用測試帳號登入 → 走完主要流程 → 截圖與紀錄寫到 qa-live/。
環境變數：SUPABASE_URL、SUPABASE_SERVICE_KEY、SITE_URL
"""
import os, json, time, urllib.request, urllib.parse, traceback
from playwright.sync_api import sync_playwright

URL = os.environ['SUPABASE_URL'].rstrip('/'); KEY = os.environ['SUPABASE_SERVICE_KEY']
SITE = os.environ.get('SITE_URL', 'https://frankf19-19.github.io/fitroom/').rstrip('/') + '/'
EMAIL = os.environ.get('QA_EMAIL', 'qa-bot@tryon-test.invalid')
OUT = 'qa-live'; os.makedirs(OUT, exist_ok=True)
rep = {'started': time.strftime('%Y-%m-%d %H:%M:%S'), 'steps': [], 'pageerrors': [], 'console': [], 'api': []}
def step(name, ok, info=''): rep['steps'].append({'name': name, 'ok': bool(ok), 'info': str(info)[:600]}); print(('OK ' if ok else 'FAIL'), name, str(info)[:300])

def admin(method, path, data=None):
  h = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
  req = urllib.request.Request(URL + path, data=json.dumps(data).encode() if data is not None else None, headers=h, method=method)
  try:
    with urllib.request.urlopen(req, timeout=60) as r: t = r.read().decode(); return r.status, (json.loads(t) if t else None)
  except urllib.error.HTTPError as e: return e.code, e.read().decode()[:500]

# 1. 測試帳號 + 登入連結
st, users = admin('GET', '/auth/v1/admin/users?page=1&per_page=200')
uid = next((u['id'] for u in (users or {}).get('users', []) if u.get('email') == EMAIL), None) if st == 200 else None
if not uid:
  st, u = admin('POST', '/auth/v1/admin/users', {'email': EMAIL, 'email_confirm': True}); uid = (u or {}).get('id'); step('建立測試帳號', bool(uid), u)
else: step('測試帳號已存在', True, uid)
# 給點數（測 360°）
admin('PATCH', f'/rest/v1/profiles?id=eq.{uid}', {'credits': 20})
st, link = admin('POST', '/auth/v1/admin/generate_link', {'type': 'magiclink', 'email': EMAIL, 'options': {'redirect_to': SITE}})
action_link = (link or {}).get('action_link') if isinstance(link, dict) else None
step('產生登入連結', bool(action_link), link if not action_link else 'ok')

with sync_playwright() as pw:
  b = pw.chromium.launch(channel='chrome')
  ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2, locale='zh-TW')
  pg = ctx.new_page()
  pg.on('pageerror', lambda e: rep['pageerrors'].append(str(e)))
  pg.on('console', lambda m: rep['console'].append([m.type, m.text[:300]]) if m.type in ('error', 'warning') else None)
  def on_resp(r):
    try:
      if '/api/' in r.url and 'workers.dev' in r.url: rep['api'].append({'url': r.url.split('workers.dev')[1][:80], 'status': r.status, 'body': (r.text()[:300] if r.status >= 400 else '')})
    except Exception: pass
  pg.on('response', on_resp)
  shot = lambda n: pg.screenshot(path=f'{OUT}/{n}.png', full_page=True)
  def txt(sel):
    try: return pg.inner_text(sel, timeout=3000)
    except Exception: return None
  try:
    # 2. 登入
    pg.goto(action_link, wait_until='load'); pg.wait_for_timeout(4000)
    try: pg.click('#onbSkip', timeout=3000)
    except Exception: pass
    pg.wait_for_timeout(1500)
    ua = txt('#userArea'); step('登入後右上顯示點數', ua and '點' in ua and '–' not in ua, f'url={pg.url} userArea={ua}'); shot('01_home_after_login')
    # 3. 試衣間：上傳全身照
    pg.goto(SITE + '#tryon'); pg.wait_for_timeout(1500)
    pg.set_input_files('#filePerson', os.environ.get('QA_PERSON', 'demo/m-before.jpg')); pg.wait_for_timeout(2500)
    step('上傳全身照', 'has' in (pg.get_attribute('#personBox', 'class') or ''), pg.get_attribute('#personBox', 'class')); shot('02_tryon_person')
    # 4. 商店：放入第一件上衣
    pg.goto(SITE + '#shop'); pg.wait_for_timeout(3500)
    n = pg.locator('[data-try]').count(); step('商店載入商品', n > 0, f'{n} 件'); shot('03_shop')
    pg.click('#shopGender [data-g="m"]'); pg.wait_for_timeout(1500)
    pg.fill('#shopQ', os.environ.get('QA_TOP', 'PUFFTECH')); pg.press('#shopQ', 'Enter'); pg.wait_for_timeout(3000)
    n = pg.locator('[data-try]').count()
    if n:
      pg.locator('[data-try]').first.click(); pg.wait_for_timeout(3000)
      slots = pg.evaluate("[...document.querySelectorAll('.slot.has')].map(e=>e.dataset.type)")
      cur = pg.evaluate("document.querySelector('.view.on')?.id")
      step('商店商品放進試衣間', len(slots) > 0, f'slots={slots} view={cur}')
      # 再放一件褲子（重現「上衣＋褲子」兩步合成）
      pg.goto(SITE + '#shop'); pg.wait_for_timeout(2000)
      pg.fill('#shopQ', os.environ.get('QA_BOTTOM', '繭型褲')); pg.press('#shopQ', 'Enter'); pg.wait_for_timeout(3000)
      if pg.locator('[data-try]').count():
        pg.locator('[data-try]').first.click(); pg.wait_for_timeout(3000)
      slots = pg.evaluate("[...document.querySelectorAll('.slot.has')].map(e=>e.dataset.type)")
      step('再放入褲子', 'bottom' in slots, f'slots={slots}')
    # 衣架多選
    pg.goto(SITE + '#shop'); pg.wait_for_timeout(1500); pg.fill('#shopQ', ''); pg.wait_for_timeout(2500)
    rb = pg.locator('[data-rack]'); nrb = rb.count()
    for k in range(min(3, nrb)): rb.nth(k).click(); pg.wait_for_timeout(200)
    bar = txt('#rackBar')
    pg.goto(SITE + '#tryon'); pg.wait_for_timeout(1500)
    nrk = pg.locator('#rackBox .rk').count()
    step('衣架多選＋試衣間一點換穿', nrk >= 3 and bar is not None, f'bar={bar} rack={nrk}'); shot('03b_rack')
    pg.evaluate("localStorage.removeItem('tryon.rack')")
    # 5. 尺寸建議
    pg.fill('#fBust', '86'); pg.fill('#fWaist', '68'); pg.fill('#fHip', '92'); pg.wait_for_timeout(300)
    fr = txt('#fitRows'); step('尺寸建議有內容', fr and '建議' in fr, fr); shot('04_fit')
    pg.wait_for_timeout(int(os.environ.get('QA_THINK', '20000')))   # 模擬使用者看尺寸的時間
    step('預先合成提示', bool(txt('#pfHint')), txt('#pfHint'))
    # 6. AI 試穿（真的呼叫 fal）
    pg.evaluate("localStorage.setItem('tryon.nocache','1')")
    if os.environ.get('QA_RES'): pg.evaluate(f"localStorage.setItem('tryon.res','{os.environ['QA_RES']}')")
    if os.environ.get('QA_ENGINE'): pg.evaluate(f"localStorage.setItem('tryon.engine','{os.environ['QA_ENGINE']}')")
    if os.environ.get('QA_VIEWS') == '0': pass
    elif 'on' not in (pg.get_attribute('#wantViews','class') or ''): pg.click('#wantViews')
    if False: pg.click('#wantViews') if 'on' not in (pg.get_attribute('#wantViews','class') or '') else None
    pg.wait_for_timeout(300)
    cost = txt('#costN'); pg.click('#btnRun'); t0 = time.time(); done = False; statuses = []
    while time.time() - t0 < 300:
      pg.wait_for_timeout(3000)
      if pg.locator('#result img').count() > 0: done = True; break
      rs = txt('#runStatus') or ''
      if not statuses or statuses[-1] != rs: statuses.append(rs)
      if any(k in rs for k in ('失敗', '錯誤', '不足', '逾時')): break
    if done:
      try:
        import base64
        imgs = pg.evaluate("[document.getElementById('cmpAfterFull')?.src, ...[...document.querySelectorAll('#usedItems .ui-it img')].map(i=>i.src), document.querySelector('#cmpAfter img')?.src]")
        for k, src in enumerate(imgs):
          if src and src.startswith('data:'):
            open(f'{OUT}/img_{k}.jpg', 'wb').write(base64.b64decode(src.split(',', 1)[1]))
          elif src and src.startswith('http'):
            urllib.request.urlretrieve(src, f'{OUT}/img_{k}.jpg')
      except Exception as e: print('save imgs', e)
      ui = pg.locator('#usedItems .ui-it').count()
      if ui: pg.locator('#usedItems .ui-it').first.click(); pg.wait_for_timeout(800)
      step('結果下方可點開選過的單品', ui > 0 and pg.locator('#itemView.on').count() > 0, f'items={ui}'); shot('05b_itemview')
      try: pg.click('#ivClose', timeout=2000)
      except Exception: pass
      t1 = time.time(); vok = False
      while time.time() - t1 < 300:
        pg.wait_for_timeout(3000)
        rs = txt('#runStatus') or ''
        if '360° 好了' in rs or '360° 完成' in rs: vok = True; break
        if '載入失敗' in rs: break
        if '失敗' in rs: break
      spin_ok = False
      if vok:
        try:
          if '循環播放' in (txt('#runStatus') or ''): raise Exception('plain')
          box = pg.locator('.spinbox.on'); bb = box.bounding_box()
          before = 0
          pg.wait_for_timeout(7000)   # 讓影片播完第一圈、抓完格
          pg.mouse.move(bb['x']+bb['width']*0.7, bb['y']+bb['height']/2); pg.mouse.down(); pg.mouse.move(bb['x']+bb['width']*0.3, bb['y']+bb['height']/2, steps=8); pg.mouse.up(); pg.wait_for_timeout(600)
          after = pg.evaluate("(()=>{ const c=document.querySelector('.spinbox canvas'); return c&&!c.hidden ? c.toDataURL().length : -1; })()")
          shot('05e_spin_drag')
          spin_ok = after > 1000
          frames = pg.evaluate("document.querySelectorAll('.spinbox').length")
          for k, frac in enumerate([0, 0.25, 0.5, 0.75]):
            pg.evaluate(f"(()=>{{}})()")
        except Exception as e: print('spin', e)
      step('360° 背景補圖', vok, f'再等 {int(time.time()-t1)}s：{txt("#runStatus")}'); shot('05c_views')
      plain = '循環播放' in (txt('#runStatus') or '')
      step('360° 可拖曳旋轉' + ('（測試瀏覽器無 H.264，改測循環播放）' if plain else ''), spin_ok or plain, '')
      # 試衣間格子可點開大圖
      pg.evaluate("document.querySelector('#slots .slot.has')?.click()"); pg.wait_for_timeout(600)
      step('試衣間格子可點開大圖', pg.locator('#itemView.on').count() > 0, ''); shot('05d_slotview')
      pg.evaluate("document.getElementById('itemView')?.classList.remove('on')")
    timing = pg.evaluate('window.__lastTiming')
    step('AI 試穿出結果', done, f'timing={timing} cost={cost} 耗時 {int(time.time()-t0)}s runStatus={txt("#runStatus")} statuses={statuses[-6:]}'); shot('05_result')
    # 7. 身形分析
    pg.goto(SITE + '#body'); pg.wait_for_timeout(1200)
    pg.fill('#bHeight', '162'); pg.fill('#bWeight', '52'); pg.click('#btnAnalyze')
    t0 = time.time(); ok = False
    while time.time() - t0 < 60:
      pg.wait_for_timeout(2000); s = txt('#analyzeStatus') or ''
      if '完成' in s: ok = True; break
      if s and ('失敗' in s or '錯誤' in s or '尚未' in s): break
    step('身形分析', ok, f'{txt("#analyzeStatus")} report_len={len(txt("#bodyReport") or "")}'); shot('06_body')
    # 8. 搭配建議
    pg.goto(SITE + '#tryon'); pg.wait_for_timeout(1200); pg.click('#btnOutfit')
    t0 = time.time(); ok = False
    while time.time() - t0 < 60:
      pg.wait_for_timeout(2000)
      if pg.locator('#outfitBox .outfit').count() > 0: ok = True; break
      s = txt('#outfitStatus') or ''
      if s and ('失敗' in s or '錯誤' in s or '尚未' in s or '找不到' in s): break
    step('AI 搭配建議', ok, f'{txt("#outfitStatus")} outfits={pg.locator("#outfitBox .outfit").count()}'); shot('07_outfit')
    # 9. 其他頁面
    for v in ['wardrobe', 'history', 'credits', 'settings', 'admin']:
      pg.goto(SITE + '#' + v); pg.wait_for_timeout(2000); shot(f'08_{v}')
      step(f'頁面 #{v}', pg.evaluate("document.querySelector('.view.on')?.id") == 'view-' + v, pg.evaluate("document.querySelector('.view.on')?.id"))
    # 10. 登出
    pg.click('#btnLogout', timeout=5000); pg.wait_for_timeout(500)
    try: pg.click('#dlgOk', timeout=3000)
    except Exception: pass
    pg.wait_for_timeout(2500); ua = txt('#userArea'); step('登出', ua is None or '登入' in ua or '–' in ua, ua); shot('09_logged_out')
  except Exception as e:
    step('例外', False, traceback.format_exc()[-800:]); shot('99_exception')
  b.close()
rep['finished'] = time.strftime('%Y-%m-%d %H:%M:%S')
json.dump(rep, open(f'{OUT}/report.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps({k: rep[k] for k in ('pageerrors', 'console', 'api')}, ensure_ascii=False)[:4000])
