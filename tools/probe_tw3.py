import json, re, sys
sys.path.insert(0, '../tools')
from probe_tw2 import get, ld_product
res = {}
for host, ids in [('www.pazzo.com.tw', ['20873', '16646']), ('www.meierq.com', ['10282', '10105']), ('www.mercci22.com', ['5977', '1681'])]:
  out = []
  for i in ids:
    for path in [f'/zh-tw/market/n/{i}', f'/market/n/{i}']:
      st, h, fin = get(f'https://{host}{path}', 1500000)
      p = ld_product(h) if st == 200 else None
      out.append({'path': path, 'st': st, 'p': p, 'len': len(h), 'imgs': re.findall(r'https://[^"\']+\.(?:jpg|jpeg|png|webp)', h)[:3]})
      if p: break
  res[host] = out
for host in ['www.obdesign.com.tw', 'www.giordano.com.tw', 'www.vans.com.tw', 'www.adidas.com.tw', 'www.roots.com.tw', 'www.edwin.com.tw', 'www.timberland.com.tw', 'www.levis.com.tw']:
  st, x, _ = get(f'https://{host}/robots.txt'); sm = (re.findall(r'(?im)^sitemap:\s*(\S+)', x) or [None])[0]
  st, x, _ = get(sm) if sm else (0, '', '')
  subs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x)
  info = {'index': sm, 'subs': subs[:12]}
  sale = []
  for sub in subs:
    if re.search(r'salepage', sub, re.I) and 'Category' not in sub:
      s3, x3, _ = get(sub); sale += re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x3)
      if len(sale) > 5: break
  info['salepages'] = len(sale); info['ex'] = sale[:3]
  if sale:
    s4, h4, _ = get(sale[0], 1500000); info['parsed'] = ld_product(h4) if s4 == 200 else s4
    shop = re.search(r'Sitemap/(\d+)/', sm or ''); sid = re.search(r'SalePage/Index/(\d+)', sale[0])
    if shop and sid:
      for api in [f'https://{host}/webapi/SalePageV2/GetSalePageV2Info/{shop.group(1)}/{sid.group(1)}', f'https://{host}/webapi/SalePage/GetSalePageV2Info/{shop.group(1)}/{sid.group(1)}']:
        s5, h5, _ = get(api, 300000); info.setdefault('api', []).append([api, s5, h5[:300]])
  res[host] = info
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
