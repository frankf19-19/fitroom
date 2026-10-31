#!/usr/bin/env python3
"""UI 巡檢（不花 AI 費用）：未登入 + 登入後，手機與電腦尺寸逐頁截圖，記錄 JS 錯誤、API 錯誤、版面溢出。"""
import os, json, time, urllib.request
from playwright.sync_api import sync_playwright

URL = os.environ['SUPABASE_URL'].rstrip('/'); KEY = os.environ['SUPABASE_SERVICE_KEY']
SITE = os.environ.get('SITE_URL', 'https://frankf19-19.github.io/fitroom/').rstrip('/') + '/'
EMAIL = os.environ.get('QA_EMAIL', 'qa-bot@tryon-test.invalid')
OUT = 'qa-live'; os.makedirs(OUT, exist_ok=True)
rep = {'started': time.strftime('%Y-%m-%d %H:%M:%S'), 'pages': [], 'pageerrors': [], 'console': [], 'api': []}

def admin(method, path, data=None):
  h = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
  req = urllib.request.Request(URL + path, data=json.dumps(data).encode() if data is not None else None, headers=h, method=method)
  try:
    with urllib.request.urlopen(req, timeout=60) as r: t = r.read().decode(); return r.status, (json.loads(t) if t else None)
  except urllib.error.HTTPError as e: return e.code, e.read().decode()[:500]

OVERFLOW_JS = """() => {
  const W = document.documentElement.clientWidth, bad = [];
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (el.closest('.hscroll,.chips,.rackbar,[style*="overflow-x"],.slots,.brandchips,.tabs')) return;
    const r = el.getBoundingClientRect(); if (r.width && (r.right > W + 2 || r.left < -2)) bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' ' + Math.round(r.left) + '→' + Math.round(r.right));
  });
  const small = [];
  document.querySelectorAll('button,a,[role=button],input,select').forEach(el => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (!r.width || cs.display === 'none' || cs.visibility === 'hidden' || !el.closest('.view.on,header,nav,.tabbar,.modal.on,.sheet.on')) return;
    if (r.height < 32 || r.width < 32) small.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + (el.innerText || el.value || '').trim().slice(0, 12));
  });
  const fonts = [];
  document.querySelectorAll('.view.on *').forEach(el => { if (el.children.length) return; const t = (el.innerText||'').trim(); if (!t) return; const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 11) fonts.push(el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' ' + fs + 'px ' + t.slice(0, 10)); });
  return { scrollW: document.documentElement.scrollWidth, W, overflow: bad.slice(0, 25), small: [...new Set(small)].slice(0, 40), tinyFont: [...new Set(fonts)].slice(0, 20) };
}"""

def tour(pg, tag, views):
  for v in views:
    try:
      pg.evaluate(f"location.hash='#{v}'"); pg.wait_for_timeout(3500 if v in ('shop', 'history', 'admin', 'wardrobe') else 1500)
      info = pg.evaluate(OVERFLOW_JS)
      info['view'] = f'{tag}_{v}'; info['text'] = (pg.inner_text('.view.on') or '')[:1500]
      rep['pages'].append(info)
      pg.screenshot(path=f'{OUT}/{tag}_{v}.png', full_page=True)
    except Exception as e: rep['pages'].append({'view': f'{tag}_{v}', 'err': str(e)[:300]})

with sync_playwright() as pw:
  b = pw.chromium.launch(channel='chrome')
  def mkpage(phone):
    ctx = b.new_context(viewport={'width': 390, 'height': 844} if phone else {'width': 1366, 'height': 900}, is_mobile=phone, has_touch=phone, device_scale_factor=2 if phone else 1, locale='zh-TW')
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: rep['pageerrors'].append(str(e)[:300]))
    pg.on('console', lambda m: rep['console'].append([m.type, m.text[:300]]) if m.type in ('error', 'warning') else None)
    def on_resp(r):
      try:
        if '/api/' in r.url and r.status >= 400: rep['api'].append({'url': r.url.split('workers.dev')[-1][:80], 'status': r.status, 'body': r.text()[:200]})
      except Exception: pass
    pg.on('response', on_resp)
    return pg
  # 未登入（含新手導覽）
  for phone in (True, False):
    tag = 'guest_' + ('phone' if phone else 'pc')
    pg = mkpage(phone); pg.goto(SITE + '?v=' + str(int(time.time())), wait_until='load'); pg.wait_for_timeout(3500)
    pg.screenshot(path=f'{OUT}/{tag}_00_first.png')
    try: pg.click('#onbSkip', timeout=2500); pg.wait_for_timeout(800)
    except Exception: pass
    tour(pg, tag, ['home', 'tryon', 'shop', 'me'])
    try: pg.click('#userArea button, #userArea a, #userArea'); pg.wait_for_timeout(1000); pg.screenshot(path=f'{OUT}/{tag}_login.png')
    except Exception as e: print('login', e)
    pg.context.close()
  # 登入
  st, users = admin('GET', '/auth/v1/admin/users?page=1&per_page=200')
  st, link = admin('POST', '/auth/v1/admin/generate_link', {'type': 'magiclink', 'email': EMAIL, 'options': {'redirect_to': SITE}})
  for phone in (True, False):
    st, link = admin('POST', '/auth/v1/admin/generate_link', {'type': 'magiclink', 'email': EMAIL, 'options': {'redirect_to': SITE}})
    tag = 'user_' + ('phone' if phone else 'pc')
    pg = mkpage(phone); pg.add_init_script("try{localStorage.setItem('tryon.onb','1');localStorage.setItem('tryon.noprefetch','1')}catch(e){}")
    pg.goto(link['action_link'], wait_until='load'); pg.wait_for_timeout(5000)
    tour(pg, tag, ['home', 'tryon', 'shop', 'wardrobe', 'history', 'me', 'credits', 'body', 'settings', 'admin'])
    # 試衣間：放照片 + 從商店放兩件（不按生成）
    try:
      pg.evaluate("location.hash='#tryon'"); pg.wait_for_timeout(800)
      pg.set_input_files('#filePerson', 'qa/person.jpg'); pg.wait_for_timeout(2500)
      pg.evaluate("location.hash='#shop'"); pg.wait_for_timeout(4000)
      btns = pg.query_selector_all('#view-shop [data-try]')
      if btns: btns[0].click(); pg.wait_for_timeout(2500)
      pg.screenshot(path=f'{OUT}/{tag}_tryon_filled.png', full_page=True)
      pg.evaluate("location.hash='#shop'"); pg.wait_for_timeout(1500)
      rr = pg.query_selector_all('#view-shop [data-rack]')
      for x in rr[1:4]: x.click(); pg.wait_for_timeout(300)
      pg.evaluate("location.hash='#tryon'"); pg.wait_for_timeout(1500)
      pg.screenshot(path=f'{OUT}/{tag}_tryon_rack.png', full_page=True)
      it = pg.query_selector('.pitem .img img')
    except Exception as e:
      dbg = pg.evaluate("(()=>{const v=document.querySelector('.view.on');const b=document.querySelector('#view-shop [data-try]');return [v&&v.id, location.hash, b?getComputedStyle(b).display+' '+b.getBoundingClientRect().width+'x'+b.getBoundingClientRect().height:'none', document.querySelectorAll('#view-shop [data-try]').length].join(' | ')})()")
      rep['pages'].append({'view': tag + '_flow', 'err': str(e)[:300], 'dbg': dbg}); pg.screenshot(path=f'{OUT}/{tag}_flow_err.png')
    pg.context.close()
  b.close()
json.dump(rep, open(f'{OUT}/report.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps({k: (v if k != 'pages' else len(v)) for k, v in rep.items()}, ensure_ascii=False)[:3000])
