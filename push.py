"""CLI entrypoint — collect jobs and push them straight into the dashboard API.

Same collection path as main.py, but instead of writing a JSON file for a
manual import it logs into the Cloudflare Pages app and POSTs the companies
to /api/companies/bulk. Existing companies are never overwritten server-side,
so re-running this is safe.

Usage:
    python push.py --url https://pilot-78c.pages.dev --email me@example.com
    python push.py --sources remoteok naukri          # url/password from env
    python push.py --dry-run                          # collect + print, push nothing
    python push.py --due-only                         # only sources whose interval elapsed

Env fallbacks: JO_URL, JO_EMAIL, JO_PASSWORD. Prefer JO_PASSWORD over --password:
an argument is visible in `ps` to every user on the host and lands in shell history.
"""
import argparse
import os
import sys
from typing import Dict, List, Tuple

# Windows terminals default stdout to cp1252, which can't print an em-dash
# or arrow — reconfigure to UTF-8 so status lines don't crash the run.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import httpx

import events
import pipeline
import scheduler
from models import Job

ALL_SOURCES = dict(pipeline.DISCOVERY)

TABS = ["blr", "pune", "lko", "noida", "rem"]

# The API batches D1 statements internally; 100 companies per request keeps
# each POST body small enough to stay well inside the Workers CPU budget.
CHUNK_SIZE = 100

REQUEST_TIMEOUT = 60.0


class PushError(Exception):
    """A step failed in a way the user needs to act on — message is user-facing."""


def dedupe(jobs: List[Job]) -> List[Job]:
    seen = set()
    out = []
    for job in jobs:
        key = job.dedupe_key()
        if key in seen:
            continue
        seen.add(key)
        out.append(job)
    return out


def prune(client: httpx.Client, base_url: str, days: int) -> int:
    """Drop scraped leads older than `days` that were never acted on.

    Server-side rule is deliberately narrow: it never touches the
    hand-researched set, anything with a stage, a note, or any contact.
    """
    try:
        resp = client.post(f"{base_url}/api/maintenance/prune",
                           json={"days": days}, timeout=REQUEST_TIMEOUT)
    except httpx.RequestError as e:
        print(f"Prune skipped — request failed: {e}")
        return 0
    if resp.status_code != 200:
        print(f"Prune skipped — HTTP {resp.status_code}")
        return 0
    try:
        return int(resp.json().get("removed", 0))
    except ValueError:
        return 0


def record_outcomes(client: httpx.Client, base_url: str, names: List[str],
                    rec: "events.Recorder", dry_run: bool = False) -> None:
    """Stamp each source that just ran into `source_schedule`.

    The per-source status is read back out of the events recorder rather than
    recomputed: pipeline.collect_discovery already recorded ok/skip/fail for
    every source it touched, and inventing a second opinion here would let the
    Events tab and the schedule disagree about the same run.
    """
    statuses = {}
    for event in rec.events:
        if event.get("kind") == "source" and event.get("name") in names:
            statuses[event["name"]] = event.get("status", "ok")

    if dry_run:
        # A dry run really did hit the sources, but stamping last_run_at would
        # then suppress the next real run — surprising for a flag whose whole
        # promise is "changes nothing".
        would = ", ".join("{}={}".format(n, statuses.get(n, "ok")) for n in names)
        print(f"--dry-run: schedule not stamped (would record {would})")
        return

    for name in names:
        scheduler.record(client, base_url, name, statuses.get(name, "ok"))
    print(f"Schedule updated for {len(names)} source(s).")


def login(client: httpx.Client, base_url: str, email: str, password: str) -> None:
    """Sign in and arm the client's session cookie. Raises PushError on failure.

    The dashboard is multi-tenant, so a passphrase alone no longer identifies
    anyone — the session it mints is scoped to one user, and every lead pushed
    afterwards lands on that user's default profile.
    """
    try:
        # follow_redirects=False so we see the response itself — following it
        # would bounce us to "/" and make a wrong-password 401 harder to
        # distinguish.
        resp = client.post(
            f"{base_url}/api/login",
            json={"email": email, "password": password},
            follow_redirects=False,
        )
    except httpx.RequestError as e:
        raise PushError(f"login failed: could not reach {base_url} ({e})")

    if resp.status_code == 401:
        raise PushError("login failed: wrong email or passphrase.")
    # A JSON sign-in answers 200 with a body; 302 is the browser form's reply and
    # is still accepted so an older deployment does not hard-fail here.
    if resp.status_code not in (200, 302):
        raise PushError(
            f"login failed: expected HTTP 200, got HTTP {resp.status_code}. "
            f"Is {base_url} the right dashboard URL?"
        )

    if resp.status_code == 200:
        body = {}
        try:
            body = resp.json()
        except ValueError:
            pass
        if body.get("must_set_password"):
            print("  ! this account is still on the bootstrap SITE_PASSWORD — "
                  "set a real passphrase in the dashboard.")

    token = resp.cookies.get("session")
    if not token:
        raise PushError("login failed: server returned no session cookie.")

    # Set the cookie explicitly rather than relying on the jar: the server marks
    # it Secure, which httpx would then refuse to send to an http:// dev server.
    client.cookies.set("session", token)


def push(client: httpx.Client, base_url: str, companies: List[dict]) -> Tuple[int, int]:
    """POST companies in chunks. Returns (submitted, skipped) totals."""
    submitted = skipped = 0

    for start in range(0, len(companies), CHUNK_SIZE):
        chunk = companies[start:start + CHUNK_SIZE]
        label = f"{start + 1}-{start + len(chunk)} of {len(companies)}"
        try:
            resp = client.post(
                f"{base_url}/api/companies/bulk",
                json={"companies": chunk},
            )
        except httpx.RequestError as e:
            raise PushError(f"push failed on companies {label}: {e}")

        if resp.status_code == 401:
            raise PushError("push failed: session rejected — try again to re-login.")
        if resp.status_code != 200:
            raise PushError(
                f"push failed on companies {label}: HTTP {resp.status_code} "
                f"{resp.text[:200]}"
            )

        try:
            data = resp.json()
        except ValueError:
            raise PushError(f"push failed on companies {label}: response wasn't JSON")

        submitted += int(data.get("submitted", 0))
        skipped += int(data.get("skipped", 0))
        print(f"  pushed {label} — submitted {data.get('submitted')}, "
              f"skipped {data.get('skipped')}")

    return submitted, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=os.environ.get("JO_URL"),
                        help="dashboard base URL, e.g. https://pilot-78c.pages.dev "
                             "(or set JO_URL)")
    parser.add_argument("--email", default=os.environ.get("JO_EMAIL"),
                        help="dashboard account email (or set JO_EMAIL)")
    parser.add_argument("--password", default=os.environ.get("JO_PASSWORD"),
                        help="dashboard passphrase. Prefer JO_PASSWORD: an "
                             "argument is visible in `ps` and shell history")
    parser.add_argument("--sources", nargs="+", choices=list(ALL_SOURCES) + ["all"],
                        default=["all"])
    parser.add_argument("--dry-run", action="store_true",
                        help="collect and print what would be pushed, but push nothing")
    parser.add_argument("--ats", nargs="+", metavar="PROVIDER:SLUG", default=[],
                        help="watch a company's own ATS board, e.g. greenhouse:stripe lever:netflix")
    parser.add_argument("--no-probe", action="store_true",
                        help="skip probing discovered companies for an ATS board")
    parser.add_argument("--max-probes", type=int, default=40,
                        help="cap on ATS probe requests (default 40)")
    parser.add_argument("--min-grade", choices=["A", "B", "C", "D"], default="C",
                        help="only push leads at or above this grade (default C). "
                             "The relevance gate already dropped anything that "
                             "isn't the right role/level/city, so this just trims "
                             "the D tail: agency reposts, stale listings and "
                             "wrong-stack roles. Tighten to B or A to see less.")
    parser.add_argument("--require-contact", action="store_true",
                        help="only push leads that have an email or phone to reach")
    parser.add_argument("--due-only", action="store_true",
                        help="only run sources whose per-source interval has "
                             "elapsed (see /api/schedule). Off by default, so "
                             "a plain run still touches every source. If the "
                             "schedule can't be read the run proceeds as "
                             "normal — a broken scheduler never blocks a scrape.")
    parser.add_argument("--prune-days", type=int, default=0, metavar="N",
                        help="before pushing, drop scraped leads older than N days "
                             "that were never acted on (0 = don't prune)")
    args = parser.parse_args()

    # --url/--email/--password are only required for a real push; a dry run needs none.
    if not args.dry_run:
        missing = [flag for flag, value in (("--url", args.url), ("--email", args.email),
                                            ("--password", args.password))
                   if not value]
        if missing:
            parser.error(f"{' and '.join(missing)} required "
                         "(or set JO_URL / JO_EMAIL / JO_PASSWORD)")

    base_url = (args.url or "").rstrip("/")
    names = list(ALL_SOURCES) if "all" in args.sources else args.sources

    ats_slugs = {}
    for spec in args.ats:
        provider, _, slug = spec.partition(":")
        if provider not in pipeline.ATS or not slug:
            parser.error(f"--ats expects provider:slug with provider in "
                         f"{'/'.join(pipeline.ATS)}, got {spec!r}")
        ats_slugs.setdefault(provider, []).append(slug)

    rec = events.Recorder()
    rec.start()

    client = httpx.Client(timeout=REQUEST_TIMEOUT)
    try:
        # Log in first — no point spending minutes scraping only to find out
        # the passphrase is wrong.
        if not args.dry_run:
            print(f"Logging into {base_url} ...")
            login(client, base_url, args.email, args.password)
            print("Logged in.")

            if args.prune_days > 0:
                removed = prune(client, base_url, args.prune_days)
                print(f"Pruned {removed} stale lead(s) older than "
                      f"{args.prune_days}d that were never acted on.")
                rec.prune("ok", counts={"removed": removed, "days": args.prune_days})

        elif args.due_only and base_url and args.password:
            # A dry run needs no session — except that reading the schedule
            # does, since /api/* is gated by the middleware. Failing here is
            # not fatal: scheduler.due_sources falls back to local state.
            try:
                login(client, base_url, args.email, args.password)
                print("Logged in (read-only — --due-only needs the schedule).")
            except PushError as e:
                print(f"Schedule login skipped — {e}")

        if args.due_only:
            due, skipped = scheduler.due_sources(client, base_url, names)
            for name, why in skipped:
                print(f"  {name} — {why}")
                # The Events tab should show a deliberate skip as a skip, not
                # as a source that silently returned nothing.
                rec.source(name, "skip", message=why[:300])
            if not due:
                print("\nNothing is due — every source is inside its interval.")
                # A run with nothing to do is a success. Closing the run keeps
                # the Events tab from reading it as a crash, and the exit code
                # stays 0 so a cron wrapper doesn't start alerting.
                rec.end("ok", message="nothing due", counts={"submitted": 0})
                return
            print(f"--due-only: running {len(due)} of {len(names)} source(s) — "
                  f"{', '.join(due)}")
            names = due

        jobs = pipeline.run(
            names,
            ats_slugs=ats_slugs,
            probe=not args.no_probe,
            max_probes=args.max_probes,
            rec=rec,
        )
        if args.due_only:
            record_outcomes(client, base_url, names, rec, dry_run=args.dry_run)

        jobs = dedupe(jobs)
        companies, dropped = pipeline.build_companies(jobs)

        # Quality gate. A dashboard full of D-grade agency reposts is worse
        # than a short list — you stop trusting the list.
        before_gate = len(companies)
        companies = pipeline.apply_quality_gate(
            companies, min_grade=args.min_grade,
            require_contact=args.require_contact,
        )
        gated = before_gate - len(companies)
        rec.layer("quality_gate", "ok",
                  counts={"kept": len(companies), "dropped": gated},
                  message=f"min grade {args.min_grade}")

        per_tab = {tab: 0 for tab in TABS}
        for company in companies:
            per_tab[company["tab"]] += 1

        grades = {}
        platforms = {}
        for company in companies:
            g = company.get("grade") or "-"
            grades[g] = grades.get(g, 0) + 1
            p = company.get("platform") or "-"
            platforms[p] = platforms.get(p, 0) + 1

        print(f"\n{len(jobs)} jobs after dedupe")
        print("grades: " + ", ".join(f"{g}:{grades[g]}" for g in "ABCD" if g in grades))
        print(f"platforms: {platforms}")
        print(f"{dropped} dropped (location not one of {'/'.join(TABS)})")
        print(f"{gated} dropped by the quality gate (below grade {args.min_grade}"
              f"{', or no contact route' if args.require_contact else ''})")
        print(f"{len(companies)} companies to push: "
              f"{ {tab: n for tab, n in per_tab.items() if n} }")

        if not companies:
            print("\nNothing to push.")
            # Mark the run finished. Without this the Events tab shows a null
            # end time, which is its signal for "the run died" — a run that
            # legitimately found nothing must not look like a crash.
            rec.end("ok", message="completed; no lead passed the filters",
                    counts={"submitted": 0})
            return

        if args.dry_run:
            rec.end("ok", message="dry run — nothing pushed")
            print("\n--dry-run: would push these companies (first 20 shown)")
            for company in companies[:20]:
                print(f"  [{company['tab']}] {company.get('grade') or '-'}"
                      f"{company.get('score', 0):>4}  {company['name']} — "
                      f"{company['job_title']} ({company['platform']})")
            if len(companies) > 20:
                print(f"  ... and {len(companies) - 20} more")
            return

        print(f"\nPushing in chunks of {CHUNK_SIZE} ...")
        submitted, skipped = push(client, base_url, companies)
        rec.push("ok", counts={"submitted": submitted, "skipped": skipped})
        print(f"\nDone — submitted {submitted}, skipped {skipped}. "
              "Existing companies were left untouched.")
        rec.end("ok", counts={"submitted": submitted, "skipped": skipped})
    except PushError as e:
        print(f"\nERROR: {e}")
        rec.error("push", str(e))
        rec.end("fail", message=str(e)[:300])
        # Still try to save the run log — knowing the run failed, and where, is
        # exactly what the Events tab is for.
        rec.flush(client, base_url)
        client.close()
        sys.exit(1)
    finally:
        # A dry run has no authenticated client, so there is nothing to post to.
        if not args.dry_run:
            rec.flush(client, base_url)
        print(rec.summary())
        client.close()


if __name__ == "__main__":
    main()
