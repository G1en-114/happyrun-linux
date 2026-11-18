#!/usr/bin/env bash
# 公共函数：定位目录、检测 node、彩色输出。被 start.sh / run-formal.sh 等 source。
# shellcheck shell=bash

HR_LINUX_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HR_DIR="$(cd -- "$HR_LINUX_DIR/.." && pwd)"   # .../happyrun
HR_ROOT="$(cd -- "$HR_DIR/.." && pwd)"        # 包根目录

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_GRAY=$'\033[90m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_GRAY=''
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s%s%s\n' "$C_CYAN" "$*" "$C_RESET"; }
ok()   { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

# node 检查 + 系统 CA 开关（学校服务器证书链不在 Node 内置 CA 里，必须 --use-system-ca）
hr_need_node() {
  command -v node >/dev/null 2>&1 || die "未找到 node。请先安装 Node.js ≥ 18（Arch: sudo pacman -S nodejs）"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 18 ] || die "Node.js 版本过低（当前 $(node -v)），需要 ≥ 18"
}

HR_NODE=(node)
hr_node_setup() {
  hr_need_node
  if node --use-system-ca -e '' >/dev/null 2>&1; then
    HR_NODE=(node --use-system-ca)
  else
    warn "当前 Node 不支持 --use-system-ca，将直接使用内置 CA（证书链不全时可能 TLS 失败）"
    HR_NODE=(node)
  fi
}
