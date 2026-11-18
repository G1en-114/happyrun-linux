@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo   happyrun login capture
echo   Step 1: Click "Yes" in the UAC popup
echo   Step 2: Open the LeRun mini program in [PC WeChat] and log in
echo   Step 3: Capture window shows [login] written back to config.json = success
echo   Step 4: Close the capture window (Ctrl+C or close X directly)
echo ==============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "happyrun\capture\launch-capture.ps1"
echo.
echo After successful login, just double-click StartRun.bat to start your run.
pause
