@echo off
REM ═══════════════════════════════════════════════════════════
REM  WeildBuild Bridge — double-click launcher (manual start)
REM ═══════════════════════════════════════════════════════════
REM  Runs the bridge worker (and with it the local Postgres) in a
REM  window you can see. Use this for first-time testing or when
REM  you want to watch the log live. For 24/7 use, the hidden
REM  auto-start installed by install-on-laptop.ps1 keeps it running.
REM
REM  Safe even while the hidden bridge runs: this instance exits
REM  on its own if another one is already active.
REM ═══════════════════════════════════════════════════════════
cd /d "%~dp0"
title WeildBuild Bridge
echo Starting WeildBuild bridge (database + file storage)...
echo (Close this window to stop it. Fully stop the hidden one with stop-bridge.bat.)
echo.
node laptop-bridge.mjs
echo.
echo Bridge exited. Press any key to close.
pause >nul
