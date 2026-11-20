@echo off
REM ═══════════════════════════════════════════════════════════
REM  WeildBuild Bridge — double-click launcher (manual start)
REM ═══════════════════════════════════════════════════════════
REM  Runs the bridge worker (and with it the local Postgres) in a
REM  window you can see. Use this for first-time testing or when
REM  you want to watch the log live. For 24/7 use, the scheduled
REM  task set up by install-on-laptop.ps1 is what keeps it running.
REM ═══════════════════════════════════════════════════════════
cd /d "%~dp0"
title WeildBuild Bridge
echo Starting WeildBuild bridge (database + file storage)...
echo (Close this window to stop it. Auto-restart is via the scheduled task.)
echo.
node laptop-bridge.mjs
echo.
echo Bridge exited. Press any key to close.
pause >nul
