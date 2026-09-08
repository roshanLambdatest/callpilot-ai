@echo off
setlocal
cd /d "%~dp0"
set ROOT=%CD%
if not exist .callpilot-logs mkdir .callpilot-logs
where python >nul 2>nul || (echo Python 3 is required.& pause & exit /b 1)
where npm >nul 2>nul || (echo Node.js/npm is required.& pause & exit /b 1)
if not exist backend\.env copy backend\.env.example backend\.env >nul
if not exist backend\.venv python -m venv backend\.venv
call backend\.venv\Scripts\activate.bat
python -m pip install -q -r backend\requirements.txt || (echo Python dependency install failed.& pause & exit /b 1)
pushd native-overlay
call npm install --silent || (popd & echo Overlay dependency install failed.& pause & exit /b 1)
popd
start "CallPilot Backend" /min cmd /c "cd /d "%ROOT%\backend" && "%ROOT%\backend\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 > "%ROOT%\.callpilot-logs\backend.log" 2>&1"
start "CallPilot Overlay" /min cmd /c "cd /d "%ROOT%\native-overlay" && npm start > "%ROOT%\.callpilot-logs\overlay.log" 2>&1"
timeout /t 3 /nobreak >nul
echo.
echo CallPilot is running. There is no Chrome extension in v4.3 - use your normal
echo Chrome, join the meeting, then click the CallPilot tray icon and choose Start Call.
pause
