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

import re

import httpx
from bs4 import BeautifulSoup

import config
from models import Job
from sources.base import Source

API = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
# The same public guest family serves one posting's full text, no login needed.
DETAIL_API = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}"
# Search cards carry no description, so every LinkedIn lead used to arrive blind:
# no stack, no experience. Fetching the JD for leads that already pass the title
# check is what lets the grader tell a real match from a keyword hit.
MAX_JD_FETCH = 80


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

            jobs = self._hydrate(client, jobs)

        return jobs

    def _hydrate(self, client: httpx.Client, jobs: List[Job]) -> List[Job]:
        """Fetch the JD for jobs that already pass the title/level/city gate."""
        import relevance
        seen, candidates = set(), []
        for job in jobs:
            if job.url in seen:
                continue
            seen.add(job.url)
            ok, _ = relevance.is_relevant(job)
            if ok:
                candidates.append(job)
        fetched = failed = 0
        for job in candidates[:MAX_JD_FETCH]:
            m = re.search(r"(\d{8,})/?$", job.url)
            if not m:
                continue
            resp = self._fetch(client, DETAIL_API.format(id=m.group(1)))
            if resp is None:
                failed += 1
                if failed >= 5:       # rate-limited: back off, don't push harder
                    print(f"[{self.name}] detail fetch failing — stopping JD hydration")
                    break
                continue
            soup = BeautifulSoup(resp.text, "lxml")
            body = soup.find("div", class_="show-more-less-html__markup")
            if body:
                job.jd_text = body.get_text("\n", strip=True)
                fetched += 1
            for item in soup.select("li.description__job-criteria-item"):
                text = item.get_text(" ", strip=True)
                if text.lower().startswith("employment type"):
                    job.employment_type = text.split(" ", 2)[-1].lower()
            self._pace()
        # The same posting turns up under several keywords; share what was fetched.
        by_url = {j.url: j for j in candidates if j.jd_text}
        for job in jobs:
            src = by_url.get(job.url)
            if src and src is not job:
                job.jd_text, job.employment_type = src.jd_text, src.employment_type
        print(f"[{self.name}] JD fetched for {fetched} of {len(candidates)} relevant leads")
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
