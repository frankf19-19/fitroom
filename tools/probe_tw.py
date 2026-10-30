import json, re, urllib.request, concurrent.futures as cf
UA = {'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Accept': '*/*', 'Accept-Language': 'zh-TW'}
def get(u, timeout=20):
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=timeout) as r: return r.status, r.read(400000).decode('utf-8', 'replace'), r.geturl()
  except urllib.error.HTTPError as e: return e.code, '', u
  except Exception as e: return 0, str(e)[:80], u
DOMAINS = '''queenshop.com.tw pazzo.com.tw meierq.com obdesign.com.tw gracegift.com.tw grace-gift.com.tw lativ.com.tw net-fashion.net mercci22.com lovfee.com cozyfee.com wstyle.com.tw tokichoi.com bonbons.com.tw anden-hud.com plain-me.com nnew.com.tw daf-shoes.com vacanza.com.tw ensso.com.tw hangten.com.tw giordano.com.tw bossini.com.tw muji.com.tw honeycoco.com.tw air-space.com.tw airspace.com.tw yourz.com.tw shopping.friday.tw kiriko.com.tw dotdotdot.com.tw leon.com.tw pinkoi.com tonyprint.com lulus.tw mos.com.tw mamaway.com.tw wakeup.com.tw imeier.com.tw 89room.com.tw jerzees.com.tw yo-che.com.tw beauty-shop.com.tw doublelove.com.tw lovelyday.com.tw puzzle.com.tw sweet-cat.com.tw moaprefer.com.tw cache-cache.com.tw ohoh-mini.com.tw annies.com.tw dazzling.com.tw wonderland.com.tw ifm.tw ohmymarket.com.tw icon-eyewear.com.tw ninjaeyewear.com.tw owndays.com tofu.com.tw mio-mio.com.tw sinfonia.com.tw lalashop.com.tw miusa.com.tw mo-bo.com.tw abby.com.tw 2wo.com.tw genquo.com stage.com.tw roots.com.tw timberland.com.tw drmartens.com.tw onitsukatiger.com crocs.com.tw skechers.com.tw newbalance.com.tw converse.com.tw vans.com.tw nike.com adidas.com.tw puma.com levis.com.tw lee.com.tw edwin.com.tw bluewaygroup.com sanding.com.tw ufa.com.tw shopee.tw momoshop.com.tw'''.split()
def probe(d):
  out = {}
  st, t, final = get(f'https://www.{d}/' if not d.startswith('www.') and d.count('.') <= 2 and not d.endswith('.tw') or d.endswith('.com.tw') else f'https://{d}/')
  if st != 200: st, t, final = get(f'https://{d}/')
  out['home'] = st; out['final'] = final
  low = t.lower()
  plat = []
  for k, sig in [('shopify', 'cdn.shopify.com'), ('shopline', 'shoplineapp'), ('shopline', 'shopline'), ('91app', '91app'), ('cyberbiz', 'cyberbiz'), ('waca', 'waca'), ('easystore', 'easystore'), ('meepshop', 'meepshop'), ('woocommerce', 'woocommerce'), ('magento', 'mage/'), ('salesforce', 'demandware')]:
    if sig in low and k not in plat: plat.append(k)
  out['plat'] = plat
  base = re.match(r'https?://[^/]+', final).group(0) if final.startswith('http') else f'https://{d}'
  st2, t2, _ = get(base + '/products.json?limit=2')
  if st2 == 200 and t2.strip().startswith('{'):
    try: j = json.loads(t2); ps = j.get('products', []); out['products_json'] = len(ps); out['sample'] = ps and (ps[0].get('title'), ps[0].get('product_type'), (ps[0].get('variants') or [{}])[0].get('price'))
    except Exception as e: out['products_json'] = 'parse:' + str(e)[:40]
  else: out['products_json'] = st2
  return d, out
res = {}
with cf.ThreadPoolExecutor(16) as ex:
  for d, o in ex.map(probe, DOMAINS): res[d] = o
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
