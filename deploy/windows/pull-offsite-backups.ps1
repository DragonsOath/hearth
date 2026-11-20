<#
  Hearth: fetch encrypted off-machine backups onto this machine.

  Runs on the machine that keeps the second copy (Home Vault), on a
  schedule. It PULLS from the Hearth server (Homeserver) over SSH, so the
  server never has access to this machine and cannot change or delete these
  copies.

  Each run fetches every encrypted backup waiting in the server's outbox,
  checks its fingerprint (SHA-256) against the one the server wrote, keeps
  it only if they match, and leaves a receipt on the server. Hearth
  checks each receipt against its own fingerprint before counting the copy.
  If either machine was off, the next run simply catches up.

  Three SSH connections per run, however many backups are waiting: one to
  list them with their fingerprints, one to download, one to leave receipts.

  The files stay encrypted here; the key is not on this machine.
#>
param(
  [string[]]$Remote = @("homelab@192.168.1.10", "homelab@homeserver"),
  [string]$RemoteDir = "/srv/homelab/backups/dragon-control",
  [string]$Destination = "M:\Backups\Hearth",
  [int]$Keep = 30
)

# Native programs (ssh, scp) report problems through exit codes, checked below. With "Stop",
# Windows PowerShell 5.1 would abort the whole run on any message they print.
$ErrorActionPreference = "Continue"
$ssh = Join-Path $env:SystemRoot "System32\OpenSSH\ssh.exe"
$scp = Join-Path $env:SystemRoot "System32\OpenSSH\scp.exe"
$options = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4")
$outbox = "$RemoteDir/offsite-outbox"
$receipts = "$RemoteDir/offsite-receipts"

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$logFile = Join-Path $Destination "pull.log"

function Write-Log([string]$Message) {
  $line = "{0}  {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  $all = @(Get-Content -Path $logFile -Encoding UTF8)
  if ($all.Count -gt 2000) { $all | Select-Object -Last 1000 | Set-Content -Path $logFile -Encoding UTF8 }
}

function Get-Fingerprint([string]$Path) { (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower() }

# 1. What is waiting, with fingerprints. -n: never read input (it would wait forever with no console).
$target = $null
$waiting = @()
$listCommand = "mkdir -p '$receipts'; cd '$outbox' 2>/dev/null || exit 0; for f in *.dcbak; do [ -f `"`$f.sha256`" ] && echo `"`$f `$(cut -d' ' -f1 `"`$f.sha256`")`"; done; true"
foreach ($candidate in $Remote) {
  $out = & $ssh -n @options $candidate $listCommand 2>$null
  if ($LASTEXITCODE -eq 0) {
    $target = $candidate
    $waiting = @($out | Where-Object { $_ -match '^[\w.-]+\.dcbak [0-9a-f]{64}$' } | ForEach-Object {
        $parts = $_ -split ' '
        [pscustomobject]@{ Name = $parts[0]; Sha = $parts[1] }
      })
    break
  }
}
if (-not $target) {
  Write-Log "Could not reach the Hearth server ($($Remote -join ', ')). Will catch up next run."
  exit 0
}
if (-not $waiting.Count) { exit 0 }

# 2. Download the ones not already here, in one transfer.
$need = @($waiting | Where-Object {
    $file = Join-Path $Destination $_.Name
    -not ((Test-Path $file) -and ((Get-Fingerprint $file) -eq $_.Sha))
  })
if ($need.Count) {
  $staging = Join-Path $Destination ".incoming"
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Get-ChildItem -Path $staging -File | Remove-Item -Force
  $sources = @($need | ForEach-Object { "${target}:$outbox/$($_.Name)" })
  & $scp -q @options @sources $staging 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Log "Download from $target did not complete; whatever arrived is checked, the rest retries next run." }
  foreach ($item in $need) {
    $partial = Join-Path $staging $item.Name
    if (-not (Test-Path $partial)) { continue }
    $got = Get-Fingerprint $partial
    if ($got -ne $item.Sha) {
      Remove-Item -Force $partial
      Write-Log "$($item.Name): fingerprint did not match after download, discarded; will retry."
      continue
    }
    Move-Item -Force -Path $partial -Destination (Join-Path $Destination $item.Name)
  }
}

# 3. Receipts for every copy now stored and matching, uploaded as files in one connection.
#    (Never piped: Windows PowerShell 5.1 wraps long lines it pipes into programs.)
$outgoing = Join-Path $Destination ".receipts"
New-Item -ItemType Directory -Force -Path $outgoing | Out-Null
Get-ChildItem -Path $outgoing -File | Remove-Item -Force
$utf8 = New-Object System.Text.UTF8Encoding $false
$written = @()
foreach ($item in $waiting) {
  $file = Join-Path $Destination $item.Name
  if (-not (Test-Path $file)) { continue }
  $sha = Get-Fingerprint $file
  if ($sha -ne $item.Sha) { continue }
  $f = Get-Item $file
  $receipt = [ordered]@{
    file        = $item.Name
    sha256      = $sha
    bytes       = $f.Length
    receivedAt  = $f.LastWriteTimeUtc.ToString("o")
    checkedAt   = (Get-Date).ToUniversalTime().ToString("o")
    destination = $Destination
    host        = $env:COMPUTERNAME
  } | ConvertTo-Json -Compress
  $path = Join-Path $outgoing "$($item.Name).json"
  [System.IO.File]::WriteAllText($path, $receipt, $utf8)
  $written += $path
}
if ($written.Count) {
  & $scp -q @options @written "${target}:$receipts/" 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Log "Stored and checked $($written.Count) of $($waiting.Count) waiting: $(($written | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_) }) -join ', ')."
  } else {
    Write-Log "Stored and checked $($written.Count), but the receipts could not be uploaded; will retry."
  }
}

# Keep the newest few weeks here.
Get-ChildItem -Path $Destination -Filter "*.dcbak" | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Force
exit 0
