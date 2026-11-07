"""第八輪探測：Queen Shop 商品列表怎麼載入（只拿到 10 件），找分頁或 AJAX 端點。輸出 out.json。"""
import json, re, time, urllib.request, urllib.parse
BOT = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
def get(u, n=3000000, data=None, headers=None):
  h = {'User-Agent': BOT, 'Accept-Language': 'zh-TW'}
  if headers: h.update(headers)
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers=h, data=data), timeout=25) as r: return r.status, r.read(n).decode('utf-8', 'replace')
  except urllib.error.HTTPError as e: return e.code, e.read(3000).decode('utf-8', 'replace')
  except Exception as e: return 0, 'ERR ' + str(e)[:100]
o = {}
s, h = get('https://www.queenshop.com.tw/zh-TW/QueenShop/ProductList?item1=01')
o['st'] = s
o['scripts'] = re.findall(r'<script[^>]+src=["\']([^"\']+)', h)[:30]
o['ajax'] = [x[:300] for x in re.findall(r'[^\n]{0,150}(?:\$\.ajax|\$\.post|\$\.get|fetch\(|url\s*:|\.ashx|\.asmx|WebMethod|/api/)[^\n]{0,150}', h)][:30]
o['saleids'] = len(set(re.findall(r'SaleID=(\w+)', h)))
o['paging'] = list(dict.fromkeys(re.findall(r'href=["\']([^"\']*(?:page|Page|pg)=[^"\']*)', h)))[:10]
o['forms'] = re.findall(r'<input[^>]+name=["\'](__\w+|ctl00[^"\']*)["\']', h)[:20]
js_hits = {}
for src in [x for x in o['scripts'] if 'productlist' in x.lower() or 'qs' in x.lower() or 'list' in x.lower()][:4]:
  u = src if src.startswith('http') else 'https://www.queenshop.com.tw' + (src if src.startswith('/') else '/' + src)
  time.sleep(0.5); s2, j = get(u)
  js_hits[u] = [x[:300] for x in re.findall(r'[^\n]{0,150}(?:\$\.ajax|\$\.post|url\s*:|\.ashx|\.asmx|/api/)[^\n]{0,150}', j)][:15]
o['js'] = js_hits
for q in ['?item1=01&page=2', '?item1=01&Page=2', '?item1=01&pageindex=2']:
  time.sleep(0.5); s3, h3 = get('https://www.queenshop.com.tw/zh-TW/QueenShop/ProductList' + q)
  o['try' + q] = [s3, len(set(re.findall(r'SaleID=(\w+)', h3))), sorted(set(re.findall(r'SaleID=(\w+)', h3)))[:3]]
json.dump(o, open('out.json', 'w'), ensure_ascii=False, indent=1)
