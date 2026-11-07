#!/usr/bin/env python3
"""商品尺寸表：解析商品頁的尺寸表 <table>、品牌／通用亞洲身體尺寸表、寫進 Supabase Storage（sizecharts/<product_id>.json）。
sync_uniqlo.py、sync_tw.py、backfill_sizecharts.py 共用。

格式：{"unit":"cm","kind":"garment"|"body","fit_type":...,"sizes":{"M":{"chest":..}},"source":"...","updated":"ISO"}
garment：chest/waist/hip/thigh 為「整圈」公分（平量寬 ×2）；length＝衣長／褲長／裙長；shoulder、sleeve、inseam 為直線長度；鞋子用 foot（公分）。
body：該尺碼適合的身體尺寸（胸圍、腰圍、臀圍、肩寬；鞋子為腳長）。
"""
import json, os, re, html as html_mod, urllib.request, urllib.error
from datetime import datetime, timezone

SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL']
KEYS = ('chest', 'shoulder', 'length', 'sleeve', 'waist', 'hip', 'inseam', 'thigh', 'foot')

def now(): return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

# ---------- 尺碼名稱 ----------
def norm_size(s):
  s = html_mod.unescape(str(s or '')).replace('\xa0', ' ').strip().upper()
  s = re.sub(r'\s+', '', s).replace('2XL', 'XXL').replace('XXXL', '3XL').replace('號', '').replace('码', '').replace('碼', '')
  if s in ('FREE', 'FREESIZE', 'ONESIZE', 'OS', 'F'): return 'F'
  return s
SIZE_RX = re.compile(r'^(XXS|XS|S|M|L|XL|XXL|[2-4]XL|F|\d{1,2}(\.5)?|\d{2}[A-Z]?)$')
def is_size(s): return bool(SIZE_RX.match(norm_size(s))) and len(norm_size(s)) <= 4

# ---------- 量測名稱 → 欄位（flat=平量寬，需 ×2） ----------
LABELS = [  # (regex, key, flat)
  (r'內(檔|襠)?長|跨下長|股下|內側長|inseam', 'inseam', False),
  (r'大腿寬|腿寬|大腿.*平量', 'thigh', True), (r'大腿圍|腿圍|thigh', 'thigh', None),
  (r'肩寬|肩幅|shoulder', 'shoulder', False),
  (r'胸寬|胸圍寬|身寬|胸.*平量|bust\s*width|chest\s*width|pit to pit', 'chest', True), (r'胸圍|上胸圍|bust|chest', 'chest', None),
  (r'腰寬|腰圍寬|腰頭寬|腰.*平量|waist\s*width', 'waist', True), (r'腰圍|waist', 'waist', None),
  (r'臀寬|臀圍寬|臀.*平量|hip\s*width', 'hip', True), (r'臀圍|hips?', 'hip', None),
  (r'連肩袖長|後中袖長|裄丈', 'sleeve_cb', False), (r'袖長|sleeve', 'sleeve', False),
  (r'對應尺寸|對應腳長|適合腳長|適用腳長|腳長|鞋內長|足長|foot', 'foot', False),
  (r'^(衣長|總長|全長|身長|裙長|褲長|褲\(裙\)長|褲裙長|洋裝長|長度|後衣長|前衣長|衣長\(後\)|length|長)$|衣長|總長|裙長|褲長|全長', 'length', False),
]
SKIP_LABEL = re.compile(r'inch|英吋|下[擺襬]|袖口|褲口|褲管|領|前襠|後襠|褲襠|褲檔|檔長|襠長|股上|袖寬|袖圍|臂|帽|包|深|高|重|身高|體重|彈性|厚', re.I)
def label_key(lbl):
  t = re.sub(r'\s+', '', html_mod.unescape(lbl or '')).strip(':：')
  if not t or re.search(r'裸身|身體尺寸|適穿身形', t): return None, None   # 身體尺寸那一列，不是商品實測
  if re.search(LABELS[0][0], t, re.I): return 'inseam', False
  if SKIP_LABEL.search(t) and not re.search(r'衣長|褲長|裙長', t): return None, None
  for rx, key, flat in LABELS:
    if re.search(rx, t, re.I): return key, flat
  return None, None

def num(s):
  s = html_mod.unescape(str(s or '')).replace('\xa0', ' ').strip()
  m = re.fullmatch(r'(\d{1,3}(?:\.\d+)?)\s*(?:cm|CM|公分)?(?:\s*[-~～]\s*(\d{1,3}(?:\.\d+)?)\s*(?:cm|CM)?)?', s)
  if not m: return None
  a = float(m.group(1)); b = float(m.group(2)) if m.group(2) else None
  return round((a + b) / 2, 1) if b else a

def cells_of(table_html):
  rows = []
  for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', table_html, re.S | re.I):
    cs = re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', tr, re.S | re.I)
    cs = [re.sub(r'\s+', ' ', html_mod.unescape(re.sub(r'<[^>]+>', ' ', c))).replace('\xa0', ' ').strip() for c in cs]
    if any(cs): rows.append(cs)
  return rows

# 整圈的合理下限：低於這個多半是平量寬（例如胸圍 41.5 其實是半圈）
CIRC_MIN = {'chest': 62, 'waist': 50, 'hip': 64, 'thigh': 38}
def _finalize(raw, typ):
  """raw: {size: {key: (value, flat)}} → {size: {key: cm}}，並檢查數值合理（英吋表、怪數字丟掉）。"""
  out = {}
  for size, kv in raw.items():
    d = {}
    for k, (v, flat) in kv.items():
      if v is None: continue
      if k == 'foot' and typ != 'shoes': continue
      if k == 'sleeve_cb':   # 連肩袖長（從後領中心量）→ 扣掉半個肩寬換成一般袖長
        sh = kv.get('shoulder', (None,))[0]
        if not sh or 'sleeve' in kv: continue
        k, v = 'sleeve', v - sh / 2
      if k in CIRC_MIN and (flat is True or (flat is None and v < CIRC_MIN[k])): v = v * 2   # 平量寬 → 整圈
      d[k] = round(v, 1)
    out[size] = d
  # 合理範圍（公分）；英吋表（肩寬 15、衣長 18）會在這裡被排除
  RANGE = {'chest': (60, 200), 'waist': (45, 200), 'hip': (60, 220), 'thigh': (36, 120), 'shoulder': (25, 80), 'sleeve': (8, 95),
           'length': (18 if typ in ('bottom',) else 28, 170), 'inseam': (15, 110), 'foot': (12, 34)}
  bad = 0; tot = 0
  for size, d in out.items():
    for k, v in list(d.items()):
      tot += 1
      lo, hi = RANGE[k]
      if not (lo <= v <= hi): bad += 1; d.pop(k)
  if tot == 0 or bad > tot * 0.25: return None
  out = {s: d for s, d in out.items() if d}
  return out or None

def parse_tables(page_html, typ=None):
  """從商品頁 HTML 找出尺寸表；回傳 sizes dict 或 None。支援「尺碼在第一列」與「尺碼在第一欄」兩種排法。"""
  best = None
  for t in re.findall(r'<table.*?</table>', page_html or '', re.S | re.I):
    if re.search(r'身材測量|國際尺碼|美碼', t): continue   # 品牌身體尺寸對照表，不是商品實測
    rows = cells_of(t)
    if len(rows) < 2: continue
    if re.search(r'\binch\b|英吋|\(in\)|單位\s*[:：]?\s*(in|吋)', ' '.join(' '.join(r) for r in rows[:2]), re.I) and not re.search(r'cm|公分', ' '.join(' '.join(r) for r in rows[:2]), re.I): continue
    raw = None
    head = rows[0]
    # A) 尺碼在第一列（橫向）：[尺碼, S, M, L] + [胸寬, 50, 52, 54]
    hs = [norm_size(c) for c in head[1:]]
    if len(hs) >= 1 and sum(is_size(c) for c in head[1:]) >= max(1, len(hs) - 1):
      raw = {}; group = ''
      for r in rows[1:]:
        if len(r) == len(hs) + 2 and not num(r[1]):   # [腰圍, B：商品測量, 64, 70…]：第一格是群組名稱
          group, r = r[0], r[1:]
        lbl = r[0]
        if re.match(r'^[A-DＡ-Ｄ]\s*[：:]', lbl) and group: lbl = group + lbl   # 「B：商品測量」承接上一列的「腰圍」
        key, flat = label_key(lbl)
        if not key: continue
        vals = r[1:]
        if len(vals) != len(hs): vals = vals[-len(hs):] if len(vals) > len(hs) else vals
        for s, v in zip(hs, vals):
          if is_size(s): raw.setdefault(s, {}).setdefault(key, (num(v), flat))
    else:
      # B) 尺碼在第一欄（直向）：[尺寸, 衣長, 胸寬] + [S, 62, 61.5]
      keys = [label_key(c) for c in head[1:]]
      if any(k for k, _ in keys) and sum(is_size(r[0]) for r in rows[1:] if r) >= max(1, (len(rows) - 1) // 2):
        raw = {}
        for r in rows[1:]:
          if not r or not is_size(r[0]): continue
          s = norm_size(r[0])
          vals = r[1:]
          for (key, flat), v in zip(keys, vals):
            if key: raw.setdefault(s, {}).setdefault(key, (num(v), flat))
    if not raw: continue
    sizes = _finalize(raw, typ)
    if not sizes: continue
    score = sum(len(d) for d in sizes.values())
    if not best or score > best[0]: best = (score, sizes)
  if not best: return None
  sizes = best[1]
  if all(s in SIZE_ORDER for s in sizes): sizes = {s: sizes[s] for s in SIZE_ORDER if s in sizes}
  return sizes

def garment_chart(sizes, source, fit_type=None):
  return {'unit': 'cm', 'kind': 'garment', 'fit_type': fit_type, 'sizes': sizes, 'source': source, 'updated': now()}

FIT_WORDS = [('oversized', r'oversize|落肩|超寬鬆|寬版|大廓形|特大'), ('relaxed', r'寬鬆|寬褲|寬管|relaxed|loose|直筒寬|abt|闊腿'), ('slim', r'修身|窄管|貼身|合身|緊身|slim|skinny|super skinny'), ('regular', r'標準|regular|直筒')]
def fit_type_of(name):
  for f, rx in FIT_WORDS:
    if re.search(rx, name or '', re.I): return f
  return None

# ---------- 身體尺寸表（沒有商品尺寸表時用） ----------
# UNIQLO／GU 台灣官網的身體尺寸對照（取各尺碼區間中間值，公分）
BODY_UQ = {
  'f': {'XS': dict(chest=75, waist=57, hip=84, shoulder=36), 'S': dict(chest=79, waist=61, hip=87, shoulder=37), 'M': dict(chest=85, waist=67, hip=90, shoulder=38.5),
        'L': dict(chest=91, waist=73, hip=93, shoulder=40), 'XL': dict(chest=97, waist=79, hip=96, shoulder=41.5), 'XXL': dict(chest=103, waist=86, hip=99, shoulder=43), '3XL': dict(chest=109, waist=93, hip=103, shoulder=44.5)},
  'm': {'XS': dict(chest=84, waist=68, hip=84, shoulder=41), 'S': dict(chest=88, waist=73, hip=88, shoulder=42.5), 'M': dict(chest=92, waist=80, hip=92, shoulder=44),
        'L': dict(chest=100, waist=88, hip=98, shoulder=46), 'XL': dict(chest=108, waist=96, hip=104, shoulder=48), 'XXL': dict(chest=116, waist=104, hip=110, shoulder=50), '3XL': dict(chest=124, waist=112, hip=116, shoulder=52)},
}
# 通用亞洲尺碼（台灣品牌常見對照）
BODY_ASIA = {
  'f': {'XS': dict(chest=76, waist=58, hip=84, shoulder=35.5), 'S': dict(chest=80, waist=62, hip=88, shoulder=36.5), 'M': dict(chest=84, waist=66, hip=92, shoulder=37.5),
        'L': dict(chest=88, waist=70, hip=96, shoulder=38.5), 'XL': dict(chest=92, waist=74, hip=100, shoulder=39.5), 'XXL': dict(chest=96, waist=78, hip=104, shoulder=40.5), '3XL': dict(chest=100, waist=82, hip=108, shoulder=41.5)},
  'm': {'XS': dict(chest=84, waist=68, hip=86, shoulder=41), 'S': dict(chest=88, waist=72, hip=90, shoulder=42.5), 'M': dict(chest=94, waist=78, hip=94, shoulder=44),
        'L': dict(chest=100, waist=84, hip=98, shoulder=45.5), 'XL': dict(chest=106, waist=90, hip=102, shoulder=47), 'XXL': dict(chest=112, waist=96, hip=106, shoulder=48.5), '3XL': dict(chest=118, waist=102, hip=110, shoulder=50)},
}
US_FOOT = {'m': {6: 24, 6.5: 24.5, 7: 25, 7.5: 25.5, 8: 26, 8.5: 26.5, 9: 27, 9.5: 27.5, 10: 28, 10.5: 28.5, 11: 29, 12: 30, 13: 31},
           'f': {4: 21, 4.5: 21.5, 5: 22, 5.5: 22.5, 6: 23, 6.5: 23.5, 7: 24, 7.5: 24.5, 8: 25, 8.5: 25.5, 9: 26, 10: 27, 11: 28}}
def body_chart(sizes, typ, gender, brand=''):
  """依商品的尺碼清單產生身體尺寸表；對不上的尺碼略過，全部對不上回傳 None。"""
  g = 'm' if gender == 'm' else 'f'
  uq = (brand or '').upper() in ('UNIQLO', 'GU')
  base = (BODY_UQ if uq else BODY_ASIA)[g]
  src = ('UNIQLO/GU 台灣官網身體尺寸對照（亞洲尺碼）' if uq else '通用亞洲尺碼身體尺寸對照（非商品實測）')
  out = {}
  for raw in sizes or []:
    s = norm_size(raw)
    if typ == 'shoes':
      try: n = float(s)
      except ValueError: continue
      if 21 <= n <= 31: out[raw] = {'foot': n}                       # 台灣／日本鞋碼＝腳長公分
      elif 34 <= n <= 47: out[raw] = {'foot': round(n * 2 / 3 - 1.5, 1)}   # 歐碼
      elif 4 <= n <= 13: v = US_FOOT[g].get(n); out.update({raw: {'foot': v}} if v else {})
      elif 210 <= n <= 310: out[raw] = {'foot': n / 10}             # 230＝23 公分
      continue
    s = {'LL': 'XL', '2L': 'XL', '3L': 'XXL', '4L': '3XL'}.get(s, s)   # 日系 2L/3L 碼
    if s in base: d = dict(base[s])
    elif s == 'F': d = dict(base['M'])
    elif re.fullmatch(r'\d{2}', s) and typ in ('bottom',) and 22 <= int(s) <= 44: d = {'waist': round(int(s) * 2.54, 1)}   # 褲子腰圍英吋碼
    elif re.fullmatch(r'\d{2}', s) and typ in ('bottom', 'dress') and 56 <= int(s) <= 110: d = {'waist': float(s)}   # 腰圍公分碼
    else: continue
    if typ == 'bottom': d.pop('chest', None); d.pop('shoulder', None)
    out[raw] = d
  if not out: return None
  return {'unit': 'cm', 'kind': 'body', 'fit_type': None, 'sizes': out, 'source': src, 'updated': now()}

def chart_sizes(chart): return list((chart or {}).get('sizes', {}).keys())

# ---------- Supabase Storage ----------
class Store:
  def __init__(self, url=None, key=None):
    self.url = (url or os.environ['SUPABASE_URL']).rstrip('/'); self.key = key or os.environ['SUPABASE_SERVICE_KEY']
    self.bucket = None
  def _req(self, method, path, body=None, ctype='application/json', extra=None):
    h = {'apikey': self.key, 'Authorization': 'Bearer ' + self.key, 'Content-Type': ctype}
    if extra: h.update(extra)
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(self.url + path, data=data, headers=h, method=method)
    try:
      with urllib.request.urlopen(req, timeout=30) as r: return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e: return e.code, e.read().decode('utf-8', 'replace')[:300]
    except Exception as e: return 0, str(e)[:200]
  def ensure(self):
    """優先用公開的 sizecharts 桶（沒有就建立）；建不了就放 results 桶的 sizecharts/ 底下。回傳 (bucket, prefix)。"""
    if self.bucket: return self.bucket
    s, t = self._req('GET', '/storage/v1/bucket/sizecharts')
    if s == 200 and '"public":true' in t.replace(' ', ''): self.bucket = ('sizecharts', ''); return self.bucket
    if s == 200:
      s2, t2 = self._req('PUT', '/storage/v1/bucket/sizecharts', {'id': 'sizecharts', 'name': 'sizecharts', 'public': True})
      if s2 == 200: self.bucket = ('sizecharts', ''); return self.bucket
    else:
      s2, t2 = self._req('POST', '/storage/v1/bucket', {'id': 'sizecharts', 'name': 'sizecharts', 'public': True, 'allowed_mime_types': ['application/json'], 'file_size_limit': 65536})
      if s2 in (200, 201) or 'already exists' in t2.lower(): self.bucket = ('sizecharts', ''); print('sizecharts bucket:', s2, t2[:120]); return self.bucket
      print('cannot create sizecharts bucket:', s, s2, t2[:200])
    self.bucket = ('results', 'sizecharts/'); return self.bucket
  def put(self, product_id, chart):
    b, pre = self.ensure()
    s, t = self._req('POST', f'/storage/v1/object/{b}/{pre}{int(product_id)}.json', json.dumps(chart, ensure_ascii=False, separators=(',', ':')).encode(),
                     'application/json', {'x-upsert': 'true', 'Cache-Control': 'max-age=3600'})
    if s not in (200, 201): print('  chart upload failed', product_id, s, t[:120])
    return s in (200, 201)
  def get(self, product_id):
    b, pre = self.ensure()
    s, t = self._req('GET', f'/storage/v1/object/public/{b}/{pre}{int(product_id)}.json')
    if s != 200: return None
    try: return json.loads(t)
    except Exception: return None
  def list_ids(self):
    """已存在的尺寸表檔案 → {product_id: 檔名}（用來統計覆蓋率、略過已有的商品實測表）。"""
    b, pre = self.ensure(); out = set(); off = 0
    while True:
      s, t = self._req('POST', f'/storage/v1/object/list/{b}', {'prefix': pre.rstrip('/'), 'limit': 1000, 'offset': off, 'sortBy': {'column': 'name', 'order': 'asc'}})
      if s != 200: break
      try: items = json.loads(t)
      except Exception: break
      for it in items:
        m = re.fullmatch(r'(\d+)\.json', it.get('name') or '')
        if m: out.add(int(m.group(1)))
      if len(items) < 1000: break
      off += 1000
    return out

def write_charts(sb_get, source, rows, store=None, log=print):
  """同步完一家商店後呼叫：rows 是剛寫入的商品（可帶 _chart＝商品實測表）。
  有實測表就寫實測表，否則依 sizes 寫身體尺寸表。sb_get(path) 回傳 PostgREST GET 結果。回傳 (garment 數, body 數)。"""
  import urllib.parse
  try:
    store = store or Store()
    ex = sb_get(f'products?source=eq.{urllib.parse.quote(source)}&active=eq.true&select=id,external_id')
  except Exception as e:
    log('size charts skipped:', e); return 0, 0
  ids = {r['external_id']: r['id'] for r in ex}
  g = b = 0
  for r in rows:
    pid = ids.get(r.get('external_id'))
    if not pid: continue
    chart = r.get('_chart') or body_chart(r.get('sizes') or [], r.get('type'), r.get('gender'), r.get('brand'))
    if not chart: continue
    if store.put(pid, chart):
      if chart['kind'] == 'garment': g += 1
      else: b += 1
  log(f'  size charts {source}: garment {g}, body {b}, products {len(rows)}')
  return g, b

# ---------- UNIQLO／GU 台灣官網（同一套 Fast Retailing 平台） ----------
FR_SITE = {'uniqlo': ('https://www.uniqlo.com/tw', 'https://d.uniqlo.com/tw', 'https://www.uniqlo.com'),
           'gu': ('https://www.gu-global.com/tw', 'https://d.gu-global.com/tw', 'https://www.gu-global.com')}
def _fr_req(url, origin, data=None):
  h = {'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-TW', 'Origin': origin, 'Referer': origin + '/tw/'}
  req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=h, method='POST' if data is not None else 'GET')
  if data is not None: req.add_header('Content-Type', 'application/json')
  with urllib.request.urlopen(req, timeout=30) as r: return r.read().decode('utf-8', 'replace')
def fr_size_lists(brand, codes):
  """POST /product/spu/size-list（官網前端用的 API）：{商品代碼: ['XS','S',…]}，一次 40 筆。"""
  web, d, origin = FR_SITE[brand]; out = {}
  for i in range(0, len(codes), 40):
    try:
      j = json.loads(_fr_req(d + '/product/spu/size-list', origin, list(codes[i:i + 40])))
      for r in j.get('resp') or []:
        if r.get('productCode') and r.get('sizeList'): out[r['productCode']] = [str(x) for x in r['sizeList']]
    except Exception as e: print('  size-list fail', e)
  return out
def fr_garment_chart(brand, code, typ, name):
  """官方商品尺寸表（商品頁「尺寸表」分頁的 HTML：/hmall/test/<代碼>/zh_TW/sizeAndTryOn.html）。"""
  web, d, origin = FR_SITE[brand]
  url = f'{web}/hmall/test/{code}/zh_TW/sizeAndTryOn.html'
  try: h = _fr_req(url, origin)
  except urllib.error.HTTPError as e:
    if e.code != 404: raise
    j = json.loads(_fr_req(f'{d}/product/detail?productCode={code}', origin))   # 路徑不同時從商品詳細資料取
    path = (((j.get('resp') or [{}])[0].get('spuInfo') or {}).get('desc') or {}).get('sizeChart')
    if not path: return None
    url = web + path; h = _fr_req(url, origin)
  return pick_chart(h, typ, name, f'{brand.upper()} 官網尺寸表 {web}/zh_TW/product-detail.html?productCode={code}')

def pick_chart(page_html, typ, name, brand_source):
  """商品頁 HTML → 商品實測尺寸表（沒有就 None）。"""
  if typ not in ('top', 'bottom', 'dress', 'shoes'): return None
  sizes = parse_tables(page_html, typ)
  if not sizes: return None
  if typ == 'shoes' and not any('foot' in d for d in sizes.values()): return None
  if typ in ('top', 'dress') and not any(('chest' in d or 'length' in d or 'shoulder' in d) for d in sizes.values()): return None
  if typ == 'bottom' and not any(('waist' in d or 'length' in d or 'hip' in d or 'inseam' in d) for d in sizes.values()): return None
  return garment_chart(sizes, brand_source, fit_type_of(name))

if __name__ == '__main__':
  # 自我測試（離線）
  goopi = '<table><tr><td>尺寸</td><td>衣長</td><td>胸寬</td><td>肩寬</td><td>袖長</td></tr><tr><td>S</td><td>62</td><td>61.5</td><td>53</td><td>62</td></tr><tr><td>M</td><td>65</td><td>64</td><td>55</td><td>63.5</td></tr></table>'
  s = parse_tables(goopi, 'top'); assert s == {'S': {'length': 62, 'chest': 123, 'shoulder': 53, 'sleeve': 62}, 'M': {'length': 65, 'chest': 128, 'shoulder': 55, 'sleeve': 63.5}}, s
  iroo = ('<table><tr><td>尺碼</td><td>36</td><td>38</td></tr><tr><td>肩寬</td><td>15.4</td><td>15.8</td></tr><tr><td>胸圍</td><td>41.5</td><td>43</td></tr><tr><td>衣長</td><td>17.8</td><td>18</td></tr></table>'
          '<table><tr><td>尺碼</td><td>36</td><td>38</td></tr><tr><td>肩寬</td><td>39.1</td><td>40</td></tr><tr><td>胸圍</td><td>105.4</td><td>109.2</td></tr><tr><td>衣長</td><td>45.1</td><td>45.7</td></tr><tr><td>袖長</td><td>60.3</td><td>61</td></tr></table>')
  s = parse_tables(iroo, 'top'); assert s == {'36': {'shoulder': 39.1, 'chest': 105.4, 'length': 45.1, 'sleeve': 60.3}, '38': {'shoulder': 40, 'chest': 109.2, 'length': 45.7, 'sleeve': 61}}, s
  plain = ('<table><tr><td>單位：cm</td><td>S</td><td>M</td><td>L</td></tr><tr><td>褲長</td><td>100</td><td>103</td><td>105</td></tr><tr><td>腰寬</td><td>38</td><td>41</td><td>43</td></tr>'
           '<tr><td>腰寬(inch)</td><td>30</td><td>32</td><td>34</td></tr><tr><td>臀寬</td><td>53</td><td>56</td><td>58</td></tr><tr><td>褲口寬</td><td>24</td><td>24</td><td>25</td></tr><tr><td>身高－體重－腰圍(cm)－腰圍(inch)</td><td>S</td><td>M</td><td>L</td></tr></table>')
  s = parse_tables(plain, 'bottom'); assert s == {'S': {'length': 100, 'waist': 76, 'hip': 106}, 'M': {'length': 103, 'waist': 82, 'hip': 112}, 'L': {'length': 105, 'waist': 86, 'hip': 116}}, s
  air = '<table><tr><td>Size</td><td>S</td><td>M</td></tr><tr><td>衣長</td><td>81.3</td><td>83.8</td></tr><tr><td>肩寬</td><td>34.3</td><td>35.6</td></tr><tr><td>胸寬</td><td>40.6</td><td>43.2</td></tr><tr><td>腰寬</td><td>34.3</td><td>36.8</td></tr><tr><td>下襬寬</td><td>92.7</td><td>95.3</td></tr></table>'
  s = parse_tables(air, 'dress'); assert s['S'] == {'length': 81.3, 'shoulder': 34.3, 'chest': 81.2, 'waist': 68.6}, s
  bag = '<table><tr><td>尺寸</td><td>F</td></tr><tr><td>包長</td><td>13</td></tr><tr><td>包寬</td><td>5.5</td></tr></table>'
  assert parse_tables(bag, 'accessory') is None
  b = body_chart(['S', 'M', 'L'], 'top', 'f', 'UNIQLO'); assert b['kind'] == 'body' and b['sizes']['M']['chest'] == 85
  assert body_chart(['26', '28'], 'bottom', 'm')['sizes']['28'] == {'waist': 71.1}
  assert body_chart(['24', '25.5'], 'shoes', 'f')['sizes']['25.5'] == {'foot': 25.5}
  assert body_chart(['F'], 'accessory', 'f')['sizes']['F']['chest'] == 84
  assert fit_type_of('寬鬆落肩大學T') == 'oversized' and fit_type_of('修身牛仔褲') == 'slim'
  uqb = ('<table><tr><th></th><th>XS</th><th>S</th></tr><tr><th rowspan=2>腰圍</th><th>A：裸身測量</th><td>66～72</td><td>68～76</td></tr><tr><th>B：商品測量</th><td>64</td><td>70</td></tr>'
         '<tr><th>臀圍</th><td>98.5</td><td>104.5</td></tr><tr><th>大腿寬</th><td>32</td><td>34</td></tr><tr><th>褲檔</th><td>27.5</td><td>28</td></tr><tr><th>褲內襠長</th><td>64</td><td>66</td></tr></table>')
  s = parse_tables(uqb, 'bottom'); assert s == {'XS': {'waist': 64, 'hip': 98.5, 'thigh': 64, 'inseam': 64}, 'S': {'waist': 70, 'hip': 104.5, 'thigh': 68, 'inseam': 66}}, s
  gut = '<table><tr><th>&nbsp;</th><th>S</th><th>M</th></tr><tr><th>衣長</th><td>61.5</td><td>62.5</td></tr><tr><th>連肩袖長</th><td>79</td><td>80.5</td></tr><tr><th>肩寬</th><td>49</td><td>50</td></tr><tr><th>胸寬</th><td>48</td><td>51</td></tr></table>'
  s = parse_tables(gut, 'top'); assert s['S'] == {'length': 61.5, 'sleeve': 54.5, 'shoulder': 49, 'chest': 96}, s
  gus = '<table><tr><th>&nbsp;</th><th>S</th><th>M</th></tr><tr><th>對應尺寸</th><td>22.5</td><td>23.5</td></tr><tr><th>鞋長</th><td>23.7</td><td>24.7</td></tr><tr><th>鞋跟高度</th><td>5.6</td><td>5.7</td></tr></table>'
  assert parse_tables(gus, 'shoes') == {'S': {'foot': 22.5}, 'M': {'foot': 23.5}}
  print('sizecharts self-test ok')
