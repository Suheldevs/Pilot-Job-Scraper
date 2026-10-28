"""LinkedIn — uses the public "guest" jobs-search fragment endpoint.

linkedin.com/jobs/search is a client-rendered React page with no job
markup in the initial HTML — a plain GET against it can never find
`base-card` elements because they don't exist server-side.

linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search is the
endpoint LinkedIn's own "load more" button calls; it returns a static
HTML fragment of <li> job cards with stable class names, no login
required, no JS execution required.

Caveat, stated plainly: LinkedIn's Terms of Service prohibit automated
scraping. This hits only public search results, at a deliberately slow
pace, for personal job-search use — not resale or bulk collection. Use
your own judgment; expect this to eventually get rate-limited (HTTP 429)
regardless, at which point back off rather than retrying harder.
"""
from typing import List
from urllib.parse import urlencode

import httpx
from bs4 import BeautifulSoup

import config
from models import Job
from sources.base import Source

API = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"


class LinkedInSource(Source):
    name = "linkedin"

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {
            "User-Agent": config.USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
        }

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            priority = [l for l in config.LOCATIONS if l in config.PRIORITY_LOCATIONS]
            others = [l for l in config.LOCATIONS if l not in config.PRIORITY_LOCATIONS]
            for location in priority + others:
                keywords = list(config.ROLE_KEYWORDS)
                if location in priority:
                    keywords += [k for k in config.PRIORITY_EXTRA_KEYWORDS if k not in keywords]
                for keyword in keywords:
                    jobs.extend(self._search(client, keyword, location,
                                             days=14 if location in priority else 7))
                    self._pace()

        return jobs

    def _search(self, client: httpx.Client, keyword: str, location: str,
                days: int = 7) -> List[Job]:
        jobs: List[Job] = []

        for page in range(config.LINKEDIN_MAX_PAGES):
            params = {
                "keywords": keyword,
                "location": location,
                "f_TPR": f"r{days * 86400}",   # last 7 days; 14 for priority cities
                "f_E": "1,2",         # entry level + associate
                "start": str(page * 25),
            }
            url = f"{API}?{urlencode(params)}"
            resp = self._fetch(client, url)
            if resp is None:
                break

            soup = BeautifulSoup(resp.text, "lxml")
            cards = soup.find_all("div", class_="base-card")
            if not cards:
                break  # no more results for this (keyword, location) pair

            for card in cards:
                job = self._parse_card(card)
                if job:
                    jobs.append(job)

            if page < config.LINKEDIN_MAX_PAGES - 1:
                self._pace()

        return jobs

    def _parse_card(self, card) -> Job | None:
        title_el = card.find("h3", class_="base-search-card__title")
        company_el = card.find("h4", class_="base-search-card__subtitle")
        location_el = card.find("span", class_="job-search-card__location")
        link_el = card.find("a", class_="base-card__full-link")

        if not (title_el and company_el and link_el):
            return None

        url = link_el.get("href", "").split("?")[0]  # strip tracking params
        if not url:
            return None

        return Job(
            company=company_el.get_text(strip=True),
            role=title_el.get_text(strip=True),
            platform=self.name,
            url=url,
            location_raw=location_el.get_text(strip=True) if location_el else "",
        )
