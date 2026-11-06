"""第二輪探測：GU 分類代碍、GAP/Skechers/GraceGift/D+AF/QueenShop/plain-me/CACO/Birkenstock 商品頁、連不上的網域換別名、403 網站用瀏覽器 UA 只讀 robots.txt。輸出 out.json。"""
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
  for m in re.findall(r'href=["\']([^"\'#]+)', html):
    if m.startswith('//'): m = 'https:' + m
    elif m.startswith('/'): m = base + m
    elif not m.startswith('http'): continue
    out.append(m)
  return list(dict.fromkeys(out))
res = {}

def alt_domains():
  o = {}
  for d in ['www.hangten.com.tw', 'hangten.com.tw', 'shop.hangten.com.tw', 'www.converse.com.tw', 'converse.com.tw', 'www.drmartens.com.tw', 'drmartens.com.tw', 'www.championusa.com.tw', 'championusa.com.tw', 'www.champion.com.tw',
            'www.genquo.com', 'genquo.com', 'www.miss21.com.tw', 'miss21.com.tw', 'www.bonjourbag.com', 'www.bonjour.com.tw', 'shop.bossini.com.tw', 'www.bossini.com', 'www.net-fashion.net', 'www.newbalance.com.tw', 'www.queenshop.com.tw', 'www.caco.com.tw']:
    time.sleep(0.3); s, t, fin = get('https://' + d + '/', 300000)
    r = {'st': s, 'fin': fin, 'err': t[:120] if s == 0 else '', 'title': (re.search(r'<title[^>]*>(.*?)</title>', t, re.S | re.I) or [None, ''])[1].strip()[:60]}
    if s in (403, 0):
      time.sleep(0.3); s2, t2, fin2 = get('https://' + d + '/robots.txt', 100000, ua=BROWSER); r['robots_browser'] = [s2, t2[:600]]
    o[d] = r
  return o

def gu():
  o = {}
  for u in ['https://www.gu-global.com/robots.txt', 'https://www.gu-global.com/tw/sitemap.xml', 'https://www.gu-global.com/tw/zh_TW/sitemap.xml', 'https://www.gu-global.com/sitemap.xml', 'https://www.gu-global.com/tw/zh_TW/sitemap_index.xml']:
    time.sleep(0.3); s, t, _ = get(u, 1000000, ua=BROWSER)
    sms = re.findall(r'(?im)^sitemap:\s*(\S+)', t) if 'robots' in u else re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', t)
    o[u] = [s, len(t), sms[:15]]
    if 'robots' in u:
      for sm in [x for x in sms if '/tw' in x][:3]:
        time.sleep(0.3); s2, t2, _ = get(sm, 3000000, ua=BROWSER); locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', t2); o[sm] = [s2, len(locs), locs[:8]]
        cats = sorted(set(re.findall(r'/c/([\w-]+)\.html', t2))); o[sm + ' cats'] = cats[:80]
        if not cats:
          for sub in [l for l in locs if 'xml' in l][:4]:
            time.sleep(0.3); s3, t3, _ = get(sub, 3000000, ua=BROWSER); c3 = sorted(set(re.findall(r'/c/([\w-]+)\.html', t3))); o[sub] = [s3, len(t3), c3[:80], re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', t3)[:5]]
  # 試幾個分類代碼
  tried = {}
  for code in ['all_women-tops', 'women-tops', 'all_women', 'women', 'all_women-t-shirts', 'women-tops-t-shirts', 'all_women-knitwear', 'tw-women-tops']:
    body = {"url": f"/tw/zh_TW/c/{code}.html", "categoryCode": code, "pageInfo": {"page": 1, "pageSize": 10, "withSideBar": "Y"}, "belongTo": "pc", "rank": "overall",
            "priceRange": {"low": 0, "high": 0}, "color": [], "size": [], "season": [], "material": [], "sex": [], "identity": [], "insideFilterCondition": [], "exclusiveCondition": [], "isCategoryExclusive": "N"}
    time.sleep(0.4)
    s, t, _ = get('https://d.gu-global.com/tw/p/search/products/by-category', 600000, ua=BROWSER, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Origin': 'https://www.gu-global.com', 'Referer': 'https://www.gu-global.com/'})
    try: pl = (json.loads(t).get('resp') or [{}])[0].get('productList') or []
    except Exception: pl = []
    tried[code] = [s, len(pl), pl and {k: pl[0].get(k) for k in ('productCode', 'name', 'shortName', 'minPrice', 'mainPic', 'sex', 'stock', 'productName')}]
  o['tried'] = tried
  # 分類樹 API 猜測
  for u in ['https://d.gu-global.com/tw/p/category/all', 'https://d.gu-global.com/tw/p/category/tree', 'https://d.gu-global.com/tw/p/category/getCategoryList', 'https://d.gu-global.com/tw/p/search/products/by-keyword']:
    time.sleep(0.3); s, t, _ = get(u, 300000, ua=BROWSER, headers={'Origin': 'https://www.gu-global.com'}); o[u] = [s, t[:300]]
  body = {"url": "/tw/zh_TW/search?q=T", "keyword": "T恤", "pageInfo": {"page": 1, "pageSize": 10, "withSideBar": "Y"}, "belongTo": "pc", "rank": "overall", "priceRange": {"low": 0, "high": 0}, "color": [], "size": [], "season": [], "material": [], "sex": [], "identity": [], "insideFilterCondition": [], "exclusiveCondition": [], "isCategoryExclusive": "N"}
  time.sleep(0.3); s, t, _ = get('https://d.gu-global.com/tw/p/search/products/by-keyword', 600000, ua=BROWSER, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Origin': 'https://www.gu-global.com'})
  o['keyword'] = [s, t[:600]]
  # 首頁 bundle 裡找分類代碼
  time.sleep(0.3); s, js, _ = get('https://www.gu-global.com/tw/build/desktop.9eb3c1eef93be4111a15.bundle.js', 4000000, ua=BROWSER)
  o['bundle'] = [s, len(js), sorted(set(re.findall(r'all_[a-z]+-[a-z0-9\-]+', js)))[:80], sorted(set(re.findall(r'https?://d\.gu-global\.com[^"\'\s]*', js)))[:30], sorted(set(re.findall(r'/tw/p/[a-zA-Z/\-]+', js)))[:40]]
  return o

def site(host, start, pats, extra=()):
  o = {}; base = 'https://' + host
  time.sleep(0.3); s, h, fin = get(start, ua=BOT); o['start'] = [s, fin, len(h)]
  if fin.startswith('http'): base = re.match(r'https?://[^/]+', fin).group(0)
  ls = links(h, base)
  cand = [l for l in ls if re.search(pats, l) and host.split('www.')[-1].split('.')[0] in l]
  o['n_links'] = len(ls); o['cand'] = cand[:6]; o['some_links'] = [l for l in ls if host.split('.')[-2] in l][:25]
  for u in list(extra) + cand[:2]:
    time.sleep(0.5); s2, h2, _ = get(u, 1500000); p = ld_product(h2) if s2 == 200 else None
    r = {'url': u, 'st': s2, 'len': len(h2), 'p': p}
    if s2 == 200 and not p:
      r['imgs'] = re.findall(r'https?://[^"\'\s<>]+\.(?:jpg|jpeg|png|webp)[^"\'\s<>]*', h2)[:4]
      r['price_hits'] = re.findall(r'.{0,40}(?:NT\$|\$|price)[^<]{0,40}', h2)[:5]
      r['scripts'] = re.findall(r'<script[^>]+type=["\']([^"\']+)', h2)[:8]
      r['ld_raw'] = [m[:300] for m in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', h2, re.S | re.I)][:3]
      r['next_data'] = '__NEXT_DATA__' in h2; r['nuxt'] = '__NUXT__' in h2
    o.setdefault('pages', []).append(r)
  return o

jobs = {
  'GAP': lambda: site('www.gap.tw', 'https://www.gap.tw/', r'/pdp/', ['https://www.gap.tw/pdp/000755814/1_000755814_H106-09390']),
  'skechers': lambda: site('www.skechers-twn.com', 'https://www.skechers-twn.com/zh-tw/home', r'/product|/goods|/item|/detail', []),
  'gracegift': lambda: site('www.gracegift.com.tw', 'https://www.gracegift.com.tw/sitemap/shoe/0', r'/product|/goods|/item|/detail|/shoe', []),
  'daf': lambda: site('www.daf-shoes.com', 'https://www.daf-shoes.com/', r'/product|/goods|/item|/detail', []),
  'queenshop': lambda: site('www.queenshop.com.tw', 'https://www.queenshop.com.tw/', r'/product|/goods|/item|/detail|PDContent|/p/', []),
  'plainme': lambda: site('www.plain-me.com', 'https://www.plain-me.com/', r'/product|/goods|/item|/detail|/p/', []),
  'caco': lambda: site('www.caco.com.tw', 'https://www.caco.com.tw/home/caco', r'/product|/goods|/item|/detail|/p/', []),
  'birkenstock': lambda: site('www.birkenstock.com.tw', 'https://www.birkenstock.com.tw/', r'product|goods|item|detail', []),
  'lulus_sm': lambda: (lambda s, t, _: {'st': s, 'locs': re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', t)[:6], 'zh': len(re.findall(r'<loc>\s*https://www\.lulus\.com\.tw/zh-hant/products/', t)), 'en': len(re.findall(r'/en/products/', t)), 'plain': len(re.findall(r'<loc>\s*https://www\.lulus\.com\.tw/products/', t))})(*get('https://www.lulus.com.tw/sitemap.xml', 3000000)),
  'fifty_sm': lambda: (lambda s, t, _: {'st': s, 'locs': re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', t)[:6]})(*get('https://www.50-shop.com/sitemap.xml', 3000000)),
  'alt': alt_domains,
  'GU': gu,
}
def run(k):
  try: return k, jobs[k]()
  except Exception as e: return k, {'err': str(e)[:200]}
with cf.ThreadPoolExecutor(6) as ex:
  for k, o in ex.map(run, list(jobs)): res[k] = o
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
