"""檢查 GOOPi：目前上架商品頁的尺寸表解析（新舊解碼比較）。≤ 8 個請求。輸出 out.json。"""
import json, sys, os, re, time, gzip, urllib.request, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sizecharts as SC
UA = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
API = 'https://tryon-api.frankccc199.workers.dev'
def raw(u):
  u = urllib.parse.quote(u, safe=':/?&=%#+,;@~'); time.sleep(0.5)
  with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA, 'Accept-Language': 'zh-TW'}), timeout=30) as r:
    b = r.read(4000000)
    if b[:2] == b'\x1f\x8b': b = gzip.decompress(b)
    return b, r.headers.get_content_charset(), r.headers.get('content-type')
with urllib.request.urlopen(urllib.request.Request(API + '/api/products?brand=GOOPi&type=top&size=12', headers={'User-Agent': 'probe'}), timeout=30) as r: ps = json.load(r)['products']
out = []
for p in ps[:6]:
  b, cs, ct = raw(p['buy_url'])
  h = SC.decode_html(b, cs)
  out.append({'url': p['buy_url'], 'name': p['name'], 'ct': ct, 'cs': cs, 'tables': len(re.findall(r'<table', h, re.I)), 'parsed': SC.parse_tables(h, 'top'),
              'cells': [SC.cells_of(t)[:3] for t in re.findall(r'<table.*?</table>', h, re.S | re.I)[:2]], 'hint': re.findall(r'.{0,80}尺寸.{0,200}', re.sub(r'<[^>]+>', ' ', h))[:3]})
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
