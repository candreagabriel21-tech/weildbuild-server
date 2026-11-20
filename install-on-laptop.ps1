# ═══════════════════════════════════════════════════════════
# WeildBuild Bridge — laptop setup (Windows 10/11, PowerShell 5.1+)
# ═══════════════════════════════════════════════════════════
# HOW TO RUN:  double-click  run-install.bat  in this same folder.
#   Keeps the window open on errors, saves a transcript to
#   install-log.txt, and sets ExecutionPolicy Bypass for you.
#
# ── WHAT CHANGED vs the old installer ────────────────────────
#  NO PostgreSQL installation. AT ALL. The database runs from
#  embedded Postgres binaries that ship inside the repo's npm
#  dependencies (node_modules). No installer, no Windows service,
#  no superuser password prompt, no psql, no PATH hunting, no
#  P1000/pg_hba errors. The password is generated here, written
#  to .env, and used once when the data folder is first created.
#  Forgot it / something's broken?  run reset-local-db.bat  →
#  a fresh empty database with the SAME password. Done.
#
# What it does:
#   1. install Node.js (via winget) if missing — the ONLY install
#   2. npm install inside the server folder (also fetches the
#      embedded Postgres binaries — they are npm packages)
#   3. write .env (RENDER_URL, INTERNAL_TOKEN, STORAGE_DIR and the
#      local Postgres settings; keeps an existing PG_PASSWORD)
#   4. install a hidden auto-start in YOUR Startup folder (no admin
#      needed anywhere) that launches the bridge at logon; the
#      keeper loop restarts it within 15s if it ever crashes
#   5. start the bridge now
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

# Resolve this script's own folder WITHOUT trusting $PSScriptRoot alone:
# on Windows PowerShell 5.1 it can come back empty, which made Join-Path
# crash with "Cannot bind argument to parameter 'Path'". Fall back hard.
$scriptDir = $PSScriptRoot
if (-not $scriptDir -and $MyInvocation.MyCommand.Definition) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
if (-not $scriptDir -and $PSCommandPath) { $scriptDir = Split-Path -Parent $PSCommandPath }
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }

# Default the server repo to this folder (where package.json lives).
if (-not $ServerRepoDir) { $ServerRepoDir = $scriptDir }

$logFile = Join-Path $scriptDir "install-log.txt"
try { Start-Transcript -Path $logFile -Force -ErrorAction SilentlyContinue | Out-Null } catch {}

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !    $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  ERR  $m" -ForegroundColor Red; throw "SETUP FAILED: $m" }

# Read KEY=VALUE lines from an existing .env into a hashtable.
function Read-EnvFile($path) {
    $map = @{}
    if (Test-Path $path) {
        foreach ($line in Get-Content $path) {
            if ($line -match "^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)\s*$") { $map[$Matches[1]] = $Matches[2].Trim('"',"'") }
        }
    }
    return $map
}

try {
  Write-Host @"
------------------------------------------------------------
 WeildBuild Bridge - laptop setup  (no-Postgres-installer edition)
 Server repo: $ServerRepoDir
 Transcript:  $logFile
------------------------------------------------------------
"@ -ForegroundColor White

  # 0. sanity: the server repo must contain package.json (catches the
  # "extracted one level too deep" mistake with a clear message instead of ENOENT)
  if (-not (Test-Path (Join-Path $ServerRepoDir "package.json"))) {
      Die "No package.json in $ServerRepoDir. Put run-install.bat + install-on-laptop.ps1 + laptop-bridge.mjs INSIDE the server folder (next to package.json), or pass -ServerRepoDir."
  }
  if (-not (Test-Path (Join-Path $ServerRepoDir "laptop-bridge.mjs"))) {
      Die "laptop-bridge.mjs is missing from $ServerRepoDir. Copy it from the zip next to install-on-laptop.ps1."
  }
  Ok "server repo looks valid (package.json + laptop-bridge.mjs present)"

  if (-not $InternalToken) {
      $InternalToken = Read-Host "Paste the INTERNAL_TOKEN from Render (Render dashboard -> weildbuild-server -> Environment)"
      if (-not $InternalToken) { Die "INTERNAL_TOKEN is required - the bridge and Render must share the same secret." }
  }
  if (-not $StorageDir) { $StorageDir = Join-Path $ServerRepoDir "wb-storage" }

  $envFile = Join-Path $ServerRepoDir ".env"
  $existing = Read-EnvFile $envFile

  # 1. Node.js — the only thing we ever install
  Step "1/4  Node.js"
  if (Get-Command node -ErrorAction SilentlyContinue) {
      Ok "Node $(node -v) already installed"
  } else {
      $winget = Get-Command winget -ErrorAction SilentlyContinue
      if (-not $winget) { Die "Node.js is missing and winget is unavailable. Install Node.js LTS from https://nodejs.org , then re-run run-install.bat." }
      Warn "Installing Node.js LTS via winget (click Yes if Windows asks)..."
      winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
      if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node install finished but 'node' is not on PATH. Reboot, then re-run run-install.bat." }
      Ok "Node $(node -v) installed"
  }

  # 2. npm install — also fetches the embedded Postgres binaries
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

  # 3. .env — keep an existing PG_PASSWORD so an existing data folder keeps working
  Step "3/4  Configuration (.env)"
  $pgPassword = $existing["PG_PASSWORD"]
  if (-not $pgPassword) {
      # letters+digits only: safe inside a DATABASE_URL with no escaping
      $chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray()
      $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
      $buf = New-Object byte[] 24
      $rng.GetBytes($buf)
      $pgPassword = ($buf | ForEach-Object { $chars[$_] % $chars.Length }) -join ""
      Ok "generated a fresh local Postgres password (stored in .env, you never need to type it)"
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
  Ok "file storage folder: $StorageDir  (this is where uploads/backups/reports now live)"
  if (-not (Test-Path (Join-Path $pgDataDir "PG_VERSION"))) {
      Ok "local database will be created on first start: $pgDataDir"
  } else {
      Ok "existing local database found: $pgDataDir (left untouched)"
  }

  # 4. Auto-start at logon — via YOUR OWN Startup folder, NOT a scheduled
  # task. Registering a scheduled task needs account rights many standard
  # accounts don't have ("Access is denied" at exactly this step); the
  # Startup folder is user-writable by design and needs no admin at all.
  # Crash-restarts are handled by run-bridge-forever.bat (the keeper loop).
  Step "4/4  Auto-start at logon"
  $startupDir = [Environment]::GetFolderPath("Startup")
  if (-not $startupDir) { $startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup" }
  $vbsPath = Join-Path $startupDir "start-weildbuild-bridge.vbs"
  $repoPathVbs = $ServerRepoDir -replace "'", "''"
  @"
' WeildBuild bridge - hidden auto-start (created by install-on-laptop.ps1)
CreateObject("WScript.Shell").Run """$repoPathVbs\run-bridge-forever.bat""", 0, False
"@ | Set-Content -Path $vbsPath -Encoding Default
  Ok "auto-start installed: $vbsPath"
  Ok "(runs the bridge hidden at every logon; the keeper loop restarts it within 15s if it crashes)"

  # tidy up: remove the scheduled task from an OLDER setup, if it exists
  Unregister-ScheduledTask -TaskName "WeildBuildBridge" -Confirm:$false -ErrorAction SilentlyContinue

  # start it now (hidden), exactly like at the next logon
  & wscript.exe $vbsPath
  Start-Sleep -Seconds 2
  Ok "bridge started (logs: $(Join-Path $ServerRepoDir 'bridge-log.txt'))"

  Write-Host @"

============================================================
 DONE - this laptop is now the database + file storage.

 * Postgres runs INSIDE the bridge process (embedded binaries,
   no service, no installer). Data folder: $pgDataDir
 * Uploaded files land in: $StorageDir
 * Check it: open  $RenderUrl/__bridge/status  in a browser.
   -> "connected":true  means the laptop is wired up. The first
   sync can take a minute after a fresh boot.
 * The bridge runs hidden and auto-starts at every logon.
   - see it live:  double-click start-bridge.bat (window with log)
   - stop it:      double-click stop-bridge.bat
 * Your app now works while the laptop is ON. If the laptop is
   off, the backend is down (that is the deal with self-hosting).
 * If you ever MOVE the server folder, re-run run-install.bat
   so the auto-start points at the new location.
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
