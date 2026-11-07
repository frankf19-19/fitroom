"""尺寸表探測（第五輪）：UNIQLO／GU /product/spu/size-list 完整回應與 /product/detail 的尺寸欄位。每網域 ≤ 12 個請求。輸出 out.json。"""
import json, re, gzip, time, urllib.request
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
API = 'https://tryon-api.frankccc199.workers.dev'
def get(u, headers=None, data=None):
  h = {'User-Agent': BROWSER, 'Accept-Language': 'zh-TW,zh;q=0.9', 'Accept': 'application/json,*/*'}
  if headers: h.update(headers)
  time.sleep(0.5)
  try:
    req = urllib.request.Request(u, headers=h, data=json.dumps(data).encode() if data is not None else None, method='POST' if data is not None else 'GET')
    if data is not None: req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=30) as r:
      b = r.read(8000000)
      if b[:2] == b'\x1f\x8b': b = gzip.decompress(b)
      return r.status, b.decode('utf-8', 'replace')
  except urllib.error.HTTPError as e: return e.code, e.read(1500).decode('utf-8', 'replace')
  except Exception as e: return 0, 'ERR ' + str(e)[:100]
out = {}
for key, D, ORIGIN, BRAND in [('uniqlo', 'https://d.uniqlo.com/tw', 'https://www.uniqlo.com', 'UNIQLO'), ('gu', 'https://d.gu-global.com/tw', 'https://www.gu-global.com', 'GU')]:
  o = out[key] = {}; hdr = {'Origin': ORIGIN, 'Referer': ORIGIN + '/tw/'}
  codes = []
  for typ in ('top', 'bottom', 'dress', 'shoes'):
    s, t = get(f'{API}/api/products?brand={BRAND}&type={typ}&size=6')
    try: codes += [p['buy_url'].split('productCode=')[-1] for p in json.loads(t)['products'][:1]]
    except Exception: pass
  o['codes'] = codes
  s, t = get(D + '/product/spu/size-list', hdr, codes)
  o['size_list'] = (s, t[:60000])
  for u in [f'{D}/product/detail?productCode={codes[0]}', f'{D}/product/detail/{codes[0]}', f'{D}/product/detail/{codes[0]}/zh_TW']:
    s, t = get(u, hdr); o[u] = (s, t[:30000])
    if s == 200: break
  s, t = get(f'{D}/product/detail', hdr, {'productCode': codes[0]}); o['detail_post'] = (s, t[:30000])
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
print('done')
