"""Per-source scheduling for the scraper — "is this source fresh enough?"

Every source used to run on one 6-hour clock. That is wrong in both
directions: the Hacker News "who is hiring" thread is monthly, so a 6h poll
asks about 120x too often, while ATS boards change daily. `source_schedule`
(migrations/007) gives each source its own interval and this module is the
scraper-side half of it.

Deliberately NOT the same thing as `http_cache.py`:

    http_cache.py  circuit breaker   a source that is *failing*   -> back off
    scheduler.py   interval clock    a source that is *fresh*     -> skip

They are independent and neither reads the other's state. A source can be due
and still skipped by an open breaker; a source can be inside its interval and
have a perfectly healthy breaker. Merging them would mean a single failure
could silently change a source's cadence, which is exactly the confusion the
split avoids.

Failure policy: **fail open, always.** If the schedule API is missing, the
network is down, or the response is garbage, every source is reported as due
and the scrape runs exactly as it did before this file existed. A broken
scheduler must never be the reason a scrape collected nothing.
"""
import json
import os
import time
from typing import Dict, List, Optional, Tuple

import httpx

STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          ".schedule-state.json")

# Kept in step with the migration's seeds so an offline run still schedules
# sensibly instead of falling back to one flat interval for everything.
DEFAULT_INTERVALS: Dict[str, int] = {
    "naukri_sitemap": 360,
    "instahyre": 720,
    "greenhouse": 720,
    "lever": 720,
    "ashby": 720,
    "keka": 720,
    "remotive": 1440,
    "arbeitnow": 1440,
    "remoteok": 1440,
    "weworkremotely": 1440,
    "linkedin": 1440,
    "hackernews": 10080,
}

FALLBACK_INTERVAL_MINS = 360

# The HN "who is hiring" thread is posted once a month by the whoishiring bot.
# Polling on a clock is the wrong model for that; a new thread is an *event*.
HN_ALGOLIA_URL = ("https://hn.algolia.com/api/v1/search_by_date"
                  "?tags=story,author_whoishiring&hitsPerPage=1")

# One request, short timeout: this runs before the scrape and must never be
# the thing that makes a run hang.
PROBE_TIMEOUT = 10.0
API_TIMEOUT = 15.0


# ---------------------------------------------------------------------------
# local state (offline fallback + the HN thread marker)
# ---------------------------------------------------------------------------
def local_fallback() -> dict:
    """Read `.schedule-state.json`.

    Shape: {"runs": {"<source>": {"last_run_at": ms, "last_status": "ok"}},
            "hn": {"object_id": "...", "seen_at": ms}}

    A missing or corrupt file is an empty state, not an error — the worst case
    is that everything looks due, which is the safe direction.
    """
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {"runs": {}, "hn": {}}
    if not isinstance(data, dict):
        return {"runs": {}, "hn": {}}
    runs = data.get("runs")
    hn = data.get("hn")
    return {
        "runs": runs if isinstance(runs, dict) else {},
        "hn": hn if isinstance(hn, dict) else {},
    }


def _save_local(state: dict) -> None:
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except OSError:
        pass  # a schedule we can't persist means more frequent runs, not a failure


def _record_local(source: str, status: str) -> None:
    state = local_fallback()
    state["runs"][source] = {"last_run_at": int(time.time() * 1000),
                             "last_status": status}
    _save_local(state)


def _due_from_local(all_names: List[str]) -> Tuple[List[str], List[Tuple[str, str]]]:
    """Decide from local timestamps. Used when the API can't be reached."""
    state = local_fallback()
    now = int(time.time() * 1000)
    due: List[str] = []
    skipped: List[Tuple[str, str]] = []

    for name in all_names:
        entry = state["runs"].get(name) or {}
        last = entry.get("last_run_at")
        interval = DEFAULT_INTERVALS.get(name, FALLBACK_INTERVAL_MINS)
        if not isinstance(last, (int, float)) or last <= 0:
            due.append(name)
            continue
        next_due = last + interval * 60000
        if next_due <= now:
            due.append(name)
        else:
            skipped.append((name, f"next due in {human_delta(next_due - now)} "
                                  f"(local state, every {human_interval(interval)})"))
    return due, skipped


# ---------------------------------------------------------------------------
# formatting
# ---------------------------------------------------------------------------
def human_delta(ms: float) -> str:
    """`14400000` -> `4h`. Coarse on purpose — this goes in a skip line."""
    secs = max(0, int(ms / 1000))
    if secs < 60:
        return f"{secs}s"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m"
    hours = mins // 60
    if hours < 48:
        rem = mins % 60
        return f"{hours}h{rem}m" if rem else f"{hours}h"
    return f"{hours // 24}d"


def human_interval(mins: int) -> str:
    if mins % 1440 == 0:
        return f"{mins // 1440}d"
    if mins % 60 == 0:
        return f"{mins // 60}h"
    return f"{mins}m"


# ---------------------------------------------------------------------------
# the API-backed schedule
# ---------------------------------------------------------------------------
def due_sources(client: httpx.Client, base_url: str,
                all_names: List[str]) -> Tuple[List[str], List[Tuple[str, str]]]:
    """Split `all_names` into (due, skipped) using the schedule API.

    `skipped` is a list of `(source, reason)` so the caller can print why —
    "hackernews — next due in 4d" is far more useful than a silent omission.

    Never raises. On any failure it prints one warning and falls back: local
    timestamps if we have them, otherwise everything is due.
    """
    if not all_names:
        return [], []

    try:
        rows = _fetch_schedule(client, base_url)
    except Exception as e:
        # Fail open. One line, not a stack trace: this is a degraded mode, not
        # a crash, and the run continues normally.
        print(f"WARNING: schedule unavailable ({_short(e)}) — "
              f"falling back to local state, then to running everything.")
        return _due_from_local(all_names)

    now = int(time.time() * 1000)
    due: List[str] = []
    skipped: List[Tuple[str, str]] = []

    for name in all_names:
        row = rows.get(name)
        if row is None:
            # No schedule row = not managed = always run it. A source added to
            # pipeline.py before the migration ran must not vanish.
            due.append(name)
            continue

        if not row.get("enabled", True):
            skipped.append((name, "disabled in the schedule"))
            continue

        if row.get("due"):
            due.append(name)
            continue

        interval = int(row.get("interval_mins") or FALLBACK_INTERVAL_MINS)
        next_due = row.get("next_due_at")
        if isinstance(next_due, (int, float)) and next_due > now:
            reason = (f"next due in {human_delta(next_due - now)} "
                      f"(every {human_interval(interval)})")
        else:
            reason = f"fresh (every {human_interval(interval)})"
        skipped.append((name, reason))

    # The HN thread is event-driven: a brand-new thread beats the clock. This
    # is the one source where "nothing changed upstream" is knowable cheaply.
    if "hackernews" in dict(skipped):
        try:
            if hn_thread_changed(client):
                skipped = [(n, r) for n, r in skipped if n != "hackernews"]
                due.append("hackernews")
                print("hackernews — new who-is-hiring thread detected, running early")
        except Exception as e:
            print(f"  (hn thread check skipped: {_short(e)})")

    return due, skipped


def _fetch_schedule(client: httpx.Client, base_url: str) -> Dict[str, dict]:
    """GET /api/schedule -> {source: row}. Raises on anything unexpected."""
    if not base_url:
        raise RuntimeError("no dashboard URL")

    resp = client.get(f"{base_url.rstrip('/')}/api/schedule", timeout=API_TIMEOUT)
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}")

    data = resp.json()
    if not isinstance(data, dict):
        raise RuntimeError("response was not a JSON object")
    sources = data.get("sources")
    if not isinstance(sources, list):
        raise RuntimeError("response had no `sources` list")

    rows = {}
    for row in sources:
        if isinstance(row, dict) and row.get("source"):
            rows[str(row["source"])] = row
    if not rows:
        raise RuntimeError("schedule was empty")
    return rows


def record(client: httpx.Client, base_url: str, source: str,
           status: str = "ok") -> bool:
    """POST a source's outcome so it stops being due. Non-fatal by design.

    The local mirror is written either way, so `--due-only` still paces itself
    correctly if the API write is the thing that failed.
    """
    _record_local(source, status)

    if not base_url:
        return False
    try:
        resp = client.post(
            f"{base_url.rstrip('/')}/api/schedule",
            json={"source": source, "status": status,
                  "at": int(time.time() * 1000)},
            timeout=API_TIMEOUT,
        )
    except Exception as e:
        print(f"  (schedule not updated for {source}: {_short(e)})")
        return False
    if resp.status_code != 200:
        print(f"  (schedule not updated for {source}: HTTP {resp.status_code})")
        return False
    return True


# ---------------------------------------------------------------------------
# HN: event-driven instead of clock-driven
# ---------------------------------------------------------------------------
def hn_thread_changed(client: Optional[httpx.Client] = None) -> bool:
    """True when the whoishiring bot has posted a thread we haven't seen.

    One request to Algolia for the newest story by `whoishiring`, comparing
    `objectID` with the last one recorded in `.schedule-state.json`. The very
    first call records the current thread and returns False: on a fresh
    checkout the clock-based interval is the right authority, and treating
    "we've never looked" as "it changed" would force a needless scrape.
    """
    owns_client = client is None
    if owns_client:
        client = httpx.Client(timeout=PROBE_TIMEOUT)
    try:
        resp = client.get(HN_ALGOLIA_URL, timeout=PROBE_TIMEOUT)
        if resp.status_code != 200:
            raise RuntimeError(f"algolia HTTP {resp.status_code}")
        hits = (resp.json() or {}).get("hits") or []
        if not hits:
            return False
        object_id = str(hits[0].get("objectID") or "")
        if not object_id:
            return False
    finally:
        if owns_client:
            client.close()

    state = local_fallback()
    previous = str(state["hn"].get("object_id") or "")
    state["hn"] = {"object_id": object_id, "seen_at": int(time.time() * 1000),
                   "title": str(hits[0].get("title") or "")[:120]}
    _save_local(state)

    return bool(previous) and object_id != previous


def _short(e: Exception) -> str:
    text = str(e) or type(e).__name__
    return text.splitlines()[0][:120]
