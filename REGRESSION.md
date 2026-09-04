# regression.mjs — proving the clone still behaves like the original

There are two live deployments:

| Target  | URL                            | D1 database      | Secrets file             |
| ------- | ------------------------------ | ---------------- | ------------------------ |
| `main`  | `https://pilot-78c.pages.dev`  | `job-outreach`   | `.secrets-generated.txt` |
| `clone` | `https://pilot-78d.pages.dev`  | `pilot-profiles` | `.secrets-78d.txt`       |

`main` is the system in daily use. `clone` is the profile-system build, its D1
seeded from an export of `main`. This harness asks both the same questions and
compares the answers, then checks a set of invariants against each one on its
own. It logs in the same way `deploy.mjs` does — the passphrase is read out of
the target's secrets file by key, and a secret value is never printed.

## How to run

```bash
node regression.mjs                          # compare both, plus invariants on each
node regression.mjs --target=main            # check one deployment in isolation
node regression.mjs --target=clone
node regression.mjs --verbose                # show the values behind passing checks too
node regression.mjs --target=clone --allow-writes   # also run the one writing check
node --check regression.mjs                  # parse-check only
```

Read-only by default: with no `--allow-writes` nothing is written to either
deployment, and the summary says so. `--allow-writes` is refused against `main`
unconditionally — the writable flag lives in the `TARGETS` table, not in a
command-line argument.

## Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | Every check passed (skips are not failures)                          |
| `1`  | At least one check failed, or an unknown `--target` was given        |
| `2`  | A deployment was unreachable — nothing was checked, so nothing is known |

`2` is deliberately distinct from `1` so this can gate a deploy: a failure means
"do not ship", an unreachable target means "the gate could not run", and the two
call for different responses.

## Parity checks — the same question asked of both

Run only when both targets are selected (the default).

| Check | A failure means |
| --- | --- |
| company count matches | The two databases have drifted. Either a write reached one and not the other, or a migration deleted rows. |
| company id sets match | Drift with names attached — the ids present on only one side are listed (capped at 20). A row created on the clone by a scrape, or a row pruned on one side only. |
| per-city / per-grade / per-platform counts match | The distribution moved even if the total did not: re-grading, re-tagging, or a `tab` rewrite. The differing keys are printed with both values. |
| `analytics.totals` match | The analytics aggregation reads differently on the two. Because the row sets are compared separately, a failure *here* while the id sets match points at the SQL in `functions/api/analytics.js`, not at the data. |
| `analytics.response_rate` matches | Progress rows differ — someone advanced a stage on one deployment only. |
| templates/settings payload matches | The `settings` table diverged; the saved outreach templates are no longer the same on both. |
| 10 sampled companies match field for field | A field-level difference in `rowToCompany()`'s output. Sampled evenly through the sorted id intersection, so it is deterministic but not clustered. |

**`profile_id` and `profile_version` are excluded from the field-level
comparison** and the exclusion is printed on every run. Those two columns exist
only on the clone and profile stamping is *expected* to differ; everything else
`rowToCompany()` returns is compared. If a field is added to the API and starts
differing, this check catches it, because the field list is the union of the keys
both sides actually returned rather than a hardcoded list.

## Invariant checks — run against each deployment independently

These must hold whatever the other deployment says.

| Check | A failure means |
| --- | --- |
| unauthenticated `GET /api/companies` is 401 | The auth wall in `functions/_middleware.js` is off. Every lead, contact email and phone number is public. Stop and fix before anything else. |
| unauthenticated `GET /` serves the login page | Same wall, HTML side. A redirect loop or a raw `index.html` here means the dashboard is served to anyone. |
| wrong password is 401 and issues no cookie | Either the passphrase check is bypassable, or a session cookie is minted before the password is verified. |
| every row has a `tab` from `blr/pune/lko/noida/rem` | A row exists that no tab in the UI will ever render — it is in the database and invisible. Usually a scraper writing an unclassified location. |
| every `grade` is empty or `A`/`B`/`C`/`D` | The grade column took a value the UI cannot style or filter on. Bad ids are listed with their actual values. |
| `hr`/`em`/`wa` are always arrays | A JSON column holds something that is not an array, and `safeArray()` in `functions/lib/db.js` silently degraded it to `[]` — meaning contacts have been lost, not just mis-shaped. |
| `GET /api/maintenance/prune?days=10` previews a number | The prune preview is broken. This is the GET, which deletes nothing; it is checked because the dashboard's "what would this remove" button depends on it, and a broken preview invites a blind POST. |
| `/.cf-credentials`, `/.dev.vars`, `/wrangler.toml`, `/push.py` carry no secret | A credential is fetchable from the live site. Every value in `.secrets-generated.txt`, `.secrets-78d.txt` and `.cf-credentials` is screened for by exact match; nothing is echoed. Treat a failure as a disclosed secret: rotate, then fix the bundle (see the staging step in `deploy.mjs`). |

## Clone-only checks

Every one of these skips with **"not present on this target"** when run against
`main`, which has no `profiles`, `profile_companies` or `source_schedule` table.

| Check | A failure means |
| --- | --- |
| exactly one profile has `is_default = 1` | Zero defaults and `profile.py` falls back to `DEFAULTS` (silently, by design) so the dashboard and the scraper can disagree about who they are working for. Two defaults and which one wins is down to row order. `PROFILE-CONTRACT.md` says exactly one. |
| default profile is named "Mohd Suhel" | The parent profile was renamed or replaced. It owns all 292 existing leads. |
| default profile `search_roles` match `config.ROLE_KEYWORDS` | The parent's targeting drifted from the values it was seeded with, so the "nothing about its current behaviour may change" guarantee no longer holds. The expected and actual arrays are both printed. |
| default profile `cities` are the five tab keys | The parent stopped covering a city, and leads in that tab are now orphaned from the profile that found them. |
| default profile band is 1–3 years | `exp_min`/`exp_max` drifted from `config.MIN/MAX_EXPERIENCE_YEARS`. These go straight into Naukri query strings. |
| `/api/schedule` lists all 12 sources | A source has no schedule row, so `--due-only` can never pick it up and it stops being scraped entirely. Missing and unexpected names are both listed. |

The expected values are **hardcoded in `regression.mjs`**, not imported from
`profile.py` or `functions/lib/*`. A test that reads its expectations out of the
thing under test cannot notice when that thing changes.

### The progress-isolation invariant

> Setting a stage under one profile must not change it under another.

`PROFILE-CONTRACT.md`: *"leads are shared, but each profile keeps its own
`progress` row so stages and notes never leak between profiles."*

- **Read-only (default).** With fewer than two profiles the invariant is vacuous
  and the check **skips**, saying so, rather than claiming to have proved
  something. With two or more real profiles it checks read-only that the
  listing responds at all to the profile selector — the strongest statement
  available without writing.
- **Writing (`--allow-writes`, clone only).** This is the definitive version. It
  creates its own throwaway company (`zz Regression Probe <timestamp>`, tab
  `rem`) and its own throwaway profile cloned from the parent, sets a stage on
  the probe company under the parent profile, reads it back under the throwaway
  profile, then deletes both. **It never touches a pre-existing row.** The line
  is labelled `WRITE` in the output.

Cleanup is *verified*, not assumed: `DELETE /api/companies/:id` answers
`{ok: true}` whether or not it matched anything, so the harness re-reads both
listings afterwards and fails loudly if the probe row or profile survived. A
leftover probe row would break every future parity run (293 vs 292).

One note on the write path: profile ids come from an `AUTOINCREMENT` column, so
each writing run consumes an id permanently. That is cosmetic — nothing depends
on profile ids being contiguous.

## Current status

As of the last run, against both live deployments:

```
35 passed  0 failed  5 skipped        # node regression.mjs
```

The five skips are the four clone-only checks against `main` (correctly not
present) plus progress-isolation on the clone (only one profile exists, so the
read-only form is vacuous).

**The writing form of progress-isolation fails today, and it is a real finding,
not a harness problem:**

```
node regression.mjs --target=clone --allow-writes
FAIL  clone: progress does not leak between profiles
      (stage set to "contacted" under profile 1; profile 3 sees HTTP 200
       stage=contacted (expected 404 or "none"))
```

`progress` is keyed on `company_id` alone — `PRIMARY KEY` in `schema.sql`, with
no `profile_id` column in any migration — and `functions/api/progress/[id].js`
ignores profile context entirely. So a stage set under one profile is visible
under every profile. That contradicts `PROFILE-CONTRACT.md` and it is what the
in-flight profile-scoping work has to close: `progress` needs a composite key of
`(profile_id, company_id)`, and the progress endpoints need to resolve a profile.
Until then this check is expected to fail under `--allow-writes`, and it will
turn green on its own once the scoping lands. **Do not loosen it.**
