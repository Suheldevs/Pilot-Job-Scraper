"""Hard relevance gate — is this even the right kind of job?

Distinct from scoring on purpose. Scoring asks "how good is this lead?" and
produces a nuanced 0-100. Relevance asks a binary question with a cheap answer:
is this a full-stack/MERN-ish role, in a city we track, at a level this
candidate could plausibly hold? Everything that fails is dropped before it
reaches the database.

Running every source and filtering hard here is deliberate: broad ingestion
plus a strict gate beats narrow ingestion, because a source we never query can
never surprise us with a good lead.

The matching is word-boundary, not substring. `"react"` as a bare substring
matches "Associate Director Reactivations Outbound" — a real false positive
seen in production from the existing keyword lists.

The keyword lists themselves are candidate data, so they come from the active
profile rather than being hardcoded here:

    ROLE_TERMS / SPECIFIC_STACK  <- profile.must_have() + profile.nice_to_have()
    TOO_SENIOR / TOO_JUNIOR      <- profile.exclude_titles()
    WRONG_DISCIPLINE             <- profile.exclude_stacks()

They are exposed under their original names via a module `__getattr__`
(PEP 562) and resolved lazily, never at import time — import order must not
decide whether the profile was loaded yet. With no profile present they
resolve to `profile.DEFAULTS`, which is exactly what this file used to hold.

Order inside each list is load-bearing: `_has_term` reports the *first*
matching term, and that term is the rejection reason.
"""
import re
from typing import Dict, List, Optional, Tuple

import profile as _profile
from locations import classify

# Generic role words — plausibly ours, but they say nothing about which stack.
# Everything else in the profile's must_have/nice_to_have is a named
# technology, which is what earns a hybrid title the exemption in rule 3:
# "React / Java Full Stack" is genuinely half ours, ".NET Full Stack
# Developer" is a .NET job that happens to say "full stack".
GENERIC_ROLE_WORDS = frozenset({
    "full stack", "fullstack", "full-stack",
    "frontend", "front end", "front-end",
    "backend", "back end", "back-end", "web developer",
    "software engineer", "software developer", "sde",
})

# The too-junior half of the profile's exclude_titles. Split out by word so
# the two rejection reasons stay distinct ("is senior-level" vs "is an
# intern"); anything unrecognised is treated as a seniority word.
JUNIOR_TITLE_WORDS = frozenset({
    "intern", "internship", "trainee", "apprentice", "fresher only",
    "junior", "jr", "fresher",
})

# Generic engineering titles — these are allowed to have their relevance
# decided by the job description, because "Software Engineer" alone says
# nothing about the stack. A non-engineering title never gets that benefit.
ENGINEERING_NOUNS = [
    "developer", "engineer", "programmer", "sde", "swe", "software",
    "technologist", "coder",
]


# ---- profile-backed term lists -----------------------------------------
# Memoised per (profile id, version) so a lookup is a dict hit, not a rebuild.
_terms_cache: Dict[tuple, Dict[str, List[str]]] = {}


def _terms() -> Dict[str, List[str]]:
    key = (_profile.profile_id(), _profile.version())
    cached = _terms_cache.get(key)
    if cached is not None:
        return cached

    # Order preserved exactly as the profile declares it — must_have first.
    stack_terms: List[str] = []
    for term in _profile.must_have() + _profile.nice_to_have():
        if term not in stack_terms:
            stack_terms.append(term)

    titles = _profile.exclude_titles()
    built = {
        # Role words that make something plausibly ours.
        "ROLE_TERMS": stack_terms,
        # Named technologies we actually use — the generic words stripped out.
        "SPECIFIC_STACK": [t for t in stack_terms
                           if t.lower() not in GENERIC_ROLE_WORDS],
        # Wrong *level*: a senior/lead role is not a stretch application, it
        # is a filtered-out application.
        "TOO_SENIOR": [t for t in titles if t.lower() not in JUNIOR_TITLE_WORDS],
        # A step backwards, not sideways.
        "TOO_JUNIOR": [t for t in titles if t.lower() in JUNIOR_TITLE_WORDS],
        # Roles centred on a stack or discipline this candidate doesn't have.
        # Only checked against the TITLE — a JD that merely mentions Java
        # under nice-to-haves shouldn't disqualify a good React role.
        "WRONG_DISCIPLINE": _profile.exclude_stacks(),
    }
    _terms_cache[key] = built
    return built


def __getattr__(name):
    built = _terms()
    if name in built:
        return list(built[name])
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(list(globals()) + ["ROLE_TERMS", "SPECIFIC_STACK",
                                     "TOO_SENIOR", "TOO_JUNIOR",
                                     "WRONG_DISCIPLINE"])


def _has_term(text: str, terms: List[str]) -> Optional[str]:
    """First term present as a whole word/phrase, else None."""
    if not text:
        return None
    low = text.lower()
    for term in terms:
        # Terms may contain regex-significant chars (".net", "next.js"), so the
        # ones we author are pre-escaped where needed; wrap in word boundaries.
        pattern = r"(?<![a-z0-9])" + term.replace(".", r"\.") + r"(?![a-z0-9])"
        try:
            if re.search(pattern, low):
                return term
        except re.error:
            if term in low:
                return term
    return None


def has_role_match(text: str) -> Optional[str]:
    return _has_term(text, _terms()["ROLE_TERMS"])


def is_relevant(job) -> Tuple[bool, str]:
    """Return (keep, reason). Reason explains a rejection, for logging."""
    title = job.role or ""
    haystack = f"{title} {' '.join(job.tags or [])}"
    terms = _terms()

    # 1. Right kind of work? Title+tags first. The JD is only allowed to
    #    rescue a post whose title is at least an engineering role — otherwise
    #    "Growth Analyst" at a company whose JD says "we use React" sneaks in.
    hit = has_role_match(haystack)
    if not hit and _has_term(title, ENGINEERING_NOUNS):
        hit = has_role_match((job.jd_text or "")[:2000])
    if not hit:
        return False, "no role/stack match"

    # 2. Right level? Title-only — JD boilerplate mentions seniority constantly.
    senior = _has_term(title, terms["TOO_SENIOR"])
    if senior:
        return False, f"title is {senior}-level"
    junior = _has_term(title, terms["TOO_JUNIOR"])
    if junior:
        return False, f"title is an {junior}"

    # 3. Right discipline? Title-only. The exemption for a hybrid title
    #    requires a *specific* stack word, not a generic one: "React / Java
    #    Full Stack" is genuinely half ours, but ".NET Full Stack Developer"
    #    is a .NET job that happens to say "full stack" — the generic term
    #    carries no information about which stack.
    wrong = _has_term(title, terms["WRONG_DISCIPLINE"])
    if wrong and not _has_term(title, terms["SPECIFIC_STACK"]):
        return False, f"title is centred on {wrong.strip()}"

    # 4. Somewhere we actually work?
    if classify(job.location_raw) is None:
        return False, f"location '{(job.location_raw or 'unknown')[:32]}' not tracked"

    return True, hit


def filter_jobs(jobs: List, verbose: bool = True) -> Tuple[List, dict]:
    """Apply the gate, returning (kept, reasons_histogram)."""
    kept = []
    reasons: dict = {}
    for job in jobs:
        ok, reason = is_relevant(job)
        if ok:
            kept.append(job)
        else:
            key = reason.split("'")[0].strip() if "'" in reason else reason
            reasons[key] = reasons.get(key, 0) + 1
    if verbose and reasons:
        top = sorted(reasons.items(), key=lambda kv: -kv[1])[:6]
        print("   filtered out: " + ", ".join(f"{k} ({n})" for k, n in top))
    return kept, reasons
