"""Lever job boards — one keyless endpoint per company slug.

https://api.lever.co/v0/postings/{slug}?mode=json returns a bare JSON array
(no envelope), unlike Greenhouse and Ashby.

As with any ATS board this is the company's own system, so nothing is
keyword-filtered — watching a board means wanting all of it.

Lever already gives us `descriptionPlain`, so there is no HTML to strip;
only the hard line wraps need collapsing.
"""
from datetime import datetime, timezone
import re
from typing import List, Optional

import httpx

import config
from models import Job
from sources.base import Source

BOARD = "https://api.lever.co/v0/postings/{slug}?mode=json"


def _collapse(raw: str) -> str:
    """descriptionPlain is already text — just normalize the line breaks."""
    return re.sub(r"\s+", " ", raw).strip() if raw else ""


def _parse_epoch_ms(value) -> Optional[datetime]:
    """createdAt is a UNIX timestamp in milliseconds."""
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


class LeverSource(Source):
    name = "lever"

    def __init__(self, slugs: List[str]):
        self.slugs = [s.strip().lower() for s in slugs if s and s.strip()]

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            for slug in self.slugs:
                postings = self._fetch_board(client, slug)
                if postings is not None:
                    jobs.extend(self._parse_board(slug, postings))
                self._pace()  # separate companies, but the same Lever host

        return jobs

    def _fetch_board(self, client: httpx.Client, slug: str) -> Optional[list]:
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
            return None  # this company just isn't on Lever
        if resp is None or resp.status_code != 200:
            resp = self._fetch(client, url)
            if resp is None:
                return None

        try:
            data = self._json(resp)
        except ValueError:
            print(f"[{self.name}] {slug}: response wasn't JSON")
            return None

        # A slug that exists but has no public postings can come back as {}.
        return data if isinstance(data, list) else []

    def _parse_board(self, slug: str, postings: list) -> List[Job]:
        # Lever postings carry no company name field — derive it from the slug.
        company = slug.replace("-", " ").replace("_", " ").title()
        jobs: List[Job] = []

        for item in postings:
            if not isinstance(item, dict):
                continue

            role = (item.get("text") or "").strip()
            url = (item.get("hostedUrl") or "").strip()
            if not role or not url:
                continue

            categories = item.get("categories") or {}
            location = (categories.get("location") or "").strip()
            team = (categories.get("team") or "").strip()

            created = item.get("createdAt")
            posted_at = _parse_epoch_ms(created)
            jobs.append(Job(
                company=company,
                role=role,
                url=url,
                platform=self.name,
                location_raw=location,
                posted_raw=posted_at.strftime("%Y-%m-%d") if posted_at else "",
                posted_at=posted_at,
                jd_text=_collapse(item.get("descriptionPlain") or ""),
                tags=[team] if team else [],
                remote="remote" in location.lower(),
            ))

        return jobs
