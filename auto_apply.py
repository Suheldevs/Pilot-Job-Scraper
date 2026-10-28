"""Auto-apply — email grade A/B leads from your Gmail, follow up once, track replies.

Runs on this PC after each scrape (scrape.cmd calls it), or by hand:

    python auto_apply.py              # a real run, as configured in the dashboard
    python auto_apply.py --dry-run    # print what it would do; sends and writes nothing
    python auto_apply.py --preview    # dry run ignoring on/off, window and test mode

All behaviour is set in the dashboard (Data -> Auto-apply), stored under the
per-profile settings key `auto_apply`. Credentials come from .push-credentials:

    JO_URL / JO_EMAIL / JO_PASSWORD     the dashboard login push.py already uses
    GMAIL_USER                          the address mail is sent from
    GMAIL_APP_PASSWORD                  a Google app password (not your Gmail password)
    RESUME_PDF                          optional; defaults to resume.pdf next to this file

One run, in order:
  1. restore   — the dashboard's send log (apply_log) is merged into the local
                 record, so a lost apply_state.json cannot cause repeat emails.
  2. replies   — IMAP: mail from a company we wrote to (same address or domain)
                 moves that lead to Replied, cancels its follow-up and pings the
                 phone. Bounces are recorded.
  3. follow-up — one per company, threaded under the first email, once
                 `followup_days` have passed with no reply and the lead is still
                 at Contacted (moving it yourself cancels the follow-up).
  4. new       — grade-matched leads at "Not contacted" with an HR inbox, newest
                 job first, until the daily limit is used up.

Guard rails, enforced here rather than trusted to the settings form:
  * hard cap of 50 emails a day whatever the setting says, sends spaced 45-120s;
  * only inside the send window, on the chosen weekdays;
  * never a second first-email to the same company, address or email domain;
  * current company (from Profile) and every listed previous company skipped,
    by name and by the HR address's domain;
  * the job title must name one of the profile's must-have skills;
  * the address's domain must accept mail (MX check), so dead inboxes are not
    bounced into — bounces are what get a Gmail account flagged;
  * test mode sends at most 3 emails a run, all to GMAIL_USER, and changes no
    lead's stage.
"""
import argparse
import datetime as dt
import email.utils
import imaplib
import json
import random
import re
import smtplib
import sys
import time
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import quote

import mx
from pilot_client import Dashboard, load_creds

HERE = Path(__file__).resolve().parent
STATE = HERE / "apply_state.json"
HARD_DAILY_CAP = 50

# Keep in step with AUTO_DEFAULTS in index.html.
DEFAULTS = {
    "enabled": False,
    "test_mode": True,
    "grades": "AB",
    "daily_limit": 30,
    "followup_enabled": True,
    "followup_days": 3,
    "window_start": 10,
    "window_end": 16,
    "days": [0, 1, 2, 3, 4],
    "exclude_companies": [],
    "subject": "Application: {job} — {name}",
    "body": ("Hi {company} team,\n\nI'm {name}, a {role} with {years} years of experience in {stack}. "
             "I'd like to apply for {job} at {company}.\n\n{proof}\n\nMy resume is attached.\n"
             "Notice period: {notice}.\n\nThanks for your time,"),
    "proof": "",
    "followup_body": ("Hi,\n\nFollowing up on my application for {job} at {company}, sent on {sent_date}. "
                      "I'd be glad to share anything else that helps — portfolio, references or a quick "
                      "call.\n\nThanks,\n{name}"),
}

# Tokens whose whole line is dropped when they resolve to nothing, so an unset
# notice period does not leave "Notice period: ." in an email.
DROP_LINE_IF_EMPTY = ("{proof}", "{notice}")

# "5+ years", "3-5 yrs", "2 to 4 years" — the first number is the minimum asked for.
EXPERIENCE_RE = re.compile(r"(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*\d{1,2})?\s*\+?\s*(?:years|yrs|yr)\b", re.I)

# Words that say nothing about which company it is; stripped before matching an
# exclusion so "Acme Technologies Pvt Ltd" and "acme.in" both reduce to "acme".
NOISE = {"pvt", "private", "ltd", "limited", "llp", "llc", "inc", "co", "company", "corp",
         "corporation", "technologies", "technology", "tech", "solutions", "software", "services",
         "systems", "labs", "india", "infotech", "global", "group", "the", "and", "it", "consulting"}

# Free mailboxes: a shared domain says nothing about the company, so never use
# it for domain-level dedupe or exclusion.
FREE_MAIL = {"gmail.com", "yahoo.com", "yahoo.in", "outlook.com", "hotmail.com", "live.com",
             "rediffmail.com", "icloud.com", "proton.me", "protonmail.com", "zoho.com"}


def log(msg: str) -> None:
    print(msg, flush=True)


def load_state() -> dict:
    if STATE.exists():
        try:
            return json.loads(STATE.read_text(encoding="utf-8"))
        except ValueError:
            # A corrupt dedupe record must stop the run, not be treated as "nothing
            # sent yet" — that would re-email every company it lists.
            sys.exit(f"{STATE.name} is unreadable — fix or restore it before running again.")
    return {"sent": {}, "days": {}, "recent": []}


def save_state(state: dict) -> None:
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATE)


def core_tokens(text: str) -> set:
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return {w for w in words if w not in NOISE and len(w) >= 3}


def domain_of(addr: str) -> str:
    return addr.rsplit("@", 1)[-1].lower().strip() if "@" in addr else ""


def iso_to_ms(iso: str) -> int:
    return int(dt.datetime.fromisoformat(iso).timestamp() * 1000)


def ms_to_iso(ms) -> str:
    return dt.datetime.fromtimestamp(int(ms) / 1000).isoformat(timespec="seconds") if ms else ""


def is_excluded(company: str, addr: str, excluded: list) -> str:
    """Name of the exclusion this lead hits, or ""."""
    name_tokens = core_tokens(company)
    dom = domain_of(addr)
    dom_label = "" if dom in FREE_MAIL else dom.split(".")[0]
    for ex in excluded:
        ex_tokens = core_tokens(ex)
        if not ex_tokens:
            continue
        if ex_tokens <= name_tokens:          # every meaningful word of the exclusion is in the name
            return ex
        if dom_label and any(t in dom_label for t in ex_tokens if len(t) >= 4):
            return ex
    return ""


def fill(tpl: str, me: dict, company: str, job: str, sent_date: str = "", proof: str = "") -> str:
    values = {"{proof}": proof.strip(), "{notice}": me.get("notice", "")}
    lines = [ln for ln in tpl.split("\n")
             if not any(tok in ln and not values[tok] for tok in DROP_LINE_IF_EMPTY)]
    out = "\n".join(lines)
    out = (out.replace("{company}", company)
              .replace("{job}", job or "a suitable role")
              .replace("{name}", me["name"])
              .replace("{role}", me["role"])
              .replace("{years}", me["years"])
              .replace("{stack}", me["stack"])
              .replace("{employer}", me["company"])
              .replace("{sent_date}", sent_date)
              .replace("{proof}", values["{proof}"])
              .replace("{notice}", values["{notice}"]))
    # Same seam-tidying as the dashboard's tidy(): a blank token must not leave debris.
    out = re.sub(r"\(\s*\)", "", out)
    out = re.sub(r"[ \t]+([.,?!])", r"\1", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def signature(me: dict) -> str:
    lines = [me["name"]]
    for label, key in (("Phone", "phone"), ("LinkedIn", "linkedin"), ("GitHub", "github"),
                       ("Portfolio", "portfolio"), ("Resume", "resume_url")):
        if me.get(key):
            lines.append(f"{label}: {me[key]}")
    return "\n".join(lines)


def identity(profiles) -> dict:
    rows = profiles.get("profiles", profiles) if isinstance(profiles, dict) else profiles
    p = next((x for x in rows or [] if x.get("is_default")), (rows or [{}])[0])
    must = p.get("must_have") or []
    if isinstance(must, str):                 # a raw JSON column, if a list row ever ships one unparsed
        try:
            must = json.loads(must)
        except ValueError:
            must = []
    must = [x for x in must if isinstance(x, str) and x]
    return {
        "name": p.get("full_name") or p.get("name") or "",
        "role": p.get("headline") or "",
        "years": "" if p.get("years") in (None, "") else str(p.get("years")),
        "company": p.get("current_company") or "",
        "stack": ", ".join(must[:6]),
        "must": must,
        "notice": p.get("notice_period") or "",
        # 0-99 is the API's "no constraint" default; treat 99 as no ceiling.
        "exp_max": (float(p["exp_max"]) if p.get("exp_max") not in (None, "", 99) else None),
        "phone": p.get("phone") or "", "linkedin": p.get("linkedin") or "",
        "github": p.get("github") or "", "portfolio": p.get("portfolio") or "",
        "resume_url": p.get("resume_url") or "",
    }


class Mailer:
    def __init__(self, user: str, app_password: str, dry: bool):
        self.user, self.pw, self.dry = user, app_password.replace(" ", ""), dry
        self.smtp = None

    def send(self, to: str, subject: str, body: str, display: str, resume: Path | None,
             reply_to_id: str = "") -> str:
        msg = EmailMessage()
        msg["From"] = email.utils.formataddr((display, self.user))
        msg["To"] = to
        msg["Subject"] = subject
        msg["Date"] = email.utils.formatdate(localtime=True)
        msg_id = email.utils.make_msgid(domain=self.user.split("@")[-1])
        msg["Message-ID"] = msg_id
        if reply_to_id:                      # thread the follow-up under the first email
            msg["In-Reply-To"] = reply_to_id
            msg["References"] = reply_to_id
        msg.set_content(body)
        if resume:
            msg.add_attachment(resume.read_bytes(), maintype="application", subtype="pdf",
                               filename=resume.name)
        if self.dry:
            return msg_id
        if self.smtp is None:
            self.smtp = smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=60)
            self.smtp.login(self.user, self.pw)
        self.smtp.send_message(msg)
        return msg_id

    def close(self):
        if self.smtp:
            try:
                self.smtp.quit()
            except Exception:
                pass


def check_replies(user: str, app_password: str, state: dict) -> tuple:
    """Return ({company_id: 'replied'|'bounced'}, error_text)."""
    open_ = {cid: s for cid, s in state["sent"].items() if not s.get("replied") and not s.get("bounced")}
    if not open_:
        return {}, ""
    found = {}
    try:
        im = imaplib.IMAP4_SSL("imap.gmail.com", 993)
        im.login(user, app_password.replace(" ", ""))
        im.select("INBOX", readonly=True)
        for cid, s in open_.items():
            # Only mail that arrived after we wrote counts, and an answer from a
            # colleague at the same company domain counts as a reply too.
            since = dt.datetime.fromisoformat(s["at"]).strftime("%d-%b-%Y")
            dom = domain_of(s["to"])
            who = s["to"] if dom in FREE_MAIL else "@" + dom
            typ, data = im.search(None, "SINCE", since, "FROM", f'"{who}"')
            if typ == "OK" and data and data[0].split():
                found[cid] = "replied"
                continue
            # A bounce comes from the mailer daemon and quotes the dead address.
            typ, data = im.search(None, "SINCE", since, "FROM", '"mailer-daemon"', "BODY", f'"{s["to"]}"')
            if typ == "OK" and data and data[0].split():
                found[cid] = "bounced"
        im.logout()
        return found, ""
    except Exception as e:                    # replies are best effort; never block sending on them
        return found, f"reply check failed: {e}"


def restore_from_dashboard(dash: Dashboard, state: dict) -> str:
    """Merge the dashboard's apply_log into the local record. Returns an error or ""."""
    try:
        rows = dash.get("/api/apply-log")
    except Exception as e:
        return f"could not read the dashboard send log ({e}) — using the local record only"
    added = 0
    for r in rows:
        cid = r["company_id"]
        s = state["sent"].get(cid)
        if s is None:
            s = state["sent"][cid] = {"company": r["company"], "to": r["to_addr"], "job": r["job"],
                                      "subject": r["subject"], "msg_id": r["msg_id"], "at": ms_to_iso(r["sent_at"])}
            added += 1
        for col, key in (("followup_at", "followup_at"), ("replied_at", "replied"), ("bounced_at", "bounced")):
            if r.get(col) and not s.get(key):
                s[key] = ms_to_iso(r[col])
    if added:
        log(f"  restored {added} sent record(s) from the dashboard")
    return ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="print what would happen; send and write nothing")
    ap.add_argument("--preview", action="store_true",
                    help="dry run that ignores the on/off switch, send window and test mode — shows the real queue")
    args = ap.parse_args()
    if args.preview:
        args.dry_run = True

    creds = load_creds()
    dash = Dashboard.from_creds(creds)
    cfg = {**DEFAULTS, **(dash.setting("auto_apply") or {})}
    state = load_state()
    now = dt.datetime.now()
    today = now.strftime("%Y-%m-%d")
    errors = []

    def report(text: str) -> None:
        log(text)
        if args.dry_run:
            return
        status = {"last_run": now.isoformat(timespec="seconds"),
                  "last_run_text": f"{now:%d %b %H:%M} — {text}",
                  "sent_today": state["days"].get(today, 0),
                  "last_error": "; ".join(errors)[:300],
                  "recent": state["recent"][:30]}
        try:
            dash.put("/api/settings/auto_apply_status", {"value": json.dumps(status)})
        except Exception as e:
            log(f"could not write status to dashboard: {e}")
        if errors:
            dash.notify("error", "Auto-apply had a problem", "\n".join(errors)[:600], "/")

    def log_remote(action: str, body: dict) -> None:
        if args.dry_run:
            return
        try:
            dash.post("/api/apply-log", {"action": action, **body})
        except Exception as e:
            log(f"  (send log not saved to dashboard: {e})")

    if args.preview:
        cfg.update(enabled=True, test_mode=False)
    if not cfg["enabled"]:
        log("Auto-apply is off (Data -> Auto-apply in the dashboard).")
        return 0
    gmail, gpw = creds.get("GMAIL_USER", ""), creds.get("GMAIL_APP_PASSWORD", "")
    if args.preview:
        gmail, gpw = gmail or "preview@example.com", gpw or "x"
    if not gmail or not gpw:
        errors.append("GMAIL_USER / GMAIL_APP_PASSWORD missing from .push-credentials")
        report("not run")
        return 1

    resume = Path(creds.get("RESUME_PDF") or HERE / "resume.pdf")
    if not resume.is_absolute():
        resume = HERE / resume
    resume = resume if resume.exists() else None

    me = identity(dash.get("/api/profiles"))
    if not me["name"]:
        errors.append("Profile has no full name — set it in Profile first")
        report("not run")
        return 1
    if not resume and not me["resume_url"]:
        errors.append("no resume: add resume.pdf next to auto_apply.py or a resume link in Profile")
        report("not run")
        return 1

    err = restore_from_dashboard(dash, state)
    if err:
        log("  " + err)

    companies = dash.get("/api/companies")
    by_id = {c["id"]: c for c in companies}
    test = bool(cfg["test_mode"])
    mailer = Mailer(gmail, gpw, args.dry_run)

    # ---- replies & bounces ----------------------------------------------------
    if not test and not args.preview:
        found, err = check_replies(gmail, gpw, state)
        if err:
            errors.append(err)
        for cid, kind in found.items():
            s = state["sent"][cid]
            s[kind] = now.isoformat(timespec="seconds")
            c = by_id.get(cid)
            log(f"  {kind}: {s['company']} <{s['to']}>")
            state["recent"].insert(0, {"at": now.isoformat(timespec="seconds"), "company": s["company"],
                                       "to": s["to"], "kind": kind, "result": "detected"})
            log_remote("update", {"company_id": cid, f"{kind}_at": int(now.timestamp() * 1000)})
            if kind == "replied":
                if not args.dry_run:
                    dash.notify("reply", f"{s['company']} replied!",
                                f"About: {s.get('job') or s.get('subject')}\nFrom {s['to']} — check your Gmail.", "/")
                if c and c.get("stage") == "contacted" and not args.dry_run:
                    note = (c.get("stage_note") or "").rstrip()
                    note = (note + "\n" if note else "") + f"Replied (auto-detected {now:%d %b})."
                    dash.put(f"/api/progress/{quote(cid, safe='')}", {"stage": "replied", "note": note})
        if not args.dry_run:
            save_state(state)

    # ---- send window & quota --------------------------------------------------
    limit = min(int(cfg["daily_limit"] or 0), HARD_DAILY_CAP)
    used = state["days"].get(today, 0)
    if test:
        # Test mode records nothing as sent, so the same leads come round again
        # every run — a few samples in your inbox is the point, not a full day's quota.
        limit = min(limit, used + 3)
    days = cfg.get("days")
    if days is None:                          # settings saved before weekday picking existed
        days = [0, 1, 2, 3, 4, 5] if cfg.get("skip_sunday", True) else list(range(7))
    in_window = int(cfg["window_start"]) <= now.hour < int(cfg["window_end"]) and now.weekday() in days
    in_window = in_window or args.preview
    if not in_window:
        if not args.dry_run:
            save_state(state)
        report(f"outside the send window — {used}/{limit} sent today")
        return 0

    sent_now = 0
    applied_names = []

    def pace():
        if not args.dry_run:
            time.sleep(random.uniform(45, 120))

    def record(company, to, kind, result):
        state["recent"].insert(0, {"at": dt.datetime.now().isoformat(timespec="seconds"),
                                   "company": company, "to": to, "kind": kind, "result": result})
        del state["recent"][60:]

    # ---- follow-ups -----------------------------------------------------------
    followups = 0
    if cfg["followup_enabled"]:
        due_after = dt.timedelta(days=int(cfg["followup_days"]))
        for cid, s in list(state["sent"].items()):
            if used + sent_now >= limit:
                break
            if s.get("test") or s.get("followup_at") or s.get("replied") or s.get("bounced"):
                continue
            if now - dt.datetime.fromisoformat(s["at"]) < due_after:
                continue
            c = by_id.get(cid)
            if not c or c.get("stage") != "contacted":
                continue                      # you moved it yourself — leave it alone
            body = fill(cfg["followup_body"], me, s["company"], s.get("job", ""),
                        dt.datetime.fromisoformat(s["at"]).strftime("%d %b"), cfg.get("proof", ""))
            subject = "Re: " + s["subject"]
            to = gmail if test else s["to"]
            try:
                mailer.send(to, subject, body, me["name"], None, s.get("msg_id", ""))
            except Exception as e:
                errors.append(f"follow-up to {s['company']} failed: {e}")
                record(s["company"], to, "follow-up", f"failed: {e}")
                if isinstance(e, smtplib.SMTPAuthenticationError):
                    break
                continue
            s["followup_at"] = dt.datetime.now().isoformat(timespec="seconds")
            sent_now += 1
            followups += 1
            record(s["company"], to, "follow-up", "sent" + (" (dry run)" if args.dry_run else ""))
            log_remote("update", {"company_id": cid, "followup_at": iso_to_ms(s["followup_at"])})
            log(f"  follow-up -> {s['company']} <{to}>")
            if not args.dry_run:
                state["days"][today] = used + sent_now
                save_state(state)
            pace()

    # ---- new applications -----------------------------------------------------
    grades = set(cfg["grades"])
    excluded = [x for x in cfg["exclude_companies"] if x.strip()] + ([me["company"]] if me["company"] else [])
    sent_addrs = {s["to"].lower() for s in state["sent"].values()}
    sent_domains = {domain_of(s["to"]) for s in state["sent"].values()} - FREE_MAIL
    sent_names = {frozenset(core_tokens(s["company"])) for s in state["sent"].values()}
    skipped = {"excluded": 0, "already": 0, "off-stack": 0, "too senior": 0, "no mail server": 0}
    # Grading alone let a "Rust Systems Engineer" through as grade A. Nothing is
    # sent unattended unless the job title names one of the profile's must-have
    # skills; a lead with no title at all is still allowed (the grade vouches for it).
    # Generic titles ("Software Engineer", "SDE") name no stack at all, so they
    # pass; a title naming a different stack ("Backend Engineer (Rust)") does not.
    allow = me["must"] + ["software engineer", "software developer", "sde", "web developer",
                          "application developer", "product engineer", "full stack", "full-stack"]
    stack_re = (re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(k.lower()) for k in allow) + r")(?![a-z0-9])")
                if me["must"] else None)

    # Newest job first: a reply is far likelier within a day or two of posting,
    # and an old opening is often already filled. Score breaks ties.
    queue = sorted((c for c in companies
                    if c.get("grade") in grades and c.get("stage") == "none" and c.get("hr")),
                   key=lambda c: (-(c.get("posted_at") or c.get("created_at") or 0), -(c.get("score") or 0)))
    for c in queue:
        if used + sent_now >= limit:
            break
        cid, name = c["id"], c["n"]
        to = c["hr"][0].strip()
        if cid in state["sent"] or to.lower() in sent_addrs or domain_of(to) in sent_domains \
                or (core_tokens(name) and frozenset(core_tokens(name)) in sent_names):
            skipped["already"] += 1
            continue
        hit = is_excluded(name, to, excluded)
        if hit:
            skipped["excluded"] += 1
            log(f"  skip {name}: matches excluded company '{hit}'")
            continue
        job = ((c.get("job") or {}).get("t") or "").strip()
        if job and stack_re and not stack_re.search(job.lower()):
            skipped["off-stack"] += 1
            log(f"  skip {name}: title '{job}' names none of your must-have skills")
            continue
        # The relevance gate reads titles, not "5+ years" in the body — a post
        # asking for well over the profile's ceiling is not worth an unattended email.
        exp_min = c.get("experience_min")
        if exp_min is None:
            # Leads pushed before experience was sent have only the JD excerpt.
            m = EXPERIENCE_RE.search(c.get("jd_excerpt") or "")
            exp_min = float(m.group(1)) if m else None
        if me["exp_max"] is not None and exp_min is not None and float(exp_min) > me["exp_max"]:
            skipped["too senior"] += 1
            log(f"  skip {name}: asks for {c.get('experience_raw') or str(exp_min) + '+ yrs'}")
            continue
        if not mx.has_mx(domain_of(to)):
            skipped["no mail server"] += 1
            log(f"  skip {name}: {domain_of(to)} cannot receive mail")
            continue
        subject = fill(cfg["subject"], me, name, job)
        body = fill(cfg["body"], me, name, job, proof=cfg.get("proof", "")) + "\n\n" + signature(me)
        if test:
            body = f"[TEST — would go to {to}]\n\n" + body
        dest = gmail if test else to
        try:
            msg_id = mailer.send(dest, subject, body, me["name"], resume)
        except Exception as e:
            errors.append(f"send to {name} failed: {e}")
            record(name, dest, "application", f"failed: {e}")
            if isinstance(e, smtplib.SMTPAuthenticationError):
                break                         # wrong app password — every send would fail
            continue
        sent_now += 1
        applied_names.append(f"{name}" + (f" — {job}" if job else ""))
        sent_addrs.add(to.lower())
        if domain_of(to) not in FREE_MAIL:
            sent_domains.add(domain_of(to))
        sent_names.add(frozenset(core_tokens(name)))
        record(name, dest, "application" + (" (test)" if test else ""),
               "sent" + (" (dry run)" if args.dry_run else ""))
        log(f"  applied -> {name} <{dest}>" + (f"  [{job}]" if job else ""))
        if not test:
            at = dt.datetime.now().isoformat(timespec="seconds")
            state["sent"][cid] = {"company": name, "to": to, "job": job, "subject": subject,
                                  "msg_id": msg_id, "at": at}
            log_remote("add", {"company_id": cid, "company": name, "to_addr": to, "subject": subject,
                               "subject_tpl": cfg["subject"], "msg_id": msg_id, "job": job,
                               "tab": c.get("tab", ""), "grade": c.get("grade", ""),
                               "platform": c.get("platform", ""), "sent_at": iso_to_ms(at)})
            if not args.dry_run:
                note = (c.get("stage_note") or "").rstrip()
                note = (note + "\n" if note else "") + f"Auto-applied {now:%d %b} to {to}."
                try:
                    dash.put(f"/api/progress/{quote(cid, safe='')}", {"stage": "contacted", "note": note})
                except Exception as e:
                    errors.append(f"sent to {name} but could not mark Contacted: {e}")
        if not args.dry_run:
            state["days"][today] = used + sent_now
            save_state(state)
        pace()

    mailer.close()
    if not args.dry_run:
        state["days"][today] = used + sent_now
        save_state(state)
    mode = "dry run" if args.dry_run else ("test mode" if test else "live")
    waiting = len(queue) - len(applied_names)
    skips = ", ".join(f"{v} {k}" for k, v in skipped.items() if v)
    text = (f"{mode}: sent {sent_now} ({used + sent_now}/{limit} today), "
            f"{waiting} grade-{cfg['grades']} leads still waiting" + (f", skipped {skips}" if skips else ""))
    if applied_names and not args.dry_run:
        dash.notify("applied",
                    f"Applied to {len(applied_names)} compan{'y' if len(applied_names) == 1 else 'ies'}"
                    + (" (test mode — sent to you)" if test else ""),
                    "\n".join("• " + n for n in applied_names[:15])
                    + (f"\n+{followups} follow-up(s)" if followups else ""), "/")
    elif followups and not args.dry_run:
        dash.notify("applied", f"Sent {followups} follow-up(s)", "", "/")
    report(text)
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
    sys.exit(_run_reporting_crashes(main, "Auto-apply"))
