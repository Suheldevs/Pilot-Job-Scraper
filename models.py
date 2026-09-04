"""Shared data model for every scraper layer.

Layers:
  1  discovery  — aggregator APIs + LinkedIn search (finds companies)
  2  ats        — Greenhouse / Lever / Ashby (authoritative, per company)
  3  enrich     — regex contact extraction from JD text
  4  score      — genuinity x match -> the two tags (platform, grade)
"""
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional

# Telltale of text that was UTF-8, got decoded as latin-1, and re-encoded —
# "Can’t" arrives as "Canâ€™t". Some feeds (RemoteOK) serve it already broken,
# so this is not something we can fix by choosing a decoder.
_MOJIBAKE = re.compile(r"[ÂâÃðÑ][\x80-\x9f-]")


# Legal-entity suffixes only — mirrors functions/lib/slug.js. Descriptive words
# ("Technologies", "Labs", "Systems") are deliberately kept: they distinguish
# genuinely different companies, and over-merging hides a lead entirely.
_ENTITY_SUFFIXES = [
    "private limited", "pvt limited", "pvt ltd", "pvt", "private",
    "limited", "ltd", "llp", "llc", "inc", "incorporated", "corp", "corporation",
    "co", "company", "gmbh", "bv", "nv", "ab", "oy", "sa", "srl", "spa", "plc",
    "pte", "pte ltd", "sdn bhd", "ag", "kg", "as",
]


def canonical_name(name: str) -> str:
    """Identity form of a company name — one row per real company."""
    s = str(name or "").lower()
    s = re.sub(r"[.,]", " ", s)
    s = re.sub(r"[()\[\]]", " ", s)
    s = s.replace("&", " and ")
    s = re.sub(r"\s+", " ", s).strip()

    changed = True
    while changed:
        changed = False
        for suffix in _ENTITY_SUFFIXES:
            if s.endswith(" " + suffix):
                s = s[: -(len(suffix) + 1)].strip()
                changed = True
    return s or str(name or "").lower().strip()


def fix_mojibake(text: str) -> str:
    """Recover double-encoded text, or return it untouched if it isn't broken."""
    if not text or not _MOJIBAKE.search(text):
        return text
    try:
        repaired = text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text
    # Only accept the repair if it actually removed the artefacts.
    return repaired if not _MOJIBAKE.search(repaired) else text


# Which layer a platform belongs to, and how much we trust it on its own.
# ATS boards are the company's own hiring system: if a job is there, it is real
# and open. Aggregators re-publish. LinkedIn search is the loosest — it mixes in
# staffing agencies and reposts.
PLATFORM_TIER = {
    # the company's own hiring board — if it's here, it's real and open
    "greenhouse": "ats",
    "lever": "ats",
    "ashby": "ats",
    "keka": "ats",
    # posted by the employer themselves, contact included
    "hackernews": "direct",
    # public feeds that re-publish someone else's posting
    "remotive": "aggregator",
    "arbeitnow": "aggregator",
    "remoteok": "aggregator",
    "weworkremotely": "aggregator",
    "instahyre": "aggregator",
    # search/crawl results — may be a repost or an agency
    "linkedin": "search",
    "naukri": "search",
    "firecrawl": "search",
    # harvested off a page a human was logged into
    "extension": "extension",
    "manual": "manual",
}


@dataclass
class Job:
    """One scraped job listing, before it becomes a company row."""

    company: str
    role: str
    url: str
    platform: str                     # key of PLATFORM_TIER
    location_raw: str = ""
    posted_raw: str = ""
    posted_at: Optional[datetime] = None
    jd_text: str = ""                 # full description when the source gives one
    tags: List[str] = field(default_factory=list)
    remote: bool = False

    # --- everything below is optional: sources vary wildly in what they give.
    # A Keka record carries salary, experience and skills; a Naukri sitemap
    # slug carries a title and a city and nothing else. All nullable so a thin
    # source is not forced to invent values.
    source_job_id: str = ""           # the source's own id, for its API
    apply_url: str = ""               # when the apply link differs from `url`
    employment_type: str = ""         # full-time | contract | internship | ...
    remote_type: str = ""             # remote | hybrid | onsite
    department: str = ""              # team or function
    salary_raw: str = ""              # as written, e.g. "8-14 LPA"
    salary_min: Optional[int] = None  # normalized, annual, source currency
    salary_max: Optional[int] = None
    salary_currency: str = ""
    experience_raw: str = ""          # as written, e.g. "2 to 4 years"
    experience_min: Optional[float] = None
    experience_max: Optional[float] = None
    company_size: str = ""
    company_website: str = ""
    openings_count: Optional[int] = None

    # The untouched payload the source returned for this job. Kept so a parsing
    # bug can be fixed and the data re-derived without re-scraping, and so a
    # field we did not think to model is not lost.
    raw: dict = field(default_factory=dict)

    # --- layer 3: filled by enrichment
    emails: List[str] = field(default_factory=list)
    phones: List[str] = field(default_factory=list)
    links: List[str] = field(default_factory=list)

    # --- layer 4: filled by scoring
    score: int = 0                    # 0-100
    grade: str = ""                   # A | B | C | D
    reasons: List[str] = field(default_factory=list)

    # set when the same job is corroborated by another platform
    also_on: List[str] = field(default_factory=list)

    scraped_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        # Repair once, centrally, so no source has to think about it and no
        # mangled name reaches the dashboard.
        self.company = fix_mojibake(self.company)
        self.role = fix_mojibake(self.role)
        self.jd_text = fix_mojibake(self.jd_text)
        self.location_raw = fix_mojibake(self.location_raw)

    # ---- identity -------------------------------------------------------
    def dedupe_key(self) -> str:
        """Canonical company + role — collapses re-postings across platforms."""
        return f"{canonical_name(self.company)}|{self.role.strip().lower()}"

    def company_key(self) -> str:
        """Canonical company name — the in-run identity, matching the server's."""
        return canonical_name(self.company)

    @property
    def tier(self) -> str:
        return PLATFORM_TIER.get(self.platform, "search")

    def raw_json(self, max_bytes: int = 8000) -> str:
        """The raw payload as JSON, capped so one verbose source can't bloat D1.

        Truncation keeps a marker rather than silently producing invalid JSON,
        so anyone reading the column later can tell it was cut.
        """
        if not self.raw:
            return ""
        try:
            text = json.dumps(self.raw, default=str, ensure_ascii=False)
        except (TypeError, ValueError):
            return ""
        if len(text.encode("utf-8")) <= max_bytes:
            return text
        clipped = text.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore")
        return json.dumps({"_truncated": True, "_prefix": clipped}, ensure_ascii=False)

    def age_days(self) -> Optional[int]:
        if not self.posted_at:
            return None
        posted = self.posted_at
        if posted.tzinfo is None:
            posted = posted.replace(tzinfo=timezone.utc)
        return max(0, (datetime.now(timezone.utc) - posted).days)


# Backwards compatibility: the original scrapers constructed Job(source=...).
# `platform` replaced `source`; keep a shim so nothing silently breaks.
def make_job(**kwargs) -> Job:
    if "source" in kwargs and "platform" not in kwargs:
        kwargs["platform"] = kwargs.pop("source")
    kwargs.pop("source", None)
    return Job(**kwargs)
