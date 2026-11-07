"""第七輪探測：Tommy／CK 台灣商品圖從哪來、AIR SPACE 台灣網站地圖、TEVA／Lovfee／mouggan／GOZO 商品頁、Cyberbiz 三家（Merrell/JanSport/Saucony）。輸出 out.json。"""
import json, re, time, concurrent.futures as cf, importlib.util, os, sys
spec = importlib.util.spec_from_file_location('p10', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probe_tw10.py'))
src = open(spec.origin).read().split('\nJOBS = {')[0]   # 只借用 probe_tw10 的工具函式
ns = {}; exec(compile(src, 'p10', 'exec'), ns)
get, deep, title, ld, meta, imgtest, links = ns['get'], ns['deep'], ns['title'], ns['ld'], ns['meta'], ns['imgtest'], ns['links']
def imgs_in(h): return {'itemprop_image': re.findall(r'itemprop=["\']image["\'][^>]*(?:content|src)=["\']([^"\']+)', h)[:3],
                        'image_src': re.findall(r'rel=["\']image_src["\'][^>]*href=["\']([^"\']+)', h)[:2],
                        'scene7_or_cdn': list(dict.fromkeys(re.findall(r'(https?://[^"\'\s]+?(?:/is/image/|/dw/image/|demandware\.static)[^"\'\s]+)', h)))[:4],
                        'data_src': list(dict.fromkeys(re.findall(r'data-(?:src|srcset|zoom-image|image)=["\']([^"\'\s]+)', h)))[:5],
                        'ga_item': re.findall(r'"item_name":"[^"]+"[^}]{0,300}', h)[:1]}
JOBS = {
  'tommy': lambda: deep('tw.tommy.com', ['https://tw.tommy.com/sitemap_0-product.xml'], r'tw\.tommy\.com/zh/', want=1, extra=imgs_in),
  'ck': lambda: deep('www.calvinklein.com.tw', ['https://www.calvinklein.com.tw/sitemap_0-product.xml'], r'calvinklein\.com\.tw/zh/', want=1, extra=imgs_in),
  'airspace': lambda: deep('www.airspaceonline.com', ['https://www.airspaceonline.com/sitemap_TW.xml'], r'airspaceonline\.com/.*product/'),
  'teva': lambda: deep('teva.com.tw', ['https://teva.com.tw/women.html', 'https://teva.com.tw/'], r'teva\.com\.tw/[\w\-]+\.html$'),
  'lovfee': lambda: deep('www.lovfee.com', ['https://www.lovfee.com/zh-TW/lovfee/productlist?other=NewArrival', 'https://www.lovfee.com/zh-TW/lovfee/ProductList?item1=01'], r'(?i)lovfee\.com/.*product\?saleid='),
  'mouggan': lambda: deep('www.mouggan.com', ['https://www.mouggan.com/', 'https://www.mouggan.com/sitemap.xml'], r'mouggan\.com/.*(?:product|products|goods)/'),
  'gozo': lambda: deep('www.gozo.com.tw', ['https://www.gozo.com.tw/'], r'gozo\.com\.tw/.*product-detail/'),
  'merrell': lambda: deep('www.merrell.com.tw', ['https://www.merrell.com.tw/sitemap.xml'], r'merrell\.com\.tw/products/'),
  'jansport': lambda: deep('www.jansport.com.tw', ['https://www.jansport.com.tw/sitemap.xml'], r'jansport\.com\.tw/products/'),
  'saucony': lambda: deep('www.saucony.com.tw', ['https://www.saucony.com.tw/sitemap.xml'], r'saucony\.com\.tw/products/'),
  'goopi': lambda: ns['shopify']('www.goopi.co'),
  'salomon': lambda: ns['shopify']('salomon.com.tw'),
  'usagi_list': lambda: deep('www.usagi-online.com.tw', ['https://www.usagi-online.com.tw/productlist?item1=01&item2=W01'], r'product\?saleid=', want=1),
}
res = {}
def go(k):
  try: return k, JOBS[k]()
  except Exception as e: return k, {'exc': repr(e)[:200]}
with cf.ThreadPoolExecutor(10) as ex:
  for k, o in ex.map(go, list(JOBS)): res[k] = o
json.dump(res, open('out.json', 'w'), ensure_ascii=False, indent=1)
