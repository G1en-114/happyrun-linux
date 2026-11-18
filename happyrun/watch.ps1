<#
.SYNOPSIS
  happyrun 实时状态查看器：跑步进行时实时显示进度/配速/预计完成时间，结束后自动报结果

.DESCRIPTION
  读取 auto-run.mjs 每秒写入的 formal-run.status.json + formal-run.log（UTF-8，中文不乱码）：
    - 实时进度条：已跑距离 / 计划距离 / 百分比
    - 当前配速（模拟投影，收尾值 = 计划平均配速）与计划平均配速
    - 距离完成剩余时间 + 预计完成时刻（含上传，误差 ±15s）
    - 后台日志新行实时滚动打印
    - 跑步进程结束 → 自动打印最终结果并退出（不影响后台进程）
  换账号说明：重新抓包后直接 start.ps1 即可，旧进程会被自动接管，台账按账号分文件。

.PARAMETER RefreshSec  刷新间隔秒，默认 2
.PARAMETER Once        只显示一帧就退出（不看完整过程）

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File happyrun\watch.ps1
#>
param(
  [int]$RefreshSec = 2,
  [switch]$Once
)

$ErrorActionPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogPath = Join-Path $root "formal-run.log"
$StatusPath = Join-Path $root "formal-run.status.json"
$script:seen = 0

function Fmt-Pace([double]$s) {
  if ($s -le 0) { return "--'--`"" }
  $t = [int][math]::Round($s)
  return "{0}'{1:d2}`"" -f [int][math]::Floor($t / 60), ($t % 60)
}

function Read-Status {
  if (Test-Path $StatusPath) {
    try { return Get-Content $StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  }
  return $null
}

function Print-NewLog {
  if (-not (Test-Path $LogPath)) { return }
  $lines = @(Get-Content $LogPath -Encoding UTF8)
  if ($lines.Count -gt $script:seen) {
    for ($i = $script:seen; $i -lt $lines.Count; $i++) { Write-Host $lines[$i] }
    $script:seen = $lines.Count
  }
}

function Show-Final {
  Write-Host ""
  Write-Host "════════════ 跑步已结束 · 最终结果 ════════════" -ForegroundColor Green
  Print-NewLog
  if (Test-Path $LogPath) {
    Get-Content $LogPath -Tail 12 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
  }
  # 当前账号的台账最后一条
  $st = Read-Status
  $acc = "default"
  if ($st -and $st.account) { $acc = $st.account }
  else {
    try {
      $cfg = Get-Content (Join-Path $root "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.student_num) { $acc = [string]$cfg.student_num } elseif ($cfg.uid) { $acc = [string]$cfg.uid }
    } catch {}
  }
  $hf = Join-Path $root ("run-history-{0}.jsonl" -f $acc)
  if (Test-Path $hf) {
    $last = Get-Content $hf -Encoding UTF8 | Select-Object -Last 1
    Write-Host ("台账最后一条（账号 {0}）: {1}" -f $acc, $last) -ForegroundColor Cyan
  }
  Write-Host "查看完整过程: powershell -File result.ps1" -ForegroundColor DarkGray
}

Write-Host "=== happyrun 实时状态（Ctrl+C 退出本界面，不影响后台跑步）===" -ForegroundColor Cyan
Print-NewLog

# ── 实时轨迹图：后台启动渲染服务，但不自动打开浏览器 ──
# 用户想看轨迹时自己访问: http://127.0.0.1:8947/  (按 O 键打开)
try {
  $liveProc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'live-serve\.mjs' }
  if (-not $liveProc) {
    Start-Process node -ArgumentList @((Join-Path $root "tools\live-serve.mjs")) -WindowStyle Hidden
    Start-Sleep -Milliseconds 900
  }
  Write-Host "实时轨迹图(想看时点开): http://127.0.0.1:8947/" -ForegroundColor DarkCyan
} catch { Write-Host "实时轨迹图服务启动失败(不影响进度显示): $_" -ForegroundColor DarkYellow }

while ($true) {

  $st = Read-Status
  $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
  $alive = $false
  if ($st -and $st.pid) {
    $alive = [bool](Get-Process -Id $st.pid -ErrorAction SilentlyContinue)
  }

  if ($st -and $alive) {
    $pct = 0
    switch ("$($st.phase)") {
      "running" { if ($st.totalS) { $pct = [int][math]::Min(98, 100 * $st.elapsedS / $st.totalS) } }
      "uploading" { $pct = 99 }
      "finishing" { $pct = 99 }
      "done" { $pct = 100 }
      default { $pct = 5 }
    }
    $remStr = "--"
    $etaStr = "--:--:--"
    if ($st.runEtaEpoch) {
      $rem = [int]($st.runEtaEpoch - $now)
      if ($rem -lt 0) { $rem = 0 }
      $remStr = "{0:d2}:{1:d2}" -f [int][math]::Floor($rem / 60), ($rem % 60)
      $etaStr = [DateTimeOffset]::FromUnixTimeSeconds([int64]$st.runEtaEpoch).LocalDateTime.ToString("HH:mm:ss")
    }
    $curPace = Fmt-Pace ([double]$st.curPaceS)
    Write-Progress -Activity "happyrun 跑步进行中（账号 $($st.account)）" `
      -Status ("阶段 {0} | 进度 {1}km / {2}km ({3}%) | 当前配速 {4}/km (计划 {5}) | 距跑完 {6} | 预计 {7} 完成" -f `
        $st.phase, $st.simKm, $st.targetKm, $pct, $curPace, $st.plannedPace, $remStr, $etaStr) `
      -PercentComplete $pct
  }
  elseif ($st -and -not $alive) {
    Write-Progress -Activity "happyrun" -Completed
    Show-Final
    break
  }
  else {
    # 无状态文件：检查是否有 auto-run 进程刚启动（状态文件几秒内会出现）
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match 'auto-run\.mjs' }
    if ($running) {
      Write-Progress -Activity "happyrun" -Status "跑步进程已启动，等待状态文件生成..." -PercentComplete 1
    } else {
      Write-Progress -Activity "happyrun" -Completed
      Write-Host "当前没有进行中的跑步。启动: powershell -File start.ps1" -ForegroundColor Yellow
      if (Test-Path $LogPath) {
        Write-Host "（显示上一次运行的日志尾部）" -ForegroundColor DarkGray
        Get-Content $LogPath -Tail 12 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
      }
      break
    }
  }

  Print-NewLog
  try { if ([Console]::KeyAvailable) { $k = [Console]::ReadKey($true); if ($k.Key -eq 'O') { Start-Process 'http://127.0.0.1:8947/' } } } catch {}
  if ($Once) { break }
  Start-Sleep -Seconds $RefreshSec
}
