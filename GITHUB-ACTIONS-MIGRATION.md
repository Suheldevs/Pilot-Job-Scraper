# Plan: Move Scraper Scheduling to GitHub Actions

## Problem

`scrape.cmd` is triggered by a Windows Task Scheduler job (`Pilot scrape`) on
one local PC, every 6h. That means the automatic scrape only happens if this
machine is on, logged in, and this folder is untouched. Cloudflare hosts the
dashboard and D1 database, but has no role in *running* the scraper — it only
receives what `push.py` POSTs to it. Nothing on Cloudflare notices or retries
if the local task never fires.

## Goal

Run the exact same `push.py` unchanged, on a schedule, on GitHub's
infrastructure — so scraping no longer depends on this PC being on. No code
changes to the scraper itself.

## Why GitHub Actions, not a Cloudflare Worker

Cloudflare Workers run JS/TS, or Python via a Pyodide-based beta that can't
use `lxml`, `beautifulsoup4`, or `dnspython` (used for MX checks) as-is. A
Cloudflare-native rewrite means porting `pipeline.py`, `scoring.py`, and the
MX-check logic — a real rewrite, not a redeploy. GitHub Actions runs the
current Python unmodified.

## Steps

### 1. Push current repo state to GitHub

Repo already exists at `git@github.com:Suheldevs/Pilot-Job-Scraper.git`.
Commit and push whatever's pending so the workflow has something to run
against. `.push-credentials` stays local-only — it's already gitignored and
nothing here changes that.

### 2. Add repo secrets

GitHub repo → Settings → Secrets and variables → Actions → New repository
secret, one per line currently in `.push-credentials`:

- `JO_URL`
- `JO_EMAIL`
- `JO_PASSWORD`
- `FIRECRAWL_API_KEY`
- `GEMINI_API_KEY`

These get injected as `env:` vars in the workflow — never written to disk or
printed in logs.

### 3. Add `.github/workflows/scrape.yml`

A scheduled workflow that:

- Triggers on `schedule:` (cron — match the current 6h cadence) and
  `workflow_dispatch:` (manual run button in the GitHub UI, for testing)
- Checks out the repo
- Sets up Python 3.13
- Runs `pip install -r requirements.txt`
- Runs the same command `scrape.cmd` runs today:
  ```
  python push.py --min-grade C --prune-days 10 --max-probes 25
  ```
  with the 5 secrets above passed as environment variables

### 4. Retire the local trigger

Once a couple of scheduled runs succeed on GitHub, **disable** (don't delete)
the Windows Task `Pilot scrape` so both don't run at once. `push.py`'s bulk
endpoint already treats existing companies as untouched
(`/api/companies/bulk` skips duplicates server-side), so an overlap during
the transition wouldn't corrupt data — just waste API calls against
Firecrawl/Gemini.

### 5. Verify

- Trigger the workflow manually once (`workflow_dispatch`) and check the
  Actions run log for the same "Logging in → collected → pushed" output seen
  in local runs.
- Confirm the D1 company count and `last_created` timestamp move, the same
  way local runs were verified.
- Let one scheduled (non-manual) run fire on its own before disabling the
  Windows task, to confirm the cron trigger itself works.

## Known constraints

- Free-tier scheduled GitHub Actions workflows can be delayed a few minutes
  under GitHub-wide load. Irrelevant at a 6h cadence.
- Public repos get unlimited Actions minutes. If this repo is or becomes
  private, minutes are metered — a ~5 min run every 6h is trivial usage
  either way.
- Logs land in the Actions tab, not `scrape.log`. Decide separately whether
  to also upload `scrape.log` as a workflow artifact for history, or treat
  the Actions log as sufficient.

## Status

Not started — this is a plan only. No workflow file, secrets, or task
changes have been made yet.

## Important notes and suggested fixes (found while diagnosing the local setup)

- **Dashboard is still on the bootstrap `SITE_PASSWORD`.** Every push run logs
  `this account is still on the bootstrap SITE_PASSWORD — set a real
  passphrase in the dashboard.` Set a real passphrase in the dashboard before
  moving `JO_PASSWORD` into a GitHub secret, so the secret being created is
  the real one, not a bootstrap value you'll have to rotate again right after.

- **`scrape.cmd` had a live parsing bug**, independent of this migration:
  unescaped `(` `)` inside the credential-check block's `echo` text (`line(s)`,
  `...become.)`) broke cmd.exe's parser with `to was unexpected at this
  time.`, aborting before `scrape.log` was even written. This has been fixed
  locally in this folder (parens escaped with `^`). GitHub Actions calls
  `push.py` directly and never touches `scrape.cmd`, so this bug doesn't
  block the migration — but commit the fix anyway so the local fallback
  path stays usable, and so `git status` doesn't show it as a stray
  uncommitted change later.

- **Credential drift across copies.** Three folders exist locally
  (`Pilot-Job-Scraper`, `pilott`, `pilot\pilot-78c`) with different
  `.push-credentials` contents — one had `GEMINI_API_KEY`, another didn't,
  one was missing `JO_EMAIL` entirely (which alone would abort every local
  run). Once GitHub Secrets become the source of truth, treat them as
  canonical and stop hand-editing `.push-credentials` copies — pull the
  values from GitHub Secrets (re-entering, since secrets aren't readable
  after creation) if a local fallback run is ever needed again.

- **The Windows Task Scheduler entry (`Pilot scrape`) was silently broken
  since 2026-09-16**, pointed at `pilott\scrape.cmd` with no working
  directory and no venv there — every run failed at "scrape start" with
  "The system cannot find the path specified." It's since been repointed to
  `Pilot-Job-Scraper` as a stopgap. Once the GitHub Actions workflow is
  confirmed working (step 5 above), disable this task rather than leaving
  a second, easy-to-forget scheduler pointed at a folder that may drift
  again.

- **`.cf-credentials` holds a live Cloudflare API token in plaintext.** It's
  gitignored correctly, but since it's been read/handled directly during
  this diagnosis, treat it as seen: avoid pasting it anywhere, and consider
  rotating the token in the Cloudflare dashboard as routine hygiene — it's
  unrelated to this migration (used by `deploy.mjs`/`wrangler`, not
  `push.py`), so rotating it won't affect the scrape secrets above.

## Notes for AI agents working on this repo

- **Don't trust `scrape.log` alone as proof a push landed.** Verify against
  the live D1 database: `npx wrangler d1 execute job-outreach --remote
  --command "SELECT COUNT(*), MAX(created_at) FROM companies;"` (needs
  `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` from `.cf-credentials`
  sourced into the environment first). The dashboard UI can show a stale,
  cached count even after a real push succeeded.
- **This repo has no local SQLite file.** All data lives in Cloudflare D1
  (`wrangler.toml` → `job-outreach`). Don't go looking for a `.db`/`.sqlite`
  file when asked to "check the db."
- **Three near-duplicate copies of this project exist on disk**
  (`Pilot-Job-Scraper`, `pilott`, `pilot\pilot-78c`). Only `Pilot-Job-Scraper`
  is the one to work in per explicit user instruction — don't assume the
  newest-by-timestamp copy is authoritative without asking, since a plain
  folder copy leaves gitignored secrets (`.push-credentials`, `.dev.vars`,
  etc.) behind and can look broken for reasons that have nothing to do with
  the code.
- **`.push-credentials` requires exactly `JO_URL`, `JO_EMAIL`,
  `JO_PASSWORD`** (see `scrape.cmd`'s own check) — an older file with only
  `JO_URL`/`JO_PASSWORD` will abort every run. `FIRECRAWL_API_KEY` and
  `GEMINI_API_KEY` are also read from the same file by the pipeline, though
  not enforced by `scrape.cmd`'s check.
- **Batch files (`.cmd`) in this repo can contain unescaped-paren bugs** that
  only surface inside `if (...)` blocks with literal `(`/`)` in echoed text.
  If a `.cmd` here fails with a cryptic `... was unexpected at this time.`
  and no log output at all, suspect this before anything else — it's a
  cmd.exe parser issue, not a credentials or environment problem.
- **Never print or persist the actual values from `.cf-credentials` or
  `.push-credentials`** in output meant to be shared or committed; redact
  key/value pairs before showing them back unless the user owns the machine
  and explicitly asked to see them.
