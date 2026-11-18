#!/usr/bin/env bash
# 安装 mitmproxy CA 到系统信任库（抓包客户端需要）
set -uo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/happyrun/capture/install-ca.sh" "$@"
