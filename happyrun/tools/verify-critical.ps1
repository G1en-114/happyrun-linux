$ErrorActionPreference = 'Stop'
$A = 'D:\HappyRun-portable\happyrun'
$desk = Get-ChildItem "$env:USERPROFILE\Desktop" -Directory -Filter 'HappyRun-portable-*' | Select-Object -First 1
$B = Join-Path $desk.FullName 'happyrun'
$critical = @('auto-run.mjs','result-popup.ps1','roadnet.json','probe.mjs','start.ps1','watch.ps1','result.ps1',
  'lib\track.mjs','lib\smooth.mjs','lib\route.mjs','lib\config.mjs','lib\client.mjs','lib\record.mjs',
  'lib\oss.mjs','lib\pace.mjs','lib\signer.mjs',
  'tools\live-serve.mjs','tools\live.html')
$bad = @()
foreach ($f in $critical) {
  $pa = Join-Path $A $f; $pb = Join-Path $B $f
  if (-not (Test-Path $pa)) { $bad += "MISSING D: $f"; continue }
  if (-not (Test-Path $pb)) { $bad += "MISSING DESKTOP: $f"; continue }
  $ha = (Get-FileHash $pa -Algorithm MD5).Hash
  $hb = (Get-FileHash $pb -Algorithm MD5).Hash
  if ($ha -ne $hb) { $bad += "DIFF: $f" }
}
$batA = Get-ChildItem 'D:\HappyRun-portable' -File -Filter '*.bat' | Where-Object { $_.Length -gt 100 }
$batB = Get-ChildItem $desk.FullName -File -Filter '*.bat' | Where-Object { $_.Length -gt 100 }
if (-not $batA) { $bad += 'MISSING D: run bat' }
if (-not $batB) { $bad += 'MISSING DESKTOP: run bat' }
if ($bad.Count -eq 0) { "CRITICAL_ALL_MATCH ($($critical.Count) files + 2 bats)" } else { $bad }
