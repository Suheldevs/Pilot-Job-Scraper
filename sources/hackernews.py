"""The monthly "Ask HN: Who is hiring?" thread, via the public Algolia API.

This is the best *contact* source we have. Thread rules bar recruiters and
agencies, so every post is written by the employer themselves — usually a
founder or the hiring engineer — and a large share of them print a direct
email address in the body. Layer 3 (extract.py) then gets a real inbox out of
the same text, which almost no ATS board gives us.

Two official endpoints, no auth, no scraping:

  1. https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring
     — every thread the whoishiring bot has posted, newest first. The bot also
     posts "Who wants to be hired?" and "Freelancer?", so titles are matched
     against /who is hiring/i rather than taken on position.
  2. https://hn.algolia.com/api/v1/items/{id}
     — the whole comment tree in one response. Only the **top-level** children
     are job posts; deeper nodes are replies asking about visas or salary.

Posts are free-form prose with a loose convention on the first line:
`Company | Role | Location | Remote/Onsite | tech`. Parsing is deliberately
pragmatic — where the company cannot be identified the post is skipped rather
than stored as "Unknown", because an unnamed company cannot be deduped
against the rest of the pipeline and cannot be contacted.

Most posts are US or remote rather than India. That is expected: the value
here is the email address, and locations.py drops anything outside the tabs
we track, so no filtering for India happens (or is faked) at this layer.
"""
from datetime import datetime, timezone
import html
import re
from typing import List, Optional

from bs4 import BeautifulSoup
import httpx

import config
from models import Job
from sources.base import Source

SEARCH = ("https://hn.algolia.com/api/v1/search_by_date"
          "?tags=story,author_whoishiring&hitsPerPage=6")
ITEM = "https://hn.algolia.com/api/v1/items/{item_id}"
COMMENT_URL = "https://news.ycombinator.com/item?id={comment_id}"

_WHO_IS_HIRING = re.compile(r"who\s+is\s+hiring", re.IGNORECASE)

# HN comment HTML uses <p> as an opening-only separator and never wraps the
# first paragraph, so paragraph breaks have to be turned into real newlines
# before tags are stripped — otherwise the convention-bearing first line runs
# into the body copy and the "|" split picks up half the post.
_BREAK_RE = re.compile(r"<\s*(?:p|br)\s*/?\s*>", re.IGNORECASE)

# Separators used in the header line, in order of preference. "|" is the
# convention; the dashes are the common deviation.
_SEPARATORS = ("|", "—", "–", " - ")

# A segment counts as the role when it mentions one of these. Kept broad
# because HN posters write "Founding Researcher", "SRE", "Rails dev" and
# "Multiple Engineering + Product Roles" in the same slot. Matched with word
# boundaries so "ops" does not fire on "shops" and "dev" not on "device".
_ROLE_RE = re.compile(
    r"(?<![a-z])(?:engineer|engineering|developer|dev|designer|scientist"
    r"|analyst|architect|manager|programmer|researcher|research|intern"
    r"|sre|swe|devops|qa|sdet|founding|hacker|consultant|roles|role"
    r"|cto|technologist)(?:s|ing)?(?![a-z])",
    re.IGNORECASE,
)

# Location hints for a segment that names no city we would recognize
# ("REMOTE", "ONSITE (hybrid)"). Word boundaries matter more here than
# anywhere else: as substrings, "us" hits "because" and "eu" hits "Europe"
# via unrelated words, which would make almost every segment a location.
_LOCATION_RE = re.compile(
    r"(?<![a-z])(?:remote|onsite|on-site|hybrid|anywhere|worldwide|wfh"
    r"|work\s+from\s+home|usa?|uk|eu|emea|apac|europe|india|canada"
    r"|germany|netherlands|australia|singapore)(?![a-z])",
    re.IGNORECASE,
)

_REMOTE_RE = re.compile(
    r"(?<![a-z])(?:remote|work\s+from\s+home|wfh)(?![a-z])",
    re.IGNORECASE,
)

# Employment-type segments. Neither the role nor the location, but they sit
# between the two often enough to be mistaken for either.
_JOB_TYPE_RE = re.compile(
    r"(?<![a-z])(?:full[\s-]?time|part[\s-]?time|contract(?:or)?|internship"
    r"|permanent|freelance|temporary|c2c|w2|hrs?|hours)(?![a-z])",
    re.IGNORECASE,
)

# Compensation segments — "$150 - 210K USD + equity", "€75k–110k", "$120-160/hr".
_COMP_RE = re.compile(r"[$€£₹]|(?<![a-z])(?:usd|eur|gbp|inr|equity|salary)"
                      r"(?![a-z])|\d\s*k(?![a-z])", re.IGNORECASE)

# Fallback role, read out of the body when the header omits it (plenty of
# posts open "Company | https://site | City | Full-time" and name the role a
# line later). Verbatim capture only — a phrase the poster actually wrote,
# never a label we invent.
_ROLE_PHRASE_RE = re.compile(
    r"\b((?:(?:senior|staff|principal|lead|founding|junior|mid[\s-]level"
    r"|full[\s-]?stack|front[\s-]?end|back[\s-]?end|software|product|data"
    r"|machine\s+learning|ml|ai|platform|infrastructure|security|mobile"
    r"|systems?|site\s+reliability|qa|devops|embedded|applied|research)\s+)"
    r"{0,3}(?:engineer|developer|designer|scientist|architect|programmer"
    r"|researcher)s?)\b",
    re.IGNORECASE,
)

# Every word that can legitimately appear in a job title and nothing else.
# Used to tell "Lead SWE" (a role in the company slot) from "G-Research" (a
# company whose name contains a role word) — see _looks_like_company.
_ROLE_ONLY_WORDS = {
    "senior", "sr", "staff", "principal", "lead", "junior", "jr", "mid",
    "level", "founding", "full", "stack", "fullstack", "front", "end",
    "frontend", "back", "backend", "software", "product", "data", "machine",
    "learning", "ml", "ai", "platform", "infrastructure", "security",
    "mobile", "systems", "system", "site", "reliability", "qa", "devops",
    "embedded", "applied", "research", "engineer", "engineers",
    "engineering", "developer", "developers", "dev", "devs", "designer",
    "scientist", "analyst", "architect", "programmer", "researcher",
    "intern", "sre", "swe", "sdet", "cto", "role", "roles", "hiring",
    "multiple", "and", "or", "web", "cloud",
}

# Bare URLs left inline after tag stripping — posters put the company site in
# the company slot ("Snout https://snout.com/") or in its own segment.
_URL_RE = re.compile(r"\b(?:https?://|www\.)\S+", re.IGNORECASE)

# Word-boundary keyword match. A plain substring test makes "react" hit
# "reactivations" and "node" hit "nodes", which quietly poisons the feed with
# unrelated posts. re.escape keeps tokens like "next.js" and "front-end"
# literal, and the boundaries are custom because \b sits badly next to "." —
# "next.js\b" would never match at end of "next.js".
_KEYWORD_RE = re.compile(
    r"(?<![a-z0-9])(?:" +
    "|".join(re.escape(k) for k in config.MATCH_KEYWORDS) +
    r")(?![a-z0-9])",
    re.IGNORECASE,
)


def _plain_text(raw: str) -> str:
    """Comment HTML -> plain text, keeping paragraph structure as newlines."""
    if not raw:
        return ""
    # Paragraph markers become newlines first (see _BREAK_RE), then tags are
    # stripped joining inline nodes with a space so an anchor inside the
    # header line stays on that line instead of splitting the company off.
    text = BeautifulSoup(_BREAK_RE.sub("\n", raw), "lxml").get_text(" ")
    # BeautifulSoup already resolves entities in text nodes; this second pass
    # catches doubly-escaped copy ("&amp;#x2F;") that some posters paste in.
    text = html.unescape(text)
    # Collapse horizontal whitespace (incl. the non-breaking spaces posters
    # paste in) while keeping the line breaks the header parse depends on.
    text = re.sub(r"[^\S\n]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return "\n".join(line.strip() for line in text.split("\n")).strip()


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """created_at is ISO-8601 Zulu ("2026-09-01T15:01:54.000Z")."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _tidy(segment: str) -> str:
    """One header segment, stripped of the URL posters put inside it.

    The anchor in "Snout https://snout.com/ | ..." becomes plain text once
    tags are stripped, and "Smarkets ( https://smarkets.com )" leaves an
    orphaned bracket pair behind, so both are cleared here — before any slot
    is identified, since a URL contains role and location words of its own.
    """
    text = _URL_RE.sub(" ", segment)
    text = re.sub(r"\(\s*\)", " ", text)          # bracket left empty by the URL
    text = re.sub(r"\s+", " ", text).strip()
    # Brackets are kept: "(Hybrid)" and "(Rust)" are part of the slot's
    # meaning, and stripping the closer alone leaves "REMOTE (US" on screen.
    text = text.strip(" .,;:-–—*|√✓•")
    return text.rstrip("(").lstrip(")").strip()


def _clean_company(segment: str) -> str:
    """Slot 0 only: drop the parenthesised aside posters attach to the name.

    "Monumint (YC W24)" and "Shepherd (Series B)" have to reduce to the bare
    name, because canonical_name() in models.py is what matches this lead
    against the same company arriving from an ATS board, and it does not know
    that "(YC W24)" is decoration.
    """
    text = re.sub(r"\([^()]*\)", " ", segment)
    text = re.sub(r"[\[\]{}<>]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text.strip(" .,;:-–—*|").strip()


def _split_header(line: str) -> List[str]:
    """Split the header line on the first separator convention present, so a
    company name containing a dash survives a post that used "|" for real.

    Segments that were only a URL come back empty from _tidy and are dropped:
    the convention counts slots by position, and a bare-link slot would push
    the role one place to the right.
    """
    for sep in _SEPARATORS:
        if sep in line:
            return [seg for seg in (_tidy(p) for p in line.split(sep)) if seg]
    tidied = _tidy(line)
    return [tidied] if tidied else []


def _looks_like_company(name: str, had_separator: bool) -> bool:
    """Reject the slot when it clearly isn't a company name.

    Some top-level comments are thread meta ("Please normalize the format"),
    and some posts open with a sentence instead of the convention. Either
    would otherwise be stored as a company we can never contact or dedupe.
    """
    if not name or len(name) < 2 or len(name) > 60:
        return False
    if not re.search(r"[A-Za-z]", name):
        return False
    words = name.split()
    # A company slot is a name, not a sentence. Only sentence-final dots
    # count: a dot followed by a letter is part of the name itself, and
    # domain-style names ("Modash.io", "Jawa.gg", "VersaFeed.com") are one of
    # the most common forms in this thread.
    if len(words) > 5 or re.search(r"[!?:]", name) or re.search(r"\.(?:\s|$)", name):
        return False
    # A slot that is nothing but a job title ("Lead SWE | ON SITE TORONTO |
    # ...") means the poster skipped the company entirely, and a role stored
    # as a company name is worse than no row at all. Tested word by word, not
    # by searching for a role word: "G-Research" is a real company whose name
    # happens to contain one.
    tokens = [t for t in re.split(r"[^A-Za-z0-9+#]+", name.lower()) if t]
    if tokens and all(t in _ROLE_ONLY_WORDS for t in tokens):
        return False
    # With no separator at all there is no slot structure to trust, so only a
    # bare name is accepted — "Moyai Agent Reliability Engineering" would
    # otherwise be filed as the company's name rather than Moyai's.
    if not had_separator and len(words) > 2:
        return False
    # "We are hiring", "Looking for a Rust dev" — prose, not a name.
    return words[0].lower() not in {
        "we", "i", "our", "the", "hiring", "looking", "please", "job", "jobs",
        "role", "roles", "position", "seeking", "anyone", "does",
    }


def _pick_role(segments: List[str]) -> str:
    """First later segment that names a role.

    Slot 2 is the convention, but posters put "(YC W21)", the company URL, a
    city or "Full Time" there often enough that the whole tail is scanned —
    and a segment with no role word is never taken, because guessing by
    position is what produces roles like "Full Time" and "ONSITE".
    """
    for segment in segments[1:]:
        if not _ROLE_RE.search(segment):
            continue
        # "Contract / Part-time (10-40 hrs/wk)" contains "contract", which is
        # an employment type rather than a job title.
        if _JOB_TYPE_RE.search(segment) and not _ROLE_PHRASE_RE.search(segment):
            continue
        return segment[:150].strip()
    return ""


def _role_from_body(lines: List[str]) -> str:
    """Role phrase lifted verbatim from the body when the header omits one.

    Roughly one post in six writes "Company | https://site | City | Full-time"
    and names the job in the next paragraph. Taking the poster's own phrase
    keeps the row truthful; the alternative (a placeholder like "Engineer")
    would read as data we were told rather than data we guessed.
    """
    for line in lines:
        match = _ROLE_PHRASE_RE.search(line)
        if match:
            phrase = re.sub(r"\s+", " ", match.group(1)).strip()[:150]
            # Mid-sentence prose gives "senior engineers"; title-case it so
            # the dashboard column reads consistently with header-derived
            # roles. Only when it is entirely lowercase, so a deliberate
            # capitalisation ("SRE", "iOS Developer") is left alone.
            return phrase.title() if phrase.islower() else phrase
    return ""


def _pick_location(segments: List[str], role: str, text: str) -> str:
    """The segment that looks most like a location.

    Scored rather than first-match: "Shepherd | ONSITE | San Francisco, CA"
    has two location-ish slots and the city is the one locations.py can
    actually classify. A "City, ST" shape therefore outranks a bare
    "ONSITE", and a slot with both ("Chicago, IL / Remote") outranks either.
    """
    best = ""
    best_score = 0

    for segment in segments[1:]:
        if segment == role or _COMP_RE.search(segment):
            continue  # compensation sits in the same slot often enough

        # The last slot regularly runs straight into the body when the poster
        # used a line break instead of a paragraph, so keep the first sentence.
        candidate = re.split(r"(?<=[.!?])\s+(?=[A-Z])", segment)[0].strip()
        if len(candidate.split()) > 12:
            continue  # prose, not a location slot

        score = 0
        if _LOCATION_RE.search(candidate):
            score += 1
        # A comma-separated place with no digits — "Utrecht, The Netherlands",
        # "Minneapolis, MN (Hybrid)". Digits would mean a salary or a date.
        if "," in candidate and not re.search(r"\d", candidate) and \
                len(candidate.split()) <= 8:
            score += 2
        if score > best_score:
            best, best_score = candidate, score

    if best:
        return best[:120]

    # No location slot at all: if the body says remote anywhere, that is the
    # only thing we can honestly record.
    return "Remote" if _REMOTE_RE.search(text) else ""


class HackerNewsSource(Source):
    name = "hackernews"

    def __init__(self, max_threads: int = 2):
        # Two threads is roughly two months of posts. More is mostly stale:
        # a role posted three months ago is usually filled, and each thread is
        # a ~400KB response.
        self.max_threads = max(1, max_threads)

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            thread_ids = self._recent_threads(client)
            if not thread_ids:
                print(f"[{self.name}] no 'who is hiring' threads found")
                return jobs

            for item_id in thread_ids:
                self._pace()  # same Algolia host as the search above
                item = self._fetch_item(client, item_id)
                if item:
                    jobs.extend(self._parse_thread(item))

        return jobs

    def _recent_threads(self, client: httpx.Client) -> List[str]:
        """objectIDs of the newest /who is hiring/i stories, newest first."""
        resp = self._fetch(client, SEARCH)
        if resp is None:
            return []
        try:
            data = self._json(resp)
        except ValueError:
            print(f"[{self.name}] search response wasn't JSON")
            return []

        ids: List[str] = []
        for hit in (data or {}).get("hits") or []:
            if not isinstance(hit, dict):
                continue
            # The same bot posts "Who wants to be hired?" and "Freelancer?"
            # in the same minute, so the title decides, not the ordering.
            if not _WHO_IS_HIRING.search(hit.get("title") or ""):
                continue
            object_id = str(hit.get("objectID") or "").strip()
            if object_id and object_id not in ids:
                ids.append(object_id)
            if len(ids) >= self.max_threads:
                break

        return ids

    def _fetch_item(self, client: httpx.Client, item_id: str) -> Optional[dict]:
        resp = self._fetch(client, ITEM.format(item_id=item_id))
        if resp is None:
            return None
        try:
            data = self._json(resp)
        except ValueError:
            print(f"[{self.name}] item {item_id}: response wasn't JSON")
            return None
        return data if isinstance(data, dict) else None

    def _parse_thread(self, item: dict) -> List[Job]:
        children = item.get("children") or []
        title = item.get("title") or item.get("id")

        jobs: List[Job] = []
        seen = 0
        matched = 0

        for child in children:
            if not isinstance(child, dict):
                continue
            seen += 1

            text = _plain_text(child.get("text") or "")
            if not text:
                continue  # deleted or flagged comment
            # Keyword filter runs on the whole post, not just the header: the
            # stack is usually listed in the body, not in the first line.
            if not _KEYWORD_RE.search(text):
                continue
            matched += 1

            job = self._parse_comment(child, text)
            if job is not None:
                jobs.append(job)

        # Three numbers because they diverge for different reasons: posts that
        # are off-stack, and posts we could not attribute to a company.
        print(f"[{self.name}] {title}: {seen} top-level posts, "
              f"{matched} matched keywords, {len(jobs)} parsed")
        return jobs

    def _parse_comment(self, comment: dict, text: str) -> Optional[Job]:
        lines = [line for line in text.split("\n") if line.strip()]
        if not lines:
            return None

        header = lines[0]
        had_separator = any(sep in header for sep in _SEPARATORS)
        segments = _split_header(header)
        if not segments:
            return None

        company = _clean_company(segments[0])
        if not _looks_like_company(company, had_separator):
            # Deliberately dropped rather than emitted as "Unknown": an
            # unnamed lead cannot be deduped or contacted.
            return None

        role = _pick_role(segments) or _role_from_body(lines[1:])
        if not role:
            return None  # nothing in the post names a job we can label

        location = _pick_location(segments, role, text)
        created = comment.get("created_at") or ""
        comment_id = comment.get("id")
        if comment_id in (None, ""):
            return None  # without the id there is no clickable lead

        # Remote-ness comes from the location slot when there is one, and only
        # falls back to the body otherwise: an onsite post whose body mentions
        # a remote-friendly culture would otherwise be flagged remote and land
        # on the wrong tab.
        return Job(
            company=company,
            role=role,
            # Link to the comment, not the thread, so the lead opens on the
            # actual post instead of a 400-comment page.
            url=COMMENT_URL.format(comment_id=comment_id),
            platform=self.name,
            location_raw=location,
            posted_raw=created,
            posted_at=_parse_iso(created),
            jd_text=text,
            tags=[],
            remote=bool(_REMOTE_RE.search(location or text)),
        )
