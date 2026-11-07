"""驗證：91APP 改走商品頁（只用 robots 允許的網址）後的解析結果；UNIQLO／GU robots.txt；91APP GetSalePageAdditionalInfo（robots 明確 Allow）網址格式。
輸出 verify91.json。"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('MAXIDS', '30')
import sizecharts as SC, sync_tw as T

out = {'fr': {}, 'shops': {}, 'addl': {}}
for h in ['d.uniqlo.com', 'www.uniqlo.com', 'd.gu-global.com', 'www.gu-global.com']:
  k, p = SC.ROBOTS.get(f'https://{h}/')
  out['fr'][h] = {'status': p['status'], 'text': p['text'][:6000], 'delay': p['delay']}
for u in ['https://d.uniqlo.com/tw/p/search/products/by-category', 'https://d.uniqlo.com/tw/product/spu/size-list', 'https://d.uniqlo.com/tw/product/detail?productCode=u0000000000000',
          'https://www.uniqlo.com/tw/hmall/test/u0000000000000/zh_TW/sizeAndTryOn.html', 'https://www.uniqlo.com/tw/zh_TW/product-detail.html?productCode=u0000000000000',
          'https://www.uniqlo.com/tw/zh_TW/c/all_women-tops-t-shirts.html', 'https://d.gu-global.com/tw/p/search/products/by-category', 'https://www.gu-global.com/tw/hmall/test/g0/zh_TW/sizeAndTryOn.html']:
  out['fr'][u] = SC.ROBOTS.allowed(u)

for host, brand, g in T.SHOPS91:
  if host not in ('www.obdesign.com.tw', 'www.levis.com.tw', 'www.dot-st.tw', 'tw.puma.com', 'www.giordano.com.tw'): continue
  ids = T.ids91(host, brand)
  rows, n = T.rows91(host, brand, g, ids[:30])
  out['shops'][host] = {'ids_total': len(ids), 'tried': n, 'rows': len(rows), 'with_sizes': sum(1 for r in rows if r['sizes']), 'with_chart': sum(1 for r in rows if r['_chart']),
                        'types': {t: sum(1 for r in rows if r['type'] == t) for t in {r['type'] for r in rows}}, 'sample': [{k: v for k, v in r.items() if k != '_chart'} for r in rows[:4]]}
  if host == 'www.obdesign.com.tw' and ids:
    shop = re.search(r'Sitemap/(\d+)/', SC.ROBOTS.text(f'https://{host}/')); shop = shop and shop.group(1)
    for u in [f'https://{host}/webapi/SalePageV2/GetSalePageAdditionalInfo/{shop}/{ids[0]}', f'https://{host}/webapi/SalePageV2/GetSalePageAdditionalInfo?shopId={shop}&salePageId={ids[0]}',
              f'https://{host}/webapi/SalePageV2/GetSalePageAdditionalInfo/{ids[0]}', f'https://{host}/webapi/SalePageV2/GetSalePageAdditionalInfo/{shop}/{ids[0]}?lang=zh-TW']:
      s, t = T.get(u, 800000)
      out['addl'][u] = {'allowed': SC.ROBOTS.allowed(u), 'status': s, 'body': t[:1500], 'tables': t.count('<table') + t.count('\\u003ctable'), 'has_size': bool(re.search('尺寸|胸寬|衣長', t))}
out['skipped'] = SC.ROBOTS.skipped
json.dump(out, open('verify91.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(out['shops'], ensure_ascii=False)[:2000])
