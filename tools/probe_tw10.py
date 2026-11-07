"""第六輪探測：上一輪找到網域的品牌，往下找商品頁、看結構化資料與商品圖能否載入；另外再辨識一批新網域。輸出 out.json。"""
import json, re, gzip, time, urllib.request, urllib.parse, concurrent.futures as cf
BOT = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
def get(u, n=3000000, ua=BOT, timeout=25, headers=None):
  u = urllib.parse.quote(u, safe=':/?&=%#+,;@~')
  h = {'User-Agent': ua, 'Accept-Language': 'zh-TW,zh;q=0.9', 'Accept': 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8'}
  if headers: h.update(headers)
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=timeout) as r:
      b = r.read(n)
      if b[:2] == b'\x1f\x8b':
        try: b = gzip.decompress(b)
        except Exception: pass
      return r.status, b.decode('utf-8', 'replace'), r.geturl()
  except urllib.error.HTTPError as e: return e.code, '', u
  except Exception as e: return 0, 'ERR ' + str(e)[:100], u
def title(h): return (re.search(r'<title[^>]*>(.*?)</title>', h, re.S | re.I) or [None, ''])[1].strip()[:80]
def ld(h):
  out = []
  for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', h, re.S | re.I):
    try: j = json.loads(m.group(1).strip())
    except Exception as e: out.append('BAD ' + m.group(1).strip()[:200]); continue
    for it in (j if isinstance(j, list) else (j.get('@graph') or [j])):
      if isinstance(it, dict) and 'Product' in str(it.get('@type')):
        off = it.get('offers') or {}
        if isinstance(off, list): off = off[0] if off else {}
        img = it.get('image'); img = img[0] if isinstance(img, list) else (img.get('url') if isinstance(img, dict) else img)
        out.append({'name': it.get('name'), 'image': img, 'price': off.get('price') or off.get('lowPrice'), 'cur': off.get('priceCurrency'), 'avail': off.get('availability'), 'cat': it.get('category'), 'brand': str(it.get('brand'))[:60]})
  return out
def meta(h, p):
  m = re.search(r'<meta[^>]+(?:property|name|itemprop)=["\']%s["\'][^>]+content=["\']([^"\']+)' % re.escape(p), h, re.I) or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name|itemprop)=["\']%s["\']' % re.escape(p), h, re.I)
  return m and m.group(1)
def imgtest(u):
  if not u: return None
  if u.startswith('//'): u = 'https:' + u
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0 (compatible; TryOnBot/1.0)'}), timeout=20) as r: return [r.status, r.headers.get('content-type'), len(r.read())]
  except urllib.error.HTTPError as e: return [e.code]
  except Exception as e: return [str(e)[:60]]
def links(h, base):
  out = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', h)
  for m in re.findall(r'(?:href|data-href|data-url)=["\']([^"\'#]+)', h):
    m = m.replace('&amp;', '&')
    if m.startswith('//'): m = 'https:' + m
    elif m.startswith('/'): m = base + m
    elif not m.startswith('http'): continue
    out.append(m)
  return list(dict.fromkeys(out))
def deep(host, seeds, prod_rx, sub_rx=r'product', want=2, extra=None, delay=0.4, ua=BOT):
  base = 'https://' + host; o = {'seeds': []}; found = []
  s, rt, _ = get(base + '/robots.txt', 200000); o['robots'] = (rt[:1500] if s == 200 else str(s))
  for sd in seeds:
    time.sleep(delay); s, h, fin = get(sd, ua=ua); ls = links(h, base)
    subs = [l for l in ls if re.search(r'\.xml', l, re.I) and re.search(sub_rx, l, re.I)][:2]
    o['seeds'].append({'u': sd, 'st': s, 'len': len(h), 'fin': fin, 'title': title(h), 'n_links': len(ls), 'subs': subs, 'sample': ls[:8] if not re.search(prod_rx, ' '.join(ls)) else []})
    for sub in subs:
      time.sleep(delay); s2, h2, _ = get(sub, ua=ua); l2 = links(h2, base); o['seeds'].append({'sub': sub, 'st': s2, 'n': len(l2), 'sample': l2[:3]}); ls += l2
    found += [l for l in ls if re.search(prod_rx, l)]
  found = list(dict.fromkeys(found)); o['n_prod'] = len(found); o['prod_ex'] = found[:3] + found[-3:]
  o['pages'] = []
  for u in (found[:1] + found[-1:] if len(found) > 1 else found)[:want]:
    time.sleep(delay); s, h, fin = get(u, ua=ua)
    p = {'u': u, 'st': s, 'len': len(h), 'title': title(h), 'ld': ld(h), 'og_title': meta(h, 'og:title'), 'og_image': meta(h, 'og:image'), 'price_meta': meta(h, 'product:price:amount') or meta(h, 'price') or meta(h, 'og:price:amount')}
    img = (p['ld'][0]['image'] if p['ld'] and isinstance(p['ld'][0], dict) else None) or p['og_image']
    p['img'] = img; p['imgtest'] = imgtest(img)
    if not p['ld'] or isinstance(p['ld'][0], str):
      p['price_hits'] = [x.strip()[:160] for x in re.findall(r'[^\n<>]{0,70}(?:NT\$|"price"|售價|特價)[^\n<>]{0,70}', h)][:6]
      p['next_data'] = bool(re.search(r'__NEXT_DATA__', h)); p['nuxt'] = bool(re.search(r'__NUXT__', h))
    if extra: p['extra'] = extra(h)
    o['pages'].append(p)
  return o
def shopify(host):
  o = {}
  s, rt, _ = get(f'https://{host}/robots.txt', 200000); o['robots_rules'] = [l for l in rt.splitlines() if l.startswith(('User-agent', 'Disallow', 'Allow', 'Content-Signal'))][:40]
  time.sleep(0.4); s, j, _ = get(f'https://{host}/products.json?limit=250&page=1')
  try:
    ps = json.loads(j)['products']; o['n'] = len(ps)
    o['ex'] = [{'title': p['title'], 'type': p.get('product_type'), 'tags': p.get('tags')[:5] if isinstance(p.get('tags'), list) else p.get('tags'), 'price': p['variants'][0]['price'], 'img': (p.get('images') or [{}])[0].get('src'), 'avail': p['variants'][0].get('available')} for p in ps[:5]]
    o['types'] = sorted({p.get('product_type') for p in ps})[:40]
    o['imgtest'] = imgtest(o['ex'][0]['img'])
  except Exception as e: o['err'] = repr(e)[:100] + j[:200]
  return o
def api91(host, n=3):
  o = {}
  s, rt, _ = get(f'https://{host}/robots.txt', 200000); m = re.search(r'Sitemap/(\d+)/Sitemap_Index', rt); shop = m and m.group(1); o['shop'] = shop; o['robots'] = rt[:400]
  if not shop: return o
  time.sleep(0.4); s, x, _ = get(f'https://{host}/Sitemap/sitemap_ShopSalePage.xml.gz'); ids = sorted({int(i) for i in re.findall(r'SalePage/Index/(\d+)', x)}, reverse=True); o['n_ids'] = len(ids)
  o['items'] = []
  for sid in ids[:n]:
    time.sleep(0.4); s, t, _ = get(f'https://{host}/webapi/SalePageV2/GetSalePageV2Info/{shop}/{sid}')
    try: d = json.loads(t).get('Data') or {}
    except Exception: d = {}
    img = ((d.get('ImageList') or [{}])[0].get('PicUrl') or '')
    o['items'].append({'sid': sid, 'title': d.get('Title'), 'price': d.get('Price'), 'cat': (d.get('CategoryLevelName') or {}).get('ShopCategory_ShowName'), 'img': img, 'imgtest': imgtest(('https:' + img) if img.startswith('//') else img)})
  return o
NEWDOM = ['www.mouggan.com', 'www.alasha.com.tw', 'www.ouwey.com.tw', 'www.stayreal.com.tw', 'www.hanchor.com.tw', 'www.goopi.co', 'www.majormade.com.tw', 'www.gozo.com.tw', 'www.blueway.com.tw',
          'www.bigtrain.com.tw', 'www.robinmay.com', 'www.kinazo.com.tw', 'www.lovebonito.com', 'www.lacoste.com.tw', 'www.kipling.com.tw', 'www.neweracap.com.tw', 'www.lecoqsportif.com.tw',
          'www.salomon.com.tw', 'www.merrell.com.tw', 'www.kappa.com.tw', 'www.jansport.com.tw', 'www.wego.tw', 'www.muji.tw', 'www.ellesse.com.tw', 'www.hushpuppies.com.tw', 'www.clarks.com.tw',
          'www.coach.com', 'www.katespade.com.tw', 'www.diadora.com.tw', 'www.saucony.com.tw', 'www.hoka.com.tw', 'www.esprit.com.tw', 'www.arena.com.tw', 'www.nautica.com.tw', 'www.snowpeak.com.tw']
def ident(host):
  o = {}
  s, rt, _ = get(f'https://{host}/robots.txt', 200000); o['robots_st'] = s; m = re.search(r'Sitemap/(\d+)/Sitemap_Index', rt); o['shop91'] = m and m.group(1)
  o['sitemaps'] = re.findall(r'(?im)^sitemap:\s*(\S+)', rt)[:3] if s == 200 else []
  time.sleep(0.3); s, h, fin = get(f'https://{host}/', 1500000); o['st'] = s; o['fin'] = fin; o['title'] = title(h); o['len'] = len(h); o['err'] = h[:80] if h.startswith('ERR') else None
  o['sigs'] = [k for k, rx in {'91app': r'nineyi|91app', 'shopline': r'shoplineapp|SHOPLINE', 'cyberbiz': r'cyberbiz', 'shopify': r'cdn\.shopify\.com', 'sfcc': r'demandware', 'nuxt': r'__NUXT__', 'next': r'__NEXT_DATA__', 'fonlego': r'fonlego'}.items() if re.search(rx, h)]
  if 'shopify' in o['sigs']: time.sleep(0.3); o['pj'] = get(f'https://{host}/products.json?limit=1', 200000)[0]
  return o

JOBS = {
  'onitsuka': lambda: api91('www.onitsukatiger.com.tw'),
  'lee': lambda: api91('www.leejeans.com.tw'),
  'mlb': lambda: api91('www.mlb-korea.com.tw'),
  'andst': lambda: api91('www.dot-st.tw', 5),
  'stripe': lambda: api91('www.stripe-club.com.tw', 5),
  'lesportsac': lambda: shopify('lesportsac.tw'),
  'bonbons': lambda: deep('bonbons.com.tw', ['https://bonbons.com.tw/sitemap_index.xml', 'https://bonbons.com.tw/product-sitemap.xml'], r'bonbons\.com\.tw/(?:product|shop)/[^/]+/?$'),
  'iroo': lambda: deep('www.iroo.com', ['https://www.iroo.com/iroo/products/allproduct/newarrival', 'https://www.iroo.com/iroo/products/allproduct/dresses'], r'/iroo/product-detail/|/iroo/products/detail|/product-detail/'),
  'charleskeith': lambda: deep('www.charleskeith.com', ['https://www.charleskeith.com/tw/sitemap_index.xml'], r'charleskeith\.com/tw/[^?]*\.html$', delay=10),
  'pedro': lambda: deep('www.pedroshoes.com', ['https://www.pedroshoes.com/tw/sitemap_index.xml'], r'pedroshoes\.com/tw/[^?]*\.html$', delay=5),
  'longchamp': lambda: deep('www.longchamp.com', ['https://www.longchamp.com/tw/zh/sitemap-stmp_zh_TW_index.xml', 'https://www.longchamp.com/tw/zh/'], r'longchamp\.com/tw/zh/products/[^?]*\.html$'),
  'tommy': lambda: deep('tw.tommy.com', ['https://tw.tommy.com/sitemap_index.xml'], r'tw\.tommy\.com/zh/[^?]*\.html$|tw\.tommy\.com/zh/p/'),
  'ck': lambda: deep('www.calvinklein.com.tw', ['https://www.calvinklein.com.tw/sitemap_index.xml'], r'calvinklein\.com\.tw/zh/[^?]*\.html$|/zh/p/'),
  'teva': lambda: deep('teva.com.tw', ['https://teva.com.tw/', 'https://teva.com.tw/sitemap.xml'], r'teva\.com\.tw/(?:products?|product-detail|item)/'),
  'airspace': lambda: deep('www.airspaceonline.com', ['https://www.airspaceonline.com/sitemap-index.xml', 'https://www.airspaceonline.com/tw/zh-tw/'], r'/tw/zh-tw/product/'),
  'agnesb': lambda: deep('www.agnesb.com.tw', ['https://www.agnesb.com.tw/', 'https://www.agnesb.com.tw/sitemap.xml'], r'agnesb\.com\.tw/products/\d+'),
  'ecco': lambda: deep('tw.ecco.com', ['https://tw.ecco.com/sitemap'], r'tw\.ecco\.com/(?:product|p)/|tw\.ecco\.com/.+\d{6}'),
  'wstyle': lambda: deep('www.wstyle.com.tw', ['https://www.wstyle.com.tw/Shop/', 'https://www.wstyle.com.tw/sitemap.xml'], r'(?i)wstyle\.com\.tw/.*(?:itemdetail|product|goods)'),
  'usagi': lambda: deep('www.usagi-online.com.tw', ['https://www.usagi-online.com.tw/', 'https://www.usagi-online.com.tw/sitemap.xml'], r'usagi-online\.com\.tw/.*(?:product|goods|item)'),
  'lovfee': lambda: deep('www.lovfee.com', ['https://www.lovfee.com/', 'https://www.lovfee.com/sitemap.xml'], r'(?i)lovfee\.com/.*(?:product|goods|item)'),
  'champion': lambda: deep('www.championstore.com.tw', ['https://www.championstore.com.tw/', 'https://www.championstore.com.tw/sitemap.xml'], r'championstore\.com\.tw/.*(?:product|goods|item)'),
  'nike': lambda: deep('www.nike.com', ['https://www.nike.com/sitemap-v2-pdp-index.xml'], r'nike\.com/tw/t/', sub_rx=r'zh-tw|-tw-|_tw|/tw'),
}
res = {}
def go(k):
  try: return k, JOBS[k]()
  except Exception as e: return k, {'exc': repr(e)[:200]}
def go2(h):
  try: return h, ident(h)
  except Exception as e: return h, {'exc': repr(e)[:200]}
with cf.ThreadPoolExecutor(12) as ex:
  futs = [ex.submit(go, k) for k in JOBS] + [ex.submit(go2, h) for h in NEWDOM]
  for f in futs:
    k, o = f.result(); res[k] = o
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
