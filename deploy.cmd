@echo off
REM Deploy Pilot with the latest changes. Double-click this, or run it from a
REM terminal. Pass --dry-run to check everything without uploading, or
REM --migrate to also apply migrations/*.sql to the remote database.

setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not on PATH. Install it from https://nodejs.org
  echo   ^(wrangler needs it too, so this is required.^)
  echo.
  pause
  exit /b 1
)

node deploy.mjs %*
set RC=%ERRORLEVEL%

echo.
if %RC%==0 (
  echo   Done.
) else (
  echo   Finished with errors ^(exit %RC%^) - see the output above.
)

REM Only pause when double-clicked, so it doesn't block a scripted run.
echo %CMDCMDLINE% | find /i "/c" >nul
if not errorlevel 1 pause

exit /b %RC%
