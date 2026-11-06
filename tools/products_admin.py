#!/usr/bin/env python3
"""商品表管理動作（在 GitHub Actions 的 products-admin.yml 裡跑，需要 SUPABASE_URL、SUPABASE_SERVICE_KEY）。
用法：python3 tools/products_admin.py <action>
  deactivate_overseas   把海外（Shopify）商店的商品全部下架（active=false）
  deactivate_source:<source>  把某個 source 的商品全部下架
  brands                列出目前上架中的品牌與件數（寫到 out.json）
"""
import json, os, sys, urllib.request, urllib.parse

URL = os.environ['SUPABASE_URL'].rstrip('/'); KEY = os.environ['SUPABASE_SERVICE_KEY']
OVERSEAS = ['Allbirds', "Rothy's", 'Kith', 'Lack of Color', 'Herschel', 'MVMT', 'Fashion Nova', 'Beginning Boutique', 'Tiger Mist', 'Gymshark', 'Alo Yoga', 'Taylor Stitch',
            'Saint Laurent', 'Visvim', 'Rick Owens', 'Rains', 'by Parra', 'KNWLS']

def sb(method, path, data=None, prefer=None):
  h = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
  if prefer: h['Prefer'] = prefer
  req = urllib.request.Request(URL + '/rest/v1/' + path, data=json.dumps(data).encode() if data is not None else None, headers=h, method=method)
  with urllib.request.urlopen(req, timeout=120) as r:
    t = r.read().decode(); return json.loads(t) if t else None

def counts():
  rows = sb('GET', 'products?active=eq.true&select=brand,source&limit=20000')
  c = {}
  for r in rows: c[(r['brand'], r['source'])] = c.get((r['brand'], r['source']), 0) + 1
  return sorted([{'brand': b, 'source': s, 'n': n} for (b, s), n in c.items()], key=lambda x: -x['n'])

act = sys.argv[1] if len(sys.argv) > 1 else 'brands'
if act == 'deactivate_overseas':
  n1 = sb('PATCH', 'products?source=like.shopify%3A%25&active=eq.true', {'active': False}, prefer='return=representation')
  brands = ','.join('"' + b.replace('"', '') + '"' for b in OVERSEAS)
  n2 = sb('PATCH', 'products?brand=in.(' + urllib.parse.quote(brands) + ')&active=eq.true', {'active': False}, prefer='return=representation')
  print('deactivated shopify:', len(n1 or []), 'by brand:', len(n2 or []))
elif act.startswith('deactivate_source:'):
  src = act.split(':', 1)[1]
  n = sb('PATCH', 'products?source=eq.' + urllib.parse.quote(src) + '&active=eq.true', {'active': False}, prefer='return=representation')
  print('deactivated', src, len(n or []))
out = counts()
for r in out: print(r['brand'], r['source'], r['n'])
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
