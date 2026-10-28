# 首頁真人範例圖

首頁的「試穿前／試穿後」示範，只要 `demo/manifest.json` 存在就會自動改用真人照片，沒有時顯示插畫。

## 免費做法（約 10 分鐘）

### 1. 拿一把免費的 Google AI Studio 金鑰
https://aistudio.google.com → 登入 Google → **Get API key** → Create。免費額度足夠做範例，不需要信用卡。
GitHub 專案 → Settings → Secrets and variables → Actions → New repository secret：名稱 `GEMINI_KEY`。

### 2. 挑免費授權的照片（Pexels，可商用、免署名）
- 全身照：到 https://www.pexels.com 搜「full body standing」或「woman standing white background」，挑一張**正面站立、素色貼身衣服、背景乾淨、直式**的，複製瀏覽器網址列（像 `https://www.pexels.com/photo/woman-in-white-shirt-1234567/`）
- 衣服照：搜「dress flat lay」「t-shirt product」「blouse on hanger」之類，挑一張只有一件衣服的，複製網址
- 男生版同樣再挑一組（可省略）

### 3. 執行
GitHub → Actions → **產生首頁真人範例圖** → Run workflow：
- engine 選 `gemini`
- 把四個網址貼上（男生版可留空）→ Run

約 2 分鐘後會自動推上 main，網站 1 分鐘後首頁就是真人範例，拖曳中線比較前後。

## 其他引擎
- `fal`：正式上線用的 FASHN 模型（需 `FAL_KEY`，每張約 NT$2.4），衣服版型最準
- `hf`：Hugging Face 免費 Space（IDM-VTON），不用金鑰但可能排隊或暫停，失敗就換 gemini

## 照片建議
- 人：正面、手臂微張不遮身體、乾淨背景、不要太寬鬆的外套
- 衣服：平拍或正面、只有一件、背景乾淨
- 不要用網拍模特兒照（肖像權）；Pexels / Unsplash / 自己拍的都可以
