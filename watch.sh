#!/usr/bin/env bash
# 实时进度：进度条 / 当前配速 / 剩余时间 / 预计完成时刻，跑完自动出结果
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$ROOT/happyrun/linux/watch.mjs" "$@"
