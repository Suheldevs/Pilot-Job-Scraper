"""Ashby job boards — one keyless endpoint per company slug.

https://api.ashbyhq.com/posting-api/job-board/{slug}

As with any ATS board this is the company's own system, so nothing is
keyword-filtered — watching a board means wanting all of it.

Ashby is the only one of the three that states remote-ness explicitly
(`isRemote`) instead of leaving us to read it out of the location string.
"""
from datetime import datetime, timezone
import re
from typing import List, Optional

import httpx

import config
from models import Job
from sources.base import Source

BOARD = "https://api.ashbyhq.com/posting-api/job-board/{slug}"


def _collapse(raw: str) -> str:
    """descriptionPlain is already text — just normalize the line breaks."""
    return re.sub(r"\s+", " ", raw).strip() if raw else ""


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """publishedAt is ISO-8601, usually Zulu ("2024-05-01T12:00:00.000Z")."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class AshbySource(Source):
    name = "ashby"

    def __init__(self, slugs: List[str]):
        self.slugs = [s.strip() for s in slugs if s and s.strip()]

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            for slug in self.slugs:
                data = self._fetch_board(client, slug)
                if data is not None:
                    jobs.extend(self._parse_board(slug, data))
                self._pace()  # separate companies, but the same Ashby host

        return jobs

    def _fetch_board(self, client: httpx.Client, slug: str) -> Optional[dict]:
        """One plain GET first — an unknown slug 404s, and the retrying helper
        would hit it three times and log each attempt. Anything other than a
        404 falls through to _fetch so real transient errors still get retries.
        """
        url = BOARD.format(slug=slug)
        try:
            resp = client.get(url, timeout=config.REQUEST_TIMEOUT)
        except httpx.RequestError:
            resp = None

        if resp is not None and resp.status_code == 404:
            return None  # this company just isn't on Ashby
        if resp is None or resp.status_code != 200:
            resp = self._fetch(client, url)
            if resp is None:
                return None

        try:
            data = self._json(resp)
        except ValueError:
            print(f"[{self.name}] {slug}: response wasn't JSON")
            return None

        return data if isinstance(data, dict) else None

    def _parse_board(self, slug: str, data: dict) -> List[Job]:
        # Ashby does return the real display name; fall back to the slug only
        # when an older board omits it.
        company = (data.get("organizationName") or "").strip() or \
            slug.replace("-", " ").replace("_", " ").title()
        jobs: List[Job] = []

        for item in data.get("jobs") or []:
            if not isinstance(item, dict):
                continue

            role = (item.get("title") or "").strip()
            url = (item.get("jobUrl") or "").strip()
            if not role or not url:
                continue

            published = item.get("publishedAt") or ""
            jobs.append(Job(
                company=company,
                role=role,
                url=url,
                platform=self.name,
                location_raw=(item.get("location") or "").strip(),
                posted_raw=published,
                posted_at=_parse_iso(published),
                jd_text=_collapse(item.get("descriptionPlain") or ""),
                remote=bool(item.get("isRemote")),
            ))

        return jobs
