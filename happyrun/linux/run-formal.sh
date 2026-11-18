#!/usr/bin/env bash
# 正式跑启动器（前台）：node auto-run.mjs 的输出实时显示，同时写入 formal-run.log
# 由 start.sh 调用；也可以直接用 ./start.sh 或 ./happyrun/linux/run-formal.sh
#
#   ./run-formal.sh                 智能配速（默认）
#   ./run-formal.sh --time=700      固定用时
#   ./run-formal.sh --dist=4.2      固定距离
#   ./run-formal.sh --dry           只读校验（不上传不等待）
set -uo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

cd "$HR_DIR" || die "无法进入 $HR_DIR"
hr_node_setup

DIST=0
TIME=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dist=*) DIST="${arg#*=}" ;;
    --time=*) TIME="${arg#*=}" ;;
    --dry|--dryRun|--dry-run) DRY=1 ;;
    *) die "未知参数: $arg（可用: --dist=3.2 --time=700 --dry）" ;;
  esac
done
case "$DIST" in ''|*[!0-9.]*) die "--dist 需要数字，例如 --dist=4.2" ;; esac
case "$TIME" in ''|*[!0-9]*) die "--time 需要整数秒，例如 --time=700" ;; esac

NODE_ARGS=(auto-run.mjs --type=formal --roadnet=roadnet.json)
if [ "$TIME" -gt 0 ] 2>/dev/null; then
  NODE_ARGS+=("--time=$TIME")
else
  NODE_ARGS+=("--time=0")
fi
if awk "BEGIN{exit !($DIST > 0)}"; then
  NODE_ARGS+=("--dist=$DIST")
fi
if [ "$DRY" -eq 1 ]; then
  NODE_ARGS+=("--dryRun=true")
fi

# 清空本次日志（watch.sh 从这里增量读取，跑步状态写在 formal-run.status.json）
: > formal-run.log

info "=== 正式跑启动（前台模式：Ctrl+C / 关闭终端 = 停止） ==="
"${HR_NODE[@]}" "${NODE_ARGS[@]}" 2>&1 | tee -a formal-run.log
rc=${PIPESTATUS[0]}

echo
if [ "$DRY" -eq 1 ]; then
  ok "=== 只读校验结束（未上传） ==="
else
  ok "=== 跑步进程已结束（./result.sh 查看台账） ==="
fi
exit "$rc"
