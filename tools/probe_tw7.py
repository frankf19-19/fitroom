"""第四輪探測：plain-me／Queen Shop／D+AF／CACO 商品頁有無結構化資料；Birkenstock 分類頁。輸出 out.json。"""
import json, re, gzip, time, urllib.request, urllib.parse, concurrent.futures as cf
from collections import Counter
BOT = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
def get(u, n=2000000, ua=BOT, timeout=25):
  u = urllib.parse.quote(u, safe=':/?&=%#+,;@~')
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': ua, 'Accept-Language': 'zh-TW,zh;q=0.9'}), timeout=timeout) as r:
      b = r.read(n)
      if b[:2] == b'\x1f\x8b':
        try: b = gzip.decompress(b)
        except Exception: pass
      return r.status, b.decode('utf-8', 'replace'), r.geturl()
  except urllib.error.HTTPError as e: return e.code, '', u
  except Exception as e: return 0, 'ERR ' + str(e)[:120], u
def ld_product(html):
  for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I):
    raw = re.sub(r'"@context":\s*(https?://[^",\s]+)', r'"@context": "\1"', m.group(1).strip())
    try: j = json.loads(raw)
    except Exception as e: continue
    for it in (j if isinstance(j, list) else (j.get('@graph') or [j])):
      if isinstance(it, dict) and 'Product' in str(it.get('@type')):
        off = it.get('offers') or {}
        if isinstance(off, list): off = off[0] if off else {}
        img = it.get('image'); img = img[0] if isinstance(img, list) else (img.get('url') if isinstance(img, dict) else img)
        return {'name': it.get('name'), 'image': img, 'price': off.get('price') or off.get('lowPrice'), 'avail': off.get('availability'), 'category': it.get('category')}
  return None
def links(html, base):
  out = []
  for m in re.findall(r'(?:href|data-href|data-url)=["\']([^"\'#]+)', html):
    m = m.replace('&amp;', '&')
    if m.startswith('//'): m = 'https:' + m
    elif m.startswith('/'): m = base + m
    elif not m.startswith('http'): continue
    out.append(m)
  return list(dict.fromkeys(out))
def run(host, listings, rx, want=2):
  base = 'https://' + host; o = {'listings': []}; details = []
  for lu in listings:
    time.sleep(0.4); s, h, _ = get(lu); ls = links(h, base)
    found = [l for l in ls if re.search(rx, l)]
    o['listings'].append({'url': lu, 'st': s, 'len': len(h), 'n_detail': len(found), 'ex': found[:2]})
    details += found
  details = list(dict.fromkeys(details)); o['n_detail'] = len(details); o['pages'] = []
  for u in details[:want]:
    time.sleep(0.5); s2, h2, _ = get(u, 1500000); p = ld_product(h2) if s2 == 200 else None
    r = {'url': u, 'st': s2, 'len': len(h2), 'p': p}
    if s2 == 200 and not (p and p.get('price')):
      r['ld_raw'] = [m[:500] for m in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', h2, re.S | re.I)][:3]
      r['itemprop'] = re.findall(r'itemprop=["\'](?:price|name|image)["\'][^>]*', h2)[:5]
      r['og'] = re.findall(r'<meta[^>]+property=["\'](?:og:title|og:image|product:price:amount)["\'][^>]+', h2)[:4]
      r['price_hits'] = [x.strip() for x in re.findall(r'[^\n<>]{0,60}(?:NT\$|售價|"price"|price)[^\n<>]{0,60}', h2)][:8]
    o['pages'].append(r)
  return o
jobs = {
  'plainme': lambda: run('www.plain-me.com', ['https://www.plain-me.com/men/', 'https://www.plain-me.com/women/', 'https://www.plain-me.com/men/product-tags/新品'], r'plain-me\.com/(?:men|women)/product-detail/'),
  'queenshop': lambda: run('www.queenshop.com.tw', ['https://www.queenshop.com.tw/', 'https://www.queenshop.com.tw/zh-TW/QueenShop/ProductList?item1=01'], r'QueenShop/Product\?SaleID='),
  'daf': lambda: run('www.daf-shoes.com', ['https://www.daf-shoes.com/product/list/142'], r'daf-shoes\.com/product/show/\d+'),
  'caco': lambda: run('www.caco.com.tw', ['https://www.caco.com.tw/productlist/51401?page=1&ca=caco-tee'], r'caco\.com\.tw/product/[A-Z0-9]+/\d+$'),
  'birkenstock': lambda: run('www.birkenstock.com.tw', ['https://www.birkenstock.com.tw/product_category?store_type_sn=40&category_sn=36', 'https://www.birkenstock.com.tw/product_store?store_type_sn=40'], r'product_detail\?product_sn=', want=1),
}
res = {}
def go(k):
  try: return k, jobs[k]()
  except Exception as e: return k, {'err': repr(e)[:200]}
with cf.ThreadPoolExecutor(5) as ex:
  for k, o in ex.map(go, list(jobs)): res[k] = o
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
