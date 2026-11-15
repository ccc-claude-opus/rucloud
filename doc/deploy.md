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

先用 `rucloud check rucloud.toml` 檢查：設定檔不接受不認識的欄位（打錯字會報錯），也會檢查找不到的檔案、重複的埠、不支援的 wrangler 欄位。資料夾裡的 `VERSION` 記錄資料格式，比目前 rucloud 新的資料會拒絕啟動（見 [stability.md](stability.md)）。

```toml
state_dir = "/var/lib/rucloud"   # 相對路徑以設定檔所在資料夾為準
node = "node"                    # Node 執行檔
bind = "0.0.0.0"

# 共用入口：依 Host 標頭分派。應用名稱、hosts、wrangler 的 routes 都可以對應
[edge]
port = 80

# 自己的網域（可省略）：每個應用自動有 <名稱>.example.com；DNS 把 example.com 與 *.example.com 指到這台
[domain]
base = "example.com"
root = "www"                     # example.com 本身給哪個應用（可省略）

# 信任的反向代理（預設只有本機）：只有從這些位址來的請求才採用 X-Forwarded-For / Proto
# trusted_proxies = ["127.0.0.1", "10.0.0.0/8", "cloudflare"]

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
port = 8799                      # 預設 8799
bind = "127.0.0.1"               # 預設只聽本機
token = "換成很長的亂數"           # 可省略；設定後 /apps/* 需要驗證（health、metrics 不用）

shutdown_timeout = 30            # 收到 SIGTERM 後最多等幾秒讓請求做完

# HTTPS（可省略）：和 edge 一樣依 Host 分派
[tls]
port = 443
# Let's Encrypt：每個應用的網域（[domain]、hosts、routes）自動申請、到期前 30 天續期；
# on_demand：第一次有人連到還沒有憑證的網域才申請（只限屬於某個應用的網域，例如執行中新增的應用）
acme = { email = ["me@example.com"] }
# cert = "/etc/rucloud/cert.pem"   # 或自備憑證（和 acme 二選一）
# key = "/etc/rucloud/key.pem"
redirect_http = true             # edge 的 HTTP 埠全部轉址到 HTTPS

compression = true               # gzip / brotli（預設開）

# R2 的 S3 相容 API（可省略）
[s3]
port = 8780                      # 預設 8780
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

HTTPS 可以由 rucloud 自己處理（`[tls]`，ACME 用 TLS-ALPN-01 驗證，需要 443 埠對外，不需要 DNS API），也可以交給前面的反向代理（Caddy、nginx、Cloudflare Tunnel）。用反向代理時，把它的位址放進 `trusted_proxies`（同一台機器上的不用，預設就信任本機）：rucloud 會採用它給的 `X-Forwarded-Proto`（`request.url` 的協定）與 `X-Forwarded-For`（Worker 看到的 `cf-connecting-ip`、Rate Limiting 用的 IP）。前面是 Cloudflare 的代理（橘色雲朵）時寫 `"cloudflare"`，會改用 `CF-Connecting-IP`。

Let's Encrypt 對同一個主網域每週發的憑證數量有上限；執行中新增的應用很多時，請改用萬用字元憑證（見 1.7）。

### 監控

管理埠的首頁（例如 <http://127.0.0.1:8799/>）就是管理介面：應用狀態、即時 log、版本與 rollback、快取、Analytics 查詢。

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

### 執行中新增應用（`[dynamic]`）

要「替使用者執行程式碼」（例如 [examples/app-builder](../examples/app-builder) 把 AI 產生的專案跑起來）時，不要在自己的 Worker 裡用 `new Function` 執行：同一個程序裡，別人的程式碼讀得到你的 `env`、改得掉 `crypto` / `fetch`。改成讓每個使用者的專案在 rucloud 裡各自是一個應用：

```toml
[edge]
port = 8700                 # 新增的應用在 http://<名稱>.<網域>:8700

[admin]
port = 8799                 # 不設 token 會自動產生在 <state_dir>/admin-token

[dynamic]
prefix = "gen-"             # 名稱必須以它開頭
grant = ["app-builder"]     # 這些應用的 env 會有 RUCLOUD_ADMIN_URL、RUCLOUD_DYNAMIC_TOKEN
max_apps = 100
memory_mb = 128             # 每個 Worker 程序的 JS heap 上限
max_block_ms = 5000         # 卡住多久就重開（只影響那個應用）
```

```bash
# 新增或部署新版本：body 是應用資料夾的 tar.gz（wrangler.jsonc 在最上層）
curl -X PUT -H "Authorization: Bearer $RUCLOUD_DYNAMIC_TOKEN" --data-binary @app.tar.gz \
  "http://127.0.0.1:8799/apps/gen-42?message=v3"
# 刪除（purge=true 連資料一起刪）
curl -X DELETE -H "Authorization: Bearer $RUCLOUD_DYNAMIC_TOKEN" "http://127.0.0.1:8799/apps/gen-42?purge=true"
```

每個應用有自己的 Worker 程序、沙箱、D1 / KV / R2 / Durable Objects 與網域；啟動時套用 D1 migrations；重新啟動後還在。為了不碰到其他應用或伺服器，不能使用 services、queues、ai、analytics_engine_datasets、hyperdrive、workflows，`main`、`assets.directory`、`migrations_dir` 也必須在上傳的資料夾裡。`[dynamic] token` 只能管理 `prefix` 開頭的應用。

注意：

* 正式環境請讓這些應用用**另一個可註冊網域**（例如服務在 `example.com`、使用者的 app 在 `*.example-apps.com`），避免 `Domain=example.com` 的 cookie 互相影響。
* rucloud 沒有限制 Worker 的對外連線：產生的程式碼連得到這台機器上的其他服務（管理埠需要 token，其他服務請自己加上驗證或防火牆）。
* 沙箱是 Node 的權限模型，不是 VM。要跑可能惡意的程式碼，請再把整個 rucloud 放進容器或 VM。

### 持續複寫（建議正式環境開啟）

```toml
[replicate]
target = "s3://my-backups/rucloud/prod"        # 或 "file:///mnt/nas/rucloud"
endpoint = "https://<帳號>.r2.cloudflarestorage.com"   # AWS S3 可省略
region = "auto"
access_key_id = "…"
secret_access_key = "…"
interval = 10                                   # 秒：多久檢查一次變動
keep = 48                                       # 每個資料庫保留幾份快照
```

機器壞了，在另一台機器上：

```bash
rucloud replica status --config rucloud.toml
rucloud replica restore --config rucloud.toml                         # 最新的
rucloud replica restore --config rucloud.toml --at 2026-11-05T10:00:00Z  # 某個時間點（例如誤刪資料之前）
rucloud serve rucloud.toml
```

最多遺失最後一個 `interval` 的寫入；各資料庫分別快照（不是同一瞬間）；資料庫很大（幾 GB）時每次都送整份，請把 `interval` 調大。

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
CMD ["dev", "/srv/app", "--bind", "0.0.0.0", "--state", "/data", "--no-watch", "--instances", "4"]
```

## 4. 發佈到 crates.io

```bash
cargo publish --dry-run --target-dir target/publish-check   # 檢查打包內容（含 runtime/*.mjs）
cargo publish
```

`--dry-run` 一定要加獨立的 `--target-dir`：驗證建置會編譯打包後的副本，若和平常的建置共用 `target/`，會覆蓋 fingerprint，之後 `cargo build` 不會發現原始碼改過。

`Cargo.toml` 的 `include` 已經限定只打包 `src/`、`runtime/`、`README.md`、`LICENSE`。
