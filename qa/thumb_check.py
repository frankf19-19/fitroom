"""檢查商店縮圖是否和目前的商品圖一致（縮圖索引的雜湊 vs 目前 image_url 的雜湊）。不花 AI 費用。"""
import os, json, hashlib, urllib.request, collections
URL = os.environ['SUPABASE_URL']; KEY = os.environ['SUPABASE_SERVICE_KEY']; H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}
def get(p, h=H):
  with urllib.request.urlopen(urllib.request.Request(URL + p, headers=h), timeout=60) as r: return json.loads(r.read())
idx = get('/storage/v1/object/public/thumbs/index.json', {})
ps, off = [], 0
while True:
  rows = get(f'/rest/v1/products?active=eq.true&select=id,source,name,image_url,updated_at&order=id&limit=1000&offset={off}'.replace(',updated_at', '')); ps += rows
  if len(rows) < 1000: break
  off += 1000
h8 = lambda u: hashlib.sha1((u or '').encode()).hexdigest()[:8]
bad = [p for p in ps if str(p['id']) in idx and idx[str(p['id'])] != h8(p['image_url'])]
miss = [p for p in ps if str(p['id']) not in idx]
print('上架', len(ps), '索引', len(idx), '縮圖與現在商品圖不同', len(bad), '沒有縮圖', len(miss))
print(collections.Counter(p['source'] for p in bad).most_common(12))
for p in bad[:8]: print(p['id'], p['source'], p['name'][:30], p['image_url'][-60:])
