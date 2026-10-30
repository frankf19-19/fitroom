import json, urllib.request, urllib.robotparser
UA = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://frankf19-19.github.io/fitroom/)'
out = {}
for host, sample in [('www.vans.com.tw', '/SalePage/Index/12254168'), ('www.adidas.com.tw', '/SalePage/Index/12250309'), ('www.roots.com.tw', '/SalePage/Index/12265563'), ('www.edwin.com.tw', '/SalePage/Index/12263474'), ('www.timberland.com.tw', '/SalePage/Index/12255714'), ('www.levis.com.tw', '/SalePage/Index/12262561'), ('www.giordano.com.tw', '/SalePage/Index/12271231'), ('www.vacanza.com.tw', '/products/316l-stainless-steel-ring-60730')]:
  try:
    t = urllib.request.urlopen(urllib.request.Request(f'https://{host}/robots.txt', headers={'User-Agent': UA}), timeout=20).read().decode('utf-8', 'replace')
  except Exception as e: t = 'ERR ' + str(e)
  rp = urllib.robotparser.RobotFileParser(); rp.parse(t.splitlines())
  out[host] = {'can': rp.can_fetch(UA, f'https://{host}{sample}'), 'robots': t[:700]}
json.dump(out, open('out.json', 'w'), ensure_ascii=False, indent=1)
