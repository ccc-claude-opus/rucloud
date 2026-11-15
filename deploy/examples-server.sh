#!/usr/bin/env bash
# 在一台 Linux 主機（例如 Linode 的 Ubuntu）上，用帳號 service 把 rucloud 與 examples/ 的應用都架起來。
# 用 root 執行一次：
#
#   curl -fsSL https://raw.githubusercontent.com/ccc-claude-opus/rucloud/main/deploy/examples-server.sh | sudo bash
#
# 做的事：
#   1. 安裝 rucloud 與 Node.js 24（用 install.sh，驗證 SHA-256）
#   2. 建立帳號 service（加入下面的 SSH 公鑰；能看 log、能 sudo 重開 rucloud，其他 root 權限都沒有）
#   3. 以 service 下載 repo 到 ~/rucloud，產生 ~/rucloud.toml 與各應用的密鑰（~/secrets，隨機產生）
#   4. 建立 systemd 服務 rucloud（以 service 執行，可以聽 80 埠）並啟動
#
# 還沒有網域時，用 sslip.io：每個應用在 http://<應用>.<IP 用 - 連接>.sslip.io/（例如 http://hello.139-162-90-34.sslip.io/），
# 也可以直接用 http://<IP>:<埠>/。有了網域之後，改 ~/rucloud.toml 的 [domain] base 並加上 [tls]（見最後的說明）。
# 再跑一次：更新 repo 與 rucloud、重新啟動；~/rucloud.toml、密鑰與資料不動。
set -euo pipefail

SVC=service
REPO_URL="https://github.com/ccc-claude-opus/rucloud.git"
RAW="https://raw.githubusercontent.com/ccc-claude-opus/rucloud/main"
# 管理用的 SSH 公鑰（Claude Code 用來登入 service 帳號部署、看 log）
SSH_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM/tJK2fVI+6hqudeo8d7DLYVIeVlYB0a6AjzYRBT1Ph claude-code rucloud service@linode"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '錯誤：%s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "請用 root 執行"
command -v apt-get >/dev/null || die "這個腳本是給 Debian / Ubuntu 用的"

say "安裝需要的套件"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates xz-utils openssl sudo >/dev/null

say "安裝 rucloud 與 Node.js"
if [ -n "${RUCLOUD_INSTALL_SH:-}" ]; then
  bash "$RUCLOUD_INSTALL_SH" --no-service   # 測試用：本機的 install.sh
else
  curl -fsSL "$RAW/install.sh" -o /tmp/rucloud-install.sh
  bash /tmp/rucloud-install.sh --no-service
  rm -f /tmp/rucloud-install.sh
fi

# ---------- 帳號 ----------
if ! id "$SVC" >/dev/null 2>&1; then
  say "建立帳號 $SVC"
  useradd --create-home --shell /bin/bash "$SVC"
fi
HOME_DIR="$(getent passwd "$SVC" | cut -d: -f6)"
install -d -m 700 -o "$SVC" -g "$SVC" "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
grep -qxF "$SSH_KEY" "$HOME_DIR/.ssh/authorized_keys" || echo "$SSH_KEY" >> "$HOME_DIR/.ssh/authorized_keys"
chown "$SVC:$SVC" "$HOME_DIR/.ssh/authorized_keys"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"
# 看 log：加入 systemd-journal 群組（不必 sudo）
getent group systemd-journal >/dev/null && usermod -aG systemd-journal "$SVC"
# sudo 只能做這兩件事，參數固定、不經過分頁程式（less 可以 !sh 開出 root 的 shell）
SYSTEMCTL="$(command -v systemctl || echo /usr/bin/systemctl)"
cat > /etc/sudoers.d/rucloud-service <<EOF
$SVC ALL=(root) NOPASSWD: $SYSTEMCTL restart rucloud, $SYSTEMCTL status rucloud --no-pager
EOF
chmod 440 /etc/sudoers.d/rucloud-service
if command -v visudo >/dev/null; then visudo -cf /etc/sudoers.d/rucloud-service >/dev/null || { rm -f /etc/sudoers.d/rucloud-service; die "sudoers 設定有誤"; }; fi

# ---------- repo ----------
as_svc() { su "$SVC" -s /bin/bash -c "$1"; }
if [ -d "$HOME_DIR/rucloud/.git" ]; then
  say "更新 ~/rucloud"
  as_svc "cd ~/rucloud && git pull --ff-only -q"
else
  say "下載 repo 到 ~/rucloud"
  as_svc "git clone -q --depth 1 $REPO_URL ~/rucloud"
fi

# ---------- 設定與密鑰 ----------
IP="${PUBLIC_IP:-$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}"
SSLIP="$(printf '%s' "$IP" | tr . -).sslip.io"
install -d -m 700 -o "$SVC" -g "$SVC" "$HOME_DIR/secrets" "$HOME_DIR/state"
secret() { openssl rand -hex 32; }
for app in myshop friendbook; do
  f="$HOME_DIR/secrets/$app.env"
  [ -f "$f" ] || printf 'AUTH_SECRET=%s\n' "$(secret)" > "$f"
done
f="$HOME_DIR/secrets/app-builder.env"
if [ ! -f "$f" ]; then
  {
    echo "AUTH_SECRET=$(secret)"
    echo "# 產生的 app 的網址；有網域之後改成 https://{name}.你的網域"
    echo "APPS_URL=http://{name}.$SSLIP"
    echo "# 選填：站方提供的 AI 金鑰；不填的話使用者要在網站的「AI 設定」填自己的"
    echo "NVIDIA_API_KEY="
    echo "MINIMAX_API_KEY="
  } > "$f"
fi
chown -R "$SVC:$SVC" "$HOME_DIR/secrets" "$HOME_DIR/state"
chmod 600 "$HOME_DIR"/secrets/*.env

CFG="$HOME_DIR/rucloud.toml"
if [ ! -f "$CFG" ]; then
  say "產生 ~/rucloud.toml"
  E="$HOME_DIR/rucloud/examples"
  cat > "$CFG" <<EOF
# rucloud：examples/ 的應用（由 deploy/examples-server.sh 產生，之後可以自己改）
# 改完：sudo systemctl restart rucloud
state_dir = "$HOME_DIR/state"
node = "/usr/local/bin/node"
bind = "0.0.0.0"

# 依網域分派：http://<應用>.$SSLIP/
[edge]
port = 80

# 還沒有網域時用 sslip.io（任何 *.$SSLIP 都解析到 $IP）。
# 有了網域：把 base 改成你的網域，DNS 設 A 記錄（網域與 *.網域 → $IP），再加上下面的 [tls]
[domain]
base = "$SSLIP"
root = "portal"

# [tls]
# port = 443
# redirect_http = true
# [tls.acme]
# email = ["你的信箱"]

# 管理 API 只聽本機：ssh 進來後用 rucloud deploy / tail；token 在 $HOME_DIR/state/admin-token
[admin]
port = 8799

# app-builder 產生的專案：http://gen-<id>.$SSLIP/
[dynamic]
grant = ["app-builder"]
memory_mb = 96

# 首頁：列出所有應用的連結（網域本身）
[[app]]
path = "$E/portal"

[[app]]
path = "$E/showcase"
port = 8710

[[app]]
path = "$E/hello"

[[app]]
path = "$E/myshop"
port = 8711
env_file = "$HOME_DIR/secrets/myshop.env"
d1_init = { DB = "schema.sql" }

[[app]]
path = "$E/friendbook"
port = 8712
env_file = "$HOME_DIR/secrets/friendbook.env"
d1_init = { DB = "schema.sql" }

[[app]]
path = "$E/chat"
port = 8713

[[app]]
path = "$E/markpedia"
port = 8714
d1_init = { DB = "schema.sql" }

[[app]]
path = "$E/map"
port = 8715
d1_init = { DB = "schema.sql" }

[[app]]
path = "$E/music"
port = 8716
d1_init = { DB = "schema.sql" }

[[app]]
path = "$E/app-builder"
port = 8717
env_file = "$HOME_DIR/secrets/app-builder.env"
d1_init = { DB = "schema.sql" }

[[app]]
path = "$E/boardgame"
port = 8718
EOF
  chown "$SVC:$SVC" "$CFG"
fi
as_svc "rucloud check $CFG" || die "設定有錯誤：$CFG"

# ---------- 服務 ----------
if [ ! -d /run/systemd/system ]; then
  say "這台機器沒有 systemd：請自己執行"
  echo "  su $SVC -c 'rucloud serve $CFG'"
  exit 0
fi
say "建立 systemd 服務 rucloud（以 $SVC 執行）"
cat > /etc/systemd/system/rucloud.service <<EOF
[Unit]
Description=rucloud (examples)
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC
Group=$SVC
WorkingDirectory=$HOME_DIR
ExecStart=/usr/local/bin/rucloud serve $CFG
Restart=always
RestartSec=2
TimeoutStopSec=45
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$HOME_DIR/state
PrivateTmp=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable rucloud >/dev/null
systemctl restart rucloud
for _ in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:8799/health && break; sleep 1; done
systemctl is-active --quiet rucloud || { journalctl -u rucloud -n 40 --no-pager; die "rucloud 沒有起來"; }

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  say "防火牆（ufw）：開 80、443、8710-8718"
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 8710:8718/tcp >/dev/null
fi

say "完成"
# 網址照 ~/rucloud.toml 實際的設定（可能已經換成自己的網域、開了 HTTPS）
BASE="$(sed -n 's/^base = "\(.*\)".*/\1/p' "$CFG" | head -1)"
BASE="${BASE:-$SSLIP}"
if grep -q '^\[tls\]' "$CFG"; then SCHEME=https; else SCHEME=http; fi
check() {
  if [ "$SCHEME" = https ]; then
    curl -sk -o /dev/null -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1/" || true
  else
    curl -s -o /dev/null -w '%{http_code}' -H "Host: $1" http://127.0.0.1/ || true
  fi
}
printf '  %-12s %-45s %s\n' 應用 網址 直接用埠號
for a in portal: showcase:8710 hello: myshop:8711 friendbook:8712 chat:8713 markpedia:8714 map:8715 music:8716 app-builder:8717 boardgame:8718; do
  n="${a%%:*}"; p="${a##*:}"
  printf '  %-12s %-45s %s  [%s]\n' "$n" "$SCHEME://$n.$BASE/" "${p:+http://$IP:$p/}" "$(check "$n.$BASE")"
done
echo
echo "  首頁（所有應用的連結）：$SCHEME://$BASE/"
echo "  log：journalctl -u rucloud -f（service 帳號也能看）；重開：sudo systemctl restart rucloud"
echo
free -m | sed 's/^/  /'
