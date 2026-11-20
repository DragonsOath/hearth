# Installs Hearth's elevated executor on Windows: the one way Hearth makes administrator-level
# changes (Storage Spaces in the RAID / Arrays tab), each only after you approve its plan.
#
# What it sets up (run once, in PowerShell as administrator):
#   - Node.js and the executor's program in "C:\Program Files\Hearth\elevated", which only
#     administrators can change (whoever could change them could run code as SYSTEM);
#   - its scope file, key, state, log, and backups in "C:\ProgramData\Hearth\elevation", closed to
#     everyone but SYSTEM and Administrators, with Hearth's account allowed to read the key, the
#     log, and the backups (never to change them);
#   - a startup task, "Hearth Elevated", running it as SYSTEM on the named pipe
#     \\.\pipe\hearth-elevated. Hearth finds it on its own.
#
# The executor runs only its fixed catalog of operations, only with a single-use authorization
# for exactly the step you approved, and checks the drives itself before acting. It refuses
# everything if any of its own files can be changed by an account other than SYSTEM or
# Administrators.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-elevation.ps1 -Operations storage
#   ... -DryRun       says what it would do, changes nothing
#   ... -Verify       checks it is installed and answering
#   ... -Uninstall    removes it (its log is kept)
param(
  [ValidateSet("storage")][string]$Operations = "storage",
  [string]$HearthHome = $(if ($env:HEARTH_HOME) { $env:HEARTH_HOME } else { Join-Path $env:LOCALAPPDATA "Hearth" }),
  [string]$HearthUser,
  [switch]$Uninstall,
  [switch]$Verify,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
function Fail($m) { Write-Host "Not done: $m" -ForegroundColor Red; exit 1 }
function Say($m) { Write-Host $m }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -and -not $DryRun) { Fail "Run this in PowerShell as administrator (right-click PowerShell, Run as administrator)." }

$Prog = Join-Path $env:ProgramFiles "Hearth\elevated"
$Data = Join-Path $env:ProgramData "Hearth\elevation"
$Task = "Hearth Elevated"
$Pipe = "\\.\pipe\hearth-elevated"
$Ops = @("spaces.member", "spaces.repair", "spaces.grow", "spaces.create")
$Scope = Join-Path $Data "elevation.json"
$Key = Join-Path $Data "elevation.key"

function StopIt {
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*hearth-elevated.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  if ($DryRun) { Say "(dry run: would remove the task, $Prog, the key, scope, and state; the log stays)"; exit 0 }
  StopIt
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $Prog -ErrorAction SilentlyContinue
  foreach ($p in @($Key, $Scope, (Join-Path $Data "state"))) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
  Say "Removed. Its log is kept: $(Join-Path $Data 'log\elevated.jsonl'). Restart Hearth so it notices."
  exit 0
}

if ($Verify) {
  $t = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  if (-not $t) { Fail "It is not installed." }
  if ($t.State -ne "Running") { Fail "The task is installed but not running ($($t.State))." }
  if (-not (Test-Path $Pipe)) { Fail "The task runs, but the pipe $Pipe is not there." }
  Say "Installed and listening on $Pipe. Hearth shows whether it accepts its setup (Storage > RAID / Arrays)."
  exit 0
}

# --- Hearth's account: the one that may read the key --------------------------------------------
if (-not $HearthUser) {
  $t = Get-ScheduledTask -TaskName "Hearth" -ErrorAction SilentlyContinue
  $HearthUser = if ($t) { $t.Principal.UserId } else { "$env:USERDOMAIN\$env:USERNAME" }
}
try { $Sid = (New-Object Security.Principal.NTAccount($HearthUser)).Translate([Security.Principal.SecurityIdentifier]).Value }
catch { Fail "Could not find the account $HearthUser. Pass the account Hearth runs as: -HearthUser NAME" }

# --- The program ----------------------------------------------------------------------------------
$node = Join-Path $HearthHome "node\node.exe"
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { Fail "Node.js was not found (looked in $HearthHome\node and on PATH)." }
$mjs = Join-Path $HearthHome "app\apps\server\dist-elevated\hearth-elevated.js"
if (-not (Test-Path $mjs)) { Fail "Hearth's executor program is not built here ($mjs). Update Hearth first." }

Say "Hearth's elevated executor, for $HearthUser ($Sid):"
Say "  program:  $Prog (Node.js $(& $node --version) and hearth-elevated.mjs)"
Say "  data:     $Data (scope, key, state, log, backups)"
Say "  task:     '$Task', as SYSTEM at startup, on $Pipe"
Say "  allows:   $($Ops -join ', ')"
if ($DryRun) { Say "(dry run: nothing was changed)"; exit 0 }

$SYSTEM = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
$ADMINS = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
$READER = New-Object Security.Principal.SecurityIdentifier($Sid)

# Only SYSTEM and Administrators may change it; $readers may read it. Nothing is inherited.
function Lock([string]$path, [bool]$readable) {
  $item = Get-Item -LiteralPath $path -Force
  $dir = $item.PSIsContainer
  $acl = if ($dir) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($ADMINS)
  $inherit = if ($dir) { [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit" } else { [Security.AccessControl.InheritanceFlags]::None }
  $prop = [Security.AccessControl.PropagationFlags]::None
  foreach ($who in @($SYSTEM, $ADMINS)) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who, "FullControl", $inherit, $prop, "Allow")))
  }
  if ($readable) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($READER, "ReadAndExecute", $inherit, $prop, "Allow")))
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}

StopIt
New-Item -ItemType Directory -Force $Prog | Out-Null
Lock $Prog $false
Copy-Item -Force $node (Join-Path $Prog "node.exe")
Copy-Item -Force $mjs (Join-Path $Prog "hearth-elevated.mjs")

New-Item -ItemType Directory -Force $Data | Out-Null
Lock $Data $true
foreach ($d in @("state", "log", "backups")) { New-Item -ItemType Directory -Force (Join-Path $Data $d) | Out-Null }
Lock (Join-Path $Data "state") $false
Lock (Join-Path $Data "log") $true
Lock (Join-Path $Data "backups") $true

# A new key on every install: the old one (if any) stops working at once.
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[IO.File]::WriteAllBytes($Key, $bytes)
Lock $Key $true

$scopeJson = [ordered]@{
  version = 1
  roots = @()
  operations = $Ops
  units = @()
  backupRoot = (Join-Path $Data "backups")
  stateDir = (Join-Path $Data "state")
  auditLog = (Join-Path $Data "log\elevated.jsonl")
  keyFile = $Key
  readerSids = @($Sid)
} | ConvertTo-Json -Depth 3
[IO.File]::WriteAllText($Scope, $scopeJson, (New-Object Text.UTF8Encoding($false)))
Lock $Scope $true

$action = New-ScheduledTaskAction -Execute (Join-Path $Prog "node.exe") `
  -Argument "`"$(Join-Path $Prog 'hearth-elevated.mjs')`" --config `"$Scope`" --serve $Pipe"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "S-1-5-18" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description "Hearth's elevated executor: approved storage changes only." -Force | Out-Null
Start-ScheduledTask -TaskName $Task

for ($i = 0; $i -lt 20 -and -not (Test-Path $Pipe); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path $Pipe)) { Fail "The task started, but the pipe $Pipe did not appear. See Task Scheduler > $Task > History." }
Say "Done. Hearth's elevated executor is listening on $Pipe."
Say "Open Storage > RAID / Arrays in Hearth: it finds the executor on its own and says if anything is wrong."
