"""Layer 3 — pull contacts out of JD text with deterministic regex.

Ported from stackbase/server/src/lib/extract.js so both codebases agree on what
counts as a contact. No AI here on purpose: once we have the text, extraction is
a solved problem and a regex is free, reproducible and never hallucinates a
phone number that wasn't on the page.

The job-specific helpers on top of the port exist because a JD is noisier than
OCR'd text: it carries tracking pixels, Sentry DSNs and Wix boilerplate that all
look like valid addresses, and only some of the surviving addresses are worth a
cold email.
"""
import re
from typing import Dict, List, Optional, Tuple

from models import Job

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
# Explicit URLs (http/www) or bare domains that include a path
# (e.g. linkedin.com/in/x) — a bare domain with no path is usually prose.
LINK_RE = re.compile(
    r"\b(?:https?://|www\.)[^\s,;<>\"')]+"
    r"|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+/[^\s,;<>\"')]+",
    re.IGNORECASE,
)
# Loose phone candidate: a run of digits/spaces/dashes/parens, optional leading +.
PHONE_RE = re.compile(r"\+?\d[\d\s().-]{7,}\d")

_TRAILING_PUNCT_RE = re.compile(r"[.,;:]+$")
_NON_DIGIT_RE = re.compile(r"\D")

# Domains that only ever show up as instrumentation or template leftovers.
# Matched on the domain itself or any subdomain of it.
NOISE_EMAIL_DOMAINS = (
    "example.com",
    "sentry.io",
    "wixpress.com",
    "domain.com",
)

# A CSS/HTML scrape turns `logo@2x.png` and friends into "addresses".
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp")

# Real inboxes, but nobody reads a resume sent there — keep them, class them
# general so they never get counted as a hiring contact.
GENERAL_ONLY_LOCALS = {
    "noreply", "no-reply", "donotreply", "do-not-reply",
    "postmaster", "abuse", "privacy", "legal", "support", "info",
}

# Recruitment intent in an address. Split into exact-token and substring sets
# because `hr` and `cv` are too short to match loosely — "cv" as a substring
# hits names like "mcvey", and "hr" hits "christina".
_HR_EXACT_TOKENS = {"hr", "cv", "hrd"}
_HR_TOKEN_PREFIXES = ("hr", "job")
_HR_SUBSTRINGS = ("career", "recruit", "talent", "hiring", "apply", "resume")

_LOCAL_TOKEN_RE = re.compile(r"[^a-z0-9]+")


def _clean(value: str) -> str:
    """Strip trailing sentence punctuation that the regexes greedily swallow."""
    return _TRAILING_PUNCT_RE.sub("", value).strip()


def normalize_phone(raw: str) -> Optional[str]:
    """Digits only, leading + preserved. None when the run isn't phone-shaped."""
    has_plus = raw.strip().startswith("+")
    digits = _NON_DIGIT_RE.sub("", raw)
    if len(digits) < 8 or len(digits) > 15:
        return None  # reject junk: dates, salary bands, pincode runs
    return ("+" if has_plus else "") + digits


def extract_contacts(text: str) -> Dict[str, List[str]]:
    """Normalized, deduped, order-preserving contacts found in `text`."""
    out: Dict[str, List[str]] = {"emails": [], "phones": [], "links": []}
    if not text:
        return out

    seen = set()

    def add(kind: str, value: str) -> None:
        key = f"{kind}:{value.lower()}"
        if not value or key in seen:
            return
        seen.add(key)
        out[kind].append(value)

    emails = EMAIL_RE.findall(text)
    for email in emails:
        add("emails", _clean(email).lower())

    # One blob of every email found, so an email's own domain doesn't get
    # re-reported as a link the reader is meant to open.
    email_blob = " ".join(emails).lower()

    for link in LINK_RE.findall(text):
        value = _clean(link)
        if "@" in value:
            continue  # part of an email, not a link
        if value.lower() in email_blob:
            continue
        add("links", value.rstrip("/"))

    for phone in PHONE_RE.findall(text):
        normalized = normalize_phone(phone)
        if normalized:
            add("phones", normalized)

    return out


# ---- job-specific helpers ----------------------------------------------

def _local_and_domain(email: str) -> Tuple[str, str]:
    local, _, domain = email.lower().rpartition("@")
    return local, domain


def is_noise_email(email: str) -> bool:
    """True for addresses that are instrumentation or scrape artefacts."""
    local, domain = _local_and_domain(email)
    if not local or not domain:
        return True
    for noise in NOISE_EMAIL_DOMAINS:
        if domain == noise or domain.endswith("." + noise):
            return True
    # `logo@2x.png` splits as local "logo" / domain "2x.png", so the extension
    # can land on either side of the @ depending on the filename.
    return local.endswith(IMAGE_SUFFIXES) or domain.endswith(IMAGE_SUFFIXES)


def _looks_like_hr(local: str) -> bool:
    if local in GENERAL_ONLY_LOCALS:
        return False  # an autoresponder inbox is never a hiring contact
    if any(fragment in local for fragment in _HR_SUBSTRINGS):
        return True
    for token in _LOCAL_TOKEN_RE.split(local):
        if not token:
            continue
        if token in _HR_EXACT_TOKENS:
            return True
        if token.startswith(_HR_TOKEN_PREFIXES) and len(token) > 2:
            return True  # hrteam, hrindia, jobsposting
    return False


def split_contacts(emails: List[str],
                   text: str = "") -> Tuple[List[str], List[str]]:
    """Split into (hr_emails, general_emails), dropping obvious noise.

    `text` is optional surrounding copy: an address printed right after
    "send your resume to" is a hiring contact even when the local part is a
    person's name, so we let the nearby words vote too.
    """
    hr: List[str] = []
    general: List[str] = []

    lowered = text.lower() if text else ""

    for email in emails:
        address = email.strip().lower()
        if not address or is_noise_email(address):
            continue
        local, _ = _local_and_domain(address)
        if _looks_like_hr(local) or _context_suggests_hr(address, lowered):
            hr.append(address)
        else:
            general.append(address)

    return hr, general


# Window of characters before an address that we treat as "surrounding text".
_CONTEXT_WINDOW = 80


def _context_suggests_hr(address: str, lowered_text: str) -> bool:
    """Recruitment wording immediately before the address in the source text."""
    if not lowered_text:
        return False
    index = lowered_text.find(address)
    if index == -1:
        return False
    local, _ = _local_and_domain(address)
    if local in GENERAL_ONLY_LOCALS:
        return False
    window = lowered_text[max(0, index - _CONTEXT_WINDOW):index]
    return any(fragment in window for fragment in _HR_SUBSTRINGS)


def indian_mobile(phone: str) -> bool:
    """True for a normalized number shaped like an Indian mobile.

    Matters because a WhatsApp deep link needs a real mobile — landlines and
    toll-free numbers in the same JD are dead ends for outreach.
    """
    digits = _NON_DIGIT_RE.sub("", phone or "")
    if len(digits) == 12:
        return digits.startswith("91") and digits[2] in "6789"
    if len(digits) == 10:
        return digits[0] in "6789"
    return False


def enrich_job(job: Job) -> None:
    """Fill job.emails / phones / links from job.jd_text, in place."""
    contacts = extract_contacts(job.jd_text)
    # Noise is dropped here rather than in extract_contacts so the ported
    # extractor stays a faithful mirror of the JS one.
    job.emails = [e for e in contacts["emails"] if not is_noise_email(e)]
    job.phones = contacts["phones"]
    job.links = contacts["links"]
