# 系統圖

GitHub 會直接把 `.mmd` 檔案渲染成圖，點進去就看得到。

| 檔案 | 內容 |
|---|---|
| [`architecture.mmd`](architecture.mmd) | **執行時架構** —— 使用者裝置、靜態網站、需要網路的外部服務 |
| [`deploy.mmd`](deploy.mmd) | **部署流程** —— 一份 repo 怎麼同時部署到 Vercel 和 Render |
| [`guide-flow.mmd`](guide-flow.mmd) | **線上導遊的一次問答** —— 含檢索、各種錯誤代號的產生點 |
| [`offline.mmd`](offline.mmd) | **沒有網路時** —— 哪些功能還能用、哪些不行 |

## 看圖時要記得的三件事

1. **綠色 = 離線也能用**，橘色 = 需要網路。這是整個設計的主軸：
   在日本沒訊號時，景點資料、日語小抄、行前準備都還打得開。

2. **金鑰只存在 Render 那一格**。前端是公開的靜態網頁，任何人按 F12
   都看得到原始碼，所以金鑰絕對不能放在那裡。

3. **根目錄沒有 package.json**，Vercel 才會把它當成靜態網站直接部署。
   後端放在 `ai-backend/` 並由 `.vercelignore` 排除，兩邊互不影響。

## 自己修改圖

`.mmd` 是純文字，直接編輯即可。要在本機預覽可以用
[mermaid.live](https://mermaid.live) 貼上內容。
