#!/usr/bin/env python3
"""多套試穿進度小條：本機架站，塞假的進行中／完成資料，截圖手機畫面。"""
import os, base64, json
from playwright.sync_api import sync_playwright
SITE = os.environ.get('SITE_URL', 'http://localhost:8765/index.html'); os.makedirs('qa-live', exist_ok=True)
uri = lambda f: 'data:image/jpeg;base64,' + base64.b64encode(open(f, 'rb').read()).decode()
rep = {}
with sync_playwright() as pw:
  b = pw.chromium.launch(channel='chrome')
  pg = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
  errs = []; pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
  pg.add_init_script("try{localStorage.setItem('tryon.debug','1');localStorage.setItem('tryon.onb','1')}catch(e){}")
  pg.goto(SITE + '#shop'); pg.wait_for_timeout(2500)
  pg.evaluate("""([p,r])=>{ const T=window.__tryon; T.runs.set(101,{seq:101,label:'上衣＋褲子',thumb:r,step:'正在換上下身…（第 2/4 步，',done:false}); T.runs.set(102,{seq:102,label:'洋裝',thumb:p,step:'已送出，等待 AI 開始…',done:false}); T.setFg(102); T.renderTray(); }""", [uri('qa/hr_person.jpg'), uri('qa/hr_result.jpg')])
  pg.wait_for_timeout(400); pg.screenshot(path='qa-live/tray_running.png')
  pg.evaluate("""([p,r])=>{ const T=window.__tryon; const R=T.runs.get(101); R.done=true; R.unseen=true; R.runItems=[{type:'top'},{type:'bottom'}]; R.rec={person0:p,img:r,d:{fit:[],quality:{retried:false}}}; T.renderTray(); }""", [uri('qa/hr_person.jpg'), uri('qa/hr_result.jpg')])
  pg.wait_for_timeout(400); pg.screenshot(path='qa-live/tray_done.png')
  pg.click('#runTray'); pg.wait_for_timeout(1500); pg.screenshot(path='qa-live/tray_shown.png', full_page=False)
  rep['view'] = pg.evaluate("location.hash"); rep['errs'] = errs
  b.close()
json.dump(rep, open('qa-live/tray.json', 'w'), ensure_ascii=False); print(rep)
