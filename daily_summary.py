"""The 5pm summary — what Pilot did today, sent to your phone and your inbox.

Run by the Windows scheduled task "Pilot daily summary" at 17:00
(summary.cmd), or by hand:

    python daily_summary.py            # send it
    python daily_summary.py --print    # just print it

It goes to the notification feed + phone push like every other event, and is
also emailed to GMAIL_USER when the Gmail app password is set — a push can be
missed, an email in the inbox is not.
"""
import argparse
import datetime as dt
import email.utils
import json
import smtplib
import sys
from email.message import EmailMessage

import firecrawl_budget as fb
from pilot_client import Dashboard, load_creds

NAMES = {"blr": "Bangalore", "pune": "Pune", "lko": "Lucknow", "noida": "Noida", "rem": "Remote"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--print", action="store_true", help="print the summary; send nothing")
    args = ap.parse_args()

    creds = load_creds()
    dash = Dashboard.from_creds(creds)
    now = dt.datetime.now()
    start = int(dt.datetime(now.year, now.month, now.day).timestamp() * 1000)
    is_today = lambda ms: bool(ms) and int(ms) >= start

    try:
        log = dash.get("/api/apply-log")
    except Exception:
        log = []
    companies = dash.get("/api/companies")
    cfg = dash.setting("auto_apply") or {}
    status = dash.setting("auto_apply_status") or {}

    sent = [r for r in log if is_today(r["sent_at"])]
    followups = [r for r in log if is_today(r.get("followup_at"))]
    replies = [r for r in log if is_today(r.get("replied_at"))]
    bounces = [r for r in log if is_today(r.get("bounced_at"))]
    total_replied = sum(1 for r in log if r.get("replied_at"))

    new = [c for c in companies if is_today(c.get("created_at"))]
    new_ab = [c for c in new if c.get("grade") in ("A", "B")]
    new_hr = [c for c in new if c.get("hr")]
    by_city = {}
    for c in new:
        by_city[c["tab"]] = by_city.get(c["tab"], 0) + 1
    grades = set(cfg.get("grades", "AB"))
    waiting = [c for c in companies if c.get("grade") in grades and c.get("stage") == "none" and c.get("hr")]

    fu_days = int(cfg.get("followup_days", 3))
    tomorrow = now + dt.timedelta(days=1)
    fu_due = [r for r in log if not r.get("followup_at") and not r.get("replied_at") and not r.get("bounced_at")
              and dt.datetime.fromtimestamp(r["sent_at"] / 1000) + dt.timedelta(days=fu_days) <= tomorrow]

    lines = []
    if replies:
        lines.append(f"🎉 {len(replies)} repl{'y' if len(replies) == 1 else 'ies'} today: "
                     + ", ".join(r["company"] for r in replies))
    lines.append(f"✉️ Applied to {len(sent)} today" + (f" + {len(followups)} follow-ups" if followups else "")
                 + (f" · {len(bounces)} bounced" if bounces else ""))
    lines.append(f"🔎 {len(new)} new leads ({len(new_ab)} grade A/B, {len(new_hr)} with HR email)"
                 + ("" if not by_city else " — " + ", ".join(f"{NAMES.get(t, t)} {n}" for t, n in by_city.items())))
    lines.append(f"📬 {len(waiting)} leads queued for auto-apply · {len(fu_due)} follow-ups due by tomorrow")
    if log:
        lines.append(f"📈 All-time: {len(log)} sent, {total_replied} replied "
                     f"({round(total_replied / len(log) * 100)}% reply rate)")
    if not cfg.get("enabled"):
        lines.append("⏸ Auto-apply is OFF (Data → Auto-apply)")
    elif cfg.get("test_mode"):
        lines.append("🧪 Auto-apply is in TEST mode — emails go to you only")
    if status.get("last_error"):
        lines.append(f"⚠️ Last auto-apply problem: {status['last_error'][:200]}")
    lines.append(f"Firecrawl: {fb.spent_today()} credits used today")

    title = f"Pilot today — {len(sent)} applied, {len(replies)} replied, {len(new)} new leads"
    body = "\n".join(lines)
    print(title + "\n" + body)
    if args.print:
        return 0

    dash.notify("summary", title, body, "/")

    gmail, gpw = creds.get("GMAIL_USER", ""), creds.get("GMAIL_APP_PASSWORD", "")
    if gmail and gpw:
        msg = EmailMessage()
        msg["From"] = email.utils.formataddr(("Pilot", gmail))
        msg["To"] = gmail
        msg["Subject"] = title
        msg.set_content(body + f"\n\nOpen the dashboard: {creds.get('JO_URL', '')}")
        try:
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=60) as s:
                s.login(gmail, gpw.replace(" ", ""))
                s.send_message(msg)
        except Exception as e:
            print(f"(summary email not sent: {e})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
