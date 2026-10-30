from playwright.sync_api import sync_playwright
import os
os.makedirs('qa-live', exist_ok=True)
with sync_playwright() as pw:
  b = pw.chromium.launch(channel='chrome')
  for name, vp in [('phone', (390, 844)), ('desktop', (1280, 900))]:
    pg = b.new_page(viewport={'width': vp[0], 'height': vp[1]}, device_scale_factor=2 if name == 'phone' else 1)
    pg.add_init_script("try{localStorage.setItem('tryon.onb','1')}catch(e){}")
    pg.goto('https://frankf19-19.github.io/fitroom/?v=' + os.environ.get('GITHUB_RUN_ID', '1') + '#shop'); pg.wait_for_timeout(5000)
    for brand in ['Fashion Nova', 'Allbirds', 'MVMT', 'UNIQLO']:
      try:
        pg.click(f'#shopBrand .chip[data-b="{brand}"]'); pg.wait_for_timeout(3500)
        pg.screenshot(path=f'qa-live/shop_{name}_{brand.replace(" ","_")}.png')
      except Exception as e: print(brand, e)
  b.close()
