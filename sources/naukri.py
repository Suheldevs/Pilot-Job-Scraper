"""Naukri.com — uses its own internal search JSON API, not HTML scraping.

naukri.com/jobs-in-india is a client-rendered SPA; the page itself has no
job markup to parse. It gets its results from this JSON endpoint, so we
call that directly instead of guessing CSS classes on an empty shell.

Response shape can drift — every field read is defensive (dict.get with
fallbacks) and a single bad record is skipped, not fatal.
"""
from datetime import datetime
from typing import List

import httpx

import config
from models import Job
from sources.base import Source

API = "https://www.naukri.com/jobapi/v3/search"


class NaukriSource(Source):
    name = "naukri"

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {
            "User-Agent": config.USER_AGENT,
            "Accept": "application/json",
            "appid": "109",
            "systemid": "Naukri",
        }

        consecutive_blocks = 0

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            for keyword in config.ROLE_KEYWORDS:
                for location in config.LOCATIONS:
                    if location.lower() == "remote":
                        continue  # Naukri's location filter doesn't mean "remote"

                    found = self._search(client, keyword, location)
                    if found:
                        consecutive_blocks = 0
                        jobs.extend(found)
                    else:
                        consecutive_blocks += 1
                        if consecutive_blocks >= 3:
                            print(f"[{self.name}] blocked on 3 consecutive searches "
                                  f"(likely the recaptcha gate on this endpoint) — "
                                  f"stopping early instead of hammering it further")
                            return jobs
                    self._pace()

        return jobs

    def _search(self, client: httpx.Client, keyword: str, location: str) -> List[Job]:
        jobs: List[Job] = []

        for page in range(1, config.NAUKRI_MAX_PAGES + 1):
            params = {
                "noOfResults": 20,
                "urlType": "search_by_keyword",
                "searchType": "adv",
                "keyword": keyword,
                "location": location,
                "experience": str(config.MIN_EXPERIENCE_YEARS),
                "pageNo": str(page),
            }
            resp = self._fetch(client, API, params=params)
            if resp is None:
                break

            try:
                data = self._json(resp)
            except ValueError:
                print(f"[{self.name}] non-JSON response for '{keyword}' in {location}")
                break

            details = data.get("jobDetails") or []
            if not details:
                break

            for item in details:
                job = self._parse_item(item)
                if job:
                    jobs.append(job)

            if page < config.NAUKRI_MAX_PAGES:
                self._pace()

        return jobs

    def _parse_item(self, item: dict) -> Job | None:
        try:
            title = (item.get("title") or "").strip()
            company = (item.get("companyName") or "").strip()
            job_id = item.get("jobId") or ""
            url = item.get("jdURL") or (
                f"https://www.naukri.com/job-listings-{job_id}" if job_id else ""
            )
            if not title or not company or not url:
                return None
            if not url.startswith("http"):
                url = "https://www.naukri.com" + url

            location = ""
            for ph in item.get("placeholders") or []:
                if ph.get("type") == "location":
                    location = ph.get("label", "")
                    break

            posted_raw = ""
            if item.get("createdDate"):
                try:
                    posted_raw = datetime.utcfromtimestamp(
                        int(item["createdDate"]) / 1000
                    ).strftime("%Y-%m-%d")
                except (ValueError, TypeError):
                    pass

            return Job(
                company=company,
                role=title,
                platform=self.name,
                url=url,
                location_raw=location,
                posted_raw=posted_raw,
            )
        except Exception as e:
            print(f"[{self.name}] skipped one malformed record: {e}")
            return None
