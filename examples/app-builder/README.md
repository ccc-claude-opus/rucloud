# app-builder — AI 網站產生器（Lovable 式）

輸入一句話，AI 幫你做出一個可部署在 rucloud / Cloudflare 上的靜態網站。具備帳號系統、AI 對話、版本管理；AI 金鑰由使用者自填（或用伺服器環境變數的測試金鑰）。

## 跑起來

```bash
cp examples/app-builder/.dev.vars.example examples/app-builder/.dev.vars   # 填入 AUTH_SECRET（與選填的 AI key）
rucloud dev examples/app-builder --d1-init DB=schema.sql                   # http://localhost:8787
```

或跟其他範例一起跑：`rucloud serve examples/rucloud.toml`（<http://localhost:8717>）。

## 功能

1. **註冊 / 登入** — email + 密碼（PBKDF2 雜湊、HMAC 簽章 cookie，同 myshop 的做法）
2. **AI 設定** — 選供應商（NVIDIA NIM / MiniMax / 自訂 OpenAI 相容端點）、模型、填 API Key（存在 D1，永遠不會回傳給前端）
   - 沒填 key 時，退回使用環境變數 `NVIDIA_API_KEY` / `MINIMAX_API_KEY`（Cloudflare 上用 `wrangler secret put`）
3. **專案 + AI 對話** — 像 Lovable：一句話產生第一版；之後持續用對話修改（「把主色改成橘色」）。回應以 **SSE 串流**顯示（含思考過程），完成後自動存成新版本
4. **使用 app** — 右側即時預覽（iframe）、看程式碼、切換歷史版本；產出的網站在 `/apps/<專案id>?v=<版本>`，公開可分享
5. **打包下載** — `⬇ 下載 zip`（或 `GET /api/projects/<id>/download?v=<版本>`）：內含 `index.html` 與部署說明 `README.md`，可直接丟上 Cloudflare Pages / Workers Assets 或 rucloud

## AI 怎麼產生網站

系統提示要求模型輸出「單一 HTML 檔」（內嵌 CSS/JS，可存 localStorage、可用 CDN），最後用 `<APP>…</APP>` 標記包住；修改時要求輸出完整新版。Worker 抽出 HTML 存入 D1 的 `versions` 表，`/apps/:id` 直接回傳，所以產出的是純靜態網站——在 rucloud 與 Cloudflare Pages/Workers Assets 上都能跑。

## 檔案

- `src/worker.js` — 帳號、設定、專案 CRUD、SSE 對話（串流轉發 + 版本儲存）、`/apps/:id` 公開伺服
- `public/index.html` — 單檔 SPA（登入 → 專案列表 → 聊天 + 預覽 + 版本 + 設定）
- `schema.sql` — `users` / `settings` / `projects` / `messages` / `versions`
- `.dev.vars.example` — 範本；`.dev.vars` 已被 .gitignore 排除，金鑰不進版控

## 安全性

- 密碼 PBKDF2（10 萬次）+ 每人隨機 salt；session 是 HMAC 簽章的 cookie，不洩漏存在性
- API Key 只進 D1，API 回應只給 `hasKey` 與末 4 碼
- 專案與訊息有 user_id 歸屬檢查；`/apps/*` 則是刻意公開（方便分享成品）
