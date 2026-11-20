@echo off
REM ═══════════════════════════════════════════════════════════
REM  WeildBuild Bridge — RESET the local database (fresh + empty)
REM ═══════════════════════════════════════════════════════════
REM  Use this if the local database is broken or you lost track of
REM  its state. It DELETES the local data folder (pgdata). The next
REM  time the bridge starts it creates a fresh empty database with
REM  the SAME password from .env - no prompts, nothing else to do.
REM
REM  !! This wipes ALL local accounts/games/files-in-DB. Uploaded
REM  !! files in wb-storage are NOT touched.
REM ═══════════════════════════════════════════════════════════
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title WeildBuild local DB reset
echo.
echo  This deletes the local database data folder (pgdata) and
echo  restarts the bridge with a fresh, EMPTY database.
echo
set /p CONFIRM=Type YES to continue:
if /i not "%CONFIRM%"=="YES" (
    echo Cancelled - nothing was changed.
    pause
    exit /b 0
)
echo.
echo Stopping the bridge task...
schtasks /End /TN WeildBuildBridge >nul 2>&1
taskkill /f /im node.exe >nul 2>&1
timeout /t 3 /nobreak >nul
if exist pgdata (
    rmdir /s /q pgdata
    echo Deleted pgdata.
) else (
    echo No pgdata folder found - nothing to delete.
)
echo Starting the bridge again...
schtasks /Run /TN WeildBuildBridge >nul 2>&1
echo.
echo Done. On the next start the bridge rebuilds the schema
echo automatically. Check bridge-log.txt or open
echo https://your-main-server.onrender.com/__bridge/status
echo.
pause
