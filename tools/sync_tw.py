#!/usr/bin/env python3
"""台灣品牌官網商品同步（測試用，無聯盟分潤）：91APP 平台品牌 + 商品頁結構化資料（JSON-LD）。
遵守 robots.txt、放慢請求。環境變數：SUPABASE_URL、SUPABASE_SERVICE_KEY。用法：python3 tools/sync_tw.py [每家每類幾件，預設 12]
"""
import json, os, re, sys, time, gzip, urllib.request, urllib.parse, urllib.robotparser, concurrent.futures as cf

SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/'); KEY = os.environ['SUPABASE_SERVICE_KEY']
PER = int(sys.argv[1]) if len(sys.argv) > 1 else 12
UA = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
H = {'User-Agent': UA, 'Accept-Language': 'zh-TW'}

def get(u, n=4000000):
  u = urllib.parse.quote(u, safe=':/?&=%#+,;@~')
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=30) as r:
      b = r.read(n)
      if b[:2] == b'\x1f\x8b':
        try: b = gzip.decompress(b)
        except Exception: pass
      return r.status, b.decode('utf-8', 'replace')
  except urllib.error.HTTPError as e: return e.code, ''
  except Exception: return 0, ''

def robots(host):
  rp = urllib.robotparser.RobotFileParser(); st, t = get(f'https://{host}/robots.txt', 300000)
  rp.parse(t.splitlines() if st == 200 else []); return rp, t

SKIP = re.compile(r'襪|內衣|內褲|內著|胸罩|bra\b|禮盒|禮卡|口罩|浴巾|毛巾|雨傘|陽傘|保養|香氛|清潔|鞋墊|鞋帶|水壺|杯|貼紙|吊飾|鑰匙圈|童|兒童|嬰|寶寶|baby|kids|kid\'s|youth|toddler|mask|sock|gift|加購|運費|補差價|會員|兌換|贈品|福袋|試穿|預購金', re.I)
RULES = [
  ('shoes', r'鞋|靴|拖|涼鞋|sneaker|shoe|slip-on|sandal|boot|clog|克駱格|洞洞|old skool|sk8|authentic|knu skool'),
  ('dress', r'洋裝|連身|吊帶裙|罩衫裙|jumpsuit|dress'),
  ('top', r'上衣|T恤|tee|t-shirt|襯衫|外套|夾克|毛衣|針織|背心|帽T|帽t|大學T|大學t|POLO|polo|衛衣|罩衫|西裝|大衣|羽絨|風衣|開襟|小可愛|衫|jacket|shirt|hoodie|sweater|coat|top\b|crew|fleece|cardigan|vest'),
  ('bottom', r'褲|裙|jean|pants|shorts|skirt|jogger|chino|legging'),
  ('hat', r'(?<!連)帽(?![Tt外上])|\bcap\b|beanie|bucket hat|毛帽|棒球帽|漁夫帽'),
  ('accessory', r'(?<![口麵])包|(?<![口麵])袋|錢夾|皮夾|項鍊|耳環|耳骨|手環|手鍊|戒指|手錶|墨鏡|眼鏡|皮帶|腰帶|圍巾|髮夾|髮圈|necklace|earring|bracelet|ring\b|bag|wallet|belt|scarf|watch|sunglass'),
]
def classify(*texts, default=None):
  t = ' '.join(x or '' for x in texts)
  if SKIP.search(t): return None
  for typ, rx in RULES:
    if re.search(rx, texts[0] or '', re.I): return typ
  for typ, rx in RULES:
    if re.search(rx, t, re.I): return typ
  return default
def gender_of(t, d):
  t = t or ''
  w = bool(re.search(r'女|women|ladies|WMNS|wmns', t, re.I)); m = bool(re.search(r'男|(?<!wo)men\b|(?<!WO)MEN\b', t))
  if w and not m: return 'f'
  if m and not w: return 'm'
  return d
SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL']
def norm_sizes(vals):
  out = []
  for v in vals:
    v = v.strip().upper().replace('2XL', 'XXL')
    if v and v not in out: out.append(v)
  if out and all(v in SIZE_ORDER for v in out): return [x for x in SIZE_ORDER if x in out]
  return out[:20]

def sb(method, path, data=None, prefer=None):
  h = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
  if prefer: h['Prefer'] = prefer
  req = urllib.request.Request(SUPABASE_URL + '/rest/v1/' + path, data=json.dumps(data).encode() if data is not None else None, headers=h, method=method)
  with urllib.request.urlopen(req, timeout=60) as r:
    t = r.read().decode(); return json.loads(t) if t else None
def save(src, rows):
  existing = sb('GET', f'products?source=eq.{urllib.parse.quote(src)}&select=id,external_id')
  ex = {r['external_id']: r['id'] for r in existing}; seen = {r['external_id'] for r in rows}
  ins = [r for r in rows if r['external_id'] not in ex]
  for i in range(0, len(ins), 100): sb('POST', 'products', ins[i:i+100], prefer='return=minimal')
  for r in rows:
    if r['external_id'] in ex: sb('PATCH', f"products?id=eq.{ex[r['external_id']]}", {k: v for k, v in r.items() if k not in ('source', 'external_id')}, prefer='return=minimal')
  for e, i in ex.items():
    if e not in seen: sb('PATCH', f'products?id=eq.{i}', {'active': False}, prefer='return=minimal')

def pick(rows):
  counts, out = {}, []
  for r in rows:
    if counts.get(r['type'], 0) >= PER: continue
    counts[r['type']] = counts.get(r['type'], 0) + 1; out.append(r)
  return out, counts

# ---------- 91APP ----------
SHOPS91 = [('www.obdesign.com.tw', 'OB嚴選', 'f'), ('www.giordano.com.tw', 'GIORDANO', 'u'), ('www.vans.com.tw', 'VANS', 'u'), ('www.adidas.com.tw', 'adidas', 'u'),
           ('www.roots.com.tw', 'Roots', 'u'), ('www.edwin.com.tw', 'EDWIN', 'u'), ('www.timberland.com.tw', 'Timberland', 'u'), ("www.levis.com.tw", "Levi's", 'u')]
def sync91(host, brand, gdef):
  rp, rt = robots(host)
  m = re.search(r'Sitemap/(\d+)/Sitemap_Index', rt); shop = m and m.group(1)
  if not shop: print(host, 'no shop id'); return
  st, x = get(f'https://{host}/Sitemap/sitemap_ShopSalePage.xml.gz')
  ids = sorted({int(i) for i in re.findall(r'SalePage/Index/(\d+)', x)}, reverse=True)[:420]
  if not ids: print(host, 'no salepages'); return
  def one(sid):
    url = f'https://{host}/webapi/SalePageV2/GetSalePageV2Info/{shop}/{sid}'
    if not rp.can_fetch(UA, f'https://{host}/SalePage/Index/{sid}'): return None
    time.sleep(0.25)
    s, t = get(url, 600000)
    if s != 200: return None
    try: d = json.loads(t).get('Data') or {}
    except Exception: return None
    if d.get('StatusDef') not in (None, 'Normal'): return None
    title = d.get('Title') or ''; cat = (d.get('CategoryLevelName') or {}).get('ShopCategory_ShowName') or d.get('CategoryName') or ''
    typ = classify(title, cat)
    imgs = d.get('ImageList') or []
    price = d.get('Price') or d.get('MinPrice')
    if not typ or not imgs or not price: return None
    sizes = []
    for k in d.get('SKUPropertySetList') or []:
      parts = (k.get('PropertyNameSet') or '').split(':')
      for j, p in enumerate(parts):
        if p in ('尺寸', '尺碼', 'SIZE', 'Size', '腰圍', '鞋碼') and j + 1 < len(parts): sizes.append(parts[j + 1])
    pic = imgs[0].get('PicUrl') or ''
    pic = ('https:' + pic) if pic.startswith('//') else pic.replace('http://', 'https://')
    return {'source': '91app:' + host, 'external_id': str(sid), 'brand': brand, 'name': title[:120], 'type': typ, 'gender': gender_of(title + ' ' + cat, gdef),
            'price': int(price), 'currency': 'TWD', 'image_url': pic.split('?')[0], 'buy_url': f'https://{host}/SalePage/Index/{sid}', 'tags': [cat.split('>')[-1].strip(' -')[:20]] if cat else [],
            'sizes': norm_sizes(sizes), 'active': True, 'featured': False}
  rows = []
  with cf.ThreadPoolExecutor(4) as ex:
    for r in ex.map(one, ids):
      if r: rows.append(r)
  rows, counts = pick(rows)
  save('91app:' + host, rows); print(host, shop, len(ids), '->', counts)

# ---------- 商品頁 JSON-LD（網站地圖） ----------
def ld_product(html):
  for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I):
    try: j = json.loads(m.group(1).strip())
    except Exception: continue
    for it in (j if isinstance(j, list) else (j.get('@graph') or [j])):
      if isinstance(it, dict) and 'Product' in str(it.get('@type')):
        off = it.get('offers') or {}
        if isinstance(off, list): off = off[0] if off else {}
        img = it.get('image'); img = img[0] if isinstance(img, list) else (img.get('url') if isinstance(img, dict) else img)
        avail = str(off.get('availability') or '')
        return {'name': it.get('name'), 'image': img, 'price': off.get('price') or off.get('lowPrice'), 'oos': 'OutOfStock' in avail, 'category': it.get('category') or ''}
  return None
LD_SITES = [('www.lativ.com.tw', 'lativ', 'u', None, r'/product/\d+', 360), ('www.crocs.com.tw', 'Crocs', 'u', 'shoes', r'/products/', 160), ('www.vacanza.com.tw', 'VACANZA', 'f', 'accessory', r'/products/', 120)]
def sync_ld(host, brand, gdef, deftype, pat, maxn):
  rp, rt = robots(host)
  maps = re.findall(r'(?im)^sitemap:\s*(\S+)', rt) or [f'https://{host}/sitemap.xml']
  urls = []
  for sm in maps[:4]:
    s, x = get(sm); locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x)
    for sub in [l for l in locs if '.xml' in l.lower() and re.search(r'product', l, re.I)][:4]:
      s2, x2 = get(sub); locs += re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x2)
    urls += [l for l in locs if re.search(pat, l) and '.xml' not in l.lower()]
  urls = [u for u in dict.fromkeys(urls) if '/en/' not in u or host == 'www.vacanza.com.tw'][-maxn:][::-1]
  def one(u):
    if not rp.can_fetch(UA, u): return None
    time.sleep(0.3)
    s, h = get(u, 2000000)
    if s != 200: return None
    p = ld_product(h)
    if not p or not p.get('image') or not p.get('price') or p.get('oos'): return None
    name = (p.get('name') or '').strip()
    typ = classify(name, str(p.get('category')), default=deftype)
    if not typ: return None
    try: price = int(float(str(p['price']).replace(',', '')))
    except Exception: return None
    img = p['image']; img = ('https:' + img) if img.startswith('//') else img
    return {'source': 'web:' + host, 'external_id': re.sub(r'^https?://[^/]+', '', u)[:200], 'brand': brand, 'name': name[:120], 'type': typ, 'gender': gender_of(name, gdef),
            'price': price, 'currency': 'TWD', 'image_url': img, 'buy_url': u, 'tags': [], 'sizes': [], 'active': True, 'featured': False}
  rows = []
  with cf.ThreadPoolExecutor(4) as ex:
    for r in ex.map(one, urls):
      if r: rows.append(r)
  rows, counts = pick(rows)
  save('web:' + host, rows); print(host, len(urls), '->', counts)

only = os.environ.get('ONLY', '')
for host, brand, g in SHOPS91:
  if only and only not in host: continue
  try: sync91(host, brand, g)
  except Exception as e: print(host, 'FAIL', e)
for args in LD_SITES:
  if only and only not in args[0]: continue
  try: sync_ld(*args)
  except Exception as e: print(args[0], 'FAIL', e)
