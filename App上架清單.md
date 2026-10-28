# 試穿吧 TryOn — App 上架清單

App 殼在 `app/`（Capacitor 8，iOS + Android），網站一推上 main 就會自動：
- **App Android**：產生可直接安裝的測試版 APK（Actions → 該次執行 → Artifacts → `tryon-debug-apk`）
- **App iOS**：確認可編譯；填好 Apple 金鑰後自動上傳 TestFlight

Bundle ID / 套件名稱：`tw.tryon.app`（上架前可改，改了要同步改 `app/capacitor.config.json` 與原生專案）

---

## 一、你要做的事（打勾）

### Android（Google Play）
- [ ] 開 Google Play 開發者帳號（一次 US$25）：https://play.google.com/console
- [ ] 跟 Claude 說「要 Android 簽章」→ Claude 產生 keystore 與四個 GitHub Secrets 的值，你貼到 GitHub → Settings → Secrets → Actions：`ANDROID_KEYSTORE_B64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`
- [ ] 之後每次建置會多一個 `tryon-release-aab`，上傳到 Play Console
- [ ] 個人帳號規定：正式上架前需 **12 位測試者連續 14 天**封閉測試，早點找人

### iOS（App Store）
- [ ] Apple Developer Program（每年 US$99）：https://developer.apple.com/programs/
- [ ] App Store Connect → Users and Access → Integrations → App Store Connect API → 建一把 **App Manager** 權限的金鑰，下載 .p8
- [ ] GitHub Secrets：`ASC_KEY_ID`、`ASC_ISSUER_ID`、`ASC_KEY_B64`（.p8 檔 base64）、`APPLE_TEAM_ID`
- [ ] App Store Connect 先建立 App（名稱「試穿吧」、Bundle ID `tw.tryon.app`）
- [ ] 之後每次推送自動上 TestFlight，手機裝 TestFlight 即可測

### 兩邊都要
- [ ] 隱私權政策網址：`https://frankf19-19.github.io/fitroom/#privacy`（網站頁尾可開）→ 之後建議綁自訂網域
- [ ] 客服 Email（填在商店頁）
- [ ] 截圖：iPhone 6.7"（1290×2796）至少 3 張、Android 手機至少 2 張 → 跟 Claude 說「做商店截圖」

---

## 二、商店文案（可直接貼）

**名稱**：試穿吧 TryOn
**副標（30 字）**：一張照片，先看穿上身的樣子再買
**簡短說明（80 字）**：上傳全身照，放入想試的衣服、鞋子、帽子、飾品甚至髮型，AI 直接合成真實穿搭照。每天有免費額度。

**完整說明**
```
網拍買衣服最怕什麼？收到才發現不適合。

試穿吧讓你先看再買：
• 上傳一張全身照
• 放入想試的上衣、褲裙、洋裝、鞋子、帽子、飾品，連髮型都能換
• 30 秒內看到 AI 合成的真實穿搭照，可前後對比、下載、分享
• 尺寸合身預估：輸入三圍與尺碼，立刻知道偏緊還是寬鬆
• 我的衣櫃：常用單品存起來，一鍵搭配
• 每天免費額度，用完可在網站購買點數

你的照片只用來產生你要求的合成結果，不用於訓練、不提供第三人，隨時可一鍵刪除帳號與所有資料。
```

**關鍵字（iOS，100 字）**：虛擬試穿,AI試衣,穿搭,服飾,網拍,試穿,換髮型,穿搭模擬,衣服,購物

**分類**：購物 / 生活風格 **年齡分級**：12+（Apple 問「不常出現的成人主題」選無；Google 選 Everyone）

---

## 三、隱私表格怎麼填

| 項目 | Apple「App 隱私」 | Google「資料安全」 |
|---|---|---|
| Email | 聯絡資訊 → 用於 App 功能（帳號）→ 與使用者連結 | 個人資訊 → 電子郵件 → 帳號管理 |
| 照片 | 使用者內容 → 照片或影片 → App 功能 → 與使用者連結 | 相片和影片 → App 功能 |
| 購買紀錄 | 購買 → App 功能 | 財務資訊 → 購買記錄 |
| 追蹤 | 不追蹤 | 不分享資料 |
| 資料可刪除 | 是（App 內刪除帳號） | 是 |
| 傳輸加密 | 是（HTTPS） | 是 |

第三方處理：fal.ai、Google（AI 合成）、Supabase（儲存）、綠界（網站付款）。

---

## 四、審核備註（Review Notes，兩邊都貼）

```
測試帳號：請用 Email 登入，驗證碼會寄到該信箱；若需固定測試帳號請來信索取。
本 App 為 AI 虛擬試穿工具。使用者上傳自己的照片與想試穿的單品照，伺服器呼叫 AI 模型合成結果。
數位點數僅於網站販售，App 內不提供購買（App 內點數頁僅顯示餘額與說明）。
App 內功能：原生相機與相簿選圖、分享到其他 App、儲存到相簿、尺寸合身計算（離線可用）。
```

---

## 五、App 內原生登入（Apple / Google）設定

程式已內建（`@capgo/capacitor-social-login` → Supabase ID Token 登入）。要啟用需要：

**Sign in with Apple（iOS 必做，Apple 審核規定）**
1. Apple Developer → Identifiers → `tw.tryon.app` → 勾選 **Sign in with Apple**。
2. Xcode 專案（或 Claude 幫你在 CI 補）加入 Sign in with Apple capability。
3. Supabase → Authentication → Providers → Apple：開啟，**Client IDs** 填 `tw.tryon.app`（原生登入不需要 Secret Key）。

**Google（App 內）**
1. Google Cloud → Credentials 建兩組 OAuth client：**Web application**（給 Supabase 驗證用）與 **iOS**（Bundle ID `tw.tryon.app`）；Android 另建 **Android** 類型（需 SHA-1，Claude 產簽章時一起給）。
2. 把 Web client ID 填進 `index.html` CONFIG 的 `GOOGLE_WEB_CLIENT_ID`，iOS client ID 填 `GOOGLE_IOS_CLIENT_ID`。
3. Supabase → Providers → Google 的 **Authorized Client IDs** 加上 iOS 與 Android client ID。
4. iOS 還要在 `Info.plist` 加 URL scheme（反轉的 iOS client ID），跟 Claude 說一聲會補進 `patch-native.js`。

沒設定時 App 會自動只顯示 Email 驗證碼登入，不會壞。

## 六、已知限制與之後要做的
- App 內購（IAP / Google Play Billing）之後再加，先用網站賣點數符合規定。
- 要換 Bundle ID 或 App 名稱，跟 Claude 說一聲即可。
