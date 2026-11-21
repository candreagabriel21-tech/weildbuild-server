@echo off
REM ═══════════════════════════════════════════════════════════
REM  WeildBuild bridge — STOP (clean)
REM ═══════════════════════════════════════════════════════════
REM  Stops ONLY the bridge node process, not every node.exe on the
REM  machine. The old stop.bat ran `taskkill /f /im node.exe` which
REM  nuked VS Code's TypeScript server, any dev server you had
REM  open, and anything else running node — brutal. This one uses
REM  wmic to find node.exe processes whose command line contains
REM  this folder, and kills only those.
REM
REM  The bridge comes back at your next logon (the scheduled task
REM  the installer created). Re-run start.bat to start it now.
REM ═══════════════════════════════════════════════════════════
cd /d "%~dp0"
echo Stopping the WeildBuild bridge (only this folder's node.exe)...
set "HERE=%CD%"
set "HERE_ESC=%HERE:\=\\%"
wmic process where "name='node.exe' and CommandLine like '%%laptop-bridge.mjs%%'" get ProcessId 2>nul | findstr /r "[0-9]" > pid.txt
for /f %%P in (pid.txt) do (
    echo   killing bridge node.exe PID %%P
    taskkill /f /pid %%P >nul 2>&1
)
del pid.txt >nul 2>&1
echo Stopped. (It auto-starts again at next logon.)
echo To start it now: double-click start.bat
pause
