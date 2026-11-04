# 更新紀錄

## 1.3.0 — 持續複寫

* **`[replicate]`**：把整個 `state_dir` 持續送到 S3 相容儲存（R2、AWS S3、MinIO，或另一台 rucloud 的 S3 API）或另一個資料夾（`file:///…`，例如 NAS）。
  * SQLite（D1、KV、Durable Objects、佇列、Workflows…）：每 `interval` 秒（預設 10）對有變動的資料庫做線上快照並 gzip，保留最近 `keep` 份（預設 48）。
  * 其他檔案（R2 物件、部署的版本）：有變動就上傳，本機刪掉的遠端也刪；大檔案直接串流上傳。
  * 關閉時會再送最後一輪。
* **`rucloud replica restore [--at 時間]`**：從遠端還原到新的資料夾；`--at` 還原到某個時間點之前最新的快照。`rucloud replica status` 看遠端的狀態。
* `rucloud check` 會檢查 `[replicate]` 的設定。
* 和 Litestream 的差異：不是逐筆送 WAL，最多遺失最後一個 interval 的寫入；資料庫很大時每次都送整份快照；不同資料庫的快照不是同一瞬間。

## 1.2.0 — 開發體驗

* **`rucloud init [資料夾] -t <範本>`**：從內建範本建立新專案（`rucloud init --list`）：
  * `hello`：Worker + 靜態檔案（JavaScript）
  * `typescript`：TypeScript Worker + KV，附 `tsconfig.json`、`package.json`（用真的 `tsc` 驗證過型別檢查會通過）
  * `d1`：D1 待辦清單（API + migrations + 前端）
  * `durable-object`：SQLite 型 Durable Object 的強一致計數器
* **`rucloud types [應用資料夾]`**：依 wrangler 設定產生 `worker-configuration.d.ts` 的 `interface Env`（類似 `wrangler types`）。綁定用 @cloudflare/workers-types 的型別，Durable Object 會帶上 main 模組的類別（RPC 方法有型別）；`vars` 是字面量型別；`.dev.vars` 的密鑰名稱是 `string`（值不會寫出去）。
* Worker 程序開啟 `--enable-source-maps`：自己打包、附 `.map` 的 JS，錯誤的 stack trace 會對回原始碼。TypeScript 檔案本來就是原始行號。

## 1.1.0 — 管理介面

* 管理埠的 `/` 是一個網頁（單一檔案、不連外部 CDN，亮色 / 暗色、手機都能用）：
  * 應用總覽：Worker 程序狀態、請求數與 5xx、平均延遲、處理中的請求、WebSocket、程序重開次數、快取命中率，每 3 秒更新。
  * 單一應用：即時 log（依種類與文字篩選）、版本列表與切換 / rollback / reload、上傳 `.tar.gz` 部署、綁定與呼叫次數、清除閘道快取。
  * Analytics Engine 的 SQL 查詢、佇列訊息數。
  * 有設定 `[admin] token` 時，網頁會要求輸入（只存在該分頁）。
* 管理 API 新增 `GET /stats`（各應用的狀態與計數，JSON）、`GET /queues`（各佇列訊息數），需要 token。

## 1.0.0 — 穩定版

從這版開始遵守語意化版本，承諾範圍見 [doc/stability.md](doc/stability.md)。

* **設定檔嚴格檢查**：`rucloud.toml` 不再接受不認識的欄位（例如打錯字的 `instnaces`），直接報錯，不會默默沒生效。`wrangler.jsonc` / `wrangler.toml` 維持寬鬆。
* **`rucloud check [rucloud.toml | 應用資料夾]`**：啟動前檢查設定格式、Node.js 版本、找不到的應用資料夾 / main / 靜態檔案 / env_file / d1_init、重複的埠與 host、不存在的 service binding 目標、沒有 token 卻對外開放的管理埠、缺連線字串的 Hyperdrive，以及 rucloud 不支援的 wrangler 欄位（`routes`、`compatibility_flags`、`tail_consumers`…）。有錯誤時以 1 結束。
* 啟動時對不支援的 wrangler 欄位印出提醒。
* **資料夾格式版本**：`state_dir` 裡寫入 `VERSION`；遇到比目前版本新的格式會拒絕啟動，避免舊版 rucloud 弄壞資料。
* `rucloud dev` 的 `--ip` 改名為 `--bind`（和 `rucloud.toml` 的 `bind` 一致，舊名稱仍可用）。
* `[admin]` 的 `port` 預設 8799、`[s3]` 的 `port` 預設 8780。
* 文件：新增 doc/stability.md，README 改寫。

## 0.15.0 — AI

* **Workers AI 串流**：`env.AI.run(model, { messages, stream: true })` 回傳 `ReadableStream`，內容是 Workers AI 格式的 SSE（`data: {"response":"…"}` … `data: [DONE]`），由後端的 OpenAI 格式串流轉換而來。
* **AI Gateway Universal endpoint**：`POST /<gateway>`，body 是步驟陣列 `[{ provider, endpoint, headers, query }]`，依序嘗試，第一個成功的回應直接串流回傳（`cf-aig-step` 標示是第幾步）；每一步都會記進 log。
* **Vectorize 查詢加速**：仍是精確搜尋（結果和原本完全相同），改成多執行緒掃描、每條執行緒用 heap 留前 topK 名再合併，不再整份排序。10 萬筆 768 維從約 51 ms 降到約 13 ms（Apple Silicon，release build）。沒有過濾條件時也省掉 metadata 比對。

## 0.14.0 — 串流 HTMLRewriter、TCP socket

* **HTMLRewriter 改成串流**：邊讀邊改，第一段輸出不必等整份 HTML 讀完；標籤、註解、UTF-8 字元被切在兩段之間也能正確處理。文字節點可能分成好幾次 `text()`，最後一次 `lastInTextNode` 為 `true`（和 Cloudflare 一樣）。
* **`connect()`**（`import { connect } from 'cloudflare:sockets'`）：TCP 連線，`secureTransport: 'off' | 'on' | 'starttls'`、`startTls()`、`opened`、`closed`、`close()`；`readable` / `writable` 是 Web Streams。可以接 PostgreSQL、Redis、SMTP 等。

## 0.13.0 — 資料：Hyperdrive、Analytics Engine、R2 事件、pull consumer、D1 匯出

* **Hyperdrive**（`hyperdrive`）：`env.HD.connectionString`、`host`、`port`、`user`、`password`、`database`。rucloud 不做連線池，連線字串取自 `localConnectionString`、`.dev.vars` 或環境變數 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`（和 wrangler dev 相同）。
* **Analytics Engine**（`analytics_engine_datasets`）：`env.AE.writeDataPoint({ blobs, doubles, indexes })`，存在 `<state>/analytics.sqlite`（保留 92 天）。用 SQLite 的 SQL 查詢，每個 dataset 是一個 view：管理埠 `POST /analytics/sql`，或 `rucloud analytics "SELECT …"`。
* **R2 事件通知**：`r2_buckets[].event_notifications = [{ queue, actions, prefix, suffix }]`（rucloud 擴充），物件新增、複製、multipart 完成、刪除時送訊息到佇列，格式和 Cloudflare 相同；binding 與 S3 API 兩條路徑都會觸發。
* **Queues 的 HTTP pull consumer**：`consumers: [{ queue, type: "http_pull" }]` 不推給 Worker；管理埠 `POST /queues/<佇列>/messages/pull`、`/messages/ack`、`/messages`（從外部送訊息）。
* **D1 匯出**：`rucloud d1 export <應用> <資料庫> -o dump.sql [--no-schema | --no-data]`，用 `rucloud d1 execute --file` 匯入。
* 更正 0.10.0 的說明：之前 `cargo build` 沒有重新編譯，原因不是 nightly，而是 `cargo publish --dry-run` 的驗證建置和一般建置共用 target 資料夾、互相覆蓋了 fingerprint。發佈檢查請加 `--target-dir`（見 doc/deploy.md）。

## 0.12.0 — Workflows、service binding RPC、連出的 WebSocket

* **Workflows**（wrangler 設定的 `workflows`）：`env.WF.create({ id, params })`、`get(id)`、`createBatch()`；實例的 `status()`、`pause()`、`resume()`、`terminate()`、`restart()`、`sendEvent({ type, payload })`。
  * `step.do(name, [config], fn)`：結果存進 SQLite，可設定 `retries`（`limit`、`delay`、`backoff`）與 `timeout`；`NonRetryableError`（`cloudflare:workflows`）不重試。
  * `step.sleep`、`step.sleepUntil`、`step.waitForEvent({ type, timeout })`：暫停時不佔用 Worker，到時間或事件進來再喚醒。
  * 用「重播」執行：每次喚醒從頭跑 `run()`，已完成的步驟直接回傳存好的結果。rucloud 重啟後會接著跑。
* **service binding RPC**：`env.SVC.method(...args)` 呼叫目標應用的 `WorkerEntrypoint` 方法（參數、回傳值支援 Date、Map、Set、位元組等）；`entrypoint` 指定具名的 entrypoint。
* **Worker 主動連出的 WebSocket**：`fetch(url, { headers: { Upgrade: 'websocket' } })` 回傳 `response.webSocket`。

## 0.11.0 — HTTPS、快取、壓縮

* **HTTPS**（`[tls]`）：自備憑證（`cert` + `key`，PEM），或 ACME 自動申請與續期（`acme = { domains = [...], email = [...] }`，Let's Encrypt，TLS-ALPN-01 驗證，只需要 443 埠）。和 edge 一樣依 Host 分派，支援 HTTP/2；Worker 看到的 `request.url` 是 `https://`。`redirect_http = true` 讓 edge 的 HTTP 埠全部 308 轉址到 HTTPS。開發時可以用 `rucloud dev --tls-cert --tls-key`。
* **閘道快取**（應用設定 `cache_mb`，預設關）：依 `Cache-Control`（`s-maxage` / `max-age`）快取 Worker 的回應；`private` / `no-store` / `Set-Cookie` / `Vary`（Accept-Encoding 以外）不快取；帶 `Authorization` 的請求不走快取；回應標頭 `cf-cache-status: HIT | MISS | BYPASS`。部署新版本時自動清空；`rucloud purge <應用> [--prefix 主機/路徑]` 手動清。
* **Cache API 跨程序共用**：`caches.default`、`caches.open()` 改存在 rucloud 裡，多個 Worker 程序看到同一份。
* **壓縮**：gzip / brotli（依 `Accept-Encoding`），靜態檔案與 Worker 回應都適用；SSE、圖片、WebSocket 不壓。`compression = false` 關閉。
* metrics 新增 `rucloud_cache_hits_total`、`rucloud_cache_misses_total`、`rucloud_cache_bytes`。

## 0.10.0 — 部署、版本與備份

* **部署**：`rucloud deploy [資料夾] --admin <管理埠>` 把應用打包（不含 `.dev.vars`、`.env` 等密鑰檔與 `.git`）上傳成新版本並啟用。
  * 不停機切換：新版本的 Worker 程序全部起來後才換上，舊版本等 `shutdown_timeout` 秒讓進行中的請求做完才關。
  * 新版本起不來（例如語法錯誤）時馬上回報錯誤，線上維持原本的版本。
  * 版本存在 `<state>/<應用>/versions/`，保留最近 10 個；重啟 rucloud 後仍跑部署的版本。
  * 密鑰仍然從設定檔 `path` 的 `.dev.vars` 與 `env_file` 讀，不會跟著程式碼上傳。
* `rucloud versions <應用>`、`rucloud rollback <應用> [--to <版本>|path]`、`rucloud reload <應用>`（改了設定或密鑰後重新載入，同樣不停機）。
* 管理 API：`GET/POST /apps/<應用>/versions`、`POST /apps/<應用>/versions/<id>/activate`、`/rollback`、`/reload`。
* **Durable Object 閒置逐出**：閒置超過 `do_idle_ms`（預設 60 秒）的物件從記憶體移除並關閉 SQLite 連線；有開著的 WebSocket 或還在處理事件的物件不會被移除。
* **備份與還原**：`rucloud backup -o backup.tar.gz`（SQLite 用線上備份 API，執行中也可以）、`rucloud restore backup.tar.gz`。
* 專案加上 `rust-toolchain.toml`（stable）。

## 0.9.0 — 維運

* **優雅關閉**：收到 SIGTERM / Ctrl-C 時停止接受新連線，等進行中的請求做完（`shutdown_timeout`，預設 30 秒），再關掉 Worker 程序。`docker stop` 不會再中斷請求。
* **管理埠**（`[admin]`，或 `rucloud dev --admin-port`；預設只聽 127.0.0.1）：
  * `GET /health`：各應用的 Worker 程序狀態；關閉期間回 503。
  * `GET /metrics`：Prometheus 格式，請求數（分靜態檔案 / Worker、狀態碼類別）、延遲直方圖、處理中的請求、WebSocket 連線數、Worker 重開次數、各種綁定的呼叫次數、佇列訊息數。
  * `GET /apps/<應用>/logs`、`/apps/<應用>/tail`（SSE）；設定 `token` 後需要驗證。
* **log**：Worker 的 console 輸出、錯誤與請求紀錄存在記憶體（最近 1000 筆），也每天寫一個 JSON lines 檔（`<state>/<應用>/logs/`，`log_files = false` 可關）。
* **`rucloud tail <應用>`**：即時看 log，可用 `--kind` 過濾、`--json` 輸出原始資料。
* docker-compose：開管理埠（只綁本機）、健康檢查、`stop_grace_period`。

## 0.8.0 — 整合測試與 CI

* `tests/e2e/`：用 Node 內建的 test runner 寫的整合測試，`cargo test` 會一起跑（需要 Node.js）。每個測試檔起一個真的 rucloud，涵蓋：
  * 靜態檔案與 ETag、內部路徑防護、D1、KV、R2（含 multipart）、Queues、Durable Object 的並行一致性、Vectorize、限流、service binding、edge、HTMLRewriter
  * myshop、friendbook 兩個完整應用的流程
  * WebSocket（Worker 回聲、Durable Object 聊天室）、S3 API（自己簽 SigV4）
  * SQLite 型 Durable Object、沙箱與看門狗、wrangler.toml / TypeScript / 模組規則 / migrations / `--env`、`kv` `r2` `d1` 指令
  * 開發模式的 `/__scheduled` 與自動重載
* GitHub Actions：`cargo fmt --check`、`clippy -D warnings`、`cargo test`、`cargo publish --dry-run`、Docker build。
* 加上 `rustfmt.toml` 並整體格式化。

## 0.7.0 — HTMLRewriter

* `HTMLRewriter`（子集）：`on(selector, { element, text, comments })`、`onDocument({ doctype, text, comments, end })`、`transform(response)`。
  * Element：`getAttribute / setAttribute / removeAttribute / hasAttribute / attributes`、`before / after / prepend / append / replace / setInnerContent`（`{ html: true }`）、`remove / removeAndKeepContent`、`onEndTag`。
  * 選擇器：`*`、標籤、`#id`、`.class`、`[attr]`、`[attr=v]` `^=` `$=` `*=` `~=` `|=`（含 `i`）、後代與 `>` 子代、`:first-child`、`:not()`。
  * `script` / `style` 等的內容不會被當成 HTML 解析；非 HTML 的回應原樣傳回。
  * 和 Cloudflare 的差異：整份讀完才處理（不是串流）；一個文字節點只呼叫一次 `text()`。
* `request.cf.country` 會取自 `CF-IPCountry` 標頭（rucloud 放在 Cloudflare 後面時）。
* showcase 新增 `/api/page`：用 HTMLRewriter 改寫靜態的 index.html。

## 0.6.0 — wrangler 相容性

* 讀 `wrangler.toml`（和 `wrangler.jsonc` / `wrangler.json` 並列）。
* 多環境：`rucloud dev --env production`、`rucloud.toml` 的 `env = "production"`；規則和 wrangler 相同（綁定與 `vars` 不繼承、名稱變成 `<name>-<env>`、優先讀 `.dev.vars.<env>`），資料也分開存放。
* 模組規則：`import` 文字檔（`.txt` `.html` `.sql`）、資料檔（`.bin` → `ArrayBuffer`）、`.wasm`（→ `WebAssembly.Module`），以及 wrangler 設定裡自訂的 `rules`；JSON 不加 `with { type: 'json' }` 也能 import。
* 相對 import 可以省略副檔名（`import './util'` 依序找 `.ts` `.js` `/index.ts`…），TypeScript 的 enum、namespace 也能跑（`--experimental-transform-types`）。
* D1 migrations：`rucloud d1 migrations create | list | apply`（和 wrangler 相同的 `migrations/` 資料夾與 `d1_migrations` 紀錄表），`rucloud dev --d1-migrate`、`d1_migrate = true` 啟動時自動套用。
* `rucloud kv put | get | list | delete`、`rucloud r2 object put | get | list | delete`：直接操作本機資料，rucloud 執行中也可以用。

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
