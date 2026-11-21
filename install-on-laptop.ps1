# ═══════════════════════════════════════════════════════════
# WeildBuild Bridge — laptop setup (Windows 10/11, PowerShell 5.1+)
# ═══════════════════════════════════════════════════════════
# HOW TO RUN:  double-click  install.bat  in this same folder.
#
# What it does (4 steps, no admin anywhere):
#   1. install Node.js (via winget) if missing — the ONLY install
#   2. npm install inside the server folder (also fetches the
#      embedded Postgres binaries — they are npm packages)
#   3. write .env (RENDER_URL, INTERNAL_TOKEN, STORAGE_DIR and the
#      local Postgres settings; keeps an existing PG_PASSWORD)
#   4. create a logon auto-start scheduled task (user-scope, no
#      admin) that launches the bridge at every logon. The
#      watchdog is INSIDE the node process, not a separate .bat
#      loop — so there is no `run-bridge-forever.bat` and no
#      "ghost" keeper process. Crash-restart is handled by the
#      node process's own supervisor loop.
#   5. start the bridge now (hidden, by the scheduled task)
#
# Re-run any time - it skips anything already done.
# ═══════════════════════════════════════════════════════════

#requires -Version 5.1
[CmdletBinding()]
param(
    [string] $RenderUrl     = "https://weildbuild-server.onrender.com",
    [string] $InternalToken = "",
    [string] $ServerRepoDir = "",
    [string] $StorageDir    = ""
)

$ErrorActionPreference = "Stop"

# Resolve this script's own folder WITHOUT trusting $PSScriptRoot alone.
$scriptDir = $PSScriptRoot
if (-not $scriptDir -and $MyInvocation.MyCommand.Definition) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
if (-not $scriptDir -and $PSCommandPath) { $scriptDir = Split-Path -Parent $PSCommandPath }
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
if (-not $ServerRepoDir) { $ServerRepoDir = $scriptDir }

$logFile = Join-Path $scriptDir "install-log.txt"
try { Start-Transcript -Path $logFile -Force -ErrorAction SilentlyContinue | Out-Null } catch {}

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !    $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  ERR  $m" -ForegroundColor Red; throw "SETUP FAILED: $m" }

# Read KEY=VALUE lines from an existing .env into a hashtable. Strips
# inline `# comments` and surrounding quotes (the original parser left
# `KEY=value # note` with the comment baked into the value).
function Read-EnvFile($path) {
    $map = @{}
    if (Test-Path $path) {
        foreach ($line in Get-Content $path) {
            if ($line -match "^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$") {
                $k = $Matches[1]
                $v = $Matches[2].Trim()
                $h = $v.IndexOf(" #")
                if ($h -ge 0) { $v = $v.Substring(0, $h).Trim() }
                $v = $v.Trim('"', "'")
                $map[$k] = $v
            }
        }
    }
    return $map
}

try {
  Write-Host @"
------------------------------------------------------------
 WeildBuild Bridge - laptop setup  (simplified)
 Server repo: $ServerRepoDir
 Transcript:  $logFile
------------------------------------------------------------
"@ -ForegroundColor White

  # 0. sanity: the server repo must contain package.json + laptop-bridge.mjs
  if (-not (Test-Path (Join-Path $ServerRepoDir "package.json"))) {
      Die "No package.json in $ServerRepoDir. Put install.bat + install-on-laptop.ps1 + laptop-bridge.mjs INSIDE the server folder (next to package.json), or pass -ServerRepoDir."
  }
  if (-not (Test-Path (Join-Path $ServerRepoDir "laptop-bridge.mjs"))) {
      Die "laptop-bridge.mjs is missing from $ServerRepoDir. Copy it from the rebuild zip next to install-on-laptop.ps1."
  }
  Ok "server repo looks valid (package.json + laptop-bridge.mjs present)"

  if (-not $InternalToken) {
      $InternalToken = Read-Host "Paste the INTERNAL_TOKEN from Render (Render dashboard -> weildbuild-server -> Environment)"
      if (-not $InternalToken) { Die "INTERNAL_TOKEN is required - the bridge and Render must share the same secret." }
  }
  if (-not $StorageDir) { $StorageDir = Join-Path $ServerRepoDir "wb-storage" }

  $envFile = Join-Path $ServerRepoDir ".env"
  $existing = Read-EnvFile $envFile

  # 1. Node.js
  Step "1/4  Node.js"
  if (Get-Command node -ErrorAction SilentlyContinue) {
      Ok "Node $(node -v) already installed"
  } else {
      $winget = Get-Command winget -ErrorAction SilentlyContinue
      if (-not $winget) { Die "Node.js is missing and winget is unavailable. Install Node.js LTS from https://nodejs.org , then re-run install.bat." }
      Warn "Installing Node.js LTS via winget (click Yes if Windows asks)..."
      winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
      if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node install finished but 'node' is not on PATH. Reboot, then re-run install.bat." }
      Ok "Node $(node -v) installed"
  }

  # 2. npm install
  Step "2/4  Dependencies (npm install)"
  Push-Location $ServerRepoDir
  try {
      if (Test-Path (Join-Path $ServerRepoDir "node_modules\.prisma\client\index.js")) {
          Ok "dependencies already installed (node_modules present)"
      } else {
          Write-Host "  npm install (a few minutes the first time)..."
          npm install --no-audit --no-fund 2>&1 | Out-Host
          if ($LASTEXITCODE -ne 0) { Die "npm install failed - see the output above." }
          Ok "dependencies installed (including the embedded Postgres binaries)"
      }
  } finally { Pop-Location }

  # 3. .env
  Step "3/4  Configuration (.env)"
  $pgPassword = $existing["PG_PASSWORD"]
  if (-not $pgPassword) {
      $chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray()
      $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
      $buf = New-Object byte[] 24
      $rng.GetBytes($buf)
      $pgPassword = ($buf | ForEach-Object { $chars[$_] % $chars.Length }) -join ""
      Ok "generated a fresh local Postgres password (stored in .env, you never type it)"
  } else {
      Ok "keeping the existing PG_PASSWORD from .env"
  }
  $pgDataDir = $existing["PG_DATA_DIR"]; if (-not $pgDataDir) { $pgDataDir = Join-Path $ServerRepoDir "pgdata" }
  $pgPort    = $existing["PG_PORT"];     if (-not $pgPort)    { $pgPort    = "5433" }   # 5433 dodges any old half-removed Postgres on 5432

  @"
RENDER_URL=$RenderUrl
INTERNAL_TOKEN=$InternalToken
STORAGE_DIR=$StorageDir
USE_EMBEDDED_PG=1
PG_PORT=$pgPort
PG_DATA_DIR=$pgDataDir
PG_PASSWORD=$pgPassword
DATABASE_URL=postgresql://postgres:$pgPassword@127.0.0.1:$pgPort/weildbuild
"@ | Set-Content -Path $envFile -Encoding UTF8
  Ok "wrote $envFile"

  New-Item -ItemType Directory -Path $StorageDir -Force | Out-Null
  Ok "file storage folder: $StorageDir  (uploads/backups/reports live here)"
  if (-not (Test-Path (Join-Path $pgDataDir "PG_VERSION"))) {
      Ok "local database will be created on first start: $pgDataDir"
  } else {
      Ok "existing local database found: $pgDataDir (left untouched)"
  }

  # 4. Auto-start at logon via a USER-scope scheduled task. The old
  # installer dropped a .vbs into the Startup folder (which anyone,
  # including a drive-by webpage via a text/plain form POST, can
  # reach on localhost:5490 in the OLD supervisor). The task
  # scheduler path is the standard Windows way and the task itself
  # only runs at logon, so there is no localhost control port to
  # attack. No admin is needed for a task that runs as the current
  # user.
  Step "4/4  Auto-start at logon"
  $taskName = "WeildBuildBridge"
  $bridgePath = Join-Path $ServerRepoDir "laptop-bridge.mjs"
  $nodePath = (Get-Command node).Source
  $cmd = "`"$nodePath`" `"$bridgePath`""

  # Remove any old task (and the old .vbs from the previous installer)
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  $oldVbs = Join-Path ([Environment]::GetFolderPath("Startup")) "start-weildbuild-bridge.vbs"
  if (Test-Path $oldVbs) { Remove-Item $oldVbs -Force; Ok "removed the old startup .vbs from the previous installer" }

  $action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$bridgePath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "WeildBuild laptop bridge (auto-start at logon)" -Force | Out-Null
  Ok "auto-start installed: scheduled task `"$taskName`" (runs hidden at every logon)"

  # 5. start it now (hidden, by the task)
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 3
  Ok "bridge started (hidden, by the scheduled task)"

  Write-Host @"

============================================================
 DONE - this laptop is now the database + file storage.

 * Postgres runs INSIDE the bridge process (embedded binaries,
   no service, no installer). Data folder: $pgDataDir
 * Uploaded files land in: $StorageDir
 * ONE PLACE TO LOOK: open http://localhost:7878 in a browser.
   That page tells you in plain English:
     - is the laptop's poll loop alive?
     - is the local database up?
     - does Render see this laptop? (connected: true/false)
   If Render says "connected:false", wait 30s and refresh —
   the laptop just hasn't polled yet. If it stays false, your
   INTERNAL_TOKEN in .env does not match Render's.
 * Stop it:   double-click  stop.bat
 * DB console: double-click  db.bat   (type RESET to wipe + restart)
 * Re-run install.bat after any change (it is idempotent).
============================================================
"@ -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  SETUP FAILED - see the error below." -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "  The full transcript is saved in: $logFile" -ForegroundColor Yellow
    Write-Host "  Copy the last ~30 lines above (or send that file)" -ForegroundColor Yellow
    Write-Host "  back and we will fix it together." -ForegroundColor Yellow
    Write-Host "============================================================" -ForegroundColor Red
}
finally {
    try { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null } catch {}
    Write-Host ""
    Read-Host "Press Enter to close this window"
}
