# Pilot — project documentation

A private job-outreach system: a scraper that reads tens of thousands of job
URLs and hands back the few dozen worth writing to, plus a dashboard that
remembers who you already wrote to.

Live at `https://pilot-78c.pages.dev` behind a passphrase. The passphrase and
all API keys live in gitignored local files, never in this repository.

**Contents**

1. [What it is and why](#1-what-it-is-and-why)
2. [How it helps in job hunting](#2-how-it-helps-in-job-hunting)
3. [Tech stack](#3-tech-stack)
4. [Layers and tools used in scraping](#4-layers-and-tools-used-in-scraping)
5. [How it works end to end](#5-how-it-works-end-to-end)
6. [How to deploy](#6-how-to-deploy)
7. [Running the scraper](#7-running-the-scraper)
8. [The dashboard](#8-the-dashboard)
9. [Data model](#9-data-model)
10. [Honest limits](#10-honest-limits)

---

## 1. What it is and why

The bottleneck in a job hunt is not finding job posts — boards produce an
unlimited supply. What runs short is **companies you can actually reach**: a
real HR inbox rather than an Apply button, an opening that is genuinely still
open, at a level a two-year developer can hold, in a city you'd work in.

And once you have written to fifty of them, the second problem arrives:
remembering who you contacted, who replied, and who is due a follow-up.

Pilot does both halves — acquisition and memory.

Current state in production:

| | Count |
|---|---|
| Companies tracked | 292 |
| Researched by hand (the original seed set) | 84 |
| Added by the scraper | 208 |
| Graded A (apply now) | 30 |
| With a usable contact route | 82 |

---

## 2. How it helps in job hunting

**It reduces.** One Naukri sitemap file holds 25,000 fresh job URLs. Because the
URL slug carries the title, company, city *and* experience band, it filters down
without opening a single page:

```
25,000  URLs in the file
22,621  slug parsed successfully
   391  role matches the stack
   116  experience band overlaps 1–3 years
    78  in a tracked city          <- what you actually look at
```

A full run across every source went **146 discovered → 89 relevant → 60 pushed**.

**It ranks.** Every lead gets a grade A–D with the reasoning attached, so you
work the list top-down instead of chronologically:

```
+18  on the company's own Greenhouse board
+14  direct hiring contact (careers@company.com)
+10  posted 2 days ago
+12  stack overlap: react, next, node, express
+12  "2-4 years" overlaps the 1-3 target band
```

**It finds the contact.** Job boards don't publish recruiter emails, but plenty
of *posts* contain one. The extractor pulls emails, phones and links out of the
description and an MX lookup discards domains that can't receive mail. Of 110
leads from one Hacker News hiring thread, **32 carried a real email address**.

**It remembers.** Six stages per company, private notes, a follow-up flag after
7 days, and reply-rate analytics by city and by grade — so you can tell whether
the outreach is working, not just that it happened.

**It forgets on purpose.** A scraped lead you never applied to is dropped after
10 days. By then it is usually filled, and leaving it there buries the fresh
ones. Anything you acted on is kept permanently, and the 84 hand-researched
companies are never evicted.

---

## 3. Tech stack

| Part | Built with | Size |
|---|---|---|
| Dashboard | One HTML file — vanilla JS, no build step, no framework. Inter via Google Fonts, hand-rolled SVG/CSS charts | 1,679 lines |
| API | Cloudflare Pages Functions (JavaScript on the Workers runtime) | 1,264 lines / 16 files |
| Database | Cloudflare D1 — SQLite at the edge, APAC region | 4 tables |
| Auth | Passphrase → HMAC-signed session cookie (Web Crypto), gating **every** route including static assets | — |
| Scraper | Python 3.13 | 4,879 lines / 30 files |
| Browser extension | Chrome MV3, no build step | 882 lines |
| Schedule | Windows Task Scheduler, every 6 hours | — |
| Deploy | Node 22 + Wrangler, driven by `deploy.mjs` | — |

Python dependencies (`requirements.txt`):

```
httpx>=0.27           async-capable HTTP client, connection reuse
beautifulsoup4>=4.12  HTML parsing
lxml>=5.0             fast parser backend for BeautifulSoup
feedparser>=6.0       RSS feeds
dnspython>=2.6        MX record lookups for email validation
```

Cloudflare is free-tier throughout: Pages, Functions and D1. The only paid
component is Firecrawl, and it is optional — the layer disables itself cleanly
when no key is present.

**Why the scraper is not on Workers:** it needs real socket-level HTTP with
retries and deliberate pacing across minutes. Workers has no raw sockets, tight
CPU limits, and no `lxml`. So the dashboard is serverless and the scraper runs
on a machine.

---

## 4. Layers and tools used in scraping

Scraping is split into five layers. Each is independently guarded — a failure in
one degrades the output instead of losing the run.

### Layer 1 — Discovery

Finds companies you didn't know existed. All keyless.

| Source | Technique | Tool | Notes |
|---|---|---|---|
| Naukri | `sitemap.xml` → gzipped child sitemaps | `httpx` + `gzip` + regex | 25,000 URLs per file. Metadata comes from the URL slug, so no page is ever fetched |
| Hacker News | Algolia public API, two calls | `httpx` | "Ask HN: Who is hiring?" — recruiters are barred, so posters are employers |
| Instahyre | `api/v1/job_search` JSON | `httpx` | India-focused. Each record's `keywords` array gives the stack directly |
| Remotive | REST | `httpx` | Remote roles |
| Arbeitnow | REST | `httpx` | Remote roles |
| RemoteOK | JSON API | `httpx` | Currently thin — the feed skews non-tech |
| We Work Remotely | RSS, two categories | `feedparser` | Full descriptions inline |
| LinkedIn | `jobs-guest/.../seeMoreJobPostings` HTML fragment | `httpx` + `BeautifulSoup` | The endpoint LinkedIn's own "load more" calls. Server-rendered, no login, no JS |

### Layer 2 — ATS boards

The company's own hiring system. If a job is here it is verifiably real and
open — the strongest signal in the whole system.

| Platform | Endpoint | Tool |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | `httpx` + `html.unescape` |
| Lever | `api.lever.co/v0/postings/{slug}?mode=json` | `httpx` |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}` | `httpx` |
| Keka | `{tenant}.keka.com/careers/api/jobs/default/active` | `httpx` + `BeautifulSoup` |

**Keka matters most here** — it is what Indian SMEs actually use, and its
`robots.txt` is `Disallow: /` **plus `Allow: /careers`**, so this path is
explicitly permitted.

**Auto-promotion:** layer 1 feeds layer 2. Every company name discovered gets
slug candidates generated and probed against all four platforms, so a lead found
on an aggregator is upgraded to its authoritative listing. Probing three Indian
company names resolved three live Keka boards.

### Layer 2b — Firecrawl (optional, paid)

The fallback for careers pages no API covers: a company with a JS-rendered
careers page, not on any ATS, with no feed.

- Endpoint: `api.firecrawl.dev/v2/scrape` with a **JSON schema** for structured
  extraction, not markdown parsing.
- Configured by name in `firecrawl.config.json`, never turned loose on a crawl.
- Why structured extraction: a line-based markdown parser was tried first and
  read award badges ("Most Reviewed App Developers") and employee testimonials
  as job openings, because every one of those lines contains the word
  "developer". Asking for a schema means a page with no openings correctly
  returns none instead of five invented ones.

### Layer 3 — Relevance

A hard yes/no gate, and the thing that makes running every source affordable.
Pure Python, no dependency.

Four tests, cheapest first: role/stack match → seniority → discipline →
city. All matching is **word-boundary**, not substring, because `"react"` as a
bare substring matches "Associate Director Reactivations Outbound".

Real rejection counts from one Naukri run:

```
filtered out: java (21) · senior-level (16) · .NET (8) · python developer (3)
layer 3 — relevance: 89 of 146 jobs are actually ours
```

### Layer 4 — Enrichment

Turns description text into a contact route.

| Step | Tool |
|---|---|
| Extract emails / phones / links | `re` — deterministic, no AI |
| Classify HR vs general inbox | local-part keywords (`hr`, `careers`, `jobs`, `recruit`, `talent`…) |
| Drop noise addresses | `example.com`, `sentry.io`, image filenames like `logo@2x.png` |
| Verify deliverability | `dnspython` MX lookup |
| Detect Indian mobiles → WhatsApp | digit-length rules |

The MX check is the difference from pattern guessing. Guessing
`jobs@{company}.com` produces addresses that look right and bounce; an MX lookup
rejects a domain that cannot receive mail. It **fails open** on DNS timeouts —
"unknown" keeps the address rather than silently deleting a good one.

### Layer 5 — Scoring

Genuinity × fit → a 0–100 score, an A–D grade, and a list of every adjustment.
Pure Python.

| Signal | Effect |
|---|---|
| On the company's own ATS board | **+18** — strongest single signal |
| Employer posted it directly (HN) | +16 |
| Direct HR email present | +14 |
| Corroborated on a second platform | +6 |
| Posted <7 days | +10 · >30 days **−20** · >60 **−35** |
| Stack overlap with React/Node/Next/Mongo | +3 each, capped at +12 |
| Experience band overlaps 1–3 years | +12 |
| Senior / lead / architect title | **−22** |
| Staffing-agency name pattern | **−30** — not the real employer |
| Title centred on a stack we don't have | −25 in title, −8 in body only |

Grades: **A ≥75** · **B 55–74** · **C 35–54** · **D <35**.

### Shared infrastructure

All of it lives in `sources/base.py` and `http_cache.py`, so every source
inherits it:

- **Retries with exponential backoff**, and `Retry-After` honoured when sent.
- **Non-retryable statuses** — 401/403/406 fail fast instead of hammering a site
  that is already refusing.
- **Conditional requests** — stored `Last-Modified`/`ETag` per URL. Re-polling
  the Naukri sitemap returns **304 and zero bytes** instead of 637 KB.
- **Circuit breaker** — four failures opens the circuit for 30 minutes, and the
  state persists to `.http-state.json` between runs, so a blocked source stays
  skipped rather than being retried from scratch every 6 hours.
- **Forced UTF-8 JSON decoding** — several of these APIs omit a charset.
- **Mojibake repair** in the `Job` model — RemoteOK serves already
  double-encoded text ("Can't" arriving as `Canâ€™t`), which no decoder choice
  can fix.

### The browser extension

The one path to contacts that server-side scraping cannot reach. A Chrome MV3
extension injects into a job board **you are already signed in to**
(LinkedIn, Naukri, Wellfound, Internshala, Indeed), reads the text already
rendered on screen, extracts contacts and posts them to the API.

It works where scraping fails because it is your own session, your own browser,
triggered by your click, reading only visible content. Auto-scroll uses
randomised 700–1600 ms pauses and stops after three stable page heights.

---

## 5. How it works end to end

```
      every 6 hours (Task Scheduler)
                 |
                 v
   +-------------------------------+
   |  layer 1  discovery           |  8 sources, keyless
   |  layer 2  ATS boards          |  4 platforms + auto-promotion
   |  layer 3  relevance gate      |  role / level / city
   |  layer 4  enrichment          |  contacts + MX validation
   |  layer 5  scoring             |  the two tags
   +-------------------------------+
                 |
        dedupe -> quality gate (min grade C)
                 |
                 v
        POST /api/companies/bulk
                 |
                 v
   Cloudflare D1  <-->  Pages Functions  <-->  dashboard
                 ^
                 |
        POST /api/events   (run log)
```

**Deduplication** happens on canonical company name — legal-entity suffixes are
stripped, so "Zethic Technologies", "Zethic Technologies Pvt Ltd" and "Zethic
Technologies Private Limited" collapse to one row. Descriptive words are
deliberately *kept*: "Acme Labs" and "Acme Systems" stay separate, because
over-merging silently hides a lead, which is worse than a duplicate.

Identity is `(city, canonical name)` — the same company in two cities is two
rows, because those are two offices.

**Fault isolation** at three levels: each source catches its own errors; the
circuit breaker skips a repeatedly-failing source; and each *layer* is wrapped so
a bug in relevance, enrichment or scoring degrades the output rather than losing
the run. Relevance fails *open* — keeping everything — because a lead you have
to skim past beats a lead you never saw.

---

## 6. How to deploy

Double-click **`deploy.cmd`**, or run it from a terminal.

```bash
deploy.cmd                 # build, check, deploy, verify
deploy.cmd --dry-run       # everything except the upload
deploy.cmd --migrate       # also apply pending SQL migrations
```

Seven stages, and it **aborts before uploading** if anything is wrong:

1. **Credentials** — reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
   from `.cf-credentials` (gitignored).
2. **Preflight** — parse-checks all 14 function files and the dashboard's inline
   script. A syntax error would take the whole site down, so it must never reach
   upload.
3. **Staging** — copies only the 20 files that belong on the web into a temp
   directory. The project folder is never deployed directly.
4. **Secret scan** — screens the bundle for credentials both by exact value and
   by shape; aborts on a hit.
5. **Migrations** — applies pending SQL, treating already-applied ones as fine
   rather than fatal (SQLite has no `ADD COLUMN IF NOT EXISTS`).
6. **Deploy** — `wrangler pages deploy`.
7. **Verify** — logs in against the live site and checks 12 things: the auth gate
   refuses anonymous API calls, data reads back, both tags are present, and no
   secret is fetchable.

**Why staging exists:** a plain `wrangler pages deploy .` once uploaded 1,558
files because it swept up the Python virtualenv — and it would have published
`.cf-credentials` as a fetchable asset. The staged bundle is 20 files. The secret
scan was verified by planting a real API key in a doc and confirming the deploy
aborted.

### First-time setup

```bash
python -m venv venv
venv\Scripts\pip install -r requirements.txt

# Cloudflare token needs exactly two permissions:
#   Account -> D1 -> Edit
#   Account -> Cloudflare Pages -> Edit
# Save it, plus the account id, to .cf-credentials

source .cf-credentials
npx wrangler d1 create job-outreach
npx wrangler d1 execute job-outreach --remote --file=schema.sql

npx wrangler pages secret put SITE_PASSWORD   --project-name pilot
npx wrangler pages secret put SESSION_SECRET  --project-name pilot

deploy.cmd --migrate
```

`SITE_PASSWORD` is what you type to log in. `SESSION_SECRET` is a random signing
key nobody types — changing it invalidates every existing session.

### Credential files (all gitignored)

| File | Holds |
|---|---|
| `.cf-credentials` | Cloudflare API token + account id |
| `.push-credentials` | dashboard URL, passphrase, `FIRECRAWL_API_KEY` — used by the scheduled run |
| `.secrets-generated.txt` | the generated passphrase and session secret |
| `.dev.vars` | the same two secrets for `wrangler pages dev` |
| `.http-state.json` | conditional-request validators + circuit-breaker state |

---

## 7. Running the scraper

```bash
# what the 6-hourly task runs
python push.py --min-grade C --prune-days 10 --max-probes 25

# collect and print, push nothing
python push.py --dry-run

# a subset of sources
python push.py --sources keka hackernews naukri_sitemap

# watch specific companies' own boards
python push.py --ats keka:cloudesign lever:matchgroup greenhouse:stripe

# only leads you can actually reach
python push.py --require-contact --min-grade B
```

| Flag | Default | What it does |
|---|---|---|
| `--min-grade` | `C` | Quality gate. Relevance already dropped anything off-target, so this only trims the D tail |
| `--require-contact` | off | Only push leads with an email or phone |
| `--prune-days` | `0` | Evict scraped leads older than N days that were never applied to |
| `--no-probe` | off | Skip ATS slug probing |
| `--max-probes` | `40` | Cap on probe requests, split between the ATS families |
| `--dry-run` | off | Collect and print without pushing |

The schedule is a Windows task named **"Pilot scrape"** running `scrape.cmd`
every 6 hours, logging to `scrape.log`. It runs Python with `-u` so the log shows
progress live rather than staying empty until the run ends.

```bash
schtasks /Query /TN "Pilot scrape" /FO LIST    # check it
schtasks /Run   /TN "Pilot scrape"             # run it now
```

---

## 8. The dashboard

Six views:

| View | What it shows |
|---|---|
| **Overview** | Stat tiles, pipeline funnel, leads by city, 60-day activity |
| **Pipeline** | The tracker. City tabs, filters, sort by best-lead-first, one card per company with HR/WhatsApp/email/LinkedIn buttons, six stage buttons, private notes |
| **Analytics** | Stage funnel, reply rate **by grade** (the honest test of the scoring), source breakdown, city × stage table |
| **Message** | Three templates — email (subject + body), WhatsApp, LinkedIn — with live character counts against real limits |
| **Events** | Per-source and per-layer outcomes for every run, failures surfaced first |
| **Data** | CSV/JSON import with a sample file, JSON export, stale-lead pruning |

**Per-channel templates matter.** A WhatsApp message read on a phone should not
be email-length, and LinkedIn connection notes cap near 300 characters. Each
card's buttons pull from the right template; LinkedIn has no URL parameter for a
note, so that one is offered as a copy button.

**Both tags on every card.** The grade chip carries its letter, label and score,
with the full scoring rationale on hover. The platform chip is emphasised when
the lead came from a company's own board. Nothing depends on colour alone.

---

## 9. Data model

Four D1 tables.

**`companies`** — one row per company per city. Identity, contacts (`hr`, `em`,
`wa` as JSON arrays), the two tags (`platform`, `grade`, `score`,
`score_reasons`), and optional per-job detail: salary range, experience range,
employment type, remote type, department, apply URL, company size. Numeric
columns are nullable on purpose — "no salary given" must not read as `0`.

`raw_data` holds the untouched source payload as JSON, capped at 8 KB, so a
parsing bug can be fixed and the data re-derived **without re-scraping**.

**`progress`** — stage, note and timestamp per company. Separate from
`companies` because a re-scrape must never touch it.

**`stage_history`** — one row per stage transition. Powers the activity timeline.

**`events`** — the run log: `run_id`, `kind`, `name`, `status`, `counts`,
`duration_ms`. A run that dies before logging `run_end` shows a null end time,
which is exactly the failure the table exists to surface.

**`settings`** — the message templates.

### API

| Route | Method | Purpose |
|---|---|---|
| `/api/login` | POST | Passphrase → session cookie |
| `/api/companies` | GET, POST | List / add one |
| `/api/companies/bulk` | POST | Scraper push |
| `/api/companies/:id` | PATCH, DELETE | Edit / remove |
| `/api/progress/:id` | GET, PUT | Stage + note |
| `/api/analytics` | GET | All aggregates |
| `/api/templates` | GET, PUT | Per-channel messages |
| `/api/events` | GET, POST, DELETE | Run log |
| `/api/maintenance/prune` | GET, POST | Preview / run stale-lead eviction |
| `/api/import`, `/api/export` | POST, GET | File in / backup out |

Every `/api/*` route is gated by `functions/_middleware.js`, which also gates
static assets — an unauthenticated request to any path gets the login page.

---

## 10. Honest limits

- **It does not apply for you.** No auto-submit, no form filling. It finds and
  tracks; you write and send.
- **Most scraped leads arrive with no contact.** Job boards don't publish
  recruiter addresses. Enrichment only finds one when the post's author put it in
  the text.
- **Naukri leads have no job description**, so they cap at grade C. Their JD
  pages are client-rendered and the detail API is reCAPTCHA-gated. Slug metadata
  is all there is — no captcha bypass was attempted.
- **LinkedIn will rate-limit you**, and its Terms prohibit automated scraping.
  The circuit breaker backs off rather than pushing through.
- **RemoteOK is currently thin** — its public feed skews non-tech, yielding about
  one relevant role per run.
- **The Chrome extension is untested in a browser.** Its parser passes 48
  assertions, but whether Chrome attaches the `SameSite=Strict` session cookie
  from an extension origin is unverified. It has a three-layer fallback ending in
  posting through an open dashboard tab.
- **SmartRecruiters was deliberately not built.** It has a good documented API,
  but `api.smartrecruiters.com/robots.txt` disallows generic crawlers with a
  LinkedInBot carve-out. That is a judgement call worth making knowingly.
- **The dashboard is one passphrase deep.** It holds real contact details for
  nearly 300 companies plus personal details. Treat the link as sensitive.

---

## File map

```
index.html                 the dashboard (one file, no build)
deploy.cmd / deploy.mjs    one-command deploy with preflight + secret scan
scrape.cmd                 what the 6-hourly task runs
push.py                    scraper CLI -> API
pipeline.py                the five layers, orchestrated
main.py                    older path: scraper -> JSON file

models.py                  Job dataclass, canonical naming, mojibake repair
relevance.py               layer 3 gate
extract.py                 layer 4 contact extraction
mx.py                      MX validation
scoring.py                 layer 5, the two tags
locations.py               free-text location -> city tab
http_cache.py              conditional requests + circuit breaker
events.py                  run-log recorder
config.py                  role keywords, cities, experience band

sources/base.py            retries, backoff, 304s, breaker, UTF-8 JSON
sources/*.py               one file per source
sources/ats_probe.py       company name -> Greenhouse/Lever/Ashby slug

functions/_middleware.js   passphrase gate over every route
functions/api/**           the API
functions/lib/**           auth, db helpers, canonical slugs

schema.sql                 fresh-install schema
migrations/*.sql           additive changes to a live database
firecrawl.config.json      which careers pages Firecrawl watches
extension/                 Chrome MV3 contact grabber
IMPORT-FORMAT.md           CSV/JSON import reference
legacy-hey.html.bak        the original single-file tracker, preserved
```
