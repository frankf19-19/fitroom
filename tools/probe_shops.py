import json, re, urllib.request
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept': 'application/json,text/html'}
def get(u, data=None, headers=None):
  h = dict(UA); h.update(headers or {})
  req = urllib.request.Request(u, data=data, headers=h)
  try:
    with urllib.request.urlopen(req, timeout=25) as r: return r.status, r.read().decode('utf-8', 'replace')
  except urllib.error.HTTPError as e: return e.code, e.read().decode('utf-8', 'replace')[:300]
  except Exception as e: return 0, str(e)[:200]
out = {}
shops = ['allbirds.com', 'gymshark.com', 'kith.com', 'fashionnova.com', 'lackofcolor.com', 'bellroy.com', 'herschel.com', 'ana-luisa.com', 'mvmt.com', 'brooklinen.com', 'cupshe.com', 'shein.com', 'princesspolly.com', 'tigermist.com.au', 'beginningboutique.com.au', 'hellomolly.com', 'skims.com', 'aloyoga.com', 'vuori.com', 'rhone.com', 'taylorstitch.com', 'outerknown.com', 'rothys.com', 'veja-store.com', 'converse.com', 'newera.com', 'oqliq.co', 'meierq.com', 'queenshop.com.tw', 'obdesign.com.tw', 'lativ.com.tw', 'net-fashion.net', 'shop.ithinkso.com.tw', 'store.ithinkso.com.tw', 'fiftypercent.com.tw', 'marjorie.com.tw', 'gozo.com.tw', 'gracegift.com.tw']
for d in shops:
  st, t = get(f'https://{d}/products.json?limit=3')
  info = {'status': st}
  if st == 200:
    try:
      j = json.loads(t); ps = j.get('products', [])
      info['n'] = len(ps)
      if ps:
        p = ps[0]; info['sample'] = {'title': p.get('title'), 'type': p.get('product_type'), 'tags': (p.get('tags') or [])[:6] if isinstance(p.get('tags'), list) else str(p.get('tags'))[:80], 'price': (p.get('variants') or [{}])[0].get('price'), 'img': ((p.get('images') or [{}])[0]).get('src'), 'options': [o.get('name') for o in p.get('options', [])]}
    except Exception as e: info['err'] = str(e)[:100]; info['head'] = t[:120]
  else: info['head'] = t[:120]
  out[d] = info
# GU Taiwan
st, html = get('https://www.gu-global.com/tw/zh_TW/')
cats = sorted(set(re.findall(r'/tw/zh_TW/c/([a-z0-9_\-]+)\.html', html)))
out['gu_home'] = {'status': st, 'cats': cats[:60]}
for code in [c for c in cats if 'women' in c or 'men' in c][:3]:
  body = json.dumps({"url": f"/tw/zh_TW/c/{code}.html", "categoryCode": code, "pageInfo": {"page": 1, "pageSize": 5, "withSideBar": "Y"}, "belongTo": "pc", "rank": "overall", "priceRange": {"low": 0, "high": 0}, "color": [], "size": [], "season": [], "material": [], "sex": [], "identity": [], "insideFilterCondition": [], "exclusiveCondition": [], "isCategoryExclusive": "N"}).encode()
  for host in ['https://d.gu-global.com/tw/p/search/products/by-category', 'https://www.gu-global.com/tw/p/search/products/by-category']:
    st, t = get(host, body, {'Content-Type': 'application/json', 'Origin': 'https://www.gu-global.com', 'Referer': 'https://www.gu-global.com/'})
    out[f'gu:{code}:{host[:30]}'] = {'status': st, 'head': t[:300]}
# ZARA Taiwan
st, t = get('https://www.zara.com/tw/zh/categories?ajax=true')
out['zara'] = {'status': st, 'head': t[:200]}
st, t = get('https://www2.hm.com/zh_asia3/ladies/shop-by-product/view-all.html')
out['hm'] = {'status': st, 'head': t[:150]}
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
