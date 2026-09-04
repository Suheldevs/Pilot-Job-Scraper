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
"""
import re
from typing import List, Optional, Tuple

from locations import classify

# Role words that make something plausibly ours.
ROLE_TERMS = [
    "full stack", "fullstack", "full-stack", "mern", "mean",
    "react", "reactjs", "react native", "next", "nextjs", "next.js",
    "node", "nodejs", "node.js", "express", "mongodb", "mongo",
    "javascript", "typescript", "frontend", "front end", "front-end",
    "backend", "back end", "back-end", "web developer", "software engineer",
    "software developer", "sde",
]

# Named technologies we actually use. Only these earn a title the "hybrid"
# exemption in rule 3 — "full stack" / "backend" / "software engineer" are
# generic and say nothing about which stack, so they don't count.
SPECIFIC_STACK = [
    "react", "reactjs", "react native", "next", "nextjs", "next.js",
    "node", "nodejs", "node.js", "express", "mongodb", "mongo",
    "mern", "mean", "javascript", "typescript",
]

# Titles that are the wrong *level* for a 2-year candidate. A senior/lead role
# is not a stretch application, it is a filtered-out application.
TOO_SENIOR = [
    "senior", "sr", "lead", "principal", "staff", "architect", "head",
    "director", "vp", "vice president", "manager", "chief", "cto",
]

# Generic engineering titles — these are allowed to have their relevance
# decided by the job description, because "Software Engineer" alone says
# nothing about the stack. A non-engineering title never gets that benefit.
ENGINEERING_NOUNS = [
    "developer", "engineer", "programmer", "sde", "swe", "software",
    "technologist", "coder",
]

# A step backwards, not sideways.
TOO_JUNIOR = ["intern", "internship", "trainee", "apprentice", "fresher only"]

# Roles centred on a stack or discipline this candidate doesn't have. Only
# checked against the TITLE — a JD that merely mentions Java under
# nice-to-haves shouldn't disqualify an otherwise-good React role.
WRONG_DISCIPLINE = [
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
]


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
    return _has_term(text, ROLE_TERMS)


def is_relevant(job) -> Tuple[bool, str]:
    """Return (keep, reason). Reason explains a rejection, for logging."""
    title = job.role or ""
    haystack = f"{title} {' '.join(job.tags or [])}"

    # 1. Right kind of work? Title+tags first. The JD is only allowed to
    #    rescue a post whose title is at least an engineering role — otherwise
    #    "Growth Analyst" at a company whose JD says "we use React" sneaks in.
    hit = has_role_match(haystack)
    if not hit and _has_term(title, ENGINEERING_NOUNS):
        hit = has_role_match((job.jd_text or "")[:2000])
    if not hit:
        return False, "no role/stack match"

    # 2. Right level? Title-only — JD boilerplate mentions seniority constantly.
    senior = _has_term(title, TOO_SENIOR)
    if senior:
        return False, f"title is {senior}-level"
    junior = _has_term(title, TOO_JUNIOR)
    if junior:
        return False, f"title is an {junior}"

    # 3. Right discipline? Title-only. The exemption for a hybrid title
    #    requires a *specific* stack word, not a generic one: "React / Java
    #    Full Stack" is genuinely half ours, but ".NET Full Stack Developer"
    #    is a .NET job that happens to say "full stack" — the generic term
    #    carries no information about which stack.
    wrong = _has_term(title, WRONG_DISCIPLINE)
    if wrong and not _has_term(title, SPECIFIC_STACK):
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
