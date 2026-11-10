# app-builder — AI 網站產生器（Lovable 式）

輸入一句話，AI 幫你做出一個可部署在 rucloud / Cloudflare 上的靜態網站。具備帳號系統、AI 對話、版本管理；AI 金鑰由使用者自填（或用伺服器環境變數的測試金鑰）。

## 跑起來

```bash
cp examples/app-builder/.dev.vars.example examples/app-builder/.dev.vars   # 填入 AUTH_SECRET（與選填的 AI key）
rucloud dev examples/app-builder --d1-init DB=schema.sql                   # http://localhost:8787
```

或跟其他範例一起跑：`rucloud serve examples/rucloud.toml`（<http://localhost:8717>）。

> 注意：本範例**僅支援 rucloud**。Cloudflare Workers 免費方案每次呼叫只有 10ms CPU，
> 撐不起 AI 長串流的轉發（實測 `exceededCpu`），所以不部署到 Cloudflare。

## 功能

1. **註冊 / 登入** — email + 密碼（PBKDF2 雜湊、HMAC 簽章 cookie，同 myshop 的做法）
2. **兩種專案類型**
   - **靜態網頁**：單一 HTML 檔（內嵌 CSS/JS、localStorage），下載即用
   - **全端應用（Worker + D1）**：AI 產生完整的 rucloud / Cloudflare 專案——`src/worker.js`（D1 API）、`public/index.html`、`schema.sql`（`wrangler.jsonc` 由平台代產），下載 zip 後 `rucloud dev 資料夾 --d1-init DB=schema.sql` 直接跑
3. **AI 設定** — 選供應商（NVIDIA NIM / MiniMax / 自訂 OpenAI 相容端點）、模型、填 API Key（存在 D1，永遠不會回傳給前端）
   - 在 `.dev.vars` 或環境變數提供 `NVIDIA_API_KEY` / `MINIMAX_API_KEY`，就是全站預設金鑰，使用者不必填；沒有時使用者必須自填
4. **專案 + AI 對話** — 像 Lovable：一句話產生第一版；之後持續用對話修改。回應以 **SSE 串流**顯示（含思考過程），完成後自動存成新版本
5. **使用 app** — 右側即時預覽（iframe）、看程式碼（全端模式可切換檔案）、切換歷史版本；靜態網站在 `/apps/<專案id>?v=<版本>`，公開可分享
6. **打包下載** — `⬇ 下載 zip`（或 `GET /api/projects/<id>/download?v=<版本>`）：靜態含 `index.html`；全端含完整專案結構與部署說明

## AI 怎麼產生程式

- **靜態**：系統提示要求模型輸出「單一 HTML 檔」，最後用 `<APP>…</APP>` 標記包住；Worker 抽出後存 D1 的 `versions` 表，`/apps/:id` 直接回傳
- **全端**：系統提示要求用 `<FILE path="...">…</FILE>` 標記輸出多個檔案；Worker 抽出後存 `version_files` 表（`wrangler.jsonc` 與 README 由平台代產，確保格式正確）。zip 解開就是一個標準 wrangler 專案——在 rucloud 與 Cloudflare 上都能跑

## 檔案

- `src/worker.js` — 帳號、設定、專案 CRUD、SSE 對話（串流轉發 + 版本儲存）、`/apps/:id` 公開伺服、zip 打包（含自製 ZIP 寫入器）
- `public/index.html` — 單檔 SPA（登入 → 專案列表 → 聊天 + 預覽 + 版本 + 設定）
- `schema.sql` — `users` / `settings` / `projects` / `messages` / `versions` / `version_files`（Worker 啟動時也會冪等地自行建表與補欄位）
- `.dev.vars.example` — 範本；`.dev.vars` 已被 .gitignore 排除，金鑰不進版控

## 安全性

- 密碼 PBKDF2（10 萬次）+ 每人隨機 salt；session 是 HMAC 簽章的 cookie，不洩漏存在性
- API Key 只進 D1，API 回應只給 `hasKey` 與末 4 碼
- 專案與訊息有 user_id 歸屬檢查；`/apps/*` 則是刻意公開（方便分享成品）
