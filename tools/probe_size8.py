"""上線檢查：Worker /api/health 版本、/api/sizechart（有／沒有尺寸表）。輸出 out.json。"""
import json, urllib.request
API = 'https://tryon-api.frankccc199.workers.dev'
def get(u, n=3000):
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'probe', 'Origin': 'https://frankf19-19.github.io'}), timeout=30) as r:
      return r.status, dict(r.headers), r.read().decode()[:n]
  except urllib.error.HTTPError as e: return e.code, dict(e.headers), e.read().decode()[:500]
out = {'health': get(API + '/api/health')}
P = lambda q: json.loads(get(API + '/api/products?' + q, 10**7)[2])['products'][:6]
ps = P('brand=UNIQLO&type=bottom&size=6') + P('brand=VANS&type=shoes&size=6') + P('brand=GOOPi&type=top&size=6')
for p in ps[:1] + ps[6:7] + ps[12:14]: out[f"{p['brand']} {p['id']} {p['name']} {p.get('sizes')}"] = get(f"{API}/api/sizechart?id={p['id']}")
out['missing'] = get(API + '/api/sizechart?id=999999999')
out['bad'] = get(API + '/api/sizechart?id=abc')
# Queen Shop 尺寸表小頁的結構
import re, time
for p in P('brand=Queen%20Shop&type=top&size=6')[:2]:
  time.sleep(0.5); st, h, b = get(p['buy_url'], 10**7)
  m = re.search(r"popSizeChart\('(https://[^']+)'\)", b)
  if m: time.sleep(0.5); out['qs ' + m.group(1)] = get(m.group(1), 8000)
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
print('done')
