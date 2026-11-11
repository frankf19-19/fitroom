#!/usr/bin/env python3
"""生圖速度與品質基準（會花 AI 費用）：臨時帳號，依序跑幾種情況（不經預先合成），用跟網站一樣的輪詢節奏，
記錄每種情況從按下到拿到結果的秒數、品質分數，並把結果圖存到 out/。CASES 可指定 JSON。"""
import os, io, json, time, base64, secrets, urllib.request, re
from PIL import Image
URL = os.environ['SUPABASE_URL']; KEY = os.environ['SUPABASE_SERVICE_KEY']; API = 'https://tryon-api.frankccc199.workers.dev'
UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'
ANON = re.search(r"SUPABASE_ANON_KEY:\s*'([^']+)'", open('index.html').read()).group(1); A = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}
os.makedirs('out', exist_ok=True)
CASES = json.loads(os.environ.get('CASES') or '[["one","qa/px_34.jpg",[[13,"top"]]],["two","qa/px_34.jpg",[[13,"top"],[60,"bottom"]]],["three","qa/real_f.jpg",[[13,"top"],[60,"bottom"],[683,"shoes"]]]]')
def call(m, url, d=None, h=None, raw=False):
  r = urllib.request.Request(url, data=json.dumps(d).encode() if d is not None else None, headers={'Content-Type': 'application/json', **({'User-Agent': UA} if url.startswith(API) else {}), **(h or {})}, method=m)
  try:
    with urllib.request.urlopen(r, timeout=120) as x: b = x.read(); return x.status, (b if raw else (json.loads(b) if b else None))
  except urllib.error.HTTPError as e: return e.code, e.read().decode()[:300]
  except Exception as e: return -1, str(e)[:200]
def ju(b, w=1200):
  im = Image.open(io.BytesIO(b)).convert('RGB'); im.thumbnail((w, w * 2)); o = io.BytesIO(); im.save(o, 'JPEG', quality=88); return 'data:image/jpeg;base64,' + base64.b64encode(o.getvalue()).decode()
email = f'bench-{int(time.time())}@tryon-test.invalid'; pw = secrets.token_urlsafe(16)
s, u = call('POST', URL + '/auth/v1/admin/users', {'email': email, 'password': pw, 'email_confirm': True}, A)
if not isinstance(u, dict): raise SystemExit(f'建立帳號失敗 {s} {u}')
uid = u['id']; rep = []
try:
  s, tok = call('POST', URL + '/auth/v1/token?grant_type=password', {'email': email, 'password': pw}, {'apikey': ANON})
  H = {'Authorization': 'Bearer ' + tok['access_token'], 'Origin': 'https://frankf19-19.github.io'}
  call('GET', API + '/api/me', None, H)
  call('POST', URL + '/rest/v1/rpc/add_credits', {'p_user': uid, 'p_amount': 30}, A)
  s, hv = call('GET', API + '/api/health'); print('worker', hv)
  cache = {}
  def item(pid, t):
    if pid not in cache: cache[pid] = call('GET', f'{API}/api/img?id={pid}', None, {'Origin': 'https://frankf19-19.github.io'}, raw=True)[1]
    return {'type': t, 'image': ju(cache[pid], 900), 'product_id': pid}
  for name, ppath, its in CASES:
    person = ju(open(ppath, 'rb').read())
    body = {'person': person, 'items': [item(p, t) for p, t in its], 'body': {'height_cm': 165, 'weight_kg': 55}, 'variants': 1, 'views': False, 'async': True, 'key': secrets.token_hex(16), 'aspect': 'auto', 'nocache': True}
    t0 = time.time(); s, d = call('POST', API + '/api/tryon', body, H); r = {'case': name, 'items': [t for _, t in its], 'submit': s, 'post_secs': round(time.time() - t0, 1), 'body_kb': len(json.dumps(body)) // 1024}
    if not (isinstance(d, dict) and d.get('id')): r['error'] = str(d)[:200]; rep.append(r); print(r); time.sleep(25); continue
    seen = []; first_pv = None
    while time.time() - t0 < 360:
      time.sleep(1.5)
      s, st = call('GET', f"{API}/api/tryon/status?id={d['id']}", None, H)
      if not isinstance(st, dict): continue
      pg = st.get('progress') or {}; cur = pg.get('current')
      if cur and (not seen or seen[-1][0] != cur): seen.append((cur, round(time.time() - t0, 1)))
      if st.get('preview') and first_pv is None: first_pv = round(time.time() - t0, 1)
      res = st.get('result') if st.get('status') == 'ok' else st.get('front')
      if res:
        r.update({'secs': round(time.time() - t0, 1), 'steps': seen, 'first_preview': first_pv, 'quality': res.get('quality'), 'timing': res.get('timing'), 'engine': res.get('engine'), 'dropped': res.get('extras_dropped'), 'marks': [(m[0], round(m[1] / 1000, 1)) for m in (res.get('marks') or [])]})
        url = (res.get('image_urls') or [None])[0]
        if url:
          b = call('GET', url, None, None, raw=True)[1]
          if isinstance(b, bytes): open(f'out/{name}.jpg', 'wb').write(b)
        break
      if st.get('status') == 'failed': r.update({'secs': round(time.time() - t0, 1), 'error': st.get('error'), 'steps': seen}); break
    else: r['error'] = 'timeout'
    open(f'out/{name}_person.jpg', 'wb').write(base64.b64decode(person.split(',')[1]))
    rep.append(r); print(json.dumps(r, ensure_ascii=False)); time.sleep(22)   # 避開「60 秒內最多 3 次」
finally:
  json.dump(rep, open('out/report.json', 'w'), ensure_ascii=False, indent=1)
  print('delete', call('DELETE', URL + f'/auth/v1/admin/users/{uid}', None, A)[0])
