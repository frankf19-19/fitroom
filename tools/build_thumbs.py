#!/usr/bin/env python3
"""商品縮圖預先產生：把每件上架商品的圖縮成 480px 寬的 webp，存到 Supabase Storage（公開 bucket `thumbs`）。
商店開啟時圖片直接從我們自己的空間出來，不必每次經過 wsrv → Worker → 品牌官網三段轉送。

- 檔名 {id}-{圖片網址雜湊8碼}.webp：品牌換圖時雜湊會變，自動重做，也不會吃到舊快取。
- thumbs/index.json：{id: 雜湊}，Worker 讀它在商品資料加上 thumb_url。
- 已下架商品的縮圖會從索引移除並刪檔。
- 圖片透過我們自己的 Worker /api/img 取得（與網站平常顯示商品圖的路徑相同）。
"""
import os, io, json, hashlib, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

URL = os.environ['SUPABASE_URL'].rstrip('/'); KEY = os.environ['SUPABASE_SERVICE_KEY']
API = os.environ.get('WORKER_URL', 'https://tryon-api.frankccc199.workers.dev')
BUCKET = 'thumbs'; W = 480; Q = 76
H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}

def req(method, path, data=None, headers=None, timeout=60):
  h = dict(H); h.update(headers or {})
  if isinstance(data, (dict, list)): data = json.dumps(data).encode(); h.setdefault('Content-Type', 'application/json')
  r = urllib.request.Request(URL + path, data=data, headers=h, method=method)
  try:
    with urllib.request.urlopen(r, timeout=timeout) as x: return x.status, x.read()
  except urllib.error.HTTPError as e: return e.code, e.read()

def ensure_bucket():
  s, _ = req('GET', f'/storage/v1/bucket/{BUCKET}')
  if s == 200: return
  s, t = req('POST', '/storage/v1/bucket', {'id': BUCKET, 'name': BUCKET, 'public': True,
             'allowed_mime_types': ['image/webp', 'application/json'], 'file_size_limit': 400000})
  print('create bucket', s, t[:200])

def products():
  out, off = [], 0
  while True:
    s, t = req('GET', f'/rest/v1/products?active=eq.true&select=id,image_url&order=id&limit=1000&offset={off}')
    rows = json.loads(t) if s == 200 else []
    out += rows
    if len(rows) < 1000: return out
    off += 1000

def h8(u): return hashlib.sha1((u or '').encode()).hexdigest()[:8]

def make(p):
  pid, u = p['id'], p['image_url']
  try:
    r = urllib.request.Request(f'{API}/api/img?id={pid}', headers={'User-Agent': 'TryOnThumbBot/1.0', 'Origin': 'https://frankf19-19.github.io'})
    with urllib.request.urlopen(r, timeout=40) as x: raw = x.read()
    im = Image.open(io.BytesIO(raw)); im.load()
    if im.mode not in ('RGB', 'RGBA'): im = im.convert('RGBA' if 'A' in im.getbands() else 'RGB')
    if im.mode == 'RGBA':
      bg = Image.new('RGB', im.size, (255, 255, 255)); bg.paste(im, mask=im.split()[3]); im = bg
    if im.width > W: im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)
    b = io.BytesIO(); im.save(b, 'WEBP', quality=Q, method=5)
    k = h8(u)
    s, t = req('POST', f'/storage/v1/object/{BUCKET}/{pid}-{k}.webp', b.getvalue(),
               {'Content-Type': 'image/webp', 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000'})
    if s not in (200, 201): return pid, None, f'upload {s} {t[:120]}'
    return pid, k, len(b.getvalue())
  except Exception as e:
    return pid, None, str(e)[:120]

def main():
  ensure_bucket()
  s, t = req('GET', f'/storage/v1/object/{BUCKET}/index.json')
  idx = json.loads(t) if s == 200 else {}
  ps = products(); live = {str(p['id']): p for p in ps}
  todo = [p for p in ps if idx.get(str(p['id'])) != h8(p['image_url'])]
  print(f'上架 {len(ps)} 件，已有縮圖 {len(ps) - len(todo)}，要做 {len(todo)}')
  ok = fail = 0; sizes = []; t0 = time.time()
  with ThreadPoolExecutor(6) as ex:
    for pid, k, info in ex.map(make, todo):
      if k: idx[str(pid)] = k; ok += 1; sizes.append(info)
      else: fail += 1; print('  失敗', pid, info)
  # 已下架的移除
  gone = [i for i in list(idx) if i not in live]
  for i in gone:
    req('DELETE', f'/storage/v1/object/{BUCKET}', {'prefixes': [f'{i}-{idx[i]}.webp']})
    idx.pop(i, None)
  s, t = req('POST', f'/storage/v1/object/{BUCKET}/index.json', json.dumps(idx, separators=(',', ':')).encode(),
             {'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'max-age=300'})
  avg = (sum(sizes) // len(sizes)) if sizes else 0
  msg = f'完成 {ok}，失敗 {fail}，移除下架 {len(gone)}，索引共 {len(idx)} 件，平均 {avg // 1024}KB，耗時 {int(time.time() - t0)} 秒；index 上傳 {s}'
  print(msg)
  if os.environ.get('GITHUB_STEP_SUMMARY'): open(os.environ['GITHUB_STEP_SUMMARY'], 'a').write('### 商品縮圖\n' + msg + '\n')

if __name__ == '__main__': main()
