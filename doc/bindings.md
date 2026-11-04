# 綁定對照與差異

和 Cloudflare 的 API 對照。沒列出的方法就是還沒支援，呼叫時會丟出說明清楚的錯誤。

## Workers 執行環境

| 項目 | rucloud |
|---|---|
| 模組格式 | `export default { fetch, queue, scheduled }`、`export default class extends WorkerEntrypoint`、`addEventListener('fetch')` |
| 全域 API | Node.js 24 原生的 `fetch`、`Request`、`Response`、`Headers`、`URL`、Web Streams、`crypto.subtle`、`TextEncoder`… |
| `request.cf` | 固定的假值（`colo: "LOCAL"`） |
| `ctx.waitUntil` | ✓（不阻擋回應） |
| `caches.default` / `caches.open` | 程序內記憶體快取，依 `Cache-Control: max-age / s-maxage` |
| `cloudflare:workers` | `DurableObject`、`WorkerEntrypoint`、`WorkflowEntrypoint`、`RpcTarget`、`env`、`waitUntil` |
| `node:*` 模組 | 都能用（等同永遠開著 `nodejs_compat`） |
| TypeScript `main` | Node 24 的型別剝除（只支援可直接剝除的語法） |
| CPU 時間限制 | 沒有 |
| `WebSocketPair`、101 回應 | ✓（見下方 WebSocket 一節） |
| `HTMLRewriter`、`connect()` | 不支援 |

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
* 單則訊息上限 32 MB。不支援 `permessage-deflate` 壓縮，也不支援 Worker 主動連出去的 `fetch()` upgrade（請改用 Node 內建的 `WebSocket` 客戶端）。

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

不支援：multipart upload、條件式 put、`include` 選項（中繼資料一律回傳）。

## Queues

| 設定 / API | 說明 |
|---|---|
| `send(body, {contentType, delaySeconds})`、`sendBatch` | `contentType`：`v8`（預設，支援 Date/Map/Set/位元組）、`json`、`text`、`bytes` |
| consumer：`max_batch_size`、`max_batch_timeout`、`max_retries`、`dead_letter_queue` | ✓；另外支援 rucloud 擴充的 `retry_delay`（秒） |
| `message.ack()` / `retry({delaySeconds})`、`batch.ackAll()` / `retryAll()` | ✓；handler 丟例外視為全部 retry |

佇列是整個 rucloud 程序共用的，所以不同應用可以互相送訊息。

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
| `ctx.storage.sql` | 不支援 |

同一個物件的事件是**完全依序**處理（比 Cloudflare 的 input gate 嚴格），所以物件之間互相呼叫形成環的話會卡住。

## Vectorize

`upsert`、`insert`、`query(vector, {topK, returnValues, returnMetadata, namespace, filter})`、`getByIds`、`deleteByIds`、`describe`。`filter` 支援 `$eq $ne $in $nin $lt $lte $gt $gte`。度量方式在 wrangler 設定裡用 rucloud 擴充欄位 `"metric": "cosine" | "euclidean" | "dot-product"`（預設 cosine）。查詢是記憶體暴力搜尋，適合幾萬筆以內。

## Rate Limiting

```jsonc
"ratelimits": [{ "name": "LIMITER", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } }]
```

`await env.LIMITER.limit({ key })` → `{ success }`。固定窗口，計數在 Rust（多個 Worker 程序共用）。

## Service bindings

```jsonc
"services": [{ "binding": "AUTH", "service": "auth-worker" }]
```

`env.AUTH.fetch(request)` 會進到同一個 rucloud 裡名叫 `auth-worker` 的應用（含它的靜態檔案）。不支援 RPC 方法。

## Workers AI

`env.AI.run(model, inputs)` 轉給 OpenAI 相容的後端：

| 環境變數 | 說明 |
|---|---|
| `RUCLOUD_AI_BASE_URL` | 必填，例如 `http://localhost:11434/v1`（Ollama） |
| `RUCLOUD_AI_API_KEY` | 可省略 |
| `RUCLOUD_AI_MODEL` | 可省略；設定後忽略程式碼裡的 `@cf/...` 名稱 |
| `RUCLOUD_AI_EMBEDDING_MODEL` | 可省略；`{text}` 輸入用的 embedding 模型 |

支援 `{messages}`、`{prompt}`（回傳 `{response}`）與 `{text}`（回傳 `{shape, data}`）。不支援串流。

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

例：讓 mini-lang-expert 經過 AI Gateway，把 `API_URL` 換成 `http://localhost:8790/default/nvidia/v1/chat/completions`。
