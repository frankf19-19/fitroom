import json, urllib.request, urllib.parse
tests = {
 'uniqlo': 'https://www.uniqlo.com/tw/hmall/test/u0000000055224/main/first/561/1.jpg',
 'gu': 'https://www.gu-global.com/tw/hmall/test/u0000000053244/main/first/561/1.jpg',
 'pazzo': None,
}
API='https://tryon-api.frankccc199.workers.dev'
UA={'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1','Accept':'image/*,*/*'}
d=json.loads(urllib.request.urlopen(urllib.request.Request(API+'/api/products?brand=PAZZO&page=0',headers=UA),timeout=30).read().decode())
tests['pazzo']=d['products'][0]['image_url']
out={}
for k,u in tests.items():
  for name,url in [('wsrv','https://wsrv.nl/?url='+urllib.parse.quote(u,safe='')+'&w=420&output=webp&q=78'),('wsrv_proxy','https://wsrv.nl/?url='+urllib.parse.quote(API+'/api/img?u='+urllib.parse.quote(u,safe=''),safe='')+'&w=420&output=webp'),('direct',u)]:
    try:
      r=urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=30); b=r.read(); out[f'{k}/{name}']=[r.status,r.headers.get('content-type'),len(b)]
    except urllib.error.HTTPError as e: out[f'{k}/{name}']=[e.code,e.read()[:200].decode('utf-8','replace')]
    except Exception as e: out[f'{k}/{name}']=[-1,str(e)[:100]]
json.dump(out,open('wsrv.json','w'),indent=1); print(json.dumps(out,indent=1))
