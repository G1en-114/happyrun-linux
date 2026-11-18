<#
.SYNOPSIS
  happyrun 一键主入口：检查登录态 -> 失效则自动抓包等你登录 -> 启动正式跑

.DESCRIPTION
  全流程封装：
    [1/3] token 探活（node probe.mjs）
    [2/3] 若失效：自动 UAC 拉起抓包窗口，提示你在电脑微信里重新登录，
          轮询直到新 token 生效（最多等 10 分钟）
    [3/3] 调 run-formal.ps1 后台启动正式跑，输出 formal-run.log

.PARAMETER Dist    目标距离（公里），默认 0 = 距离带随机（3.0~3.35）。显式传值则锁定该距离
.PARAMETER Time    目标用时（秒），默认 0 = 智能配速模式：按打卡点布局自动规划，
                   平均配速落在 3'15"~3'30"/km 带内（可用 run.paceMinS/paceMaxS 调）。
                   显式传值（如 -Time 700）则退回固定用时模式
.PARAMETER DryRun  只做只读校验，不等待不上传

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File happyrun\start.ps1
  powershell -ExecutionPolicy Bypass -File happyrun\start.ps1 -Time 700
  powershell -ExecutionPolicy Bypass -File happyrun\start.ps1 -DryRun
#>
param(
  [double]$Dist = 0.0,
  [int]$Time = 0,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# ── [1/3] 登录态探活 ──
Write-Host "=== [1/3] 检查登录态 ===" -ForegroundColor Cyan
$probe = & node --use-system-ca probe.mjs 2>&1 | Out-String
$needLogin = $probe -match 'FAILED'
if (-not $needLogin) { Write-Host "登录态有效" -ForegroundColor Green }

# ── [2/3] 失效则自动抓包并等待新登录态 ──
$capturedLaunched = $false
if ($needLogin) {
  Write-Host "登录态已失效，自动拉起抓包（马上会弹 UAC，请点『是』）..." -ForegroundColor Yellow
  $capturedLaunched = $true
  Start-Process powershell -Verb RunAs -ArgumentList @(
    "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "capture\start-tun-capture.ps1")
  )
  Write-Host ""
  Write-Host ">>> 请在【电脑微信】打开乐跑小程序，用测试账号登录 <<<" -ForegroundColor Magenta
  Write-Host ">>> 登录成功后本窗口会自动继续，无需其它操作 <<<" -ForegroundColor Magenta
  Write-Host ""
  $deadline = (Get-Date).AddMinutes(10)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 8
    $p2 = & node --use-system-ca probe.mjs 2>&1 | Out-String
    if ($p2 -notmatch 'FAILED') { $ok = $true; break }
    Write-Host ("  ... 等待登录中，剩余 {0:n0}s" -f ($deadline - (Get-Date)).TotalSeconds) -ForegroundColor DarkGray
  }
  if (-not $ok) {
    Write-Host "10 分钟内未等到新登录态，退出。可稍后重跑本脚本。" -ForegroundColor Red
    exit 1
  }
  Write-Host "新登录态已就位" -ForegroundColor Green
}

# ── [3/3] 正式跑 ──
Write-Host "=== [3/3] 启动正式跑 ===" -ForegroundColor Cyan
$extra = @()
if ($DryRun) { $extra += "-DryRun" }
if ($Dist -gt 0) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "run-formal.ps1") -Dist $Dist -Time $Time @extra
} else {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "run-formal.ps1") -Time $Time @extra
}

# ── [4/4] 长等待跑：自动拉起抓包窗口，供等待期间刷新 token ──
# 4km 用时约 22 分钟，token 可能撑不到提交；等待到第 12~15 分钟时在电脑微信里
# 重新登录一次小程序，新 token 写入 config.json，auto-run.mjs 提交前会自动采用。
if (-not $DryRun -and $Time -ge 900 -and -not $capturedLaunched) {
  Write-Host ""
  Write-Host "=== 本次需真实等待约 $([math]::Round($Time / 60)) 分钟，token 可能过期 ===" -ForegroundColor Yellow
  Write-Host "已自动拉起抓包窗口（UAC 点『是』）。等待进行到第 12~15 分钟时，" -ForegroundColor Yellow
  Write-Host "请在【电脑微信】里重新登录一次乐跑小程序，提交时会自动用新 token。" -ForegroundColor Yellow
  Write-Host ""
  Start-Process powershell -Verb RunAs -ArgumentList @(
    "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "capture\start-tun-capture.ps1")
  )
}
