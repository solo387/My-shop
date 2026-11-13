@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then run this file again.
  pause
  exit /b
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo This shop needs Node.js 22.13 or newer. You have:
  node -v
  echo Download the LTS version from https://nodejs.org, install it, then run this file again.
  pause
  exit /b
)
echo Starting the shop... the admin page will open in your browser in a moment.
echo Keep this window open while the shop is running. Close it to stop the shop.
echo.
node --disable-warning=ExperimentalWarning server.js --open
echo.
echo The shop has stopped.
pause
