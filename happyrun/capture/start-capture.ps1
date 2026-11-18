<#
.SYNOPSIS
  happyrun 自动抓包启动脚本

.DESCRIPTION
  一键启动 mitmweb + happyrun-capture.py addon，拦截 happyrun 小程序流量、
  自动 AES 解密、提取登录态写回 config.json。

  首次运行会生成 mitmproxy CA 证书 (~\.mitmproxy)。
  手机代理与证书安装步骤见脚本输出提示。

.PARAMETER Port
  代理监听端口，默认 8080

.PARAMETER WebPort
  mitmweb 可视化界面端口，默认 8081

.PARAMETER NoWeb
  用 mitmdump（无界面）代替 mitmweb

.PARAMETER Once
  抓到登录态写回 config.json 后自动退出

.EXAMPLE
  .\start-capture.ps1
  .\start-capture.ps1 -Port 8888 -WebPort 8889
  .\start-capture.ps1 -NoWeb
#>
param(
  [int]$Port = 8080,
  [int]$WebPort = 8081,
  [switch]$NoWeb,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$addon = Join-Path $here "happyrun-capture.py"
$caDir = Join-Path $env:USERPROFILE ".mitmproxy"

if (-not (Test-Path $addon)) { Write-Error "找不到 addon: $addon"; exit 1 }

# 确保 mitmproxy 可用
$mp = (Get-Command mitmdump -ErrorAction SilentlyContinue).Source
if (-not $mp) { Write-Error "未找到 mitmdump / mitmproxy，请先安装 (pip install mitmproxy)"; exit 1 }

Write-Host "=== happyrun 自动抓包 ===" -ForegroundColor Cyan
Write-Host "代理监听端口 : $Port"
if (-not $NoWeb) {
  Write-Host "可视化界面   : $WebPort  (浏览器访问 http://localhost:$WebPort)" -ForegroundColor Cyan
}
Write-Host "Addon 脚本   : $addon"
Write-Host "config.json  : $(Join-Path (Split-Path $here) 'config.json')"
Write-Host ""

# 首次运行提示证书安装
if (-not (Test-Path $caDir)) {
  Write-Host "首次运行，将在启动时生成 CA 证书到 $caDir" -ForegroundColor Yellow
}

$cmd = if ($NoWeb) { "mitmdump" } else { "mitmweb" }
$args = @(
  "-s", $addon,
  "--listen-port", $Port,
  "--set", "happyrun_write_config=true",
  "--set", "happyrun_log=true",
  "--set", "happyrun_quiet=true",
  "--set", "termlog_verbosity=warn"
)
# 压连接日志：mitmweb 用 termlog=warn，mitmdump 额外加 --flow-detail 0
# addon [login] 走独立 stderr，不受影响
if ($NoWeb) { $args += @("--flow-detail","0") }
if (-not $NoWeb) {
  $args += @("--web-port", $WebPort, "--no-web-open-browser")
}
if ($Once) {
  $args += @("--set", "happyrun_write_config=true")
}

Write-Host "启动命令: $cmd $($args -join ' ')" -ForegroundColor DarkGray
Write-Host ""
# 取本机局域网 IPv4，避开 CIM/Native 应用层（Get-NetIPAddress 在部分环境抛
# Microsoft.Management.Infrastructure.Native 类型初始化异常）。改用 ipconfig 文本解析。
function Get-LocalIP {
  try {
    $out = ipconfig 2>$null
    $grab = $false
    foreach ($line in $out) {
      if ($line -match 'IPv4') {
        $ip = ($line -split ':\s*')[1]
        if ($ip -and $ip -notmatch '^(127\.|169\.254)') { return $ip.Trim() }
      }
    }
  } catch {}
  return $null
}
$lanIP = Get-LocalIP

Write-Host "---- 使用步骤 ----" -ForegroundColor Green
Write-Host "1. 电脑与手机连同一 WiFi" -ForegroundColor White
Write-Host "2. 手机 WiFi 设置 → 代理 → 手动" -ForegroundColor White
if ($lanIP) {
  Write-Host "   服务器: $lanIP"
} else {
  Write-Host "   服务器: <请手动查电脑局域网 IPv4（ipconfig）>"
}
Write-Host "   端口  : $Port"
Write-Host "3. 手机浏览器访问 http://mitm.it 下载证书 → 安装并设为信任" -ForegroundColor White
Write-Host "4. 打开微信 → 进入 happyrun 小程序 → 完成登录" -ForegroundColor White
Write-Host "5. 看到 '[login] 已写回 config.json' 即抓取成功，可 Ctrl+C 退出" -ForegroundColor White
Write-Host ""
Write-Host "---- 实时日志 ----" -ForegroundColor Green

if ($Once) {
  # 抓到登录态后自动退出的简易包装：监控 config.json 写入时间
  $configPath = Join-Path (Split-Path $here) "config.json"
  $start = if (Test-Path $configPath) { (Get-Item $configPath).LastWriteTime } else { [datetime]::MinValue }
  $job = Start-Process -FilePath $cmd -ArgumentList $args -PassThru -NoNewWindow
  Write-Host "等待登录态写入 config.json ..."
  while (-not $job.HasExited) {
    if ((Test-Path $configPath) -and (Get-Item $configPath).LastWriteTime -gt $start) {
      Write-Host "`n检测到 config.json 已更新，自动退出" -ForegroundColor Green
      Start-Sleep -Seconds 2
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $job.HasExited) { Stop-Process -Id $job.Id -Force }
} else {
  & $cmd @args
}
