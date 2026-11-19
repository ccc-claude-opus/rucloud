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

像 `wrangler deploy` 一樣，從自己的電腦部署到主機。主機上沒有這個應用就自動新增（不必改 `rucloud.toml`、不必重新啟動），有了就部署新版本：

```toml
[admin]
host = "admin.example.com"       # 管理 API 透過 HTTPS 用這個網域對外（需要 [tls]，憑證自動申請）
# token 不設就自動產生在 <state_dir>/admin-token
```

```bash
export RUCLOUD_ADMIN_TOKEN=…              # 主機上 <state_dir>/admin-token 的內容
rucloud deploy ./myshop -m "新增報表" --admin https://admin.example.com
#   已新增應用 myshop，版本 20261115-…
#     https://myshop.example.com/         （[domain] 的子網域、wrangler routes 的網域）
echo -n "sk-…" | rucloud secret put myshop OPENAI_API_KEY --admin https://admin.example.com
rucloud secret list myshop                # 只列名稱，值讀不回來
rucloud delete myshop --purge             # 刪除部署時新增的應用（--purge 連資料一起刪）
rucloud versions myshop                   # * 是目前的版本
rucloud rollback myshop                   # 回到上一版
rucloud rollback myshop --to path         # 回到 rucloud.toml 的 path
rucloud reload myshop                     # 改了 .dev.vars / env_file 之後
```

* 打包時不含 `.dev.vars`、`.env*`、`.git`、`.wrangler`；`node_modules` 會一起上傳。密鑰請用 `rucloud secret put`（存在主機的 `<state_dir>/<應用>/secrets.json`，權限 600，蓋過 `.dev.vars` 與 `env_file`；設定後應用自動重新載入）。
* 部署時新增的應用和 `rucloud.toml` 裡的一樣能用所有綁定（它是你自己的程式碼）；重新啟動後還在（`<state_dir>/managed.json`）。要限制綁定、資源的「替使用者跑程式碼」請用下面的 `[dynamic]`。
* 管理 API 只在 `[admin] host` 的 HTTPS 上對外；edge 的 HTTP 埠不提供，token 不會明文傳送。
* 切換不停機：新版本的 Worker 全部起來才換上；起不來就維持原本的版本並回報錯誤。
* 換版的瞬間新舊程序會短暫並存：同一個 Durable Object 在舊程序裡還沒做完的事件，可能和新程序的事件重疊。

### 執行中新增應用（`[dynamic]`）

要「替使用者執行程式碼」（例如 [apps/app-builder](../apps/app-builder) 把 AI 產生的專案跑起來）時，不要在自己的 Worker 裡用 `new Function` 執行：同一個程序裡，別人的程式碼讀得到你的 `env`、改得掉 `crypto` / `fetch`。改成讓每個使用者的專案在 rucloud 裡各自是一個應用：

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

### 安裝的應用（`[install]`）

像手機的 App：程式碼由一個「安裝程式」應用取得、檢查、徵得使用者同意後交給 rucloud，用**應用自己的名稱**（`<名稱>.<網域>`）執行。和 `[dynamic]` 一樣是不可信的程式碼（自己的程序、沙箱與資料，套件裡不能宣告 services、analytics_engine_datasets、hyperdrive（`[dynamic]` 另外不能用 queues、workflows、send_email、ai），不採用 wrangler 的 routes），差別是：

* 名稱沒有前綴，但不能用 rucloud.toml 或部署時新增的應用已經用掉的名稱。
* 權限由安裝程式另外給，存在 `<state_dir>/<應用>/grants.json`：
  * **service binding**：只能綁定到 `services` 列出的應用，`props` 告訴目標應用是誰、什麼權限（目標在 `ctx.props` 讀到，呼叫端偽造不了）。
  * **對外連線**（`network`）：預設關，關的時候 Worker 的 `fetch`、`WebSocket` 都會丟錯。開了也**只能連網際網路上的位址**：連線前先查 DNS，本機（`localhost`、`*.localhost`、127.0.0.0/8、::1）、私有網路（10/8、172.16/12、192.168/16、fc00::/7）、CGNAT、連結本地位址都擋下，免得繞過權限直接呼叫這台機器上的其他應用。`cloudflare:sockets` 與 Node 的網路模組（`node:net`、`node:http`…）一律不開放。rucloud 自己的綁定不受影響。這是在執行環境裡擋，不是作業系統層級的隔離。
* **寄信**（`email`）：預設關；開了 Worker 才能用套件宣告的 `send_email` 綁定，而且仍然只能寄給寄信設定（`[email]`、管理 API 的 `/email`）裡驗證過的收件地址，見 [bindings.md](bindings.md#寄信send_email)。
* **AI**（`ai`）：預設關；開了 Worker 才能用套件宣告的 `ai` 綁定，用的是 `[ai]` 設定的後端，有每個應用每天的上限，見 [bindings.md](bindings.md#workers-ai)。
* 可以用 **Queues** 與 **Workflows**：佇列名稱在 rucloud 裡是全機共用的，安裝的應用的佇列會自動加上應用名稱前綴（套件裡寫 `tasks`，實際是 `<應用>:tasks`，包括 R2 事件通知與 dead letter queue），所以只碰得到自己的佇列；workflow 本來就是每個應用一份。移除應用並刪除資料（`purge`）時，它佇列裡還沒處理的訊息一起刪掉。

```toml
[install]
grant = ["installer"]          # 這些應用的 env 有 RUCLOUD_ADMIN_URL、RUCLOUD_INSTALL_TOKEN
services = ["files", "photos"] # 安裝的應用可以被綁定到哪些應用
max_apps = 200
memory_mb = 256
```

```bash
# 安裝或更新（body 是應用資料夾的 tar.gz）；新安裝的應用沒有任何權限
curl -X PUT -H "Authorization: Bearer $RUCLOUD_INSTALL_TOKEN" --data-binary @notes.tar.gz "$RUCLOUD_ADMIN_URL/apps/notes?message=1.2.0"
# 給權限（之後自動重新載入）
curl -X PUT -H "Authorization: Bearer $RUCLOUD_INSTALL_TOKEN" -H "content-type: application/json" \
  -d '{"services":[{"binding":"FILES","service":"files","props":{"app":"notes","perms":["files:read"]}}],"network":false}' \
  "$RUCLOUD_ADMIN_URL/apps/notes/grants"
curl -H "Authorization: Bearer $RUCLOUD_INSTALL_TOKEN" "$RUCLOUD_ADMIN_URL/apps/notes/grants"
# 回到上一版、移除（purge=true 連資料一起刪）
curl -X POST -H "Authorization: Bearer $RUCLOUD_INSTALL_TOKEN" "$RUCLOUD_ADMIN_URL/apps/notes/rollback"
curl -X DELETE -H "Authorization: Bearer $RUCLOUD_INSTALL_TOKEN" "$RUCLOUD_ADMIN_URL/apps/notes?purge=true"
```

`[install]` 的 token 只能做這些事（加上 `GET /apps` 列出應用、看安裝的應用的 versions 與 logs）；重新安裝已移除（保留資料）的應用時，舊的權限不沿用。

### 作業系統層級的隔離（`[isolation]`）

`[install]`、`[dynamic]` 的應用是不可信的程式碼。Node 的權限模型（`sandbox`）擋得住一般的程式，但 Node 官方說明它不是擋惡意程式碼的安全邊界。在 Linux 上，rucloud 會把這些應用的 Worker 程序再放進 [bubblewrap](https://github.com/containers/bubblewrap)（`bwrap`）的籠子：

| 限制 | 做法 |
|---|---|
| 檔案 | 自己的 mount namespace：只看得到系統的 `/usr`、`/lib`、rucloud 的執行環境、應用自己的程式碼（唯讀）與 Durable Object 資料夾（可寫），`/tmp` 是有大小上限的 tmpfs。別的應用的資料、`rucloud.toml`、`/etc/passwd` 都不存在 |
| 網路 | 自己的 network namespace：只有自己的 `lo`。和 rucloud 之間只靠 Unix socket（綁定 API、這個程序池的資料夾）；連外經過 rucloud 的**出口代理**（`HTTP(S)_PROXY`），在籠子外面查 DNS，本機、私有網路、CGNAT、連結本地位址一律拒絕。沒有 `network` 權限的安裝應用沒有出口代理 |
| 程序 | 自己的 pid、ipc、uts namespace；`--cap-drop ALL`、`--die-with-parent`、`--new-session` |
| 使用者 | rucloud 是 root 時，Worker 先換成 `user`（預設 `rucloud-worker`，要先 `useradd -r rucloud-worker`） |
| 資源 | 有 cgroup v2 時每個應用一個 cgroup（rucloud 自己的 cgroup 底下的 `workers/<應用>`）：記憶體（`memory_mb`）、CPU、程序數上限。systemd 的服務要加 `Delegate=yes` |

```toml
[isolation]
mode = "auto"        # auto（預設：有 bwrap 就用，用不了只發警告；rucloud dev 不用）、on（用不了就不啟動）、off
user = "rucloud-worker"
cpu = 0.5            # 每個應用最多幾顆 CPU
pids = 64            # 每個 Worker 程序最多幾個程序／執行緒
tmp_mb = 64          # 籠子裡的 /tmp
```

`rucloud.toml` 裡的應用也可以加 `isolate = true` 放進籠子（籠子裡連不到本機的其他服務，需要的應用不要開）。這一層是 Linux 的 namespace，共用同一個核心，擋不住核心本身的漏洞。

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

## 3. 新主機（Linode、DigitalOcean、Hetzner…）

目標：一台新的 Linux 主機加一個網域，幾分鐘後就能像 Cloudflare 一樣 `rucloud deploy`，應用自動有 `https://<名稱>.example.com`。

1. **DNS**（只做一次）：`example.com` 與 `*.example.com` 的 A 記錄指到主機的 IP。
2. **安裝**（在主機上）：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/ccc-claude-opus/rucloud/main/install.sh | sudo bash -s -- --domain example.com --email me@example.com
   ```

   會下載 rucloud（GitHub Releases，驗證 SHA-256）、沒有的話裝 Node.js 24、建立系統使用者 `rucloud`、`/etc/rucloud/rucloud.toml`（`[domain]`、`[tls]` 自動憑證、`[admin] host = "admin.example.com"`）、`/var/lib/rucloud`，以及 systemd 服務（非 root 也能聽 80 / 443）。加 `--firewall` 會用 ufw 只開 22、80、443。再跑一次就是升級，設定與資料不動。

3. **部署**（在自己的電腦上）：

   ```bash
   export RUCLOUD_ADMIN_TOKEN=$(ssh 主機 sudo cat /var/lib/rucloud/admin-token)
   rucloud deploy ./my-app --admin https://admin.example.com
   #   https://my-app.example.com/
   ```

### 萬用字元憑證

預設每個網域各申請一張憑證（TLS-ALPN-01，不需要 DNS API）。Let's Encrypt 對同一個主網域每週發的憑證數量有上限，應用很多（例如 `[dynamic]`）時改用萬用字元憑證：一張 `*.example.com` 涵蓋所有子網域。需要 DNS 供應商的 API（DNS-01 驗證）：

```toml
[tls.acme]
email = ["me@example.com"]
dns = { provider = "cloudflare" }     # 或 "linode"
# wildcard = ["example.com"]          # 不寫就用 [domain] 的 base
# propagation_seconds = 30            # 建立 TXT 記錄後等 DNS 生效的秒數；Linode 可能要調長
```

API token 放在 `/etc/rucloud/env`（權限 600，systemd 會讀）：

```bash
CLOUDFLARE_API_TOKEN=…     # Cloudflare：Zone → DNS → Edit 權限
LINODE_TOKEN=…             # Linode：Domains 讀寫權限
```

### 前面再套 Cloudflare 的代理

一台主機沒有全球節點、DDoS 防護與 CDN。需要的話把 DNS 開成 Cloudflare 的代理（橘色雲朵），並在 `rucloud.toml` 加上：

```toml
trusted_proxies = ["127.0.0.1", "cloudflare"]
```

Worker 看到的 `cf-connecting-ip` 就是真實的使用者 IP。Cloudflare 的 SSL 模式請用「Full (strict)」（rucloud 上有 Let's Encrypt 的正式憑證）。

## 4. Docker

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

## 5. 發佈到 crates.io

```bash
cargo publish --dry-run --target-dir target/publish-check   # 檢查打包內容（含 runtime/*.mjs）
cargo publish
```

`--dry-run` 一定要加獨立的 `--target-dir`：驗證建置會編譯打包後的副本，若和平常的建置共用 `target/`，會覆蓋 fingerprint，之後 `cargo build` 不會發現原始碼改過。

`Cargo.toml` 的 `include` 已經限定只打包 `src/`、`runtime/`、`README.md`、`LICENSE`。
