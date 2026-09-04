"""CLI entrypoint — collect jobs, dedupe, write a hey.html-importable JSON file.

Usage:
    python main.py                          # all sources, writes scraped.json
    python main.py --sources remoteok naukri
    python main.py --out my-run.json
    python main.py --dry-run                # collect + print summary, don't write
"""
import argparse
import json
import sys
from typing import List

# Windows terminals default stdout to cp1252, which can't print an em-dash
# or arrow — reconfigure to UTF-8 so status lines don't crash the run.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from models import Job
from export_hey import build_import_file
from sources.remoteok import RemoteOKSource
from sources.weworkremotely import WeWorkRemotelySource
from sources.naukri import NaukriSource
from sources.linkedin import LinkedInSource

ALL_SOURCES = {
    "remoteok": RemoteOKSource,
    "weworkremotely": WeWorkRemotelySource,
    "naukri": NaukriSource,
    "linkedin": LinkedInSource,
}


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", nargs="+", choices=list(ALL_SOURCES) + ["all"],
                         default=["all"])
    parser.add_argument("--out", default="scraped.json")
    parser.add_argument("--dry-run", action="store_true",
                         help="collect and print a summary, but don't write the file")
    args = parser.parse_args()

    names = list(ALL_SOURCES) if "all" in args.sources else args.sources

    all_jobs: List[Job] = []
    for name in names:
        source = ALL_SOURCES[name]()
        all_jobs.extend(source.collect())

    before = len(all_jobs)
    jobs = dedupe(all_jobs)
    print(f"\n{before} jobs collected, {len(jobs)} after dedupe")

    payload = build_import_file(jobs)
    counts = {tab: len(companies) for tab, companies in payload["custom"].items()}
    total_companies = sum(counts.values())
    print(f"{total_companies} companies mapped to tracked cities: {counts}")

    if args.dry_run:
        print("\n--dry-run: not writing a file")
        return

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {args.out} — import it in hey.html via the ↑ Import button.")


if __name__ == "__main__":
    main()
