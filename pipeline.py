"""The multi-layer scraper.

    layer 1  discovery  aggregator APIs, sitemaps, search — finds companies
    layer 2  ats        Greenhouse / Lever / Ashby / Keka — the company's board
    layer 3  relevance  hard gate: right role, right level, right city
    layer 4  enrich     regex contacts out of the JD, MX-validated
    layer 5  score      genuinity x match -> the two tags (platform, grade)

Every source runs. The relevance gate is what keeps that affordable: broad
ingestion plus a strict filter beats querying fewer sources, because a source
we never ask can never surprise us.

Layer 2 is fed by layer 1: every company discovered gets its slug probed
against the three ATS boards, so a company found on an aggregator gets
upgraded to its authoritative listing when it has one.

`build_companies` then collapses jobs to one row per (city, company), keeping
the strongest-graded job as that company's representative.
"""
import time
import traceback
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import config
import mx
from extract import enrich_job, indian_mobile, split_contacts
from locations import classify
from models import Job
from relevance import filter_jobs
from scoring import score_all

TABS = ["blr", "pune", "lko", "noida", "rem"]

# Layer 1 — broad discovery.
# sources/naukri.py (the /jobapi/ search endpoint) is deliberately NOT here:
# it is reCAPTCHA-gated and now drops connections outright. The sitemap source
# replaces it and carries the same "naukri" platform tag.
DISCOVERY = {
    # keyless aggregator feeds
    "remoteok": ("sources.remoteok", "RemoteOKSource"),
    "weworkremotely": ("sources.weworkremotely", "WeWorkRemotelySource"),
    "remotive": ("sources.remotive", "RemotiveSource"),
    "arbeitnow": ("sources.arbeitnow", "ArbeitnowSource"),
    "instahyre": ("sources.instahyre", "InstahyreSource"),
    # employer-posted, contact usually included
    "hackernews": ("sources.hackernews", "HackerNewsSource"),
    # search / sitemap crawls
    "linkedin": ("sources.linkedin", "LinkedInSource"),
    "naukri_sitemap": ("sources.naukri_sitemap", "NaukriSitemapSource"),
}

# Layer 2 — per-company ATS boards. These take a list of slugs.
ATS = {
    "greenhouse": ("sources.greenhouse", "GreenhouseSource"),
    "lever": ("sources.lever", "LeverSource"),
    "ashby": ("sources.ashby", "AshbySource"),
    "keka": ("sources.keka", "KekaSource"),
}


def _load(module_name: str, class_name: str):
    mod = __import__(module_name, fromlist=[class_name])
    return getattr(mod, class_name)


def collect_discovery(names: List[str], rec=None) -> List[Job]:
    """Layer 1. A source that fails returns nothing rather than killing the run.

    Each source's outcome is recorded individually, so the Events tab shows
    which one broke instead of just a lower total.
    """
    jobs: List[Job] = []
    for name in names:
        if name not in DISCOVERY:
            continue
        try:
            cls = _load(*DISCOVERY[name])
        except Exception as e:
            print(f"[{name}] unavailable: {e}")
            if rec:
                rec.source(name, "fail", message=f"import failed: {e}")
            continue

        started = time.time()
        try:
            found = cls().collect()
        except Exception as e:
            print(f"[{name}] FAILED: {e}")
            if rec:
                rec.source(name, "fail", message=str(e)[:300],
                           duration_ms=int((time.time() - started) * 1000))
            continue

        jobs.extend(found)
        if rec:
            rec.source(name, "ok" if found else "skip", counts={"collected": len(found)},
                       duration_ms=int((time.time() - started) * 1000))
    return jobs


def collect_ats(slugs_by_provider: Dict[str, List[str]], rec=None) -> List[Job]:
    """Layer 2. `slugs_by_provider` looks like {"greenhouse": ["acme"], ...}."""
    jobs: List[Job] = []
    for provider, slugs in slugs_by_provider.items():
        if provider not in ATS or not slugs:
            continue
        try:
            cls = _load(*ATS[provider])
        except Exception as e:
            print(f"[{provider}] unavailable: {e}")
            if rec:
                rec.source(provider, "fail", message=f"import failed: {e}")
            continue

        started = time.time()
        try:
            found = cls(slugs).collect()
        except Exception as e:
            print(f"[{provider}] FAILED: {e}")
            if rec:
                rec.source(provider, "fail", message=str(e)[:300])
            continue

        jobs.extend(found)
        if rec:
            rec.source(provider, "ok" if found else "skip",
                       counts={"collected": len(found), "boards": len(slugs)},
                       duration_ms=int((time.time() - started) * 1000))
    return jobs


def promote_to_ats(jobs: List[Job], max_probes: int = 40) -> Dict[str, List[str]]:
    """Turn discovered company names into ATS slugs (layer 1 -> layer 2).

    Probes Greenhouse/Lever/Ashby and Keka. Keka matters most here: it is what
    Indian SMEs actually use, so it is the layer most likely to turn a name
    found on a feed into that company's own board.
    """
    # Probe the companies most likely to be worth it: ones we found a real
    # opening for, deduped, in discovery order.
    names: List[str] = []
    seen = set()
    for j in jobs:
        k = j.company_key()
        if k and k not in seen:
            seen.add(k)
            names.append(j.company)
    if not names:
        return {}

    found: Dict[str, List[str]] = {}

    # Split the budget so one probe family can't consume it all.
    half = max(5, max_probes // 2)

    try:
        from sources.ats_probe import probe_ats
        found.update(probe_ats(names, max_probes=half) or {})
    except Exception as e:
        print(f"[ats_probe] unavailable: {e}")

    try:
        from sources.keka import probe_keka
        slugs = probe_keka(names, max_probes=max_probes - half) or []
        if slugs:
            found["keka"] = slugs
    except Exception as e:
        print(f"[keka probe] unavailable: {e}")

    return found


def enrich(jobs: List[Job]) -> None:
    """Layer 4 — contacts out of the JD text, then an MX gate on the addresses.

    The MX check is what separates this from the pattern-guessing approach: an
    address only survives if its domain can actually receive mail.

    Per-job try/except: one pathological description (a regex blowing up on a
    4 MB blob, a DNS resolver dying) must cost that one job's contacts, not
    every job's.
    """
    rejected = 0
    failed = 0
    for job in jobs:
        try:
            enrich_job(job)
            if job.emails:
                keep, drop = mx.filter_emails(job.emails)
                rejected += len(drop)
                job.emails = keep
        except Exception as e:
            failed += 1
            if failed <= 3:  # don't spam the log with the same breakage
                print(f"   enrichment failed for {job.company[:30]}: {e}")
    if rejected:
        print(f"   MX gate rejected {rejected} undeliverable address(es); "
              f"{mx.stats()}")
    if failed:
        print(f"   {failed} job(s) could not be enriched — they keep their "
              f"other data and continue through the pipeline")


def _safe_layer(label: str, fn, fallback, rec=None, name: str = ""):
    """Run one pipeline layer; on failure log it and carry on with `fallback`.

    Each layer is independent by design: relevance filtering, contact
    enrichment and scoring all *improve* a job list, none of them is required
    to produce one. A bug in scoring should cost the grades, not the run — the
    leads themselves are still worth having.
    """
    started = time.time()
    try:
        out = fn()
        if rec and name:
            rec.layer(name, "ok", duration_ms=int((time.time() - started) * 1000))
        return out
    except Exception as e:
        print(f"{label}: FAILED ({e}) — continuing without it")
        traceback.print_exc(limit=3)
        if rec and name:
            rec.layer(name, "fail", message=str(e)[:300],
                      duration_ms=int((time.time() - started) * 1000))
        return fallback


def run(
    discovery_names: List[str],
    ats_slugs: Optional[Dict[str, List[str]]] = None,
    probe: bool = False,
    max_probes: int = 40,
    rec=None,
) -> List[Job]:
    """Run every layer and return scored jobs.

    No layer can break the run. Sources are already isolated from each other
    (`Source.collect` swallows its own errors and the circuit breaker skips a
    source that keeps failing); this adds the same isolation *between layers*,
    so a bug in relevance, enrichment or scoring degrades the output instead
    of losing it.
    """
    jobs = _safe_layer("layer 1 — discovery",
                       lambda: collect_discovery(discovery_names, rec), [], rec, "discovery")
    print(f"\nlayer 1 — discovery: {len(jobs)} jobs")

    slugs: Dict[str, List[str]] = dict(ats_slugs or {})
    if probe and jobs:
        found = _safe_layer("layer 2 — probe",
                            lambda: promote_to_ats(jobs, max_probes=max_probes), {},
                            rec, "ats_probe")
        for provider, s in found.items():
            slugs.setdefault(provider, [])
            slugs[provider].extend(x for x in s if x not in slugs[provider])
        if found:
            print("layer 2 — probe promoted: " +
                  ", ".join(f"{p}:{len(s)}" for p, s in found.items() if s))

    if slugs:
        ats_jobs = _safe_layer("layer 2 — ats boards",
                               lambda: collect_ats(slugs, rec), [], rec, "ats")
        print(f"layer 2 — ats boards: {len(ats_jobs)} jobs")
        jobs.extend(ats_jobs)

    if not jobs:
        print("no jobs collected — every source was empty or unavailable")
        return []

    # Relevance failing open (keeping everything) is the right fallback: the
    # grade gate downstream still trims, and a lead you have to skim past
    # beats a lead you never saw.
    before = len(jobs)
    jobs = _safe_layer("layer 3 — relevance",
                       lambda: filter_jobs(jobs)[0], jobs, rec, "relevance")
    print(f"layer 3 — relevance: {len(jobs)} of {before} jobs are actually ours")

    _safe_layer("layer 4 — enrichment", lambda: enrich(jobs), None, rec, "enrichment")
    with_contacts = sum(1 for j in jobs if j.emails or j.phones)
    print(f"layer 4 — enrichment: {with_contacts} jobs carried a contact in the JD")

    _safe_layer("layer 5 — scoring", lambda: score_all(jobs), None, rec, "scoring")
    grades = defaultdict(int)
    for j in jobs:
        grades[j.grade] += 1
    scored = ", ".join(f"{g}:{grades[g]}" for g in "ABCD" if grades[g])
    print("layer 5 — scored: " + (scored or "nothing graded"))

    return jobs


def build_companies(jobs: List[Job]) -> Tuple[List[dict], int]:
    """Collapse jobs to one API row per (city, company).

    The highest-scoring job wins as the company's representative — that is the
    one worth actually applying to, and its grade becomes the company's tag.
    """
    best: Dict[str, Dict[str, Job]] = defaultdict(dict)
    extra: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    dropped = 0

    for job in jobs:
        tab = classify(job.location_raw)
        if tab is None:
            dropped += 1
            continue
        key = job.company_key()
        held = best[tab].get(key)
        if held is None:
            best[tab][key] = job
        else:
            extra[tab][key] += 1
            if job.score > held.score:
                best[tab][key] = job

    out: List[dict] = []
    for tab in TABS:
        for key, job in best[tab].items():
            hr, em = split_contacts(job.emails, job.jd_text)
            wa = [p.lstrip("+") for p in job.phones if indian_mobile(p)]

            posted = f", posted {job.posted_raw}" if job.posted_raw else ""
            note = (f"{job.role} — via {job.platform}{posted}. "
                    f"Auto-scraped, verify before contacting.")
            n_extra = extra[tab][key]
            if n_extra:
                note += f" (+{n_extra} more role{'s' if n_extra > 1 else ''} found)"

            out.append({
                "name": job.company,
                "tab": tab,
                # section omitted — the API assigns one from hr/wa/job_url
                "hr": hr,
                "em": em,
                "wa": wa,
                "li": "",
                "note": note,
                "job_url": job.url,
                "job_title": job.role,
                "source": "scraped",
                "scraped_from": job.platform,
                # the two tags
                "platform": job.platform,
                "grade": job.grade,
                "score": job.score,
                "reasons": job.reasons,
                "jd_excerpt": (job.jd_text or "")[:600],
                "posted_at": int(job.posted_at.timestamp() * 1000) if job.posted_at else None,
            })
    return out, dropped


GRADE_ORDER = {"A": 4, "B": 3, "C": 2, "D": 1, "": 0}


def apply_quality_gate(companies: List[dict], min_grade: str = "B",
                       require_contact: bool = False) -> List[dict]:
    """Keep only leads worth acting on.

    Volume is not the goal — a list you trust is. A C or D grade means an
    agency repost, a stale listing, a seniority mismatch or the wrong stack;
    pushing those buries the handful you would actually apply to.

    An ungraded lead is dropped too: if scoring couldn't form a view, there is
    nothing to justify putting it in front of you.
    """
    floor = GRADE_ORDER.get(min_grade, 3)
    kept = []
    for c in companies:
        if GRADE_ORDER.get(c.get("grade", ""), 0) < floor:
            continue
        if require_contact and not (c.get("hr") or c.get("em") or c.get("wa")):
            continue
        kept.append(c)
    return kept
