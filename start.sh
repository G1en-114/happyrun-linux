#!/usr/bin/env bash
# 一键正式跑：探活 → 失效则抓包等待 → 启动跑步（默认 3km 智能配速）
# 用法见 ./start.sh --help
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/happyrun/linux/start.sh" "$@"
