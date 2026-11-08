#!/usr/bin/env python3
"""驗證新會員見面禮：建立測試帳號 → 同時打 5 次 /api/me → 應只送一次 10 點 → 刪除測試帳號。"""
import os, json, time, secrets, urllib.request, re
from concurrent.futures import ThreadPoolExecutor
URL = os.environ['SUPABASE_URL']; KEY = os.environ['SUPABASE_SERVICE_KEY']; API = 'https://tryon-api.frankccc199.workers.dev'
ANON = re.search(r"SUPABASE_ANON_KEY:\s*'([^']+)'", open('index.html').read()).group(1)
def call(method, url, data=None, h=None):
  r = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers={'Content-Type': 'application/json', **(h or {})}, method=method)
  try:
    with urllib.request.urlopen(r, timeout=60) as x: t = x.read().decode(); return x.status, json.loads(t) if t else None
  except urllib.error.HTTPError as e: return e.code, e.read().decode()[:300]
A = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}
email = f'bonus-{int(time.time())}@tryon-test.invalid'; pw = secrets.token_urlsafe(16)
s, u = call('POST', URL + '/auth/v1/admin/users', {'email': email, 'password': pw, 'email_confirm': True}, A); uid = u['id']
try:
  s, tok = call('POST', URL + '/auth/v1/token?grant_type=password', {'email': email, 'password': pw}, {'apikey': ANON})
  H = {'Authorization': 'Bearer ' + tok['access_token'], 'Origin': 'https://frankf19-19.github.io'}
  with ThreadPoolExecutor(5) as ex: rs = list(ex.map(lambda _: call('GET', API + '/api/me', None, H), range(5)))
  s, again = call('GET', API + '/api/me', None, H)
  s, prof = call('GET', URL + f'/rest/v1/profiles?id=eq.{uid}&select=credits,prefs', None, A)
  s, marks = call('GET', URL + f'/rest/v1/generations?user_id=eq.{uid}&status=eq.bonus&select=id', None, A)
  out = {'parallel': [(r[0], r[1].get('credits') if isinstance(r[1], dict) else r[1], r[1].get('welcome_bonus') if isinstance(r[1], dict) else None) for r in rs],
         'again': (again.get('credits'), again.get('welcome_bonus')), 'db_credits': prof[0]['credits'], 'bonus_rows': len(marks)}
  print(json.dumps(out, ensure_ascii=False)); open('out.json', 'w').write(json.dumps(out, ensure_ascii=False))
finally:
  print('delete', call('DELETE', URL + f'/auth/v1/admin/users/{uid}', None, A)[0])
