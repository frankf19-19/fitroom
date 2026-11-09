import json, os
from PIL import Image, ImageDraw, ImageFont
r = json.load(open('out/report.json')); E = r['engines']; H = 520
font = ImageFont.load_default(size=28) if hasattr(ImageFont, 'load_default') else None
rows = []
for ci in range(len(r['cases'])):
  cols = ['person', 'garment'] + E; ims = []
  for c in cols:
    p = f'out/c{ci}_{c}.jpg'
    im = Image.open(p).convert('RGB') if os.path.exists(p) else Image.new('RGB', (350, H), (240, 220, 220))
    im = im.resize((int(im.width * H / im.height), H)); cv = Image.new('RGB', (im.width, H + 40), 'white'); cv.paste(im, (0, 40))
    ImageDraw.Draw(cv).text((6, 4), c, fill='black', font=font); ims.append(cv)
  W = sum(i.width for i in ims) + 10 * len(ims); row = Image.new('RGB', (W, H + 40), 'white'); x = 0
  for i in ims: row.paste(i, (x, 0)); x += i.width + 10
  rows.append(row)
W = max(r_.width for r_ in rows); sheet = Image.new('RGB', (W, sum(r_.height + 16 for r_ in rows)), 'white'); y = 0
for r_ in rows: sheet.paste(r_, (0, y)); y += r_.height + 16
sheet.save('out/sheet.jpg', quality=85)
