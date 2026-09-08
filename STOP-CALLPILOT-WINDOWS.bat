@echo off
taskkill /F /IM electron.exe >nul 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000') do taskkill /F /PID %%a >nul 2>nul
echo CallPilot stopped.
pause
