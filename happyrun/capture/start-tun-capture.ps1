<#
.SYNOPSIS
  happyrun TUN 抓包 —— 电脑微信小程序专用（免手机、免外部 WireGuard 客户端）

.DESCRIPTION
  用 mitmproxy 的 --mode local（mitmproxy_rs LocalRedirector，OS 级透明重定向）
  把电脑上 happyrun (tyxyzhpt.tyut.edu.cn) 的流量透明导入 mitmproxy。

  对 WeChatAppEx 完全透明：
    ✅ 不需要设系统代理
    ✅ 不需要给 WeChatAppEx 子进程传 --proxy-server
    ✅ 不依赖微信是否走系统代理
    ✅ 不需要外部 WireGuard 客户端（区别于 --mode wireguard）
    ✅ --allow-hosts 只抓 happyrun，其它流量直通

  需要：管理员权限（OS 级重定向需提权）。脚本非管理员运行时自动 UAC 提权。

.PARAMETER WebPort   mitmweb 可视化端口，默认 8081
.PARAMETER NoWeb     用 mitmdump 无界面
.PARAMETER Once       抓到登录态写回 config.json 后自动退出
.PARAMETER AllowHosts 只代理这些主机（正则，| 分隔）
.PARAMETER Pids       只重定向这些进程的流量（可选，留空则重定向全部进程）
                     传入 WeChatAppEx 的 PID 可避免影响其它应用
#>
param(
  [int]$WebPort = 8081,
  [switch]$NoWeb,
  [switch]$Once,
  [string[]]$AllowHosts = @("tyxyzhpt\.tyut\.edu\.cn"),
  [int[]]$Pids = @()
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$addon = Join-Path $here "happyrun-capture.py"
$caDir = Join-Path $env:USERPROFILE ".mitmproxy"
if (-not (Test-Path $addon)) { Write-Error "找不到 addon: $addon"; exit 1 }

# ── 1. 管理员权限检查 + 自动提权 ──
function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) {
  Write-Host "TUN/local 模式需要管理员权限，正在 UAC 提权..." -ForegroundColor Yellow
  $relaunch = @("-NoExit","-NoProfile","-ExecutionPolicy","Bypass","-File",$PSCommandPath)
  if ($NoWeb)   { $relaunch += "-NoWeb" }
  if ($Once)    { $relaunch += "-Once" }
  $relaunch += "-WebPort",$WebPort
  $relaunch += "-AllowHosts",($AllowHosts -join ",")
  if ($Pids.Count) { $relaunch += "-Pids",($Pids -join ",") }
  Start-Process powershell -Verb RunAs -ArgumentList $relaunch
  exit
}

# ── 2. 探测 WeChatAppEx 进程（可选，用于精准定向）──
function Get-AppExPids {
  try {
    [System.Diagnostics.Process]::GetProcessesByName("WeChatAppEx") | ForEach-Object { $_.Id }
  } catch { @() }
}
$appPids = Get-AppExPids
Write-Host "WeChatAppEx PIDs: $($appPids -join ', ')" -ForegroundColor DarkGray

# ── 3. 安装 mitmproxy CA 到系统根证书（local 模式需系统级信任）──
$caCert = Join-Path $caDir "mitmproxy-ca-cert.cer"
if (-not (Test-Path $caCert)) {
  Write-Host "首次运行，生成 mitmproxy CA..." -ForegroundColor Yellow
  Start-Process -FilePath "mitmdump" -ArgumentList "--version" -Wait -NoNewWindow | Out-Null
}
if (Test-Path $caCert) {
  # 检查是否已安装到 LocalMachine\Root
  $thumb = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $caCert).Thumbprint
  $installed = Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $thumb }
  if (-not $installed) {
    Write-Host "安装 mitmproxy CA 到「本地计算机 → 受信任的根证书颁发机构」..." -ForegroundColor Cyan
    Import-Certificate -FilePath $caCert -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    Write-Host "✓ CA 已安装" -ForegroundColor Green
  } else {
    Write-Host "✓ mitmproxy CA 已在系统根证书" -ForegroundColor DarkGray
  }
} else {
  Write-Host "⚠ 未找到 CA：$caCert，TUN 模式下 TLS 拦截会失败" -ForegroundColor Yellow
}

# ── 4. 构造 mitmproxy 启动参数 ──
$cmd = if ($NoWeb) { "mitmdump" } else { "mitmweb" }
# local 模式 spec：空 = 重定向全部进程；"local:pid1,pid2" = 只重定向指定进程
$modeSpec = if ($Pids.Count -gt 0) { "local:" + ($Pids -join ",") } else { "local" }
$mpArgs = @(
  "--mode",$modeSpec,
  "--allow-hosts",($AllowHosts -join "|"),
  "-s",$addon,
  "--set","happyrun_write_config=true",
  "--set","happyrun_log=true",
  "--set","happyrun_quiet=true",
  "--set","termlog_verbosity=warn"
)
# 压掉 mitmproxy 的 client/server connect 连接日志：
#   mitmweb  → termlog_verbosity=warn（上面已设，连接事件是 termlog info 级）
#   mitmdump → 额外加 --flow-detail 0（连接日志由 flow-detail 控制）
# addon 的 [login] 日志走独立 stderr handler，不受 termlog 等级影响，照常显示
if ($NoWeb) { $mpArgs += @("--flow-detail","0") }
if (-not $NoWeb) { $mpArgs += @("--web-port",$WebPort,"--no-web-open-browser") }

# ── 5. 启动 ──
Write-Host ""
Write-Host "=== happyrun TUN 抓包（电脑微信，--mode local） ===" -ForegroundColor Cyan
Write-Host "ModeSpec   : $modeSpec"
Write-Host "AllowHosts : $($AllowHosts -join ' | ')"
Write-Host "Addon      : $addon"
Write-Host "config.json: $(Join-Path (Split-Path $here) 'config.json')"
Write-Host "启动命令  : $cmd $($mpArgs -join ' ')" -ForegroundColor DarkGray
Write-Host ""

Write-Host "---- 使用步骤 ----" -ForegroundColor Green
Write-Host "1. 此脚本会启动 mitmproxy 并透明拦截到 happyrun 的流量" -ForegroundColor White
Write-Host "2. 打开电脑微信 → 进入 happyrun 小程序 → 完成登录" -ForegroundColor White
Write-Host "3. 看到 '[login] 已写回 config.json' 即抓取成功" -ForegroundColor White
Write-Host "4. Ctrl+C 退出" -ForegroundColor White
Write-Host ""
Write-Host "---- 实时日志 ----" -ForegroundColor Green

if ($Once) {
  $configPath = Join-Path (Split-Path $here) "config.json"
  $start = if (Test-Path $configPath) { (Get-Item $configPath).LastWriteTime } else { [datetime]::MinValue }
  $job = Start-Process -FilePath $cmd -ArgumentList $mpArgs -PassThru -NoNewWindow `
    -RedirectStandardOutput "$env:TEMP\happyrun_tun_out.log" `
    -RedirectStandardError "$env:TEMP\happyrun_tun_err.log"
  Write-Host "等待登录态写入 config.json ..."
  while (-not $job.HasExited) {
    if ((Test-Path $configPath) -and (Get-Item $configPath).LastWriteTime -gt $start) {
      Write-Host "`n检测到 config.json 已更新" -ForegroundColor Green
      Start-Sleep -Seconds 2; break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $job.HasExited) { Stop-Process -Id $job.Id -Force }
} else {
  & $cmd @mpArgs
}

Write-Host ""
Write-Host "退出完成。如不再使用，可在「证书管理器」移除 mitmproxy CA。" -ForegroundColor Yellow
