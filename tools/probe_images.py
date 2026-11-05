#!/usr/bin/env python3
"""檢查商店每個品牌的商品圖能不能直接載入（含透過 Worker 代理），結果寫到 images.json。"""
import json, urllib.request, urllib.parse
API = 'https://tryon-api.frankccc199.workers.dev'
def get(url, headers=None, timeout=20):
  req = urllib.request.Request(url, headers=headers or {'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1', 'Accept': 'image/*,*/*'})
  try:
    with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.headers.get('content-type', ''), len(r.read())
  except urllib.error.HTTPError as e: return e.code, '', 0
  except Exception as e: return -1, str(e)[:80], 0
brands = json.loads(get(API + '/api/brands')[1] if False else urllib.request.urlopen(API + '/api/brands', timeout=30).read().decode()).get('brands', [])
out = {}
for b in brands:
  d = json.loads(urllib.request.urlopen(API + '/api/products?brand=' + urllib.parse.quote(b['name']) + '&page=0', timeout=30).read().decode())
  ps = d.get('products', [])[:3]
  rows = []
  for p in ps:
    direct = get(p['image_url'])
    direct_ref = get(p['image_url'], {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://frankf19-19.github.io/', 'Accept': 'image/*'})
    proxy = get(f"{API}/api/img?id={p['id']}")
    rows.append({'id': p['id'], 'url': p['image_url'][:90], 'direct': direct, 'direct_with_referer': direct_ref, 'proxy': proxy})
  out[b['name']] = rows
  print(b['name'], [(r['direct'][0], r['direct_with_referer'][0], r['proxy'][0], r['proxy'][1][:20]) for r in rows])
json.dump(out, open('images.json', 'w'), ensure_ascii=False, indent=1)
