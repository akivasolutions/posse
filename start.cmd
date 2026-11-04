@echo off
REM Bullpen launcher for Windows. Double-click to start, then use the browser tab that opens.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and try again. & pause & exit /b 1)
node server.js --open
pause
