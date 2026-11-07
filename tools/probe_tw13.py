"""只檢查指定品牌的商品圖（直接／Worker 代理），邏輯同 probe_images.py。輸出 images.json。"""
import os
ONLY = ['plain-me', 'iROO', 'gozo', 'Queen Shop', 'gelato pique', 'LeSportsac']
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probe_images.py')).read()
src = src.replace("brands = gj(API + '/api/brands').get('brands', [])", "brands = [b for b in gj(API + '/api/brands').get('brands', []) if b['name'] in ONLY]")
exec(compile(src, 'probe_images', 'exec'))
