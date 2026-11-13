#!/usr/bin/env python3
"""商品性別標記統計：各性別×類別數量，以及標成「不分男女」(u) 的品牌與商品名稱抽樣。"""
import os, json, urllib.request, collections
URL = os.environ['SUPABASE_URL']; KEY = os.environ['SUPABASE_SERVICE_KEY']; H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}
rows, off = [], 0
while True:
  r = json.load(urllib.request.urlopen(urllib.request.Request(f"{URL}/rest/v1/products?active=eq.true&select=id,brand,name,type,gender&order=id&limit=1000&offset={off}", headers=H)))
  rows += r
  if len(r) < 1000: break
  off += 1000
c = collections.Counter((r['gender'], r['type']) for r in rows)
out = {'total': len(rows), 'by_gender_type': {f'{g}/{t}': n for (g, t), n in sorted(c.items(), key=lambda x: str(x[0]))}}
ub = collections.Counter(r['brand'] for r in rows if r['gender'] == 'u'); out['u_by_brand'] = dict(ub.most_common(60))
allb = collections.Counter(r['brand'] for r in rows); out['brand_gender'] = {b: dict(collections.Counter(r['gender'] for r in rows if r['brand'] == b)) for b, _ in allb.most_common(80)}
samp = collections.defaultdict(list)
for r in rows:
  if r['gender'] == 'u' and len(samp[r['brand']]) < 6: samp[r['brand']].append(f"{r['type']}:{r['name'][:28]}")
out['u_samples'] = samp
json.dump(out, open('gender.json', 'w'), ensure_ascii=False, indent=1); print(out['total'], out['by_gender_type'])
