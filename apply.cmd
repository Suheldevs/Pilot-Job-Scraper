@echo off
REM Auto-apply sender, run by the "Pilot apply 11am" and "Pilot apply 6pm" tasks.
REM It does nothing unless switched on in the dashboard (Data -> Auto-apply).
setlocal
cd /d "%~dp0"
echo. >> scrape.log
echo ======== [%DATE% %TIME%] auto-apply ======== >> scrape.log
"%~dp0venv\Scripts\python.exe" -u auto_apply.py >> scrape.log 2>&1
exit /b %ERRORLEVEL%
