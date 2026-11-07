"""上線檢查：Worker /api/health 版本、/api/sizechart（有／沒有尺寸表）。輸出 out.json。"""
import json, urllib.request
API = 'https://tryon-api.frankccc199.workers.dev'
def get(u):
  try:
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'probe', 'Origin': 'https://frankf19-19.github.io'}), timeout=30) as r:
      return r.status, dict(r.headers), r.read().decode()[:3000]
  except urllib.error.HTTPError as e: return e.code, dict(e.headers), e.read().decode()[:500]
out = {'health': get(API + '/api/health')}
ps = json.loads(get(API + '/api/products?brand=UNIQLO&type=bottom&size=6')[2])['products'] + json.loads(get(API + '/api/products?brand=VANS&type=shoes&size=6')[2])['products'] + json.loads(get(API + '/api/products?brand=GOOPi&type=top&size=6')[2])['products']
for p in ps[:1] + ps[6:7] + ps[12:14]: out[f"{p['brand']} {p['id']} {p['name']} {p.get('sizes')}"] = get(f"{API}/api/sizechart?id={p['id']}")
out['missing'] = get(API + '/api/sizechart?id=999999999')
out['bad'] = get(API + '/api/sizechart?id=abc')
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
print('done')
