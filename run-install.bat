@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title WeildBuild laptop installer
echo.
echo  ============================================================
echo   WeildBuild laptop installer  (self-hosted DB + files)
echo  ============================================================
echo   - This window will NOT close on error. If something fails,
echo     it stays open and shows you exactly what went wrong.
echo   - Everything is saved to install-log.txt in this folder.
echo   - Needs NO administrator rights. It installs Node.js only
echo     if missing, and never installs PostgreSQL: the database
echo     ships with the project and runs from this folder.
echo  ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-on-laptop.ps1"
echo.
echo  ============================================================
echo   Installer finished. Full transcript:
echo   %~dp0install-log.txt
echo  ============================================================
echo.
pause
