@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === happyrun dry-run check (no upload) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "happyrun\start.ps1" -DryRun
pause
