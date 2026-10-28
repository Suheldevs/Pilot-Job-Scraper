@echo off
REM Morning "apply by hand" reminder, run by the "Pilot apply reminder" task.
setlocal
cd /d "%~dp0"
echo. >> scrape.log
echo ======== [%DATE% %TIME%] apply reminder ======== >> scrape.log
"%~dp0venv\Scripts\python.exe" -u remind.py >> scrape.log 2>&1
exit /b %ERRORLEVEL%
