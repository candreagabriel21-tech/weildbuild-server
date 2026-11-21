@echo off
REM ═══════════════════════════════════════════════════════════
REM  WeildBuild Bridge — START (visible window with the live log)
REM ═══════════════════════════════════════════════════════════
REM  Runs the bridge worker (and with it the local Postgres + the
REM  status page) in a window you can see. Use this for first-time
REM  testing or when you want to watch the log live. For 24/7 use,
REM  the hidden auto-start scheduled task installed by
REM  install-on-laptop.ps1 keeps it running at every logon.
REM
REM  Safe even while the hidden bridge runs: the second instance
REM  exits on its own (the status port 7878 is already taken) and
REM  prints a clear message — no ghost, no race.
REM ═══════════════════════════════════════════════════════════
cd /d "%~dp0"
title WeildBuild Bridge
echo Starting WeildBuild bridge (database + file storage + status page)...
echo.
echo  Open http://localhost:7878 in a browser for the status page.
echo  Close this window OR press Ctrl+C to stop. For a fully clean
echo  stop of the hidden one too, run stop.bat.
echo.
node laptop-bridge.mjs
echo.
echo Bridge exited. Press any key to close.
pause >nul
