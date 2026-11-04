# 部署

## 1. 開發：`rucloud dev`

```bash
cargo install rucloud
cd my-worker                         # 有 wrangler.jsonc 的資料夾
rucloud dev --d1-init DB=schema.sql  # http://localhost:8787
```

* 讀 `.dev.vars`（沒有就讀 `.env`）當密鑰。
* `main` 所在資料夾的檔案改了，Worker 程序會自動重開（`--no-watch` 關掉）。
* 資料存在目前目錄的 `.rucloud/<應用名稱>/`（`--state` 可改）。
* `--env production` 使用 wrangler 設定的 `env.production`，資料存在 `<name>-production`。
* `--d1-migrate` 啟動時套用 `migrations/` 裡還沒套用的 SQL 檔。
* `--d1-init` 每次啟動都會執行；schema 用 `CREATE TABLE IF NOT EXISTS` 就不會有問題。也可以手動：

```bash
rucloud d1 execute . my-db --file schema.sql
rucloud d1 execute . my-db --command "SELECT COUNT(*) FROM users"
rucloud d1 migrations create . my-db add_orders   # migrations/0003_add_orders.sql
rucloud d1 migrations apply . my-db
rucloud kv put . greeting "你好" --binding KV
rucloud r2 object put . my-bucket/logo.png --file logo.png
```

## 2. 正式：`rucloud serve rucloud.toml`

```toml
state_dir = "/var/lib/rucloud"   # 相對路徑以設定檔所在資料夾為準
node = "node"                    # Node 執行檔
bind = "0.0.0.0"

# 共用入口：依 Host 標頭分派。應用名稱、hosts 都可以對應
[edge]
port = 80

# AI Gateway（可省略）
[ai_gateway]
port = 8790
cache_ttl = 0
retries = 2
rate_limit = { limit = 120, period = 60 }
[ai_gateway.providers]
ollama = "http://localhost:11434"

# 管理埠（可省略）：/health、/metrics、/apps/<應用>/logs、/apps/<應用>/tail
[admin]
port = 8799
bind = "127.0.0.1"               # 預設只聽本機
token = "換成很長的亂數"           # 可省略；設定後 /apps/* 需要驗證（health、metrics 不用）

shutdown_timeout = 30            # 收到 SIGTERM 後最多等幾秒讓請求做完

# R2 的 S3 相容 API（可省略）
[s3]
port = 8780
access_key_id = "rucloud"
secret_access_key = "換成很長的亂數"

[[app]]
path = "/srv/apps/myshop"        # wrangler 專案資料夾
name = "myshop"                  # 可省略，預設用 wrangler 的 name
port = 8703                      # 可省略：只走 edge
hosts = ["shop.example.com"]     # edge 用
instances = 4                    # Worker 程序數，建議 ≈ CPU 核心數
env_file = "/etc/rucloud/myshop.env"   # 密鑰，會蓋過 .dev.vars
env = "production"               # wrangler 設定的 env.production（可省略）
d1_migrate = true                # 啟動時套用 migrations/
d1_init = { DB = "schema.sql" }
watch = false
sandbox = true                   # Node 權限模型（預設開）
allow_read = []                  # 沙箱額外可讀的路徑，例如 monorepo 上層的 node_modules
allow_write = []
memory_mb = 256                  # 每個 Worker 程序的 JS heap 上限
max_block_ms = 30000             # 事件迴圈卡住多久就重開程序（0 = 不檢查）
```

TLS 建議交給前面的反向代理（Caddy、nginx、Cloudflare Tunnel）。rucloud 會把 `x-forwarded-proto` 反映到 `request.url` 的協定。

### 監控

```bash
curl localhost:8799/health                 # 關閉中回 503
curl localhost:8799/metrics                # 給 Prometheus 抓
rucloud tail myshop --admin http://127.0.0.1:8799 --token …   # 即時 log
rucloud tail myshop --kind error           # 只看錯誤
```

log 也會存成每天一個檔：`<state>/<應用>/logs/YYYY-MM-DD.log`（JSON lines）。

## 3. Docker

repo 附的 `docker-compose.yml` 直接把 test-apps 跑起來：

```bash
docker compose up --build
# TEST_APPS=/別的/路徑 docker compose up --build
```

| 埠 | 服務 |
|---|---|
| 8700 | edge：`http://myshop.localhost:8700` 這類網址 |
| 8701 | mini-lang-expert |
| 8702 | aichat |
| 8703 | myshop |
| 8704 | friendbook |
| 8790 | AI Gateway |

* 應用資料夾以唯讀方式掛在 `/apps`，各自的 `.dev.vars` 會被讀成密鑰。
* 資料在 named volume `rucloud-data`（`/data`），容器重建不會遺失。
* 設定檔是 `docker/rucloud.toml`。

自己的應用：

```dockerfile
FROM rucloud:latest
COPY . /srv/app
CMD ["dev", "/srv/app", "--ip", "0.0.0.0", "--state", "/data", "--no-watch", "--instances", "4"]
```

## 4. 發佈到 crates.io

```bash
cargo publish --dry-run   # 檢查打包內容（含 runtime/*.mjs）
cargo publish
```

`Cargo.toml` 的 `include` 已經限定只打包 `src/`、`runtime/`、`README.md`、`LICENSE`。
