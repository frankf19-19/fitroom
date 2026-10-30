import json, re, gzip, urllib.request, urllib.robotparser, concurrent.futures as cf
UA = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
H = {'User-Agent': UA, 'Accept-Language': 'zh-TW'}
def get(u, n=3000000):
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=25) as r:
      b = r.read(n)
      if u.endswith('.gz') or b[:2] == b'\x1f\x8b':
        try: b = gzip.decompress(b)
        except Exception: pass
      return r.status, b.decode('utf-8', 'replace'), r.geturl()
  except urllib.error.HTTPError as e: return e.code, '', u
  except Exception as e: return 0, str(e)[:80], u
def ld_product(html):
  for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I):
    try: j = json.loads(m.group(1).strip())
    except Exception: continue
    items = j if isinstance(j, list) else (j.get('@graph') or [j])
    for it in items:
      if isinstance(it, dict) and 'Product' in str(it.get('@type')):
        off = it.get('offers') or {}
        if isinstance(off, list): off = off[0] if off else {}
        img = it.get('image'); img = img[0] if isinstance(img, list) else (img.get('url') if isinstance(img, dict) else img)
        return {'name': it.get('name'), 'image': img, 'price': off.get('price') or off.get('lowPrice'), 'brand': (it.get('brand') or {}).get('name') if isinstance(it.get('brand'), dict) else it.get('brand')}
  og = lambda p: (re.search(r'<meta[^>]+property=["\']%s["\'][^>]+content=["\']([^"\']+)' % p, html) or [None, None])[1]
  if og('og:title') and og('og:image'): return {'name': og('og:title'), 'image': og('og:image'), 'price': og('product:price:amount'), 'og': True}
  return None
SITES = '''www.queenshop.com.tw www.pazzo.com.tw www.meierq.com www.obdesign.com.tw www.gracegift.com.tw www.lativ.com.tw www.mercci22.com www.lovfee.com www.cozyfee.com www.plain-me.com www.daf-shoes.com www.vacanza.com.tw www.giordano.com.tw bossini.com.tw www.leon.com.tw www.mamaway.com.tw www.wakeup.com.tw annies.com.tw www.wonderland.com.tw tofu.com.tw www.mo-bo.com.tw www.abby.com.tw www.roots.com.tw www.timberland.com.tw www.crocs.com.tw www.vans.com.tw www.adidas.com.tw www.levis.com.tw www.edwin.com.tw www.sanding.com.tw www.wstyle.com.tw'''.split()
PROD = re.compile(r'(SalePage/Index/\d+|/products?/[^<\s"]+|/product/[^<\s"]+|/goods/[^<\s"]+|/item/[^<\s"]+|/Product/[^<\s"]+|/p/[^<\s"]+|\.html)', re.I)
def probe(host):
  base = 'https://' + host; o = {}
  st, robots, _ = get(base + '/robots.txt', 200000)
  rp = urllib.robotparser.RobotFileParser(); rp.parse(robots.splitlines() if st == 200 else [])
  maps = re.findall(r'(?im)^sitemap:\s*(\S+)', robots) or [base + '/sitemap.xml']
  o['sitemaps'] = maps[:4]
  urls = []
  for sm in maps[:4]:
    s2, x, _ = get(sm)
    locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x)
    subs = [l for l in locs if 'xml' in l.lower()]
    prods = [l for l in locs if 'xml' not in l.lower()]
    for sub in [l for l in subs if re.search(r'product|salepage|goods|item', l, re.I)][:3] or subs[:3]:
      s3, x3, _ = get(sub); prods += re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x3)
    urls += prods
    if len(urls) > 50: break
  cand = [u for u in urls if PROD.search(u) and host.split('www.')[-1] in u]
  o['n_urls'] = len(urls); o['n_prod'] = len(cand); o['ex'] = cand[:2]
  o['robots_ok'] = all(rp.can_fetch(UA, u) for u in cand[:3]) if cand else None
  got = []
  for u in cand[:4]:
    s4, h4, _ = get(u, 1500000); p = ld_product(h4) if s4 == 200 else None
    if p: got.append(p)
    if len(got) >= 2: break
  o['parsed'] = got
  return host, o
res = {}
with cf.ThreadPoolExecutor(12) as ex:
  for h, o in ex.map(probe, SITES): res[h] = o
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
