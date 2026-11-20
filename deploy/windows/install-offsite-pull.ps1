<#
  Registers the scheduled task that fetches Hearth's encrypted
  backups onto this machine: every 30 minutes and at sign-in, and right
  away if a run was missed while the machine was off. Runs as you while you
  are signed in (no admin rights, no stored password), fully hidden so
  nothing flashes on screen (or on a Moonlight stream).

  Remove it with: Unregister-ScheduledTask -TaskName "Hearth - fetch off-machine backups"
#>
param(
  [string]$Destination = "M:\Backups\Hearth"
)

$ErrorActionPreference = "Stop"
$name = "Hearth - fetch off-machine backups"
$script = Join-Path $PSScriptRoot "pull-offsite-backups.ps1"
$user = "$env:USERDOMAIN\$env:USERNAME"

# conhost --headless runs the console program with no window at all.
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
  -Argument "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Destination `"$Destination`""
$every30 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 30)
$atSignIn = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($every30, $atSignIn) -Settings $settings `
  -Principal $principal -Description "Fetches and checks Hearth's encrypted backups from the server (pull only; the server cannot reach this machine)." -Force -ErrorAction Stop | Out-Null

if (-not (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) {
  throw "The task was not registered."
}
"Registered '$name' (every 30 minutes and at sign-in; catches up after missed runs)."
