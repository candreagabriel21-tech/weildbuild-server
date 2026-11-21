@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title WeildBuild DB console

REM ═══════════════════════════════════════════════════════════
REM  WeildBuild bridge — DB console
REM ═══════════════════════════════════════════════════════════
REM  Opens a psql-like REPL against the local embedded Postgres,
REM  using the same DATABASE_URL the bridge uses (read from .env).
REM  No psql binary needed — uses node + prisma so it works on a
REM  clean laptop with only the bridge's npm deps installed.
REM
REM  Special commands inside the console:
REM    RESET        wipe the database (pgdata folder) and restart
REM                 the bridge with a fresh empty database. Same
REM                 password from .env. ASKS FOR CONFIRMATION.
REM    TABLES       list every table (the 16 the platform uses).
REM    HELP         show a few safe examples.
REM    EXIT / QUIT  close.
REM
REM  The DB password is read from .env. If .env is missing, run
REM  install.bat first — it writes .env for you.
REM ═══════════════════════════════════════════════════════════

if not exist ".env" (
    echo.
    echo  No .env file found in this folder.
    echo  Run install.bat first - it writes .env with the database
    echo  password and connection settings.
    echo.
    pause
    exit /b 1
)

node "%~dp0db-console.mjs"
pause
