"""尺寸表探測（第六輪）：UNIQLO／GU 商品的 sizeAndTryOn.html（官方尺寸表 HTML），並用 sizecharts.py 試解析。每網域 ≤ 16 個請求。輸出 out.json。"""
import json, re, gzip, time, sys, os, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sizecharts as SC
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
API = 'https://tryon-api.frankccc199.workers.dev'
def get(u, headers=None):
  h = {'User-Agent': BROWSER, 'Accept-Language': 'zh-TW,zh;q=0.9'}
  if headers: h.update(headers)
  time.sleep(0.5)
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=30) as r:
      b = r.read(4000000)
      if b[:2] == b'\x1f\x8b': b = gzip.decompress(b)
      return r.status, b.decode('utf-8', 'replace')
  except urllib.error.HTTPError as e: return e.code, ''
  except Exception as e: return 0, 'ERR ' + str(e)[:100]
out = {}
for key, D, WEB, BRAND in [('uniqlo', 'https://d.uniqlo.com/tw', 'https://www.uniqlo.com/tw', 'UNIQLO'), ('gu', 'https://d.gu-global.com/tw', 'https://www.gu-global.com/tw', 'GU')]:
  o = out[key] = []; hdr = {'Origin': WEB.rsplit('/', 1)[0], 'Referer': WEB + '/'}
  for typ in ('top', 'bottom', 'dress', 'shoes'):
    s, t = get(f'{API}/api/products?brand={BRAND}&type={typ}&size=6')
    try: p = json.loads(t)['products'][0]
    except Exception: continue
    code = p['buy_url'].split('productCode=')[-1]
    s, t = get(f'{D}/product/detail?productCode={code}', hdr)
    m = re.search(r'"sizeChart"\s*:\s*"([^"]+)"', t); m2 = re.search(r'"sizeChartH5"\s*:\s*"([^"]+)"', t)
    r = {'type': typ, 'code': code, 'name': p['name'], 'sizeChart': m and m.group(1)}
    if m:
      s, h = get(WEB + m.group(1), hdr)
      r['status'] = s; r['len'] = len(h); r['head'] = h[:7000]
      r['tables'] = len(re.findall(r'<table', h, re.I)); r['imgs'] = re.findall(r'<img[^>]+src=["\']([^"\']+)', h)[:6]
      try: r['parsed'] = SC.parse_tables(h, typ)
      except Exception as e: r['parsed'] = 'ERR ' + str(e)
    if m2:
      s, h2 = get(WEB + m2.group(1), hdr); r['h5_len'] = len(h2); r['h5_head'] = h2[:3000]
    o.append(r)
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
print('done')
