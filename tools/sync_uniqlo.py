#!/usr/bin/env python3
"""把 UNIQLO 台灣官網各分類的商品同步進試穿吧的 products 表（測試用，無聯盟分潤）。
環境變數：SUPABASE_URL、SUPABASE_SERVICE_KEY。用法：python3 tools/sync_uniqlo.py [每分類幾件，預設 12]
"""
import json, os, sys, urllib.request, time

SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
KEY = os.environ['SUPABASE_SERVICE_KEY']
PER_CAT = int(sys.argv[1]) if len(sys.argv) > 1 else 12
API = 'https://d.uniqlo.com/tw/p/search/products/by-category'
IMG = 'https://www.uniqlo.com/tw'
BUY = 'https://www.uniqlo.com/tw/zh_TW/product-detail.html?productCode='

# 分類代碼 → (type, gender, 額外 tags)
CATS = {
  'all_women-tops-t-shirts':     ('top', 'f', ['T恤']),
  'all_women-shirts':            ('top', 'f', ['襯衫']),
  'all_women-knit-lineup':       ('top', 'f', ['針織']),
  'all_women-tops-sweat':        ('top', 'f', ['大學T']),
  'all_women-outer':             ('top', 'f', ['外套']),
  'all_women-bottoms':           ('bottom', 'f', ['褲子']),
  'all_women-dresses-and-skirts':('dress', 'f', ['洋裝/裙']),
  'all_men-tops':                ('top', 'm', ['T恤']),
  'all_men-shirts':              ('top', 'm', ['襯衫']),
  'all_men-knit-lineup':         ('top', 'm', ['針織']),
  'all_men-outer':               ('top', 'm', ['外套']),
  'all_men-bottoms':             ('bottom', 'm', ['褲子']),
  'all_women-accessories':       (None, 'f', []),   # 用名稱判斷帽子/包包
  'all_men-accessories':         (None, 'm', []),
}

def fetch_cat(code, n):
  body = {"url": f"/tw/zh_TW/c/{code}.html", "categoryCode": code,
          "pageInfo": {"page": 1, "pageSize": max(n, 10), "withSideBar": "Y"}, "belongTo": "pc", "rank": "overall",
          "priceRange": {"low": 0, "high": 0}, "color": [], "size": [], "season": [], "material": [], "sex": [],
          "identity": [], "insideFilterCondition": [], "exclusiveCondition": [], "isCategoryExclusive": "N"}
  req = urllib.request.Request(API, data=json.dumps(body).encode(), headers={
    'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.uniqlo.com', 'Referer': 'https://www.uniqlo.com/'})
  with urllib.request.urlopen(req, timeout=30) as r:
    j = json.load(r)
  return (j.get('resp') or [{}])[0].get('productList') or []

def classify(cat_type, name):
  if cat_type: return cat_type
  if '帽' in name: return 'hat'
  if any(k in name for k in ('包', '袋')): return 'accessory'
  return None

def sb(method, path, data=None, prefer=None):
  h = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
  if prefer: h['Prefer'] = prefer
  req = urllib.request.Request(SUPABASE_URL + '/rest/v1/' + path, data=json.dumps(data).encode() if data is not None else None, headers=h, method=method)
  with urllib.request.urlopen(req, timeout=60) as r:
    t = r.read().decode()
    return json.loads(t) if t else None

rows, seen = [], set()
for code, (ctype, gender, tags) in CATS.items():
  try:
    lst = fetch_cat(code, PER_CAT)
  except Exception as e:
    print('skip', code, e); continue
  k = 0
  for p in lst:
    pid = p.get('productCode'); name = p.get('shortName') or p.get('name') or ''
    t = classify(ctype, name)
    if not pid or not t or pid in seen or not p.get('mainPic'): continue
    if p.get('stock') == 'N': continue
    sex = p.get('sex') or ''
    g = 'u' if '男女' in sex else gender
    rows.append({'source': 'uniqlo', 'external_id': pid, 'brand': 'UNIQLO', 'name': name, 'type': t, 'gender': g,
                 'price': int(p.get('minPrice') or 0), 'currency': 'TWD', 'image_url': IMG + p['mainPic'],
                 'buy_url': BUY + pid, 'tags': tags + ([s for s in [p.get('season')] if s]), 'active': True,
                 'featured': k == 0 and ctype in ('top', 'dress')})
    seen.add(pid); k += 1
    if k >= PER_CAT: break
  print(code, k)

print('total', len(rows))
existing = sb('GET', 'products?source=eq.uniqlo&select=id,external_id')
ex = {r['external_id']: r['id'] for r in existing}
ins = [r for r in rows if r['external_id'] not in ex]
upd = [r for r in rows if r['external_id'] in ex]
if ins: sb('POST', 'products', ins, prefer='return=minimal')
for r in upd:
  sb('PATCH', f"products?id=eq.{ex[r['external_id']]}", {k: v for k, v in r.items() if k not in ('source', 'external_id')}, prefer='return=minimal')
gone = [i for e, i in ex.items() if e not in seen]
for i in gone:
  sb('PATCH', f'products?id=eq.{i}', {'active': False}, prefer='return=minimal')
print(f'inserted {len(ins)}, updated {len(upd)}, deactivated {len(gone)}')
