"""Turn discovered company NAMES into real ATS board slugs.

Layer 1 (aggregators, LinkedIn) gives us company names. Layer 2 needs slugs.
There is no lookup API for that mapping, so we guess a couple of obvious
slugs per name and ask each board whether it exists.

This is a courtesy scan, not a crawl: candidates are capped at 3 per company,
total requests at `max_probes`, and every candidate is paced. A company that
resolves on one board stops being probed for that board.
"""
import re
import time
from typing import Dict, List

import httpx

import config

LOG = "ats_probe"

# Cheapest "does this board exist and have postings" call per ATS. A HEAD
# would confirm the slug but not that the board has any open roles, and an
# empty board is useless to us — so these are GETs with the smallest payload
# each API offers (Greenhouse without content=true, Lever with limit=1).
PROBES = {
    "greenhouse": "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
    "lever": "https://api.lever.co/v0/postings/{slug}?mode=json&limit=1",
    "ashby": "https://api.ashbyhq.com/posting-api/job-board/{slug}",
}


def _candidates(name: str) -> List[str]:
    """1-3 slug guesses: "Zethic Technologies" -> zethic-technologies,
    zethictechnologies, zethic. Boards use all three conventions."""
    cleaned = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not cleaned:
        return []

    out = [cleaned]
    squashed = cleaned.replace("-", "")
    if squashed and squashed not in out:
        out.append(squashed)

    # Bare first word only if it is distinctive — "the" or "go" would probe
    # somebody else's board entirely.
    first = cleaned.split("-")[0]
    if len(first) >= 4 and first not in out:
        out.append(first)

    return out[:3]


def _has_jobs(client: httpx.Client, board: str, slug: str) -> bool:
    """A 200 is not proof on its own — a parked or private board answers 200
    with an empty list. Require at least one posting before claiming a match.
    """
    url = PROBES[board].format(slug=slug)
    try:
        resp = client.get(url, timeout=config.REQUEST_TIMEOUT)
    except httpx.RequestError:
        return False

    if resp.status_code != 200:
        return False  # 404 is the normal answer here, not an error

    try:
        data = resp.json()
    except ValueError:
        return False

    postings = data if isinstance(data, list) else (data or {}).get("jobs") or []
    return bool(postings)


def probe_ats(company_names: List[str], max_probes: int = 40) -> Dict[str, List[str]]:
    """Return {board: [slugs that actually resolved]} for the given names."""
    resolved: Dict[str, List[str]] = {board: [] for board in PROBES}
    headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}
    probes = 0
    capped = False

    with httpx.Client(headers=headers, follow_redirects=True) as client:
        for name in company_names:
            if probes >= max_probes:
                capped = True
                break

            pending = [b for b in PROBES if probes < max_probes]
            for slug in _candidates(name):
                if not pending or probes >= max_probes:
                    break

                for board in list(pending):
                    if probes >= max_probes:
                        break
                    probes += 1
                    if _has_jobs(client, board, slug) and slug not in resolved[board]:
                        resolved[board].append(slug)
                        pending.remove(board)  # this company is found on that ATS

                # Paced per candidate, not per request: the three probes above
                # go to three different hosts, so none of them is a repeat hit.
                if pending:
                    time.sleep(config.DELAY_BETWEEN_REQUESTS)

    if probes >= max_probes:
        capped = True

    summary = " ".join(
        f"{board}={','.join(slugs) if slugs else '-'}"
        for board, slugs in resolved.items()
    )
    print(f"[{LOG}] {probes} probes over {len(company_names)} companies"
          f"{' (capped)' if capped else ''} -> {summary}")

    return resolved
