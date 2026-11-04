# 發展路線

一版補一塊和 Cloudflare 的差距，依「對實際應用的影響」排序。每版都會更新 [CHANGELOG.md](../CHANGELOG.md) 與 [bindings.md](bindings.md)。這份規劃會隨做隨調。

| 版本 | 主題 | 內容 | 狀態 |
|---|---|---|---|
| 0.1.x | 基礎 | 閘道、Assets、D1/KV/R2/Queues/Cron/DO/Vectorize/限流/service/AI、AI Gateway、Docker | ✓ |
| 0.2.0 | WebSocket | 閘道轉發 upgrade；Worker 的 `WebSocketPair`、`new Response(null, {status: 101, webSocket})`；Durable Object 的 `ctx.acceptWebSocket` 與 hibernation handler（`webSocketMessage/Close/Error`）、`getWebSockets`、tags | ✓ |
| 0.3.0 | DO SQL storage | `ctx.storage.sql.exec()`（同步，Node 內建 `node:sqlite`），`migrations[].new_sqlite_classes`；SQLite 型 DO 的 KV API 也存在同一個資料庫 | ✓ |
| 0.4.0 | R2 進階 | S3 相容 API（SigV4 驗證：List/Get/Put/Head/Delete/Copy、multipart）；binding 的 `createMultipartUpload` | ✓ |
| 0.5.0 | 沙箱 | Node 權限模型（只能讀應用資料夾、不能開子程序）、記憶體上限、請求逾時、乾淨的 `process.env` | ✓ |
| 0.6.0 | wrangler 相容 | `wrangler.toml`、`--env` 多環境、模組規則（`import` 文字 / 資料 / wasm）、`rucloud kv` / `rucloud r2` 指令 | ✓ |
| 0.7.0 | HTMLRewriter | `HTMLRewriter` 子集（選擇器、element/text/comments/document handler） | ✓ |

## 還缺什麼（0.7.0 時的盤點）

| 面向 | 缺口 | 影響 |
|---|---|---|
| **品質** | 沒有放進 repo 的整合測試：每版都是手動跑腳本驗證；沒有 CI | 改動容易壞掉舊功能而沒發現 |
| **維運** | 只處理 Ctrl-C，沒有處理 SIGTERM，也沒有等進行中的請求做完（`docker stop` 會直接砍掉）；沒有 metrics；log 只印在 stdout，沒有 `tail` | 正式環境難以監控與排錯 |
| **部署** | 沒有部署 API、版本紀錄、rollback；改 `wrangler.jsonc` 要整個重啟 | 每次更新都要登入主機 |
| **網路** | 沒有內建 HTTPS（要自己架反向代理）；Worker 回應不會被快取；靜態檔案沒有壓縮 | 小型部署還要多架一層 |
| **資源** | Durable Object 永遠留在記憶體、SQLite 連線不關；沒有備份指令 | 物件多了以後記憶體一直長 |
| **執行環境** | Workflows、service binding 的 RPC 與具名 entrypoint、`connect()`、Worker 主動連出的 WebSocket、串流 HTMLRewriter | 部分 Cloudflare 專案跑不起來 |
| **資料** | Hyperdrive、Analytics Engine、R2 事件通知（→ Queues）、D1 匯出 / 匯入、Queues 的 HTTP pull | 進階應用缺功能 |
| **AI** | Workers AI 不支援串流與圖片 / 語音模型；Vectorize 是暴力搜尋；AI Gateway 沒有 fallback 鏈與儀表板 | 大規模 RAG 不適合 |
| **規模** | 單機：所有狀態在一台機器的 SQLite | 無法水平擴充、沒有高可用 |

## 接下來的版本

依「先穩、再好維運、再補功能」排序。每版的內容做的時候可能再調整。

| 版本 | 主題 | 內容 |
|---|---|---|
| 0.8.0 ✓ | 測試與 CI | `tests/` 整合測試（`cargo test` 起 rucloud、跑 examples 與各綁定、WebSocket、S3、沙箱）；GitHub Actions（fmt、clippy、test、Docker build） |
| 0.9.0 ✓ | 維運 | SIGTERM 優雅關閉（停止收新請求、等進行中的請求、關掉 Worker 程序）；`/__rucloud/metrics`（Prometheus：請求數、延遲、Worker 重啟、綁定呼叫）；log 存檔與 `rucloud tail <應用>`；健康檢查端點 |
| 0.10.0 ✓ | 部署 | 管理 API（token 驗證）：上傳新版本（tar）、版本列表、rollback、熱重載設定；`rucloud deploy` 指令；Durable Object 閒置逐出；`rucloud backup` / `restore`（SQLite 線上備份） |
| 0.11.0 ✓ | 邊緣 | HTTPS（自備憑證 / ACME）、HTTP 轉址；閘道快取（選擇性開啟，Cloudflare 本身不會自動快取 Worker 回應）、`caches.default` 跨程序共用；gzip / brotli |
| 0.12.0 ✓ | 執行環境 | Workflows（`step.do` / `step.sleep` / `step.waitForEvent`，進度存 SQLite，可重試、可恢復）；service binding RPC 與具名 entrypoint；Worker 主動連出的 WebSocket（`fetch` + `Upgrade`） |
| 0.13.0 ✓ | 資料 | Hyperdrive（`connectionString` 與連線參數）；Analytics Engine（`writeDataPoint` 存 SQLite，提供 SQL 查詢 API）；R2 事件通知送進 Queues；`rucloud d1 export / import`；Queues 的 HTTP pull consumer |
| 0.14.0 ✓ | 串流與 socket | 串流 HTMLRewriter（邊讀邊改）；`connect()` TCP socket（`cloudflare:sockets`） |
| 0.15.0 ✓ | AI | Workers AI 串流（SSE）；AI Gateway 的 Universal endpoint（fallback）；Vectorize 精確搜尋改成多執行緒 + heap（約 4 倍快）。HNSW 等近似索引延後：精確搜尋在 10 萬筆內已經夠快，近似索引會讓結果不再精確 |
| 1.0.0 ✓ | 穩定 | 設定檔嚴格檢查、`rucloud check`、資料夾格式版本、相容性承諾（doc/stability.md） |

## 1.x

1.0 之後只加功能、不破壞相容性（見 [stability.md](stability.md)）。

| 版本 | 主題 | 內容 | 狀態 |
|---|---|---|---|
| 1.1.0 ✓ | 管理介面 | 管理埠上的網頁：應用狀態、即時 log、版本與 rollback、快取清除、Analytics 查詢、佇列 | |
| 1.2.0 ✓ | 開發體驗 | `rucloud init`（4 個範本）、`rucloud types`（產生 `Env` 型別）、`--enable-source-maps`（TypeScript 的行號本來就正確） |
| 1.3.0 ✓ | 持續複寫 | SQLite 的變更持續送到 S3 / R2（類似 Litestream），機器壞了可以在另一台還原到幾秒前 | |
| 1.4.0 | workerd 評估 | 評估用 Cloudflare 開源的 workerd 取代 Node 跑 Worker（真正的 isolate 隔離、CPU 限制）；可行就做成可選的執行環境 | |

## 之後再考慮

* **多台機器**：多台共用狀態、Durable Object 的跨機器路由。
* **Containers**：Cloudflare Containers 的對應（rucloud 本來就在 Docker 裡，可以由 Worker 啟動容器）。
* **Browser Rendering**：接本機的 Chromium（Puppeteer / Playwright 相容介面）。
* **Images**：圖片縮放、轉檔。

## 不打算做的

全球複製與 Anycast、Cloudflare 的 DDoS / WAF 網路、Email Routing 等依賴 Cloudflare 自家網路的產品。
