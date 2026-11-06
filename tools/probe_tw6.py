"""第三輪探測：GU 真實分類代碼、GAP 商品頁價格、GraceGift/D+AF/QueenShop/plain-me/CACO/Birkenstock 從列表頁找商品頁。輸出 out.json。"""
import json, re, gzip, time, urllib.request, urllib.parse, concurrent.futures as cf
from collections import Counter
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
  except Exception as e: return 0, 'ERR ' + str(e)[:120], u
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
def links(html, base):
  out = []
  for m in re.findall(r'(?:href|data-href|data-url)=["\']([^"\'#]+)', html):
    if m.startswith('//'): m = 'https:' + m
    elif m.startswith('/'): m = base + m
    elif not m.startswith('http'): continue
    out.append(m)
  return list(dict.fromkeys(out))
def patterns(ls, host):
  c = Counter()
  for l in ls:
    if host.split('.')[-2] not in l: continue
    p = re.sub(r'\d+', 'N', urllib.parse.urlparse(l).path); q = urllib.parse.urlparse(l).query
    c[p + ('?' + re.sub(r'=[^&]*', '=', q) if q else '')] += 1
  return c.most_common(25)

def listing_then_detail(host, listing_urls, detail_rx, want=2):
  o = {'listings': []}
  base = 'https://' + host
  details = []
  for lu in listing_urls:
    time.sleep(0.4); s, h, fin = get(lu)
    ls = links(h, base)
    o['listings'].append({'url': lu, 'st': s, 'len': len(h), 'patterns': patterns(ls, host)})
    details += [l for l in ls if re.search(detail_rx, l)]
    if len(details) >= want: break
  details = list(dict.fromkeys(details))
  o['n_detail'] = len(details); o['detail_ex'] = details[:5]
  o['pages'] = []
  for u in details[:want]:
    time.sleep(0.5); s2, h2, _ = get(u, 1500000); p = ld_product(h2) if s2 == 200 else None
    r = {'url': u, 'st': s2, 'len': len(h2), 'p': p}
    if s2 == 200:
      r['ld_raw'] = [m[:400] for m in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', h2, re.S | re.I)][:3]
      r['price_hits'] = [x.strip() for x in re.findall(r'[^\n<>]{0,60}(?:NT\$|售價|價格|price)[^\n<>]{0,60}', h2)][:8]
      r['imgs'] = re.findall(r'https?://[^"\'\s<>]+\.(?:jpg|jpeg|png|webp)[^"\'\s<>]*', h2)[:4]
    o['pages'].append(r)
  return o

def gu():
  o = {}
  s, t, _ = get('https://www.gu-global.com/tw/sitemap_pc_l3_tw.xml', 3000000, ua=BROWSER)
  cats = sorted(set(re.findall(r'/c/([\w-]+)\.html', t))); o['cats'] = cats
  tried = {}
  for code in ['women_all', 'women_tshirtsweat', 'women_tshirtsweat_cutsewn', 'men_outer', 'men_bottoms_jeans', 'women_onepiece', 'men_all']:
    body = {"url": f"/tw/zh_TW/c/{code}.html", "categoryCode": code, "pageInfo": {"page": 1, "pageSize": 12, "withSideBar": "Y"}, "belongTo": "pc", "rank": "overall",
            "priceRange": {"low": 0, "high": 0}, "color": [], "size": [], "season": [], "material": [], "sex": [], "identity": [], "insideFilterCondition": [], "exclusiveCondition": [], "isCategoryExclusive": "N"}
    time.sleep(0.5)
    s, t, _ = get('https://d.gu-global.com/tw/p/search/products/by-category', 800000, ua=BROWSER, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Origin': 'https://www.gu-global.com', 'Referer': 'https://www.gu-global.com/'})
    try: j = json.loads(t); r0 = (j.get('resp') or [{}])[0]; pl = r0.get('productList') or []
    except Exception: pl = []; r0 = {}
    tried[code] = {'st': s, 'n': len(pl), 'keys': list(r0.keys())[:20], 'sample': pl[:2]}
  o['tried'] = tried
  # 商品頁/圖片網址
  if tried['women_all']['sample']:
    p = tried['women_all']['sample'][0]; pic = p.get('mainPic') or ''
    for u in ['https://www.gu-global.com/tw' + pic, 'https://im.uniqlo.com/global-cms' + pic, 'https://www.gu-global.com/tw/zh_TW/product-detail.html?productCode=' + str(p.get('productCode'))]:
      time.sleep(0.3); s, t, fin = get(u, 200000, ua=BROWSER); o.setdefault('urls', []).append([u, s, fin, len(t)])
  return o

def gap():
  o = {}
  time.sleep(0.3); s, h, _ = get('https://www.gap.tw/pdp/000755814/1_000755814_H106-09390', 1500000)
  o['st'] = s; o['len'] = len(h)
  o['ld_raw'] = [m[:600] for m in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', h, re.S | re.I)][:3]
  o['price_hits'] = [x.strip() for x in re.findall(r'[^\n<>]{0,80}(?:salePrice|listPrice|"price"|NT\$|售價)[^\n<>]{0,80}', h)][:12]
  o['json_blobs'] = [m[:300] for m in re.findall(r'window\.__\w+__\s*=\s*(\{.{0,300})', h)][:5]
  o['api_hits'] = sorted(set(re.findall(r'["\'](/[a-zA-Z0-9_\-/]*(?:api|pdp|product|sku)[a-zA-Z0-9_\-/]*)["\']', h)))[:30]
  time.sleep(0.3); s2, x, _ = get('https://www.gap.tw/sitemap.xml', 3000000)
  locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x); o['pdp_in_sitemap'] = len([l for l in locs if '/pdp/' in l]); o['pdp_ex'] = [l for l in locs if '/pdp/' in l][:3]
  return o

jobs = {
  'GU': gu, 'GAP': gap,
  'gracegift': lambda: (lambda s, t, _: (lambda locs: {'st': s, 'n': len(locs), 'ex': locs[:5], 'pages': [dict(url=u, **(lambda s2, h2, _: {'st': s2, 'len': len(h2), 'p': ld_product(h2) if s2 == 200 else None, 'ld_raw': [m[:400] for m in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', h2, re.S | re.I)][:2], 'price_hits': [x.strip() for x in re.findall(r'[^\n<>]{0,60}(?:NT\$|售價|price)[^\n<>]{0,60}', h2)][:6]})(*get(u, 1500000))) for u in locs[-2:]]})(re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', t)))(*get('https://www.gracegift.com.tw/sitemap/shoe/0', 3000000)),
  'daf': lambda: listing_then_detail('www.daf-shoes.com', ['https://www.daf-shoes.com/product/pageSet/1750'], r'daf-shoes\.com/product/(?!pageSet)[^/]+/\d+|daf-shoes\.com/product/\d+'),
  'queenshop': lambda: listing_then_detail('www.queenshop.com.tw', ['https://www.queenshop.com.tw/'], r'queenshop\.com\.tw/(?:zh-TW/)?(?:PDContent|product|Product|item|goods)[^"\']*\d'),
  'plainme': lambda: listing_then_detail('www.plain-me.com', ['https://www.plain-me.com/men/product-tags/新品'], r'plain-me\.com/(?:men|women)/[^/]*product[^/]*/[^/]+/\d+|plain-me\.com/(?:men|women)/product/[^/]+|plain-me\.com/(?:men|women)/[^/]+/\d{4,}'),
  'caco': lambda: listing_then_detail('www.caco.com.tw', ['https://www.caco.com.tw/productlist/51401?page=1&ca=caco-tee'], r'caco\.com\.tw/product(?!list)[^"\']*\d'),
  'birkenstock': lambda: listing_then_detail('www.birkenstock.com.tw', ['https://www.birkenstock.com.tw/product_store?store_type_sn=47'], r'birkenstock\.com\.tw/product_detail[^"\']*|birkenstock\.com\.tw/product\?[^"\']*|birkenstock\.com\.tw/product/\d+'),
}
res = {}
def run(k):
  try: return k, jobs[k]()
  except Exception as e: return k, {'err': repr(e)[:200]}
with cf.ThreadPoolExecutor(5) as ex:
  for k, o in ex.map(run, list(jobs)): res[k] = o
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
