"""Scrape settings. Targeting values come from the active profile.

Everything candidate-specific (which roles to search, which cities, which
tokens to filter feeds on, the experience band) now lives in `profile.py`;
with no profile present those resolve to `profile.DEFAULTS`, which holds the
exact values this file used to hardcode.

The profile is read lazily through a module `__getattr__` (PEP 562), never at
import time — otherwise import order would decide whether the profile had been
loaded yet, and a source imported early would silently see stale values.
Callers keep using the old names:

    config.ROLE_KEYWORDS        # QUERY terms  <- profile.search_roles()
    config.LOCATIONS            # QUERY terms  <- profile.search_locations()
    config.MATCH_KEYWORDS       # FILTER tokens <- profile.match_keywords()
    config.MIN_EXPERIENCE_YEARS # <- profile.exp_min()
    config.MAX_EXPERIENCE_YEARS # <- profile.exp_max()
"""
import profile as _profile

# Search phrases sent to sources with a server-side keyword search
# (Naukri, LinkedIn) — kept short: each extra phrase is extra requests
# against sites that actively rate-limit.
#
# Broader tokens (MATCH_KEYWORDS) filter sources that hand back an unfiltered
# feed (RemoteOK, We Work Remotely); they are matched as substrings, so they
# are short and loose on purpose. A full-phrase match there misses real titles
# like "Full Stack Engineer" or "Senior React Developer" — which is why the
# two lists are separate profile fields and must never be merged.
#
# LOCATIONS are city *search* terms — each must match something locations.py
# can classify, otherwise the results get collected then silently dropped.
_PROFILE_BACKED = {
    "ROLE_KEYWORDS": _profile.search_roles,
    "MATCH_KEYWORDS": _profile.match_keywords,
    "LOCATIONS": _profile.search_locations,
    "MIN_EXPERIENCE_YEARS": _profile.exp_min,
    "MAX_EXPERIENCE_YEARS": _profile.exp_max,
}


def __getattr__(name):
    accessor = _PROFILE_BACKED.get(name)
    if accessor is not None:
        return accessor()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(list(globals()) + list(_PROFILE_BACKED))


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

REQUEST_TIMEOUT = 20.0
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0       # seconds, doubled each retry
DELAY_BETWEEN_REQUESTS = 2.0  # seconds, between successful requests to the same host

# Pages fetched per (keyword, location) pair, per source.
NAUKRI_MAX_PAGES = 2
LINKEDIN_MAX_PAGES = 2
