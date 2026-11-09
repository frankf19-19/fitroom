#!/usr/bin/env python3
"""同時送出兩套試穿（不經預先合成），確認兩套都能完成（會花 AI 費用）。"""
import os, io, json, time, base64, secrets, urllib.request, re, threading
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
email = f'conc-{int(time.time())}@tryon-test.invalid'; pw = secrets.token_urlsafe(16)
s, u = call('POST', URL + '/auth/v1/admin/users', {'email': email, 'password': pw, 'email_confirm': True}, A); uid = u['id']
out = {}
try:
  s, tok = call('POST', URL + '/auth/v1/token?grant_type=password', {'email': email, 'password': pw}, {'apikey': ANON})
  H = {'Authorization': 'Bearer ' + tok['access_token'], 'Origin': 'https://frankf19-19.github.io'}
  call('GET', API + '/api/me', None, H)
  person = ju(open('qa/px_34.jpg', 'rb').read())
  def item(pid, t):
    s, b = call('GET', f'{API}/api/img?id={pid}', None, {'Origin': 'https://frankf19-19.github.io'}, raw=True); return {'type': t, 'image': ju(b, 900), 'product_id': pid}
  jobs = {'A': [item(13, 'top')], 'B': [item(60, 'bottom')]}
  ids = {}
  for k, its in jobs.items():
    s, d = call('POST', API + '/api/tryon', {'person': person, 'items': its, 'variants': 1, 'views': False, 'async': True, 'key': secrets.token_hex(16), 'aspect': 'auto'}, H); ids[k] = d; print('submit', k, s, d)
  res = {}
  def poll(k):
    gid = ids[k].get('id') if isinstance(ids[k], dict) else None
    if not gid: res[k] = 'no id'; return
    t0 = time.time()
    while time.time() - t0 < 300:
      s, d = call('GET', f'{API}/api/tryon/status?id={gid}', None, H)
      if isinstance(d, dict) and d.get('status') in ('ok', 'failed'): res[k] = {'status': d['status'], 'secs': int(time.time() - t0), 'err': d.get('error'), 'q': (d.get('result') or {}).get('quality')}; return
      time.sleep(3)
    res[k] = 'timeout'
  ts = [threading.Thread(target=poll, args=(k,)) for k in ids]; [t.start() for t in ts]; [t.join() for t in ts]
  out = res; print(json.dumps(res, ensure_ascii=False))
finally:
  print('delete', call('DELETE', URL + f'/auth/v1/admin/users/{uid}', None, A)[0])
