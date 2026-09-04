"""We Work Remotely — public per-category RSS feeds. No auth, no HTML parsing.

Entry titles are formatted "Company: Role" — split on the first colon.
"""
from typing import List

import feedparser
import httpx

import config
from models import Job
from sources.base import Source

FEEDS = [
    "https://weworkremotely.com/categories/remote-programming-jobs.rss",
    "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
]


class WeWorkRemotelySource(Source):
    name = "weworkremotely"

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {"User-Agent": config.USER_AGENT}
        wanted = [kw.lower() for kw in config.MATCH_KEYWORDS]

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            for feed_url in FEEDS:
                resp = self._fetch(client, feed_url)
                if resp is None:
                    continue

                parsed = feedparser.parse(resp.text)
                for entry in parsed.entries:
                    title = getattr(entry, "title", "")
                    if ":" in title:
                        company, role = title.split(":", 1)
                    else:
                        company, role = "", title
                    company, role = company.strip(), role.strip()
                    if not company or not role:
                        continue

                    if not any(kw in role.lower() for kw in wanted):
                        continue

                    jobs.append(Job(
                        company=company,
                        role=role,
                        platform=self.name,
                        url=getattr(entry, "link", ""),
                        location_raw="Remote",
                        posted_raw=getattr(entry, "published", ""),
                    ))

                self._pace()

        return jobs
