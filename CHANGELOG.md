# 更新紀錄

## 0.5.0 — 沙箱與資源限制

* **安全修正**：每個應用改用自己的綁定 token。之前所有應用共用一把，A 應用的 Worker 可以存取 B 應用的 D1、KV 等資料。
* **安全修正**：Worker 程序不再繼承 rucloud 的環境變數（只留 `PATH`、`HOME`、`LANG`、`TZ` 等），`RUCLOUD_SPEC`（含 token）讀完就從 `process.env` 刪掉。
* 預設開啟 Node 權限模型（`--permission`）：只能讀應用資料夾與 rucloud 執行環境，只能寫 SQLite 型 Durable Object 的資料夾，不能開子程序、worker threads、原生 addon。`sandbox = false` 或 `rucloud dev --no-sandbox` 關掉；`allow_read` / `allow_write` 加開路徑。
* 看門狗：每秒 ping 一次 Worker 程序，事件迴圈卡住超過 `max_block_ms`（預設 30 秒）就強制重開，無窮迴圈不會讓應用永遠沒有回應。
* `memory_mb`：每個 Worker 程序的 JS heap 上限，超過時程序結束並自動重開。

## 0.4.0 — R2 的 S3 相容 API 與 multipart upload

* 新的 S3 相容端點（`rucloud.toml` 的 `[s3]`，或 `rucloud dev --s3-port`）：aws-cli、rclone、boto3 等工具可以直接存取 R2 bucket。
  * AWS Signature V4 驗證：Authorization 標頭與 presigned URL（GET / PUT），含時間與到期檢查；內容帶 SHA-256 時會核對。
  * ListBuckets、ListObjects（V1、V2，含分頁、delimiter、`encoding-type=url`）、Get（Range、If-None-Match）/ Head / Put / Delete / Copy Object、DeleteObjects、GetBucketLocation。
  * Multipart upload（Create / UploadPart / Complete / Abort），ETag 和 S3 一樣是 `md5-段數`。
  * 支援新版 SDK 預設的 `aws-chunked` 上傳編碼（含 checksum trailer）。
* R2 binding 新增 `createMultipartUpload()`、`resumeMultipartUpload()`、`uploadPart()`、`complete()`、`abort()`。
* 上傳一律串流寫入暫存檔，不經過記憶體。

## 0.3.0 — SQLite 型 Durable Objects

* `migrations[].new_sqlite_classes` 宣告的類別改用 SQLite 儲存：每個物件一個資料庫檔（`<state>/<應用>/do-sqlite/<binding>/<id>.sqlite`），由擁有它的 Worker 程序用 Node 內建的 `node:sqlite` 直接開啟。
* `ctx.storage.sql.exec(query, ...bindings)`：同步、可多句（正確處理字串裡的分號與 `CREATE TRIGGER … END;`）；cursor 支援迭代、`toArray()`、`one()`、`raw()`、`columnNames`、`rowsRead`、`rowsWritten`；`sql.databaseSize`。
* 同步 KV API `ctx.storage.kv.get/put/delete/list`；非同步 KV API 也存進同一個資料庫的 `_cf_KV` 表。
* `transactionSync(fn)`、`transaction(fn)`（含 `txn.rollback()`）用 SAVEPOINT 實作；`deleteAll()` 連 SQL 表一起清掉。
* 一般（KV 型）的 Durable Object 存取 `ctx.storage.sql` 時，會丟出和 Cloudflare 一樣的錯誤。
* `examples/chat` 改成 SQLite 型：聊天紀錄存進每個房間自己的資料庫，加入時先收到最近 20 則。

## 0.2.0 — WebSocket

* 閘道支援 HTTP upgrade：對 Worker 程序用原始 TCP 轉發，101 之後兩邊直接對接，不解讀訊框。
* Worker：`WebSocketPair`、`new Response(null, { status: 101, webSocket })`、`accept()`、`send()`、`close()`、`addEventListener` / `onmessage`。101 送出前 `send()` 的訊息會先存著，接上後再送。
* Durable Objects：`stub.fetch()` 可以轉發 upgrade（跨程序也行）；hibernation API：`ctx.acceptWebSocket(ws, tags)`、`getWebSockets(tag)`、`getTags`、`webSocketMessage / webSocketClose / webSocketError`、`serializeAttachment / deserializeAttachment`、`setWebSocketAutoResponse`。
* Service bindings 與 edge 也能轉發 WebSocket。
* 新範例 `examples/chat`：每個房間一個 Durable Object 的聊天室。

## 0.1.1

* 新增範例 `examples/myshop`（D1、HMAC cookie、PBKDF2）與 `examples/friendbook`（D1 + KV），取自 cloudflare/test-apps；示範用密鑰放在 `.dev.vars.example`。
* `examples/rucloud.toml` 一次跑 showcase、hello、myshop、friendbook。
* 打包修正：`Cargo.toml` 的 `include` 只收根目錄的 `README.md`、`LICENSE`，範例不會進到 crate。

## 0.1.0

第一版。

* Rust 邊緣閘道（axum）：靜態檔案直接回應、`run_worker_first`、SPA / 404、依 Host 分派。
* Worker 程式碼跑在 Node.js 程序池，崩潰自動重開、開發模式熱重載。
* 綁定：D1、KV、R2、Queues、Cron Triggers、Durable Objects（含 alarm）、Vectorize、Rate Limiting、service bindings、Workers AI（OpenAI 相容後端）。
* AI Gateway：log、回應快取（含 SSE）、限流、重試。
* CLI：`dev`、`serve`、`d1 execute`、`ai-gateway`。
* Dockerfile 與 docker-compose。
