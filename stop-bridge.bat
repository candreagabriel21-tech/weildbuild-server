@echo off
REM ═══════════════════════════════════════════════════════════
REM  WeildBuild bridge — STOP
REM ═══════════════════════════════════════════════════════════
REM  Stops the bridge and its auto-restart keeper. The bridge
REM  comes back at your next logon (or via start-bridge.bat).
REM ═══════════════════════════════════════════════════════════
cd /d "%~dp0"
echo Stopping WeildBuild bridge...
type nul > stop-now.flag
taskkill /f /im node.exe >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq WeildBuild Bridge*" >nul 2>&1
timeout /t 3 /nobreak >nul
del stop-now.flag >nul 2>&1
del bridge.lock >nul 2>&1
echo Stopped. (It auto-starts again at next logon.)
pause
