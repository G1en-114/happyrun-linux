# 全包 .ps1 BOM 体检：缺 BOM 的补上（PS 5.1 无 BOM 会按 ANSI 误读中文导致解析失败），并按 PS 5.1 的实际读取方式验证可解析
$ErrorActionPreference = 'Stop'
$roots = @('D:\HappyRun-portable', 'C:\Users\吴佳庆\Desktop\HappyRun-portable', 'C:\Users\吴佳庆\Desktop\HappyRun-portable-最新版', 'C:\Users\吴佳庆\Desktop\HappyRun-原版备份-20261012')
$utf8Bom = New-Object System.Text.UTF8Encoding $true
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -Recurse -File -Filter *.ps1 | ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    if (-not $hasBom) {
      $c = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
      [System.IO.File]::WriteAllText($_.FullName, $c, $utf8Bom)
      Write-Host ('BOM 补齐: ' + $_.FullName.Replace($root, ''))
    }
  }
}
Write-Host ''
Write-Host '--- 按 PS 5.1 实际读取方式（默认编码）验证全部 ps1 可解析 ---'
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -Recurse -File -Filter *.ps1 | ForEach-Object {
    $e = $null
    [void][System.Management.Automation.PSParser]::Tokenize((Get-Content $_.FullName -Raw), [ref]$e)
    $tag = $_.FullName.Replace('C:\Users\吴佳庆\Desktop', '~').Replace('D:\HappyRun-portable', 'D:\...原包')
    if ($e.Count -eq 0) { Write-Host ('OK   ' + $tag) } else { Write-Host ('FAIL ' + $tag + ' -> ' + $e[0].Message); $script:bad = $true }
  }
}
if ($bad) { Write-Host ''; Write-Host '存在解析失败项 ❌'; exit 1 }
Write-Host ''
Write-Host '=== 全部 ps1 可正常解析 ✅ ==='
