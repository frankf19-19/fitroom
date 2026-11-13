"""抽樣比對：商店縮圖的內容 vs 現在的商品圖（同一個網址但品牌換了圖的情況）。不花 AI 費用。"""
import os, io, json, random, urllib.request, collections
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
URL = os.environ['SUPABASE_URL']; KEY = os.environ['SUPABASE_SERVICE_KEY']; H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}
API = 'https://tryon-api.frankccc199.workers.dev'; N = int(os.environ.get('N') or 240)
def raw(u, h=None):
  with urllib.request.urlopen(urllib.request.Request(u, headers=h or {}), timeout=40) as r: return r.read()
idx = json.loads(raw(URL + '/storage/v1/object/public/thumbs/index.json'))
ps, off = [], 0
while True:
  rows = json.loads(raw(URL + f'/rest/v1/products?active=eq.true&select=id,source,name,image_url&order=id&limit=1000&offset={off}', H)); ps += rows
  if len(rows) < 1000: break
  off += 1000
random.seed(7); ps = [p for p in ps if str(p['id']) in idx]; sample = random.sample(ps, min(N, len(ps)))
def sig(b):
  im = Image.open(io.BytesIO(b)).convert('RGB').resize((12, 12), Image.BILINEAR); return list(im.getdata())
def one(p):
  try:
    a = sig(raw(f"{URL}/storage/v1/object/public/thumbs/{p['id']}-{idx[str(p['id'])]}.webp"))
    b = sig(raw(f"{API}/api/img?id={p['id']}", {'User-Agent': 'TryOnThumbBot/1.0', 'Origin': 'https://frankf19-19.github.io'}))
    d = sum(abs(x - y) for pa, pb in zip(a, b) for x, y in zip(pa, pb)) / (144 * 3)
    return p, round(d, 1)
  except Exception as e: return p, None
res = []
with ThreadPoolExecutor(4) as ex:
  for r in ex.map(one, sample): res.append(r)
bad = [(p, d) for p, d in res if d is not None and d > 18]; err = [p for p, d in res if d is None]
print('抽樣', len(res), '內容明顯不同', len(bad), '抓不到', len(err))
print('不同的來源', collections.Counter(p['source'] for p, _ in bad).most_common())
print('抽樣來源', collections.Counter(p['source'] for p, _ in res).most_common(30))
for p, d in sorted(bad, key=lambda x: -x[1])[:25]: print(d, p['id'], p['source'], p['name'][:28], p['image_url'][-70:])
