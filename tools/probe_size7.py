"""尺寸表探測（第七輪）：沒有尺寸表的品牌——商品 sizes 的寫法、商品頁表格的實際結構（給 sizecharts.py 改進用）。每網域 ≤ 6 個請求。輸出 out.json。"""
import json, re, gzip, time, sys, os, urllib.request, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sizecharts as SC
UA = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
API = 'https://tryon-api.frankccc199.workers.dev'
def get(u):
  u = urllib.parse.quote(u, safe=':/?&=%#+,;@~')
  time.sleep(0.4)
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA, 'Accept-Language': 'zh-TW'}), timeout=30) as r:
      b = r.read(4000000)
      if b[:2] == b'\x1f\x8b': b = gzip.decompress(b)
      return r.status, b.decode('utf-8', 'replace')
  except urllib.error.HTTPError as e: return e.code, ''
  except Exception as e: return 0, 'ERR ' + str(e)[:100]
def prods(brand, typ):
  s, t = get(f'{API}/api/products?brand={urllib.parse.quote(brand)}&type={typ}&size=24')
  try: return json.loads(t)['products']
  except Exception: return []
out = {'sizes': {}, 'pages': {}}
for b in ['VANS', 'The North Face', 'adidas', 'Timberland', 'Under Armour', 'LACOSTE', 'PUMA', "Levi's", 'EDWIN', 'earth music&ecology', 'Samansa Mos2', 'YECCA VECCA', 'Columbia', 'Green Parks', 'GLOBAL WORK', 'JEANASIS', 'niko and...', 'Salomon', 'à la sha']:
  vals = {}
  for typ in ('top', 'bottom', 'shoes', 'dress'):
    for p in prods(b, typ):
      k = typ + ':' + '|'.join(p.get('sizes') or [])
      vals[k] = vals.get(k, 0) + 1
  out['sizes'][b] = sorted(vals.items(), key=lambda x: -x[1])[:12]
for b in ['AIR SPACE', 'MEIER.Q', 'Queen Shop', 'GAP', 'FILA', 'Lulus', '50% FIFTY PERCENT', 'gozo', 'GOOPi', 'Saucony', 'à la sha', 'GLOBAL WORK', 'Grace Gift', 'Timberland']:
  ps = (prods(b, 'top') + prods(b, 'bottom'))
  ps = ps[:2] + ps[-1:] if len(ps) > 3 else ps
  r = out['pages'][b] = []
  for p in ps[:3]:
    s, h = get(p['buy_url'])
    tabs = []
    for t in re.findall(r'<table.*?</table>', h, re.S | re.I)[:4]: tabs.append(SC.cells_of(t)[:6])
    r.append({'url': p['buy_url'], 'status': s, 'len': len(h), 'tables': tabs, 'parsed': SC.parse_tables(h, p['type']),
              'hints': [re.sub(r'\s+', ' ', x)[:300] for x in re.findall(r'.{0,120}(?:尺寸表|size.?chart|sizeChart|SizeChart|胸寬|衣長|肩寬).{0,160}', h)[:5]]})
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
print('done')
