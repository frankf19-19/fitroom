#!/usr/bin/env python3
"""檢查資料庫是否仍限制「每人同時只能一筆進行中」：替測試帳號插兩筆 running，看第二筆會不會被擋，最後刪掉。"""
import os, json, urllib.request
URL = os.environ['SUPABASE_URL']; KEY = os.environ['SUPABASE_SERVICE_KEY']
H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation'}
def call(m, p, d=None):
  r = urllib.request.Request(URL + p, data=json.dumps(d).encode() if d is not None else None, headers=H, method=m)
  try:
    with urllib.request.urlopen(r, timeout=30) as x: return x.status, json.loads(x.read() or b'null')
  except urllib.error.HTTPError as e: return e.code, e.read().decode()[:300]
s, us = call('GET', '/auth/v1/admin/users?page=1&per_page=200'); uid = next(u['id'] for u in us['users'] if u['email'] == 'qa-bot@tryon-test.invalid')
ids = []
for k in range(2):
  s, r = call('POST', '/rest/v1/generations', {'user_id': uid, 'items': ['top'], 'cost': 0, 'status': 'working', 'variants': 1})
  print('insert', k, s, str(r)[:200]); 
  if isinstance(r, list) and r: ids.append(r[0]['id'])
for i in ids: print('delete', call('DELETE', f'/rest/v1/generations?id=eq.{i}')[0])
