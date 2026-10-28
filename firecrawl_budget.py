"""Firecrawl spend control, shared by every paid Firecrawl caller.

The plan is ~1000 credits a month and the scraper runs every 6 hours, so a
caller that ran on every run would drain it in days. Two limits, both persisted
in .firecrawl-state.json (gitignored):

  * per-feature interval — `due(feature, hours)` is False until that many hours
    have passed since the feature last ran, so "once a day" survives 4 runs/day;
  * a daily credit cap across all features — `can_spend(n)` refuses once today's
    estimated spend would pass `daily_credit_cap` in firecrawl.config.json.

Spend is an estimate (search ~2 credits per call, scrape 1 per page), recorded
by the caller through `spend()`. It errs high on purpose.
"""
import datetime as dt
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / ".firecrawl-state.json"
CONFIG_FILE = HERE / "firecrawl.config.json"

SEARCH_URL = "https://api.firecrawl.dev/v2/search"
SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape"
SEARCH_COST = 2
SCRAPE_COST = 1


def config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def api_key() -> str:
    key = os.environ.get("FIRECRAWL_API_KEY", "")
    if key:
        return key
    creds = HERE / ".push-credentials"
    if creds.exists():
        for line in creds.read_text(encoding="utf-8").splitlines():
            if line.startswith("FIRECRAWL_API_KEY="):
                return line.split("=", 1)[1].strip()
    return ""


def _load() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(state: dict) -> None:
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    tmp.replace(STATE_FILE)


def feature_state(feature: str) -> dict:
    return _load().get(feature, {})


def save_feature_state(feature: str, data: dict) -> None:
    state = _load()
    state[feature] = data
    _save(state)


def due(feature: str, every_hours: float) -> bool:
    last = feature_state(feature).get("last_run")
    if not last:
        return True
    return dt.datetime.now() - dt.datetime.fromisoformat(last) >= dt.timedelta(hours=every_hours)


def mark_ran(feature: str) -> None:
    data = feature_state(feature)
    data["last_run"] = dt.datetime.now().isoformat(timespec="seconds")
    save_feature_state(feature, data)


def _today() -> str:
    return dt.date.today().isoformat()


def spent_today() -> int:
    return int(_load().get("spend", {}).get(_today(), 0))


def can_spend(credits: int) -> bool:
    cap = int(config().get("daily_credit_cap", 35))
    return spent_today() + credits <= cap


def spend(credits: int) -> None:
    state = _load()
    days = state.setdefault("spend", {})
    days[_today()] = int(days.get(_today(), 0)) + credits
    # keep a month of history, no more
    for old in sorted(days)[:-31]:
        days.pop(old, None)
    _save(state)
