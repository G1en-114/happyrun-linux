#!/usr/bin/env bash
# 登录抓包：把乐跑登录态写进 happyrun/config.json
#   ./capture.sh                普通代理模式（127.0.0.1:8080）
#   ./capture.sh --transparent  透明模式（nftables，需要 sudo）
#   ./capture.sh --once         抓到登录态后自动退出
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/happyrun/capture/linux-capture.sh" "$@"
