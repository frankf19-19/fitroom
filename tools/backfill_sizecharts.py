#!/usr/bin/env python3
"""一次性（可重跑）：替所有上架中的商品寫尺寸表到 Supabase Storage，並統計各品牌覆蓋率。
- UNIQLO／GU：官方商品尺寸 API（sizecharts.fr_garment_chart）；拿不到就用 UNIQLO/GU 身體尺寸表
- 商品頁型（web:*）：重新抓商品頁解析尺寸表 <table>；商品原本沒有 sizes 時順便補上
- 91APP／Shopify：描述多半是圖片，直接用身體尺寸表
遵守 robots.txt（含 Crawl-delay），每個網域單線、間隔 ≥ 0.4 秒。
環境變數：SUPABASE_URL、SUPABASE_SERVICE_KEY；ONLY=只跑來源含此字串；MAX_PER_HOST（預設 400）。輸出 out/coverage.json。
"""
import json, os, re, sys, time, urllib.request, urllib.parse, urllib.robotparser, concurrent.futures as cf, gzip
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sizecharts as SC

SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/'); KEY = os.environ['SUPABASE_SERVICE_KEY']
ONLY = os.environ.get('ONLY', ''); MAX_PER_HOST = int(os.environ.get('MAX_PER_HOST', '400'))
UA = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'

def sb(method, path, data=None, prefer=None):
  h = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
  if prefer: h['Prefer'] = prefer
  req = urllib.request.Request(SUPABASE_URL + '/rest/v1/' + path, data=json.dumps(data).encode() if data is not None else None, headers=h, method=method)
  with urllib.request.urlopen(req, timeout=60) as r:
    t = r.read().decode(); return json.loads(t) if t else None
def get(u, n=3000000):
  u = urllib.parse.quote(u, safe=':/?&=%#+,;@~')
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA, 'Accept-Language': 'zh-TW'}), timeout=30) as r:
      b = r.read(n)
      if b[:2] == b'\x1f\x8b':
        try: b = gzip.decompress(b)
        except Exception: pass
      return r.status, SC.decode_html(b, r.headers.get_content_charset())
  except urllib.error.HTTPError as e: return e.code, ''
  except Exception: return 0, ''

products = []
for off in range(0, 50000, 1000):
  page = sb('GET', f'products?active=eq.true&select=id,source,external_id,brand,name,type,gender,sizes,buy_url&order=id&limit=1000&offset={off}')
  products += page
  if len(page) < 1000: break
products = [p for p in products if not ONLY or ONLY in (p.get('source') or '')]
print('active products', len(products))
store = SC.Store(); print('storage:', store.ensure())
result = {}   # id -> 'garment' | 'body' | None
lock_print = print

def do_fr(group):
  brand = 'gu' if group[0]['source'] == 'gu' else 'uniqlo'
  lists = SC.fr_size_lists(brand, [p['external_id'] for p in group])
  for p in group:
    sl = lists.get(p['external_id'])
    if sl and not p.get('sizes'):
      try: sb('PATCH', f"products?id=eq.{p['id']}", {'sizes': sl[:20]}, prefer='return=minimal'); p['sizes'] = sl[:20]
      except Exception as e: lock_print('  sizes patch fail', p['id'], e)
  for p in group:
    chart = None
    if p['type'] not in ('top', 'bottom', 'dress', 'shoes'): write(p, None); continue
    try: chart = SC.fr_garment_chart(brand, p['external_id'], p['type'], p['name'])
    except Exception as e: lock_print('  fr chart fail', p['external_id'], e)
    time.sleep(0.4)
    if chart and not p.get('sizes'):
      try: sb('PATCH', f"products?id=eq.{p['id']}", {'sizes': SC.chart_sizes(chart)[:20]}, prefer='return=minimal')
      except Exception: pass
    write(p, chart)

def write(p, chart):
  chart = chart or SC.body_chart(p.get('sizes') or [], p.get('type'), p.get('gender'), p.get('brand'))
  if not chart: result[p['id']] = None; return
  result[p['id']] = chart['kind'] if store.put(p['id'], chart) else None

_ROBOTS = {}
def robots_ok(u):
  h = urllib.parse.urlparse(u).netloc
  if h not in _ROBOTS:
    rp = urllib.robotparser.RobotFileParser(); st, rt = get(f'https://{h}/robots.txt', 300000); rp.parse(rt.splitlines() if st == 200 else []); _ROBOTS[h] = rp
  return _ROBOTS[h].can_fetch(UA, u)
def do_web(host, group):
  rp = urllib.robotparser.RobotFileParser(); st, rt = get(f'https://{host}/robots.txt', 300000)
  rp.parse(rt.splitlines() if st == 200 else [])
  delay = max(0.4, float(rp.crawl_delay(UA) or 0))
  n = 0
  for p in group:
    chart = None
    if p['type'] in ('top', 'bottom', 'dress', 'shoes') and p.get('buy_url') and n < MAX_PER_HOST and rp.can_fetch(UA, p['buy_url']):
      time.sleep(delay); n += 1
      s, h = get(p['buy_url'])
      if s == 200:
        try: chart = SC.pick_chart(h, p['type'], p['name'], '商品頁尺寸表 ' + p['buy_url'])
        except Exception as e: lock_print('  parse fail', p['buy_url'][:80], e)
        pop = not chart and p['type'] in ('top', 'bottom', 'dress') and re.search(r"popSizeChart\('(https://[^']+\.html?)'\)", h)   # Queen Shop：尺寸表在另一個小頁面
        if pop and robots_ok(pop.group(1)):
          time.sleep(delay); s2, h2 = get(pop.group(1), 600000)
          if s2 == 200: chart = SC.pick_chart(h2, p['type'], p['name'], '商品尺寸表 ' + pop.group(1))
      if chart and not p.get('sizes'):
        sz = SC.chart_sizes(chart)[:20]
        try: sb('PATCH', f"products?id=eq.{p['id']}", {'sizes': sz}, prefer='return=minimal'); p['sizes'] = sz
        except Exception as e: lock_print('  sizes patch fail', p['id'], e)
    write(p, chart)
  lock_print(host, 'pages', n, 'garment', sum(1 for p in group if result.get(p['id']) == 'garment'), '/', len(group))

groups = {}
for p in products: groups.setdefault(p['source'] or '', []).append(p)
jobs = []
with cf.ThreadPoolExecutor(10) as ex:
  for src, g in groups.items():
    if src in ('uniqlo', 'gu'): jobs.append(ex.submit(do_fr, g))
    elif src.startswith('web:'): jobs.append(ex.submit(do_web, src[4:], g))
    else: jobs.append(ex.submit(lambda g=g: [write(p, None) for p in g]))
  for j in jobs:
    try: j.result()
    except Exception as e: print('job FAIL', e)

# ---------- 覆蓋率 ----------
cov = {}
for p in products:
  b = p.get('brand') or '?'; c = cov.setdefault(b, {'active': 0, 'garment': 0, 'body': 0, 'none': 0, 'clothing': 0, 'garment_clothing': 0})
  k = result.get(p['id']); c['active'] += 1; c[k or 'none'] += 1
  if p['type'] in ('top', 'bottom', 'dress', 'shoes'):
    c['clothing'] += 1
    if k == 'garment': c['garment_clothing'] += 1
tot = {k: sum(c[k] for c in cov.values()) for k in ('active', 'garment', 'body', 'none', 'clothing', 'garment_clothing')}
rows = sorted(cov.items(), key=lambda x: -x[1]['active'])
lines = ['| 品牌 | 上架 | 商品實測表 | % | 身體尺寸表 | 無 |', '|---|---|---|---|---|---|']
for b, c in rows: lines.append(f"| {b} | {c['active']} | {c['garment']} | {100 * c['garment'] / max(1, c['active']):.0f}% | {c['body']} | {c['none']} |")
lines.append(f"| **合計** | {tot['active']} | {tot['garment']} | {100 * tot['garment'] / max(1, tot['active']):.1f}% | {tot['body']} | {tot['none']} |")
md = '\n'.join(lines); print(md)
# 有尺碼卻沒對上任何尺寸表的商品（改進 body_chart 用）
miss = {}
for p in products:
  if not result.get(p['id']) and p.get('sizes') and p['type'] in ('top', 'bottom', 'dress', 'shoes'):
    m = miss.setdefault(p.get('brand') or '?', [])
    if len(m) < 3: m.append(p['type'] + ':' + '|'.join(p['sizes'][:8]))
for b, m in miss.items(): print('unmapped sizes', b, m)
os.makedirs('out', exist_ok=True)
json.dump({'storage': store.ensure(), 'total': tot, 'brands': cov, 'at': SC.now()}, open('out/coverage.json', 'w'), ensure_ascii=False, indent=1)
open('out/coverage.md', 'w').write(md + '\n')
if os.environ.get('GITHUB_STEP_SUMMARY'): open(os.environ['GITHUB_STEP_SUMMARY'], 'a').write(md + '\n')
