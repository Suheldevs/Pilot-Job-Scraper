"""Naukri through an Apify actor — real job descriptions, experience and agency flags.

Why this exists: the free Naukri source (naukri_sitemap.py) can only read a job's
URL, so every Naukri lead arrives with no description, no stack and no contact.
This source asks the `blackfalcondata/naukri-jobs-feed` actor instead, which
returns per job: the full description, numeric min/max experience, the skills
list, a `consultant` flag (staffing agency), an `isRepost` flag, and sometimes a
recruiter email or company website. Compared with the other actor tried
(muhammetakkurtt/naukri-job-scraper) it was ~8x cheaper per detailed job and
needs no 50-job minimum; that one returned only a snippet without details.

Cost control — this is the only part of the scraper that spends real money:
  * priced per result ($0.00039 on the free plan) plus $0.001 per run, so a run
    over every tracked city is about $0.05–0.10;
  * one run per city, capped at MAX_RESULTS_PER_CITY results;
  * refuses to run when less than MIN_BUDGET_USD is left on the account, and the
    Apify account's own monthly cap (Settings > Limits on apify.com) still applies;
  * runs once a day (scheduler.py), and not at all while the scraper is off.

Needs APIFY_TOKEN in .push-credentials. Without it the source reports that it is
unconfigured and returns nothing, so a run never breaks over a missing key.
"""
import datetime as dt
from typing import Dict, List, Optional

import httpx

import config
import profile as _profile
from models import Job
from pilot_client import load_creds
from sources.base import Source

ACTOR = "xYOP3UjaS8w38lWM7"          # blackfalcondata/naukri-jobs-feed
API = "https://api.apify.com/v2"
MAX_RESULTS_PER_CITY = 40
MIN_BUDGET_USD = 0.50
FRESH_DAYS = 3                        # the actor accepts 1, 3, 7, 15 or 30
RUN_TIMEOUT_S = 240

# Profile city -> the name Naukri's search understands. Remote has no Naukri city.
CITY_QUERY = {"bangalore": "Bangalore", "bengaluru": "Bangalore", "pune": "Pune",
              "noida": "Noida", "lucknow": "Lucknow", "delhi": "Delhi / NCR",
              "gurugram": "Gurgaon", "gurgaon": "Gurgaon"}


def _parse_ts(text: str) -> Optional[dt.datetime]:
    try:
        return dt.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _skills(item: Dict) -> List[str]:
    raw = item.get("skills")
    if isinstance(raw, list):
        return [str(s).strip() for s in raw if str(s).strip()]
    out: List[str] = []
    ks = item.get("keySkills")
    if isinstance(ks, dict):
        for group in ks.values():
            out += [str(x.get("label", "")).strip() for x in group or [] if isinstance(x, dict)]
    return [s for s in out if s]


def _experience_filter() -> str:
    """The profile's band as the actor writes it, e.g. "1-3"."""
    try:
        lo, hi = int(float(_profile.exp_min())), int(float(_profile.exp_max()))
    except (TypeError, ValueError):
        return "0-3"
    return f"{max(0, lo)}-{max(lo, min(hi, 15))}"


class NaukriApifySource(Source):
    name = "naukri_apify"

    def _collect_impl(self) -> List[Job]:
        token = load_creds().get("APIFY_TOKEN", "")
        if not token:
            print(f"[{self.name}] no APIFY_TOKEN — skipped")
            return []
        headers = {"Authorization": f"Bearer {token}"}

        with httpx.Client(headers=headers, timeout=RUN_TIMEOUT_S + 30) as client:
            left = self._budget_left(client)
            if left is None:
                print(f"[{self.name}] could not read the Apify balance — skipped")
                return []
            if left < MIN_BUDGET_USD:
                print(f"[{self.name}] only ${left:.2f} left on Apify (minimum ${MIN_BUDGET_USD}) — skipped")
                return []

            cities, seen = [], set()
            for loc in config.LOCATIONS:
                city = CITY_QUERY.get(loc.strip().lower())
                if city and city not in seen:
                    seen.add(city)
                    cities.append(city)

            jobs: List[Job] = []
            for city in cities:
                jobs.extend(self._run_city(client, city))
            after = self._budget_left(client)
            if after is not None:
                print(f"[{self.name}] {len(jobs)} jobs kept; Apify balance ${left:.3f} -> ${after:.3f}")
            return jobs

    def _budget_left(self, client: httpx.Client) -> Optional[float]:
        try:
            r = client.get(f"{API}/users/me/limits")
            r.raise_for_status()
            d = r.json()["data"]
            return float(d["limits"]["maxMonthlyUsageUsd"]) - float(d["current"]["monthlyUsageUsd"])
        except Exception as e:
            print(f"[{self.name}] balance check failed: {type(e).__name__}")
            return None

    def _run_city(self, client: httpx.Client, city: str) -> List[Job]:
        body = {
            "searchQueries": list(config.ROLE_KEYWORDS),
            "location": city,
            "experience": _experience_filter(),
            "freshness": FRESH_DAYS,
            "maxResults": MAX_RESULTS_PER_CITY,
            "fetchDetails": True,
        }
        try:
            r = client.post(f"{API}/acts/{ACTOR}/run-sync-get-dataset-items",
                            params={"timeout": RUN_TIMEOUT_S, "format": "json"}, json=body)
            r.raise_for_status()
            items = r.json()
        except Exception as e:
            print(f"[{self.name}] {city}: run failed ({type(e).__name__}: {str(e)[:100]})")
            return []

        jobs, skipped = [], 0
        for item in items if isinstance(items, list) else []:
            job = self._parse(item, city)
            if job is None:
                skipped += 1
            else:
                jobs.append(job)
        print(f"[{self.name}] {city}: {len(items)} results -> {len(jobs)} kept "
              f"({skipped} agency/repost/incomplete dropped)")
        return jobs

    def _parse(self, item: Dict, city: str) -> Optional[Job]:
        title = str(item.get("title") or "").strip()
        company = str(item.get("companyName") or "").strip()
        url = str(item.get("portalUrl") or "").strip()
        if not (title and company and url):
            return None
        # Agencies post on behalf of unnamed clients and reposts are old jobs
        # resurfacing; neither is a lead worth writing to.
        if item.get("consultant") or item.get("isRepost"):
            return None

        emails = []
        for e in [item.get("contactEmail")] + list(item.get("extractedEmails") or []):
            e = str(e or "").strip().lower()
            if e and "@" in e and e not in emails:
                emails.append(e)

        wfh = str(item.get("wfhType") or item.get("workModeLabel") or "").lower()
        remote_type = ("remote" if "wfh" in wfh or "remote" in wfh
                       else "hybrid" if "hybrid" in wfh else "onsite" if wfh else "")
        lo, hi = item.get("minimumExperience"), item.get("maximumExperience")
        posted = _parse_ts(item.get("createdDate"))
        salary = str(item.get("salary") or "")

        return Job(
            company=company,
            role=title,
            url=url,
            platform="naukri",          # same site and tag as the sitemap source
            location_raw=str(item.get("location") or city),
            posted_at=posted,
            posted_raw=posted.strftime("%d %b") if posted else "",
            jd_text=str(item.get("description") or ""),
            tags=_skills(item)[:25],
            remote=remote_type == "remote",
            source_job_id=str(item.get("jobId") or ""),
            apply_url=str(item.get("applyRedirectUrl") or item.get("companyApplyUrl") or ""),
            employment_type=str(item.get("employmentType") or "").lower(),
            remote_type=remote_type,
            salary_raw="" if salary.lower().startswith("not disclosed") else salary,
            experience_raw=str(item.get("experienceText") or ""),
            experience_min=float(lo) if lo not in (None, "") else None,
            experience_max=float(hi) if hi not in (None, "") else None,
            company_website=str(item.get("companyWebsite") or ""),
            emails=emails,
            raw={"jobRole": item.get("jobRole"), "vacancy": item.get("vacancy"),
                 "applyCount": item.get("applyCount")},
        )
