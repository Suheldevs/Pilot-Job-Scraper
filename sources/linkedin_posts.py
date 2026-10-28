"""LinkedIn hiring posts — "We're hiring, send your CV to hr@…" posts.

Job boards rarely carry a contact; hiring posts usually do. LinkedIn's own post
search needs a login (and automating a logged-in account risks a ban), so this
finds posts the way anyone would from outside: a web search restricted to
linkedin.com/posts and the past week, through Firecrawl's search API.

Cost control: the search is the only paid call (~2 credits per query). Each
post page is then fetched directly — LinkedIn serves public posts without a
login, with the author, date and full text in a JSON-LD block — which is free.
The whole source runs at most once per `every_hours` (default 20h), however
often the scraper runs, and stops at the daily credit cap. See
firecrawl_budget.py and the `linkedin_posts` block of firecrawl.config.json.

Cities are searched in the order configured, so the priority cities (Lucknow,
Noida) are never the ones a tight budget cuts.
"""
import datetime as dt
import json
import random
import re
import time
import unicodedata
from typing import List, Optional

import httpx

import config
import firecrawl_budget as fb
from locations import classify
from models import Job
from sources.base import Source

UA = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Accept-Language": "en-US,en;q=0.9",
}

DEFAULTS = {
    "enabled": True,
    "every_hours": 20,
    "results_per_query": 10,
    "max_age": "qdr:w",                       # past week
    "cities": {
        "Lucknow": ["react developer", "node.js developer", "MERN OR \"full stack\" developer"],
        "Noida": ["react developer", "node.js developer", "MERN OR \"full stack\" developer"],
    },
}

ROLE_WORDS = re.compile(r"developer|engineer|full[\s-]?stack|mern|react|node|frontend|front-end|backend|programmer",
                        re.I)
LABELLED = re.compile(r"^\s*(?:position|role|job\s*title|designation|opening|hiring\s*for)\s*[:\-–]\s*(.+)$",
                      re.I | re.M)
COMPANY_LABEL = re.compile(r"^\s*(?:company|organi[sz]ation|employer|client)\s*(?:name)?\s*[:\-–]\s*(.+)$",
                           re.I | re.M)
COMPANY_AT = re.compile(r"\b(?:at|@|join)\s+([A-Z][A-Za-z0-9&.\-]+(?:\s+[A-Z][A-Za-z0-9&.\-]+){0,3})")
LOCATION_LABEL = re.compile(r"^\s*(?:location|job\s*location|work\s*location|city)\s*[:\-–]\s*(.+)$",
                            re.I | re.M)
EXPERIENCE = re.compile(r"(\d{1,2})\s*(?:\+|plus)?\s*(?:[-–to]+\s*(\d{1,2}))?\s*\+?\s*(?:years|yrs|yr)", re.I)
FREE_MAIL = ("gmail.", "yahoo.", "outlook.", "hotmail.", "rediffmail.", "live.", "icloud.")


def _clean_company(name: str) -> str:
    # "CepiaLabs — Intelligence in Action" -> "CepiaLabs"
    name = re.split(r"\s+[—–|-]\s+|\s*\|\s*", name.strip())[0]
    return re.sub(r"[#@]", "", name).strip(" .,:;")


TITLE_WORDS = re.compile(r"developer|engineer|programmer", re.I)
NOT_A_TITLE = re.compile(r"^(tech\s*stack|skills?|requirements?|experience|location|work\s*mode|"
                         r"salary|ctc|qualification|responsibilit|about|key\s*skills)\b", re.I)


def _tidy_title(part: str) -> str:
    part = re.sub(r"(?i)we[’']?re\s+hiring|we\s+are\s+hiring|hiring\s*(alert)?\s*[!:]*|urgent(ly)?|#\w+", "", part)
    part = re.sub(r"^[^\w(]+|[^\w)]+$", "", part)        # emoji, pins, dashes at either end
    return re.sub(r"\s{2,}", " ", part).strip()


def _role(headline: str, body: str) -> str:
    m = LABELLED.search(body)
    if m:
        return _tidy_title(m.group(1))[:120]
    parts = [_tidy_title(p) for p in re.split(r"[|\n•]", headline + "\n" + body[:1500])]
    parts = [p for p in parts if 3 < len(p) < 90 and not NOT_A_TITLE.match(p)]
    # A part naming an actual job ("… Developer", "… Engineer") beats one that
    # only mentions a technology ("React Native").
    for p in parts:
        if TITLE_WORDS.search(p) and ROLE_WORDS.search(p):
            return p
    for p in parts:
        if ROLE_WORDS.search(p):
            return p
    return ""


def _company(author: dict, body: str, emails: List[str]) -> str:
    if author.get("@type") == "Organization" and author.get("name"):
        return _clean_company(author["name"])
    m = COMPANY_LABEL.search(body)
    if m:
        return _clean_company(m.group(1))[:60]
    m = COMPANY_AT.search(body)
    if m and len(m.group(1)) > 2:
        return _clean_company(m.group(1))[:60]
    for e in emails:
        dom = e.split("@", 1)[1].lower()
        if not dom.startswith(FREE_MAIL):
            return dom.split(".")[0].capitalize()
    return ""


class LinkedInPostsSource(Source):
    name = "li_post"

    def _collect_impl(self) -> List[Job]:
        cfg = {**DEFAULTS, **(fb.config().get("linkedin_posts") or {})}
        if not cfg.get("enabled"):
            print("[li_post] disabled in firecrawl.config.json")
            return []
        key = fb.api_key()
        if not key:
            print("[li_post] no FIRECRAWL_API_KEY — skipped")
            return []
        if not fb.due("linkedin_posts", float(cfg["every_hours"])):
            print(f"[li_post] ran in the last {cfg['every_hours']}h — skipped to save Firecrawl credits")
            return []

        state = fb.feature_state("linkedin_posts")
        seen = state.get("seen", {})              # post url -> date first processed
        cutoff = (dt.date.today() - dt.timedelta(days=30)).isoformat()
        seen = {u: d for u, d in seen.items() if d >= cutoff}

        found = []                                 # (url, city)
        with httpx.Client(timeout=60) as fc:
            for city, roles in cfg["cities"].items():
                for role in roles:
                    if not fb.can_spend(fb.SEARCH_COST):
                        print("[li_post] daily Firecrawl credit cap reached — stopping searches")
                        break
                    q = f"site:linkedin.com/posts hiring {role} {city}"
                    try:
                        r = fc.post(fb.SEARCH_URL, headers={"Authorization": f"Bearer {key}"},
                                    json={"query": q, "limit": int(cfg["results_per_query"]),
                                          "tbs": cfg["max_age"], "country": "IN"})
                        fb.spend(fb.SEARCH_COST)
                    except httpx.HTTPError as e:
                        print(f"[li_post] search failed: {e}")
                        continue
                    if r.status_code != 200:
                        print(f"[li_post] search HTTP {r.status_code}: {r.text[:120]}")
                        continue
                    data = r.json().get("data") or {}
                    rows = data.get("web", []) if isinstance(data, dict) else data
                    for row in rows or []:
                        url = (row.get("url") or "").split("?")[0]
                        if "linkedin.com/posts/" in url and url not in seen:
                            found.append((url, city))
                            seen[url] = dt.date.today().isoformat()

        # De-duplicate across queries, keep the first (highest-priority) city.
        urls = list(dict.fromkeys(found))
        jobs: List[Job] = []
        with httpx.Client(headers=UA, follow_redirects=True, timeout=30) as client:
            for url, city in urls:
                job = self._read_post(client, url, city)
                if job:
                    jobs.append(job)
                time.sleep(random.uniform(1.5, 3.5))

        state["seen"] = seen
        fb.save_feature_state("linkedin_posts", state)
        fb.mark_ran("linkedin_posts")
        print(f"[li_post] {len(urls)} new posts read, {len(jobs)} usable")
        return jobs

    def _read_post(self, client: httpx.Client, url: str, city: str) -> Optional[Job]:
        resp = self._fetch(client, url)
        if resp is None:
            return None
        post = None
        for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', resp.text, re.S):
            try:
                d = json.loads(m.group(1))
            except ValueError:
                continue
            if isinstance(d, dict) and d.get("articleBody"):
                post = d
                break
        if not post:
            return None

        # Posts love "math bold" letters (𝐌𝐄𝐑𝐍 𝐃𝐞𝐯𝐞𝐥𝐨𝐩𝐞𝐫) for emphasis. NFKC folds them
        # back to plain ASCII, without which no regex here can read the title.
        body = unicodedata.normalize("NFKC", post.get("articleBody") or "")
        headline = unicodedata.normalize("NFKC", post.get("headline") or "")
        author = post.get("author") or {}
        emails = sorted(set(re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", body)))
        company = _company(author, body, emails)
        role = _role(headline, body)
        if not role:
            return None
        if not company:
            # A recruiter's post with no company named: still a real opening
            # with a real contact route, so it is kept under the poster's name.
            company = f"{author.get('name', 'Unknown')} (hiring post)"

        loc = ""
        m = LOCATION_LABEL.search(body)
        if m and classify(m.group(1)):
            loc = m.group(1).strip()
        if not loc:
            loc = city

        exp_raw, exp_min, exp_max = "", None, None
        m = EXPERIENCE.search(body)
        if m:
            exp_raw = m.group(0)
            exp_min = float(m.group(1))
            exp_max = float(m.group(2)) if m.group(2) else None

        posted_at = None
        if post.get("datePublished"):
            try:
                posted_at = dt.datetime.fromisoformat(post["datePublished"].replace("Z", "+00:00"))
            except ValueError:
                pass

        return Job(
            company=company,
            role=role,
            url=url,
            platform=self.name,
            location_raw=loc,
            posted_at=posted_at,
            posted_raw=posted_at.strftime("%d %b") if posted_at else "",
            jd_text=body,
            experience_raw=exp_raw,
            experience_min=exp_min,
            experience_max=exp_max,
            raw={"author": author.get("name"), "author_type": author.get("@type"),
                 "author_url": author.get("url"), "headline": headline},
        )
