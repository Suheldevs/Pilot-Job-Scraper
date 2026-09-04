"""Keka career boards — one keyless endpoint per tenant subdomain.

https://{tenant}.keka.com/careers/api/jobs/default/active

Keka is the HR suite a large share of Indian SMEs run on, which makes this
the India-focused ATS layer: the same companies that never appear on
Greenhouse or Ashby do have a Keka board.

Each tenant's robots.txt is `Disallow: /` **plus `Allow: /careers`**, so this
path is explicitly permitted rather than merely unblocked. Everything below
stays under /careers for that reason.

Two quirks drive the shape of this module:

  * The endpoint answers with a **bare JSON array**, not an object wrapper.
  * A subdomain that is not a Keka customer answers **302** (to
    /careers/Content/TenantNotFound.html), so redirects are deliberately NOT
    followed — following one turns "no such tenant" into a 200 page of HTML
    that only fails later, at JSON parse time.

As with any ATS board this is the company's own hiring system, so nothing is
keyword-filtered: if we are watching a board on purpose we want all of it.
"""
from datetime import datetime, timedelta, timezone
import html
import re
import time
from typing import Any, List, Optional

from bs4 import BeautifulSoup
import httpx

import config
from models import Job
from sources.base import Source

BOARD = "https://{tenant}.keka.com/careers/api/jobs/default/active"
JOB_URL = "https://{tenant}.keka.com/careers/jobdetails/{job_id}"

PROBE_LOG = "keka_probe"

# Statuses that mean "this subdomain isn't a Keka customer" — expected, not
# an error worth retrying or logging per attempt.
_MISSING_TENANT = (301, 302, 303, 307, 308, 404)

# The active-jobs payload carries no display name today (verified against
# five live tenants), so the slug fallback in _company_name is what actually
# runs. These are checked first anyway, so a field that does appear on some
# tenant's build is used instead of being silently ignored.
_COMPANY_NAME_KEYS = ("companyName", "organizationName", "tenantName", "company")


def _plain_text(raw: str) -> str:
    """HTML description -> plain text.

    Entities are unescaped before tag stripping, mirroring greenhouse.py: the
    descriptions are rich-text editor output and arrive with entities inside
    the markup, so stripping first would leave "&amp;" visible in jd_text.
    Both scoring and contact extraction read this text, so an address written
    as "hr&#64;x.com" has to be resolved before extract.py sees it.
    """
    if not raw:
        return ""
    text = BeautifulSoup(html.unescape(raw), "lxml").get_text(" ", strip=True)
    return re.sub(r"\s+", " ", text).strip()


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """publishedOn is ISO-8601 Zulu with a variable-length fraction
    ("2026-09-03T14:20:24.41Z"), which fromisoformat accepts on 3.11+."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _from_since_days(value: Any) -> Optional[datetime]:
    """Fallback when publishedOn is missing: publishedSinceDays is an int
    counted from today, so the reconstructed date is day-accurate only. That
    is enough — everything downstream uses age in days, not the timestamp.
    """
    try:
        days = int(value)
    except (TypeError, ValueError):
        return None
    if days < 0:
        return None
    return datetime.now(timezone.utc) - timedelta(days=days)


def _location_text(locations: Any) -> str:
    """Join jobLocations into one string locations.py can classify.

    `name` is whatever the tenant typed ("Pune HQ", "INDIA"), so `city` is
    preferred and `name` used only when there is no city. A single job may
    list several offices; they are kept (deduped) rather than truncated so a
    Bangalore-and-Pune role is visible on both tabs.
    """
    if not isinstance(locations, list):
        return ""

    parts: List[str] = []
    for loc in locations:
        if not isinstance(loc, dict):
            continue
        city = (loc.get("city") or loc.get("name") or "").strip()
        state = (loc.get("state") or "").strip()
        country = (loc.get("countryName") or "").strip()

        # City first; fall back to country so an office with neither city nor
        # state still produces something classifiable.
        label = ", ".join(p for p in (city, state) if p) or country
        if label and label not in parts:
            parts.append(label)

    return " | ".join(parts)


def _candidates(name: str) -> List[str]:
    """Slug guesses for a company name, mirroring sources/ats_probe.py:
    "Bacancy Technologies" -> bacancy-technologies, bacancytechnologies,
    bacancy. Keka tenants use all three conventions."""
    cleaned = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not cleaned:
        return []

    out = [cleaned]
    squashed = cleaned.replace("-", "")
    if squashed and squashed not in out:
        out.append(squashed)

    # Bare first word only if it is distinctive — a short token like "the"
    # or "go" would probe some unrelated tenant's board.
    first = cleaned.split("-")[0]
    if len(first) >= 4 and first not in out:
        out.append(first)

    return out[:3]


class KekaSource(Source):
    name = "keka"

    def __init__(self, slugs: List[str]):
        # Tenant subdomains are lowercase; normalize so a display-cased slug
        # from the probe or a config file still resolves.
        self.slugs = [s.strip().lower() for s in slugs if s and s.strip()]

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}

        # follow_redirects=False on purpose: the 302 IS the "not a tenant"
        # answer, and following it hides that behind a 200 HTML page.
        with httpx.Client(headers=headers, follow_redirects=False) as client:
            for slug in self.slugs:
                records = self._fetch_board(client, slug)
                if records is not None:
                    jobs.extend(self._parse_board(slug, records))
                self._pace()  # separate tenants, but all on keka.com

        return jobs

    def _fetch_board(self, client: httpx.Client,
                     slug: str) -> Optional[List[dict]]:
        """One plain GET first — a non-tenant answers 302 and the retrying
        helper would hit it three times and log each attempt. Anything else
        falls through to _fetch so real transient errors still get retries.
        """
        url = BOARD.format(tenant=slug)
        try:
            resp = client.get(url, timeout=config.REQUEST_TIMEOUT)
        except httpx.RequestError:
            resp = None

        if resp is not None and resp.status_code in _MISSING_TENANT:
            return None  # this company just isn't a Keka customer
        if resp is None or resp.status_code != 200:
            resp = self._fetch(client, url)
            if resp is None:
                return None

        try:
            data = self._json(resp)
        except ValueError:
            print(f"[{self.name}] {slug}: response wasn't JSON")
            return None

        # Documented shape is a bare array; tolerate an object wrapper in case
        # a tenant is on a newer build of the careers app.
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ("data", "jobs", "items"):
                if isinstance(data.get(key), list):
                    return data[key]
        return None

    def _company_name(self, slug: str, records: List[dict]) -> str:
        for item in records:
            if not isinstance(item, dict):
                continue
            for key in _COMPANY_NAME_KEYS:
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

        # Fallback: the tenant slug is not a display name, so this is a guess
        # ("bacancy" -> "Bacancy"). canonical_name() in models.py collapses it
        # against the real name if another source supplies one for the same
        # company, so a slightly-off label does not split the lead.
        return slug.replace("-", " ").replace("_", " ").title()

    def _parse_board(self, slug: str, records: List[dict]) -> List[Job]:
        company = self._company_name(slug, records)
        jobs: List[Job] = []

        for item in records:
            if not isinstance(item, dict):
                continue

            role = (item.get("title") or "").strip()
            job_id = item.get("id")
            if not role or job_id in (None, ""):
                continue

            location = _location_text(item.get("jobLocations"))
            published = item.get("publishedOn") or ""
            posted_at = _parse_iso(published) or \
                _from_since_days(item.get("publishedSinceDays"))

            # Keka states locations as cities, so a remote role shows up as a
            # tenant-created "Remote" pseudo-location rather than a flag.
            jobs.append(Job(
                company=company,
                role=role,
                url=JOB_URL.format(tenant=slug, job_id=job_id),
                platform=self.name,
                location_raw=location,
                posted_raw=published or str(item.get("publishedSinceDays") or ""),
                posted_at=posted_at,
                jd_text=_plain_text(item.get("description") or ""),
                tags=[s.strip() for s in (item.get("skillNames") or [])
                      if isinstance(s, str) and s.strip()],
                remote="remote" in location.lower(),
            ))

        return jobs


def probe_keka(names: List[str], max_probes: int = 30) -> List[str]:
    """Turn company names into live Keka tenant slugs.

    Same courtesy-scan contract as sources/ats_probe.py: at most 3 candidates
    per company, `max_probes` requests overall, every request paced, and a
    company stops being probed once one of its candidates resolves.

    A 302 is the tenant-not-found redirect, so it counts as "not a customer".
    A 200 with an empty array means the tenant exists but has nothing open,
    which is useless as a lead — so postings are required before claiming a
    match, matching _has_jobs() in ats_probe.
    """
    resolved: List[str] = []
    headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}
    probes = 0
    capped = False

    with httpx.Client(headers=headers, follow_redirects=False) as client:
        for name in names:
            if probes >= max_probes:
                capped = True
                break

            for slug in _candidates(name):
                if probes >= max_probes:
                    capped = True
                    break

                probes += 1
                if _tenant_has_jobs(client, slug):
                    if slug not in resolved:
                        resolved.append(slug)
                    break  # this company is found; stop guessing for it

                time.sleep(config.DELAY_BETWEEN_REQUESTS)  # same host every time

    print(f"[{PROBE_LOG}] {probes} probes over {len(names)} companies"
          f"{' (capped)' if capped else ''} -> "
          f"{','.join(resolved) if resolved else '-'}")

    return resolved


def _tenant_has_jobs(client: httpx.Client, slug: str) -> bool:
    """True only for a real tenant with at least one active posting."""
    try:
        resp = client.get(BOARD.format(tenant=slug),
                          timeout=config.REQUEST_TIMEOUT)
    except httpx.RequestError:
        return False

    if resp.status_code != 200:
        return False  # 302 (not a tenant) is the normal answer here

    try:
        # Source._json is a staticmethod: the same forced-UTF-8 decode the
        # source itself uses, without needing an instance to probe.
        data: Any = Source._json(resp)
    except ValueError:
        return False

    postings = data if isinstance(data, list) else (data or {}).get("data") or []
    return bool(postings)
