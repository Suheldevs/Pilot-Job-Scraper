# pilot

A private job-outreach tracker (**Pilot**): a dashboard on Cloudflare Pages, a D1 database
behind it, and a Python scraper that pushes live openings straight into its API.
It replaces the old single-file HTML tracker that kept everything in
`localStorage` — that file is preserved as
[legacy-hey.html.bak](legacy-hey.html.bak) and is no longer used.

The whole site sits behind one passphrase. There are no accounts.

## Architecture

| Piece | Where | What it is |
|---|---|---|
| Dashboard | [index.html](index.html) | One static file, plain JS, no build step, no dependencies. Fetches everything from the API on load. |
| API | [functions/api/](functions/api) | Cloudflare Pages Functions. JSON in, JSON out. |
| Auth gate | [functions/_middleware.js](functions/_middleware.js) | Runs before everything, static assets included. HMAC-signed session cookie. |
| Database | D1 `job-outreach` | Four tables — see [schema.sql](schema.sql). |
| Scraper | `main.py` / `push.py` | Python. Collects openings from four job sources, pushes them to `/api/companies/bulk`. |

Request path: browser → `_middleware.js` (cookie check) → static file or
`functions/api/*` → D1.

D1 details:

| | |
|---|---|
| Database name | `job-outreach` |
| Database id | `e655ed5e-a357-44f2-aeb3-0441d996374b` |
| Region | APAC |
| Binding | `DB` (see [wrangler.toml](wrangler.toml)) |

Tables: `companies` (one row per company per city, ids like `blr:zethic-technologies`),
`progress` (current stage + private note, one row per company), `stage_history`
(one row per stage transition — this is what the activity chart reads), `settings`
(key/value; currently just the message template).

### Migrated data

84 companies were pulled out of the old tracker's embedded JS literals and
loaded into D1 as `source='seed'`. [migrate.mjs](migrate.mjs) did it
(`node migrate.mjs > seed-data.sql`) — one-time, kept for reference.

| City | Companies |
|---|---|
| Bangalore (`blr`) | 21 |
| Pune (`pune`) | 45 |
| Lucknow (`lko`) | 7 |
| Noida / NCR (`noida`) | 6 |
| Remote (`rem`) | 5 |
| **Total** | **84** |

Contact details, notes, LinkedIn handles and the outreach template all carried
over. Progress was not — every migrated company starts at `none`.

## The five views

Sidebar nav, one file, no routing. The current view is remembered in
`localStorage`.

| View | Shows |
|---|---|
| **Overview** | Four tiles (companies, contacted, response rate, need follow-up), the pipeline funnel by stage, a by-city bar chart, and a 60-day activity strip. |
| **Pipeline** | The working screen. City tabs (Bangalore / Pune / Lucknow / Noida–NCR / Remote), a text search over name, note and emails, and filter chips: not contacted, needs follow-up, has HR inbox, has WhatsApp, live opening. Companies are grouped into contact-quality tiers within each city. Each card gives one-click `mailto:` and `wa.me` links with the message pre-filled, a link to the live opening, a LinkedIn people link, six stage buttons, and a private note box that autosaves. |
| **Analytics** | Same numbers, read properly: reached out / replied / interviewing / offers, stage funnel, where companies came from (hand-researched vs scraped vs manual vs imported, plus a per-scraper-source breakdown), the 60-day activity strip, and a city × stage table with reply rates. |
| **Message** | Edit the outreach template, with `{company}` `{role}` `{name}` `{years}` `{stack}` tokens, a live preview, and the outreach rules kept next to it. Saved to `settings.template`, so every email and WhatsApp link on every card uses it. |
| **Data** | Import a CSV or JSON file, download a full JSON backup, and the `push.py` command line for the scraper. |

There is a sixth screen, **Add company**, reached from the `+ Add company`
button on Pipeline. Contact tier is assigned automatically: HR inbox → tier 1,
WhatsApp or a live opening → tier 2, otherwise the last tier.

"Needs follow-up" means: stage is `contacted` and it has been that way for
more than 7 days.

## Setup and deploy

Not deployed yet. These are the steps.

### 1. Credentials

Deploy credentials live in `.cf-credentials` (gitignored):

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```

Every wrangler command below assumes they are sourced:

```bash
source .cf-credentials && npx wrangler <...>
```

### 2. Apply the schema

Local first, so `wrangler pages dev` has something to read:

```bash
npx wrangler d1 execute job-outreach --local --file=schema.sql
npx wrangler d1 execute job-outreach --local --file=seed-data.sql
```

Then remote:

```bash
source .cf-credentials && npx wrangler d1 execute job-outreach --remote --file=schema.sql
source .cf-credentials && npx wrangler d1 execute job-outreach --remote --file=seed-data.sql
```

Both files are idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`), so
re-running them is safe.

### 3. Set the two secrets

Both are required. Without `SESSION_SECRET` no cookie can ever verify, so
every request bounces back to the login page.

```bash
source .cf-credentials && npx wrangler pages secret put SITE_PASSWORD
source .cf-credentials && npx wrangler pages secret put SESSION_SECRET
```

- `SITE_PASSWORD` — the passphrase you type to log in.
- `SESSION_SECRET` — a random signing key, never typed by anyone. Generate one:
  `openssl rand -hex 32`.

Changing `SESSION_SECRET` invalidates every existing session.

For local development put the same two in `.dev.vars` (gitignored):

```
SITE_PASSWORD=whatever
SESSION_SECRET=whatever-random
```

### 4. Run it

```bash
npx wrangler pages dev .                                    # local, uses .dev.vars + --local D1
source .cf-credentials && npx wrangler pages deploy .        # deploy
```

`pages_build_output_dir = "."` — the repo root *is* the site. There is no build.

### How the gate works

`functions/_middleware.js` runs on every request. No valid `session` cookie
means: HTML requests get the login page, `/api/*` requests get
`401 {"error":"unauthorized"}`. `POST /api/login` compares the submitted
password against `SITE_PASSWORD` and, on a match, sets a 30-day
`HttpOnly; Secure; SameSite=Strict` cookie holding an HMAC-SHA256-signed
`{exp}` payload. No session table, no session store — just the secret.

## Running the scraper

```bash
python -m venv venv
venv\Scripts\pip install -r requirements.txt
```

### Push straight into the dashboard (`push.py`)

```bash
python push.py --url https://<your-site>.pages.dev --password '<passphrase>'
python push.py --url http://localhost:8788 --password '<passphrase>' --sources linkedin weworkremotely
python push.py --url https://<your-site>.pages.dev --password '<passphrase>' --dry-run
```

It logs in the way the browser does, then posts to `/api/companies/bulk`.
That endpoint only ever adds — a company that already exists (hand-edited,
or from an earlier run) is left exactly as it is.

### Write a file instead (`main.py`)

```bash
venv\Scripts\python main.py                                  # all sources → scraped.json
venv\Scripts\python main.py --sources remoteok linkedin
venv\Scripts\python main.py --dry-run                        # collect + summarize, don't write
venv\Scripts\python main.py --out my-run.json
```

`main.py` still emits the old hey.html file shape. See the limitations below
before relying on it.

### Configuration

Edit [config.py](config.py): role keywords, target cities, experience band,
request pacing, pages per query. Currently tuned to a MERN / full-stack
profile, 1–3 years, Bangalore / Pune / Lucknow / Noida / Remote.

[locations.py](locations.py) maps a free-text job location onto one of the five
city tabs. Anything it cannot classify is dropped — there is deliberately no
"everything else" bucket, because the dashboard has no tab for one.

## Import and export

**Import** (Data view) takes CSV or JSON. Nothing is ever overwritten — only
new companies are added, and progress merges newest-wins. Both the current
export shape and the old hey.html `localStorage` shape are accepted, so old
backups still load.

Full column and field reference: **[IMPORT-FORMAT.md](IMPORT-FORMAT.md)**.
Working example: [sample-import.csv](sample-import.csv).

**Export** (Data view, or `GET /api/export`) downloads every company, its
stage, its notes and the message template as one JSON file. That file imports
back cleanly — it is the backup format.

## API reference

Every endpoint requires the session cookie. All request and response bodies
are JSON.

| Method | Path | Does |
|---|---|---|
| `POST` | `/api/login` | Form or JSON `{password}`. Sets the session cookie, redirects to `/`. Handled in the middleware. |
| `GET` | `/api/companies` | All companies with stage joined. `?tab=blr` filters to one city. |
| `POST` | `/api/companies` | Add one. `{name, tab}` required; `section` auto-assigned if omitted. Re-posting the same name in the same city updates only `li`, `note`, `job_url`, `job_title`. |
| `POST` | `/api/companies/bulk` | `{companies:[...]}`. Insert-only, never overwrites. Returns `{submitted, skipped}`. Statements are chunked in 80s to stay under D1's batch cap. This is what the scraper calls. |
| `PATCH` | `/api/companies/:id` | Edit `li`, `note`, `land`, `section`, `hr`, `em`, `wa`, `job_url`, `job_title`. |
| `DELETE` | `/api/companies/:id` | Removes the company, its progress and its stage history. |
| `GET` | `/api/progress/:id` | Current stage row for one company. |
| `PUT` | `/api/progress/:id` | `{stage, note}`. A `stage_history` row is written only on an actual stage change, not on a note-only edit. |
| `GET` | `/api/analytics` | Totals, response rate, and breakdowns by city, stage, source and scraper source, plus a 60-day daily timeline. |
| `GET` | `/api/export` | Full JSON backup, with a `Content-Disposition` filename. |
| `POST` | `/api/import` | Accepts the current export shape or the legacy hey.html shape. Returns `{companies_added, progress_merged}`. |
| `GET` | `/api/settings/:key` | Read one setting. |
| `PUT` | `/api/settings/:key` | `{value}` (string). Currently only `template` is used. |

Company ids are `{tab}:{slug-of-name}` — stable, and identical to the ids the
old tracker generated, which is what let progress carry across the migration.
Valid tabs: `blr` `pune` `lko` `noida` `rem`. Valid stages: `none` `contacted`
`replied` `interviewing` `offer` `rejected`.

## Scraper source status (tested, not guessed)

| Source | Method | Status |
|---|---|---|
| LinkedIn | guest `seeMoreJobPostings` endpoint — the one LinkedIn's own "load more" button calls; server-rendered HTML fragment, no login, no JS execution needed | works — best source by a distance, roughly 150 companies per run |
| We Work Remotely | public per-category RSS feeds | works well |
| RemoteOK | public JSON API | works, but the feed currently skews non-tech, so yields are thin — 1 usable hit in a test run |
| Naukri | internal search JSON API | **blocked** — `406 recaptcha required`, even with a warmed-up session. No captcha bypass was attempted. The code is left in place in case the gate lifts. |

A real run: 155 companies across Bangalore / Pune / Lucknow / Noida plus 14
remote, all with live posting URLs, in about a minute.

[sources/base.py](sources/base.py) treats 401/403/406 as "stop, don't hammer
it" rather than retrying blindly, and a source that fails never takes down the
rest of the run.

## What this does not do

**Job boards do not publish HR emails or WhatsApp numbers.** This is the
limitation that matters most. Every scraped company arrives with empty `hr`,
`em` and `wa` — the dashboard renders that fine, and the auto-assigned contact
tier drops those companies to the bottom tier, but they are not contactable
until someone looks up the company site's careers or contact page by hand. The
scraper gets you *company + live opening*. Contact enrichment is still manual,
exactly as it was for the original 84.

**LinkedIn's Terms of Service prohibit automated scraping**, regardless of
endpoint. The LinkedIn source hits public search results only, at the pace set
by `DELAY_BETWEEN_REQUESTS` in `config.py`, and is built for personal
job-search volume — not bulk collection or resale. Expect rate limiting
(HTTP 429) eventually; when it happens, back off — raise the delay, run less
often — rather than retrying harder.

**Naukri is unavailable** while the reCAPTCHA gate is up. Nothing in this repo
tries to defeat it.

**`main.py`'s output file no longer imports cleanly.** It writes the old
hey.html `{state, custom, tpl}` shape with `custom` keyed by *city*
(`custom.blr`), while `/api/import`'s legacy handler expects `custom` keyed by
*section* (`custom.s1`) — city keys are silently ignored, so nothing gets
added. Use `push.py`, or a CSV, or the current export shape. `main.py` is
still useful with `--dry-run` to see what a run would collect.

**One passphrase, no accounts.** Anyone who has it has full read and write
access, deletion included. There are no roles, no audit trail beyond
`stage_history`, and no per-user data.

**The "Sign out" link is dead.** It points at `/api/logout`, which has no
handler — the request falls through the middleware and 404s. Clearing the
`session` cookie is the only way to sign out early. Sessions otherwise expire
after 30 days.

**`PATCH` and `DELETE /api/companies/:id` have no UI.** Editing a company's
contact details or deleting one has to be done against the API directly. The
dashboard can only add.

**Locations outside the five tracked cities are dropped**, not collected into a
catch-all. If you want another city, it needs a tab in `index.html`, sections
in `SECTIONS`, keywords in `locations.py`, and a tier list in
`functions/lib/db.js`.
