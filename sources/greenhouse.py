"""Greenhouse job boards — one keyless endpoint per company slug.

https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true

This is the company's own hiring system, so every posting here is real and
open. That is why nothing is keyword-filtered: if we are watching a board on
purpose, we want the whole board, not just the roles that match our tokens.

`content` arrives HTML-escaped ("&lt;p&gt;...") — entities have to be
unescaped before tag stripping, or jd_text ends up full of visible markup.
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

BOARD = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"


def _plain_text(raw: str) -> str:
    """Unescape entities first, then strip tags and collapse whitespace."""
    if not raw:
        return ""
    text = BeautifulSoup(html.unescape(raw), "lxml").get_text(" ", strip=True)
    return re.sub(r"\s+", " ", text).strip()


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """updated_at is ISO-8601 with an offset ("2024-05-01T12:00:00-04:00")."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class GreenhouseSource(Source):
    name = "greenhouse"

    def __init__(self, slugs: List[str]):
        self.slugs = [s.strip().lower() for s in slugs if s and s.strip()]

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            for slug in self.slugs:
                data = self._fetch_board(client, slug)
                if data is not None:
                    jobs.extend(self._parse_board(slug, data))
                self._pace()  # separate companies, but the same Greenhouse host

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
            return None  # this company just isn't on Greenhouse
        if resp is None or resp.status_code != 200:
            resp = self._fetch(client, url)
            if resp is None:
                return None

        try:
            return self._json(resp)
        except ValueError:
            print(f"[{self.name}] {slug}: response wasn't JSON")
            return None

    def _parse_board(self, slug: str, data: dict) -> List[Job]:
        # The jobs endpoint never returns the company's display name, so it is
        # derived from the slug rather than spending an extra request on it.
        company = slug.replace("-", " ").replace("_", " ").title()
        jobs: List[Job] = []

        for item in data.get("jobs") or []:
            if not isinstance(item, dict):
                continue

            role = (item.get("title") or "").strip()
            url = (item.get("absolute_url") or "").strip()
            if not role or not url:
                continue

            location = ((item.get("location") or {}).get("name") or "").strip()
            updated = item.get("updated_at") or ""
            jobs.append(Job(
                company=company,
                role=role,
                url=url,
                platform=self.name,
                location_raw=location,
                posted_raw=updated,
                posted_at=_parse_iso(updated),
                jd_text=_plain_text(item.get("content") or ""),
                remote="remote" in location.lower(),
            ))

        return jobs
