"""探測台灣品牌官網：平台、robots.txt、網站地圖、商品頁結構化資料；另外探測 GU 台灣 API。輸出 out.json。"""
import json, re, gzip, time, urllib.request, urllib.robotparser, urllib.parse, concurrent.futures as cf
BOT = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
def get(u, n=2000000, ua=BOT, timeout=25, data=None, headers=None):
  u = urllib.parse.quote(u, safe=':/?&=%#+,;@~')
  h = {'User-Agent': ua, 'Accept-Language': 'zh-TW,zh;q=0.9', 'Accept': 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8'}
  if headers: h.update(headers)
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers=h, data=data), timeout=timeout) as r:
      b = r.read(n)
      if u.endswith('.gz') or b[:2] == b'\x1f\x8b':
        try: b = gzip.decompress(b)
        except Exception: pass
      return r.status, b.decode('utf-8', 'replace'), r.geturl()
  except urllib.error.HTTPError as e: return e.code, '', u
  except Exception as e: return 0, str(e)[:100], u
def ld_product(html):
  for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I):
    try: j = json.loads(m.group(1).strip())
    except Exception: continue
    for it in (j if isinstance(j, list) else (j.get('@graph') or [j])):
      if isinstance(it, dict) and 'Product' in str(it.get('@type')):
        off = it.get('offers') or {}
        if isinstance(off, list): off = off[0] if off else {}
        img = it.get('image'); img = img[0] if isinstance(img, list) else (img.get('url') if isinstance(img, dict) else img)
        return {'name': it.get('name'), 'image': img, 'price': off.get('price') or off.get('lowPrice'), 'avail': off.get('availability'), 'category': it.get('category')}
  og = lambda p: (re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']+)' % p, html) or [None, None])[1]
  if og('og:title') and og('og:image'): return {'name': og('og:title'), 'image': og('og:image'), 'price': og('product:price:amount'), 'og': True}
  return None

HOSTS = '''www.pazzo.com.tw www.meierq.com www.mercci22.com www.50-shop.com www.daf-shoes.com www.gracegift.com.tw www.queenshop.com.tw www.bonjourbag.com
www.net-fashion.net www.hangten.com.tw www.bossini.com.tw www.gap.tw www.newbalance.com.tw www.converse.com.tw tw.puma.com www.skechers-twn.com
www.thenorthface.com.tw www.underarmour.tw www.fila.com.tw www.drmartens.com.tw www.columbiasportswear.com.tw www.championusa.com.tw www.plain-me.com
www.caco.com.tw www.genquo.com www.lulus.com.tw www.miss21.com.tw www.dickies.com.tw www.birkenstock.com.tw www2.hm.com'''.split()
PROD = re.compile(r'(SalePage/Index/\d+|/products?/[^<\s"]+|/goods/[^<\s"]+|/item/[^<\s"]+|/Product[^<\s"]*/[^<\s"]+|/p/[^<\s"]+|/market/n/\d+|\.html)', re.I)

def probe(host):
  o = {}; base = 'https://' + host
  st, home, fin = get(base + '/' if host != 'www2.hm.com' else base + '/zh_tw/index.html')
  o['home'] = st; o['final'] = fin
  low = home.lower()
  plat = []
  for k, sig in [('shopify', 'cdn.shopify.com'), ('shopline', 'shoplineapp'), ('shopline', 'shopline'), ('91app', '91app'), ('91app', '/webapi/'), ('cyberbiz', 'cyberbiz'), ('waca', 'waca.ec'), ('easystore', 'easystore'), ('meepshop', 'meepshop'), ('woocommerce', 'woocommerce'), ('magento', 'mage/'), ('salesforce', 'demandware'), ('nextjs', '__next'), ('nuxt', '__nuxt')]:
    if sig in low and k not in plat: plat.append(k)
  o['plat'] = plat; o['title'] = (re.search(r'<title[^>]*>(.*?)</title>', home, re.S | re.I) or [None, ''])[1].strip()[:80]
  if fin.startswith('http'): base = re.match(r'https?://[^/]+', fin).group(0)
  o['base'] = base
  st, robots, _ = get(base + '/robots.txt', 200000)
  o['robots_st'] = st; o['robots'] = robots[:1500] if st == 200 else ''
  rp = urllib.robotparser.RobotFileParser(); rp.parse(robots.splitlines() if st == 200 else [])
  maps = re.findall(r'(?im)^sitemap:\s*(\S+)', robots) or [base + '/sitemap.xml']
  o['sitemaps'] = maps[:5]
  m91 = re.search(r'Sitemap/(\d+)/Sitemap_Index', robots); o['shop91'] = m91 and m91.group(1)
  time.sleep(0.3)
  s2, t2, _ = get(base + '/products.json?limit=3', 400000, ua=BROWSER)
  o['products_json'] = s2
  if s2 == 200 and t2.strip().startswith('{'):
    try:
      ps = json.loads(t2).get('products', []); o['products_json'] = len(ps)
      o['pj_sample'] = ps and {'title': ps[0].get('title'), 'type': ps[0].get('product_type'), 'price': (ps[0].get('variants') or [{}])[0].get('price'), 'img': (ps[0].get('images') or [{}])[0].get('src', '')[:100], 'opts': [v.get('title') for v in (ps[0].get('variants') or [])][:6]}
    except Exception as e: o['products_json'] = 'parse:' + str(e)[:40]
  urls = []; n = 0
  for sm in maps[:3]:
    time.sleep(0.3); s3, x, _ = get(sm); n += 1
    locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x)
    subs = [l for l in locs if '.xml' in l.lower()]; prods = [l for l in locs if '.xml' not in l.lower()]
    for sub in ([l for l in subs if re.search(r'product|salepage|goods|item', l, re.I)] or subs)[:3]:
      time.sleep(0.3); s4, x4, _ = get(sub); n += 1; prods += re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x4)
    o.setdefault('sm_st', []).append([sm, s3, len(locs)])
    urls += prods
    if len(urls) > 50: break
  cand = [u for u in dict.fromkeys(urls) if PROD.search(u) and host.split('www.')[-1].split('.')[0] in u]
  o['n_urls'] = len(urls); o['n_prod'] = len(cand); o['ex'] = cand[:3]; o['sample_urls'] = urls[:3] + urls[-3:]
  o['robots_ok'] = [rp.can_fetch(BOT, u) for u in cand[:3]]
  got = []
  for u in cand[:3]:
    if not rp.can_fetch(BOT, u): continue
    time.sleep(0.5); s5, h5, _ = get(u, 1500000); p = ld_product(h5) if s5 == 200 else None
    got.append({'url': u, 'st': s5, 'len': len(h5), 'p': p})
    if p and len(got) >= 2: break
  o['pages'] = got
  if o['shop91'] and cand:
    sid = re.search(r'SalePage/Index/(\d+)', cand[0])
    if sid:
      time.sleep(0.4); s6, h6, _ = get(f'{base}/webapi/SalePageV2/GetSalePageV2Info/{o["shop91"]}/{sid.group(1)}', 300000)
      o['api91'] = [s6, h6[:200]]
  # Shopline：試 /products/<handle>.json 與 og
  if 'shopline' in plat and cand:
    u = cand[0].rstrip('/')
    time.sleep(0.4); s7, h7, _ = get(u + '.json', 300000, ua=BROWSER); o['shopline_json'] = [s7, h7[:200]]
  return host, o

def probe_gu():
  o = {}
  st, home, fin = get('https://www.gu-global.com/tw/zh_TW/', ua=BROWSER); o['home'] = [st, fin, len(home)]
  cats = sorted(set(re.findall(r'/c/([\w-]+)\.html', home)))[:40]; o['cats_from_home'] = cats
  st, rb, _ = get('https://www.gu-global.com/robots.txt', 100000); o['robots'] = rb[:800]
  st, rb2, _ = get('https://d.gu-global.com/robots.txt', 100000); o['robots_d'] = [st, rb2[:300]]
  code = 'all_women-tops' if 'all_women-tops' in cats else (cats[0] if cats else 'all_women-tops')
  body = {"url": f"/tw/zh_TW/c/{code}.html", "categoryCode": code, "pageInfo": {"page": 1, "pageSize": 10, "withSideBar": "Y"}, "belongTo": "pc", "rank": "overall",
          "priceRange": {"low": 0, "high": 0}, "color": [], "size": [], "season": [], "material": [], "sex": [], "identity": [], "insideFilterCondition": [], "exclusiveCondition": [], "isCategoryExclusive": "N"}
  for api in ['https://d.gu-global.com/tw/p/search/products/by-category', 'https://d.gu-global.com/tw/gu/p/search/products/by-category', 'https://www.gu-global.com/tw/api/commodity/v5/product/search/products/by-category', 'https://d.uniqlo.com/tw/gu/p/search/products/by-category']:
    time.sleep(0.4)
    s, t, _ = get(api, 400000, ua=BROWSER, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Origin': 'https://www.gu-global.com', 'Referer': 'https://www.gu-global.com/'})
    r = {'st': s, 'head': t[:300]}
    if s == 200:
      try:
        j = json.loads(t); pl = (j.get('resp') or [{}])[0].get('productList') or []
        r['n'] = len(pl); r['sample'] = pl and {k: pl[0].get(k) for k in ('productCode', 'name', 'shortName', 'minPrice', 'mainPic', 'sex', 'stock', 'productName')}
      except Exception as e: r['err'] = str(e)[:80]
    o[api] = r
  # 任何 /c/ 頁找到 api 線索
  m = re.findall(r'https?://[a-z0-9.\-]+gu-global\.com[^"\'\s]*', home); o['hosts_in_home'] = sorted(set(re.match(r'https?://[^/]+', x).group(0) for x in m))[:20]
  js = re.findall(r'src=["\']([^"\']+\.js[^"\']*)', home)[:30]; o['js'] = js
  return o

res = {}
with cf.ThreadPoolExecutor(8) as ex:
  for h, o in ex.map(probe, HOSTS): res[h] = o
try: res['GU'] = probe_gu()
except Exception as e: res['GU'] = {'err': str(e)}
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
