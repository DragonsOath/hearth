# Hearth in one command, on Windows. Downloads Hearth, brings its own Node.js 24 when this PC has
# none, builds it, sets it to start when you sign in, and opens its setup page. No administrator
# rights needed. Run it again any time to update: your data and settings are kept.
#
#     irm https://raw.githubusercontent.com/DragonsOath/hearth/main/deploy/get.ps1 | iex
#   Joining a Hearth you already have (the command from its "Add a PC" sets this first):
#     $env:HEARTH_JOIN = 'http://192.168.1.10:7600/join?code=...'
#   From a downloaded copy:
#     powershell -ExecutionPolicy Bypass -File get.ps1 [-DryRun | -Uninstall]
#   To remove it with the one-line command, set $env:HEARTH_UNINSTALL = "1" first.
#
# Everything lives in one folder (HEARTH_HOME, default %LOCALAPPDATA%\Hearth): the app in app\,
# your data, vault key, and backups beside it, and hearth.ps1 to start, stop, or check it.
# Settings (all optional, as environment variables): HEARTH_HOME, HEARTH_VERSION (like 0.28.0),
# HEARTH_CHANNEL=stable|fast (stable when not set: releases marked stable; fast: every release as
# soon as it is out), HEARTH_NETWORK=yes|no (open it to other devices on your home network),
# HEARTH_PORT (7600). With no one to ask (run by a script or an AI assistant), the question takes
# "no" and the installer prints what it chose.
param([switch]$DryRun, [switch]$Uninstall)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = "DragonsOath/hearth"
# Sets a shortcut's taskbar ID (System.AppUserModel.ID), which WScript.Shell cannot do.
function SetTaskbarId($path, $id) {
  if (-not ("HearthLnk" -as [type])) {
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class HearthLnk {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bc, int flags, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPS ps);
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPS { int GetCount(out uint c); int GetAt(uint i, out PK k); int GetValue(ref PK k, out PV v); int SetValue(ref PK k, ref PV v); int Commit(); }
  [StructLayout(LayoutKind.Sequential, Pack=4)] struct PK { public Guid f; public uint p; }
  [StructLayout(LayoutKind.Sequential)] struct PV { public ushort vt; ushort a,b,c; public IntPtr p; IntPtr q; }
  public static void SetId(string path, string id) {
    Guid g = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPS ps;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref g, out ps));
    PK k = new PK { f = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), p = 5 };
    PV v = new PV { vt = 31, p = Marshal.StringToCoTaskMemUni(id) };
    Marshal.ThrowExceptionForHR(ps.SetValue(ref k, ref v)); Marshal.ThrowExceptionForHR(ps.Commit());
    Marshal.ReleaseComObject(ps);
  }
}
"@
  }
  [HearthLnk]::SetId($path, $id)
}
function Say($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host ""; Write-Host $text -ForegroundColor Red; throw "Hearth was not installed." }

$HearthHome = if ($env:HEARTH_HOME) { $env:HEARTH_HOME } else { Join-Path $env:LOCALAPPDATA "Hearth" }
$App = Join-Path $HearthHome "app"
$Work = Join-Path ([IO.Path]::GetTempPath()) ("hearth-get-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force $Work | Out-Null

# Removing it: stops it, removes the sign-in task, then, only if you say so, its folder.
if ($Uninstall -or $env:HEARTH_UNINSTALL -eq "1") {
  $Control = Join-Path $HearthHome "hearth.ps1"
  if (-not (Test-Path $Control)) { Fail "Hearth is not installed in $HearthHome." }
  # The Crucible's request checkpoint is on: removing Hearth from here skips its clean exit.
  if (Test-Path (Join-Path $HearthHome "data\crucible-checkpoint.json")) {
    $Hold = "Hearth " + [char]0x00B7 + " Waiting for the Crucible"
    Write-Host ""
    Write-Host "WARNING: Hearth's Crucible is holding Seerr's movie requests for you."
    Write-Host "Removing Hearth from here leaves new requests on the Radarr profile"
    Write-Host "'$Hold', where nothing is ever downloaded for them."
    Write-Host "Uninstall from inside Hearth instead (PCs > Uninstall): it hands them back first."
    Write-Host "Or afterwards: in Seerr, turn 'Enable Automatic Search' back on and pick your old"
    Write-Host "profile; in Radarr, move any movies on that profile to another one and search them."
    $go = Read-Host "Remove Hearth anyway? [y/N]"
    if ($go -notmatch "^[yY]") {
      Write-Host "Kept Hearth."
      Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
      return
    }
  }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Control stop
  Unregister-ScheduledTask -TaskName "Hearth" -Confirm:$false -ErrorAction SilentlyContinue
  foreach ($dir in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
    Remove-Item (Join-Path $dir "Hearth.lnk") -ErrorAction SilentlyContinue
  }
  # hearth:// links, only when they open this Hearth.
  $cmd = (Get-ItemProperty "HKCU:\Software\Classes\hearth\shell\open\command" -ErrorAction SilentlyContinue)."(default)"
  if ($cmd -and $cmd -like "*$HearthHome*") { Remove-Item -Recurse "HKCU:\Software\Classes\hearth" -ErrorAction SilentlyContinue }
  Write-Host "Removed the sign-in task and the Hearth app icons."
  Write-Host ""
  Write-Host "Your Hearth folder is still here: $HearthHome (your settings, vault, backups, and the app)."
  $a = Read-Host "Delete it too? This cannot be undone. [y/N]"
  if ($a -match "^[yY]") {
    Remove-Item -Recurse -Force $HearthHome
    Write-Host "Deleted $HearthHome."
  } else {
    Write-Host "Kept it. Running the installer again brings Hearth back with everything in it."
  }
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
  return
}

# One installer at a time: two at once (Update clicked twice, say) fight over the same folder.
$Lock = New-Object System.Threading.Mutex($false, "Local\HearthInstaller")
$HaveLock = $false
try { $HaveLock = $Lock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $HaveLock = $true }
if (-not $HaveLock) {
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
  Write-Host "Hearth is already being installed or updated. Let that finish first." -ForegroundColor Yellow
  return
}

# Starts Hearth through its sign-in task when there is one, so Hearth does not belong to whatever ran
# this installer (closing that window, or the update job ending, would otherwise stop Hearth too).
# Otherwise through its control script, waiting for that script only. Not through a pipe:
# Hearth inherits the script's output handles, so a pipe would stay open as long as Hearth runs.
function StartHearth {
  $task = Get-ScheduledTask -TaskName "Hearth" -ErrorAction SilentlyContinue
  if ($task) { Start-ScheduledTask -TaskName "Hearth"; return }
  $p = Start-Process powershell -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$Control`"", "start") `
    -WindowStyle Hidden -PassThru
  $p.WaitForExit()
}

try {
  Say "Hearth installer"
  Write-Host "Hearth goes in:  $HearthHome"
  $Update = Test-Path (Join-Path $HearthHome "hearth.ps1")
  if ($Update) { Write-Host "Already installed. This updates it, keeping your data and settings." }

  # --- Node.js 24 -------------------------------------------------------------------------------
  $OwnNode = Join-Path $HearthHome "node"
  function NodeOk {
    $n = Get-Command node -ErrorAction SilentlyContinue
    if (-not $n) { return $false }
    return ([int](& node -p "process.versions.node.split('.')[0]") -ge 24)
  }
  if (Test-Path (Join-Path $OwnNode "node.exe")) { $env:PATH = "$OwnNode;$env:PATH" }
  if (-not (NodeOk)) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    Say "Getting Node.js 24 (just for Hearth, in $OwnNode)"
    $base = "https://nodejs.org/dist/latest-v24.x"
    $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
    $line = ($sums -split "`n") | Where-Object { $_ -match "node-v24[0-9.]*-win-$arch\.zip$" } | Select-Object -First 1
    if (-not $line) { Fail "Could not find Node.js 24 for win-$arch on nodejs.org." }
    $hash, $file = ($line.Trim() -split "\s+")
    $zip = Join-Path $Work $file
    Invoke-WebRequest "$base/$file" -OutFile $zip -UseBasicParsing
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) {
      Fail "The Node.js download did not match its checksum; nothing was installed."
    }
    if (-not $DryRun) {
      Expand-Archive $zip -DestinationPath $Work -Force
      if (Test-Path $OwnNode) { Remove-Item -Recurse -Force $OwnNode }
      Move-Item (Join-Path $Work ($file -replace "\.zip$", "")) $OwnNode
      $env:PATH = "$OwnNode;$env:PATH"
    } else {
      Write-Host "(dry run: would unpack $file into $OwnNode)"
    }
  }
  if (NodeOk) { Write-Host "Node.js $(& node -v)" }

  # --- The source of the newest release ------------------------------------------------------------
  Say "Downloading Hearth"
  $headers = @{ "User-Agent" = "hearth-installer"; "Accept" = "application/vnd.github+json" }
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if ($gh) {
    & gh auth status *> $null
    if ($LASTEXITCODE -eq 0) { $headers["Authorization"] = "Bearer " + (& gh auth token) }
  }
  try {
    # Newest first, drafts included when you can see them.
    $releases = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases?per_page=100" -Headers $headers
  } catch {
    Fail "Could not reach Hearth on GitHub. Check this PC can reach github.com, then run this again."
  }
  $Channel = if ($env:HEARTH_CHANNEL) { $env:HEARTH_CHANNEL } else { "stable" }
  if ($Channel -ne "stable" -and $Channel -ne "fast") { Fail "HEARTH_CHANNEL is stable or fast, not '$Channel'." }
  $release = if ($env:HEARTH_VERSION) {
    $releases | Where-Object { $_.tag_name -eq ("v" + $env:HEARTH_VERSION.TrimStart("v")) } | Select-Object -First 1
  } else {
    # The highest version (GitHub's list order is not always newest first): Hearth releases
    # only (other releases, like the voices, have other names), never a draft. Stable: only
    # releases marked stable (not prereleases). Fast: every published release.
    $releases | Where-Object { -not $_.draft -and $_.tag_name -match '^v\d+\.\d+\.\d+$' -and ($Channel -eq "fast" -or -not $_.prerelease) } |
      Sort-Object { [version]$_.tag_name.TrimStart("v") } -Descending |
      Select-Object -First 1
  }
  if (-not $release) { Fail "No Hearth release found on GitHub yet." }
  $version = $release.tag_name.TrimStart("v")
  Write-Host "Channel: $Channel (Hearth $version)"
  # An update never moves to an older release on its own (a fast install run again on stable).
  $HaveFile = Join-Path $App "RELEASE"
  if (-not $env:HEARTH_VERSION -and (Test-Path $HaveFile)) {
    $have = ((Get-Content $HaveFile) -match '^version=' | Select-Object -First 1) -replace '^version=', ''
    if ($have -and $have -ne $version -and ([version]$have -gt [version]$version)) {
      Write-Host "This Hearth ($have) is newer than the newest $Channel release ($version), so it stays as it is."
      Write-Host 'To follow every release, set $env:HEARTH_CHANNEL = "fast" and run this again.'
      return
    }
  }
  # Exactly that release's code (its tag), not whatever its branch has now.
  $commit = $release.tag_name
  Write-Host "Hearth $version"
  $srcZip = Join-Path $Work "hearth-src.zip"
  Invoke-WebRequest "https://api.github.com/repos/$Repo/zipball/$commit" -Headers $headers -OutFile $srcZip -UseBasicParsing
  Expand-Archive $srcZip -DestinationPath (Join-Path $Work "src") -Force
  $Fresh = Get-ChildItem (Join-Path $Work "src") -Directory | Select-Object -First 1
  if (-not $Fresh) { Fail "The download was empty." }

  # --- One question (skipped on an update: the installed settings are kept) ------------------------
  $Network = $env:HEARTH_NETWORK
  $Port = if ($env:HEARTH_PORT) { [int]$env:HEARTH_PORT } else { 7600 }
  if (-not $Update) {
    # A PC joining your Hearth dials out to it; nothing needs to reach this PC.
    if (-not $Network -and $env:HEARTH_JOIN) { $Network = "no" }
    if ($Network -match "^[yY]") { $Network = "yes" } elseif ($Network -match "^[nN]") { $Network = "no" }
    elseif ($Network) { Fail "HEARTH_NETWORK is yes or no, not '$Network'." }
    if (-not $Network) {
      # No one to ask (a script, an AI assistant, a non-interactive shell): this PC only.
      $interactive = [Environment]::UserInteractive -and -not ([Environment]::GetCommandLineArgs() -match '^-NonI')
      $a = $null
      if ($interactive) {
        Say "One question"
        Write-Host "Open Hearth to your other devices (phone, laptop) on your home network?"
        Write-Host "No keeps it to this PC only. You can change it later. (Windows may ask once to allow it.)"
        try { $a = Read-Host "Open to your home network? [y/N]" } catch { $interactive = $false }
      }
      if (-not $interactive) {
        Write-Host "No one to ask, so Hearth stays on this PC only (home network: no)."
        Write-Host 'To open it to your home network, set $env:HEARTH_NETWORK = "yes" and run this again.'
      }
      $Network = if ($a -match "^[yY]") { "yes" } else { "no" }
    }
    Write-Host "Home network: $Network"
    # Another program already on that port: take the next free one.
    while ($true) {
      $c = New-Object Net.Sockets.TcpClient
      try { $c.Connect("127.0.0.1", $Port); $c.Close(); $Port++ } catch { break }
    }
  }

  if ($DryRun) {
    Write-Host "(dry run: would build Hearth $version in $App, port $Port, home network: $Network,"
    Write-Host " and set it to start when $env:USERNAME signs in)"
    return
  }

  # --- Build --------------------------------------------------------------------------------------
  Say "Building Hearth (a few minutes, once per update)"
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
  Push-Location $Fresh.FullName
  try {
    $log = Join-Path $Work "build.log"
    # Through cmd: Windows PowerShell 5.1 counts any progress a program writes to its error
    # stream as a failure, and pnpm writes its progress there. The exit code says how it went.
    & cmd /c "corepack pnpm install --frozen-lockfile > `"$log`" 2>&1"
    if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 30; Fail "Installing Hearth's packages failed." }
    & cmd /c "corepack pnpm build > `"$log`" 2>&1"
    if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 30; Fail "Building Hearth failed." }
  } finally { Pop-Location }
  "version=$version`ncommit=$commit`nbuilt=$((Get-Date).ToUniversalTime().ToString('s'))Z" |
    Set-Content -Encoding ascii (Join-Path $Fresh.FullName "RELEASE")

  # --- Install: swap in the new version, keep the control script and its settings --------------------
  New-Item -ItemType Directory -Force $HearthHome | Out-Null
  $Control = Join-Path $HearthHome "hearth.ps1"
  if (Test-Path $Control) { & powershell -NoProfile -ExecutionPolicy Bypass -File $Control stop | Out-Null }
  $Previous = Join-Path $HearthHome "app.previous"
  if (Test-Path $Previous) { Remove-Item -Recurse -Force $Previous }
  # Windows can hold the folder for a few seconds after Hearth stops (closing files, a virus scan).
  # Wait for it rather than giving up, and if it never frees, start the version that was there.
  $swapped = $false
  for ($i = 0; $i -lt 30 -and -not $swapped; $i++) {
    try {
      if (Test-Path $App) { Move-Item $App $Previous -ErrorAction Stop }
      Move-Item $Fresh.FullName $App -ErrorAction Stop
      $swapped = $true
    } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $swapped) {
    if (-not (Test-Path $App) -and (Test-Path $Previous)) { Move-Item $Previous $App }
    if (Test-Path $Control) { StartHearth }
    Fail "Windows kept Hearth's folder busy, so the update was not installed. Hearth was started again on the version you had; try the update again in a minute."
  }

  if (-not (Test-Path $Control)) {
    $hostAddr = if ($Network -eq "yes") { "0.0.0.0" } else { "127.0.0.1" }
    # The control script: how Hearth starts at sign-in, and how you start, stop, or check it.
    @"
# Starts, stops, or checks Hearth. Its settings are the lines just below.
param([ValidateSet("start", "stop", "restart", "status", "url")][string]`$Do = "status")
`$HearthHome = "$HearthHome"
`$env:NODE_ENV = "production"
`$env:DC_FIRST_START = "empty"
`$env:DC_PORT = "$Port"
`$env:DC_HOST = "$hostAddr"
`$env:DC_DATA_DIR = "`$HearthHome\data"
`$env:DC_KEY_DIR = "`$HearthHome\keys"
`$env:DC_BACKUP_DIR = "`$HearthHome\backups"
if (Test-Path "`$HearthHome\node\node.exe") { `$env:PATH = "`$HearthHome\node;`$env:PATH" }
`$pidFile = "`$HearthHome\hearth.pid"
function Running {
  if (-not (Test-Path `$pidFile)) { return `$null }
  Get-Process -Id ([int](Get-Content `$pidFile)) -ErrorAction SilentlyContinue | Where-Object { `$_.ProcessName -eq "node" }
}
switch (`$Do) {
  "start" {
    if (Running) { "Hearth is already running."; break }
    New-Item -ItemType Directory -Force "`$HearthHome\data", "`$HearthHome\keys", "`$HearthHome\backups" | Out-Null
    `$p = Start-Process node -ArgumentList "apps/server/dist/index.js" -WorkingDirectory "`$HearthHome\app" -WindowStyle Hidden ``
      -RedirectStandardOutput "`$HearthHome\hearth.log" -RedirectStandardError "`$HearthHome\hearth.err.log" -PassThru
    `$p.Id | Set-Content `$pidFile
    "Hearth started."
  }
  "stop" {
    `$p = Running
    if (`$p) { & taskkill /PID `$p.Id /T /F | Out-Null; "Hearth stopped." } else { "Hearth is not running." }
    Remove-Item `$pidFile -ErrorAction SilentlyContinue
  }
  "restart" { & `$PSCommandPath stop; & `$PSCommandPath start }
  "status" { if (Running) { "Hearth is running on port `$env:DC_PORT." } else { "Hearth is not running." } }
  "url" {
    `$code = "`$HearthHome\data\setup-code.txt"
    if (Test-Path `$code) { "http://localhost:`$env:DC_PORT/setup?code=`$((Get-Content `$code).Trim())" }
    else { "http://localhost:`$env:DC_PORT" }
  }
}
"@ | Set-Content -Encoding utf8 $Control
  }

  # How it was installed, so Hearth can also remove itself (from any of your devices).
  # Written without a byte-order mark (Windows PowerShell's "utf8" adds one, which breaks JSON readers).
  $installJson = @{ kind = "windows-sign-in-task"; home = $HearthHome; service = "Hearth"; channel = $Channel } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $HearthHome "install.json"), $installJson, (New-Object System.Text.UTF8Encoding $false))
  # A join link from your Hearth's "Add a PC": Hearth joins with it when it starts.
  if ($env:HEARTH_JOIN) {
    New-Item -ItemType Directory -Force (Join-Path $HearthHome "data") | Out-Null
    Set-Content -Encoding ascii -NoNewline (Join-Path $HearthHome "data\join-link") $env:HEARTH_JOIN
  }

  # Start when you sign in (your account only; no administrator rights needed).
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Control`" start"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  Register-ScheduledTask -TaskName "Hearth" -Action $action -Trigger $trigger -Force `
    -Description "Starts Hearth when you sign in." | Out-Null

  Say "Starting"
  StartHearth
  $port = (Select-String -Path $Control -Pattern 'DC_PORT = "(\d+)"').Matches[0].Groups[1].Value
  $up = $false
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break }
    catch { Start-Sleep -Seconds 1 }
  }
  if (-not $up) {
    if (Test-Path (Join-Path $HearthHome "hearth.err.log")) { Get-Content (Join-Path $HearthHome "hearth.err.log") -Tail 30 }
    if (Test-Path $Previous) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $Control stop | Out-Null
      Remove-Item -Recurse -Force $App
      Move-Item $Previous $App
      StartHearth
      Write-Host "Put the previous version back and started it."
    }
    Fail "Hearth did not start. The messages above say why."
  }
  if (Test-Path $Previous) { Remove-Item -Recurse -Force $Previous }

  # --- The Hearth app: its own window (no tabs or address bar), from the Start menu and desktop ----
  # A joined PC opens your main Hearth, where its projects and systems are.
  $appUrl = "http://localhost:$port"
  if ($env:HEARTH_JOIN) { $appUrl = ([Uri]$env:HEARTH_JOIN).GetLeftPart([UriPartial]::Authority) }
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  $browser = if ($chrome) { $chrome } else { $edge }
  $ico = Join-Path $HearthHome "hearth.ico"
  try {
    Add-Type -AssemblyName System.Drawing
    $png = [Drawing.Bitmap]::FromFile((Join-Path $App "apps\web\dist\icon-192.png"))
    $small = New-Object Drawing.Bitmap $png, 128, 128
    $icon = [Drawing.Icon]::FromHandle($small.GetHicon())
    $fs = [IO.File]::Create($ico); $icon.Save($fs); $fs.Close(); $png.Dispose()
  } catch { $ico = $null }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($dir in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "Hearth.lnk"))
    # Its own browser profile makes it its own app on the taskbar (Hearth's icon, pinnable).
    $profileDir = Join-Path $HearthHome "app-window"
    if ($browser) {
      $lnk.TargetPath = $browser
      # window=app: Hearth knows it is in its own window, not a browser tab.
      $lnk.Arguments = "--user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required --app=$appUrl/?window=app"
    }
    else { $lnk.TargetPath = $appUrl }
    if ($ico) { $lnk.IconLocation = $ico }
    $lnk.Description = "Hearth: your homelab, with Ember"
    $lnk.Save()
    # Windows groups a window under the shortcut with the same taskbar ID. Chrome gives an app
    # window "Chrome.<host>_<path>.appwindow.Default"; without the same ID on the shortcut, a
    # pinned Hearth shows Chrome's icon.
    if ($browser) {
      $u = [Uri]$appUrl
      $prefix = if ($browser -eq $chrome) { "Chrome" } else { "MSEdge" }
      try { SetTaskbarId (Join-Path $dir "Hearth.lnk") "$prefix.$($u.Host)_$($u.AbsolutePath).appwindow.Default" } catch { }
    }
  }
  # hearth:// links open Hearth's own window: Hearth in a browser tab on this PC offers "Open the
  # Hearth app" (11-22, the owner: nothing told a beginner an app landed on their PC).
  if ($browser) {
    $opener = Join-Path $HearthHome "open-hearth.ps1"
    @"
# Opens a hearth://open/<page> link in Hearth's own window. Only a plain page path is kept.
param([string]`$Link = "")
`$page = `$Link -replace '^hearth://open', ''
if (`$page -notmatch '^/[A-Za-z0-9/_.?=&%-]*$') { `$page = "/" }
`$sep = if (`$page.Contains("?")) { "&" } else { "?" }
Start-Process -FilePath "$browser" -ArgumentList @("--user-data-dir=```"$profileDir```"", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--app=$appUrl`$page`${sep}window=app")
"@ | Set-Content -Encoding utf8 $opener
    $key = "HKCU:\Software\Classes\hearth"
    New-Item -Path "$key\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(default)" -Value "URL:Hearth"
    Set-ItemProperty -Path $key -Name "URL Protocol" -Value ""
    Set-ItemProperty -Path "$key\shell\open\command" -Name "(default)" -Value "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$opener`" `"%1`""
  }
  Write-Host "Hearth is in your Start menu and on your desktop: it opens in its own window."

  $link = (& powershell -NoProfile -ExecutionPolicy Bypass -File $Control url | Out-String).Trim()
  if ($env:HEARTH_JOIN) {
    for ($i = 0; $i -lt 20 -and (Test-Path (Join-Path $HearthHome "data\join-link")); $i++) { Start-Sleep -Seconds 1 }
    Say "Hearth is installed and joined your Hearth."
    Write-Host "This PC now shows up there, under PCs and devices. Use Hearth from there, on any device."
  } elseif ($link -match "setup\?code=") {
    Say "Hearth is running. Finish setting it up here:"
    Write-Host ""
    Write-Host "    $link"
    Write-Host ""
    Start-Process $link
  } else {
    Say "Hearth is updated and running. Sign in as usual at $link"
  }
  Write-Host "Start, stop, or check it: powershell -File `"$Control`" start|stop|status|url"
} finally {
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
  if ($HaveLock) { $Lock.ReleaseMutex() }
}
