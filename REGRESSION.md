# regression.mjs — proving the clone still behaves like the original

There are two live deployments:

| Target  | URL                            | D1 database      | Secrets file             |
| ------- | ------------------------------ | ---------------- | ------------------------ |
| `main`  | `https://pilot-78c.pages.dev`  | `job-outreach`   | `.secrets-generated.txt` |
| `clone` | `https://pilot-78d.pages.dev`  | `pilot-profiles` | `.secrets-78d.txt`       |

`main` is the system in daily use. `clone` is the profile-system build, its D1
seeded from an export of `main`. This harness asks both the same questions and
compares the answers, then checks a set of invariants against each one on its
own. It logs in the same way `deploy.mjs` does — the sign-in email and the
passphrase are read out of the target's secrets file by key, and a secret value
is never printed.

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

## Credentials

Read by key from the selected target's secrets file — `.secrets-generated.txt`
for `main`, `.secrets-78d.txt` for `clone` — one `KEY=value` per line.

| Key | Required | What it is |
| --- | --- | --- |
| `SITE_EMAIL` | yes | The address to sign in with. `POST /api/login` takes `{email, password}` since migration 010, so a passphrase on its own identifies nobody and every authenticated check would skip without this. Falls back to the `JO_EMAIL` environment variable. |
| `SITE_PASSWORD` | yes | The passphrase for that address. On a deployment that has just applied 010 this is still the *bootstrap* credential: the seeded owner has an empty `pw_hash` and `SITE_PASSWORD` is accepted for that one user until a real password is set, after which this must be the real password. |
| `SECOND_EMAIL` | no | A second real account on the same deployment. Falls back to `JO_SECOND_EMAIL`. |
| `SECOND_PASSWORD` | no | Its passphrase. Falls back to `JO_SECOND_PASSWORD`. |

`deploy.mjs` reads the same two required keys, from the same file, the same way.

**An email address is not screened as a secret.** `SITE_EMAIL` and
`SECOND_EMAIL` are excluded from the values the "carries no secret" checks
screen live responses for, here and in `deploy.mjs`. The address is the owner's
own, migration 010 seeds it from profile 1's `email` column, and `index.html`
and `README.md` already publish it — screening for it would report the site's
own content as a leaked credential on every run, and a scanner that cries wolf
on a non-secret is one people learn to route around. Both passphrases are
screened for exactly as before.

### Configuring a second account

The tenancy-isolation checks need a second tenant to be about anything. To
create one, signed in as the owner (who is an admin):

1. `POST /api/users` with `{"email": "...", "name": "...", "password": "..."}`.
   Admin only, and the password floor is 12 characters. Omitting the password
   creates an account that cannot sign in — set one via
   `POST /api/user/password` if you do.
2. Sign in as that account and give it a profile of its own:
   `POST /api/profiles` with `{"name": "second tenant"}`. `owner_user_id` is
   stamped from the session and never from the body, so the profile belongs to
   whoever posted it. `copy_from` will not work here — cloning requires owning
   the source, which is the point.
3. Put the two values in the target's secrets file as `SECOND_EMAIL=` and
   `SECOND_PASSWORD=`.

For the `/similar` check to have rows to look at, that second profile also has
to be *similar*: `match_keywords`, `cities` and the experience band have to
overlap the parent's enough to clear the 0.6 threshold in
`PROFILE-CONTRACT.md`. A second profile with unrelated targeting is still
enough for every other check in the section.

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
| JSON login returns 200 with a session cookie | A 302 means the JSON branch of `/api/login` is gone. `push.py` and the browser extension read the cookie off the response and cannot follow a redirect into dashboard HTML, so both stop being able to sign in. |
| second account signs in | Only runs when `SECOND_EMAIL`/`SECOND_PASSWORD` are set, and it *fails* rather than skips when they are: the tenancy checks below would otherwise report "not configured", which would be untrue and would hide the real problem. |
| wrong password is 401 and issues no cookie | Either the passphrase check is bypassable, or a session cookie is minted before the password is verified. |
| wrong email with the correct passphrase is 401 and issues no cookie | The email half is a credential too since 010. A pass with the correct passphrase and an address that owns nothing means the handler verified the password against whatever row it found first, or against `SITE_PASSWORD` without checking *which* user asked. The bootstrap fallback makes that a live risk — `SITE_PASSWORD` really is accepted, for exactly one user, and "for exactly one user" is the clause a refactor can drop without anything else looking different. |
| a session with no `uid` claim (pre-010 shape) is refused | A cookie minted when one passphrase opened every profile still opens the API, so the upgrade did not actually close the ambient-access hole. **What this proves is narrower than it reads:** the harness cannot sign a token — `SESSION_SECRET` lives in the Cloudflare environment, not in any file it can read — so it presents an unsigned token carrying a `{exp}`-only payload. A pass means that shape gets nothing; it does not on its own separate the signature check from the `uid` check in `functions/lib/auth.js`. |
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

### The tenancy-isolation invariants

> A profile the caller does not own must not be reachable, and nothing that
> identifies its owner may reach the caller.

Migration 010 turned `?profile_id=` from a view filter into an authorisation
decision. Before it, one passphrase opened the site and any valid cookie plus
any `N` read that profile's board, stages, notes and analytics. That is the
class of bug this suite exists to catch, and it is the reason these checks probe
several endpoints rather than one: `resolveProfileId` is the single chokepoint,
so the failure that matters is a *handler* that resolves a profile without
passing a user id, and a green `/api/companies` says nothing about the other
nine.

All of these are read-only and none of them needs `--allow-writes`.

| Check | A failure means |
| --- | --- |
| `?profile_id=` for a profile the caller does not own never answers 200 | Probes every id from 1 up to three past the highest the caller's own listing returned, minus the ones they own, against `/api/companies`, `/api/analytics` and `/api/export`. 403 (someone else's) and 404 (no such profile) are both correct refusals — only a 200 is a finding, and a 200 here is the pre-010 hole, open. Needs no second account. |
| another user's profile is 403 on every profile-scoped endpoint | Aimed at a profile that provably belongs to the second account, so 403 is the *only* right answer: 404 would mean the row vanished between two reads and 200 is ambient access. Covers the same three endpoints plus `/api/profile/:id`, which goes through `assertProfileOwner` rather than `resolveProfileId` — a second door onto the same question. |
| `GET /api/profiles` lists only the caller's own profiles | Compares the two accounts' listings for a shared id. An overlap means the listing is not scoped by owner, and every row it returned carries the identity fields `rowToProfile` fills in — email, phone, linkedin, resume_url — for somebody who is not the caller. |
| `/similar` carries no identity field on any row | `PROFILE-CONTRACT.md` pins the response to `{id, similarity, shared_leads, owned}` plus `name` on an owned row. Checked on *every* row rather than only the unowned ones: a handler that started spreading the whole profile row would leak on both branches, and on a single-account deployment the owned rows are the only ones there to notice it on. |
| `/similar` returns no `name` for a profile the caller does not own | `name` is the sharpest identifier on the row — profiles are named after people — so returning it turns the one endpoint that deliberately looks across tenants into a directory any signed-in tenant can enumerate. |

**What skips without a second account, and why.** Three of the five need a real
second tenant, and they skip rather than pass: with one account every row in
`profiles` belongs to the caller, so "nothing leaked between tenants" would be
true for want of a second tenant, not because anything was proved. A check that
cannot fail is worse than no check, because it reads green.

| Check | Skips when |
| --- | --- |
| another user's profile is 403 … | `SECOND_EMAIL`/`SECOND_PASSWORD` are unset, the second account owns no profiles, or its listing could not be read. A *configured* account that fails to sign in is a failure in section 1, not a silent skip here. |
| `GET /api/profiles` lists only the caller's own | Same conditions. |
| `/similar` returns no `name` for an unowned profile | No row in the response has `owned: false` — either no second tenant exists, or their profile is not similar enough to clear the 0.6 threshold. |
| `?profile_id=` … never answers 200 | Never. The three-id lookahead past the caller's highest profile is unowned by construction, so there is always something to ask for — this one has teeth on a single-account deployment. |

Every one of them also skips with **"not present on this target"** against
`main`, along with the rest of this section.

## Current status

The counts below are from the last run before multi-tenancy landed and have
**not** been re-measured. The suite needs a live deployment, and the login
contract it exercises changed underneath these numbers — read them as the shape
of a good run, not as today's.

```
35 passed  0 failed  5 skipped        # node regression.mjs
```

Those five skips were the four clone-only checks against `main` (correctly not
present) plus progress-isolation on the clone (only one profile existed, so the
read-only form was vacuous). The tenancy-isolation checks added since will skip
too until a second account is configured, on top of those.

**The progress-isolation failure this section used to record has been closed by
the work it called for.** Migration `008-progress-per-profile.sql` rekeyed
`progress` on `(profile_id, company_id)`, `011-lead-notes.sql` moved the lead
note off the shared `companies.note` onto `progress.lead_note`, and
`functions/api/progress/[id].js` resolves a profile on both verbs. The writing
form of the check should now pass on its own. **Do not loosen it** — it is the
only thing standing between that composite key and a future refactor that
quietly drops the `profile_id` half of it.

Expect the first run against a deployment that has not applied `010-users.sql`
to fail at login rather than anywhere interesting: there is no `users` table for
`/api/login` to look an address up in, so nothing downstream gets a session.
