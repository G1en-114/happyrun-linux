#!/usr/bin/env bash
# happyrun 登录抓包（Linux / macOS）
#
#   ./capture.sh                  普通代理模式（127.0.0.1:8080，不需要 root）
#   ./capture.sh --transparent    透明模式（nftables 重定向，需要 sudo；适合不认代理设置的客户端）
#   ./capture.sh --once           抓到登录态、config.json 被更新后自动退出
#   ./capture.sh --no-web         无 Web 界面（mitmdump）
#   ./capture.sh --host=xxx       指定要抓的域名（默认取 config.baseUrl 的 host）
#   ./capture.sh --dump           只打印透明模式将要添加的防火墙规则，不执行
#
# 成功标志：看到 “[login] 已写回 config.json”，或日志里出现 captured token。
set -uo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HR="$(cd -- "$HERE/.." && pwd)"          # happyrun/
ROOT="$(cd -- "$HR/.." && pwd)"          # 包根目录
ADDON="$HERE/happyrun-capture.py"
CONFIG="$HR/config.json"
USER_HOME="${HOME}"
CONFDIR="$USER_HOME/.mitmproxy"

MODE=proxy
ONCE=0
NO_WEB=0
BLOCK_QUIC=1
DUMP=0
PORT=8080
WEB_PORT=8081
HOST=""

for arg in "$@"; do
  case "$arg" in
    --transparent|-t) MODE=transparent ;;
    --proxy|-p) MODE=proxy ;;
    --once) ONCE=1 ;;
    --no-web) NO_WEB=1 ;;
    --dump) DUMP=1 ;;
    --no-block-quic) BLOCK_QUIC=0 ;;
    --port=*) PORT="${arg#*=}" ;;
    --web-port=*) WEB_PORT="${arg#*=}" ;;
    --host=*) HOST="${arg#*=}" ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  info() { printf '\033[36m%s\033[0m\n' "$*"; }
  warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
  die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
else
  info() { printf '%s\n' "$*"; }
  warn() { printf '%s\n' "$*" >&2; }
  die()  { printf '%s\n' "$*" >&2; exit 1; }
fi

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# ── 1. 默认抓哪个域名 ──
if [ -z "$HOST" ]; then
  if command -v node >/dev/null 2>&1 && [ -f "$CONFIG" ]; then
    HOST="$(node -e 'try{console.log(new URL(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).baseUrl).hostname)}catch{}' "$CONFIG" 2>/dev/null)"
  fi
  [ -n "$HOST" ] || HOST="tyxyzhpt.tyut.edu.cn"
fi
ALLOW="${HOST//./\\.}"

# ── 2. 解析目标域名 IP（透明模式按 IP 精确重定向）──
resolve_ips() {
  getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u
}
resolve_ips6() {
  getent ahostsv6 "$1" 2>/dev/null | awk '{print $1}' | grep -v '^::ffff:' | sort -u
}
IPS4="$(resolve_ips "$HOST")"
IPS6="$(resolve_ips6 "$HOST")"

if [ "$MODE" = transparent ] && [ "$DUMP" -eq 1 ]; then
  say "透明模式将添加以下 nftables 规则（OUTPUT 链，只匹配 $HOST 解析出的 IP）："
  for ip in $IPS4; do say "  ip  daddr $ip  tcp dport { 80, 443 }  redirect to :$PORT"; done
  for ip6 in $IPS6; do say "  ip6 daddr $ip6  tcp dport { 80, 443 }  redirect to :$PORT"; done
  [ "$BLOCK_QUIC" -eq 1 ] && for ip in $IPS4; do say "  ip  daddr $ip  udp dport 443  reject"; done
  say "  ip  skuid 0  accept   （root 自己的连接直通，避免代理环路）"
  exit 0
fi

# ── 3. 依赖检查 ──
command -v mitmdump >/dev/null 2>&1 || command -v mitmweb >/dev/null 2>&1 || {
  cat >&2 <<'EOF'
未找到 mitmproxy。安装方式（任选其一）：
  Arch Linux : sudo pacman -S mitmproxy
  通用       : python3 -m pip install --user mitmproxy
  或         : pipx install mitmproxy
EOF
  exit 1
}
[ -f "$ADDON" ] || die "找不到抓包插件: $ADDON"

# ── 4. 首次运行先生成 mitmproxy CA ──
if [ ! -f "$CONFDIR/mitmproxy-ca-cert.pem" ]; then
  info "首次运行，生成 mitmproxy CA…"
  timeout 8 mitmdump --listen-port 39081 -q >/dev/null 2>&1 || true
fi

# ── 5. 构造命令 ──
MP_CMD=mitmweb
[ "$NO_WEB" -eq 1 ] && MP_CMD=mitmdump
MP_ARGS=(
  -s "$ADDON"
  --allow-hosts "$ALLOW"
  --set happyrun_write_config=true
  --set happyrun_log=true
  --set happyrun_quiet=true
  --set termlog_verbosity=warn
  --listen-host 127.0.0.1
)
if [ "$NO_WEB" -eq 0 ]; then
  MP_ARGS+=(--web-port "$WEB_PORT" --no-web-open-browser)
else
  MP_ARGS+=(--flow-detail 0)
fi

if [ "$MODE" = transparent ]; then
  [ -n "$IPS4$IPS6" ] || die "无法解析 $HOST 的 IP，透明模式需要按 IP 重定向（可加 --host=你的学校域名）"
  [ "$(id -u)" -eq 0 ] || {
    command -v sudo >/dev/null 2>&1 || die "透明模式需要 root，但没找到 sudo"
    info "透明模式需要 root，正在提权…"
    exec sudo env HOME="$USER_HOME" PATH="$PATH" HR_FORCE_ROOT=1 bash "${BASH_SOURCE[0]}" "$@"
  }
  command -v nft >/dev/null 2>&1 || die "透明模式依赖 nftables（Arch: sudo pacman -S nftables）"
fi

# ── 6. 透明模式：nftables 只重定向目标学校 IP ──
cleanup_nft() {
  nft delete table ip happyrun_cap 2>/dev/null || true
  nft delete table ip6 happyrun_cap6 2>/dev/null || true
}

setup_nft() {
  cleanup_nft
  if [ -n "$IPS4" ]; then
    nft add table ip happyrun_cap || return 1
    nft 'add chain ip happyrun_cap out { type nat hook output priority -100; policy accept; }' || return 1
    nft add rule ip happyrun_cap out meta skuid 0 accept || return 1
    local ip
    for ip in $IPS4; do
      nft "add rule ip happyrun_cap out ip daddr $ip tcp dport { 80, 443 } redirect to :$PORT" || return 1
      if [ "$BLOCK_QUIC" -eq 1 ]; then
        nft "add rule ip happyrun_cap out ip daddr $ip udp dport 443 reject with icmp-port-unreachable" || return 1
      fi
    done
  fi
  if [ -n "$IPS6" ]; then
    nft add table ip6 happyrun_cap6 || return 1
    nft 'add chain ip6 happyrun_cap6 out { type nat hook output priority -100; policy accept; }' || return 1
    nft add rule ip6 happyrun_cap6 out meta skuid 0 accept || return 1
    local ip6
    for ip6 in $IPS6; do
      nft "add rule ip6 happyrun_cap6 out ip6 daddr $ip6 tcp dport { 80, 443 } redirect to :$PORT" || return 1
    done
  fi
}

MP_PID=""
cleanup() {
  [ -n "$MP_PID" ] && kill "$MP_PID" 2>/dev/null
  if [ "$MODE" = transparent ]; then
    cleanup_nft
  fi
}
trap cleanup EXIT INT TERM

# ── 7. 启动 ──
say ""
info "=== happyrun 登录抓包（$MODE 模式）==="
say "  目标站点 : $HOST"
say "  允许主机 : $ALLOW"
say "  插件     : $ADDON"
say "  CA 目录  : $CONFDIR"
say ""

if [ "$MODE" = transparent ]; then
  info "添加 nftables 重定向规则（只影响 $HOST 的 80/443）…"
  setup_nft || { cleanup_nft; die "nftables 规则添加失败（可能已存在同名表，可执行 sudo nft delete table ip happyrun_cap 后重试）"; }
  MP_ARGS+=(--mode "transparent" --listen-port "$PORT" --set "confdir=$CONFDIR")
  say "  规则已就绪，退出（Ctrl+C）时自动清理。"
else
  MP_ARGS+=(--mode "regular" --listen-port "$PORT")
  cat <<EOF
  把客户端代理指向 127.0.0.1:$PORT，例如：
      export http_proxy=http://127.0.0.1:$PORT https_proxy=http://127.0.0.1:$PORT
  或在浏览器 / 模拟器的网络设置里填 HTTP/HTTPS 代理 127.0.0.1:$PORT
EOF
fi
say ""
say "---- 接下来 ----"
say "1. 打开乐跑客户端（电脑微信小程序 / Android 模拟器 / 浏览器），完成登录"
say "2. 看到 [login] 已写回 config.json 即抓取成功"
say "3. Ctrl+C 退出；如还不打算马上跑，建议执行 ./install-ca.sh 让客户端信任 mitmproxy CA"
say ""

"$MP_CMD" "${MP_ARGS[@]}" &
MP_PID=$!

if [ "$ONCE" -eq 1 ]; then
  before="$(mtime "$CONFIG")"
  while kill -0 "$MP_PID" 2>/dev/null; do
    now="$(mtime "$CONFIG")"
    if [ "$now" != "0" ] && [ "$now" != "$before" ]; then
      say ""
      info "检测到 config.json 已更新（登录态已抓取），2 秒后停止抓包…"
      sleep 2
      kill "$MP_PID" 2>/dev/null
      break
    fi
    sleep 0.5
  done
fi

wait "$MP_PID" 2>/dev/null
MP_PID=""
say ""
say "抓包已退出。"
