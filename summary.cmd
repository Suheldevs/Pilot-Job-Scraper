@echo off
REM Daily 5pm summary, run by the "Pilot daily summary" scheduled task.
REM Sends today's numbers to the dashboard feed, the phone, and your Gmail.
setlocal
cd /d "%~dp0"
echo. >> scrape.log
echo ======== [%DATE% %TIME%] daily summary ======== >> scrape.log
"%~dp0venv\Scripts\python.exe" -u daily_summary.py >> scrape.log 2>&1
exit /b %ERRORLEVEL%
