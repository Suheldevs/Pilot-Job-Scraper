# Profile contract — the one source of truth

Every agent building the profile system reads this. Do not invent field names.

## Why profiles

Today the candidate is hardcoded across `config.py`, `relevance.py`,
`scoring.py` and `index.html`. A profile record replaces those values so the
same pipeline can serve a different candidate — and so a change to your targets
is a settings edit, not a code edit.

**The existing hardcoded values become profile id 1, named "Mohd Suhel", flagged
`is_default = 1`.** It is the parent profile: it already owns the 292 existing
companies, and nothing about its current behaviour may change.

## Two kinds of profile data — do not merge these

| Kind | Field | Used for | Sizing rule |
|---|---|---|---|
| **Query terms** | `search_roles` | Builds actual search URLs for LinkedIn and Naukri | Few and natural (`"full stack developer"`). Each one costs requests against rate-limited sites |
| **Query terms** | `search_locations` | Same — the `location=` parameter | Few; the cities you'd actually work in |
| **Filter tokens** | `match_keywords` | Post-fetch filtering in 7 sources that return unfiltered feeds | Many and loose (`react`, `node`, `mern`) |

Merging them either makes searches useless or filtering too narrow.

## The `profiles` table

```sql
CREATE TABLE IF NOT EXISTS profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  version         INTEGER NOT NULL DEFAULT 1,
  name            TEXT NOT NULL,
  is_default      INTEGER NOT NULL DEFAULT 0,   -- exactly one row has 1
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  -- identity, used to fill message templates
  full_name       TEXT NOT NULL DEFAULT '',
  headline        TEXT NOT NULL DEFAULT '',     -- "Full-stack developer (React / Node)"
  years           REAL NOT NULL DEFAULT 0,
  current_company TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  linkedin        TEXT NOT NULL DEFAULT '',
  github          TEXT NOT NULL DEFAULT '',
  portfolio       TEXT NOT NULL DEFAULT '',
  resume_url      TEXT NOT NULL DEFAULT '',
  notice_period   TEXT NOT NULL DEFAULT '',

  -- targeting. every one of these is a JSON array of strings unless noted.
  search_roles    TEXT NOT NULL DEFAULT '[]',   -- QUERY terms
  search_locations TEXT NOT NULL DEFAULT '[]',  -- QUERY terms
  match_keywords  TEXT NOT NULL DEFAULT '[]',   -- FILTER tokens
  must_have       TEXT NOT NULL DEFAULT '[]',   -- skills that must appear
  nice_to_have    TEXT NOT NULL DEFAULT '[]',
  exclude_titles  TEXT NOT NULL DEFAULT '[]',   -- "senior", "lead", "architect"
  exclude_stacks  TEXT NOT NULL DEFAULT '[]',   -- "java", "dot net", "php"
  cities          TEXT NOT NULL DEFAULT '[]',   -- tab keys: ["blr","pune","lko","noida","rem"]
  exp_min         REAL NOT NULL DEFAULT 0,
  exp_max         REAL NOT NULL DEFAULT 99,
  remote_pref     TEXT NOT NULL DEFAULT 'any',  -- any | remote | hybrid | onsite
  employment_type TEXT NOT NULL DEFAULT 'any',  -- any | full-time | contract | internship
  min_grade       TEXT NOT NULL DEFAULT 'C'     -- quality gate, NOT the relevance gate
);
```

## Dynamic locations

`cities` is **not** fixed. A profile may name any city. Getting there needs four
coordinated changes, and this section is the spec for them — the five current
keys stay working throughout.

**1. A `cities` table replaces the hardcoded allow-list.**

```sql
CREATE TABLE IF NOT EXISTS cities (
  key        TEXT PRIMARY KEY,   -- "blr", "hyd", "chennai"
  label      TEXT NOT NULL,      -- "Bangalore", "Hyderabad"
  keywords   TEXT NOT NULL DEFAULT '[]',  -- JSON: how it appears in a job posting
  is_remote  INTEGER NOT NULL DEFAULT 0,  -- only "rem" sets this
  sort_order INTEGER NOT NULL DEFAULT 100
);
```

Seed it with today's five and their existing keyword lists out of
`locations.py::TAB_KEYWORDS`, preserving `noida`'s NCR aliases
(gurugram/gurgaon/delhi/ghaziabad/faridabad) and `rem`'s
remote/wfh/anywhere set. `is_remote = 1` for `rem` only — remote is not a city
and must keep winning over any city name that also appears in the same string.

`VALID_TABS` in `functions/lib/db.js` becomes a lookup against this table
instead of a literal array. `locations.py::classify()` reads it too, with the
current five as its offline default so a scrape never depends on the API.

**2. `SECTIONS` collapses to one uniform tier scheme.**

Today each city has its own hand-written tiers — `blr` has 3, `noida` 2, `rem`
1, and one label (*"Outside Bangalore — but real HR inbox"*) only means anything
for Bangalore. That is what blocks new cities. Replace all of it with three
tiers that mean the same thing everywhere, keyed `{city}-1/2/3`:

| Tier | Key | Means |
|---|---|---|
| 1 | `{city}-1` | Real HR inbox — email these properly |
| 2 | `{city}-2` | WhatsApp them, or a live opening right now |
| 3 | `{city}-3` | Email / LinkedIn only |

`defaultSection()` already assigns by contact quality (HR email → tier 1,
WhatsApp or a live opening → tier 2, else tier 3), so its logic is unchanged —
only the key format changes.

**3. Migrate the existing section keys.** Exact mapping, no data loss:

```
s1 -> blr-1    p1 -> pune-1    l1 -> lko-1     n1 -> noida-1   r1 -> rem-1
s2 -> blr-2    p2 -> pune-2    l2 -> lko-2     n2 -> noida-2
s3 -> blr-3    p3 -> pune-3    l3 -> lko-3
```

`s3` was *"Outside Bangalore — but real HR inbox"*, which is a tier-1 route by
contact quality. Mapping it to `blr-3` preserves where those rows currently
appear rather than silently relocating them; note it in the migration so the
choice is visible, and leave re-tiering to the user.

`SECTION_TO_TAB` in `functions/api/import.js` must keep accepting the **old**
keys as well, so an old export file still imports.

**4. The dashboard renders tabs from the profile**, not from a literal — the
city list comes from `profile.cities` joined against the `cities` table for
labels and order.

### Adding a city
Insert a `cities` row, then add its key to a profile's `cities`. Nothing else.
A city with no keywords only matches its own label, which is honest —
`classify()` should not guess aliases it was not given.

## Stamping leads

```sql
ALTER TABLE companies ADD COLUMN profile_id      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 1;
```

Every lead records which profile and which version of it judged the lead. This is
what keeps grades explainable after a profile edit: `score_reasons` already says
*why*, and `profile_version` says *under what rules*. Existing rows default to
profile 1 version 1 — the parent.

Editing a profile's targeting fields **bumps `version`**. Editing only identity
fields (phone, portfolio) does not.

## Reusing leads across similar profiles

When a new profile is created, do not re-scrape what another profile already
found. Compute similarity between two profiles as a weighted Jaccard overlap:

| Component | Weight |
|---|---|
| `match_keywords` overlap | 0.35 |
| `cities` overlap | 0.30 |
| experience-band overlap (as a fraction of the union) | 0.20 |
| `search_roles` overlap | 0.15 |

`similarity >= 0.6` counts as **similar**. For a similar profile, existing leads
are made visible to it rather than re-scraped — leads are shared, but each
profile keeps its own `progress` row so stages and notes never leak between
profiles.

Expose this as `GET /api/profile/:id/similar` returning
`[{id, name, similarity, shared_leads}]`.

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/profiles` | GET | List all, with `is_default` and lead counts |
| `/api/profiles` | POST | Create; body may include `copy_from` to clone |
| `/api/profile/:id` | GET | One profile, JSON arrays parsed to real arrays |
| `/api/profile/:id` | PUT | Update; bumps `version` if targeting changed |
| `/api/profile/:id/similar` | GET | Similar profiles + shareable lead counts |
| `/api/profile/:id/adopt` | POST | Attach leads from a similar profile to this one |

JSON in and out uses **real arrays**, never JSON strings — parse on read,
stringify on write, exactly how `hr`/`em`/`wa` are already handled in
`functions/lib/db.js`.

## Users and tenancy

Added by migration 010. Before it there was no user: one `SITE_PASSWORD` opened
the site and the session payload was `{exp}`, so any holder of a cookie could
read any profile by passing `?profile_id=`. Profiles were a view filter, not a
boundary.

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL,        -- UNIQUE on lower(email)
  name          TEXT NOT NULL DEFAULT '',
  pw_hash       TEXT NOT NULL DEFAULT '',  -- '' = no password set, never verifies
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  session_epoch INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE profiles ADD COLUMN owner_user_id INTEGER NOT NULL DEFAULT 1;
```

**One user owns many profiles.** The same person targeting two different roles is
the normal case, so this is deliberately not 1:1. Every profile that existed
before 010 belongs to user 1, the parent.

### The three rules

1. **Ownership is checked in exactly one place.** `resolveProfileId` in
   `functions/lib/profile.js` is the chokepoint every profile-scoped handler
   already routed through, so the check lives there and not in ten handlers. It
   **fails closed**: a missing `userId` is a 401, never a fallback to the old
   existence-only behaviour. `assertProfileOwner` is the same check for handlers
   that name a profile in the path rather than the query string.

2. **Identity never crosses a tenant.** `rowToProfile` carries `email`, `phone`,
   `linkedin`, `github`, `portfolio`, `resume_url` and `notice_period`. Any
   endpoint that can return a profile the caller does not own must return the id
   and nothing that identifies its owner — see `/similar`, which returns
   `{id, similarity, shared_leads, owned}` and adds `name` only when `owned`.

3. **Leads cross; what you wrote about them does not.** Adoption shares
   `companies` rows through `profile_companies` and nothing else. `progress` and
   `stage_history` stay keyed `(profile_id, company_id)` from 008, and migration
   011 moved the lead note off the shared `companies.note` onto
   `progress.lead_note` for the same reason. Sharing a lead must never mean
   sharing your note on it.

Cross-tenant adoption is intentional, not a leak: it is the whole point. A new
tenant whose targeting matches an existing one adopts their leads instead of
re-running the scrape, and re-scraping is what gets this project rate-limited by
LinkedIn and Naukri.

### Sessions

HMAC-signed and stateless — there is no session table. The payload is
`{uid, ep, exp}`, where `ep` is the user's `session_epoch` when the token was
minted. `_middleware.js` refuses a token whose `ep` is behind the row's, so
bumping `session_epoch` is a per-user "sign out everywhere" — which is what lets
a password change revoke the sessions it was prompted by. Rotating
`SESSION_SECRET` is the only other lever and it signs out everyone at once.

Tokens minted before 010 carry no `uid` and are rejected: the upgrade signs
everyone out once, deliberately, rather than honouring cookies issued when one
passphrase opened every profile.

### Known gap

There is still **no rate limiting on `/api/login`**. It belongs in a Cloudflare
rate-limiting rule on that path, not in a D1 write per attempt — that would put a
write on the unauthenticated path, which is exactly what an attacker would want
to amplify.

## Per-source scheduling

Sources currently all run on one 6-hour clock, which is wrong in both
directions — the HN thread is monthly, ATS boards change daily.

```sql
CREATE TABLE IF NOT EXISTS source_schedule (
  source        TEXT PRIMARY KEY,
  interval_mins INTEGER NOT NULL,
  last_run_at   INTEGER,
  last_status   TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1
);
```

Defaults:

| Source | Interval |
|---|---|
| `naukri_sitemap` | 360 (6h) |
| `instahyre` | 720 |
| `greenhouse`, `lever`, `ashby`, `keka` | 720 |
| `remotive`, `arbeitnow`, `remoteok`, `weworkremotely` | 1440 |
| `linkedin` | 1440 — the one that gets you rate-limited |
| `hackernews` | 10080 (weekly); the thread is monthly |

A run with `--due-only` touches only sources whose
`last_run_at + interval_mins` has passed. This is separate from the circuit
breaker in `http_cache.py`, which handles *failing* sources; this handles
*fresh enough* ones.
