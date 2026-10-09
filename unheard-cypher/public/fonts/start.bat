@echo off
   cd /d "%~dp0..\.."
if not exist node_modules call npm install
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
node server.js
pause