"""Manual cross-platform scrape runner — same job as scrape.cmd, works on
Windows, macOS and Linux since it's plain Python instead of a batch file.

Usage:
    python scrape.py

Reads the same .push-credentials file as scrape.cmd (KEY=VALUE lines),
requires JO_URL, JO_EMAIL, JO_PASSWORD, and runs push.py with the same
flags scrape.cmd uses. Output is echoed to the console and appended to
scrape.log, same as the batch version.
"""
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CREDENTIALS_FILE = HERE / ".push-credentials"
LOG_FILE = HERE / "scrape.log"
REQUIRED = ["JO_URL", "JO_EMAIL", "JO_PASSWORD"]
LOG_MAX_BYTES = 2 * 1024 * 1024
LOG_KEEP_LINES = 2000


def load_credentials() -> dict:
    if not CREDENTIALS_FILE.exists():
        return {}
    env = {}
    for line in CREDENTIALS_FILE.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.strip().startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


def log(message: str) -> None:
    print(message)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(message + "\n")


def trim_log() -> None:
    if not LOG_FILE.exists() or LOG_FILE.stat().st_size <= LOG_MAX_BYTES:
        return
    lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    LOG_FILE.write_text("\n".join(lines[-LOG_KEEP_LINES:]) + "\n", encoding="utf-8")


def main() -> int:
    if not CREDENTIALS_FILE.exists():
        log(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] .push-credentials missing - cannot run")
        return 1

    creds = load_credentials()
    missing = [key for key in REQUIRED if not creds.get(key)]
    if missing:
        log("")
        log(f"======== [{time.strftime('%Y-%m-%d %H:%M:%S')}] scrape aborted ========")
        log(f".push-credentials is missing: {' '.join(missing)}")
        log("Add the missing line(s) to .push-credentials, e.g. JO_EMAIL=you@example.com")
        log("(the dashboard is multi-tenant now - JO_EMAIL picks whose leads these become.)")
        return 1

    log("")
    log(f"======== [{time.strftime('%Y-%m-%d %H:%M:%S')}] scrape start ========")

    import os
    env = {**os.environ, **creds}

    proc = subprocess.Popen(
        [sys.executable, "-u", str(HERE / "push.py"),
         "--min-grade", "C", "--prune-days", "10", "--max-probes", "25"],
        cwd=str(HERE), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    with LOG_FILE.open("a", encoding="utf-8") as f:
        for line in proc.stdout:
            print(line, end="")
            f.write(line)
    rc = proc.wait()

    log(f"======== [{time.strftime('%Y-%m-%d %H:%M:%S')}] scrape end (exit {rc}) ========")
    trim_log()
    return rc


if __name__ == "__main__":
    sys.exit(main())
