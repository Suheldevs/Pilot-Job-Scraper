"""RemoteOK — public JSON API, no auth, no scraping tricks needed.

https://remoteok.com/api returns a JSON array. The first element is a
metadata legal notice (not a job) — always skip it.
"""
from typing import List

import httpx

import config
from models import Job
from sources.base import Source


class RemoteOKSource(Source):
    name = "remoteok"

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            resp = self._fetch(client, "https://remoteok.com/api")
            if resp is None:
                return jobs

            try:
                data = self._json(resp)
            except ValueError:
                print(f"[{self.name}] response wasn't JSON")
                return jobs

        wanted = [kw.lower() for kw in config.MATCH_KEYWORDS]

        for item in data:
            if not isinstance(item, dict) or "id" not in item:
                continue  # skip the legal-notice header row

            position = (item.get("position") or "").strip()
            company = (item.get("company") or "").strip()
            if not position or not company:
                continue

            haystack = (position + " " + " ".join(item.get("tags") or [])).lower()
            if not any(kw in haystack for kw in wanted):
                continue

            url = item.get("url") or (
                "https://remoteok.com" + item["slug"] if item.get("slug") else ""
            )
            if not url:
                continue

            jobs.append(Job(
                company=company,
                role=position,
                platform=self.name,
                url=url,
                location_raw="Remote",
                posted_raw=item.get("date", ""),
            ))

        return jobs
