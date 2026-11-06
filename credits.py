"""Collect credit / quota balances for every paid account and publish them to the
dashboard's Credits tab.

The API keys live on this machine (.push-credentials), never in Cloudflare, so the
browser cannot ask Firecrawl or Apify itself. This script asks them (both
balance endpoints are free — no credits are spent checking) and stores the result
under the per-profile setting `credits_status`, which the tab reads. It runs after
every scrape (scrape.py) and can also be run by hand or from cron:

    python credits.py            # check and publish
    python credits.py --print    # check and show, publish nothing

More than one account per service is supported: any credentials line named
FIRECRAWL_API_KEY / FIRECRAWL_API_KEY_<NAME> or APIFY_TOKEN / APIFY_TOKEN_<NAME>
becomes its own row, labelled by <NAME>. Keys are never copied into the payload.
"""
import argparse
import datetime as dt
import json
import sys

import httpx

import firecrawl_budget as fb
from pilot_client import Dashboard, load_creds

TIMEOUT = 20


def _label(key: str, base: str) -> str:
    rest = key[len(base):].lstrip("_")
    return rest.replace("_", " ").title() if rest else "Main"


def firecrawl(key: str, label: str) -> dict:
    row = {"service": "Firecrawl", "label": label, "unit": "credits"}
    try:
        r = httpx.get("https://api.firecrawl.dev/v2/team/credit-usage",
                      headers={"Authorization": f"Bearer {key}"}, timeout=TIMEOUT)
        r.raise_for_status()
        d = r.json()["data"]
        total, left = int(d["planCredits"]), int(d["remainingCredits"])
        row.update(total=total, remaining=left, used=total - left, period_end=d.get("billingPeriodEnd"))
    except Exception as e:
        row["error"] = f"{type(e).__name__}: {str(e)[:120]}"
        return row
    # Our own daily budget (shared by every Firecrawl feature) is separate from the plan.
    try:
        today = dt.date.today().isoformat()
        spent = int((fb._load().get("spend") or {}).get(today, 0))
        cap = int(fb.config().get("daily_credit_cap", 0))
        if cap:
            row["note"] = f"Today: about {spent} of the {cap}-credit daily cap used by the scraper"
    except Exception:
        pass
    return row


def apify(key: str, label: str) -> dict:
    row = {"service": "Apify", "label": label, "unit": "USD"}
    try:
        h = {"Authorization": f"Bearer {key}"}
        me = httpx.get("https://api.apify.com/v2/users/me", headers=h, timeout=TIMEOUT)
        me.raise_for_status()
        lim = httpx.get("https://api.apify.com/v2/users/me/limits", headers=h, timeout=TIMEOUT)
        lim.raise_for_status()
        d = lim.json()["data"]
        total = float(d["limits"]["maxMonthlyUsageUsd"])
        used = float(d["current"]["monthlyUsageUsd"])
        plan = (me.json()["data"].get("plan") or {}).get("id", "")
        row.update(total=round(total, 2), used=round(used, 4), remaining=round(max(0.0, total - used), 4),
                   period_end=(d.get("monthlyUsageCycle") or {}).get("endAt"),
                   note=f"{plan.title()} plan" if plan else "")
    except Exception as e:
        row["error"] = f"{type(e).__name__}: {str(e)[:120]}"
    return row


def email_quota(dash) -> dict:
    """Auto-apply sends from Gmail; the only meter is how many went out today."""
    row = {"service": "Gmail (auto-apply)", "label": "Today", "unit": "emails"}
    try:
        state = json.loads((fb.HERE / "apply_state.json").read_text(encoding="utf-8"))
        sent = int((state.get("days") or {}).get(dt.date.today().isoformat(), 0))
        cfg = dash.setting("auto_apply") or {}
        target = int(cfg.get("daily_target") or 20)
        row.update(total=target, used=sent, remaining=max(0, target - sent),
                   note="Daily target, automatic plus manual sends. Gmail itself allows about 500 a day.")
    except Exception as e:
        row["error"] = f"{type(e).__name__}: {str(e)[:120]}"
    return row


def collect(dash=None) -> dict:
    creds = load_creds()
    accounts = []
    for k in sorted(creds):
        if creds[k] and (k == "FIRECRAWL_API_KEY" or k.startswith("FIRECRAWL_API_KEY_")):
            accounts.append(firecrawl(creds[k], _label(k, "FIRECRAWL_API_KEY")))
        elif creds[k] and (k == "APIFY_TOKEN" or k.startswith("APIFY_TOKEN_")):
            accounts.append(apify(creds[k], _label(k, "APIFY_TOKEN")))
    if dash is not None:
        accounts.append(email_quota(dash))
    return {"checked_at": int(dt.datetime.now().timestamp() * 1000), "accounts": accounts}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", action="store_true", help="show the result, publish nothing")
    args = ap.parse_args()

    dash = None if args.print else Dashboard.from_creds()
    status = collect(dash)
    for a in status["accounts"]:
        if a.get("error"):
            print(f"{a['service']} ({a['label']}): ERROR {a['error']}")
        else:
            print(f"{a['service']} ({a['label']}): {a['remaining']} of {a['total']} {a['unit']} left")
    if dash is not None:
        dash.put("/api/settings/credits_status", {"value": json.dumps(status)})
        print("published to the dashboard")
    return 0


if __name__ == "__main__":
    sys.exit(main())
