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
| 0.7.0 | 其餘 | `HTMLRewriter`（子集）等，依使用情況決定 | |

## 不打算做的

全球複製、Analytics Engine、Browser Rendering、Images、Email Workers 等依賴 Cloudflare 網路或大型外部服務的產品。
