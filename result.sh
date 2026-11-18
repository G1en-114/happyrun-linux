#!/usr/bin/env bash
# 结果与台账：上次运行日志尾部 + 当前账号的有效次数
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$ROOT/happyrun/linux/result.mjs" "$@"
