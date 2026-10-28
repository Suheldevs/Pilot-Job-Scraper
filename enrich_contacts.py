"""Find HR emails on company websites for leads that have no contact.

Most scraped leads arrive with no email at all — job boards hide them. Runs on
the dashboard's own leads (not just this run's), after push.py:

    python enrich_contacts.py            # update leads in the dashboard
    python enrich_contacts.py --dry-run  # print what it would find; write nothing

Per lead (grade A/B, still "Not contacted", no email, not tried recently):
  1. one Firecrawl search for the company (~2 credits) to find its own website —
     a domain is only trusted when its name shares a word with the company's;
  2. that site's careers / contact pages are read directly (free);
  3. only if nothing turned up, one Firecrawl render of the contact page
     (~1 credit) for sites that build their page in JavaScript.
Addresses must be on the company's own domain and pass the MX check (mx.py),
so nothing is guessed. Hiring-looking addresses (hr@, careers@ …) go to the
lead's HR list, the rest to its general list.

Runs at most once per `every_hours` and inside the shared daily credit cap
(firecrawl_budget.py, `website_emails` in firecrawl.config.json). Lucknow and
Noida leads are tried first.
"""
import argparse
import datetime as dt
import random
import re
import sys
import time
from urllib.parse import quote, urlparse

import httpx

import firecrawl_budget as fb
import mx
from auto_apply import core_tokens
from pilot_client import Dashboard, load_creds
from extract import is_noise_email, split_contacts

DEFAULTS = {"enabled": True, "every_hours": 20, "max_companies_per_run": 6,
            "retry_after_days": 30, "priority_cities": ["lko", "noida"]}

# Sites that mention a company without being it.
NOT_COMPANY_SITES = (
    "linkedin.", "naukri.", "indeed.", "glassdoor.", "ambitionbox.", "instahyre.", "foundit.",
    "wellfound.", "angel.co", "crunchbase.", "zaubacorp.", "tofler.", "justdial.", "facebook.",
    "instagram.", "twitter.", "x.com", "youtube.", "wikipedia.", "internshala.", "cutshort.",
    "apna.", "shine.", "timesjobs.", "monster", "google.", "bing.", "github.", "medium.",
    "quora.", "reddit.", "clutch.co", "goodfirms.", "indiamart.", "tracxn.", "owler.",
    "zoominfo.", "rocketreach.", "apollo.io", "signalhire.", "contactout.", "lusha.",
)
PAGES = ["", "careers", "career", "contact", "contact-us", "jobs", "about"]
EMAIL_RE = re.compile(r"[\w.+-]+(?:@|\s*\[at\]\s*|\s*\(at\)\s*)[\w-]+(?:\.[\w-]+)+", re.I)
# Inboxes on the company's domain that are never the right place for a CV.
NOT_FOR_APPLICANTS = re.compile(r"press|media|^pr$|privacy|legal|abuse|no-?reply|donotreply|webmaster|"
                                r"investor|^ir$|compliance|gdpr|dpo|security|billing|accounts?|invoice|"
                                r"grievance|complaint|unsubscribe|postmaster", re.I)
FIRST_TIER = {"blr": "s1", "pune": "p1", "lko": "l1", "noida": "n1", "rem": "r1"}
UA = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")}


def own_domain(url: str, company: str) -> str:
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    if not host or any(bad in host for bad in NOT_COMPANY_SITES):
        return ""
    label = host.split(".")[0]
    tokens = [t for t in core_tokens(company) if len(t) >= 3]
    # The site must look like the company's: one of its name words in the host
    # label, or the label spelling the name with the spaces removed.
    joined = "".join(tokens)
    if any(t in label for t in tokens) or (joined and joined in label):
        return host
    return ""


def emails_in(text: str, domain: str) -> list:
    out = set()
    for raw in EMAIL_RE.findall(text or ""):
        e = re.sub(r"\s*(\[at\]|\(at\))\s*", "@", raw, flags=re.I).lower().strip(".")
        dom = e.rsplit("@", 1)[-1]
        local = e.split("@", 1)[0]
        if (dom == domain or dom.endswith("." + domain)) and not is_noise_email(e) \
                and not NOT_FOR_APPLICANTS.search(local):
            out.add(e)
    return sorted(out)


def read_site(client: httpx.Client, domain: str, extra_urls: list) -> tuple:
    """Fetch the site's likely pages for free. Returns (emails, text)."""
    found, text = set(), ""
    urls = list(dict.fromkeys(extra_urls + [f"https://{domain}/{p}" for p in PAGES]))
    for url in urls[:8]:
        try:
            r = client.get(url)
        except httpx.HTTPError:
            continue
        if r.status_code != 200 or "text/html" not in r.headers.get("content-type", ""):
            continue
        page = r.text
        found.update(emails_in(page, domain))
        text += " " + re.sub(r"<[^>]+>", " ", page)[:20000]
        if any(re.search(r"hr|career|job|recruit|talent|hiring", e.split("@")[0]) for e in found):
            break                             # a hiring address is what we came for
        time.sleep(random.uniform(0.5, 1.5))
    return sorted(found), text


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="ignore the once-a-day interval")
    ap.add_argument("--limit", type=int, default=0, help="check at most this many leads")
    args = ap.parse_args()

    cfg = {**DEFAULTS, **(fb.config().get("website_emails") or {})}
    if not cfg["enabled"]:
        print("website emails: disabled in firecrawl.config.json")
        return 0
    key = fb.api_key()
    if not key:
        print("website emails: no FIRECRAWL_API_KEY — skipped")
        return 0
    if not args.force and not fb.due("website_emails", float(cfg["every_hours"])):
        print(f"website emails: ran in the last {cfg['every_hours']}h — skipped to save credits")
        return 0

    creds = load_creds()
    dash = Dashboard.from_creds(creds)
    state = fb.feature_state("website_emails")
    tried = state.get("tried", {})
    cutoff = (dt.date.today() - dt.timedelta(days=int(cfg["retry_after_days"]))).isoformat()
    tried = {k: v for k, v in tried.items() if v >= cutoff}

    leads = [c for c in dash.get("/api/companies")
             if c.get("grade") in ("A", "B") and c.get("stage") == "none"
             and not c.get("hr") and not c.get("em") and c["id"] not in tried
             and "(hiring post)" not in c["n"]]
    prio = {t: i for i, t in enumerate(cfg["priority_cities"])}
    leads.sort(key=lambda c: (prio.get(c["tab"], 99), -(c.get("posted_at") or c.get("created_at") or 0),
                              -(c.get("score") or 0)))

    found_n, checked = 0, 0
    results = []
    with httpx.Client(timeout=30) as fc, httpx.Client(headers=UA, follow_redirects=True, timeout=20) as web:
        for c in leads[: args.limit or int(cfg["max_companies_per_run"])]:
            if not fb.can_spend(fb.SEARCH_COST):
                print("website emails: daily Firecrawl credit cap reached")
                break
            name = c["n"]
            checked += 1
            tried[c["id"]] = dt.date.today().isoformat()
            try:
                r = fc.post(fb.SEARCH_URL, headers={"Authorization": f"Bearer {key}"},
                            json={"query": f"\"{name}\" careers contact", "limit": 6, "country": "IN"})
                fb.spend(fb.SEARCH_COST)
                rows = (r.json().get("data") or {}).get("web", []) if r.status_code == 200 else []
            except (httpx.HTTPError, ValueError) as e:
                print(f"  {name}: search failed ({e})")
                continue

            domain, page_urls, snippet_text = "", [], ""
            for row in rows:
                d = own_domain(row.get("url", ""), name)
                if d and not domain:
                    domain = d
                if d and d == domain:
                    page_urls.append(row["url"])
                    snippet_text += " " + (row.get("description") or "")
            if not domain:
                print(f"  {name}: no website found")
                continue

            emails = set(emails_in(snippet_text, domain))
            site_emails, text = read_site(web, domain, page_urls)
            emails.update(site_emails)
            if not emails and fb.can_spend(fb.SCRAPE_COST):
                try:
                    r = fc.post(fb.SCRAPE_URL, headers={"Authorization": f"Bearer {key}"},
                                json={"url": f"https://{domain}/contact", "formats": ["markdown"],
                                      "onlyMainContent": False})
                    fb.spend(fb.SCRAPE_COST)
                    if r.status_code == 200:
                        md = (r.json().get("data") or {}).get("markdown", "")
                        emails.update(emails_in(md, domain))
                        text += " " + md
                except (httpx.HTTPError, ValueError):
                    pass

            emails = [e for e in emails if mx.has_mx(e.rsplit("@", 1)[-1])]
            if not emails:
                print(f"  {name} ({domain}): site has no email")
                continue
            hr, em = split_contacts(emails, text)
            found_n += 1
            results.append({"company": name, "hr": hr, "em": em})
            print(f"  {name} ({domain}): hr={hr} em={em}")
            if not args.dry_run:
                body = {"hr": hr, "em": em}
                if hr:
                    body["section"] = FIRST_TIER.get(c["tab"], "s1")
                try:
                    dash.c.patch(f"{dash.base}/api/companies/{quote(c['id'], safe='')}", json=body).raise_for_status()
                except httpx.HTTPError as e:
                    print(f"    could not save: {e}")

    if results and not args.dry_run:
        dash.notify("scrape", f"Found emails for {len(results)} compan{'y' if len(results) == 1 else 'ies'}",
                    "\n".join(f"• {r['company']}: {', '.join(r['hr'] or r['em'])}" for r in results[:10]))
    if not args.dry_run:
        state["tried"] = tried
        state["last_found"] = results[-20:]
        fb.save_feature_state("website_emails", state)
        fb.mark_ran("website_emails")
    print(f"website emails: checked {checked}, found contacts for {found_n} "
          f"({fb.spent_today()} Firecrawl credits used today)")
    return 0


def _run_reporting_crashes(main_fn, label: str) -> int:
    """Run main; an unexpected crash is reported to the phone, not just the log."""
    try:
        return main_fn()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        try:
            from pilot_client import Dashboard
            Dashboard.from_creds().notify("error", f"{label} crashed", f"{type(e).__name__}: {e}"[:500])
        except BaseException:
            pass
        return 2


if __name__ == "__main__":
    sys.exit(_run_reporting_crashes(main, "Website email finder"))
