#!/usr/bin/env python3
"""把多家 Shopify 品牌的公開商品清單同步進 products 表（測試用，無聯盟分潤）。
環境變數：SUPABASE_URL、SUPABASE_SERVICE_KEY。用法：python3 tools/sync_shopify.py [每家每類幾件，預設 10]
"""
import json, os, re, sys, urllib.request, urllib.error, urllib.parse

SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/'); KEY = os.environ['SUPABASE_SERVICE_KEY']
PER = int(sys.argv[1]) if len(sys.argv) > 1 else 10
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept': 'application/json'}
FX = {'USD': 32.0, 'AUD': 21.0}
# 網域, 品牌（None=用商品 vendor）, 幣別, 預設性別, 只收哪些類別（None=全部）
STORES = [
  ('allbirds.com', 'Allbirds', 'USD', 'u', {'shoes'}),
  ('rothys.com', "Rothy's", 'USD', 'f', {'shoes', 'accessory'}),
  ('kith.com', None, 'USD', 'u', None),
  ('lackofcolor.com', 'Lack of Color', 'AUD', 'u', {'hat'}),
  ('herschel.com', 'Herschel', 'USD', 'u', {'accessory', 'hat'}),
  ('mvmt.com', 'MVMT', 'USD', 'u', {'accessory'}),
  ('fashionnova.com', 'Fashion Nova', 'USD', 'f', None),
  ('beginningboutique.com.au', 'Beginning Boutique', 'AUD', 'f', None),
  ('tigermist.com.au', 'Tiger Mist', 'AUD', 'f', None),
  ('gymshark.com', 'Gymshark', 'USD', 'u', None),
  ('aloyoga.com', 'Alo Yoga', 'USD', 'f', None),
  ('taylorstitch.com', 'Taylor Stitch', 'USD', 'm', None),
]
SKIP = re.compile(r'gift ?card|bikini|swim|tankini|underwear|brief|boxer|bra\b|bralette|sock|lingerie|quilt|sheet|candle|sticker|charm|keychain|key ring|sample|bundle|kit\b|sleep|pajama|robe|lotion|perfume|fragrance|cleaner|insole|lace kit|patch', re.I)
RULES = [
  ('shoes', r'shoe|sneaker|sandal|slide|boot|flip ?flop|loafer|mary jane|\bflat\b|runner|trainer|heel|mule|clog|slipper|dasher|lounger|cruiser'),
  ('hat', r'\bhat\b|\bcap\b|beanie|headwear|beret|bucket|pillbox|fedora|visor|trucker'),
  ('accessory', r'\bbag\b|backpack|tote|pouch|wallet|watch|necklace|earring|bracelet|\bring\b|sunglass|\bbelt\b|jewel|crossbody|duffle|clutch|scarf|purse|handbag|sling'),
  ('dress', r'dress|jumpsuit|romper|playsuit|catsuit|onesie|unitard'),
  ('bottom', r'pant|trouser|jean|denim|\bshort|skirt|legging|jogger|chino|cargo|culotte|sweatpant|flare'),
  ('top', r'shirt|\btee\b|t-shirt|\btop\b|blouse|sweater|hoodie|jacket|coat|cardigan|knit|crew|polo|vest|blazer|outerwear|sweatshirt|tank|corset|bodysuit|pullover|zip|wovens|overshirt|puffer|parka|anorak|henley|camisole|cami\b|tube'),
]
def classify(p):
  text = ' '.join([p.get('product_type') or '', p.get('title') or '', ' '.join(p.get('tags') or []) if isinstance(p.get('tags'), list) else str(p.get('tags') or '')])
  if SKIP.search(p.get('title') or '') or SKIP.search(p.get('product_type') or ''): return None
  pt = (p.get('product_type') or '') + ' ' + (p.get('title') or '')
  for t, rx in RULES:
    if re.search(rx, pt, re.I): return t
  for t, rx in RULES:
    if re.search(rx, text, re.I): return t
  return None
def gender_of(p, default):
  text = ' '.join([p.get('product_type') or '', p.get('title') or '', ' '.join(p.get('tags') or []) if isinstance(p.get('tags'), list) else str(p.get('tags') or '')]).lower()
  w = bool(re.search(r"\bwom[ae]n'?s?\b|\bladies\b|\bwomens\b", text)); m = bool(re.search(r"\bm[ae]n'?s?\b|\bmens\b", text.replace('women', '').replace('womens', '')))
  if w and not m: return 'f'
  if m and not w: return 'm'
  return default
SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL']
def sizes_of(p):
  opts = p.get('options') or []
  idx = next((i for i, o in enumerate(opts) if (o.get('name') or '').lower() in ('size', 'sizes', 'shoe size', 'women\'s size', 'men\'s size')), None)
  if idx is None: return []
  vals = []
  for v in p.get('variants') or []:
    s = (v.get(f'option{idx+1}') or '').strip()
    if s and s not in vals and v.get('available', True): vals.append(s)
  up = [v.upper().replace('2XL', 'XXL') for v in vals]
  if all(u in SIZE_ORDER for u in up): return [x for x in SIZE_ORDER if x in up]
  return vals[:20]
def get(u):
  req = urllib.request.Request(u, headers=UA)
  with urllib.request.urlopen(req, timeout=40) as r: return json.load(r)
def sb(method, path, data=None, prefer=None):
  h = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
  if prefer: h['Prefer'] = prefer
  req = urllib.request.Request(SUPABASE_URL + '/rest/v1/' + path, data=json.dumps(data).encode() if data is not None else None, headers=h, method=method)
  with urllib.request.urlopen(req, timeout=60) as r:
    t = r.read().decode(); return json.loads(t) if t else None

total = 0
for domain, brand, cur, gdef, allow in STORES:
  src = 'shopify:' + domain
  try:
    prods = []
    for page in (1, 2):
      j = get(f'https://{domain}/products.json?limit=250&page={page}')
      prods += j.get('products', [])
      if len(j.get('products', [])) < 250: break
  except Exception as e:
    print(domain, 'FAIL', e); continue
  counts, rows, seen = {}, [], set()
  for p in prods:
    t = classify(p)
    if not t or (allow and t not in allow): continue
    if counts.get(t, 0) >= PER: continue
    imgs = p.get('images') or []
    if not imgs: continue
    vs = p.get('variants') or []
    if not any(v.get('available', True) for v in vs): continue
    try: price = float((vs[0] or {}).get('price') or 0)
    except: price = 0
    if price <= 0: continue
    pid = str(p['id'])
    rows.append({'source': src, 'external_id': pid, 'brand': brand or p.get('vendor') or domain, 'name': (p.get('title') or '')[:120], 'type': t,
                 'gender': gender_of(p, gdef), 'price': int(round(price * FX.get(cur, 32) / 10) * 10), 'currency': 'TWD',
                 'image_url': imgs[0]['src'].split('?')[0] + '?width=1200', 'buy_url': f'https://{domain}/products/{p.get("handle")}',
                 'tags': [x for x in [p.get('product_type')] if x][:1], 'sizes': sizes_of(p), 'active': True, 'featured': False})
    counts[t] = counts.get(t, 0) + 1; seen.add(pid)
  existing = sb('GET', f'products?source=eq.{urllib.parse.quote(src)}&select=id,external_id')
  ex = {r['external_id']: r['id'] for r in existing}
  ins = [r for r in rows if r['external_id'] not in ex]
  if ins: sb('POST', 'products', ins, prefer='return=minimal')
  for r in rows:
    if r['external_id'] in ex: sb('PATCH', f"products?id=eq.{ex[r['external_id']]}", {k: v for k, v in r.items() if k not in ('source', 'external_id')}, prefer='return=minimal')
  for e, i in ex.items():
    if e not in seen: sb('PATCH', f'products?id=eq.{i}', {'active': False}, prefer='return=minimal')
  total += len(rows)
  print(domain, len(prods), 'products ->', counts)
print('total', total)
