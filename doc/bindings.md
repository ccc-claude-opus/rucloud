# 綁定對照與差異

和 Cloudflare 的 API 對照。沒列出的方法就是還沒支援，呼叫時會丟出說明清楚的錯誤。

## Workers 執行環境

| 項目 | rucloud |
|---|---|
| 模組格式 | `export default { fetch, queue, scheduled }`、`export default class extends WorkerEntrypoint`、`addEventListener('fetch')` |
| 全域 API | Node.js 24 原生的 `fetch`、`Request`、`Response`、`Headers`、`URL`、Web Streams、`crypto.subtle`、`TextEncoder`… |
| `request.cf` | 固定的假值（`colo: "LOCAL"`）；有 `CF-IPCountry` 標頭時 `country` 取自它 |
| `ctx.waitUntil` | ✓（不阻擋回應） |
| `caches.default` / `caches.open` | 存在 rucloud 的記憶體，所有 Worker 程序共用；依 `Cache-Control: max-age / s-maxage`，沒有就不存 |
| `cloudflare:workers` | `DurableObject`、`WorkerEntrypoint`、`WorkflowEntrypoint`、`RpcTarget`、`env`、`waitUntil` |
| `node:*` 模組 | 都能用（等同永遠開著 `nodejs_compat`） |
| TypeScript `main` | Node 24 的型別轉換（`--experimental-transform-types`，enum、namespace 也可以）；不讀 `tsconfig.json` 的 `paths` |
| 設定檔 | `wrangler.jsonc`、`wrangler.json`、`wrangler.toml`；`env.<名稱>` 多環境 |
| 相對 import | 可以省略副檔名（依序找 `.ts` `.js` `.mjs` `.mts` `.tsx` `.jsx` 與 `/index.*`） |
| 模組規則 | 預設 `.txt` `.html` `.sql` → 字串、`.bin` → `ArrayBuffer`、`.wasm` → `WebAssembly.Module`；`rules = [{ type = "Text" \| "Data" \| "CompiledWasm", globs = [...] }]` 自訂；`.json` 不需要 import attribute |
| 打包 | 不打包（不跑 esbuild）：`node_modules` 裡的套件由 Node 直接載入 |
| CPU 時間限制 | 沒有逐請求的 CPU 計時；事件迴圈卡住超過 `max_block_ms`（預設 30 秒）會重開程序 |
| `process.env` | 只有 `PATH`、`HOME` 等基本變數；請用 `env` 取得設定與密鑰 |
| 檔案系統 | 預設只能讀應用資料夾、不能寫（Node 權限模型） |
| `WebSocketPair`、101 回應 | ✓（見下方 WebSocket 一節） |
| `HTMLRewriter` | ✓ 子集（見下方） |
| `connect()`（`cloudflare:sockets`） | ✓ TCP、TLS、`startTls()`；沒有 Cloudflare 對 25 埠等的限制 |

## WebSocket

```js
const [client, server] = Object.values(new WebSocketPair());
server.accept();
server.addEventListener('message', (e) => server.send(`echo: ${e.data}`));
return new Response(null, { status: 101, webSocket: client });
```

* 閘道把 upgrade 請求用原始 TCP 轉給 Worker 程序，101 之後位元組直接對接；WebSocket 訊框由 Node 端的 rucloud 執行環境處理（文字、二進位、分段、ping/pong、close）。
* 轉給 Durable Object（`return stub.fetch(request)`）或 service binding 時，跨程序同樣是位元組對接，不會多一層解碼。
* 101 送出前 `send()` 的訊息會先排隊，連線接上後依序送出。
* 單則訊息上限 32 MB。不支援 `permessage-deflate` 壓縮。
* Worker 主動連出：`const ws = (await fetch(url, { headers: { Upgrade: 'websocket' } })).webSocket; ws.accept();`（用 Node 內建的 WebSocket 客戶端，`Sec-WebSocket-Protocol` 以外的自訂標頭不會送出）。

## HTMLRewriter

```js
return new HTMLRewriter()
  .on('a[href^="http"]', { element(el) { el.setAttribute('target', '_blank'); } })
  .on('#main > p:first-child', { text(t) { t.replace(t.text.toUpperCase()); } })
  .onDocument({ end(end) { end.append('<!-- by rucloud -->', { html: true }); } })
  .transform(await env.ASSETS.fetch(request));
```

| 項目 | 支援 |
|---|---|
| 選擇器 | `*`、標籤、`#id`、`.class`、`[attr]`、`[attr=v]` `^=` `$=` `*=` `~=` `\|=`（可加 `i`）、後代（空白）、子代（`>`）、`:first-child`、`:not(簡單選擇器)` |
| Element | `tagName`、`attributes`、`getAttribute` `hasAttribute` `setAttribute` `removeAttribute`、`before` `after` `prepend` `append` `replace` `setInnerContent`（`{ html: true }` 時不跳脫）、`remove` `removeAndKeepContent`、`onEndTag(end => end.before/after/remove)` |
| Text / Comment | `text`、`replace` `before` `after` `remove`；文字 handler 收到比對到的元素（含後代）裡的文字 |
| Document | `doctype`、`text`、`comments`、`end(end => end.append())` |

邊讀邊改：每收到一段就處理能確定的部分並送出；標籤被切在兩段之間時會等下一段。一個文字節點可能分成好幾次 `text()`，最後一次的 `lastInTextNode` 是 `true`。和 Cloudflare 的差異：不支援 `:nth-child` 等其他虛擬類別。

## Static Assets

| 設定 | rucloud |
|---|---|
| `directory` | ✓ |
| `binding`（`env.ASSETS.fetch`） | ✓ |
| `run_worker_first`：`true` 或 `["/api/*", "!/api/docs/*"]` | ✓ |
| `not_found_handling`：`single-page-application`、`404-page` | ✓ |
| `html_handling` | 固定為「`/a` 找 `a`、`a.html`、`a/index.html`」，不做 307 轉址 |

## D1

| API | 說明 |
|---|---|
| `prepare(sql).bind(...)` | 參數：`null`、數字、字串、布林（轉 0/1）、`ArrayBuffer`/`Uint8Array`（BLOB）；`undefined` 會丟 `D1_TYPE_ERROR` |
| `.first(col?)` `.all()` `.run()` `.raw({columnNames})` | ✓；`meta` 有 `changes`、`last_row_id`、`duration`、`rows_read`、`rows_written` |
| `db.batch([...])` | 同一個交易，失敗整批回滾 |
| `db.exec(sql)` | 多句 SQL |
| `db.withSession()` | 回傳同一個資料庫（單機沒有讀取複本） |
| 外鍵 | 預設 `PRAGMA foreign_keys = ON`（同 D1） |

## KV

`get(key, type | {type})`（`text`/`json`/`arrayBuffer`/`stream`、陣列 bulk get）、`getWithMetadata`、`put(key, value, {expiration, expirationTtl, metadata})`、`delete`、`list({prefix, limit, cursor})`。

差異：**強一致**（Cloudflare 是最終一致，最長 60 秒）；`expirationTtl` 沒有 60 秒下限。

## R2

`head`、`get(key, {range, onlyIf})`、`put(key, value, {httpMetadata, customMetadata})`（value 可以是字串、`ArrayBuffer`、`Blob`、`ReadableStream`，串流寫入不佔記憶體）、`delete(key | keys)`、`list({prefix, limit, cursor, delimiter})`。`R2Object` 有 `writeHttpMetadata()`、`httpEtag`、`checksums.md5`。

Multipart：`createMultipartUpload(key, {httpMetadata, customMetadata})` → `uploadPart(n, value)`（回傳 `{partNumber, etag}`）→ `complete(parts)`；也有 `resumeMultipartUpload(key, uploadId)` 與 `abort()`。

不支援：條件式 put、`include` 選項（中繼資料一律回傳）、`ssecKey`。

### S3 相容 API

```toml
# rucloud.toml
[s3]
port = 8780
access_key_id = "…"
secret_access_key = "…"
```

開發模式：`RUCLOUD_S3_ACCESS_KEY_ID=… RUCLOUD_S3_SECRET_ACCESS_KEY=… rucloud dev --s3-port 8780`。

```bash
aws --endpoint-url http://localhost:8780 s3 ls s3://my-bucket/
aws --endpoint-url http://localhost:8780 s3 cp big.iso s3://my-bucket/   # 大檔自動 multipart
```

| 項目 | 說明 |
|---|---|
| bucket | wrangler 設定裡 `r2_buckets[].bucket_name`；不同應用同名時以第一個為準 |
| 網址 | path-style（`/bucket/key`）；`<bucket>.host` 的虛擬主機風格也接受 |
| 驗證 | SigV4（標頭或 presigned URL），只接受設定的那一組金鑰；沒有匿名讀取 |
| 操作 | ListBuckets、ListObjects V1/V2、Get（Range）/Head/Put/Delete/Copy Object、DeleteObjects、multipart、GetBucketLocation |
| 不支援 | 建立 / 刪除 bucket、versioning、ACL、bucket policy、lifecycle、ListParts / ListMultipartUploads、跨應用的 Copy、aws-chunked 每段簽章的驗證（只驗證整個請求的簽章） |

## Queues

| 設定 / API | 說明 |
|---|---|
| `send(body, {contentType, delaySeconds})`、`sendBatch` | `contentType`：`v8`（預設，支援 Date/Map/Set/位元組）、`json`、`text`、`bytes` |
| consumer：`max_batch_size`、`max_batch_timeout`、`max_retries`、`dead_letter_queue` | ✓；另外支援 rucloud 擴充的 `retry_delay`（秒） |
| `message.ack()` / `retry({delaySeconds})`、`batch.ackAll()` / `retryAll()` | ✓；handler 丟例外視為全部 retry |

佇列是整個 rucloud 程序共用的，所以不同應用可以互相送訊息。

**HTTP pull consumer**：`consumers: [{ "queue": "jobs", "type": "http_pull" }]` 的佇列不會推給 Worker，由外部程式從管理埠取：

```bash
curl -X POST localhost:8799/queues/jobs/messages/pull -d '{"batch_size": 10, "visibility_timeout_ms": 30000}'
curl -X POST localhost:8799/queues/jobs/messages/ack -H 'content-type: application/json' \
  -d '{"acks": [{"lease_id": "…"}], "retries": [{"lease_id": "…", "delay_seconds": 60}]}'
curl -X POST localhost:8799/queues/jobs/messages -H 'content-type: application/json' -d '{"body": {"from": "outside"}}'
```

**R2 事件通知**（rucloud 擴充，Cloudflare 是用 `wrangler r2 bucket notification` 設定）：

```jsonc
"r2_buckets": [{ "binding": "FILES", "bucket_name": "uploads",
  "event_notifications": [{ "queue": "thumbnails", "actions": ["PutObject", "CompleteMultipartUpload"], "prefix": "images/" }] }]
```

訊息內容：`{ account, action, bucket, object: { key, size, eTag }, eventTime }`。

## Cron Triggers

`triggers.crons` 的 5 欄位語法，UTC。開發模式（`rucloud dev`）可以用 `curl "localhost:8787/__scheduled?cron=*+*+*+*+*"` 手動觸發。

## Durable Objects

| API | 說明 |
|---|---|
| `idFromName`、`newUniqueId`、`idFromString`、`get`、`getByName` | ✓ |
| `stub.fetch()`、`stub.<方法>(...args)`（RPC） | ✓；RPC 參數與回傳值用 rucloud 的結構化序列化（JSON + Date/Map/Set/位元組/BigInt） |
| `ctx.storage`：`get/put/delete/list/deleteAll`、`getAlarm/setAlarm/deleteAlarm`、`transaction` | ✓（KV 型 storage） |
| `ctx.blockConcurrencyWhile` | ✓ |
| `alarm()` | ✓；失敗 10 秒後重試 |
| WebSocket hibernation：`ctx.acceptWebSocket(ws, tags)`、`getWebSockets(tag)`、`getTags`、`setWebSocketAutoResponse`、`webSocketMessage/Close/Error`、`serializeAttachment` | ✓（物件不會真的休眠，一直留在記憶體） |
| SQLite 型（`migrations` 的 `new_sqlite_classes`）：`ctx.storage.sql.exec()`、`ctx.storage.kv`、`transactionSync` | ✓（見下方） |
| Point-in-time recovery（`getBookmarkForTime` 等） | 不支援 |

### SQLite 型 Durable Object

```jsonc
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChatRoom"] }]
```

```js
const { id } = this.ctx.storage.sql
  .exec('INSERT INTO messages (name, text) VALUES (?, ?) RETURNING id', name, text)
  .one();
for (const row of this.ctx.storage.sql.exec('SELECT * FROM messages')) { … }
```

* 每個物件一個 SQLite 檔，由擁有該物件的 Worker 程序用 `node:sqlite` 開啟，所以 `exec()` 和 Cloudflare 一樣是**同步**的。
* `exec` 可以一次多句（回傳最後一句的結果），參數只套用到最後一句。cursor：迭代、`toArray()`、`one()`、`raw()`、`columnNames`、`rowsRead`、`rowsWritten`。BLOB 讀出來是 `ArrayBuffer`。
* 非同步的 `get/put/delete/list` 與同步的 `ctx.storage.kv.*` 都存在同一個資料庫的 `_cf_KV` 表；鬧鐘仍由 rucloud 排程。
* `transactionSync()` / `transaction()` 用 SAVEPOINT，可以巢狀。
* 和 Cloudflare 不同：cursor 會一次讀完全部結果（不是邊讀邊取）；資料庫連線在物件存在期間一直開著。

同一個物件的事件是**完全依序**處理（比 Cloudflare 的 input gate 嚴格），所以物件之間互相呼叫形成環的話會卡住。

## Vectorize

`upsert`、`insert`、`query(vector, {topK, returnValues, returnMetadata, namespace, filter})`、`getByIds`、`deleteByIds`、`describe`。`filter` 支援 `$eq $ne $in $nin $lt $lte $gt $gte`。度量方式在 wrangler 設定裡用 rucloud 擴充欄位 `"metric": "cosine" | "euclidean" | "dot-product"`（預設 cosine）。查詢是精確搜尋（不是近似），多執行緒掃描整個索引：10 萬筆 768 維約 13 ms（Apple Silicon）。百萬筆以上建議改用專門的向量資料庫。

## Rate Limiting

```jsonc
"ratelimits": [{ "name": "LIMITER", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } }]
```

`await env.LIMITER.limit({ key })` → `{ success }`。固定窗口，計數在 Rust（多個 Worker 程序共用）。

## Workflows

```jsonc
"workflows": [{ "name": "orders", "binding": "ORDERS", "class_name": "OrderFlow" }]
```

```js
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

export class OrderFlow extends WorkflowEntrypoint {
  async run(event, step) {
    const charge = await step.do('charge', { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } }, () => pay(event.payload));
    await step.sleep('cool down', '1 hour');
    const ok = await step.waitForEvent('approval', { type: 'approve', timeout: '1 day' });
    return step.do('ship', () => ship(ok.payload));
  }
}
// const inst = await env.ORDERS.create({ params: { amount: 100 } }); await inst.status();
```

| 項目 | 說明 |
|---|---|
| 執行方式 | 重播：每次喚醒從頭跑 `run()`，已完成的 `step.do` 直接回傳存好的結果，所以 `step.do` 以外的程式碼要能重複執行 |
| 步驟名稱 | 同名的步驟依出現順序編號，順序要固定（和 Cloudflare 一樣） |
| 狀態 | `queued`、`running`、`waiting`（sleep / 等事件）、`paused`、`complete`、`errored`、`terminated` |
| 儲存 | `<state>/<應用>/workflows.sqlite`；rucloud 重啟後接著跑 |
| 差異 | 重試的等待在 Worker 程序裡進行（不會跨程序重啟）；同時最多跑 16 個實例；沒有 Cloudflare 的步驟數與大小限制 |

## Hyperdrive

```jsonc
"hyperdrive": [{ "binding": "HD", "id": "…", "localConnectionString": "postgres://user:pass@localhost:5432/shop" }]
```

`env.HD.connectionString`（以及拆好的 `host`、`port`、`user`、`password`、`database`）直接交給 `pg`、`postgres`、`mysql2` 等驅動。rucloud 不做連線池與查詢快取。連線字串也可以放在 `.dev.vars` 或環境變數 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HD`。

## Analytics Engine

```js
env.AE.writeDataPoint({ blobs: [url.pathname, country], doubles: [ms], indexes: [userId] });
```

```bash
rucloud analytics "SELECT blob1 AS path, COUNT(*) AS n, AVG(double1) AS ms FROM page_views WHERE timestamp > datetime('now', '-1 day') GROUP BY blob1"
curl -X POST localhost:8799/analytics/sql -d "SELECT …"     # 管理埠
```

欄位：`timestamp`（UTC 文字，可用 SQLite 的 `datetime()`）、`index1`、`blob1`…`blob20`、`double1`…`double20`、`_sample_interval`（一律 1，不取樣）。和 Cloudflare 的差異：用 SQLite 的 SQL（不是 ClickHouse 方言）；資料保留 92 天。

## Service bindings

```jsonc
"services": [{ "binding": "AUTH", "service": "auth-worker" }]
```

`env.AUTH.fetch(request)` 會進到同一個 rucloud 裡名叫 `auth-worker` 的應用（含它的靜態檔案）。

RPC：`env.AUTH.verify(token)` 呼叫目標應用 default export（`WorkerEntrypoint` 類別或物件）的方法；`{ "binding": "ADMIN", "service": "auth-worker", "entrypoint": "Admin" }` 呼叫具名 entrypoint。參數與回傳值用 rucloud 的結構化序列化（支援 Date、Map、Set、位元組、BigInt），不支援傳函式或 stub。`fetch()` 一律進 default export。

## Workers AI

`env.AI.run(model, inputs)` 轉給 OpenAI 相容的後端：

| 環境變數 | 說明 |
|---|---|
| `RUCLOUD_AI_BASE_URL` | 必填，例如 `http://localhost:11434/v1`（Ollama） |
| `RUCLOUD_AI_API_KEY` | 可省略 |
| `RUCLOUD_AI_MODEL` | 可省略；設定後忽略程式碼裡的 `@cf/...` 名稱 |
| `RUCLOUD_AI_EMBEDDING_MODEL` | 可省略；`{text}` 輸入用的 embedding 模型 |

支援 `{messages}`、`{prompt}`（回傳 `{response}`）與 `{text}`（回傳 `{shape, data}`）。`{ stream: true }` 回傳 SSE 的 `ReadableStream`（`data: {"response":"…"}`，最後是 `data: [DONE]`），可以直接 `new Response(stream, { headers: { 'content-type': 'text/event-stream' } })`。不支援圖片、語音模型。

## AI Gateway

不是 Worker 綁定，是一個 HTTP 代理：

```
http://localhost:8790/<gateway 名稱>/<provider>/<供應商原本的路徑>
```

內建 provider：`openai`、`anthropic`、`nvidia`、`deepseek`、`openrouter`、`groq`、`mistral`、`google-ai-studio`、`zhipu`、`moonshot`，也可以在 `[ai_gateway.providers]` 自訂。

| 功能 | 怎麼用 |
|---|---|
| Log | `GET /__logs?limit=50`（時間、模型、狀態、耗時、位元組、是否命中快取） |
| 快取 | 請求帶 `cf-aig-cache-ttl: 秒數`，或設定 `cache_ttl`；`cf-aig-skip-cache: true` 跳過。串流回應（SSE）也能快取。快取鍵包含金鑰，不同使用者不會互相拿到 |
| 限流 | `rate_limit = { limit = 60, period = 60 }`（每個 gateway 名稱） |
| 重試 | `retries = 2`，上游 429 / 5xx / 連線失敗時退避重試 |
| Fallback | Universal endpoint：`POST /<gateway 名稱>`，body 是 `[{ provider, endpoint, headers, query }, …]`，依序嘗試到第一個 2xx；回應標頭 `cf-aig-step` 是成功的步驟 |

例：讓 mini-lang-expert 經過 AI Gateway，把 `API_URL` 換成 `http://localhost:8790/default/nvidia/v1/chat/completions`。
