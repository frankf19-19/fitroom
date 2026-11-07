"""第五輪探測：大量台灣品牌官網的網域與平台辨識（91APP／Shopline／Cyberbiz／Shopify／SFCC／Magento…），
另外看 Queen Shop 商品頁的 dataLayer 與 plain-me 圖片。每個網域最多 4 個請求。輸出 out.json。"""
import json, re, gzip, time, urllib.request, urllib.parse, concurrent.futures as cf
BOT = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
def get(u, n=1500000, ua=BOT, timeout=20, headers=None):
  u = urllib.parse.quote(u, safe=':/?&=%#+,;@~')
  h = {'User-Agent': ua, 'Accept-Language': 'zh-TW,zh;q=0.9', 'Accept': 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8'}
  if headers: h.update(headers)
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=timeout) as r:
      b = r.read(n)
      if b[:2] == b'\x1f\x8b':
        try: b = gzip.decompress(b)
        except Exception: pass
      return r.status, b.decode('utf-8', 'replace'), r.geturl(), r.headers.get('content-type', '')
  except urllib.error.HTTPError as e: return e.code, '', u, ''
  except Exception as e: return 0, 'ERR ' + str(e)[:100], u, ''

SIGS = {'91app': r'nineyi|91app|91APP', 'shopline': r'shoplineapp|shoplytics|SHOPLINE', 'cyberbiz': r'cyberbiz', 'shopify': r'cdn\.shopify\.com|Shopify\.theme',
        'sfcc': r'demandware|/on/demandware\.store|dwvar_|sfcc', 'magento': r'Magento|mage/|requirejs-config', 'meepshop': r'meepshop', 'waca': r'waca\.ec|wacaApp',
        'easystore': r'easystore', 'shopone': r'shop1\.com\.tw|shopone', 'nuxt': r'__NUXT__', 'next': r'__NEXT_DATA__', 'salesforce': r'salesforce', 'vtex': r'vtex',
        'sap': r'hybris|_ui/responsive', 'ldjson_product': r'"@type"\s*:\s*"Product"'}
CANDS = {
  'tokichoi': ['www.tokichoi.com', 'www.tokichoi.com.tw', 'tokichoi.com'],
  'Bonbons': ['www.bonbons.com.tw', 'bonbons.com.tw'],
  'H:CONNECT': ['www.hconnect.com.tw', 'www.h-connect.com.tw', 'hconnect.com.tw'],
  'iROO': ['www.iroo.com.tw', 'shop.iroo.com.tw', 'www.irooshop.com'],
  'CHARLES & KEITH': ['www.charleskeith.com/tw/zh-TW/', 'www.charleskeith.com/tw/'],
  'PEDRO': ['www.pedroshoes.com/tw/', 'www.pedroshoes.com/tw/zh-TW/'],
  'LeSportsac': ['www.lesportsac.com.tw', 'lesportsac.com.tw'],
  'Coach': ['tw.coach.com', 'www.coach.com.tw'],
  'Kate Spade': ['www.katespade.com.tw', 'tw.katespade.com'],
  'Longchamp': ['www.longchamp.com/tw/zh/'],
  'Tommy Hilfiger': ['tw.tommy.com', 'www.tommy.com.tw', 'www.tommyhilfiger.com.tw'],
  'Calvin Klein': ['www.calvinklein.com.tw', 'tw.calvinklein.com'],
  'Lee': ['www.lee.com.tw', 'www.leejeans.com.tw'],
  'Wrangler': ['www.wrangler.com.tw'],
  'Superdry': ['www.superdry.com.tw', 'www.superdry.tw'],
  'ASICS': ['www.asics.com/tw/zh-tw/'],
  'Onitsuka Tiger': ['www.onitsukatiger.com/tw/zh-tw/'],
  'MIZUNO': ['www.mizuno.com.tw', 'shop.mizuno.com.tw', 'www.mizunoshop.com.tw'],
  'Nike': ['www.nike.com/tw/'],
  'MLB': ['www.mlb-korea.com.tw', 'www.mlbkorea.com.tw', 'tw.mlb-korea.com'],
  'Kangol': ['www.kangol.com.tw', 'www.kangolshop.com.tw'],
  'Arnold Palmer': ['www.arnoldpalmer.com.tw', 'www.ap-shop.com.tw'],
  'Hush Puppies': ['www.hushpuppies.com.tw'],
  'Clarks': ['www.clarks.com.tw', 'www.clarks.tw'],
  'ECCO': ['www.ecco.com.tw', 'tw.ecco.com'],
  'Dr. Martens': ['www.drmartens.com.tw', 'drmartens.com.tw', 'www.drmartens-tw.com'],
  'Native Shoes': ['www.nativeshoes.com.tw', 'www.native-shoes.com.tw'],
  'TEVA': ['www.teva.com.tw', 'teva.com.tw'],
  'KEEN': ['www.keen.com.tw', 'www.keenfootwear.com.tw'],
  'Champion': ['www.champion.tw', 'www.championstore.com.tw', 'champion-tw.com'],
  'AIR SPACE': ['www.airspaceonline.com'],
  'Lovfee': ['www.lovfee.com', 'www.lovfee.com.tw'],
  'WSTYLE': ['www.wstyle.com.tw'],
  'Mog': ['www.mog.com.tw', 'www.mogshop.com.tw'],
  'Bellini': ['www.bellini.com.tw'],
  'SNIDEL': ['www.snidel.com.tw', 'www.usagi-online.com.tw', 'tw.usagi-online.com'],
  'gelato pique': ['www.gelatopique.com.tw'],
  'niko and...': ['www.nikoand.com.tw', 'www.dot-st.tw', 'www.and-st.tw'],
  'earth music&ecology': ['www.earth1999.com.tw', 'www.stripe-club.com.tw'],
  'GLOBAL WORK': ['www.globalwork.com.tw'],
  'LOWRYS FARM': ['www.lowrysfarm.com.tw'],
  'Samantha Thavasa': ['www.samantha.com.tw', 'www.samanthathavasa.com.tw'],
  'Pandora': ['tw.pandora.net', 'www.pandora.net/zh-tw/'],
  'Swarovski': ['www.swarovski.com/zh-TW/'],
  'agnes b.': ['www.agnesb.com.tw', 'tw.agnesb.com'],
  'Queen Shop': ['www.queenshop.com.tw'],
}
def probe(brand, target):
  host = target.split('/')[0]; path = '/' + target.split('/', 1)[1] if '/' in target else '/'
  o = {'target': target}
  s, rt, _, _ = get(f'https://{host}/robots.txt', 200000)
  o['robots_st'] = s; o['robots'] = rt[:700] if s == 200 else rt[:80]
  o['sitemaps'] = re.findall(r'(?im)^sitemap:\s*(\S+)', rt)[:5] if s == 200 else []
  m = re.search(r'Sitemap/(\d+)/Sitemap_Index', rt); o['shop91'] = m and m.group(1)
  time.sleep(0.3)
  s, h, fin, ct = get(f'https://{host}{path}')
  o['home_st'] = s; o['final'] = fin; o['len'] = len(h)
  if s in (403, 0, 503) or (s == 200 and len(h) < 1500):
    time.sleep(0.3); s2, h2, fin2, _ = get(f'https://{host}{path}', ua=BROWSER)
    o['home_browser_st'] = s2; o['browser_len'] = len(h2)
    if s2 == 200 and len(h2) > len(h): h, fin = h2, fin2
  o['title'] = html_title(h); o['sigs'] = [k for k, rx in SIGS.items() if re.search(rx, h)]
  o['err'] = h[:100] if h.startswith('ERR') else None
  o['prod_links'] = list(dict.fromkeys(re.findall(r'href=["\']([^"\']*(?:/products?/|SalePage|/p/|/pdp/|product_detail|/goods/|/item/)[^"\']*)', h)))[:6]
  o['twd'] = bool(re.search(r'NT\$|TWD|NT\s*\$', h))
  if 'shopify' in o['sigs']:
    time.sleep(0.3); s3, j, _, _ = get(f'https://{host}/products.json?limit=2', 300000)
    o['products_json'] = s3; o['pj_ex'] = j[:300]
  return o
def html_title(h): return (re.search(r'<title[^>]*>(.*?)</title>', h, re.S | re.I) or [None, ''])[1].strip()[:80]

def queenshop():
  o = {}
  s, h, fin, _ = get('https://www.queenshop.com.tw/zh-TW/QueenShop/ProductList?item1=01')
  o['list_st'] = s; o['list_len'] = len(h)
  ids = list(dict.fromkeys(re.findall(r'Product\?SaleID=([A-Za-z0-9]+)', h)))
  o['n_ids'] = len(ids); o['ids'] = ids[:8]
  o['list_patterns'] = list(dict.fromkeys(re.findall(r'href=["\'](/[^"\']{5,80})', h)))[:40]
  pages = []
  for sid in ids[:2]:
    time.sleep(0.5); s2, h2, _, _ = get(f'https://www.queenshop.com.tw/zh-TW/QueenShop/Product?SaleID={sid}')
    r = {'sid': sid, 'st': s2, 'len': len(h2), 'title': html_title(h2)}
    r['datalayer'] = [x[:900] for x in re.findall(r'dataLayer\.push\((.{0,1500}?)\);', h2, re.S)][:4]
    r['gtag'] = [x[:600] for x in re.findall(r'(?:gtag|ecommerce)[^\n]{0,600}', h2)][:4]
    r['imgs'] = list(dict.fromkeys(re.findall(r'(https?://[^"\'\s>]+?\.(?:jpe?g|png|webp))', h2, re.I)))[:12]
    r['src_imgs'] = list(dict.fromkeys(re.findall(r'src=["\']([^"\']+?\.(?:jpe?g|png|webp)[^"\']*)', h2, re.I)))[:12]
    r['og'] = re.findall(r'<meta[^>]+(?:og:|itemprop)[^>]+>', h2)[:8]
    r['price_hits'] = [x.strip() for x in re.findall(r'[^\n<>]{0,80}(?:NT\$|售價|特價|"price"|Price)[^\n<>]{0,80}', h2)][:12]
    r['json_vars'] = [x[:400] for x in re.findall(r'var\s+\w+\s*=\s*[\[{][^\n]{20,400}', h2)][:6]
    pages.append(r)
  o['pages'] = pages
  return o

def plainme():
  o = {}
  s, h, _, _ = get('https://www.plain-me.com/women/')
  ls = list(dict.fromkeys(re.findall(r'href=["\']([^"\']*/product-detail/[^"\']+)', h)))
  o['n'] = len(ls)
  if not ls: return o
  u = ls[0] if ls[0].startswith('http') else 'https://www.plain-me.com' + ls[0]
  time.sleep(0.5); s, h2, _, _ = get(u)
  img = (re.search(r'property=["\']og:image["\'][^>]*content=["\']([^"\']+)', h2) or [None, None])[1]
  o['img'] = img
  if img:
    for name, hd in [('bot', {'User-Agent': 'Mozilla/5.0 (compatible; TryOnBot/1.0)'}), ('browser_ref', {'User-Agent': BROWSER, 'Referer': 'https://www.plain-me.com/', 'Accept': 'image/*'})]:
      time.sleep(0.4)
      try:
        with urllib.request.urlopen(urllib.request.Request(img, headers=hd), timeout=20) as r: o[name] = [r.status, r.headers.get('content-type'), len(r.read())]
      except urllib.error.HTTPError as e: o[name] = [e.code]
      except Exception as e: o[name] = [str(e)[:80]]
  return o

res = {}
jobs = [(b, t) for b, ts in CANDS.items() for t in ts]
def go(bt):
  try: return bt, probe(*bt)
  except Exception as e: return bt, {'exc': repr(e)[:200]}
with cf.ThreadPoolExecutor(10) as ex:
  for (b, t), o in ex.map(go, jobs): res.setdefault(b, []).append(o)
try: res['_queenshop'] = queenshop()
except Exception as e: res['_queenshop'] = {'exc': repr(e)}
try: res['_plainme'] = plainme()
except Exception as e: res['_plainme'] = {'exc': repr(e)}
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
