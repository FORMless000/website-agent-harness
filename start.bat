@echo off
setlocal
rem Run from this script's directory; the server loads .env itself.
pushd "%~dp0" || exit /b 1

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo Node.js 20.20+ and npm are required.
  popd
  pause
  exit /b 1
)
if not exist "node_modules\tsx\package.json" (
  echo Dependencies are missing. Run npm ci in this directory first.
  popd
  pause
  exit /b 1
)

call npm.cmd start -- %*
set "harness_exit_code=%errorlevel%"
popd
if not "%harness_exit_code%"=="0" pause
exit /b %harness_exit_code%
