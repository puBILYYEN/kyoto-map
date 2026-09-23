# 京都線上導遊 — 後端

前端（`kyoto-map` 根目錄）是公開的靜態網頁，任何人按 F12 就看得到原始碼。
**AI 金鑰放在那裡等於直接公開**，所以由這支程式代為轉送，金鑰只存在伺服器的環境變數裡。

## 為什麼放在同一個 repo

Render 支援指定子目錄部署（Root Directory），所以不需要另開一個 repo。
根目錄的 `.vercelignore` 已經把這個資料夾排除，**Vercel 的靜態部署完全不受影響**。

## 零相依套件

沒有 express，沒有任何 npm 套件，只用 Node 內建模組。
部署快、沒有套件漏洞、`npm install` 不會失敗。

## 部署到 Render

1. 到 https://dashboard.render.com → **New → Web Service**
2. 選 repo `puBILYYEN/kyoto-map`
3. 設定：

| 欄位 | 值 |
|---|---|
| Name | `kyoto-ai` |
| Language | Node |
| **Root Directory** | `ai-backend` ← **這格一定要填** |
| Build Command | 留空 |
| Start Command | `node server.js` |
| Instance Type | Free |

4. Environment Variables：

| 變數 | 值 |
|---|---|
| `AI_BASE_URL` | 供應商的 OpenAI 相容端點（結尾不加斜線）。程式會自動接上 `/v1/chat/completions` |
| `AI_CHAT_URL` | **選填**。路徑不符慣例時用這個直接指定完整網址，指定後會忽略 `AI_BASE_URL` |
| `AI_API_KEY` | 你的金鑰（機密，自己手動輸入） |
| `AI_MODEL` | 模型名稱，依供應商而定 |
| `ALLOWED_ORIGINS` | `https://kyoto-trip-map.vercel.app` |
| `RATE_LIMIT` | `20`（可不填） |
| `TAVILY_API_KEY` | **選填**。設定後導遊能查即時網路資訊（見下面「即時網路搜尋」） |

常見供應商的填法：

| 供應商 | 要填的變數 |
|---|---|
| Groq | `AI_BASE_URL` = `https://api.groq.com/openai` |
| OpenRouter | `AI_BASE_URL` = `https://openrouter.ai/api` |
| Google Gemini | `AI_CHAT_URL` = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
| OpenAI | `AI_BASE_URL` = `https://api.openai.com` |

5. Create Web Service，拿到網址
6. 把網址填進根目錄 `data.js` 的 `AI_CONFIG.endpoint`

> 建議到 Settings 把 **Auto-Deploy 關掉**。否則每次改景點資料 push，
> Render 都會重新部署一次後端，沒有必要。

## 驗證

```
https://你的網址.onrender.com/healthz
```

- `{"ok":true,"configured":true,"webSearch":true}` → 成功，且已接上 Tavily
- `configured` 是 `false` → AI 環境變數沒設好
- `webSearch` 是 `false` → 沒填 `TAVILY_API_KEY`，導遊還是能正常回答，只是查不到即時網路資訊

## 即時網路搜尋（選填，接 Tavily）

導遊原本只會根據自己的訓練資料跟我們的景點資料庫回答，遇到「現在」
「最新」「今天還開嗎」「天氣」這類需要即時資訊的問題就無能為力。接上
[Tavily](https://tavily.com) 之後，每次提問都會先幫忙查一次網路，把
搜尋結果（最多4筆，含標題／摘要／來源網址）附進送給 AI 的內容，讓它
優先參考比較新的資料回答，但還是會照 system prompt 的規則，覺得來源
可疑就老實說「請再確認」，不會照單全收。

啟用方式：到 [tavily.com](https://tavily.com) 註冊拿免費 API Key，
填進 Render 的 `TAVILY_API_KEY` 環境變數即可，不用改任何程式碼。

- **完全選填**：沒填這個變數，功能就是安靜地跳過，跟原本行為一模一樣
- 查詢失敗或逾時（8秒）也是安靜跳過，不會讓整個問答掛掉
- `/healthz` 的 `webSearch` 欄位可以確認有沒有接上（`true`／`false`）
- 金鑰一樣只存在環境變數，不會出現在前端或進 git

## 免費方案的限制

閒置 15 分鐘會休眠，冷啟動要幾十秒。
前端在載入時就會先呼叫 `/healthz` 把它叫醒，所以通常使用者要問的時候已經醒了。

## 安全設計

| 機制 | 作用 |
|---|---|
| 金鑰只存在環境變數 | 不會出現在前端，也不會進 git |
| `ALLOWED_ORIGINS` 白名單 | 別的網站拿到網址也呼叫不動 |
| 每 IP 每分鐘流量限制 | 網址外流時損害有限 |
| 請求長度上限、45 秒逾時 | 避免被灌爆或卡住 |

> `Origin` 標頭只擋得住瀏覽器，用 curl 偽造仍可呼叫。家庭旅遊用途足夠。

## 本機測試

```bash
AI_BASE_URL=https://你的端點 AI_API_KEY=你的金鑰 \
ALLOWED_ORIGINS=http://127.0.0.1:8080 node server.js
```
