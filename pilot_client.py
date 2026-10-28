"""Shared dashboard client for the PC-side scripts.

auto_apply.py, enrich_contacts.py, daily_summary.py and notify.py all sign in
the same way (the JO_* lines of .push-credentials, like push.py) and report
through the same notification endpoint, so that lives here once.
"""
import json
import os
import sys
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
CREDS = HERE / ".push-credentials"


def load_creds() -> dict:
    """KEY=value lines of .push-credentials, overridable from the environment."""
    env = {}
    if CREDS.exists():
        for line in CREDS.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip().removeprefix("export ").strip()] = v.strip()
    for k, v in os.environ.items():
        if k in env or k.startswith(("JO_", "GMAIL_", "RESUME_", "FIRECRAWL_")):
            env[k] = v
    return env


class Dashboard:
    def __init__(self, base: str, email_: str, password: str):
        self.base = base.rstrip("/")
        self.c = httpx.Client(timeout=60)
        r = self.c.post(f"{self.base}/api/login", json={"email": email_, "password": password},
                        follow_redirects=False)
        if r.status_code != 200 or not r.cookies.get("session"):
            sys.exit(f"dashboard login failed (HTTP {r.status_code})")
        self.c.cookies.set("session", r.cookies.get("session"))

    @classmethod
    def from_creds(cls, creds: dict | None = None) -> "Dashboard":
        creds = creds or load_creds()
        for k in ("JO_URL", "JO_EMAIL", "JO_PASSWORD"):
            if not creds.get(k):
                sys.exit(f"{k} missing from .push-credentials")
        return cls(creds["JO_URL"], creds["JO_EMAIL"], creds["JO_PASSWORD"])

    def get(self, path: str):
        r = self.c.get(self.base + path)
        r.raise_for_status()
        return r.json()

    def put(self, path: str, body: dict):
        r = self.c.put(self.base + path, json=body)
        r.raise_for_status()
        return r.json()

    def post(self, path: str, body: dict):
        r = self.c.post(self.base + path, json=body)
        r.raise_for_status()
        return r.json()

    def setting(self, key: str):
        v = self.get(f"/api/settings/{key}").get("value")
        return json.loads(v) if v else None

    def notify(self, kind: str, title: str, body: str = "", url: str = "/") -> None:
        """Feed entry + phone push. Never raises: a notification problem must not
        break the job that is reporting."""
        try:
            self.post("/api/notifications", {"action": "notify", "kind": kind, "title": title,
                                             "body": body[:1900], "url": url})
        except Exception as e:
            print(f"(notification not delivered: {e})", flush=True)
