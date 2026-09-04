@echo off
cd /d "%~dp0"
if not exist server.js (
  echo ERROR: server.js was not found.
  echo Please keep this start.bat in the same folder as server.js.
  pause
  exit /b 1
)
node server.js
pause
