#!/usr/bin/env bash
# 把 mitmproxy 根证书装进系统信任库（Linux 抓包必需；只影响本机抓包，可随时移除）
#
#   ./install-ca.sh          安装/更新
#   ./install-ca.sh --remove 从系统信任库移除（按指纹模糊匹配 happyrun 装的证书）
#
# 说明：抓包客户端（微信小程序 / 模拟器 / 浏览器）不信任 mitmproxy CA 时，
# 表现为一直加载、TLS 报错。装完重启客户端即可。
# 注意：Chrome/Electron 类客户端还可能需要 NSS 数据库（脚本会自动尝试）。
set -uo pipefail

PEM="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
CRT_NAME="happyrun-mitmproxy.crt"

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

REMOVE=0
[ "${1:-}" = "--remove" ] && REMOVE=1

if [ ! -f "$PEM" ]; then
  command -v mitmdump >/dev/null 2>&1 || die "未安装 mitmproxy，先装 mitmproxy 再执行本脚本"
  info "生成 mitmproxy CA（首次需要）…"
  timeout 8 mitmdump --listen-port 39081 -q >/dev/null 2>&1 || true
fi
[ -f "$PEM" ] || die "仍未找到 $PEM，请先运行一次 ./capture.sh"

if [ "$REMOVE" -eq 1 ]; then
  if command -v trust >/dev/null 2>&1; then
    sudo trust anchor --remove "$PEM" 2>/dev/null || sudo trust anchor --remove "$CRT_NAME" 2>/dev/null || true
  fi
  [ -f "/usr/local/share/ca-certificates/$CRT_NAME" ] && sudo rm -f "/usr/local/share/ca-certificates/$CRT_NAME" && sudo update-ca-certificates --fresh >/dev/null
  [ -f "/etc/pki/ca-trust/source/anchors/$CRT_NAME" ] && sudo rm -f "/etc/pki/ca-trust/source/anchors/$CRT_NAME" && sudo update-ca-trust
  if command -v certutil >/dev/null 2>&1 && [ -d "$HOME/.pki/nssdb" ]; then
    certutil -d "sql:$HOME/.pki/nssdb" -D -n "happyrun mitmproxy" 2>/dev/null || true
  fi
  say "已尝试移除 mitmproxy CA。"
  exit 0
fi

say ""
info "=== 安装 mitmproxy CA ==="
say "证书: $PEM"
say ""

if command -v trust >/dev/null 2>&1; then
  # Arch / Fedora 等使用 p11-kit trust 的系统
  info "使用 trust anchor（p11-kit）…"
  sudo trust anchor --store "$PEM" || die "trust anchor 安装失败"
elif command -v update-ca-certificates >/dev/null 2>&1; then
  # Debian / Ubuntu
  info "使用 update-ca-certificates…"
  sudo cp "$PEM" "/usr/local/share/ca-certificates/$CRT_NAME"
  sudo update-ca-certificates || die "update-ca-certificates 失败"
elif command -v update-ca-trust >/dev/null 2>&1; then
  # Fedora / RHEL
  info "使用 update-ca-trust…"
  sudo cp "$PEM" "/etc/pki/ca-trust/source/anchors/$CRT_NAME"
  sudo update-ca-trust || die "update-ca-trust 失败"
else
  die "没有找到系统证书管理工具（trust / update-ca-certificates / update-ca-trust）"
fi

# Chrome / Electron 类客户端使用 NSS 数据库
if command -v certutil >/dev/null 2>&1; then
  if [ -d "$HOME/.pki/nssdb" ]; then
    info "导入 NSS 数据库（Chrome/Electron 客户端）…"
    certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n "happyrun mitmproxy" -i "$PEM" 2>/dev/null || true
  fi
else
  warn "未找到 certutil（libnss3-tools），Chrome/Electron 类客户端如仍报证书错误可手动导入 NSS。"
fi

say ""
info "完成。请重启被抓包的客户端，再试一次登录。"
say "移除：./install-ca.sh --remove"
