"""Instahyre — the public API its own job board is built on.

`GET /api/v1/job_search?job_functions=1&job_functions=10` needs no auth and no
cookie; job_functions 1 and 10 are Full-Stack and Backend Development, which
is the whole of what we look for here. instahyre.com/robots.txt is
`User-agent: *` with no Disallow rules.

Shape of the response (verified live, not guessed): a dict with `objects`
(the listings) and `meta` (offset / limit / total_count / next). Each listing
carries `title`, `locations`, `keywords` (the stack, e.g. ["MongoDB",
"Node.js", "React.js"]), `public_url` and a nested `employer`.

Two honest gaps: there is no per-job description and no experience field —
neither the list endpoint nor `/api/v1/job_search/{id}` returns one. So
`jd_text` is built from the employer blurb (`company_tagline` +
`instahyre_note`), which is company-level text rather than a JD, and the
experience filter is left to the scoring layer.
"""
import re
from typing import Dict, List, Optional

import httpx

import config
from models import Job
from sources.base import Source

API = "https://www.instahyre.com/api/v1/job_search"

# Full-Stack Development and Backend Development.
JOB_FUNCTIONS = ["1", "10"]
PAGE_SIZE = 35


def _word_boundary_patterns(keywords: List[str]) -> List[re.Pattern]:
    """Compile keywords so they only match whole alphanumeric runs.

    The older sources test `kw in haystack`, which lets "react" match
    "reactivations". Lookarounds on [a-z0-9] rather than \\b so that keywords
    containing punctuation ("next.js", "front-end") still behave.
    """
    return [
        re.compile(r"(?<![a-z0-9])" + re.escape(kw.lower()) + r"(?![a-z0-9])")
        for kw in keywords
    ]


def _blurb(employer: Dict) -> str:
    """Employer tagline + note as one string, de-duplicated.

    It is not a job description, but the scorer reads prose and a short blurb
    beats an empty string.
    """
    parts: List[str] = []
    for key in ("company_tagline", "instahyre_note"):
        text = str(employer.get(key) or "").strip()
        if text and text not in parts:
            parts.append(text)
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


class InstahyreSource(Source):
    name = "instahyre"

    def __init__(self, max_pages: int = 4) -> None:
        # total_count is a few thousand; 4 pages of 35 is a sane slice of the
        # freshest end without a long paced crawl every run.
        self.max_pages = max_pages

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}
        patterns = _word_boundary_patterns(config.MATCH_KEYWORDS)
        seen_ids: set = set()
        raw = 0

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            for page in range(self.max_pages):
                params = {
                    "job_functions": JOB_FUNCTIONS,
                    "limit": str(PAGE_SIZE),
                    "offset": str(page * PAGE_SIZE),
                }
                resp = self._fetch(client, API, params=params)
                if resp is None:
                    break

                try:
                    data = self._json(resp)
                except ValueError:
                    print(f"[{self.name}] response wasn't JSON at offset "
                          f"{page * PAGE_SIZE}")
                    break

                items = (data.get("objects") or []) if isinstance(data, dict) else []
                if not items:
                    break
                raw += len(items)

                for item in items:
                    job = self._parse_item(item, patterns)
                    if job is None:
                        continue
                    # The same listing can resurface across pages when the
                    # underlying ordering shifts between requests.
                    if job.url in seen_ids:
                        continue
                    seen_ids.add(job.url)
                    jobs.append(job)

                meta = data.get("meta") or {}
                total = meta.get("total_count")
                if isinstance(total, int) and (page + 1) * PAGE_SIZE >= total:
                    break

                if page + 1 < self.max_pages:
                    self._pace()

        print(f"[{self.name}] {raw} listings -> {len(jobs)} matched")
        return jobs

    def _parse_item(self, item: Dict, patterns: List[re.Pattern]) -> Optional[Job]:
        if not isinstance(item, dict):
            return None

        employer = item.get("employer") or {}
        role = str(item.get("title") or item.get("candidate_title") or "").strip()
        company = str(employer.get("company_name") or "").strip()
        url = str(item.get("public_url") or "").strip()
        if not role or not company or not url:
            return None

        tags = [str(k).strip() for k in (item.get("keywords") or []) if str(k).strip()]

        # Title plus stack: many listings are titled generically ("SDE III")
        # and only the keywords say it is a Node/React role.
        haystack = (role + " " + " ".join(tags)).lower()
        if not any(p.search(haystack) for p in patterns):
            return None

        # `locations` is a comma-joined string ("Hyderabad,Work From Home").
        location_raw = str(item.get("locations") or "").replace(",", ", ").strip()

        return Job(
            company=company,
            role=role,
            url=url,
            platform=self.name,
            location_raw=location_raw,
            jd_text=_blurb(employer),
            tags=tags,
            remote="work from home" in location_raw.lower(),
        )
