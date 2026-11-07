"""尺寸表探測（第四輪）：UNIQLO／GU 前端設定檔（polyfill bundle）裡的 prodService 與尺寸相關 API，實際打打看。
每個網域 ≤ 30 個請求、間隔 0.4 秒。輸出 out.json。"""
import json, re, gzip, time, urllib.request, urllib.parse
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
API = 'https://tryon-api.frankccc199.workers.dev'
def get(u, headers=None, data=None, n=12000000):
  h = {'User-Agent': BROWSER, 'Accept-Language': 'zh-TW,zh;q=0.9', 'Accept': 'application/json,text/html,*/*;q=0.8'}
  if headers: h.update(headers)
  time.sleep(0.4)
  try:
    req = urllib.request.Request(u, headers=h, data=json.dumps(data).encode() if data is not None else None, method='POST' if data is not None else 'GET')
    if data is not None: req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=30) as r:
      b = r.read(n)
      if b[:2] == b'\x1f\x8b':
        try: b = gzip.decompress(b)
        except Exception: pass
      return r.status, b.decode('utf-8', 'replace')
  except urllib.error.HTTPError as e:
    try: return e.code, e.read(2000).decode('utf-8', 'replace')
    except Exception: return e.code, ''
  except Exception as e: return 0, 'ERR ' + str(e)[:100]

out = {}
for key, ORIGIN, BRAND in [('uniqlo', 'https://www.uniqlo.com', 'UNIQLO'), ('gu', 'https://www.gu-global.com', 'GU')]:
  o = out[key] = {}
  hdr = {'Origin': ORIGIN, 'Referer': ORIGIN + '/tw/'}
  s, t = get(f'{API}/api/products?brand={BRAND}&type=top&size=6')
  ps = json.loads(t)['products']
  s, t2 = get(f'{API}/api/products?brand={BRAND}&type=bottom&size=6')
  ps += json.loads(t2)['products'][:1]
  codes = [p['buy_url'].split('productCode=')[-1] for p in ps[:2]] + [ps[-1]['buy_url'].split('productCode=')[-1]]
  o['codes'] = codes
  s, h = get(f'{ORIGIN}/tw/zh_TW/product-detail.html?productCode={codes[0]}', hdr)
  poly = [x for x in re.findall(r'<script[^>]+src=["\']([^"\']+)', h) if 'polyfill' in x]
  if not poly: continue
  s, js = get(ORIGIN + poly[0])
  svc = {}
  for m in re.finditer(r'(\w+Service)\s*:\s*("[^"]*"|[\w.]+(?:\.concat\([^)]*\))?)', js): svc.setdefault(m.group(1), m.group(2)[:200])
  o['services'] = svc
  o['svc_ctx'] = [js[max(0, m.start() - 300): m.end() + 600] for m in list(re.finditer(r'prodService\s*:', js))[:3]]
  consts = {}
  for m in re.finditer(r'(\w*(?:SIZE|DETAIL|CHART|MEASURE|SPU)\w*_URL)\s*:\s*"[^"]*"\.concat\(\s*n\.(\w+)\s*,\s*"([^"]*)"\)', js): consts[m.group(1)] = (m.group(2), m.group(3))
  o['consts'] = consts
  # prodService 的實際網址：常見寫法 prodService:"".concat(r,"/p/product/i/product")
  base = 'https://d.uniqlo.com/tw' if key == 'uniqlo' else 'https://d.gu-global.com/tw'
  guess = []
  sv = svc.get('prodService', '')
  m = re.search(r'"(/[^"]+)"', sv)
  if m: guess.append(base + m.group(1))
  guess += [base + '/p/product/i/product', base + '/p/product/i', base + '/p/product']
  o['tries'] = []
  for pb in dict.fromkeys(guess):
    for c in codes[:2]:
      for u, body in [(f'{pb}/spu/size-list', {'productCodeList': [c]}), (f'{pb}/spu/size-list', {'productCodes': [c]}), (f'{pb}/spu/size-list', [c]),
                      (f'{pb}/detail?productCode={c}', None), (f'{pb}/detail/{c}', None), (f'{pb}/spu/pc/query/{c}/zh_TW', None)]:
        if len(o['tries']) >= 24: break
        s, t = get(u, hdr, body)
        o['tries'].append((u, body, s, t[:2500]))
        if s == 200 and 'size' in t.lower() and len(t) > 300: break
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
print('done')
