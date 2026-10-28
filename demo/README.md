# 首頁真人範例圖

首頁的「試穿前／試穿後」示範，有真實照片就會自動改用真人照片，沒有時顯示插畫。

## 怎麼產生（一次約 2 分鐘，費用約 NT$5）
1. GitHub → Settings → Secrets and variables → Actions → New repository secret：`FAL_KEY` = 你的 fal.ai 金鑰
2. 準備照片（二選一）：
   - 把檔案放進這個資料夾：`person-f.jpg`（女生全身照）、`garment-f.jpg`（她要試的衣服照）；男生版 `person-m.jpg`、`garment-m.jpg`
   - 或直接用網址（例如 Pexels 的免費圖片：在 pexels.com 搜「full body」→ 右鍵「複製圖片網址」）
3. GitHub → Actions → **產生首頁真人範例圖** → Run workflow → 填網址或留預設路徑 → Run
4. 跑完會自動把 `demo/f-before.jpg`、`demo/f-after.jpg`（與男生版）推上 main，網站約 1 分鐘後換成真人範例

## 照片建議
- 全身照：正面站立、素色貼身衣服、乾淨背景、直式 3:4
- 衣服照：商品平拍或模特兒正面照，只有這一件
- 肖像權：用自己、朋友（取得同意）或 Pexels / Unsplash 授權照片；不要用網拍模特兒照
