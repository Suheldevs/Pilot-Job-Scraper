"""Quality gates — "is this a lead worth acting on for THIS candidate?"

relevance.py answers a cheap question (right kind of job, level, city).
This module holds the stricter checks that were missing, found by auditing the
live pipeline: a C++/GPU role graded A because the JD mentioned React, US-only
remote posts graded A for an India-based candidate, "6-12 years" roles sitting
at B, and 412 grade-C search results with no JD and no way to reach anyone.

Three kinds of check, all driven by the active profile (nothing hardcoded to
one candidate except the generic word lists below):

  normalise(jobs)      repair titles, fill experience from the JD   (in place)
  hard_reject(job)     reasons a job must never enter the pipeline  (relevance)
  grade_cap(job)       the best grade the evidence can support      (scoring)

Principle: a scraped keyword is not evidence. A lead earns A only with a title
that names the stack, a known experience band that fits, a way to reach
someone, and a real job description (or an employer-posted source).
"""
import re
from typing import List, Optional, Tuple

import profile as _profile
from locations import classify

# ---------------------------------------------------------------- titles --
# "AppSquadz is Full Stack Developer", "Zed is a company for developers…",
# "/^Full-?stack Engineer$/i" were all stored as titles.
_IS_PREFIX = re.compile(r"^.{2,60}?\s+(?:is|are)\s+(?:hiring\s+(?:a|an|for)?\s*|looking\s+for\s+(?:a|an)?\s*|"
                        r"seeking\s+(?:a|an)?\s*)?(?=[A-Za-z].*(?:developer|engineer|programmer|sde))", re.I)
_REGEXY = re.compile(r"[\^$\\]|\(\?|/[a-z]*$|\.\*")
_SENTENCE = re.compile(r"\b(?:we are|we're|is a company|for developers|all \d of|our team|you will|"
                       r"join us|click|apply now)\b", re.I)


def clean_title(title: str) -> str:
    """A usable job title, or "" when the text is not a title at all."""
    t = re.sub(r"\s+", " ", (title or "")).strip(" -–—|:•")
    if not t:
        return ""
    t = _IS_PREFIX.sub("", t).strip()
    t = re.sub(r"(?i)\bfull\s*[-–]\s*stack\b", "Full-Stack", t)   # "Full - Stack" matched nothing
    if _REGEXY.search(t) or _SENTENCE.search(t) or len(t) > 90:
        return ""
    return t


# Numeral levels: "SDE III", "Software Engineer 3", "Developer - IV" are 5+ year
# roles. "II"/"2" is left alone (2-4 years is this candidate's band) but is
# kept out of grade A below.
_LEVEL_HIGH = re.compile(r"\b(?:sde|swe|software\s+(?:development\s+)?engineer|developer|engineer)"
                         r"[\s\-–,]*(?:iii|iv|v|3|4|5)\b", re.I)
_LEVEL_TWO = re.compile(r"\b(?:sde|swe|software\s+(?:development\s+)?engineer|developer|engineer)"
                        r"[\s\-–,]*(?:ii|2)\b", re.I)

# Titles that say nothing about the stack. A vague title needs the JD to prove
# the stack; a specific one ("React Developer") proves itself.
VAGUE_TITLE_WORDS = ("software engineer", "software developer", "sde", "web developer",
                     "developer", "engineer", "programmer",
                     # frontend/backend alone could be Angular, Vue, Spring, .NET...
                     "frontend", "front end", "front-end", "backend", "back end", "back-end")

# A title built on another framework is not ours unless it also names our stack:
# "Angular Full Stack" and "React + Spring Boot" differ in exactly that way.
_OTHER_STACK = re.compile(r"\bangular(?:js)?\b|\bvue(?:\.?js)?\b|\bspring(?:\s*boot)?\b|\bhibernate\b|"
                          r"\bjsp\b|\bstruts\b|\bperl\b|\bxamarin\b|\bsvelte\b|\bember\b", re.I)
_OUR_STACK_TITLE = re.compile(r"\breact(?:\.?js)?\b|\bnode(?:\.?js)?\b|\bnext(?:\.?js)?\b|\bmern\b|"
                              r"\bexpress\b|\bmongo(?:db)?\b|\btypescript\b|\bjavascript\b", re.I)

# Disciplines that are never a MERN/React role, whatever the JD name-drops. The
# profile's exclude_stacks covers the common ones; these are the ones the live
# pipeline let through ("C++ / HPC / GPU Computing Engineer" graded A on a JD
# that mentioned React, "AEM Front End Developer", "Computer Vision Engineer").
_OFF_DISCIPLINE = re.compile(
    r"c\+\+|\bc\b(?=\s*(?:/|developer|engineer))|\bhpc\b|\bgpu\b|\bcuda\b|\brust\b|\bscala\b|\belixir\b|"
    r"\baem\b|adobe experience|\bcomputer vision\b|\brobotic|\bautonomy\b|\bperception\b|\bhardware\b|"
    r"\bsdet\b|software development engineer in test|\bforward deployed\b|\bsolutions? engineer\b|"
    r"\bsupport engineer\b|\bnetworking engineer\b|\binfrastructure\b|\bplatform engineer\b|"
    r"\bsecurity engineer\b|\bexecutive\b|\boperations\b|\banalyst\b|\bsupport\b|\bblockchain\b|\bsolidity\b|\bgame\b|\bwebsite developer\b|\(go\)|\bgolang\b",
    re.I)

# -------------------------------------------------------------- employers --
# Mass-hiring IT-services firms. Their roles are real, but a cold email to
# careers@ never reaches the team and the stack is whatever the client uses.
SERVICES_FIRMS = (
    "accenture", "wipro", "capgemini", "tata consultancy", "tcs", "infosys", "cognizant",
    "hcl", "tech mahindra", "mphasis", "ltimindtree", "lti ", "genpact", "wns", "hexaware",
    "birlasoft", "coforge", "mastek", "zensar", "cyient", "deloitte", "pwc", "kpmg",
    "ernst", "ibm", "dxc", "ntt data", "virtusa", "sonata software", "kyndryl",
)

# ----------------------------------------------------------- remote jobs --
# Sources whose "Remote" means "remote for a US/EU company" unless the post
# says otherwise. Indian boards' "Work From Home" is already India-based.
REMOTE_INDIA_ONLY = True      # Settings > Scraper can switch this off (push.py sets it)
FOREIGN_REMOTE_PLATFORMS = {"hackernews", "remoteok", "weworkremotely", "remotive", "arbeitnow"}
_INDIA_OK = re.compile(r"\bindia\b|\bindian\b|\bapac\b|\basia\b|\bworldwide\b|\bglobal(?:ly)?\b|"
                       r"\banywhere\b|\bany\s*time\s*zone|\ball\s*time\s*zones\b|\bist\b|gmt\s*\+\s*5|"
                       r"\bbangalore\b|\bbengaluru\b|\bpune\b|\bnoida\b|\bdelhi\b|\blucknow\b|"
                       r"\bhyderabad\b|\bmumbai\b|\bgurugram\b|\bgurgaon\b", re.I)
_REGION_ONLY = re.compile(
    r"\b(?:us|u\.s\.|usa|u\.s\.a\.|united\s+states|eu|europe|european|uk|canada|north\s+america|emea|latam)"
    r"[\s\-]*(?:only|based|residents?|citizens?)\b|"
    r"\bmust\s+(?:be\s+)?(?:based|located|reside|live)\s+in\s+(?:the\s+)?(?:us|u\.s\.|usa|united\s+states|eu|europe|uk|canada)\b|"
    r"\b(?:eligible|authori[sz]ed|authori[sz]ation|right)\s+to\s+work\s+in\s+(?:the\s+)?(?:us|u\.s\.|usa|united\s+states|uk|eu)\b|"
    r"\bwork\s+authori[sz]ation\b|\bno\s+visa\s+sponsorship\b|\b(?:est|pst|cst|pt|et)\s+(?:hours|time\s*zone|timezone)\b|"
    r"\b(?:overlap|work)\s+(?:with|in)\s+(?:us|est|pst|european|eu)\b", re.I)


def remote_india_ok(job) -> Tuple[bool, str]:
    """(ok, reason). Only foreign-board remote jobs are questioned."""
    if not REMOTE_INDIA_ONLY or job.platform not in FOREIGN_REMOTE_PLATFORMS:
        return True, ""
    if classify(job.location_raw) != "rem" and not job.remote:
        return True, ""        # a city-based post from a foreign board is judged by its city
    text = f"{job.location_raw} {job.role} {' '.join(job.tags or [])} {(job.jd_text or '')[:4000]}"
    only = _REGION_ONLY.search(text)
    if only:
        return False, f"remote but restricted to a region ('{only.group(0)[:30]}')"
    if not _INDIA_OK.search(text):
        return False, "remote with no sign India is eligible"
    return True, ""


# ------------------------------------------------------------- experience --
def has_real_jd(job) -> bool:
    """Instahyre's jd_text is an employer tagline, not a job description."""
    return job.platform != "instahyre" and len((job.jd_text or "").strip()) >= 120


def resolve_experience(job) -> None:
    """Fill experience_min/max from the JD when the source didn't give it."""
    if job.experience_min is not None:
        return
    if not has_real_jd(job):
        return
    from scoring import parse_experience
    band = parse_experience(job.jd_text)
    if band:
        low, high = band
        job.experience_min = float(low)
        job.experience_max = float(high) if high is not None else None
        job.experience_raw = job.experience_raw or (f"{low}-{high} years" if high is not None else f"{low}+ years")


def normalise(jobs: List) -> int:
    """Repair titles and experience in place. Returns how many titles were fixed."""
    fixed = 0
    for job in jobs:
        cleaned = clean_title(job.role)
        if cleaned != job.role:
            fixed += 1
            job.role = cleaned          # "" means junk; relevance rejects it
        resolve_experience(job)
    return fixed


# ------------------------------------------------------------ hard reject --
def exp_ceiling() -> Optional[float]:
    v = _profile.exp_max()
    try:
        return float(v) if v not in (None, "", 99) else None
    except (TypeError, ValueError):
        return None


def hard_reject(job) -> Optional[str]:
    """Reason this job must not enter the pipeline, else None."""
    if not (job.role or "").strip():
        return "title is not a job title"
    off = _OFF_DISCIPLINE.search(job.role)
    if off:
        return f"title is a different discipline ('{off.group(0).strip()}')"
    other = _OTHER_STACK.search(job.role)
    if other and not _OUR_STACK_TITLE.search(job.role):
        return f"title is built on {other.group(0).strip()}, not your stack"
    if _LEVEL_HIGH.search(job.role):
        return "title level is III or above"
    ceiling = exp_ceiling()
    if ceiling is not None and job.experience_min is not None and job.experience_min > ceiling:
        return f"asks {job.experience_raw or str(job.experience_min) + '+ years'} (limit {ceiling:g})"
    ok, why = remote_india_ok(job)
    if not ok:
        return why
    return None


# -------------------------------------------------------------- grade cap --
_ORDER = {"A": 3, "B": 2, "C": 1, "D": 0}


def _vague(job) -> bool:
    """True when title+tags carry no stack information ("Software Engineer", "SDE")."""
    import relevance
    terms = [t for t in relevance.ROLE_TERMS if t.lower() not in VAGUE_TITLE_WORDS]
    return relevance._has_term(f"{job.role} {' '.join(job.tags or [])}", terms) is None


def _jd_skill_hits(job) -> int:
    from scoring import _matched_skills
    return len(_matched_skills(job.jd_text.lower())) if has_real_jd(job) else 0


def _reachable(job) -> bool:
    return bool(job.emails or job.phones or job.tier == "ats")


def is_services_firm(name: str) -> Optional[str]:
    low = f" {(name or '').lower()} "
    for firm in SERVICES_FIRMS:
        if re.search(r"(?<![a-z])" + re.escape(firm.strip()) + r"(?![a-z])", low):
            return firm.strip()
    return None


def grade_cap(job) -> Tuple[str, str]:
    """(best grade the evidence supports, why). 'A' means no cap."""
    firm = is_services_firm(job.company)
    if firm:
        return "C", f"{firm.title()} is a mass-hiring services firm — cold outreach won't reach the team"

    vague = _vague(job)
    if vague and _jd_skill_hits(job) < 2:
        return "C", "title names no stack and there is no job description to prove one"

    # Unverifiable and unreachable: only a title/tags that name *our* stack keep
    # such a lead at B ("Full Stack Engineer" alone could be Java or .NET).
    if not has_real_jd(job) and not _reachable(job) and job.tier in ("search", "aggregator"):
        if not _OUR_STACK_TITLE.search(f"{job.role} {' '.join(job.tags or [])}"):
            return "C", "no job description, no contact, and title/tags don't name your stack"

    # ---- what grade A needs, beyond a high score ----
    problems = []
    from scoring import _candidate_years
    candidate_years = float(_candidate_years())
    if job.experience_min is None:
        problems.append("experience not stated")
    elif job.experience_min > candidate_years:
        problems.append(f"wants {job.experience_min:g}+ years, candidate has {candidate_years:g}")
    if _LEVEL_TWO.search(job.role or ""):
        problems.append("level-II title")
    if not _reachable(job):
        problems.append("no contact route")
    if not (has_real_jd(job) or job.tier in ("direct", "ats")):
        problems.append("no job description")
    if vague:
        problems.append("generic title")
    if problems:
        return "B", "held at B: " + ", ".join(problems)
    return "A", ""


def apply_cap(job) -> None:
    """Lower job.grade/score to what the evidence supports (scoring layer calls this)."""
    from scoring import GRADE_A_MIN, GRADE_B_MIN, GRADE_C_MIN, grade_for
    cap, why = grade_cap(job)
    if _ORDER.get(job.grade, 0) <= _ORDER[cap]:
        return
    ceiling = {"A": 100, "B": GRADE_A_MIN - 1, "C": GRADE_B_MIN - 1, "D": GRADE_C_MIN - 1}[cap]
    job.score = min(job.score, ceiling)
    job.grade = grade_for(job.score)
    job.reasons.append(f"cap {cap}: {why}")
