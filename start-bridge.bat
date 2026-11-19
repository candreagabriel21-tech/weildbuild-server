@echo off
REM ═══════════════════════════════════════════════════════════
REM  WeildBuild Bridge — double-click launcher (manual start)
REM ═══════════════════════════════════════════════════════════
REM  Runs the bridge worker in a window you can see. Use this for
REM  first-time testing. For 24/7 use, the scheduled task set up by
REM  install-on-laptop.ps1 is what actually keeps it running.
REM
REM  Put this file in the SAME folder as laptop-bridge.mjs (the
REM  server repo root) and double-click it.
REM ═══════════════════════════════════════════════════════════
cd /d "%~dp0"
title WeildBuild Bridge
echo Starting WeildBuild bridge worker...
echo (Close this window to stop it. Auto-restart is via the scheduled task.)
echo.
node laptop-bridge.mjs
echo.
echo Bridge exited. Press any key to close.
pause >nul
