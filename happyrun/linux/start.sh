#!/usr/bin/env bash
# happyrun 一键主入口（Linux/macOS）：
#   [1/3] token 探活 → [2/3] 失效则拉起登录抓包并等待 → [3/3] 正式跑
#
#   ./start.sh                    3km 智能配速（默认）
#   ./start.sh --dry              只读校验，不上传不等待
#   ./start.sh --time=700         固定用时 700s
#   ./start.sh --dist=4.2         锁定距离 4.2km
#   ./start.sh --capture          登录失效时直接在后台启动抓包（需要能免密/交互 sudo）
#
# 每次跑步的日志：happyrun/formal-run.log
# 实时进度：./watch.sh     结果/台账：./result.sh
set -uo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

cd "$HR_DIR" || die "无法进入 $HR_DIR"
hr_node_setup

DIST=0
TIME=0
DRY=0
AUTO_CAPTURE=0
for arg in "$@"; do
  case "$arg" in
    --dist=*) DIST="${arg#*=}" ;;
    --time=*) TIME="${arg#*=}" ;;
    --dry|--dryRun|--dry-run) DRY=1 ;;
    --capture) AUTO_CAPTURE=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数: $arg" ;;
  esac
done
case "$DIST" in ''|*[!0-9.]*) die "--dist 需要数字，例如 --dist=4.2" ;; esac
case "$TIME" in ''|*[!0-9]*) die "--time 需要整数秒，例如 --time=700" ;; esac

probe_ok() {
  local out
  out="$("${HR_NODE[@]}" probe.mjs 2>&1 || true)"
  [ -n "$out" ] && ! printf '%s' "$out" | grep -q 'FAILED'
}

launch_capture_window() {
  [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || return 1
  local inner t
  inner="cd $(printf '%q' "$HR_ROOT") && ./capture.sh --once"
  for t in gnome-terminal konsole xfce4-terminal x-terminal-emulator kitty alacritty wezterm foot xterm; do
    command -v "$t" >/dev/null 2>&1 || continue
    case "$t" in
      gnome-terminal) nohup "$t" -- bash -lc "$inner" >/dev/null 2>&1 & ;;
      wezterm)        nohup "$t" start -- bash -lc "$inner" >/dev/null 2>&1 & ;;
      *)              nohup "$t" -e bash -lc "$inner" >/dev/null 2>&1 & ;;
    esac
    disown 2>/dev/null || true
    return 0
  done
  return 1
}

# ── [1/3] 登录态探活 ──
info "=== [1/3] 检查登录态 ==="
need_login=1
if probe_ok; then
  need_login=0
  ok "登录态有效"
else
  warn "登录态无效或 config.json 不存在"
fi

# ── [2/3] 失效则拉起抓包并等待 ──
if [ "$need_login" -eq 1 ]; then
  say ""
  say "${C_BOLD}>>> 需要在乐跑客户端里登录一次，把 token 写进 happyrun/config.json <<<${C_RESET}"
  say "    1) 另一个终端窗口会启动 mitmproxy 抓包（首次会要 sudo 密码）"
  say "    2) 在客户端（电脑微信小程序 / 模拟器 / 浏览器）里完成乐跑登录"
  say "    3) 看到 [login] 已写回 config.json 后本窗口自动继续"
  say ""

  launched=0
  if [ "$AUTO_CAPTURE" -eq 1 ]; then
    ./capture.sh --once >/tmp/happyrun-capture.log 2>&1 &
    launched=$!
    say "抓包已在后台启动（PID $launched，日志 /tmp/happyrun-capture.log）"
  elif launch_capture_window; then
    say "已在新终端窗口启动抓包。"
  else
    warn "没有可用的图形终端，请手动在另一个终端里执行：${C_BOLD}./capture.sh --once${C_RESET}"
  fi

  deadline=$(( $(date +%s) + 600 ))
  while :; do
    sleep 6
    if probe_ok; then
      ok "新登录态已就位"
      break
    fi
    left=$(( deadline - $(date +%s) ))
    if [ "$left" -le 0 ]; then
      warn "10 分钟内未等到新登录态。请手动完成 ./capture.sh 后重跑 ./start.sh"
      exit 1
    fi
    printf '  ... 等待登录中，剩余 %3ds（完成登录后会自动继续）\r' "$left"
  done
  printf '\n'
fi

# ── [3/3] 正式跑 ──
say ""
info "=== [3/3] 启动正式跑${DRY:+（只读校验）} ==="
if [ "$TIME" -ge 900 ] 2>/dev/null; then
  warn "本次需真实等待约 $((TIME / 60)) 分钟，token 可能过期；"
  warn "跑完前 3~5 分钟可再执行一次 ./capture.sh --once 刷新 token（提交时会自动采用）。"
fi

RUN_ARGS=(--dist="$DIST" --time="$TIME")
[ "$DRY" -eq 1 ] && RUN_ARGS+=(--dry)
exec "$HR_LINUX_DIR/run-formal.sh" "${RUN_ARGS[@]}"
