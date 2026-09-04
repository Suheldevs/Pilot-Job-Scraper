-- Per-profile stages and notes.
--
-- THE BUG THIS FIXES
--   `progress` was keyed by `company_id` alone. Migration 006 then made a
--   single company row visible to several profiles at once (`profile_companies`,
--   written by POST /api/profile/:id/adopt) — so two profiles sharing a lead
--   shared one stage and one note. Profile B marking a company "contacted"
--   silently changed it for profile A. PROFILE-CONTRACT.md is explicit that
--   "leads are shared, but each profile keeps its own `progress` row so stages
--   and notes never leak between profiles"; this migration makes that true.
--
--   `stage_history` had the same leak — it is the source of the analytics
--   timeline and was also per-company only.
--
-- WHY A TABLE REBUILD FOR `progress`
--   The fix is a new primary key, `(profile_id, company_id)`. SQLite cannot
--   ALTER a primary key, so the standard four-step dance is the only route:
--   create the replacement, copy every row, drop the original, rename.
--
-- WHY *NOT* A REBUILD FOR `stage_history`
--   Its primary key does not change — it stays `id INTEGER PRIMARY KEY
--   AUTOINCREMENT` and only gains a `profile_id` column. A plain
--   `ALTER TABLE ... ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1` stamps
--   every existing row with 1 in one statement, cannot lose a row, and keeps
--   the AUTOINCREMENT counter in `sqlite_sequence` intact (a rebuild would
--   silently reset it and start handing out ids that already existed). Doing
--   the safe thing here is not a shortcut, it is the correct thing.
--
-- ATOMICITY — no explicit statement-level grouping here, deliberately
--   Two independent reasons, both verified against this project's wrangler
--   (4.129.0) and its local D1:
--     1. workerd rejects the SQL keywords outright, answering with "please use
--        the state.storage.transaction() ... APIs instead".
--     2. wrangler's own --file loader refuses a file that carries them, and
--        does not need one: it already runs the whole file as a single atomic
--        unit. Verified directly — a three-statement file whose last statement
--        fails leaves the table its first statement created rolled back.
--
--   Belt and braces anyway, because that guarantee is the tool's and not
--   SQLite's: the statements are ordered so that any partial failure leaves a
--   *working* table rather than none. `progress` is finished completely before
--   `stage_history` is touched, and inside each block the only unrecoverable
--   window is between the DROP and the RENAME — two adjacent, cheap DDL
--   statements. If the process died in exactly that gap, `progress_new` still
--   holds every migrated row and `ALTER TABLE progress_new RENAME TO progress;`
--   finishes the job by hand.
--
-- RE-RUN SAFETY
--   This migration is NOT idempotent and a blind second run would be
--   destructive: it would copy the already-migrated table into a fresh
--   `progress_new` collapsing every profile's rows onto profile 1, then drop
--   the real table. So it refuses instead. `m008_guard` has a
--   CHECK (already_migrated = 0) and is fed the number of `profile_id` columns
--   already on `progress`/`stage_history`; on a database that has run this
--   once, the INSERT violates the CHECK and the whole file aborts before
--   anything is dropped. The guard is dropped again on success, so it recomputes
--   from the live schema every time rather than trusting bookkeeping.
--
-- SCOPE
--   Column set is otherwise unchanged (`stage`, `note`, `updated_at`), and the
--   `companies(id) ON DELETE CASCADE` foreign key is carried across verbatim.
--   No foreign key to `profiles` is added: `profile_companies` in 006 has none
--   either, and the API handlers validate the profile instead.

-- ---------------------------------------------------------------------------
-- 0. Refuse a second run, before anything destructive happens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS m008_guard (
  already_migrated INTEGER NOT NULL CHECK (already_migrated = 0)
);
DELETE FROM m008_guard;
INSERT INTO m008_guard (already_migrated)
SELECT (SELECT COUNT(*) FROM pragma_table_info('progress')      WHERE name = 'profile_id')
     + (SELECT COUNT(*) FROM pragma_table_info('stage_history') WHERE name = 'profile_id');

-- ---------------------------------------------------------------------------
-- 1. progress: rebuild on the composite primary key.
-- ---------------------------------------------------------------------------
CREATE TABLE progress_new (
  profile_id  INTEGER NOT NULL DEFAULT 1,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL DEFAULT 'none',  -- none|contacted|replied|interviewing|offer|rejected
  note        TEXT DEFAULT '',
  updated_at  INTEGER,
  PRIMARY KEY (profile_id, company_id)
);

-- Every existing row belongs to profile 1: PROFILE-CONTRACT.md says profile 1
-- is the parent and already owns the current data, and `companies.profile_id`
-- defaults to 1 for exactly the same reason. Columns are listed explicitly on
-- both sides so the copy cannot be reordered by a later schema edit.
INSERT INTO progress_new (profile_id, company_id, stage, note, updated_at)
SELECT 1, company_id, stage, note, updated_at FROM progress;

DROP TABLE progress;
ALTER TABLE progress_new RENAME TO progress;

-- The composite key indexes profile-first lookups (every list and analytics
-- query). The reverse direction needs its own index: deleting a company has to
-- clear that company's row for *every* profile.
CREATE INDEX IF NOT EXISTS idx_progress_company ON progress(company_id);

-- ---------------------------------------------------------------------------
-- 2. stage_history: additive, existing rows stamped 1.
-- ---------------------------------------------------------------------------
ALTER TABLE stage_history ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1;

-- The analytics timeline reads "this profile's transitions since a date", so
-- profile_id leads and `at` follows.
CREATE INDEX IF NOT EXISTS idx_history_profile_at ON stage_history(profile_id, at);
CREATE INDEX IF NOT EXISTS idx_history_profile_company ON stage_history(profile_id, company_id);

-- ---------------------------------------------------------------------------
-- 3. Clear the guard so the check is recomputed from the schema next time.
-- ---------------------------------------------------------------------------
DROP TABLE m008_guard;
