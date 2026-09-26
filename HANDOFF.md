# 接手維修說明（給 AI 看的）

> 這份文件寫給**任何接手這個專案的 AI**（Claude、Gemini 或其他模型）。
> 你以前沒看過這個專案沒關係，照著讀完大約 5 分鐘就能開始安全地修改。
> 動手之前請整份讀完，特別是「⚠️ 地雷區」——那些都是以前**真的出過**的 bug。
>
> **如果你是 9B 等小模型（例如 Ornith-1.5-9B），請改讀 [`HANDOFF-9B.md`](HANDOFF-9B.md)**，
> 那張卡片比較短，而且常見任務都有現成指令可以用。

---

## 0. 三十秒了解這個專案

| 項目 | 內容 |
|---|---|
| 是什麼 | 「京都行程景點地圖」，Billy 一家人 2026/9/29–10/3 京都自由行用的網頁 |
| 網址 | https://kyoto-trip-map.vercel.app |
| Repo | GitHub `puBILYYEN/kyoto-map`，**`main` 分支一 push，Vercel 就自動上線** |
| 技術 | 純靜態網頁：HTML + CSS + 原生 JavaScript。**沒有 build、沒有 npm、根目錄沒有 package.json** |
| 地圖 | MapLibre GL JS（放在 `vendor/`，不走 CDN），圖磚用 OpenFreeMap（免費、免金鑰） |
| 雲端 | Firebase（Google 登入 + Firestore），只有「跳棋」家人即時同步功能用到 |
| 後端 | 只有「線上導遊」有後端：`ai-backend/`，部署在 Render，跟 Vercel 無關 |
| 使用者 | Billy（寫程式新手的大學生）和家人，全部用**繁體中文**溝通，主要用手機 |

---

## 1. 接手後的第一件事

1. **先要記錄**：請使用者到網站「已選景點」區塊最下面按「🪵 下載系統記錄（.log）」，
   把檔案傳給你。看法見下面「5. 除錯流程」。沒有記錄就不要憑空猜原因。
2. `git status`、`git log --oneline -10` 看目前狀態，不要蓋掉別人還沒 commit 的東西。
3. 讀 `VERSION.txt` 最上面幾筆，知道最近改了什麼（很多 bug 是最近一次改動造成的）。
4. 使用者說的症狀如果跟下面「⚠️ 地雷區」某一條很像，先從那條查起。

---

## 2. 檔案地圖

| 檔案 | 負責什麼 | 什麼時候要改 |
|---|---|---|
| `index.html` | 頁面骨架、按鈕、各種彈出視窗的外框；最下面決定 JS 載入順序 | 加按鈕、加彈出視窗 |
| `logger.js` | **系統記錄（.log）**，必須是第一個載入的 JS | 改記錄格式、加自動攔截項目 |
| `data.js` | **所有內容資料**：景點 `SPOTS`、分類 `CATEGORY_META`、行前準備 `TRIP_PREP`、日語小抄 `PHRASES`、退稅小幫手 `TAX_REFUND`、Firebase 設定 `SHARE_CONFIG`、導遊設定 `AI_CONFIG` | 90% 的需求只改這個檔 |
| `app.js` | 所有互動邏輯：地圖、清單、選點、路線、跳棋同步、Google 登入、導遊聊天、問路語音、各面板 | 改功能、修 bug |
| `styles.css` | 所有樣式，含手機版（`@media (max-width: 860px)` 以下） | 改外觀 |
| `sw.js` | Service Worker（離線快取）。**每次改任何前端檔案都要把 `VERSION` 加 1** | 每次部署 |
| `VERSION.txt` | 更新紀錄，新的寫在最上面，格式「版本：vN」 | 每次部署 |
| `kyoto-border.js` | 京都府府界的 GeoJSON（地圖上的邊界線） | 幾乎不用動 |
| `tv.html` / `tv.js` / `tv.css` | **電視版**（Android TV 電視盒，遙控器操作、只讀）。共用 `data.js`、`logger.js`，不載入 `app.js`；家人行程直接讀 Firestore `members`（開放讀取、不用登入）；「全家白板」把每個人的路線用各自顏色疊在一起即時更新，手機打開景點介紹時 `app.js` 的 `pushViewing()` 會寫 `viewing/{uid}`，電視顯示「✏️ 名字」白板筆（規則沒發布時只有這個不能用） | 電視版的問題 |
| `tools/check.js` | **改完必跑的自動檢查**（`node tools/check.js`），不會部署到網站 | 加新的資料欄位或新檔案時 |
| `tools/find.js` 等 | 現成指令：`find` 查景點、`set-coords` 改座標、`add-spot` 新增景點、`add-category` 新增分類、`bump` 加版號（用法寫在各檔案開頭） | 常見任務直接用，不用手改 data.js |
| `HANDOFF-9B.md` | 給 9B 等小模型的短版說明卡 | 新增現成指令時 |
| `.hermes.md` | `HANDOFF-9B.md` 的副本，Hermes Agent 會優先自動讀它（每次只讀一個說明檔） | 改完 HANDOFF-9B.md 後執行 `cp HANDOFF-9B.md .hermes.md`（check.js 會檢查） |
| `README.md` | 給人看的說明，含 **Firestore 安全規則全文**、Firebase 設定步驟 | 改到 Firebase 時 |
| `docs/*.mmd` | 架構圖（Mermaid），GitHub 會直接畫出來 | 架構大改時 |
| `ai-backend/` | 線上導遊後端（Node，零套件），部署在 Render；`.vercelignore` 把它排除在 Vercel 外 | 導遊壞掉時 |

**JS 載入順序（index.html 最下面）**：`logger.js` → `vendor/maplibre-gl.js` → `data.js` → `kyoto-border.js` → `app.js`。
全部是一般 `<script>`（不是 module），所以 `data.js` 裡的 `const SPOTS` 在 `app.js` 可以直接用。

---

## 3. 部署流程（每次改完都照做）

```bash
# 1. 在開發分支上改

# 2. sw.js 的 VERSION 加 1、VERSION.txt 最上面加一筆新紀錄（用指令一次做完）
node tools/bump.js "這次改了什麼"

# 3. 跑自動檢查，有 ❌ 就不准 commit（語法、資料格式、簡體字、檔案截斷、忘記加版號都會抓）
node tools/check.js

# 4. commit、push 開發分支，再快轉合併到 main（main 一 push 就自動上線）
git add <改過的檔案>
git commit -m "說明這次改了什麼"
git push -u origin <開發分支>
git checkout main && git pull origin main
git merge --ff-only <開發分支>
git push origin main
git checkout <開發分支>
```

- **忘了改 `sw.js` 的 VERSION** → 家人手機會一直用舊快取，看起來像「改了沒生效」。
- Vercel 通常 1 分鐘內上線；手機上要**完全關掉網頁再打開**（或重新整理兩次）才會拿到新版。
- `ai-backend/` 改了要到 Render 手動部署（Auto-Deploy 建議關掉）。

---

## 4. 資料格式

### 景點（`data.js` 的 `SPOTS`，一行一個）

```js
{ id:'t65', categories:['temple'], name:'壬生寺', area:'市中心・壬生',
  lat:35.001872205038815, lng:135.74336623943248,
  address:'京都府京都市中京区壬生梛ノ宮町31',   // 選填，有填 Google 地圖連結會用地址查
  hours:'8:30–17:00',                            // 選填，不確定就不要填
  booking:{ level:'required', note:'說明' },     // 選填：permit / required / recommended
  labelSide:'right',                             // 選填：地圖標籤貼左或右，避免重疊
  shape:'buddha',                                // 選填：triangle / star / ingot / buddha
  desc:'介紹文字' },
```

### id 開頭字母（新增時接續最大的號碼，**不能重複**）

| 字母 | 用途 | 字母 | 用途 |
|---|---|---|---|
| `b` | 住宿與交通（飯店、車站、加油站） | `p` | 日本警察局（30 筆，政府開放資料） |
| `t` | 寺與神社 | `k` | 機車與腳踏車停車場（京都市開放資料） |
| `s` | 穿搭與藥妝／購物 | `r` | 柏青哥的廁所（借廁所用） |
| `v` | 美景 | `d` | 鐵道迷之旅 |
| `j` | 精進料理 | `u` | 宇治抹茶 |
| `o` | 陰陽師 | `n` | 織田信長 |
| `e` | 各種體驗（忍者、陶藝、茶道…） | | |

### 新增一個分類要改**兩個地方**

1. `data.js` 的 `CATEGORY_META` 加 `key: { label:'中文名', color:'#深色' }`（白字要看得清楚，用深色）
2. `app.js` 的 `TABS` 陣列加 `{ cat:'key', label: CATEGORY_META.key.label }`

只改一邊：下拉選單不會出現，或畫面直接壞掉（`CATEGORY_META[c]` 是 undefined）。

### 快速驗證沒寫壞（不需要瀏覽器、不需要安裝套件）

```bash
node tools/check.js
```

會檢查：JS 語法、id 重複、缺欄位、分類不存在、座標超出關西範圍（經緯度寫反）、
分類只加了一邊、簡體字、`index.html` 載入順序、`sw.js` 快取清單，
以及跟上一次 commit 比：**景點數變少、檔案突然縮水超過 20%（整份重寫被截斷）、前端改了但沒加版號**。

---

## 5. 除錯流程

### 5-1. 系統記錄（.log）——最重要的線索

- 位置：網站「已選景點」區塊最下面「🪵 下載系統記錄（.log）」（手機在下方「✅ 已選」分頁）。
- 按鈕是 `logger.js` 自己綁的，**就算 `app.js` 整個當掉也按得到**。
- 記錄存在每支手機自己的 localStorage（最多 600 筆），不會上傳。**要看哪個人的狀況，就要那個人的手機匯出**。
- 檔案開頭有網站版本、快取版本、裝置、景點數、地圖狀態、登入狀態、目前選點，後面是時間軸。

| 標籤 | 意思 | 看到時先懷疑 |
|---|---|---|
| `uncaught` | 未捕捉的程式錯誤（會附檔名:行:列） | 最近一次改的程式；`Cannot access 'X' before initialization` = TDZ（見地雷區 1） |
| `promise` | 非同步錯誤沒被接住 | Firebase / fetch 相關 |
| `resource` | 檔案載入失敗 | 網路、`vendor/` 檔案、Firebase CDN |
| `select` | 自己的選點變化（勾選、取消、清除、從連結載入、登入接回舊選點） | 「選點不見」：看是哪一個動作把數量變成 0 |
| `跳棋` | 家人同步：上傳成功/失敗、登入狀態、**家人選點數量變化（例如「哥 5→0」）** | 同步、Firestore 規則 |
| `地圖` | 標記畫了幾個、底圖載入 | 「標記已畫出 0 / N 個」= renderMarkers 當掉 |
| `導遊` | 提問、失敗代號 | 後端代號見 README「導遊的錯誤代號」 |
| `sw` | 離線快取註冊、新版接管 | 「改了沒生效」 |
| `network` / `page` | 斷線、恢復、切到背景 | 日本漫遊訊號問題 |

時間已經換成**那支手機的當地時間**（開頭會寫是日本時間還是台灣時間），不用再換算。
記錄開頭的「===== 診斷摘要 =====」會自動比對已知的故障模式，先看那段。
手機上另有「📋 複製精簡記錄」：只有摘要＋最近 40 筆，給上下文小的模型用。

### 5-2. 其他線索

- **跳棋雲端記錄**：「🔍 查看跳棋同步記錄」按鈕，讀 Firestore `trips/kyoto2026/memberLogs`，跨裝置、所有人共用。
- **導遊錯誤代號**：E1 沒網路、E2 沒設定後端、E3 連不上、E4 逾時、E4xx/E5xx 後端回傳的 HTTP 狀態。後端健康檢查：`https://kyoto-ai.onrender.com/healthz`。
- **本機實測**：`python3 -m http.server 8791`，瀏覽器開 `http://localhost:8791/`。有 Playwright 的話用它點點看；Firebase 相關可以用 `page.route()` 攔截 `gstatic.com/firebasejs/...` 換成假模組測試。

---

## 6. ⚠️ 地雷區（以前真的發生過）

1. **TDZ：`renderMarkers()` 在 `app.js` 很前面就同步執行**。
   它（以及它呼叫的函式）用到的任何 `const` / `let`，都必須宣告在 `app.js` 最上面那一區（`othersState`、`SHAPE_BASE_COLOR` 旁邊）。
   宣告在後面 → `ReferenceError: Cannot access ... before initialization` → **地圖上一個標記都不見**。
   用 `function` 宣告的函式不受影響（會被提升）。
2. **不要在標記元素本身設 `clip-path`**：會把名稱標籤、跳棋旗子一起裁掉。特殊形狀一律畫在 `::before` 上（見 `styles.css` 的 `.marker-shape-*`）。
3. **不要對 `.maplibregl-marker` 設 `position: relative`**：MapLibre 靠 `position:absolute` 定位，改掉標記會全部跑位。
4. **閃爍只能變顏色，不能變透明度**：以前用 opacity 閃，家人反映「常常按不到」。現在只動 `::before` 的 `background`。
5. **忘記改 `sw.js` 的 VERSION** → 手機一直拿到舊版。
6. **Firestore 安全規則不會跟著程式自動部署**：規則全文在 README，改了要請使用者自己到 Firebase Console 貼上並「發布」。
   規則沒更新 → 寫入被擋 → 記錄裡會看到 `permission-denied`。
7. **跳棋身份以前用「名字」當 id**，兩台手機打同一個名字就互相覆蓋，選點變 0。已改成 Google 登入 uid，不要改回去。
8. **同一件事不要寫入兩次**：`signInWithPopup` 完成跟 `onAuthStateChanged` 都會觸發，所以登入後的處理只交給 `onAuthStateChanged`（有 `loadingMemberForUid` 防重入）。
9. **座標一定要準**：使用者非常在意。能用使用者從 Google 地圖長按取得的座標就用那個；只能依地址估算時，`desc` 開頭要寫「⚠️ 座標為依地址估算，尚未逐一用Google地圖核對精確位置」。
10. **頁面上有 `id="map"` 的 div**，瀏覽器會自動產生全域變數 `map` 指向它；判斷地圖是否可用要看 `map && typeof map.flyTo === 'function'`。
11. **選點會存在手機（localStorage `kyotoMapSelected`），而且跟雲端比對前不准上傳。**
    以前沒存，重新開啟網頁時畫面是空的，又立刻把空清單上傳，蓋掉雲端的選點（家人看到「某人 5→0」）。
    `scheduleMemberSync()` / `pushMemberDoc()` 裡的 `ownSelectionReconciled` 檢查**絕對不能拿掉**；
    比對邏輯在 `reconcileOwnSelection()`，依「手機最後修改時間 vs 雲端 updatedAt」決定用哪邊。
12. **`#list=` / `#order=` 連結套用後要把網址的 # 清掉**（`clearShareHash()`），
    不然選點存在手機後，每次重新整理都會再套用一次，把之後自己改的選點蓋回去。
13. **導遊只能重新排列、不能刪除**：導遊回答裡的 `[[ORDER: …]]`、`[[ORDER@m1: …]]` 一律經過
    `reorderKeepAll()`——漏掉的景點保留在最後、多出來的忽略。這是使用者明確要求的規則，不要改成直接照導遊的清單。
    格式說明是寫在前端 `buildGuideContext()` 送出的狀態裡（不在後端 system prompt），所以改格式不用重新部署 Render。
    後端 `max_tokens` 是 600，導遊說明寫太長時結尾的標記會被截斷，所以格式說明要求**標記放在回答最前面**；
    前端也會清掉半截標記，而且使用者問排順序、導遊卻沒給可用的 ORDER 時，改提供 `plannedOrderIds()` 算的順序。
    排順路時「住宿與交通」（機場、車站、飯店）維持原位，距離從開頭那段之後才算（`tripLengthKm()`）。

---

## 7. 給 Ornith-1.5 及其他開源／較小模型的特別規則

Ornith-1.5（2026/8 發布的開源模型，397B / 35B / 9B，另有手機用的 9B-Mobile）
社群實測有三個弱點，剛好都會傷到這個專案。**不管你是哪個模型，照這幾條做都比較安全。**

1. **一次只改一小段，絕對不要把整個檔案重新輸出一次。**
   `app.js` 有兩千多行、`data.js` 近九百行，而實測 Ornith-1.5 產生超過約 80 行的程式碼時容易陷入重複迴圈，
   結果就是檔案被截斷或塞滿重複內容，整個網站壞掉。
   做法：找到要改的那幾行 → 只換掉那幾行；新增景點就只插入那一行。
2. **一律繁體中文、台灣用語。** Ornith-1.5 常會冒出簡體字和大陸用語。
   `tools/check.js` 會抓簡體字，但抓不到用語，請自己對照：
   視頻→影片、信息→資訊、軟件→軟體、質量→品質、默認→預設、網絡→網路、打車→叫計程車、地鐵→捷運／地下鐵。
3. **改完一定跑 `node tools/check.js`。** 有 ❌ 就不准 commit。
   看到「行數少了超過 20%」→ 用 `git checkout -- 檔名` 還原，重新用小範圍修改的方式再做一次。
4. **沒把握就停下來問使用者**，特別是這幾塊：Firestore 安全規則、Google 登入流程、`sw.js` 的快取邏輯。
   這幾塊改錯會讓全家人的資料不同步或網站打不開，而且不容易從畫面上看出來。
5. **9B 版本（使用者目前用的就是 Ornith-1.5-9B）上下文有限**，`app.js`、`data.js` 都塞不進去。
   所以準備了現成指令（見 `HANDOFF-9B.md`）：`tools/find.js` 查景點、`tools/set-coords.js` 改座標、
   `tools/add-spot.js` 新增景點、`tools/add-category.js` 新增分類、`tools/bump.js` 加版號寫紀錄。
   這些指令改完會自動驗證，失敗就自動還原，不會留下壞掉的檔案。
   超出這些指令範圍的修改（登入、同步、快取、大段程式），9B 應該寫診斷報告交給較大的模型。
   手機上跑的 9B-Mobile 不能讀檔案、不能執行指令，只能看「📋 複製精簡記錄」並說明原因。
6. **架設的人注意**：Ornith-1.5 的工具呼叫預設可能用 Markdown 程式碼區塊包住 JSON，導致解析失敗，
   system prompt 裡要加「工具呼叫請輸出純 JSON，不要用程式碼區塊包起來」。

---

## 8. 跟使用者溝通的原則

- 一律**繁體中文**，用新手聽得懂的話，專有名詞要解釋。
- **不造假**：營業時間、票價、規定查不到或不確定就寫「不確定／以官網為準」，不要編。
- 使用者傳座標過來，照抄，不要自己「修正」。
- 改完要說清楚：改了什麼、已經上線了沒、使用者需要自己做什麼（例如重新整理、到 Firebase 發布規則）。
- 行程日期 **2026/9/29–10/3**，住宿 RESI STAY HEART（京都市下京区飴屋町253），租了一台 Yamaha JOG125 機車。
