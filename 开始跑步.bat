@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === happyrun formal run (3km smart pace) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "happyrun\start.ps1" %*
pause
