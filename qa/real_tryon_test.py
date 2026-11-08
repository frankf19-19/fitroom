#!/usr/bin/env python3
"""真實生圖測試（會花 AI 費用）：建立臨時帳號 → 走「預先合成 → 按下認領」路徑 → 存結果圖與品質檢查 → 刪帳號。
PRODUCTS=逗號分隔商品 id（預設 60：軍綠寬褲，模特兒外面套黑色外套），PERSON=人物照路徑。"""
import os, io, json, time, base64, secrets, urllib.request, re
from PIL import Image
URL = os.environ['SUPABASE_URL']; KEY = os.environ['SUPABASE_SERVICE_KEY']; API = 'https://tryon-api.frankccc199.workers.dev'
UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'
ANON = re.search(r"SUPABASE_ANON_KEY:\s*'([^']+)'", open('index.html').read()).group(1)
A = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}
os.makedirs('out', exist_ok=True)
def call(method, url, data=None, h=None, raw=False, timeout=120):
  r = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers={'Content-Type': 'application/json', **({'User-Agent': UA} if url.startswith(API) else {}), **(h or {})}, method=method)
  try:
    with urllib.request.urlopen(r, timeout=timeout) as x: b = x.read(); return x.status, (b if raw else (json.loads(b) if b else None))
  except urllib.error.HTTPError as e: return e.code, e.read().decode()[:400]
def jpeg_uri(b, maxw=1200):
  im = Image.open(io.BytesIO(b)).convert('RGB'); im.thumbnail((maxw, maxw * 2)); o = io.BytesIO(); im.save(o, 'JPEG', quality=88)
  return 'data:image/jpeg;base64,' + base64.b64encode(o.getvalue()).decode()
pids = [x.strip() for x in os.environ.get('PRODUCTS', '60').split(',') if x.strip()]
person = jpeg_uri(open(os.environ.get('PERSON', 'demo/f-before.webp'), 'rb').read())
email = f'realtest-{int(time.time())}@tryon-test.invalid'; pw = secrets.token_urlsafe(16)
s, u = call('POST', URL + '/auth/v1/admin/users', {'email': email, 'password': pw, 'email_confirm': True}, A)
if not isinstance(u, dict): raise SystemExit(f'建立帳號失敗 {s} {u}')
uid = u['id']
rep = {}
try:
  s, tok = call('POST', URL + '/auth/v1/token?grant_type=password', {'email': email, 'password': pw}, {'apikey': ANON})
  H = {'Authorization': 'Bearer ' + tok['access_token'], 'Origin': 'https://frankf19-19.github.io'}
  call('GET', API + '/api/me', None, H)   # 觸發建立 profile（見面禮 10 點）
  items = []
  for pid in pids:
    s, pr = call('GET', URL + f'/rest/v1/products?id=eq.{pid}&select=id,type,name,brand', None, A); p = pr[0]
    s, img = call('GET', f'{API}/api/img?id={pid}', None, {'Origin': 'https://frankf19-19.github.io'}, raw=True)
    open(f'out/product_{pid}.jpg', 'wb').write(img)
    items.append({'type': p['type'], 'image': jpeg_uri(img, 900), 'name': p['brand'] + ' ' + p['name'], 'product_id': p['id']})
  key = secrets.token_hex(16)
  body = {'person': person, 'items': items, 'body': {'height_cm': 165, 'weight_kg': 55}, 'variants': 1, 'views': False, 'async': True, 'key': key, 'aspect': 'auto'}
  def poll(gid, want, limit=300):
    t0 = time.time(); last = None
    while time.time() - t0 < limit:
      s, d = call('GET', f'{API}/api/tryon/status?id={gid}', None, H); last = d
      st = d.get('status') if isinstance(d, dict) else None
      if st in want or st in ('failed', 'stopped'): return d, int(time.time() - t0)
      time.sleep(4)
    return last, int(time.time() - t0)
  s, d = call('POST', API + '/api/tryon', {**body, 'prefetch': True}, H); rep['prefetch_start'] = d
  d1, t1 = poll(d['id'], ('prefetched', 'ok')); rep['prefetch_done'] = {'status': d1.get('status'), 'secs': t1, 'error': d1.get('error')}
  s, d = call('POST', API + '/api/tryon', body, H); rep['claim'] = d
  d2, t2 = poll(d['id'], ('ok',)); res = (d2 or {}).get('result') or {}
  rep['final'] = {'status': d2.get('status'), 'secs_after_press': t2, 'quality': res.get('quality'), 'charged': res.get('charged'), 'error': d2.get('error')}
  url = (res.get('image_urls') or [None])[0] or d2.get('image_url')
  if url: s, b = call('GET', url, None, None, raw=True); open('out/result.jpg', 'wb').write(b)
  open('out/person.jpg', 'wb').write(base64.b64decode(person.split(',')[1]))
  # 品質檢查細節（直接讀資料庫）
  s, rows = call('GET', URL + f'/rest/v1/generations?user_id=eq.{uid}&select=id,status,error,job&order=id', None, A)
  rep['rows'] = [{'id': r['id'], 'status': r['status'], 'error': r['error'], 'job_keys': sorted((r.get('job') or {}).keys())[:30]} for r in rows]
finally:
  json.dump(rep, open('out/report.json', 'w'), ensure_ascii=False, indent=1); print(json.dumps(rep, ensure_ascii=False)[:3000])
  print('delete user', call('DELETE', URL + f'/auth/v1/admin/users/{uid}', None, A)[0])
