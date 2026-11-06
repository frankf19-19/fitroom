"""診斷 PAZZO／MEIER.Q／Mercci22 同步沒抓到商品的原因：網站地圖排序與尾端商品頁的狀態。輸出 out.json。"""
import json, re, time, urllib.request, urllib.parse, urllib.robotparser
UA = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
def get(u, n=3000000):
  u = urllib.parse.quote(u, safe=':/?&=%#+,;@~')
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA, 'Accept-Language': 'zh-TW'}), timeout=30) as r: return r.status, r.read(n).decode('utf-8', 'replace')
  except urllib.error.HTTPError as e: return e.code, e.read(2000).decode('utf-8', 'replace')
  except Exception as e: return 0, 'ERR ' + str(e)[:100]
def ld(html):
  out = []
  for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I):
    try: j = json.loads(m.group(1).strip())
    except Exception as e: out.append('BAD ' + str(e)[:60] + ' ' + m.group(1).strip()[:120]); continue
    for it in (j if isinstance(j, list) else (j.get('@graph') or [j])):
      if isinstance(it, dict): out.append({'type': it.get('@type'), 'name': it.get('name'), 'offers': it.get('offers') if 'Product' in str(it.get('@type')) else None})
  return out
res = {}
for host, pat in [('www.pazzo.com.tw', r'\.tw/market/n/\d+$'), ('www.meierq.com', r'\.com/market/n/\d+$'), ('www.mercci22.com', r'\.com/market/n/\d+$')]:
  o = {}
  st, rt = get(f'https://{host}/robots.txt'); rp = urllib.robotparser.RobotFileParser(); rp.parse(rt.splitlines())
  st, x = get(f'https://{host}/sitemap.xml', 6000000)
  locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', x)
  lastmod = re.findall(r'<lastmod>\s*([^<\s]+)\s*</lastmod>', x)
  urls = [l for l in locs if re.search(pat, l)]
  o['sitemap_st'] = st; o['n_locs'] = len(locs); o['n_match'] = len(urls); o['n_lastmod'] = len(lastmod); o['lastmod_ex'] = lastmod[:3] + lastmod[-3:]
  o['first'] = urls[:4]; o['last'] = urls[-4:]
  ids = [int(re.search(r'/n/(\d+)', u).group(1)) for u in urls]
  o['id_min'] = min(ids); o['id_max'] = max(ids); o['sorted_asc'] = ids == sorted(ids); o['sorted_desc'] = ids == sorted(ids, reverse=True)
  o['can_fetch'] = rp.can_fetch(UA, urls[-1])
  pages = []
  for u in urls[-6:] + urls[:3] + [f'https://{host}/market/n/{max(ids)}', f'https://{host}/market/n/{max(ids) - 3}']:
    time.sleep(0.6); s, h = get(u, 2000000)
    pages.append({'url': u, 'st': s, 'len': len(h), 'ld': ld(h) if s == 200 else h[:200], 'title': (re.search(r'<title[^>]*>(.*?)</title>', h, re.S) or [None, ''])[1].strip()[:60]})
  o['pages'] = pages
  res[host] = o
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
