"""robots.txt 合規稽核：抓所有同步用網域的 robots.txt 原文；91APP 另抓網站地圖與一個 SalePage 商品頁 HTML（只在 robots 允許時），
看頁面內嵌了哪些商品資料。UNIQLO／GU 也看 API 網域與商品頁。輸出 robots_audit.json、html/<host>.html.gz。"""
import json, os, re, gzip, time, urllib.request, urllib.parse, urllib.error, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
import sizecharts as SC

UA = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
SHOPS91 = ['www.obdesign.com.tw', 'www.giordano.com.tw', 'www.vans.com.tw', 'www.adidas.com.tw', 'www.roots.com.tw', 'www.edwin.com.tw', 'www.timberland.com.tw', 'www.levis.com.tw', 'tw.puma.com', 'www.thenorthface.com.tw', 'www.underarmour.tw', 'www.columbiasportswear.com.tw', 'www.onitsukatiger.com.tw', 'www.leejeans.com.tw', 'www.mlb-korea.com.tw', 'www.alasha.com.tw', 'www.lacoste.com.tw', 'www.kipling.com.tw', 'www.bigtrain.com.tw', 'www.dot-st.tw', 'www.stripe-club.com.tw']
OTHER = ['www.lativ.com.tw', 'www.crocs.com.tw', 'www.vacanza.com.tw', 'www.pazzo.com.tw', 'www.meierq.com', 'www.mercci22.com', 'www.50-shop.com', 'www.lulus.com.tw', 'www.fila.com.tw', 'www.gap.tw', 'www.gracegift.com.tw', 'www.mouggan.com', 'www.goopi.co', 'www.merrell.com.tw', 'www.jansport.com.tw', 'www.saucony.com.tw', 'lesportsac.tw', 'www.airspaceonline.com', 'www.charleskeith.com', 'www.pedroshoes.com', 'www.longchamp.com',
         'www.birkenstock.com.tw', 'www.plain-me.com', 'www.daf-shoes.com', 'www.caco.com.tw', 'www.queenshop.com.tw', 'www.usagi-online.com.tw', 'www.iroo.com', 'www.gozo.com.tw', 'salomon.com.tw',
         'd.uniqlo.com', 'd.gu-global.com', 'www.uniqlo.com', 'www.gu-global.com']

def raw(u, n=4000000):
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA, 'Accept-Language': 'zh-TW'}), timeout=30) as r:
      b = r.read(n)
      if b[:2] == b'\x1f\x8b':
        try: b = gzip.decompress(b)
        except Exception: pass
      return r.status, SC.decode_html(b, r.headers.get_content_charset()), r.geturl()
  except urllib.error.HTTPError as e: return e.code, '', u
  except Exception as e: return 0, repr(e)[:200], u

out = {'robots': {}, 'shops91': {}, 'fr': {}}
os.makedirs('html', exist_ok=True)
for h in SHOPS91 + OTHER:
  s, t, fin = raw(f'https://{h}/robots.txt', 300000)
  out['robots'][h] = {'status': s, 'final': fin, 'text': t[:20000]}
  time.sleep(0.3)

def ok(u): return SC.ROBOTS.allowed(u, UA)

for h in SHOPS91:
  o = out['shops91'][h] = {}
  sm = f'https://{h}/Sitemap/sitemap_ShopSalePage.xml.gz'
  o['sitemap_allowed'] = ok(sm)
  o['webapi_allowed'] = ok(f'https://{h}/webapi/SalePageV2/GetSalePageV2Info/1/1')
  if not o['sitemap_allowed']: continue
  s, x, _ = raw(sm); o['sitemap_status'] = s; o['sitemap_head'] = x[:600]
  ids = sorted({int(i) for i in re.findall(r'SalePage/Index/(\d+)', x)}, reverse=True)
  o['n_ids'] = len(ids)
  for sid in ids[:2]:
    u = f'https://{h}/SalePage/Index/{sid}'
    o.setdefault('pages', []).append({'url': u, 'allowed': ok(u)})
    if not ok(u): continue
    time.sleep(0.5); s, p, fin = raw(u)
    pg = o['pages'][-1]; pg.update(status=s, final=fin, len=len(p))
    pg['ld'] = [m[:3000] for m in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', p, re.S | re.I)][:4]
    pg['og'] = dict(re.findall(r'<meta[^>]+property=["\']((?:og|product):[\w:]+)["\'][^>]+content=["\']([^"\']*)', p))
    pg['globals'] = sorted(set(re.findall(r'(window\.[A-Za-z_$][\w$.]*)\s*=', p)))[:80]
    pg['nineyi'] = sorted(set(re.findall(r'(nineyi\.[\w.]+)\s*=', p)))[:80]
    pg['next'] = '__NEXT_DATA__' in p
    for k in ('SKUPropertySetList', 'MajorList', 'PropertyNameSet', 'SalePageId', 'Price', 'SuggestPrice', 'ImageList', 'ShopCategory', 'StatusDef', 'SoldOut', 'IsSoldOut', '尺寸', 'size'):
      i = p.find(k); pg['ctx_' + k] = p[max(0, i - 200): i + 400] if i >= 0 else None
    if sid == ids[0]:
      with gzip.open(f'html/{h}.html.gz', 'wt', encoding='utf-8') as f: f.write(p)

# UNIQLO／GU：API 與商品頁是否允許、頁面是否有伺服器端資料
for brand, web, api in [('uniqlo', 'https://www.uniqlo.com', 'https://d.uniqlo.com'), ('gu', 'https://www.gu-global.com', 'https://d.gu-global.com')]:
  o = out['fr'][brand] = {}
  for u in [api + '/tw/p/search/products/by-category', api + '/tw/product/spu/size-list', api + '/tw/product/detail?productCode=u0000000000000',
            web + '/tw/hmall/test/u0000000000000/zh_TW/sizeAndTryOn.html', web + '/tw/zh_TW/product-detail.html?productCode=u0000000000000',
            web + '/tw/zh_TW/c/all_women-tops-t-shirts.html', web + '/tw/zh_TW/c/women_outer.html', web + '/tw/sitemap.xml']:
    o[u] = ok(u)
  for u in [web + '/tw/zh_TW/c/' + ('all_women-tops-t-shirts' if brand == 'uniqlo' else 'women_outer') + '.html']:
    if not ok(u): continue
    time.sleep(0.5); s, p, fin = raw(u)
    o['cat_page'] = {'status': s, 'len': len(p), 'productCodes': list(dict.fromkeys(re.findall(r'(u\d{13}|g\d{13})', p)))[:10], 'ld': [m[:1500] for m in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', p, re.S | re.I)][:2]}
    with gzip.open(f'html/{brand}-cat.html.gz', 'wt', encoding='utf-8') as f: f.write(p)
  sm = [l.split(':', 1)[1].strip() for l in out['robots'][web[8:]]['text'].splitlines() if l.lower().startswith('sitemap:')]
  o['sitemaps'] = sm[:20]
  for u in sm[:6]:
    if 'tw' not in u.lower() or not ok(u): continue
    time.sleep(0.5); s, x, _ = raw(u, 3000000)
    o.setdefault('sm', {})[u] = {'status': s, 'head': x[:1200], 'n_loc': len(re.findall('<loc>', x))}
json.dump(out, open('robots_audit.json', 'w'), ensure_ascii=False, indent=1)
print('done')
