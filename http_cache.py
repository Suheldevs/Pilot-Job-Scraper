"""Conditional-request cache and per-source circuit breaker.

Two pieces of politeness that also make us faster:

*Conditional requests* — we store each URL's `Last-Modified` / `ETag` and send
them back as `If-Modified-Since` / `If-None-Match`. Verified live: Naukri's
sitemaps answer `304` with an empty body instead of 637 KB (they honour
`Last-Modified` but not their own ETag), and SmartRecruiters answers `304` to
`If-None-Match`. Polling daily then costs almost nothing.

*Circuit breaker* — when a source refuses us repeatedly, stop asking for a
while. This replaces the ad-hoc `consecutive_blocks` counter that lived inside
the Naukri source, which reset on any success and carried nothing between runs.
State is persisted, so a blocked source stays skipped across the 6-hourly runs
rather than being retried from scratch every time.
"""
import json
import os
import time
from typing import Dict, Optional, Tuple

STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".http-state.json")


def _load() -> dict:
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except OSError:
        pass  # a cache we can't persist is a slower run, not a failed one


class HttpState:
    """Validator cache + breaker state, persisted to one JSON file."""

    def __init__(self) -> None:
        raw = _load()
        self.validators: Dict[str, dict] = raw.get("validators", {})
        self.breakers: Dict[str, dict] = raw.get("breakers", {})

    def save(self) -> None:
        _save({"validators": self.validators, "breakers": self.breakers})

    # ---- conditional requests ------------------------------------------
    def conditional_headers(self, url: str) -> Dict[str, str]:
        entry = self.validators.get(url)
        if not entry:
            return {}
        headers = {}
        if entry.get("last_modified"):
            headers["If-Modified-Since"] = entry["last_modified"]
        if entry.get("etag"):
            headers["If-None-Match"] = entry["etag"]
        return headers

    def remember(self, url: str, resp) -> None:
        last_modified = resp.headers.get("last-modified")
        etag = resp.headers.get("etag")
        if not last_modified and not etag:
            return
        self.validators[url] = {
            "last_modified": last_modified,
            "etag": etag,
            "seen_at": int(time.time()),
        }

    # ---- circuit breaker -----------------------------------------------
    def can_request(self, source: str) -> Tuple[bool, Optional[str]]:
        b = self.breakers.get(source)
        if not b:
            return True, None
        if b.get("state") != "open":
            return True, None
        opened_at = b.get("opened_at", 0)
        cooldown = b.get("cooldown", 1800)
        remaining = int(opened_at + cooldown - time.time())
        if remaining <= 0:
            # half-open: allow one probe through to test recovery
            b["state"] = "half_open"
            return True, None
        return False, f"circuit open, {remaining}s left"

    def record_success(self, source: str) -> None:
        self.breakers[source] = {"state": "closed", "failures": 0}

    def record_failure(self, source: str, threshold: int = 4,
                       cooldown: int = 1800) -> None:
        b = self.breakers.setdefault(source, {"state": "closed", "failures": 0})
        b["failures"] = b.get("failures", 0) + 1
        if b["failures"] >= threshold or b.get("state") == "half_open":
            b["state"] = "open"
            b["opened_at"] = int(time.time())
            b["cooldown"] = cooldown
