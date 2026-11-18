<#
.SYNOPSIS
  happyrun 结果查看器：显示上次运行的完整过程 + 当前账号的全部有效次数台账

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File happyrun\result.ps1
#>
param([int]$TailLines = 30, [string]$Account = "")

$ErrorActionPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── 1. 当前账号（-Account 可显式指定看哪个账号的台账）──
$acc = "default"
$accKnown = $false
if ($Account) {
  $acc = $Account
  $accKnown = $true
} else {
  try {
    $cfgPath = Join-Path $root "config.json"
    if (Test-Path $cfgPath) {
      $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.student_num) { $acc = [string]$cfg.student_num; $accKnown = $true }
      elseif ($cfg.uid) { $acc = [string]$cfg.uid; $accKnown = $true }
    }
  } catch {}
}
$headerAcc = if ($accKnown) { $acc } else { "未登录（config.json 不存在，完成登录抓包后自动生成）" }
Write-Host "════════════ happyrun 结果（账号: $headerAcc）════════════" -ForegroundColor Cyan

# ── 2. 上次运行的过程日志（尾部）──
$log = Join-Path $root "formal-run.log"
if (Test-Path $log) {
  Write-Host ""
  Write-Host "── 上次运行日志（尾部 $TailLines 行）──" -ForegroundColor Yellow
  Get-Content $log -Tail $TailLines -Encoding UTF8 | ForEach-Object { Write-Host $_ }
} else {
  Write-Host "（还没有 formal-run.log）" -ForegroundColor DarkGray
}

# ── 3. 有效次数台账（-Account 指定账号；config 缺失时自动列出全部账号）──
function Show-Ledger([string]$accName) {
  $hf = Join-Path $root ("run-history-{0}.jsonl" -f $accName)
  if (-not (Test-Path $hf)) { return $false }
  Write-Host "── 有效次数台账（账号 $accName）──" -ForegroundColor Yellow
  $script:okCount = 0
  Get-Content $hf -Encoding UTF8 | ForEach-Object {
    if (-not $_.Trim()) { return }
    try {
      $r = $_ | ConvertFrom-Json
      $res = $r.result
      $mark = switch ($res) { "success" { "✅ 有效"; $script:okCount++ } "duplicate" { "♻ 重复" } "rejected" { "⚠ 被拒" } "aborted" { "✖ 中止" } default { $res } }
      $dist = if ($r.distance_km) { "{0}km" -f $r.distance_km } else { "--" }
      $pace = if ($r.pace) { $r.pace } else { "--" }
      $why = if ($r.reason) { " $($r.reason)" } elseif ($r.record_id) { " record=$($r.record_id)" } else { "" }
      Write-Host ("  #{0,-3} {1}  {2}  {3}  {4}{5}" -f $r.n, ($r.time -replace 'T', ' ' -replace '\..*$', ''), $mark, $dist, $pace, $why)
    } catch { Write-Host "  (无法解析: $_)" }
  }
  Write-Host ("  合计: {0} 次有效" -f $script:okCount) -ForegroundColor Green
  return $true
}

Write-Host ""
if ($Account) {
  if (-not (Show-Ledger $acc)) { Write-Host "  （账号 $acc 还没有记录）" -ForegroundColor DarkGray }
} elseif (Test-Path (Join-Path $root "config.json")) {
  if (-not (Show-Ledger $acc)) { Write-Host "  （账号 $acc 还没有记录）" -ForegroundColor DarkGray }
} else {
  # 没有 config.json（比如刚删掉准备换号）→ 列出所有账号的台账
  $all = Get-ChildItem (Join-Path $root "run-history-*.jsonl") -ErrorAction SilentlyContinue
  if ($all) {
    foreach ($f in $all) {
      $a = $f.BaseName -replace '^run-history-', ''
      Show-Ledger $a | Out-Null
      Write-Host ""
    }
  } else {
    Write-Host "  （还没有任何账号的记录）" -ForegroundColor DarkGray
  }
}
