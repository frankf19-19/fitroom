#!/usr/bin/env python3
"""把量身除錯資料（window.__tryon.lastPose / lastMeasure）畫成檢查用圖：遮罩、關節點、量測列與區段端點、頭頂與腳底線。
用法：python3 qa/measure_overlay.py <照片> <pose.json> <dbg.json> <輸出.png>"""
import sys, json, base64
from PIL import Image, ImageDraw

def render(img_path, pose, dbg, out):
    mw, mh = pose['mw'], pose['mh']
    im = Image.open(img_path).convert('RGB').resize((mw, mh))
    if pose.get('mask'):
        m = Image.frombytes('L', (mw, mh), base64.b64decode(pose['mask']))
        tint = Image.new('RGB', (mw, mh), (0, 160, 255))
        im = Image.composite(Image.blend(im, tint, 0.35), im, m.point(lambda v: 255 if v > 127 else 0))
    S = 2; im = im.resize((mw * S, mh * S)); d = ImageDraw.Draw(im)
    P = lambda x, y: (x * S, y * S)
    lm = pose['lm']
    for a, b in [(11,12),(11,13),(13,15),(12,14),(14,16),(11,23),(12,24),(23,24),(23,25),(25,27),(24,26),(26,28),(27,29),(29,31),(27,31),(28,30),(30,32),(28,32),(15,17),(15,19),(16,18),(16,20)]:
        d.line([P(lm[a]['x']*mw, lm[a]['y']*mh), P(lm[b]['x']*mw, lm[b]['y']*mh)], fill=(255,255,0), width=2)
    for i, q in enumerate(lm):
        x, y = P(q['x']*mw, q['y']*mh); c = (0,220,0) if q.get('visibility',1) >= 0.5 else (255,0,0)
        d.ellipse([x-4, y-4, x+4, y+4], fill=c); d.text((x+5, y-5), str(i), fill=c)
    if dbg:
        for k, col in (('top',(255,0,255)),('foot',(255,0,255))):
            if dbg.get(k) is not None: d.line([P(0, dbg[k]), P(mw, dbg[k])], fill=col, width=2)
        colors = {'shoulder':(255,80,80),'chest':(255,140,0),'waist':(0,200,120),'hip':(160,60,255)}
        for k, r in (dbg.get('rows') or {}).items():
            if not r: continue
            col = colors.get(k, (255,255,255)); y = r['y']
            for sg in r.get('segs', []): d.line([P(sg[0], y), P(sg[1], y)], fill=(120,120,120), width=3)
            d.line([P(r['l'], y), P(r['r'], y)], fill=col, width=5)
            for x in (r['l'], r['r']): d.ellipse([x*S-6, y*S-6, x*S+6, y*S+6], outline=col, width=3)
            d.text((r['r']*S+8, y*S-6), k, fill=col)
        txt = ' '.join(f"{k}={v}" for k, v in (dbg.get('values') or {}).items()) or str(dbg.get('err', ''))
        d.rectangle([0, 0, mw*S, 22], fill=(0,0,0)); d.text((4, 5), txt[:200], fill=(255,255,255))
    im.save(out)

if __name__ == '__main__':
    a = sys.argv
    render(a[1], json.load(open(a[2])), json.load(open(a[3])) if a[3] != '-' else None, a[4])
