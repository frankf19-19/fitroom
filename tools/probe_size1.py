"""尺寸表探測（第一輪）：UNIQLO／GU 台灣商品尺寸 API、91APP 商品資料、JSON-LD 商品頁的尺寸表 <table>。
每個網域 ≤ 約 40 個請求、間隔 ≥ 0.4 秒。輸出 out.json（加上 js_*.txt 片段）。"""
import json, re, gzip, time, urllib.request, urllib.parse
BOT = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
API = 'https://tryon-api.frankccc199.workers.dev'
def get(u, n=3000000, ua=BROWSER, timeout=25, headers=None, data=None):
  u = urllib.parse.quote(u, safe=':/?&=%#+,;@~')
  h = {'User-Agent': ua, 'Accept-Language': 'zh-TW,zh;q=0.9', 'Accept': 'application/json,text/html,*/*;q=0.8'}
  if headers: h.update(headers)
  time.sleep(0.4)
  try:
    req = urllib.request.Request(u, headers=h, data=json.dumps(data).encode() if data is not None else None, method='POST' if data is not None else 'GET')
    if data is not None: req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=timeout) as r:
      b = r.read(n)
      if b[:2] == b'\x1f\x8b':
        try: b = gzip.decompress(b)
        except Exception: pass
      return r.status, b.decode('utf-8', 'replace')
  except urllib.error.HTTPError as e:
    try: return e.code, e.read(3000).decode('utf-8', 'replace')
    except Exception: return e.code, ''
  except Exception as e: return 0, 'ERR ' + str(e)[:100]

out = {}
def products(brand, n=3):
  s, t = get(f'{API}/api/products?brand={urllib.parse.quote(brand)}&size=6')
  try: return json.loads(t)['products'][:n]
  except Exception: return []

# ---------- UNIQLO / GU ----------
FR = {'uniqlo': ('https://d.uniqlo.com/tw', 'https://www.uniqlo.com', 'https://www.uniqlo.com/tw', 'UNIQLO'),
      'gu': ('https://d.gu-global.com/tw', 'https://www.gu-global.com', 'https://www.gu-global.com/tw', 'GU')}
for key, (D, ORIGIN, WEB, BRAND) in FR.items():
  o = out[key] = {}
  hdr = {'Origin': ORIGIN, 'Referer': ORIGIN + '/'}
  ps = products(BRAND, 2)
  o['products'] = [(p['id'], p['buy_url'], p['type']) for p in ps]
  if not ps: continue
  code = ps[0]['buy_url'].split('productCode=')[-1]
  o['code'] = code
  # 1) 分類 API 的完整一筆（看有哪些欄位）
  body = {"url": "/tw/zh_TW/search.html", "searchFlag": True, "description": code, "pageInfo": {"page": 1, "pageSize": 1}, "belongTo": "pc", "rank": "overall", "priceRange": {"low": 0, "high": 0},
          "color": [], "size": [], "season": [], "material": [], "sex": [], "identity": [], "insideFilterCondition": [], "exclusiveCondition": [], "isCategoryExclusive": "N"}
  s, t = get(D + '/p/search/products/by-category', headers=hdr, data=body)
  o['search_one'] = (s, t[:2500])
  # 2) 候選商品詳細 API
  cands = [f'{D}/p/product/i/product/spu/pc/query/{code}/zh_TW', f'{D}/p/product/i/product/spu/h5/query/{code}/zh_TW',
           f'{D}/p/product/i/product/sizeChart/{code}', f'{D}/p/product/i/product/size/{code}/zh_TW', f'{D}/p/product/i/product/spu/pc/size/{code}/zh_TW',
           f'{WEB}/data/products/spu/zh_TW/{code}.json', f'{WEB}/data/products/zh_TW/{code}.json', f'{WEB}/data/products/prodInfo/zh_TW/{code}.json',
           f'{D}/p/stock/stock/query/zh_TW', f'{D}/p/product/i/product/sku/pc/query/{code}/zh_TW']
  o['cands'] = {}
  for u in cands:
    s, t = get(u, headers=hdr)
    o['cands'][u] = (s, t[:3000])
  # 3) 商品頁 HTML 與 JS：找出含 size 的 API 路徑
  s, h = get(f'{WEB}/zh_TW/product-detail.html?productCode={code}', ua=BROWSER)
  o['page'] = (s, len(h), re.findall(r'<script[^>]+src=["\']([^"\']+)', h)[:30])
  apis = set(); jsn = 0
  for src in re.findall(r'<script[^>]+src=["\']([^"\']+)', h):
    if jsn >= 12: break
    if src.startswith('//'): src = 'https:' + src
    elif src.startswith('/'): src = ORIGIN + src
    if not src.startswith('http') or not re.search(r'uniqlo|gu-global|/tw/', src): continue
    jsn += 1
    s, js = get(src, n=8000000)
    for m in re.finditer(r'["\'`](/?(?:p/)?[a-zA-Z0-9_\-/{}$.]*(?:size|Size|SIZE|measure|Measure|chart|Chart)[a-zA-Z0-9_\-/{}$.]*)["\'`]', js):
      if len(m.group(1)) < 120: apis.add(m.group(1))
    for m in re.finditer(r'.{80}(?:sizeChart|sizeTable|sizeInfo|sizeImg|productSize|measurement).{120}', js):
      apis.add('CTX ' + m.group(0))
      if len(apis) > 400: break
  o['js_size_strings'] = sorted(apis)[:400]

# ---------- 91APP ----------
o = out['91app'] = {}
for brand, host in [('GIORDANO', 'www.giordano.com.tw'), ('OB嚴選', 'www.obdesign.com.tw'), ("Levi's", 'www.levis.com.tw'), ('Lee', 'www.leejeans.com.tw')]:
  ps = products(brand, 1)
  if not ps: continue
  sid = ps[0]['buy_url'].rstrip('/').split('/')[-1]
  s, rt = get(f'https://{host}/robots.txt', ua=BOT)
  m = re.search(r'Sitemap/(\d+)/Sitemap_Index', rt); shop = m and m.group(1)
  r = o[host] = {'sid': sid, 'shop': shop}
  s, t = get(f'https://{host}/webapi/SalePageV2/GetSalePageV2Info/{shop}/{sid}', ua=BOT)
  try:
    d = json.loads(t).get('Data') or {}
    r['keys'] = list(d.keys())
    r['size_fields'] = {k: str(v)[:800] for k, v in d.items() if re.search(r'尺寸|尺碼|cm|CM|胸圍|衣長', str(v))}
  except Exception as e: r['err'] = str(e)
  for u in [f'https://{host}/webapi/SalePageV2/GetSalePageDescription/{shop}/{sid}', f'https://{host}/webapi/SalePage/GetSalePageDescription/{shop}/{sid}',
            f'https://{host}/webapi/SalePageV2/GetSalePageV2Description/{shop}/{sid}', f'https://{host}/webapi/salepage/GetSaleProductDesc/{shop}/{sid}']:
    s, t = get(u, ua=BOT)
    r[u] = (s, len(t), re.findall(r'.{60}(?:胸圍|衣長|肩寬|腰圍|cm).{120}', t)[:6], re.findall(r'<table', t)[:3], re.findall(r'<img[^>]+src=["\']([^"\']+)', t)[:6])

# ---------- JSON-LD／Shopline／Cyberbiz 商品頁：尺寸表 table ----------
o = out['web'] = {}
for brand in ['lativ', 'GOOPi', '50% FIFTY PERCENT', 'Lulus', 'FILA', 'GAP', 'PAZZO', 'MEIER.Q', 'plain-me', 'iROO', 'Queen Shop', 'CACO', 'AIR SPACE', 'Saucony', 'MERRELL', 'Salomon', 'gozo', 'mouggan']:
  ps = products(brand, 2)
  r = o[brand] = []
  for p in ps:
    s, h = get(p['buy_url'], ua=BOT)
    tables = re.findall(r'<table.*?</table>', h, re.S | re.I)
    st = [re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', t))[:600] for t in tables if re.search(r'尺寸|尺碼|胸|腰|肩|衣長|SIZE|Size|cm', t)]
    ctx = re.findall(r'.{0,80}(?:胸圍|衣長|肩寬|腰圍|褲長|胸寬).{0,200}', re.sub(r'<[^>]+>', ' ', h))[:5]
    imgs = re.findall(r'<img[^>]+(?:src|data-src)=["\']([^"\']*(?:size|Size|尺寸|chart)[^"\']*)', h)[:4]
    r.append({'id': p['id'], 'type': p['type'], 'url': p['buy_url'], 'status': s, 'len': len(h), 'size_tables': st[:3], 'ctx': [re.sub(r'\s+', ' ', c) for c in ctx], 'size_imgs': imgs})

json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
print('done')
