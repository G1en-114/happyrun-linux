<#
.SYNOPSIS
  正式跑启动器（前台运行）：开始跑步.bat → start.ps1 → 本脚本
.DESCRIPTION
  前台运行 auto-run.mjs：
    - 所有输出实时显示在本窗口，同时写入 formal-run.log（实时进度窗口读取）
    - 关闭本窗口或 Ctrl+C = 停止跑步（与旧版行为一致）
    - 跑步数据写入 formal-run.status.json / track.json（实时进度界面读取）
    - 上传成功后由 auto-run 写入台账 run-history-<学号>.jsonl
#>
param(
  [double]$Dist = 0.0,
  [int]$Time = 0,
  [switch]$DryRun
)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$logPath = Join-Path $root 'formal-run.log'
Remove-Item $logPath -ErrorAction SilentlyContinue

$nodeArgs = @('--use-system-ca', 'auto-run.mjs', '--type=formal', '--roadnet=roadnet.json')
if ($Time -gt 0) { $nodeArgs += "--time=$Time" } else { $nodeArgs += '--time=0' }
if ($Dist -gt 0) { $nodeArgs += "--dist=$Dist" }
if ($DryRun) { $nodeArgs += '--dryRun=true' }

Write-Host "=== 正式跑启动（前台模式：关闭窗口/Ctrl+C 即停止）===" -ForegroundColor Cyan

# 前台运行：输出实时显示 + 同步写 formal-run.log（tee）
& node @nodeArgs 2>&1 | ForEach-Object {
    $line = "$_"
    Write-Host $line
    try { Add-Content -Path $logPath -Value $line -Encoding UTF8 } catch {}
}

Write-Host ""
Write-Host "=== 跑步进程已结束（结果可点 查看结果.bat 查看，台账已记录）===" -ForegroundColor Cyan
