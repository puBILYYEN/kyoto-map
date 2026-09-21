# 京都行程景點地圖

一個純靜態網頁（沒有後端、不用資料庫），用 MapLibre GL JS 顯示京都景點地圖，
依「住宿與交通 / 寺與神社 / 穿搭與藥妝 / 美景 / 精進料理 / 動漫迷陰陽師之旅 /
軍事迷織田信長之旅 / 宇治抹茶體驗之旅」八大分類瀏覽，
點景點看詳細介紹，勾選多個景點後可以一鍵開啟 Google 地圖的大眾運輸路線。

## 系統圖

架構圖放在 [`docs/`](docs/)，GitHub 會直接渲染：
[執行時架構](docs/architecture.mmd) ·
[部署流程](docs/deploy.mmd) ·
[導遊問答流程](docs/guide-flow.mmd) ·
[離線時的行為](docs/offline.mmd)

## 檔案結構

```
kyoto-map/
├── index.html   ← 網頁主體
├── styles.css   ← 樣式
├── app.js       ← 互動邏輯（地圖、清單、選取、路線連結）
├── data.js      ← 景點資料庫（可自行增修）
└── README.md    ← 這份說明
```

沒有任何 build 流程、沒有 package.json，純 HTML/CSS/JS，Vercel 會自動當成靜態網站部署。

## 部署到 Vercel（三種方式擇一）

### 方式一：Vercel 網站拖拉上傳（最簡單，不用裝任何東西）

1. 到 https://vercel.com 註冊 / 登入帳號（可用 Email 或 GitHub 帳號登入）
2. 進入 Dashboard，點右上角「Add New...」→「Project」
3. 選擇畫面上「拖拉檔案上傳」的區域，把整個 `kyoto-map` 資料夾拖進去
   （如果只能選檔案不能選資料夾，改用下面「方式二」）
4. 按下 Deploy，等待約 10～20 秒，就會拿到一個 `https://xxxx.vercel.app` 的網址

### 方式二：用 Vercel CLI（電腦上有 Node.js 的話）

在終端機（Mac 用「終端機」App，Windows 用 PowerShell 或 cmd）裡執行：

```bash
# 1. 安裝 Vercel CLI（只需要做一次）
npm install -g vercel

# 2. 切換到這個資料夾
cd 你解壓縮後的kyoto-map資料夾路徑

# 3. 登入並部署
vercel login
vercel --prod
```

過程中它會問幾個問題，全部按 Enter 用預設值就可以。跑完之後終端機會顯示一個網址，
那就是可以直接貼給家人的連結。

### 方式三：透過 GitHub 匯入（適合之後還想常常修改內容）

1. 把 `kyoto-map` 資料夾建立成一個新的 GitHub repository（可以用 GitHub Desktop 或網頁上傳）
2. 到 https://vercel.com/new，選「Import Git Repository」，選剛剛那個 repo
3. 其他設定都不用改，直接 Deploy
4. 之後如果要修改景點資料，只要改 GitHub 上的 `data.js` 檔案，Vercel 會自動重新部署

## 如何新增或修改景點

打開 `data.js`，裡面是一個叫做 `SPOTS` 的陣列，每個景點長這樣：

```js
{ id:'t62', categories:['temple'], name:'新景點名稱', area:'所在區域',
  lat:35.0000, lng:135.7500, desc:'這裡寫景點特色介紹文字。' }
```

- `id`：不能跟其他景點重複，各分類的開頭字母為 temple 用 t、shopping 用 s、scenic 用 v、
  shojin 用 j、onmyoji 用 o、nobunaga 用 n、ujimatcha 用 u、stay 用 b，數字接續下去即可
- `categories`：**陣列**，可同時屬於多個分類，例如 `['temple','onmyoji']`。
  可用的分類有 `stay`（住宿與交通）、`temple`（寺與神社）、`shopping`（穿搭與藥妝）、
  `scenic`（美景）、`shojin`（精進料理）、`onmyoji`（動漫迷陰陽師之旅）、
  `nobunaga`（軍事迷織田信長之旅）、`ujimatcha`（宇治抹茶體驗之旅）
- `lat` / `lng`：緯度／經度，可以到 Google 地圖上對著該地點按右鍵複製座標
- `address`：**選填**。填了之後，詳細介紹裡的「在 Google 地圖上看」會改用地址去查，
  適合座標只有概略值、但地址確定的地點
- `booking`：**選填**。格式為 `{ level:'required', note:'說明文字' }`，
  `level` 可填 `permit`（需事前申請）、`required`（必須預約）、`recommended`（建議預約）。
  填了之後清單會出現標籤，也能用「只看需要預約／申請的景點」篩選出來

另外兩塊內容也寫在 `data.js`，對應右上角的兩個按鈕：

- `TRIP_PREP` → 「🛂 行前準備」：護照、免簽、Visit Japan Web 等證件事項
- `PHRASES` → 「💬 日語小抄」：住宿地址日文寫法、緊急電話、69 句求助日語（10 個分類）

日語小抄每句的格式是 `{ zh: '中文意思', ja: '日文原文', sound: '中文近似發音' }`，
要增減句子直接改 `PHRASES.groups` 裡的陣列即可。這部分是純靜態資料，
**沒有網路也能開**，在日本漫遊訊號不好時仍然可用。
- `desc`：介紹文字，會顯示在下方詳細介紹欄

存檔後重新部署（方式一、二要重新拖拉/執行一次；方式三只要 push 到 GitHub 就會自動更新）。

## 使用說明（給你跟家人）

- 左側可切換分類頁籤，或用搜尋框輸入關鍵字篩選景點
- 點景點名稱或地圖上的圓點，下方會顯示該景點的詳細介紹
- 勾選景點前面的checkbox可以多選，選了兩個以上，左下角會出現「查大眾運輸路線」的按鈕，
  點下去會直接跳到 Google 地圖幫你算好公車/電車路線（依照你勾選的順序，一段一段串起來）
  ※ Google 地圖的大眾運輸模式只支援兩點之間，所以多個景點會拆成一段一段
- 勾選的景點會在地圖上用虛線連起來，圓點內標示 1、2、3 的順序，一眼看出動線順不順
- 已選清單每一列可以按 ▲ ▼ 調整順序、按 ✕ 單獨移除，路線會即時重算
- 路線按鈕上會顯示兩點間的直線距離，上方也會顯示全程直線距離合計，
  方便快速判斷「這兩個點是不是差太遠、不該排在同一天」
- 點景點詳細介紹裡的「在 Google 地圖上看」，可以查看照片、評價與營業時間

### 手機上怎麼用（畫面會自動切換成手機版）

螢幕寬度 860px 以下會自動切成手機版，最下方有三個切換鈕：

- **📋 景點清單**：切分類、搜尋、勾選景點
- **🗺 地圖**：看所有景點位置，勾選的點會標上 1、2、3 並用虛線連起來
- **✅ 已選 (n)**：調整順序、開啟各段路線、清除選取

點任一景點會從下方浮出介紹面板，按 ✕ 收起，按「🗺 看地圖」可直接跳到地圖該位置。
Android 的返回鍵會先關閉這個面板，不會一按就離開網頁。
- 目前收錄座標為概略位置，正式排行程或導航前，建議在 Google 地圖上再次確認實際地址與營業時間

## 離線使用（在日本沒訊號時）

網站有 Service Worker（`sw.js`），**只要在有網路時開過一次**，之後沒有網路也能打開：

| 功能 | 沒網路時 |
|---|---|
| 景點清單、搜尋、分類、勾選、路線連結 | ✅ 完全正常 |
| 日語小抄、行前準備 | ✅ 完全正常 |
| 地圖 | ⚠️ 只看得到之前載過的範圍（圖磚有快取，最多 600 張） |
| 線上導遊 | ❌ 需要網路 |

沒有網路時，網頁頂端會出現提示說明。

**出發前建議做兩件事**：

1. 在有網路的地方把網頁打開一次，並且把地圖縮放到你們會去的區域（嵐山、東山、宇治…），
   讓圖磚先存進快取
2. 用 Android Chrome 開啟後，選單 →「加到主畫面」，之後可以像 App 一樣從桌面開啟

## 共享清單（選用功能）

勾好景點後，在「已選景點」區按「☁️ 分享這份清單」存成一份具名清單，
其他人打開網頁按「📂 開啟共享清單」就能載入同一份。

啟用方式：在 Firebase 主控台建立專案 → 加入「網頁應用程式」→ 複製 config，
填進 `data.js` 的 `SHARE_CONFIG.firebaseConfig`：

```js
const SHARE_CONFIG = {
  firebaseConfig: {
    apiKey: '…', authDomain: '…', projectId: '…',
    storageBucket: '…', messagingSenderId: '…', appId: '…',
  },
  tripId: 'kyoto2026',
  maxLists: 30,
};
```

> **這串 config 不是機密**，它本來就會出現在前端原始碼裡，
> Firebase 的設計就是如此。安全性靠的是下面的安全規則。

到 Firestore Database → 規則，貼上這段（把 `kyoto2026` 換成你的 `tripId`）：

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /trips/kyoto2026/lists/{listId} {
      allow read, delete: if true;
      allow create: if request.resource.data.keys().hasOnly(['name', 'spotIds', 'createdAt'])
                    && request.resource.data.name is string
                    && request.resource.data.name.size() <= 40
                    && request.resource.data.spotIds is list
                    && request.resource.data.spotIds.size() <= 60;
    }
  }
}
```

這組規則把可寫入的範圍限制在那一個路徑，並檢查欄位與長度。

> 老實說：因為沒有登入機制，任何知道網址的人理論上都能讀寫那份清單。
> 對家庭旅遊的用途來說這樣夠了；若之後在意，可以改用 Firebase 匿名登入再加上規則。

沒有填 config 的話，按鈕還是可以按，只會顯示「尚未設定」，不會讓網站壞掉。

## 線上導遊（選用功能）

右上角的「🧭 線上導遊」會開啟聊天視窗，可以問景點特色、請它幫忙排順路的順序、
或是現場遇到的問題。它看得到你目前在地圖上勾了哪些景點。

這個功能需要一個後端來保管 AI 金鑰（**金鑰絕對不能寫在這個靜態網站裡**，
任何人按 F12 就看得到）。後端是獨立的專案，部署在 Render，本專案完全不受影響：

```
kyoto-map/            → 純靜態，Vercel 自動部署（根目錄沒有 package.json，不能加）
kyoto-map/ai-backend/ → 後端代理，Render（用 Root Directory 指定這個子目錄）
```

後端放在同一個 repo 的子目錄，用根目錄的 `.vercelignore` 排除，
所以 **Vercel 那邊完全看不到它**，現有的靜態部署不受影響。
部署步驟見 [`ai-backend/README.md`](ai-backend/README.md)。

後端部署好之後，把網址填進 `data.js` 的 `AI_CONFIG.endpoint` 即可，例如：

```js
const AI_CONFIG = {
  endpoint: 'https://kyoto-ai.onrender.com',
  ...
};
```

留空的話按鈕還是可以按，只會顯示錯誤代號，不會讓網站壞掉。

### 導遊的錯誤代號

家人看到的只有一句人話加一個代號，技術細節寫在瀏覽器主控台。

| 代號 | 意思 | 怎麼處理 |
|---|---|---|
| `E1` | 沒有網路 | 正常現象，其他功能仍可用 |
| `E2` | `AI_CONFIG.endpoint` 還沒填 | 填入 Render 網址 |
| `E3` | 連不上後端 | 檢查 Render 服務是否還活著 |
| `E4` | 等太久沒有回應 | 多半是冷啟動，再試一次 |
| `E403` | 來源被擋 | Render 的 `ALLOWED_ORIGINS` 設錯 |
| `E429` | 問太快 | 等一分鐘 |
| `E500` | 後端的 AI 設定不完整 | 檢查 `/healthz` 的 `configured` |
| `E502` | 後端連不到 AI 供應商 | 金鑰或端點網址有誤，看 Render 的 Logs |

> Render 免費方案閒置 15 分鐘會休眠，冷啟動要幾十秒。網頁載入時會自動先敲一次
> 後端的 `/healthz` 把它叫醒，所以通常等你真的要問的時候它已經醒了。

## 注意事項

- 地圖圖磚使用 [OpenFreeMap](https://openfreemap.org/)（免費、不需申請 API 金鑰），正常使用不會產生費用
- 這個網站部署在 Vercel 的免費方案內就綽綽有餘，不會有額外費用
