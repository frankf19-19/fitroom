# 試穿吧 TryOn

上傳全身照，AI 把上衣、褲裙、洋裝、鞋子、帽子、飾品、髮型真實合成到妳身上。

- `index.html` — 前端 App（GitHub Pages）
- `worker/worker.js` — Cloudflare Worker 後端：登入驗證、試穿管線（fal.ai FASHN ＋ Google Gemini 影像）、每日免費額度與點數、綠界金流
- `supabase/schema.sql` — 資料庫與儲存設定
- `設定指南.md` — 上線前要申請與填入的設定

網站：https://frankf19-19.github.io/fitroom/
