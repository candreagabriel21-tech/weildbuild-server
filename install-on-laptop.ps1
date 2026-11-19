# ═══════════════════════════════════════════════════════════
# WeildBuild Bridge, laptop setup (Windows 10/11, PowerShell)
# ═══════════════════════════════════════════════════════════
# ONE-TIME setup. Run in PowerShell as Administrator. It will:
#   1. install Node.js + PostgreSQL (via winget) if missing
#   2. create the `weildbuild` database + role
#   3. write the .env the bridge worker reads
#   4. `npm install` + `prisma generate` + `prisma db push` + seed
#   5. register a Scheduled Task that auto-starts the bridge at logon
#      and restarts it every minute if it ever crashes
#
# Nothing here touches Render, your desktop app, or the internet.
# It only sets up the laptop. You can re-run it safely (it skips what
# is already done).
#
# Usage:  right-click → Run with PowerShell   (or)
#         powershell -ExecutionPolicy Bypass -File .\install-on-laptop.ps1
# ═══════════════════════════════════════════════════════════

#requires -Version 5.1
[CmdletBinding()]
param(
    [string] $RenderUrl       = "https://weildbuild-main.onrender.com",  # ← your Render main URL
    [string] $InternalToken   = "",                                       # ← paste the INTERNAL_TOKEN from Render
    [string] $ServerRepoDir   = "$env:USERPROFILE\weildbuild-server",     # ← where you cloned/copied server/
    [string] $StorageDir      = "",                                       # ← blank = auto (D:\wb-storage if D: else C:\wb-storage)
    [string] $PgPassword      = ""                                        # ← blank = prompt
)

$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)    { Write-Host "  ✓ $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die($m)   { Write-Host "  ✗ $m" -ForegroundColor Red; exit 1 }

Write-Host @"
╔══════════════════════════════════════════════════════════╗
║  WeildBuild Bridge — laptop setup                        ║
║  Installs Postgres + Node, writes .env, registers task.  ║
╚══════════════════════════════════════════════════════════╝
"@ -ForegroundColor White

if (-not $InternalToken) {
    $InternalToken = Read-Host "Paste the INTERNAL_TOKEN from Render env vars"
    if (-not $InternalToken) { Die "INTERNAL_TOKEN is required (it's on Render → main → Environment)." }
}
if (-not $PgPassword) {
    $PgPassword = Read-Host "Postgres superuser password (the one you set during install, or pick one now)"
    if (-not $PgPassword) { Die "A Postgres password is required." }
}
if (-not $StorageDir) {
    $StorageDir = if (Test-Path "D:\") { "D:\wb-storage" } else { "C:\wb-storage" }
}

# ── 1. winget available? ──
Step "1/5  Check package manager"
$winget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $winget) { Die "winget is missing. Open Microsoft Store → install 'App Installer', then re-run." }
Ok "winget found"

# ── 2. Node.js ──
Step "2/5  Node.js"
if (Get-Command node -ErrorAction SilentlyContinue) {
    Ok "Node $(node -v) already installed"
} else {
    Warn "Installing Node.js LTS via winget (click through the installer if it prompts)..."
    winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node install finished but `node` not on PATH. Reboot, then re-run." }
    Ok "Node $(node -v) installed"
}

# ── 3. PostgreSQL ──
Step "3/5  PostgreSQL"
if (Get-Command psql -ErrorAction SilentlyContinue) {
    Ok "psql already available"
} else {
    Warn "Installing PostgreSQL 17 via winget. The installer will ask for a superuser password — USE THE SAME ONE you typed above."
    Warn "(If you already typed a password above, just re-type the same one in the installer.)"
    winget install -e --id PostgreSQL.PostgreSQL.17 --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (-not (Get-Command psql -ErrorAction SilentlyContinue)) { Die "Postgres installed but `psql` not on PATH. Reboot, then re-run." }
    Ok "psql available"
}

# Create weildbuild role + database (idempotent)
$env:PGPASSWORD = $PgPassword
$psqlArgs = "-U", "postgres", "-h", "localhost", "-p", "5432", "-tAc"
& psql @psqlArgs "SELECT 1 FROM pg_roles WHERE rolname='weildbuild'" | Out-Null
if ($LASTEXITCODE -ne 0) { Die "Can't connect to Postgres as `postgres`. Check the password and that the service is running (services.msc → postgresql-x64-17)." }
$roleExists = & psql @psqlArgs "SELECT 1 FROM pg_roles WHERE rolname='weildbuild'"
if ($roleExists -notmatch "1") {
    & psql -U postgres -h localhost -p 5432 -c "CREATE ROLE weildbuild LOGIN PASSWORD '$PgPassword'" | Out-Null
    Ok "created role `weildbuild`"
} else { Ok "role `weildbuild` already exists" }
$dbExists = & psql @psqlArgs "SELECT 1 FROM pg_database WHERE datname='weildbuild'"
if ($dbExists -notmatch "1") {
    & psql -U postgres -h localhost -p 5432 -c "CREATE DATABASE weildbuild OWNER weildbuild" | Out-Null
    Ok "created database `weildbuild`"
} else { Ok "database `weildbuild` already exists" }
Remove-Item Env:\PGPASSWORD

# ── 4. Server repo + migrations ──
Step "4/5  Server repo + schema"
if (-not (Test-Path $ServerRepoDir)) { Die "Server repo not found at $ServerRepoDir. Copy the `server/` folder there first (or pass -ServerRepoDir)." }
Ok "server repo: $ServerRepoDir"

# Drop the bridge worker in if it isn't there already
$bridgeSrc = Join-Path $PSScriptRoot "laptop-bridge.mjs"
$bridgeDst = Join-Path $ServerRepoDir "laptop-bridge.mjs"
if ((Test-Path $bridgeSrc) -and (-not (Test-Path $bridgeDst))) {
    Copy-Item $bridgeSrc $bridgeDst
    Ok "copied laptop-bridge.mjs into server repo"
}

Push-Location $ServerRepoDir
try {
    Write-Host "  npm install (this takes a few minutes the first time)..."
    npm install --no-audit --no-fund 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Die "npm install failed." }
    Ok "dependencies installed"

    & npx prisma generate 2>&1 | Out-Null
    Ok "prisma client generated"

    $env:DATABASE_URL = "postgresql://weildbuild:$PgPassword@localhost:5432/weildbuild"
    & npx prisma db push 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Die "prisma db push failed. Is the weildbuild database created?" }
    Ok "schema pushed to local Postgres"

    $userCount = & psql -U weildbuild -h localhost -p 5432 -d weildbuild -tAc "SELECT count(*) FROM users" 2>$null
    if ($userCount -notmatch "\d" -or [int]$userCount -eq 0) {
        Warn "database is empty, seeding..."
        npm run seed 2>&1 | Out-Host
        Ok "seeded"
    } else {
        Ok "database already has $userCount users, skipping seed"
    }
} finally {
    Pop-Location
    Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
}

# ── 5. .env + scheduled task ──
Step "5/5  .env + auto-start"
$envFile = Join-Path $ServerRepoDir ".env"
@"
RENDER_URL=$RenderUrl
INTERNAL_TOKEN=$InternalToken
DATABASE_URL=postgresql://weildbuild:$PgPassword@localhost:5432/weildbuild
STORAGE_DIR=$StorageDir
"@ | Set-Content -Path $envFile -Encoding UTF8
Ok "wrote $envFile"

New-Item -ItemType Directory -Path $StorageDir -Force | Out-Null
Ok "storage folder: $StorageDir"

# Register the bridge as a Scheduled Task: start at logon, restart forever.
$taskName = "WeildBuildBridge"
$action    = New-ScheduledTaskAction -Execute "node" -Argument "laptop-bridge.mjs" -WorkingDirectory $ServerRepoDir
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -DontStopOnIdleEnd
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Ok "scheduled task '$taskName' registered (starts at logon, restarts on crash)"

# Start it now
Start-ScheduledTask -TaskName $taskName
Ok "bridge started"

Write-Host @"

╔══════════════════════════════════════════════════════════╗
║  DONE. The laptop is now the database + file storage.    ║
║                                                          ║
║  • Bridge is running in the scheduled task.              ║
║  • It polls Render every ~0s (long-poll, 25s hold).      ║
║  • Watch it live:  Get-Content $envFile                  ║
║    and logs:       Get-ScheduledTaskInfo WeildBuildBridge ║
║                                                          ║
║  Next: on Render, set USE_BRIDGE=1 and redeploy main.    ║
║  Then visit:  $RenderUrl/__bridge/status                 ║
║  → connected=true means the laptop is wired up.          ║
╚══════════════════════════════════════════════════════════╝
"@ -ForegroundColor White
