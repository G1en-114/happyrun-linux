#!/usr/bin/env bash
# 只读彩排：拉真打卡点、规划路线、校验打卡点覆盖，不上传不等待
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/happyrun/linux/start.sh" --dry "$@"
