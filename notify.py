"""Send one notification to the dashboard feed and your phone.

    python notify.py error "Scrape run failed" "push.py exited with code 1 — see scrape.log"

Used by scrape.cmd / scrape.py when a step crashes before it could report
anything itself. Kinds: reply, applied, scrape, summary, error, info.
"""
import sys

from pilot_client import Dashboard

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    kind, title = sys.argv[1], sys.argv[2]
    body = sys.argv[3] if len(sys.argv) > 3 else ""
    Dashboard.from_creds().notify(kind, title, body)
