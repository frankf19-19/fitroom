"""尺寸表探測（第二輪）：UNIQLO／GU 前端程式裡的尺寸 API、lativ 商品 JSON 的 sizeChart、OB 嚴選 91APP 描述格式、PAZZO 系統。
每個網域 ≤ 約 40 個請求、間隔 ≥ 0.4 秒。輸出 out.json。"""
import json, re, gzip, time, urllib.request, urllib.parse
BOT = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
API = 'https://tryon-api.frankccc199.workers.dev'
def get(u, n=12000000, ua=BROWSER, timeout=30, headers=None, data=None):
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
def products(brand, n=3, typ=None):
  s, t = get(f'{API}/api/products?brand={urllib.parse.quote(brand)}&size=12' + (f'&type={typ}' if typ else ''))
  try: return json.loads(t)['products'][:n]
  except Exception: return []
def ctx(text, pat, before=200, after=600, limit=12):
  return [text[max(0, m.start() - before): m.end() + after] for m in list(re.finditer(pat, text))[:limit]]

out = {}
FR = {'uniqlo': ('https://d.uniqlo.com/tw', 'https://www.uniqlo.com', 'https://www.uniqlo.com/tw', 'UNIQLO'),
      'gu': ('https://d.gu-global.com/tw', 'https://www.gu-global.com', 'https://www.gu-global.com/tw', 'GU')}
for key, (D, ORIGIN, WEB, BRAND) in FR.items():
  o = out[key] = {}
  ps = products(BRAND, 1, 'top')
  if not ps: continue
  code = ps[0]['buy_url'].split('productCode=')[-1]; o['code'] = code
  s, h = get(f'{WEB}/zh_TW/product-detail.html?productCode={code}')
  srcs = [x for x in re.findall(r'<script[^>]+src=["\']([^"\']+)', h) if '/build/' in x]
  o['srcs'] = srcs
  allc = {}
  chunk_names = set()
  for src in srcs:
    if 'desktop' not in src and 'vendor' not in src: continue
    u = ORIGIN + src if src.startswith('/') else src
    s, js = get(u)
    o.setdefault('js_len', {})[src] = (s, len(js))
    for pat in [r'size-list', r'spu/', r'/p/product', r'sizeChart["\']?\s*[:(]', r'productSizeChart', r'apiPrefix|API_PREFIX|baseURL|BFF_', r'\.chunk\.js|chunkFilename|"\.bundle\.js"']:
      allc.setdefault(pat, []).extend(ctx(js, pat, 250, 500, 8))
    for m in re.finditer(r'["\']([\w\-/]*productSizeChart[\w\-/]*)["\']', js): chunk_names.add(m.group(1))
  o['ctx'] = allc
  o['chunk_names'] = sorted(chunk_names)

# lativ：商品頁內嵌 JSON 的 sizeChart 結構
o = out['lativ'] = []
for p in products('lativ', 2, 'top') + products('lativ', 1, 'bottom'):
  s, h = get(p['buy_url'], ua=BOT)
  o.append({'url': p['buy_url'], 'ctx': ctx(h, r'"sizeChart', 300, 2500, 3), 'size_keys': sorted(set(re.findall(r'"(size\w*)"\s*:', h)))[:60]})

# OB 嚴選 91APP：服飾的描述欄位格式
o = out['ob'] = []
for typ in ('top', 'bottom', 'dress'):
  for p in products('OB嚴選', 2, typ):
    sid = p['buy_url'].rstrip('/').split('/')[-1]
    s, t = get(f'https://www.obdesign.com.tw/webapi/SalePageV2/GetSalePageV2Info/41602/{sid}', ua=BOT)
    try: d = json.loads(t).get('Data') or {}
    except Exception: d = {}
    o.append({'sid': sid, 'type': typ, 'SubDescript': (d.get('SubDescript') or '')[:1500], 'ShortDescription': (d.get('ShortDescription') or '')[:600], 'Description': (d.get('Description') or '')[:1500], 'Meta': str(d.get('SalePageDetailMetafields'))[:800]})
# GIORDANO／Levi's 的 Description（是不是圖片）
for brand, host, shop in [('GIORDANO', 'www.giordano.com.tw', '42198'), ('Roots', 'www.roots.com.tw', None)]:
  for p in products(brand, 1, 'top'):
    sid = p['buy_url'].rstrip('/').split('/')[-1]
    if not shop:
      s, rt = get(f'https://{host}/robots.txt', ua=BOT); m = re.search(r'Sitemap/(\d+)/Sitemap_Index', rt); shop = m and m.group(1)
    s, t = get(f'https://{host}/webapi/SalePageV2/GetSalePageV2Info/{shop}/{sid}', ua=BOT)
    try: d = json.loads(t).get('Data') or {}
    except Exception: d = {}
    out['ob'].append({'host': host, 'sid': sid, 'SubDescript': (d.get('SubDescript') or '')[:1200], 'Description': (d.get('Description') or '')[:1200], 'Meta': str(d.get('SalePageDetailMetafields'))[:800]})

# PAZZO 系統：頁面裡的 API 線索
o = out['pazzo'] = {}
for p in products('PAZZO', 1, 'top') + products('MEIER.Q', 1, 'top'):
  s, h = get(p['buy_url'], ua=BOT)
  o[p['buy_url']] = {'scripts': re.findall(r'<script[^>]+src=["\']([^"\']+)', h)[:15], 'api': sorted(set(re.findall(r'["\'](/api/[^"\']{3,80})["\']', h)))[:40], 'size_ctx': ctx(h, r'尺寸|size_table|sizeTable|SizeTable', 100, 300, 6)}

json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
print('done')
