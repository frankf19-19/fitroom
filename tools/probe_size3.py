"""尺寸表探測（第三輪）：UNIQLO 前端 webpack 分塊（productSizeChart／productDetails）裡的尺寸 API。
只抓 UNIQLO 一個網域，≤ 45 個請求、間隔 0.4 秒。輸出 out.json。"""
import json, re, gzip, time, urllib.request, urllib.parse
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
API = 'https://tryon-api.frankccc199.workers.dev'
N = [0]
def get(u, n=15000000, headers=None, data=None):
  N[0] += 1
  if N[0] > 45: return -1, ''
  h = {'User-Agent': BROWSER, 'Accept-Language': 'zh-TW,zh;q=0.9', 'Accept': 'application/json,text/html,*/*;q=0.8', 'Origin': 'https://www.uniqlo.com', 'Referer': 'https://www.uniqlo.com/tw/'}
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
    try: return e.code, e.read(3000).decode('utf-8', 'replace')
    except Exception: return e.code, ''
  except Exception as e: return 0, 'ERR ' + str(e)[:100]
def ctx(text, pat, before=200, after=600, limit=10):
  return [text[max(0, m.start() - before): m.end() + after] for m in list(re.finditer(pat, text))[:limit]]

out = {}
s, t = get(f'{API}/api/products?brand=UNIQLO&type=top&size=6')
code = json.loads(t)['products'][0]['buy_url'].split('productCode=')[-1]; out['code'] = code
s, h = get(f'https://www.uniqlo.com/tw/zh_TW/product-detail.html?productCode={code}')
srcs = [x for x in re.findall(r'<script[^>]+src=["\']([^"\']+)', h) if '/build/' in x]
js = {}
for src in srcs:
  s, j = get('https://www.uniqlo.com' + src); js[src] = j
out['loader_ctx'] = {}
for src, j in js.items():
  c = ctx(j, r'\.chunk\.js|"\.js"|\+"\.js|chunk\.[a-z]*\.?js|jsonpScriptSrc|\.p\+"', 1500, 600, 3)
  if c: out['loader_ctx'][src] = c
  for m in re.finditer(r'size-list|sizeChart|product-size', j): out.setdefault('hits', []).append((src, j[max(0, m.start() - 300): m.end() + 300]))
# 嘗試從 loader 附近取出 {id:"hash"} 對照
pairs = {}; names = {}
for src, cs in out['loader_ctx'].items():
  for c in cs:
    for a, b in re.findall(r'(\d+):"([0-9a-f]{8,32})"', c): pairs[a] = b
    for a, b in re.findall(r'(\d+):"([A-Za-z][\w/\-]{2,60})"', c): names[a] = b
out['pairs_n'] = len(pairs); out['names'] = names
base = 'https://www.uniqlo.com/tw/build/'
fmt = None
for a, b in list(pairs.items())[:3]:
  for f in ['{id}.{hash}.chunk.js', '{id}.{hash}.bundle.js', '{hash}.js', '{id}.{hash}.js', '{name}.{hash}.chunk.js']:
    u = base + f.format(id=a, hash=b, name=names.get(a, a))
    s, j = get(u)
    if s == 200 and len(j) > 100: fmt = f; break
  if fmt: break
out['fmt'] = fmt
found = {}
if fmt:
  order = sorted(pairs, key=lambda a: (0 if re.search(r'product|size', names.get(a, ''), re.I) else 1, int(a)))
  for a in order:
    if N[0] >= 44: break
    s, j = get(base + fmt.format(id=a, hash=pairs[a], name=names.get(a, a)))
    if s != 200: continue
    hits = sorted(set(m for m in re.findall(r'["\'`]([\w\-/{}$.]*(?:size|Size|spu|/i/product|measure)[\w\-/{}$.]*)["\'`]', j) if 4 < len(m) < 120))
    if hits or 'productSizeChart' in j: found[a] = {'name': names.get(a), 'hits': hits[:60], 'ctx': ctx(j, r'size-list|sizeChart|spu/|i/product', 300, 500, 6)}
out['chunks'] = found
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
print('done', N[0])
