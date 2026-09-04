"""Layer 4 — genuinity x match, collapsed into the two tags hey.html shows.

Genuinity answers "is this a real, open role I can apply to directly?" and match
answers "does it fit this candidate?". They are deliberately additive rather
than multiplied: a perfect-fit role on a staffing agency's LinkedIn repost and a
mediocre-fit role on the company's own Greenhouse board should both land in the
middle, and a multiplication would push one of them to a false extreme.

Every adjustment appends a reason string, so a low grade can always be argued
with instead of just accepted.
"""
import re
from typing import Dict, List, Optional, Tuple

import locations
import profile as _profile
from extract import split_contacts
from models import Job

# ---- candidate profile --------------------------------------------------
# The candidate's years and stack come from the active profile:
#
#     CANDIDATE_YEARS  <- profile.years()
#     CANDIDATE_SKILLS <- profile.must_have() / profile.nice_to_have(),
#                         resolved through SKILL_PATTERNS below
#
# Both are exposed under their original names through a module `__getattr__`
# (PEP 562) and resolved lazily, never at import time, so import order cannot
# decide whether the profile had loaded yet. With no profile present they
# resolve to profile.DEFAULTS — the values this file used to hardcode.
#
# The *weights* further down are hand-tuned scoring policy, not profile data,
# and stay exactly as they are.

TARGET_BAND = (1, 3)          # inclusive years of experience we want to match

# Canonical skill -> the spellings a JD actually uses. Distinct canonical hits
# are what get counted, so "React", "React.js" and "ReactJS" score once.
#
# This is pattern knowledge, not candidate data: it says how a skill is
# *written*, not whether this candidate has it. A profile term is looked up
# here through SKILL_ALIASES; a term with no pattern simply doesn't score, so
# an unknown skill can never widen the match by accident.
#
# Dict order is preserved into CANDIDATE_SKILLS, and _matched_skills reports
# hits in that order, so it is load-bearing for reason strings.
SKILL_PATTERNS: Dict[str, Tuple[str, ...]] = {
    "react":        (r"\breact(?:\.?js)?\b",),
    "next":         (r"\bnext\.?js\b",),
    "react native": (r"\breact\s*native\b",),
    "node":         (r"\bnode(?:\.?js)?\b",),
    "express":      (r"\bexpress(?:\.?js)?\b",),
    "mongodb":      (r"\bmongo(?:db)?\b",),
    # The bare "js"/"ts" forms use a lookbehind so "node.js" isn't also read
    # as a JavaScript mention — that would inflate the distinct-hit count.
    "javascript":   (r"\bjavascript\b", r"(?<![.\w])js\b", r"\bes6\b"),
    "typescript":   (r"\btypescript\b", r"(?<![.\w])ts\b"),
    "mern":         (r"\bmern\b",),
    "ai workflows": (r"\bai\s+workflow", r"\bllm\b", r"\bgen\s?ai\b",
                     r"\bopenai\b", r"\bprompt\s+engineering\b"),
    "agents":       (r"\bagent(?:ic)?\s+(?:pipeline|workflow|framework)",
                     r"\blangchain\b", r"\bllamaindex\b"),
    "vector search": (r"\bvector\s+(?:search|db|database)", r"\bembedding",
                      r"\bpinecone\b", r"\bpgvector\b", r"\brag\b"),
}

# Profile spellings -> canonical SKILL_PATTERNS key.
SKILL_ALIASES: Dict[str, str] = {
    "react": "react", "reactjs": "react", "react.js": "react",
    "next": "next", "nextjs": "next", "next.js": "next",
    "react native": "react native",
    "node": "node", "nodejs": "node", "node.js": "node", "node js": "node",
    "express": "express", "expressjs": "express", "express.js": "express",
    "mongo": "mongodb", "mongodb": "mongodb",
    "javascript": "javascript", "js": "javascript",
    "typescript": "typescript", "ts": "typescript",
    "mern": "mern",
    "ai workflows": "ai workflows", "llm": "ai workflows", "genai": "ai workflows",
    "agents": "agents", "agentic": "agents", "langchain": "agents",
    "vector search": "vector search", "rag": "vector search",
}

# Emerging-stack signals this candidate carries beyond the declared MERN
# terms. Like the weights below they are tuning, not targeting: a JD that
# mentions LLM work is a better fit for a JS generalist either way.
BONUS_SKILLS: Tuple[str, ...] = ("ai workflows", "agents", "vector search")

# Stacks the candidate cannot credibly claim. A title built on one of these is
# a hard no; the same word buried in a JD's nice-to-haves is nearly harmless,
# which is why the two get very different weights.
WRONG_STACK: Tuple[str, ...] = (
    r"\bjava\b", r"\.net\b", r"(?<![a-z])c#", r"\bphp\b", r"\blaravel\b",
    r"\bruby\s+on\s+rails\b", r"\bror\b", r"\bgolang\b", r"\bdjango\b",
    r"\bsalesforce\b", r"\bsap\b", r"\bsharepoint\b", r"\bwordpress\b",
    r"\bdrupal\b", r"\bflutter\b", r"\bandroid\b", r"\bios\b",
    r"\bdevops\b", r"\bsre\b", r"\bdata\s+engineer", r"\bml\s+engineer",
    r"\bqa\b", r"\btester\b", r"\bautomation\s+testing\b",
)

# Staffing firms and consultancies: the posting is real, the employer named on
# it is not, so the whole pitch (direct application, known company) collapses.
STAFFING_PATTERNS: Tuple[str, ...] = (
    "staffing", "consultanc", "consulting", "recruit", "manpower",
    "hr solutions", "hr services", "placement", "talent acquisition",
    "teamlease", "randstad", "adecco", "quess", "naukri", "hirist",
    "careernet", "abc consultants", "michael page", "antal", "weekday",
    "multi recruit", "sourcingxpress",
)

SENIOR_TITLE = (
    r"\bsenior\b", r"\bsr\.?\b", r"\blead\b", r"\bprincipal\b", r"\bstaff\b",
    r"\barchitect\b", r"\bmanager\b", r"\bhead\s+of\b", r"\bdirector\b",
    r"\bvp\b",
)
INTERN_TITLE = (r"\bintern(?:ship)?\b", r"\btrainee\b")
JUNIOR_TITLE = (r"\bjunior\b", r"\bjr\.?\b", r"\bassociate\b", r"\bfresher\b",
                r"\bentry\b")
LEVEL_ONE_TITLE = (r"\bsde\s*[-–]?\s*(?:1|i)\b", r"\bsoftware\s+engineer\s*1\b",
                   r"\bengineer\s*[-–]?\s*i\b")

# ---- weights -----------------------------------------------------------
BASE_SCORE = 50

TIER_WEIGHT = {
    "ats": 18,          # the company's own board: the single strongest signal
    "extension": 18,    # a human saw it on a real logged-in page
    "direct": 16,       # the employer posted it themselves (HN who-is-hiring:
                        # recruiters are barred, and posts usually carry an email)
    "aggregator": 6,
    "search": -4,       # search/sitemap results mix in reposts and agencies
    "manual": 0,
}
W_HR_EMAIL = 14         # an HR address means we can skip the portal entirely
W_ALSO_ON = 6
W_FRESH = 10            # < FRESH_DAYS old
W_STALE = -20           # STALE_DAYS .. VERY_STALE_DAYS
W_VERY_STALE = -30      # > VERY_STALE_DAYS
W_STAFFING = -30
W_NO_JD = -6            # nothing to verify the posting against

W_SKILL_HIT = 3
SKILL_CAP = 12          # caps a keyword-stuffed JD at four distinct hits
W_EXP_OVERLAP = 12
W_EXP_FOUR = -8
W_EXP_FIVE_PLUS = -25
W_SENIOR_TITLE = -22
# Heavier than the senior penalty on purpose: a senior title is a stretch the
# candidate might grow into, an internship is a pay cut and a title downgrade.
W_INTERN_TITLE = -35
W_JUNIOR_TITLE = 6
W_LEVEL_ONE_TITLE = 10
W_WRONG_STACK_TITLE = -25
W_WRONG_STACK_JD = -4
WRONG_STACK_JD_CAP = -10
W_LOCATION_OK = 6
W_LOCATION_MISS = -12   # the candidate is not relocating to a fifth city

FRESH_DAYS = 7
STALE_DAYS = 30
VERY_STALE_DAYS = 60

GRADE_A_MIN = 75
GRADE_B_MIN = 55
GRADE_C_MIN = 35

# ---- profile-backed lookups --------------------------------------------
# Memoised per (profile id, version); the compiled regexes are the expensive
# part, so they are built once per profile rather than per job.
_skills_cache: Dict[tuple, tuple] = {}


def _skills():
    """(CANDIDATE_SKILLS, compiled) for the active profile."""
    key = (_profile.profile_id(), _profile.version())
    cached = _skills_cache.get(key)
    if cached is not None:
        return cached

    wanted = set(BONUS_SKILLS)
    for term in _profile.must_have() + _profile.nice_to_have():
        canonical = SKILL_ALIASES.get(term.strip().lower())
        if canonical:
            wanted.add(canonical)

    # Built in SKILL_PATTERNS order, so hit order is stable across profiles.
    candidate_skills: Dict[str, Tuple[str, ...]] = {
        name: patterns for name, patterns in SKILL_PATTERNS.items()
        if name in wanted
    }
    compiled = {
        name: [re.compile(p, re.IGNORECASE) for p in patterns]
        for name, patterns in candidate_skills.items()
    }
    cached = (candidate_skills, compiled)
    _skills_cache[key] = cached
    return cached


def _candidate_years():
    return _profile.years()


def __getattr__(name):
    if name == "CANDIDATE_SKILLS":
        return dict(_skills()[0])
    if name == "CANDIDATE_YEARS":
        return _candidate_years()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(list(globals()) + ["CANDIDATE_SKILLS", "CANDIDATE_YEARS"])


_COMPILED_WRONG = [re.compile(p, re.IGNORECASE) for p in WRONG_STACK]
_COMPILED_SENIOR = [re.compile(p, re.IGNORECASE) for p in SENIOR_TITLE]
_COMPILED_INTERN = [re.compile(p, re.IGNORECASE) for p in INTERN_TITLE]
_COMPILED_JUNIOR = [re.compile(p, re.IGNORECASE) for p in JUNIOR_TITLE]
_COMPILED_LEVEL_ONE = [re.compile(p, re.IGNORECASE) for p in LEVEL_ONE_TITLE]

_YEAR_WORD = r"(?:years?|yrs?)"
# Ordered widest-context-first; every pattern is tried and the most permissive
# requirement wins, so "2-4 years, 6+ years in a team" is read as 2-4.
_EXP_PATTERNS = (
    re.compile(r"(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*" + _YEAR_WORD,
               re.IGNORECASE),
    re.compile(r"(?:minimum|min\.?|at\s*least|atleast|more\s+than|over)\s*"
               r"(?:of\s*)?(\d{1,2})\s*\+?\s*" + _YEAR_WORD, re.IGNORECASE),
    re.compile(r"(\d{1,2})\s*\+\s*" + _YEAR_WORD, re.IGNORECASE),
    re.compile(r"(\d{1,2})\s*" + _YEAR_WORD, re.IGNORECASE),
)


def _reason(delta: int, text: str) -> str:
    return f"{delta:+d} {text}"


def _posted(age: int) -> str:
    return f"posted {age} day{'' if age == 1 else 's'} ago"


def parse_experience(text: str) -> Optional[Tuple[int, Optional[int]]]:
    """Lowest experience requirement stated in `text` as (min, max_or_None)."""
    if not text:
        return None

    best: Optional[Tuple[int, Optional[int]]] = None
    for pattern in _EXP_PATTERNS:
        for match in pattern.finditer(text):
            groups = match.groups()
            low = int(groups[0])
            high: Optional[int] = None
            if len(groups) > 1 and groups[1] is not None:
                high = int(groups[1])
                if high < low:            # "4 to 2" — treat as a typo'd range
                    low, high = high, low
            if low > 20:                  # not an experience figure at all
                continue
            if best is None or low < best[0]:
                best = (low, high)
    return best


def _matched_skills(text: str) -> List[str]:
    return [name for name, patterns in _skills()[1].items()
            if any(p.search(text) for p in patterns)]


def _matched(patterns: List[re.Pattern], text: str) -> List[str]:
    """The literal substrings that matched — used verbatim in reason strings."""
    hits: List[str] = []
    for pattern in patterns:
        found = pattern.search(text)
        if found:
            hits.append(found.group(0).strip())
    return hits


def _score_genuinity(job: Job, reasons: List[str]) -> int:
    total = 0
    tier = job.tier

    weight = TIER_WEIGHT.get(tier, TIER_WEIGHT["search"])
    if weight:
        label = {
            "ats": f"on the company's own {job.platform.title()} board",
            "extension": f"captured by hand from {job.platform}",
            "direct": f"posted by the employer directly on {job.platform.title()}",
            "aggregator": f"listed on the {job.platform.title()} feed",
            "search": f"{job.platform.title()} search result, not a company board",
        }.get(tier, f"from {job.platform}")
        total += weight
        reasons.append(_reason(weight, label))

    hr_emails, _ = split_contacts(job.emails, job.jd_text)
    if hr_emails:
        total += W_HR_EMAIL
        reasons.append(_reason(W_HR_EMAIL,
                               f"direct hiring contact in the JD ({hr_emails[0]})"))

    if job.also_on:
        total += W_ALSO_ON
        reasons.append(_reason(W_ALSO_ON,
                               "same role corroborated on " + ", ".join(job.also_on)))

    age = job.age_days()
    if age is None:
        pass  # a missing date is not evidence of staleness — stay neutral
    elif age < FRESH_DAYS:
        total += W_FRESH
        reasons.append(_reason(W_FRESH, _posted(age)))
    elif age > VERY_STALE_DAYS:
        total += W_VERY_STALE
        reasons.append(_reason(W_VERY_STALE, _posted(age)))
    elif age > STALE_DAYS:
        total += W_STALE
        reasons.append(_reason(W_STALE, _posted(age)))

    company = job.company.lower()
    agency = next((p for p in STAFFING_PATTERNS if p in company), None)
    if agency:
        total += W_STAFFING
        reasons.append(_reason(W_STAFFING,
                               f"\"{job.company}\" looks like a staffing firm, "
                               "not the employer"))

    if not job.jd_text.strip():
        total += W_NO_JD
        reasons.append(_reason(W_NO_JD, "no job description to verify"))

    return total


def _score_match(job: Job, reasons: List[str]) -> int:
    total = 0
    title = job.role.lower()
    body = job.jd_text.lower()
    blob = f"{title}\n{body}"
    candidate_years = _candidate_years()

    skills = _matched_skills(blob)
    if skills:
        raw = W_SKILL_HIT * len(skills)
        capped = min(raw, SKILL_CAP)
        total += capped
        shown = ", ".join(skills[:4])
        reasons.append(_reason(capped, f"stack overlap: {shown}"
                                       + (" (capped)" if raw > capped else "")))

    senior = _matched(_COMPILED_SENIOR, title)
    intern = _matched(_COMPILED_INTERN, title)

    band = parse_experience(job.jd_text)
    # An internship JD's "0-1 years" is describing the internship, not a band
    # this candidate wants to sit in — so it earns no overlap credit.
    if band and not intern:
        low, high = band
        stated = f"{low}-{high}" if high is not None else f"{low}+"
        if low >= 5:
            total += W_EXP_FIVE_PLUS
            reasons.append(_reason(W_EXP_FIVE_PLUS,
                                   f"wants {stated} years, candidate has "
                                   f"{candidate_years}"))
        elif low == 4:
            total += W_EXP_FOUR
            reasons.append(_reason(W_EXP_FOUR, f"wants {stated} years, just above band"))
        else:
            total += W_EXP_OVERLAP
            reasons.append(_reason(W_EXP_OVERLAP,
                                   f"{stated} years overlaps the "
                                   f"{TARGET_BAND[0]}-{TARGET_BAND[1]} target band"))

    if senior:
        total += W_SENIOR_TITLE
        reasons.append(_reason(W_SENIOR_TITLE,
                               f"senior-track title ({'/'.join(senior)})"))
    if intern:
        total += W_INTERN_TITLE
        reasons.append(_reason(W_INTERN_TITLE,
                               f"{intern[0]} is a step backwards at "
                               f"{candidate_years} years"))
    level_one = _matched(_COMPILED_LEVEL_ONE, title)
    if level_one:
        total += W_LEVEL_ONE_TITLE
        reasons.append(_reason(W_LEVEL_ONE_TITLE, f"{level_one[0]} is the right rung"))
    elif not senior and not intern:
        junior = _matched(_COMPILED_JUNIOR, title)
        if junior:
            total += W_JUNIOR_TITLE
            reasons.append(_reason(W_JUNIOR_TITLE, f"{junior[0]}-level title"))

    # Title matches are weighted far more heavily than body matches: a JD that
    # lists Java under "nice to have" is still a JS role, a title that says
    # Java is not.
    wrong_in_title = _matched(_COMPILED_WRONG, title)
    if wrong_in_title:
        total += W_WRONG_STACK_TITLE
        reasons.append(_reason(W_WRONG_STACK_TITLE,
                               f"title is centred on {'/'.join(wrong_in_title)}"))
    else:
        wrong_in_body = _matched(_COMPILED_WRONG, body)
        if wrong_in_body:
            delta = max(W_WRONG_STACK_JD * len(wrong_in_body), WRONG_STACK_JD_CAP)
            total += delta
            reasons.append(_reason(delta, "JD leans on "
                                          + ", ".join(wrong_in_body[:3])))

    tab = locations.classify(job.location_raw)
    if tab:
        total += W_LOCATION_OK
        reasons.append(_reason(W_LOCATION_OK, f"location maps to {tab}"))
    else:
        total += W_LOCATION_MISS
        reasons.append(_reason(W_LOCATION_MISS,
                               f"location \"{job.location_raw or 'unknown'}\" "
                               "is outside the tracked cities"))

    return total


def grade_for(score: int) -> str:
    if score >= GRADE_A_MIN:
        return "A"
    if score >= GRADE_B_MIN:
        return "B"
    if score >= GRADE_C_MIN:
        return "C"
    return "D"


def score_job(job: Job) -> None:
    """Set job.score / job.grade / job.reasons in place."""
    reasons: List[str] = []
    raw = BASE_SCORE + _score_genuinity(job, reasons) + _score_match(job, reasons)

    job.score = max(0, min(100, raw))
    job.grade = grade_for(job.score)
    job.reasons = reasons


def score_all(jobs: List[Job]) -> None:
    """Fill also_on by cross-platform corroboration, then score every job."""
    by_key: Dict[str, List[Job]] = {}
    for job in jobs:
        by_key.setdefault(job.dedupe_key(), []).append(job)

    for group in by_key.values():
        for job in group:
            # Order-preserving unique list of the *other* platforms carrying it.
            others: List[str] = []
            for sibling in group:
                if sibling.platform != job.platform and sibling.platform not in others:
                    others.append(sibling.platform)
            job.also_on = others

    for job in jobs:
        score_job(job)
