#!/usr/bin/env python3
"""台灣品牌官網商品同步（測試用，無聯盟分潤）：91APP 平台品牌 + 商品頁結構化資料（JSON-LD）。
遵守 robots.txt、放慢請求。環境變數：SUPABASE_URL、SUPABASE_SERVICE_KEY。用法：python3 tools/sync_tw.py [每家每類幾件，預設 12]
"""
import json, os, re, sys, time, gzip, urllib.request, urllib.parse, urllib.robotparser, concurrent.futures as cf, html as html_mod
import sizecharts as SC   # 商品尺寸表（tools/sizecharts.py）

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

SKIP = re.compile(r'襪|內衣|內褲|內著|胸罩|bra\b|禮盒|禮卡|口罩|浴巾|毛巾|雨傘|陽傘|保養|香氛|清潔|鞋墊|鞋帶|水壺|杯|貼紙|吊飾|鑰匙圈|童|兒童|嬰|寶寶|baby|kids|kid\'s|youth|toddler|mask|sock|gift|加購|運費|補差價|會員|兌換|贈品|福袋|試穿|預購金|玩偶|娃娃|碗|盤子|餐具|筷|擴香|蠟燭|香水|毛毯|毯子|抱枕|靠墊|收納盒|寵物|手機殼|衝浪板|紅包', re.I)
RULES = [
  ('shoes', r'鞋|靴(?!型)|拖(?!特)|涼鞋|sneaker|shoe|slip-on|sandal|boot(?!cut)|clog|克駱格|洞洞|old skool|sk8|authentic|knu skool|loafer|mule\b|樂福|穆勒|瑪莉珍|mexico 66|gel-|\bheels?\b'),
  ('dress', r'洋裝|連身|吊帶裙|罩衫裙|jumpsuit|dress'),
  ('hat', r'(?<![連附拆])帽(?![Tt外上])|\bcap\b|beanie|bucket hat|毛帽|棒球帽|漁夫帽'),
  ('top', r'上衣|T恤|tee|t-shirt|襯衫|外套|夾克|毛衣|針織|背心|帽T|帽t|大學T|大學t|POLO|polo|衛衣|罩衫|西裝|大衣|羽絨|風衣|開襟|小可愛|衫|jacket|shirt|hoodie|sweater|coat|top\b|crew|fleece|cardigan|vest'),
  ('bottom', r'褲|裙|jean|pants|shorts|skirt|jogger|chino|legging'),
  ('accessory', r'(?<![口麵])包|(?<![口麵])袋|錢夾|皮夾|卡夾|零錢|項鍊|項鏈|墜飾|耳環|耳夾|耳針|耳骨|手環|手鍊|手鐲|戒指|胸針|手錶|腕錶|墨鏡|眼鏡|皮帶|腰帶|圍巾|披肩|絲巾|髮夾|髮圈|髮箍|髮帶|髮飾|necklace|earring|bracelet|\bring\b|bag|tote|backpack|crossbody|clutch|pouch|wallet|belt|scarf|watch|sunglass|bangle|pendant|charm'),
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
  charts = [dict(r) for r in rows]                              # 尺寸表另外存 Storage（_chart 不進資料表）
  rows = [{k: v for k, v in r.items() if k != '_chart'} for r in rows]
  _save(src, rows)
  try: SC.write_charts(lambda path: sb('GET', path), src, charts)
  except Exception as e: print(src, 'size charts FAIL', e)
def _save(src, rows):
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
    k = (r['brand'], r['type'])   # 多品牌館（and ST、STRIPE CLUB、USAGI ONLINE）每個品牌各自算上限
    if counts.get(k, 0) >= PER: continue
    counts[k] = counts.get(k, 0) + 1; out.append(r)
  return out, {(f'{b}/{t}' if multi(out) else t): n for (b, t), n in counts.items()}
def multi(rows): return len({r['brand'] for r in rows}) > 1

# ---------- 91APP ----------
SHOPS91 = [('www.obdesign.com.tw', 'OB嚴選', 'f'), ('www.giordano.com.tw', 'GIORDANO', 'u'), ('www.vans.com.tw', 'VANS', 'u'), ('www.adidas.com.tw', 'adidas', 'u'),
           ('www.roots.com.tw', 'Roots', 'u'), ('www.edwin.com.tw', 'EDWIN', 'u'), ('www.timberland.com.tw', 'Timberland', 'u'), ("www.levis.com.tw", "Levi's", 'u'),
           ('tw.puma.com', 'PUMA', 'u'), ('www.thenorthface.com.tw', 'The North Face', 'u'), ('www.underarmour.tw', 'Under Armour', 'u'), ('www.columbiasportswear.com.tw', 'Columbia', 'u'),
           ('www.onitsukatiger.com.tw', 'Onitsuka Tiger', 'u'), ('www.leejeans.com.tw', 'Lee', 'u'), ('www.mlb-korea.com.tw', 'MLB', 'u'), ('www.alasha.com.tw', 'à la sha', 'f'),
           ('www.lacoste.com.tw', 'LACOSTE', 'u'), ('www.kipling.com.tw', 'Kipling', 'f'), ('www.bigtrain.com.tw', 'BIG TRAIN', 'u'),
           # 多品牌館：品牌名取分類第一層（and ST＝niko and...／GLOBAL WORK／LOWRYS FARM…；STRIPE CLUB＝earth music&ecology／Samansa Mos2…）
           ('www.dot-st.tw', '*', 'f'), ('www.stripe-club.com.tw', '*', 'f')]
BRAND_FIX = {'EARTH MUSIC & ECOLOGY': 'earth music&ecology', 'EARTH MUSIC&ECOLOGY': 'earth music&ecology', 'NIKO AND ...': 'niko and...', 'NIKO AND...': 'niko and...'}
def sub_brand(cat, title):
  m = re.search(r'\s-\s([A-Za-z][\w&.\' ]{1,30})$', title or '')   # STRIPE CLUB：「…(編號) - Samansa Mos2」
  b = m.group(1) if m else re.split(r'\s*>\s*', cat or '')[0]
  b = re.sub(r'[^\w&.\' +\-]', '', b).strip()
  if not b or re.search(r'[\u4e00-\u9fff]', b) or len(b) > 30 or re.search(r'(?i)^(new|sale|outlet|top|best|all|men|women|ladies|kids)$', b): return None
  return BRAND_FIX.get(b.upper(), b)
SIZE_TITLE = re.compile(r'尺寸|尺碼|size|腰圍|鞋碼|鞋號|碼數|規格', re.I)
def sku_sizes(d):
  """91APP 規格：優先用 MajorList 的「尺寸」規格清單；沒有就從 SKU 的 PropertyNameSet（「-1:-1:顏色:黑;-1:-1:尺寸:M」）取。"""
  for major in d.get('MajorList') or []:
    for sku in major.get('SKUList') or []:
      names = [str(x.get('Name') or '').strip() for x in sku.get('PropertyList') or []]
      if names and (SIZE_TITLE.search(sku.get('Title') or '') or sum(bool(re.fullmatch(r'(?i)(XXS|XS|S|M|L|XL|XXL|[2-4]XL|F|FREE|\d{1,2}(\.5)?|UK ?\d.*|US ?\d.*|\d{2}(\.5)?CM)', n)) for n in names) >= max(1, len(names) - 1)):
        names = [SC.split_color_size(n) or n for n in names if n]   # 「15灰M」→「M」
        return list(dict.fromkeys(names))
  out = []
  for k in d.get('SKUPropertySetList') or []:
    for part in (k.get('PropertyNameSet') or '').split(';'):
      bits = part.split(':')
      v = SC.split_color_size(bits[3]) or bits[3] if len(bits) >= 4 else None
      if v and SIZE_TITLE.search(bits[2]) and v not in out: out.append(v)
  return out
stats = {'blocked': 0}
def sync91(host, brand, gdef):
  rp, rt = robots(host)
  m = re.search(r'Sitemap/(\d+)/Sitemap_Index', rt); shop = m and m.group(1)
  if not shop: print(host, 'no shop id'); return
  st, x = get(f'https://{host}/Sitemap/sitemap_ShopSalePage.xml.gz')
  ids = sorted({int(i) for i in re.findall(r'SalePage/Index/(\d+)', x)}, reverse=True)[:int(os.environ.get('MAXIDS', '400' if brand == '*' else '240'))]
  if not ids: print(host, 'no salepages'); return
  def one(sid):
    url = f'https://{host}/webapi/SalePageV2/GetSalePageV2Info/{shop}/{sid}'
    if not rp.can_fetch(UA, f'https://{host}/SalePage/Index/{sid}'): return None
    time.sleep(0.4)
    s, t = get(url, 600000)
    if s in (403, 429): stats['blocked'] += 1
    if s != 200: return None
    try: d = json.loads(t).get('Data') or {}
    except Exception: return None
    if d.get('StatusDef') not in (None, 'Normal'): return None
    title = d.get('Title') or ''; cat = (d.get('CategoryLevelName') or {}).get('ShopCategory_ShowName') or d.get('CategoryName') or ''
    typ = classify(title, cat)
    b = brand
    if brand == '*':
      b = sub_brand(cat, title)
      if not b: return None
      title = re.sub(r'\s-\s' + re.escape(b) + r'$', '', title, flags=re.I)
    imgs = d.get('ImageList') or []
    price = d.get('Price') or d.get('MinPrice')
    if not typ or not imgs or not price: return None
    sizes = sku_sizes(d)
    desc = ' '.join(str(d.get(k) or '') for k in ('SubDescript', 'ShortDescription', 'Description'))
    chart = SC.pick_chart(desc, typ, title, f'商品頁尺寸表 https://{host}/SalePage/Index/{sid}') if '<table' in desc else None
    pic = imgs[0].get('PicUrl') or ''
    pic = ('https:' + pic) if pic.startswith('//') else pic.replace('http://', 'https://')
    return {'source': '91app:' + host, 'external_id': str(sid), 'brand': b, 'name': title[:120], 'type': typ, 'gender': gender_of(title + ' ' + cat, gdef),
            'price': int(price), 'currency': 'TWD', 'image_url': pic.split('?')[0], 'buy_url': f'https://{host}/SalePage/Index/{sid}', 'tags': [cat.split('>')[-1].strip(' -')[:20]] if cat else [],
            'sizes': norm_sizes(sizes) or SC.chart_sizes(chart)[:20], 'active': True, 'featured': False, '_chart': chart}
  rows = []
  with cf.ThreadPoolExecutor(3) as ex:
    for r in ex.map(one, ids):
      if r: rows.append(r)
  rows, counts = pick(rows)
  if not rows and stats['blocked']: print(host, 'blocked', stats); return   # 被擋時不要把舊商品下架
  save('91app:' + host, rows); print(host, shop, len(ids), '->', counts, stats)

# ---------- 商品頁 JSON-LD（網站地圖） ----------
def meta(html, prop):
  m = re.search(r'<meta[^>]+(?:property|name|itemprop)=["\']%s["\'][^>]+content=["\']([^"\']+)' % re.escape(prop), html, re.I) or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name|itemprop)=["\']%s["\']' % re.escape(prop), html, re.I)
  return m and m.group(1).strip()
def ld_product(html):
  fallback_price = (re.search(r'itemprop=["\']price["\'][^>]*content=["\']([\d.,]+)', html) or re.search(r'property=["\'](?:product:price:amount|og:price)["\'][^>]*content=["\']([\d.,]+)', html)
                    or re.search(r"var _price = '([\d.]+)'", html) or [None, None])[1]
  for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I):
    raw = re.sub(r'"@context":\s*(https?://[^",\s]+)', r'"@context": "\1"', m.group(1).strip())   # CACO 的 @context 沒加引號
    raw = re.sub(r'(\d)，', r'\1,', raw)   # CACO 的價格後面是全形逗號
    try: j = json.loads(raw)
    except Exception: continue
    for it in (j if isinstance(j, list) else (j.get('@graph') or [j])):
      if isinstance(it, dict) and 'Product' in str(it.get('@type')):
        off = it.get('offers') or {}
        if isinstance(off, list): off = off[0] if off else {}
        img = it.get('image'); img = (img[0] if img else None) if isinstance(img, list) else (img.get('url') if isinstance(img, dict) else img)
        if isinstance(img, dict): img = img.get('url') or img.get('contentUrl')
        avail = str(off.get('availability') or '')
        br = it.get('brand'); br = (br.get('name') if isinstance(br, dict) else br) or ''
        return {'name': it.get('name'), 'image': img, 'price': off.get('price') or off.get('lowPrice') or fallback_price, 'oos': 'OutOfStock' in avail, 'category': it.get('category') or '', 'brand': str(br)}
  # Queen Shop／Lovfee（同一套 ASP.NET）：沒有 JSON-LD／OG，名稱與價格在 GTM dataLayer 的 view_item，圖片是 photo.<網域>/<編號>/<編號>-<色>-01.jpg
  m = re.search(r'dataLayer\.push\((\{"event":"view_item".*?\})\);', html)
  if m:
    try:
      it = json.loads(m.group(1))['ecommerce']['items'][0]; iid = str(it.get('item_id') or '')
      ims = [u for u in re.findall(r'(https?://[^"\'\s>]+?\.(?:jpe?g|png|webp))', html, re.I) if iid and iid in u and 'ColorIcon' not in u]
      if ims and it.get('price'): return {'name': it.get('item_name'), 'image': ims[0], 'price': it['price'], 'oos': False, 'category': str(it.get('item_brand') or '') + ' ' + str(it.get('item_category') or '')}
    except Exception: pass
  # JSON-LD 壞掉或沒有時（plain-me、D+AF、PEDRO）退回 Open Graph
  t, im = meta(html, 'og:title'), meta(html, 'og:image')
  if t and im and fallback_price:
    t = re.split(r'\s*[│|｜]\s*', t)[0].strip()
    return {'name': t, 'image': im, 'price': fallback_price, 'oos': False, 'category': ''}
  return None
# (網域, 品牌, 預設性別, 預設類別, 商品網址樣式, 最多看幾個商品網址)
LD_SITES = [('www.lativ.com.tw', 'lativ', 'u', None, r'/product/\d+', 360), ('www.crocs.com.tw', 'Crocs', 'u', 'shoes', r'/products/', 160), ('www.vacanza.com.tw', 'VACANZA', 'f', 'accessory', r'/products/', 120),
            # PAZZO／MEIER.Q／Mercci22 同一套系統：/market/n/<id>（網站地圖另有 /zh-tw/、/en-us/ 重複網址，會去重）
            ('www.pazzo.com.tw', 'PAZZO', 'f', None, r'\.tw/market/n/\d+$', 240, 'id_desc'), ('www.meierq.com', 'MEIER.Q', 'f', None, r'\.com/market/n/\d+$', 240, 'id_desc'), ('www.mercci22.com', 'Mercci22', 'f', None, r'\.com/market/n/\d+$', 240, 'id_desc'),
            # Shopline：/zh-hant/products/<handle>
            ('www.50-shop.com', '50% FIFTY PERCENT', 'u', None, r'/(zh-hant/)?products/', 240), ('www.lulus.com.tw', 'Lulus', 'f', None, r'/(zh-hant/)?products/', 240),
            # Cyberbiz：/products/<handle>
            ('www.fila.com.tw', 'FILA', 'u', None, r'/products/', 240),
            # GAP 台灣：/pdp/<id>/<sku>，JSON-LD 沒價格、用 itemprop=price 補
            ('www.gap.tw', 'GAP', 'u', None, r'/pdp/', 240),
            # Grace Gift：robots 的 Sitemap 指到 /sitemap/index → /sitemap/shoe/0、/sitemap/bag/0
            ('www.gracegift.com.tw', 'Grace Gift', 'f', None, r'/products/\d+/\d+', 240),
            # 2026-11-07 新增（probe_tw9~11.py）
            ('www.mouggan.com', 'mouggan', 'f', None, r'\.com/market/n/\d+$', 240, 'id_desc'),   # 同 PAZZO 系統
            ('www.goopi.co', 'GOOPi', 'u', None, r'/(zh-hant/)?products/', 240),   # Shopline
            ('www.merrell.com.tw', 'MERRELL', 'u', None, r'/products/', 240), ('www.jansport.com.tw', 'JanSport', 'u', 'accessory', r'/products/', 200),
            ('www.saucony.com.tw', 'Saucony', 'u', None, r'/products/', 240),   # Cyberbiz
            ('lesportsac.tw', 'LeSportsac', 'f', 'accessory', r'lesportsac\.tw/products/', 200, 'tail', {'sitemaps': ['https://lesportsac.tw/sitemap.xml']}),   # Shopify
            ('www.airspaceonline.com', 'AIR SPACE', 'f', None, r'/tw/zh-hant/product/', 240, 'tail', {'sitemaps': ['https://www.airspaceonline.com/sitemap_TW.xml']}),
            # Salesforce Commerce Cloud 台灣站：robots 有 Crawl-delay（C&K 10 秒、PEDRO 5 秒）就照著慢慢抓
            ('www.charleskeith.com', 'CHARLES & KEITH', 'f', None, r'charleskeith\.com/tw/[^/]+\.html$', 75, 'tail', {'sitemaps': ['https://www.charleskeith.com/tw/sitemap_index.xml'], 'delay': 10}),
            ('www.pedroshoes.com', 'PEDRO', 'u', None, r'pedroshoes\.com/tw/[^/]+\.html$', 130, 'tail', {'sitemaps': ['https://www.pedroshoes.com/tw/sitemap_index.xml'], 'delay': 5}),
            ('www.longchamp.com', 'Longchamp', 'f', None, r'longchamp\.com/tw/zh/products/', 200, 'tail', {'sitemaps': ['https://www.longchamp.com/tw/zh/sitemap-stmp_zh_TW_index.xml']})]
def sync_ld(host, brand, gdef, deftype, pat, maxn, order='tail', opts=None):
  opts = opts or {}
  rp, rt = robots(host)
  maps = opts.get('sitemaps') or re.findall(r'(?im)^sitemap:\s*(\S+)', rt) or [f'https://{host}/sitemap.xml']
  urls = []
  for sm in maps[:4]:
    s, x = get(sm); locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x)
    subs = [l for l in locs if '.xml' in l.lower() or '/sitemap/' in l.lower()]
    for sub in ([l for l in subs if re.search(r'product|shoe|bag', l, re.I)] or subs)[:4]:
      time.sleep(0.3); s2, x2 = get(sub); locs += re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x2)
    urls += [l for l in locs if re.search(pat, l) and '.xml' not in l.lower() and '/sitemap/' not in l.lower()]
  seen_key = set(); uniq = []
  for u in urls:
    if ('/en/' in u or '/en-us/' in u) and host != 'www.vacanza.com.tw': continue
    k = re.sub(r'^https?://[^/]+', '', u); k = re.sub(r'^/(zh-hant|zh-tw|zh-TW)(?=/)', '', k).rstrip('/')
    if k in seen_key: continue
    seen_key.add(k); uniq.append(u)
  if order == 'id_desc':   # 網站地圖沒排序時，用網址裡的商品編號由大到小（新品優先）
    urls = sorted(uniq, key=lambda u: int((re.findall(r'\d+', u) or ['0'])[-1]), reverse=True)[:maxn]
  else: urls = uniq[-maxn:][::-1]
  rows, counts = pick(fetch_rows(host, brand, gdef, deftype, urls, rp, opts.get('delay', 0.3)))
  if not rows: print(host, 'no rows', len(urls)); return
  save('web:' + host, rows); print(host, len(urls), '->', counts)

_ROBOTS = {}
def robots_ok(u):
  host = urllib.parse.urlparse(u).netloc
  if host not in _ROBOTS: _ROBOTS[host] = robots(host)[0]
  return _ROBOTS[host].can_fetch(UA, u)
def fetch_rows(host, brand, gdef, deftype, urls, rp, delay=0.3):
  def one(u):
    try: return one_(u)
    except Exception as e: print('  skip', u[:100], repr(e)[:80]); return None
  def one_(u):
    if not rp.can_fetch(UA, u): return None
    time.sleep(delay)
    s, h = get(u, 2000000)
    if s != 200: return None
    p = ld_product(h)
    if not p or not p.get('image') or not p.get('price') or p.get('oos'): return None
    name = html_mod.unescape((p.get('name') or '').strip())
    typ = classify(name, str(p.get('category')), default=deftype)
    if not typ: return None
    try: price = int(float(str(p['price']).replace(',', '')))
    except Exception: return None
    if price <= 0: return None
    img = p['image'].strip(); img = ('https:' + img) if img.startswith('//') else ('https://' + host + img if img.startswith('/') else img)
    b = brand
    if brand == '*':   # 多品牌館（USAGI ONLINE）：品牌取 JSON-LD 的 brand
      b = re.sub(r'(?i)\s+hom(m)?e$', '', (p.get('brand') or '').strip())
      b = {'GELATO PIQUE': 'gelato pique', 'LILY BROWN': 'Lily Brown'}.get(b.upper(), b)
      if not b or len(b) > 30: return None
    chart = SC.pick_chart(h, typ, name, '商品頁尺寸表 ' + u)   # 同一份 HTML，不多花請求
    pop = not chart and typ in ('top', 'bottom', 'dress') and re.search(r"popSizeChart\('(https://[^']+\.html?)'\)", h)   # Queen Shop：尺寸表在另一個小頁面
    if pop and robots_ok(pop.group(1)):
      time.sleep(delay); s2, h2 = get(pop.group(1), 600000)
      if s2 == 200: chart = SC.pick_chart(h2, typ, name, '商品尺寸表 ' + pop.group(1))
    return {'source': 'web:' + host, 'external_id': re.sub(r'^https?://[^/]+', '', u)[:200], 'brand': b, 'name': name[:120], 'type': typ, 'gender': gender_of(name, gdef),
            'price': price, 'currency': 'TWD', 'image_url': img, 'buy_url': u, 'tags': [], 'sizes': SC.chart_sizes(chart)[:20], 'active': True, 'featured': False, '_chart': chart}
  rows = []
  with cf.ThreadPoolExecutor(1 if delay >= 2 else 4) as ex:   # 有 Crawl-delay 的網站單線慢慢抓
    for r in ex.map(one, urls):
      if r: rows.append(r)
  return rows

# ---------- 沒有網站地圖的官網：從首頁／分類頁找商品頁 ----------
def links_in(html, base, page=None):
  out = []
  for m in re.findall(r'(?:href|data-href|data-url)=["\']([^"\'#]+)', html):
    m = m.replace('&amp;', '&').strip()
    if m.startswith('//'): m = 'https:' + m
    elif m.startswith('/'): m = base + m
    elif page and re.match(r'^[A-Za-z][\w\-]*\?', m): m = urllib.parse.urljoin(page, m)   # Queen Shop 的「Product?…&SaleID=」相對網址
    elif not m.startswith('http'): continue
    m = re.sub(r'(QueenShop/Product)\?.*?(SaleID=\w+).*$', r'\1?\2', m)   # 同商品不同分類參數只留一個
    out.append(m)
  return list(dict.fromkeys(out))
# (網域, 品牌, 預設性別, 預設類別, 起始頁, 分類頁網址樣式（None=起始頁就是分類頁）, 商品頁網址樣式, 最多看幾個分類頁, 最多看幾個商品頁)
LIST_SITES = [
  ('www.birkenstock.com.tw', 'BIRKENSTOCK', 'u', 'shoes', ['https://www.birkenstock.com.tw/'], r'/product_(?:category|store)\?', r'/product_detail\?product_sn=\d+&color_sn=\d+$', 14, 200),
  # plain-me：商品圖曾擋 Worker 代理（502）；Worker 已改成被擋時用瀏覽器 UA＋Referer 重試，2026-11-07 重新開啟（圖片仍失敗就再下架）
  ('www.plain-me.com', 'plain-me', 'u', None, ['https://www.plain-me.com/men/', 'https://www.plain-me.com/women/', 'https://www.plain-me.com/men/product-tags/新品', 'https://www.plain-me.com/women/product-tags/新品'], None, r'/(?:men|women)/product-detail/[\w\-]+$', 0, 240),
  ('www.daf-shoes.com', 'D+AF', 'f', 'shoes', ['https://www.daf-shoes.com/'], r'/product/list/\d+$', r'/product/show/\d+/\d+/?$', 10, 200),
  ('www.caco.com.tw', 'CACO', 'u', None, [f'https://www.caco.com.tw/productlist/{c}?page={pg}' for c in ('51401', '14304', '14338', '143021', '142021', '14332') for pg in (1, 2)], None, r'/product/[A-Z0-9]+/\d+$', 0, 160),
  # Queen Shop（ASP.NET，無 JSON-LD）：資料取自 GTM dataLayer 的 view_item（ld_product 的備援）
  ('www.queenshop.com.tw', 'Queen Shop', 'f', None, ['https://www.queenshop.com.tw/'] + [f'https://www.queenshop.com.tw/zh-TW/QueenShop/ProductList?item1={c}' for c in ('00', '01', '02', '03', '20')],
   r'QueenShop/ProductList\?item1=\d+(&item2=\w+)?(&item3=\w+)?$', r'QueenShop/Product\?SaleID=\w+$', 12, 220),
  # USAGI ONLINE（MASH 台灣：SNIDEL、gelato pique、FRAY I.D、Mila Owen、lily brown…）：品牌取 JSON-LD 的 brand
  ('www.usagi-online.com.tw', '*', 'f', None, ['https://www.usagi-online.com.tw/', 'https://www.usagi-online.com.tw/productlist?other=newarrival'],
   r'productlist\?item1=\d+&item2=\w+$', r'product\?saleid=\w+$', 14, 300),
  # iROO、gozo：fonlego 系統（同 plain-me），商品頁有 JSON-LD
  ('www.iroo.com', 'iROO', 'f', None, [f'https://www.iroo.com/iroo/products/allproduct/{c}' for c in ('newarrival', 'tops', 'dresses', 'pants', 'skirts', 'outer', 'accessories')], None, r'/iroo/product-detail/\w+$', 0, 200),
  ('www.gozo.com.tw', 'gozo', 'f', None, ['https://www.gozo.com.tw/'], r'gozo\.com\.tw/gozo/products/[\w\-/]+$', r'/gozo/product-detail/\w+$', 8, 200),
]
def sync_list(host, brand, gdef, deftype, seeds, list_pat, detail_pat, max_lists, maxn):
  rp, _ = robots(host); base = 'https://' + host
  def crawl(u):
    if not rp.can_fetch(UA, u): return []
    time.sleep(0.4); s, h = get(u, 2000000)
    return links_in(h, base, u) if s == 200 else []
  found = []
  for u in seeds: found += crawl(u)
  if list_pat:
    lists = [l for l in dict.fromkeys(found) if re.search(list_pat, l) and host in l][:max_lists]
    for l in lists: found += crawl(l)
  found = [re.sub(r'&colorid=\w+$', '', l) for l in found]   # USAGI ONLINE 同商品不同色只留一個
  urls = [l for l in dict.fromkeys(found) if re.search(detail_pat, l) and host in l][:maxn]
  rows, counts = pick(fetch_rows(host, brand, gdef, deftype, urls, rp))
  if not rows: print(host, 'no rows', len(urls)); return
  save('web:' + host, rows); print(host, len(urls), '->', counts)

# ---------- Shopify：/products.json ----------
SHOPIFY = [('salomon.com.tw', 'Salomon', 'u', None)]   # LeSportsac 的 products.json 只回 3 件，改走網站地圖＋JSON-LD（LD_SITES）
def sync_shopify(host, brand, gdef, deftype):
  rp, _ = robots(host); rows = []
  for page in (1, 2, 3):
    time.sleep(0.5); st, t = get(f'https://{host}/products.json?limit=100&page={page}', 12000000)
    try: ps = json.loads(t)['products']
    except Exception: print(host, 'bad json', st); break
    for p in ps:
      u = f"https://{host}/products/{p['handle']}"
      if not rp.can_fetch(UA, u): continue
      vs = [v for v in p.get('variants') or [] if v.get('available', True)]
      ims = p.get('images') or []
      if not vs or not ims: continue
      tags = p.get('tags') or []; tags = tags if isinstance(tags, list) else tags.split(',')
      typ = classify(p['title'], (p.get('product_type') or '') + ' ' + ' '.join(tags), default=deftype)
      if not typ: continue
      try: price = int(float(vs[0]['price']))
      except Exception: continue
      if price <= 0: continue
      chart = SC.pick_chart(p.get('body_html') or '', typ, p['title'], '商品頁尺寸表 ' + u)
      sizes = [v.get('option2') or v.get('option1') for v in vs if re.fullmatch(r'(?i)(XXS|XS|S|M|L|XL|XXL|2XL|3XL|\d{2}(\.5)?)', str(v.get('option2') or v.get('option1') or ''))]
      rows.append({'source': 'shop:' + host, 'external_id': str(p['id']), 'brand': brand, 'name': p['title'][:120], 'type': typ, 'gender': gender_of(p['title'] + ' ' + ' '.join(tags), gdef),
                   'price': price, 'currency': 'TWD', 'image_url': ims[0]['src'].split('?')[0], 'buy_url': u, 'tags': [], 'sizes': norm_sizes(sizes) or SC.chart_sizes(chart)[:20], 'active': True, 'featured': False, '_chart': chart})
    if len(ps) < 100: break
  rows, counts = pick(rows)
  if not rows: print(host, 'no rows'); return
  save('shop:' + host, rows); print(host, '->', counts)

only = os.environ.get('ONLY', '')
for host, brand, g in SHOPS91:
  if only and only not in host: continue
  try: sync91(host, brand, g)
  except Exception as e: print(host, 'FAIL', e)
for args in LD_SITES:
  if only and only not in args[0]: continue
  try: sync_ld(*args)
  except Exception as e: print(args[0], 'FAIL', e)
for args in LIST_SITES:
  if only and only not in args[0]: continue
  try: sync_list(*args)
  except Exception as e: print(args[0], 'FAIL', e)
for args in SHOPIFY:
  if only and only not in args[0]: continue
  try: sync_shopify(*args)
  except Exception as e: print(args[0], 'FAIL', e)
