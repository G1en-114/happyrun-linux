# 登录抓包启动器：弹 UAC 后在新窗口启动 mitmproxy 抓包（等待微信登录乐跑）
# 由根目录的「登录抓包.bat」调用；抓包窗口出现 [login] 已写回 config.json 即成功，
# 之后 Ctrl+C 或直接关闭抓包窗口即可。
$script = Join-Path $PSScriptRoot 'start-tun-capture.ps1'
Start-Process powershell -Verb RunAs -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', $script
)
Write-Host ''
Write-Host '抓包窗口已在管理员权限下启动。接下来：' -ForegroundColor Cyan
Write-Host '  1. 在【电脑微信】里打开乐跑小程序，完成登录' -ForegroundColor Yellow
Write-Host '  2. 看到抓包窗口出现 [login] 已写回 config.json 即成功' -ForegroundColor Yellow
Write-Host '  3. 用完后直接关闭抓包窗口（或 Ctrl+C）' -ForegroundColor Yellow
