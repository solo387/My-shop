@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org ^(LTS version^), install it, then run this file again.
  pause
  exit /b
)
start "" http://localhost:4080/admin
node server.js
pause
