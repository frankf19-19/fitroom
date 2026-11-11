#!/usr/bin/env python3
"""防錯測試（會花 AI 費用）：
A. 使用者送出後完全不輪詢（模擬切到別的 App）：排程應該代為推進，幾分鐘內資料庫那筆變成完成。
B. 免費額度：第一套用掉今天的免費額度後，緊接著（第一套還在跑）送第二套，第二套必須扣點數、不能再用免費額度。"""
import os, io, json, time, base64, secrets, urllib.request, re
from PIL import Image
URL = os.environ['SUPABASE_URL']; KEY = os.environ['SUPABASE_SERVICE_KEY']; API = 'https://tryon-api.frankccc199.workers.dev'
UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'
ANON = re.search(r"SUPABASE_ANON_KEY:\s*'([^']+)'", open('index.html').read()).group(1); A = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}
def call(m, url, d=None, h=None, raw=False):
  r = urllib.request.Request(url, data=json.dumps(d).encode() if d is not None else None, headers={'Content-Type': 'application/json', **({'User-Agent': UA} if url.startswith(API) else {}), **(h or {})}, method=m)
  try:
    with urllib.request.urlopen(r, timeout=120) as x: b = x.read(); return x.status, (b if raw else (json.loads(b) if b else None))
  except urllib.error.HTTPError as e: return e.code, e.read().decode()[:300]
def ju(b, w=1200):
  im = Image.open(io.BytesIO(b)).convert('RGB'); im.thumbnail((w, w * 2)); o = io.BytesIO(); im.save(o, 'JPEG', quality=88); return 'data:image/jpeg;base64,' + base64.b64encode(o.getvalue()).decode()
email = f'robust-{int(time.time())}@tryon-test.invalid'; pw = secrets.token_urlsafe(16)
s, u = call('POST', URL + '/auth/v1/admin/users', {'email': email, 'password': pw, 'email_confirm': True}, A); uid = u['id']; out = {}
try:
  s, tok = call('POST', URL + '/auth/v1/token?grant_type=password', {'email': email, 'password': pw}, {'apikey': ANON})
  H = {'Authorization': 'Bearer ' + tok['access_token'], 'Origin': 'https://frankf19-19.github.io'}
  s, me = call('GET', API + '/api/me', None, H); out['me'] = {k: me.get(k) for k in ('credits', 'free_left')}
  person = ju(open('qa/px_34.jpg', 'rb').read()); cache = {}
  def item(pid, t):
    if pid not in cache: cache[pid] = call('GET', f'{API}/api/img?id={pid}', None, {'Origin': 'https://frankf19-19.github.io'}, raw=True)[1]
    return {'type': t, 'image': ju(cache[pid], 900), 'product_id': pid}
  def submit(its):
    return call('POST', API + '/api/tryon', {'person': person, 'items': its, 'variants': 1, 'views': False, 'async': True, 'key': secrets.token_hex(16), 'aspect': 'auto', 'nocache': True}, H)
  t0 = time.time()
  s, a = submit([item(13, 'top'), item(60, 'bottom')]); print('A', s, a)      # 2 件：用掉今天 2 張免費
  s, b = submit([item(3, 'top')]); print('B', s, b)                           # 緊接著 1 件：應該扣 1 點
  rows = lambda: call('GET', URL + f'/rest/v1/generations?user_id=eq.{uid}&status=neq.bonus&select=id,status,cost,free_used,image_url,error,job&order=id', None, A)[1]
  r0 = rows(); out['quota'] = [{'id': r['id'], 'cost': r['cost'], 'free_used': r['free_used']} for r in r0]
  # 之後完全不呼叫 /api/tryon/status：只看資料庫
  timeline = []
  while time.time() - t0 < 420:
    time.sleep(20); rs = rows(); snap = [(r['id'], r['status'], bool(r['image_url'])) for r in rs]; timeline.append((int(time.time() - t0), snap)); print(timeline[-1])
    if all(r['status'] in ('ok', 'failed') for r in rs): break
  rs = rows(); out['final'] = [{'id': r['id'], 'status': r['status'], 'has_image': bool(r['image_url']), 'error': r['error'], 'marks': [(m[0], round(m[1] / 1000)) for m in ((r.get('job') or {}).get('tm') or [])]} for r in rs]
  out['secs_until_all_done'] = int(time.time() - t0)
finally:
  print(json.dumps(out, ensure_ascii=False)); print('delete', call('DELETE', URL + f'/auth/v1/admin/users/{uid}', None, A)[0])
