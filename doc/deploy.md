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

# HTTPS（可省略）：和 edge 一樣依 Host 分派，應用要設定 hosts
[tls]
port = 443
acme = { domains = ["shop.example.com"], email = ["me@example.com"] }   # Let's Encrypt 自動申請、續期
# cert = "/etc/rucloud/cert.pem"   # 或自備憑證（和 acme 二選一）
# key = "/etc/rucloud/key.pem"
redirect_http = true             # edge 的 HTTP 埠全部轉址到 HTTPS

compression = true               # gzip / brotli（預設開）

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
do_idle_ms = 60000               # Durable Object 閒置多久就從記憶體移除（0 = 不移除）
cache_mb = 64                    # 閘道依 Cache-Control 快取 Worker 回應（不設 = 不快取）
```

HTTPS 可以由 rucloud 自己處理（`[tls]`，ACME 需要 443 埠對外），也可以交給前面的反向代理（Caddy、nginx、Cloudflare Tunnel）；用反向代理時 rucloud 會把 `x-forwarded-proto` 反映到 `request.url` 的協定。

### 監控

```bash
curl localhost:8799/health                 # 關閉中回 503
curl localhost:8799/metrics                # 給 Prometheus 抓
rucloud tail myshop --admin http://127.0.0.1:8799 --token …   # 即時 log
rucloud tail myshop --kind error           # 只看錯誤
```

log 也會存成每天一個檔：`<state>/<應用>/logs/YYYY-MM-DD.log`（JSON lines）。

### 部署新版本

管理埠開著時，可以從任何地方部署（遠端部署請把管理埠綁到內網或放在 TLS 反向代理後面，並設定 token）：

```bash
rucloud deploy ./myshop -m "新增報表" --admin https://admin.example.com --token …
rucloud versions myshop                   # * 是目前的版本
rucloud rollback myshop                   # 回到上一版
rucloud rollback myshop --to path         # 回到 rucloud.toml 的 path
rucloud reload myshop                     # 改了 .dev.vars / env_file 之後
```

* 打包時不含 `.dev.vars`、`.env*`、`.git`、`.wrangler`；`node_modules` 會一起上傳。
* 切換不停機：新版本的 Worker 全部起來才換上；起不來就維持原本的版本並回報錯誤。
* 換版的瞬間新舊程序會短暫並存：同一個 Durable Object 在舊程序裡還沒做完的事件，可能和新程序的事件重疊。

### 備份

```bash
rucloud backup --state /var/lib/rucloud -o backup-$(date +%F).tar.gz   # 執行中也可以
rucloud restore backup-2026-11-04.tar.gz --state /var/lib/rucloud       # 先停掉 rucloud
```

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
cargo publish --dry-run --target-dir target/publish-check   # 檢查打包內容（含 runtime/*.mjs）
cargo publish
```

`--dry-run` 一定要加獨立的 `--target-dir`：驗證建置會編譯打包後的副本，若和平常的建置共用 `target/`，會覆蓋 fingerprint，之後 `cargo build` 不會發現原始碼改過。

`Cargo.toml` 的 `include` 已經限定只打包 `src/`、`runtime/`、`README.md`、`LICENSE`。
