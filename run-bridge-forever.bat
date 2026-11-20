@echo off
REM ═══════════════════════════════════════════════════════════
REM  WeildBuild bridge keeper
REM ═══════════════════════════════════════════════════════════
REM  Starts the bridge and restarts it within 15 seconds if it
REM  ever crashes. Runs HIDDEN at every logon (installed in your
REM  Startup folder by install-on-laptop.ps1). You can also run
REM  this file directly to see it in a visible window.
REM
REM  Stop it with stop-bridge.bat. Double-clicking start-bridge.bat
REM  while this runs is safe: the second instance exits on its own.
REM ═══════════════════════════════════════════════════════════
title WeildBuild Bridge
cd /d "%~dp0"
:loop
if exist stop-now.flag (
    del stop-now.flag >nul 2>&1
    goto :eof
)
if exist bridge-log.txt (
    for %%A in (bridge-log.txt) do if %%~zA GTR 5000000 move /y bridge-log.txt bridge-log.old.txt >nul
)
node laptop-bridge.mjs >> bridge-log.txt 2>&1
REM v1.10.1 FIX: exit code 3 used to STOP the keeper ("another instance is
REM running"). That meant: close a visible start-bridge window and the
REM auto-restart was dead until the next logon. Now the keeper simply waits
REM and tries again — when the other instance closes, the bridge comes back
REM on its own. This also removes the visible-window race that made manual
REM starts look alternatingly "successful" and broken.
timeout /t 15 /nobreak >nul
goto loop
