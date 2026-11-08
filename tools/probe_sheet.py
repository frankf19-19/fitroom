#!/usr/bin/env python3
"""把女生下身商品縮圖拼成一張總覽圖（找特定商品用），輸出 sheet.jpg + sheet.json。"""
import os, io, json, urllib.request
from PIL import Image, ImageDraw
URL = os.environ['SUPABASE_URL']; KEY = os.environ['SUPABASE_SERVICE_KEY']; H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}
Q = os.environ.get('Q', 'type=eq.bottom&gender=in.(f,u)&brand=in.(GU,UNIQLO)')
rows = json.load(urllib.request.urlopen(urllib.request.Request(f"{URL}/rest/v1/products?active=eq.true&{Q}&select=id,brand,name&order=id&limit=120", headers=H)))
idx = json.load(urllib.request.urlopen(f"{URL}/storage/v1/object/public/thumbs/index.json"))
cells = []
for r in rows:
  k = idx.get(str(r['id']))
  if not k: continue
  try: im = Image.open(io.BytesIO(urllib.request.urlopen(f"{URL}/storage/v1/object/public/thumbs/{r['id']}-{k}.webp", timeout=20).read())).convert('RGB')
  except Exception: continue
  im.thumbnail((150, 200)); c = Image.new('RGB', (150, 220), 'white'); c.paste(im, ((150 - im.width) // 2, 0)); ImageDraw.Draw(c).text((4, 204), str(r['id']), fill='red'); cells.append(c)
cols = 12; rws = (len(cells) + cols - 1) // cols
sheet = Image.new('RGB', (cols * 150, max(1, rws) * 220), 'white')
for i, c in enumerate(cells): sheet.paste(c, ((i % cols) * 150, (i // cols) * 220))
sheet.save('sheet.jpg', quality=80); json.dump(rows, open('sheet.json', 'w'), ensure_ascii=False)
print(len(cells))
