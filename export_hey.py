"""Turn a deduped job list into hey.html's Import file shape.

hey.html's import button only reads {state, custom, tpl}. `custom` is the
same structure the "Add a company" form writes to — a dict keyed by tab
(blr/pune/lko/noida/rem), each holding company cards. It's merged in,
deduped by company name against what's already in the tracker, and never
overwrites existing progress (state is untouched — we send an empty one).
"""
from collections import defaultdict
from typing import Dict, List

from locations import classify
from models import Job

TABS = ["blr", "pune", "lko", "noida", "rem"]


def build_custom(jobs: List[Job]) -> Dict[str, list]:
    """Dedupe by company within each tab, keep the best-matching role."""
    by_tab_company: Dict[str, Dict[str, dict]] = defaultdict(dict)
    extra_roles: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for job in jobs:
        tab = classify(job.location_raw)
        if tab is None:
            continue

        key = job.company_key()
        if key in by_tab_company[tab]:
            extra_roles[tab][key] += 1
            continue

        posted = f", posted {job.posted_raw}" if job.posted_raw else ""
        by_tab_company[tab][key] = {
            "n": job.company,
            "hr": [],
            "em": [],
            "wa": [],
            "note": f"{job.role} — via {job.platform}{posted}. Auto-scraped, verify before contacting.",
            "job": {"u": job.url, "t": job.role},
        }

    for tab, companies in by_tab_company.items():
        for key, extra in extra_roles[tab].items():
            if extra:
                companies[key]["note"] += f" (+{extra} more role{'s' if extra > 1 else ''} found)"

    return {tab: list(companies.values()) for tab, companies in by_tab_company.items() if companies}


def build_import_file(jobs: List[Job]) -> dict:
    return {
        "state": {},
        "custom": build_custom(jobs),
        "tpl": "",
    }
