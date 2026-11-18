$ErrorActionPreference = 'Stop'
$A = 'D:\HappyRun-portable\happyrun'
$desk = Get-ChildItem "$env:USERPROFILE\Desktop" -Directory -Filter 'HappyRun-portable-*' | Select-Object -First 1
if (-not $desk) { Write-Error 'desktop copy not found'; exit 1 }
$B = Join-Path $desk.FullName 'happyrun'
Write-Host "A=$A"; Write-Host "B=$B"
$skip = 'config\.json$|formal-run|status\.json$|run-ledger|\.log$|live-testdata|__pycache__|\.pcap|sync-report'
function Inv($root) {
  Get-ChildItem $root -Recurse -File |
    Where-Object { $_.FullName -notmatch $skip -and $_.FullName -notmatch 'node_modules' -and $_.FullName -notmatch '\\flows' } |
    ForEach-Object {
      $h = $null
      try { $h = (Get-FileHash $_.FullName -Algorithm MD5 -ErrorAction Stop).Hash } catch { $h = 'UNREADABLE' }
      [pscustomobject]@{ Rel = $_.FullName.Substring($root.Length + 1); Hash = $h }
    }
}
$ha = @{}; Inv $A | ForEach-Object { $ha[$_.Rel] = $_.Hash }
$hb = @{}; Inv $B | ForEach-Object { $hb[$_.Rel] = $_.Hash }
$diff = @()
foreach ($k in $ha.Keys) {
  if (-not $hb.ContainsKey($k)) { $diff += 'ONLY-D: ' + $k }
  elseif ($hb[$k] -ne $ha[$k]) { $diff += 'DIFF: ' + $k }
}
foreach ($k in $hb.Keys) { if (-not $ha.ContainsKey($k)) { $diff += 'ONLY-DESKTOP: ' + $k } }
if ($diff.Count -eq 0) { "ALL_MATCH ($($ha.Count) files)" } else { $diff; "TOTAL DIFF: $($diff.Count)" }
