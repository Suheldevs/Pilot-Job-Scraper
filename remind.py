"""Morning reminder: the leads only you can contact, sent to your phone.

Auto-apply only handles leads with an HR email. Everything else — WhatsApp
numbers, LinkedIn-only companies, bare job links — needs a human, and is the
easiest thing to forget. This picks the best few of those (newest first, grade
A/B, still "Not contacted") plus any contacted lead gone quiet for a week, and
sends one sticky notification that opens the Pipeline.

Run by the Windows scheduled task "Pilot apply reminder" (remind.cmd), or:

    python remind.py           # send it
    python remind.py --print   # just print it
"""
import argparse
import sys
import time

from auto_apply import EXPERIENCE_RE, identity
from pilot_client import Dashboard

NAMES = {"blr": "Bangalore", "pune": "Pune", "lko": "Lucknow", "noida": "Noida", "rem": "Remote"}
TOP = 5


def channel(c: dict, auto_on: bool) -> str:
    """How you would reach this lead by hand, or "" when auto-apply covers it."""
    if c.get("hr") and auto_on:
        return ""                                  # auto-apply will email it
    if c.get("wa"):
        return "WhatsApp"
    if c.get("hr") or c.get("em"):
        return "email"
    if c.get("li"):
        return "LinkedIn"
    if c.get("job"):
        return "apply link"
    return ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--print", action="store_true")
    args = ap.parse_args()

    dash = Dashboard.from_creds()
    companies = dash.get("/api/companies")
    auto = dash.setting("auto_apply") or {}
    auto_on = bool(auto.get("enabled")) and not auto.get("test_mode", True)
    me = identity(dash.get("/api/profiles"))

    def too_senior(c):
        # Same rule as auto-apply: skip a post asking for more years than the
        # profile's ceiling, from the stored number or the JD excerpt.
        exp = c.get("experience_min")
        if exp is None:
            m = EXPERIENCE_RE.search(c.get("jd_excerpt") or "")
            exp = float(m.group(1)) if m else None
        return me["exp_max"] is not None and exp is not None and float(exp) > me["exp_max"]

    todo = []
    for c in companies:
        if c.get("stage") != "none" or c.get("grade") not in ("A", "B") or too_senior(c):
            continue
        how = channel(c, auto_on)
        if how:
            todo.append((c, how))
    todo.sort(key=lambda x: -(x[0].get("created_at") or 0))

    week = time.time() * 1000 - 7 * 86400000
    quiet = [c for c in companies if c.get("stage") == "contacted" and (c.get("stage_at") or 0) < week]

    if not todo and not quiet:
        print("Nothing to do by hand today.")
        return 0

    city = lambda c: (c.get("city") if c.get("tab") == "oth" and c.get("city") else NAMES.get(c.get("tab"), c.get("tab", "")))
    lines = [f"• {c['n']} — {((c.get('job') or {}).get('t') or 'opening')[:40]} ({how}, {city(c)})"
             for c, how in todo[:TOP]]
    if len(todo) > TOP:
        lines.append(f"+ {len(todo) - TOP} more waiting")
    if quiet:
        lines.append(f"↻ {len(quiet)} contacted a week ago with no reply — follow up")

    title = (f"{min(len(todo), TOP)} leads to apply to by hand" if todo else "Follow-ups waiting") + " — 10 minutes"
    body = "\n".join(lines)
    print(title + "\n" + body)
    if not args.print:
        dash.notify("reminder", title, body, "/?view=pipeline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
