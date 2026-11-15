#!/usr/bin/env bash
# rucloud 安裝腳本（Linux：Debian / Ubuntu / Fedora / Alpine…，x86_64 或 arm64）
#
#   curl -fsSL https://raw.githubusercontent.com/ccc-claude-opus/rucloud/main/install.sh | sudo bash -s -- --domain example.com --email me@example.com
#
# 做的事：
#   1. 從 GitHub Releases 下載 rucloud（驗證 SHA-256），裝到 /usr/local/bin
#   2. 沒有 Node.js 22.15 以上就從 nodejs.org 下載 Node 24（驗證 SHA-256），裝到 /usr/local/lib/nodejs
#   3. 建立系統使用者 rucloud、/etc/rucloud/rucloud.toml（已經有就不動）、/var/lib/rucloud
#   4. 建立 systemd 服務並啟動（可以聽 80 / 443 埠，但不是 root）
# 再跑一次就是升級：換新的執行檔、重新啟動服務，設定與資料不動。
#
# 選項：
#   --domain 網域      產生的設定用這個網域（[domain]、自動憑證、管理介面 admin.<網域>）
#   --email 信箱       Let's Encrypt 的聯絡信箱
#   --version v1.7.0   指定版本（預設最新）
#   --no-service       只裝執行檔與 Node，不建立使用者與服務
#   --firewall         用 ufw 只開 22、80、443（ufw 有裝才會做）
#   --binary 檔案      用本機的 rucloud 執行檔，不下載（測試用）
#   --skip-node        不檢查、不安裝 Node.js（測試用）
set -euo pipefail

REPO="ccc-claude-opus/rucloud"
NODE_VERSION="24.22.3"
DOMAIN="" EMAIL="" VERSION="" SERVICE=1 FIREWALL=0 BINARY="" SKIP_NODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --firewall) FIREWALL=1; shift ;;
    --binary) BINARY="$2"; shift 2 ;;
    --skip-node) SKIP_NODE=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "不認識的選項：$1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '錯誤：%s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "需要 $1（例如 apt-get install -y $1）"; }

[ "$(uname -s)" = "Linux" ] || die "這個腳本只支援 Linux（macOS 請用 cargo install rucloud）"
[ "$(id -u)" -eq 0 ] || die "請用 root 執行（sudo bash install.sh …）"
case "$(uname -m)" in
  x86_64|amd64) TARGET="x86_64-unknown-linux-musl"; NODE_ARCH="x64" ;;
  aarch64|arm64) TARGET="aarch64-unknown-linux-musl"; NODE_ARCH="arm64" ;;
  *) die "不支援的 CPU：$(uname -m)" ;;
esac
if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$'; then
  die "網域格式不對：$DOMAIN"
fi
need tar
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------- 1. rucloud ----------
if [ -n "$BINARY" ]; then
  say "使用本機的執行檔 $BINARY"
  install -m 755 "$BINARY" /usr/local/bin/rucloud
else
  need curl
  if [ -z "$VERSION" ]; then
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4)"
    [ -n "$VERSION" ] || die "找不到最新版本（GitHub API 連不到？）"
  fi
  NAME="rucloud-$VERSION-$TARGET"
  say "下載 $NAME"
  curl -fsSL -o "$TMP/$NAME.tar.gz" "https://github.com/$REPO/releases/download/$VERSION/$NAME.tar.gz"
  curl -fsSL -o "$TMP/$NAME.tar.gz.sha256" "https://github.com/$REPO/releases/download/$VERSION/$NAME.tar.gz.sha256"
  [ "$(sha256 "$TMP/$NAME.tar.gz")" = "$(cut -d' ' -f1 "$TMP/$NAME.tar.gz.sha256")" ] || die "SHA-256 不符，停止安裝"
  tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP"
  install -m 755 "$TMP/$NAME/rucloud" /usr/local/bin/rucloud
fi
/usr/local/bin/rucloud --version

# ---------- 2. Node.js ----------
node_ok() {
  local v
  v="$(node --version 2>/dev/null | tr -d v)" || return 1
  [ -n "$v" ] || return 1
  local major="${v%%.*}" rest="${v#*.}"
  local minor="${rest%%.*}"
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 15 ]; }
}
NODE_BIN="$(command -v node || true)"
if [ "$SKIP_NODE" -eq 1 ]; then
  say "略過 Node.js"
elif node_ok; then
  say "Node.js $(node --version) 已經有了"
else
  need curl
  NODE_LIBC=""
  if [ -f /etc/alpine-release ]; then
    die "Alpine 請先用套件管理員安裝 Node.js 22.15 以上（apk add nodejs），再重跑這個腳本"
  fi
  NODE_NAME="node-v$NODE_VERSION-linux-$NODE_ARCH$NODE_LIBC"
  say "下載 Node.js $NODE_VERSION"
  curl -fsSL -o "$TMP/$NODE_NAME.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_NAME.tar.xz"
  curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  grep " $NODE_NAME.tar.xz\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1 > "$TMP/want"
  [ -s "$TMP/want" ] && [ "$(sha256 "$TMP/$NODE_NAME.tar.xz")" = "$(cat "$TMP/want")" ] || die "Node.js 的 SHA-256 不符，停止安裝"
  mkdir -p /usr/local/lib/nodejs
  rm -rf "/usr/local/lib/nodejs/$NODE_NAME"
  tar -xJf "$TMP/$NODE_NAME.tar.xz" -C /usr/local/lib/nodejs
  ln -sf "/usr/local/lib/nodejs/$NODE_NAME/bin/node" /usr/local/bin/node
  NODE_BIN=/usr/local/bin/node
  node --version
fi
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"

[ "$SERVICE" -eq 1 ] || { say "完成（--no-service：沒有建立服務）"; exit 0; }

# ---------- 3. 使用者、設定、資料夾 ----------
if ! id rucloud >/dev/null 2>&1; then
  say "建立系統使用者 rucloud"
  if command -v useradd >/dev/null; then
    useradd --system --home-dir /var/lib/rucloud --shell /usr/sbin/nologin rucloud
  else
    adduser -S -D -H -h /var/lib/rucloud -s /sbin/nologin rucloud
  fi
fi
mkdir -p /etc/rucloud /var/lib/rucloud
chown rucloud: /var/lib/rucloud
chmod 750 /var/lib/rucloud

if [ ! -f /etc/rucloud/rucloud.toml ]; then
  say "建立 /etc/rucloud/rucloud.toml"
  {
    echo '# rucloud 設定：https://github.com/'"$REPO"'/blob/main/doc/deploy.md'
    echo 'state_dir = "/var/lib/rucloud"'
    echo "node = \"$NODE_BIN\""
    echo
    echo '[edge]'
    echo 'port = 80'
    echo
    echo '# 管理 API：本機 http://127.0.0.1:8799；token 自動產生在 /var/lib/rucloud/admin-token'
    echo '[admin]'
    echo 'port = 8799'
    if [ -n "$DOMAIN" ]; then
      echo "host = \"admin.$DOMAIN\"           # 從自己的電腦 rucloud deploy --admin https://admin.$DOMAIN"
      echo
      echo "# 每個應用自動有 <名稱>.$DOMAIN；DNS 請把 $DOMAIN 與 *.$DOMAIN 的 A 記錄指到這台機器"
      echo '[domain]'
      echo "base = \"$DOMAIN\""
      echo
      echo '# HTTPS：Let'"'"'s Encrypt 自動申請、續期'
      echo '[tls]'
      echo 'port = 443'
      echo 'redirect_http = true'
      echo '[tls.acme]'
      if [ -n "$EMAIL" ]; then echo "email = [\"$EMAIL\"]"; fi
      echo '# 萬用字元憑證（應用很多時建議）：'
      echo '# dns = { provider = "cloudflare" }   # 或 "linode"；token 放在 /etc/rucloud/env 的 CLOUDFLARE_API_TOKEN / LINODE_TOKEN'
    fi
    echo
    echo '# 用 rucloud deploy 部署的應用會自動新增，不必寫在這裡'
  } > /etc/rucloud/rucloud.toml
  chmod 644 /etc/rucloud/rucloud.toml
fi
[ -f /etc/rucloud/env ] || { : > /etc/rucloud/env; chmod 600 /etc/rucloud/env; }
/usr/local/bin/rucloud check /etc/rucloud/rucloud.toml || die "設定有錯誤，請修改 /etc/rucloud/rucloud.toml 後重跑"

# ---------- 4. systemd 服務 ----------
if [ ! -d /run/systemd/system ]; then
  say "這台機器沒有 systemd：請自己用程序管理器執行"
  echo "  sudo -u rucloud /usr/local/bin/rucloud serve /etc/rucloud/rucloud.toml"
  exit 0
fi
say "建立 systemd 服務 rucloud"
cat > /etc/systemd/system/rucloud.service <<'UNIT'
[Unit]
Description=rucloud
Documentation=https://github.com/ccc-claude-opus/rucloud
After=network-online.target
Wants=network-online.target

[Service]
User=rucloud
Group=rucloud
EnvironmentFile=-/etc/rucloud/env
ExecStart=/usr/local/bin/rucloud serve /etc/rucloud/rucloud.toml
Restart=always
RestartSec=2
# 收到 SIGTERM 後讓進行中的請求做完（rucloud.toml 的 shutdown_timeout 預設 30 秒）
TimeoutStopSec=45
# 不是 root 也能聽 80 / 443
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/rucloud
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable rucloud >/dev/null
systemctl restart rucloud
sleep 2
systemctl is-active --quiet rucloud || { journalctl -u rucloud -n 30 --no-pager; die "rucloud 沒有起來"; }

if [ "$FIREWALL" -eq 1 ] && command -v ufw >/dev/null; then
  say "防火牆：只開 22、80、443"
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

say "完成！rucloud $(/usr/local/bin/rucloud --version | cut -d' ' -f2) 正在執行"
echo "  設定：/etc/rucloud/rucloud.toml（改完 sudo systemctl restart rucloud）"
echo "  log ：journalctl -u rucloud -f"
if [ -n "$DOMAIN" ]; then
  echo
  echo "  1. DNS：$DOMAIN 與 *.$DOMAIN 的 A 記錄指到這台機器的 IP"
  echo "  2. 在自己的電腦上："
  echo "       export RUCLOUD_ADMIN_TOKEN=\$(ssh 這台機器 sudo cat /var/lib/rucloud/admin-token)"
  echo "       rucloud deploy ./my-app --admin https://admin.$DOMAIN"
  echo "     就會在 https://my-app.$DOMAIN/ 上線"
fi
