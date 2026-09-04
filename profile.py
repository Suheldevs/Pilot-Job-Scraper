"""The active candidate profile — one resolved record, shared by every module.

Until now the candidate was hardcoded across `config.py`, `relevance.py` and
`scoring.py`. Those modules now read their targeting values from here, so the
same pipeline can serve a different candidate without a code edit.

Resolution order, first hit wins:

  1. `PILOT_PROFILE` env var pointing at a JSON file
  2. a local `profile.json` next to this module
  3. `GET {JO_URL}/api/profiles`, taking the row flagged `is_default`
  4. `DEFAULTS` — today's hardcoded values, verbatim

Every fallback is silent and non-fatal on purpose: a scrape must never fail
because a profile could not be read. If nothing resolves we are provably back
to the behaviour that shipped, because `DEFAULTS` *is* that behaviour.

Field names come from PROFILE-CONTRACT.md. Two kinds of data live in here and
must never be merged:

  * `search_roles` / `search_locations` are QUERY terms — they build the actual
    search URLs sent to LinkedIn and Naukri. Few and natural; each one costs
    requests against a rate-limited site.
  * `match_keywords` are FILTER tokens — matched post-fetch against sources
    that hand back an unfiltered feed. Many and loose.
"""
import json
import os
from typing import Any, Dict, List, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_LOCAL_PROFILE = os.path.join(_HERE, "profile.json")
_CACHE_FILE = os.path.join(_HERE, ".profile-cache.json")


# ---------------------------------------------------------------------------
# The built-in default — profile 1, "Mohd Suhel", the parent profile.
#
# Assembled to be bit-for-bit the values that were hardcoded before profiles
# existed, so the no-profile path is provably unchanged behaviour:
#
#   search_roles     was config.ROLE_KEYWORDS
#   search_locations was config.LOCATIONS
#   match_keywords   was config.MATCH_KEYWORDS
#   exp_min/exp_max  were config.MIN/MAX_EXPERIENCE_YEARS
#   must_have + nice_to_have  was relevance.ROLE_TERMS, in that order
#   exclude_titles   was relevance.TOO_SENIOR + relevance.TOO_JUNIOR
#   exclude_stacks   was relevance.WRONG_DISCIPLINE
#   years            was scoring.CANDIDATE_YEARS
#
# Order inside these lists is load-bearing: the relevance gate reports the
# *first* matching term as its reason, so reordering changes reason strings.
# ---------------------------------------------------------------------------
DEFAULTS: Dict[str, Any] = {
    "id": 1,
    "version": 1,
    "name": "Mohd Suhel",
    "is_default": 1,

    # identity — fills message templates
    "full_name": "Mohd Suhel",
    "headline": "Full-stack developer (React / Node)",
    "years": 2,
    "current_company": "",
    "email": "",
    "phone": "",
    "linkedin": "",
    "github": "",
    "portfolio": "",
    "resume_url": "",
    "notice_period": "",

    # QUERY terms — sent to sources with a server-side keyword search
    # (Naukri, LinkedIn). Kept short: each extra phrase is extra requests
    # against sites that actively rate-limit.
    "search_roles": [
        "full stack developer",
        "mern stack developer",
        "react developer",
        "node js developer",
    ],
    # QUERY terms — must match something locations.py can classify, otherwise
    # the results get collected then silently dropped.
    "search_locations": ["Bangalore", "Pune", "Lucknow", "Noida", "Remote"],

    # FILTER tokens — used on sources that hand back an unfiltered feed
    # (RemoteOK, We Work Remotely). Matched as substrings, so short and loose
    # on purpose.
    "match_keywords": [
        "react", "node", "mern", "full stack", "fullstack",
        "javascript", "typescript", "next.js", "nextjs",
        "frontend", "front-end", "backend", "express", "mongodb",
    ],

    # The stack identity: full-stack/JS role words plus the named
    # technologies. relevance.ROLE_TERMS is must_have + nice_to_have.
    "must_have": [
        "full stack", "fullstack", "full-stack", "mern", "mean",
        "react", "reactjs", "react native", "next", "nextjs", "next.js",
        "node", "nodejs", "node.js", "express", "mongodb", "mongo",
        "javascript", "typescript",
    ],
    # Adjacent generic engineering words — enough to make a title plausibly
    # ours, but they say nothing about which stack.
    "nice_to_have": [
        "frontend", "front end", "front-end",
        "backend", "back end", "back-end", "web developer",
        "software engineer", "software developer", "sde",
    ],

    # Wrong *level* — senior words first, then the too-junior ones.
    "exclude_titles": [
        "senior", "sr", "lead", "principal", "staff", "architect", "head",
        "director", "vp", "vice president", "manager", "chief", "cto",
        "intern", "internship", "trainee", "apprentice", "fresher only",
    ],
    # Wrong discipline — a stack or function this candidate doesn't have.
    "exclude_stacks": [
        # ".net" shows up in the wild as "dot net", "dotnet" and a bare "net" —
        # Naukri slugs strip punctuation, so every form has to be listed or a
        # ".NET Full Stack Developer" reads as ours on the words "full stack".
        "java", ".net", "dot net", "dotnet", "net developer", "net full stack",
        "asp net", "c#", "php", "laravel", "ruby on rails", "rails", "ror",
        "golang", "go developer", "django", "flask", "python developer",
        "salesforce", "sap", "sharepoint", "wordpress", "drupal", "shopify",
        "flutter", "android", "ios", "swift", "kotlin", "unity",
        "devops", "sre", "site reliability", "cloud engineer", "network",
        "data engineer", "data scientist", "ml engineer", "machine learning",
        "qa", "quality assurance", "tester", "testing", "automation test",
        "business analyst", "product manager", "designer", "ui/ux", "graphic",
        "sales", "marketing", "recruiter", "hr ", "accountant", "finance",
        "support engineer", "customer success", "technical writer",
        "embedded", "firmware", "mainframe", "cobol", "oracle", "dba",
    ],

    "cities": ["blr", "pune", "lko", "noida", "rem"],
    "exp_min": 1,
    "exp_max": 3,
    "remote_pref": "any",
    "employment_type": "any",
    "min_grade": "C",
}

# Targeting fields are JSON arrays in the table; an API row may hand them back
# as JSON strings. These are the ones we always want as real lists.
_LIST_FIELDS = (
    "search_roles", "search_locations", "match_keywords",
    "must_have", "nice_to_have", "exclude_titles", "exclude_stacks", "cities",
)

_cached: Optional[Dict[str, Any]] = None


# ---- normalisation -------------------------------------------------------

def _as_list(value: Any) -> List[str]:
    """A profile list field as a real list of strings, whatever shape it came in."""
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            # Not JSON — tolerate a comma-separated string rather than dying.
            return [part.strip() for part in text.split(",") if part.strip()]
        return _as_list(parsed)
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value if str(item) != ""]
    return [str(value)]


def _as_number(value: Any, fallback):
    """A REAL column as an int when it is integral, so f-strings read '2', not '2.0'.

    `str(config.MIN_EXPERIENCE_YEARS)` goes straight into a Naukri query string
    and `CANDIDATE_YEARS` goes into score reason text, so the int/float
    distinction is user-visible.
    """
    if value is None or value == "":
        return fallback
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return int(number) if number == int(number) else number


def normalize(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Merge a partial profile record over DEFAULTS and coerce its types."""
    merged = dict(DEFAULTS)
    if isinstance(raw, dict):
        for key, value in raw.items():
            if value is not None:
                merged[key] = value

    for field in _LIST_FIELDS:
        items = _as_list(merged.get(field))
        # An empty targeting list would silently disable a whole gate; fall
        # back to the default rather than scraping the entire internet.
        merged[field] = items or list(DEFAULTS[field])

    for field in ("years", "exp_min", "exp_max"):
        merged[field] = _as_number(merged.get(field), DEFAULTS[field])

    merged["min_grade"] = str(merged.get("min_grade") or DEFAULTS["min_grade"])
    merged["version"] = int(_as_number(merged.get("version"), 1))
    merged["id"] = int(_as_number(merged.get("id"), 1))
    return merged


# ---- sources -------------------------------------------------------------

def _from_json_file(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and isinstance(data.get("profile"), dict):
        data = data["profile"]
    return data if isinstance(data, dict) else None


def _from_api() -> Optional[Dict[str, Any]]:
    """Fetch /api/profiles and take the is_default row. Never raises."""
    base_url = (os.environ.get("JO_URL") or "").rstrip("/")
    password = os.environ.get("JO_PASSWORD") or ""
    if not base_url or not password:
        return None

    try:
        import httpx
    except ImportError:
        return None

    try:
        with httpx.Client(timeout=20.0) as client:
            # Same login shape as push.py::login — the 302 carries the cookie,
            # and the server marks it Secure, so it is set explicitly.
            resp = client.post(f"{base_url}/api/login",
                               json={"password": password},
                               follow_redirects=False)
            if resp.status_code != 302:
                return None
            token = resp.cookies.get("session")
            if not token:
                return None
            client.cookies.set("session", token)

            resp = client.get(f"{base_url}/api/profiles")
            if resp.status_code != 200:
                return None
            payload = resp.json()
    except Exception:
        # Any network/parse failure at all: fall through to the next source.
        return None

    rows = payload.get("profiles") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return None
    rows = [row for row in rows if isinstance(row, dict)]
    if not rows:
        return None
    for row in rows:
        if row.get("is_default"):
            return row
    return rows[0]


def _write_cache(record: Dict[str, Any]) -> None:
    try:
        with open(_CACHE_FILE, "w", encoding="utf-8") as fh:
            json.dump(record, fh, ensure_ascii=False, indent=2, default=str)
    except OSError:
        pass  # a cache we can't write is a missing optimisation, not an error


# ---- public API ----------------------------------------------------------

def load(path_or_url: Optional[str] = None) -> Dict[str, Any]:
    """Resolve the active profile and cache it, in memory and on disk.

    `path_or_url` overrides the whole resolution order with one explicit
    source — a JSON file path, or a dashboard base URL.
    """
    global _cached

    raw: Optional[Dict[str, Any]] = None

    if path_or_url:
        if str(path_or_url).startswith(("http://", "https://")):
            previous = os.environ.get("JO_URL")
            os.environ["JO_URL"] = str(path_or_url)
            try:
                raw = _from_api()
            finally:
                if previous is None:
                    os.environ.pop("JO_URL", None)
                else:
                    os.environ["JO_URL"] = previous
        else:
            raw = _from_json_file(str(path_or_url))
    else:
        env_path = os.environ.get("PILOT_PROFILE")
        if env_path:
            raw = _from_json_file(env_path)
        if raw is None and os.path.exists(_LOCAL_PROFILE):
            raw = _from_json_file(_LOCAL_PROFILE)
        if raw is None:
            raw = _from_api()

    record = normalize(raw or {})
    record["_source"] = (
        "explicit" if path_or_url else
        "env" if os.environ.get("PILOT_PROFILE") and raw else
        "file" if raw and os.path.exists(_LOCAL_PROFILE) else
        "api" if raw else "defaults"
    )
    _cached = record
    _write_cache(record)
    return record


def active() -> Dict[str, Any]:
    """The resolved profile, loading it on first use."""
    if _cached is None:
        return load()
    return _cached


def reset() -> None:
    """Drop the in-memory cache — tests only."""
    global _cached
    _cached = None


def _get(field: str):
    return active().get(field, DEFAULTS.get(field))


# Typed accessors. Callers use these instead of indexing raw dicts, so a
# renamed column breaks in one place.

def search_roles() -> List[str]:
    """QUERY terms — build the search URLs for LinkedIn and Naukri."""
    return list(_get("search_roles"))


def search_locations() -> List[str]:
    """QUERY terms — the `location=` parameter."""
    return list(_get("search_locations"))


def match_keywords() -> List[str]:
    """FILTER tokens — applied post-fetch to unfiltered feeds."""
    return list(_get("match_keywords"))


def must_have() -> List[str]:
    return list(_get("must_have"))


def nice_to_have() -> List[str]:
    return list(_get("nice_to_have"))


def exclude_titles() -> List[str]:
    return list(_get("exclude_titles"))


def exclude_stacks() -> List[str]:
    return list(_get("exclude_stacks"))


def cities() -> List[str]:
    return list(_get("cities"))


def exp_min():
    return _get("exp_min")


def exp_max():
    return _get("exp_max")


def years():
    return _get("years")


def min_grade() -> str:
    return str(_get("min_grade"))


def version() -> int:
    return int(_get("version"))


def profile_id() -> int:
    return int(active().get("id", DEFAULTS["id"]))


def identity() -> Dict[str, Any]:
    """The fields that fill message templates."""
    record = active()
    return {
        key: record.get(key, DEFAULTS.get(key, ""))
        for key in ("name", "full_name", "headline", "years", "current_company",
                    "email", "phone", "linkedin", "github", "portfolio",
                    "resume_url", "notice_period")
    }
