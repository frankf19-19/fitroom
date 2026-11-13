#!/usr/bin/env python3
"""一次性修正商品性別標記（之後每天同步會照新規則標）：洋裝／裙子／女裝品牌被標成「不分男女」的改成女生。"""
import os, json, urllib.request, urllib.parse
URL = os.environ['SUPABASE_URL']; KEY = os.environ['SUPABASE_SERVICE_KEY']
H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation'}
def patch(q, label):
  r = urllib.request.Request(f"{URL}/rest/v1/products?active=eq.true&gender=eq.u&{q}", data=json.dumps({'gender': 'f'}).encode(), headers=H, method='PATCH')
  rows = json.load(urllib.request.urlopen(r)); print(label, len(rows), [x['name'][:20] for x in rows[:5]]); return len(rows)
n = patch('type=eq.dress', '洋裝')
for kw in ('裙', '洋裝', '連身'): n += patch('name=ilike.' + urllib.parse.quote(f'*{kw}*') + '&name=not.ilike.' + urllib.parse.quote('*男*'), kw)
n += patch('brand=eq.' + urllib.parse.quote('50% FIFTY PERCENT'), '50% FIFTY PERCENT')
open('fix_gender.json', 'w').write(json.dumps({'fixed': n})); print('total', n)
