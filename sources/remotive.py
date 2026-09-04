"""Remotive — public remote-jobs API, no auth.

https://remotive.com/api/remote-jobs hands back every live listing in a
single response, so we fetch once and filter locally instead of issuing a
request per keyword: their docs explicitly ask callers not to poll, and one
unfiltered call is cheaper than a dozen `?search=` calls anyway.

Descriptions come through as HTML — flattened into jd_text for the scorer.
"""
from datetime import datetime, timezone
import re
from typing import List, Optional

from bs4 import BeautifulSoup
import httpx

import config
from models import Job
from sources.base import Source

API = "https://remotive.com/api/remote-jobs"


def _plain_text(raw: str) -> str:
    """HTML -> collapsed plain text. The scoring layer reads prose, not markup."""
    if not raw:
        return ""
    text = BeautifulSoup(raw, "lxml").get_text(" ", strip=True)
    return re.sub(r"\s+", " ", text).strip()


def _parse_date(value: Optional[str]) -> Optional[datetime]:
    """publication_date is naive ISO ("2024-05-01T12:00:00") — assume UTC."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class RemotiveSource(Source):
    name = "remotive"

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

        for item in data.get("jobs") or []:
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

            posted_raw = item.get("publication_date") or ""
            jobs.append(Job(
                company=company,
                role=role,
                url=url,
                platform=self.name,
                location_raw=(item.get("candidate_required_location") or "").strip(),
                posted_raw=posted_raw,
                posted_at=_parse_date(posted_raw),
                jd_text=_plain_text(item.get("description") or ""),
                tags=tags,
                remote=True,  # the whole board is remote-only by definition
            ))

        return jobs
