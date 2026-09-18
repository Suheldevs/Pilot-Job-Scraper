@echo off
REM Auto-scrape wrapper, run by the "Pilot scrape" scheduled task every 6h.
REM Credentials come from .push-credentials (gitignored) so the passphrase is
REM never baked into the task definition or the log.

setlocal
cd /d "%~dp0"

if not exist ".push-credentials" (
  echo [%DATE% %TIME%] .push-credentials missing - cannot run >> scrape.log
  exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%a in (".push-credentials") do set "%%a=%%b"

REM push.py needs all three of these. Since the dashboard went multi-tenant,
REM JO_EMAIL is required too - an older .push-credentials with only JO_URL and
REM JO_PASSWORD makes push.py exit at argument parsing before it scrapes
REM anything. Name the missing one plainly here instead of leaving a bare
REM "error: --email required" buried in the log.
set "MISSING="
if not defined JO_URL      set "MISSING=%MISSING% JO_URL"
if not defined JO_EMAIL    set "MISSING=%MISSING% JO_EMAIL"
if not defined JO_PASSWORD set "MISSING=%MISSING% JO_PASSWORD"
if defined MISSING (
  echo. >> scrape.log
  echo ======== [%DATE% %TIME%] scrape aborted ======== >> scrape.log
  echo .push-credentials is missing:%MISSING% >> scrape.log
  echo Add the missing line(s) to .push-credentials, e.g. JO_EMAIL=you@example.com >> scrape.log
  echo (the dashboard is multi-tenant now - JO_EMAIL picks whose leads these become.) >> scrape.log
  exit /b 1
)

echo. >> scrape.log
echo ======== [%DATE% %TIME%] scrape start ======== >> scrape.log

REM -u keeps stdout unbuffered so scrape.log shows progress live instead of
REM staying empty until the run ends (or losing everything if it's killed).
REM Prune first so a stale lead can't block a fresh one on the same id.
REM Every source runs. The relevance gate (right role, right level, right
REM city) does the real filtering; --min-grade C only trims the D tail of
REM agency reposts and stale listings. Tighten to B or A for a shorter list,
REM or add --require-contact to see only leads you can actually reach.
"%~dp0venv\Scripts\python.exe" -u push.py --min-grade C --prune-days 10 --max-probes 25 >> scrape.log 2>&1
set RC=%ERRORLEVEL%

echo ======== [%DATE% %TIME%] scrape end (exit %RC%) ======== >> scrape.log

REM Keep the log from growing without bound (trim to the last ~2000 lines).
powershell -NoProfile -Command ^
  "if ((Get-Item 'scrape.log').Length -gt 2MB) { $t = Get-Content 'scrape.log' -Tail 2000; Set-Content 'scrape.log' $t -Encoding utf8 }"

exit /b %RC%
