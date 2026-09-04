"""Firecrawl — the fallback layer for careers pages no API covers.

Every other source is either an official API or a published feed. This one
exists for the long tail: a Bangalore company with a careers page that isn't on
Greenhouse, Lever, Ashby or Keka, and has no feed at all. Firecrawl renders the
page (including JS) and returns clean markdown, which our existing scoring and
contact extraction can read.

Use it deliberately, not broadly: it is a paid, rate-limited API, and every
other layer is free. The intended input is a short list of company careers URLs
you actually care about — not a crawl.

Needs FIRECRAWL_API_KEY in the environment. Without it this source reports that
it is unconfigured and returns nothing, so a run never breaks over a missing key.
"""
import json
import os
import re
from typing import List, Optional

import time

import httpx

import config
from models import Job
from sources.base import Source

API = "https://api.firecrawl.dev/v2/scrape"


def config_delay(cfg: Optional[dict]) -> float:
    """Pacing between renders, from config. Firecrawl is rate-limited by plan."""
    try:
        return float(((cfg or {}).get("limits") or {}).get("delay_seconds", 2))
    except (TypeError, ValueError):
        return 2.0

# Firecrawl does the extraction, not a regex over markdown lines. Line-based
# parsing was tried first and produced garbage: it read award badges ("Most
# Reviewed App Developers") and employee testimonials ("Abdul Waheed —
# Meanstack Developer") as openings, because every one of those lines contains
# the word "developer". Asking for a schema instead means a page with no
# openings correctly returns none rather than five invented ones.
EXTRACT_PROMPT = (
    "Extract every current job opening listed on this page. For each: the job "
    "title exactly as written, the location if stated, and the apply/details "
    "link if present. Only real current openings - ignore awards, client "
    "testimonials, team member bios, blog posts and past roles."
)
EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "openings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "location": {"type": "string"},
                    "url": {"type": "string"},
                },
                "required": ["title"],
            },
        }
    },
    "required": ["openings"],
}


CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "firecrawl.config.json")


def load_config(path: str = CONFIG_PATH) -> dict:
    """Read firecrawl.config.json. A missing or broken file disables the layer
    rather than breaking a run — every other source is free and still works."""
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        print(f"[firecrawl] config unreadable ({e}) — layer disabled")
        return {"enabled": False, "targets": []}
    if not isinstance(cfg, dict):
        return {"enabled": False, "targets": []}
    return cfg


class FirecrawlSource(Source):
    name = "firecrawl"

    def __init__(self, urls: Optional[List[str]] = None,
                 company_names: Optional[List[str]] = None,
                 config: Optional[dict] = None):
        """Called with no arguments it reads firecrawl.config.json, so the
        scheduled run needs no wiring. Explicit `urls` override the config,
        which is what an ad-hoc "check these pages" run wants."""
        if urls:
            self.urls = urls
            self.company_names = company_names or []
            self.cities: List[str] = []
            self.delay = config_delay(config)
            self.enabled = True
            return

        cfg = config if config is not None else load_config()
        self.enabled = bool(cfg.get("enabled", False))
        targets = [t for t in (cfg.get("targets") or []) if t.get("url")]
        cap = int((cfg.get("limits") or {}).get("max_pages_per_run", 12))
        targets = targets[:cap]
        self.urls = [t["url"] for t in targets]
        self.company_names = [t.get("company", "") for t in targets]
        self.cities = [t.get("city", "") for t in targets]
        self.delay = config_delay(cfg)

    def _collect_impl(self) -> List[Job]:
        if not self.enabled:
            print(f"[{self.name}] disabled in firecrawl.config.json — skipping")
            return []

        api_key = os.environ.get("FIRECRAWL_API_KEY", "").strip()
        if not api_key:
            print(f"[{self.name}] no FIRECRAWL_API_KEY set — skipping "
                  f"(this layer is optional)")
            return []
        if not self.urls:
            print(f"[{self.name}] no careers URLs configured — skipping")
            return []

        jobs: List[Job] = []
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            for i, url in enumerate(self.urls):
                company = (self.company_names[i]
                           if i < len(self.company_names) else self._company_from(url))
                page = self._scrape(client, url)
                if not page:
                    continue
                # A careers index rarely states a city per role, but we know
                # which company we asked about, so carry the configured one —
                # otherwise the relevance gate drops every row as untracked.
                city = self.cities[i] if i < len(self.cities) else ""
                found = self._parse(page, company, url)
                for j in found:
                    if city and not j.location_raw:
                        j.location_raw = city
                jobs.extend(found)
                time.sleep(self.delay)

        return jobs

    def _scrape(self, client: httpx.Client, url: str) -> Optional[dict]:
        """Render the page and return {"openings": [...], "markdown": "..."}."""
        try:
            resp = client.post(API, json={
                "url": url,
                "formats": [
                    {"type": "json", "prompt": EXTRACT_PROMPT, "schema": EXTRACT_SCHEMA},
                    "markdown",
                ],
                "onlyMainContent": True,
            }, timeout=config.REQUEST_TIMEOUT * 4)  # extraction is slower than a plain render
        except httpx.RequestError as e:
            print(f"[{self.name}] request failed for {url[:60]}: {e}")
            return None

        if resp.status_code == 401:
            print(f"[{self.name}] 401 — FIRECRAWL_API_KEY rejected")
            return None
        if resp.status_code == 402:
            print(f"[{self.name}] 402 — Firecrawl credit exhausted")
            return None
        if resp.status_code == 429:
            print(f"[{self.name}] 429 — rate limited, backing off this run")
            return None
        if resp.status_code != 200:
            print(f"[{self.name}] HTTP {resp.status_code} for {url[:60]}")
            return None

        try:
            body = self._json(resp)
        except ValueError:
            return None
        data = body.get("data") or {}
        return {
            "openings": ((data.get("json") or {}).get("openings") or []),
            "markdown": data.get("markdown") or "",
        }

    def _parse(self, page: dict, company: str, source_url: str) -> List[Job]:
        """Turn extracted openings into Jobs.

        The page markdown rides along as jd_text so scoring and contact
        extraction have real text to read — a careers page often carries the
        HR address even when the listing itself doesn't.
        """
        jobs: List[Job] = []
        markdown = page.get("markdown") or ""
        seen = set()

        for op in page.get("openings") or []:
            title = (op.get("title") or "").strip()
            if not title or len(title) > 120:
                continue
            key = title.lower()
            if key in seen:
                continue
            seen.add(key)

            href = (op.get("url") or "").strip()
            jobs.append(Job(
                company=company,
                role=title,
                url=href if href.startswith("http") else source_url,
                platform=self.name,
                jd_text=markdown[:4000],
                location_raw=(op.get("location") or "").strip(),
            ))

        return jobs

    @staticmethod
    def _company_from(url: str) -> str:
        host = re.sub(r"^https?://", "", url).split("/")[0]
        host = re.sub(r"^(www|careers|jobs|apply)\.", "", host)
        return host.split(".")[0].replace("-", " ").title()
