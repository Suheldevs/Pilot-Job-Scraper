"""Arbeitnow — public job-board API, no auth.

https://www.arbeitnow.com/api/job-board-api returns the first page of a
paginated feed. We take that one page only: it is the freshest slice, and
walking the whole board would be hundreds of requests for a source we treat
as discovery-grade anyway.

The board is Europe-heavy and unfiltered, so results are keyword-matched
locally the same way RemoteOK's are.
"""
from datetime import datetime, timezone
import re
from typing import List, Optional

from bs4 import BeautifulSoup
import httpx

import config
from models import Job
from sources.base import Source

API = "https://www.arbeitnow.com/api/job-board-api"


def _plain_text(raw: str) -> str:
    """HTML -> collapsed plain text. The scoring layer reads prose, not markup."""
    if not raw:
        return ""
    text = BeautifulSoup(raw, "lxml").get_text(" ", strip=True)
    return re.sub(r"\s+", " ", text).strip()


def _parse_epoch(value) -> Optional[datetime]:
    """created_at is a UNIX timestamp in seconds (not ms, unlike Lever's)."""
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


class ArbeitnowSource(Source):
    name = "arbeitnow"

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            resp = self._fetch(client, API)
            if resp is None:
                return jobs

            try:
                data = self._json(resp)
            except ValueError:
                print(f"[{self.name}] response wasn't JSON")
                return jobs

        wanted = [kw.lower() for kw in config.MATCH_KEYWORDS]

        for item in data.get("data") or []:
            if not isinstance(item, dict):
                continue

            role = (item.get("title") or "").strip()
            company = (item.get("company_name") or "").strip()
            url = (item.get("url") or "").strip()
            if not role or not company or not url:
                continue

            tags = [str(t).strip() for t in (item.get("tags") or []) if str(t).strip()]
            haystack = (role + " " + " ".join(tags)).lower()
            if not any(kw in haystack for kw in wanted):
                continue

            created = item.get("created_at")
            posted_at = _parse_epoch(created)
            jobs.append(Job(
                company=company,
                role=role,
                url=url,
                platform=self.name,
                location_raw=(item.get("location") or "").strip(),
                posted_raw=posted_at.strftime("%Y-%m-%d") if posted_at else "",
                posted_at=posted_at,
                jd_text=_plain_text(item.get("description") or ""),
                tags=tags,
                remote=bool(item.get("remote")),
            ))

        return jobs
