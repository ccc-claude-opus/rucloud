# 更新紀錄

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
