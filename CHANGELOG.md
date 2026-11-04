# 更新紀錄

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
