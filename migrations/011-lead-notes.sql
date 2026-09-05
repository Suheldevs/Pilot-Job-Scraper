-- Per-profile lead notes.
--
-- WHAT THIS FIXES
--   `companies.note` is a human-editable column on the SHARED company row, and
--   `PATCH /api/companies/:id` has always let any caller write it. That was
--   harmless while a company row belonged to exactly one board. Since 006 gave
--   us `profile_companies` and 008 made a single lead visible to several
--   profiles at once, it is a leak: profile A typing "spoke to Priya, reapply
--   in March" into a lead's note publishes that sentence to every other profile
--   that adopted the same company.
--
--   008 fixed the same class of bug for stages and for `progress.note` (now
--   exposed as `stage_note`) by keying `progress` on (profile_id, company_id).
--   `companies.note` was simply left behind — it is a second, older note field
--   that nobody re-homed. PROFILE-CONTRACT.md promises "stages and notes never
--   leak between profiles"; this migration finishes making that true.
--
--   The two notes are kept distinct on purpose rather than merged into one.
--   `stage_note` is about the conversation ("waiting on their reply"), the lead
--   note is about the lead itself ("careers page lists 3 backend roles") — the
--   dashboard has always shown them in different places, and collapsing them
--   here would silently destroy one of the two texts for every company that has
--   both. So `progress` grows a second column.
--
-- WHY *NOT* A TABLE REBUILD
--   Same reasoning 008 gave for `stage_history`: the primary key does not
--   change. `progress` keeps the composite (profile_id, company_id) key 008
--   built for it and only gains a column, so a plain
--   `ALTER TABLE progress ADD COLUMN lead_note TEXT NOT NULL DEFAULT ''`
--   stamps every existing row with '' in one statement and cannot lose a row.
--   SQLite accepts NOT NULL on an added column precisely because the default is
--   a non-NULL literal.
--
--   A rebuild would be strictly worse here, not merely slower: it would have to
--   reconstruct the composite key and `idx_progress_company` by hand, and a
--   copy that got the key wrong is exactly how 008's own re-run hazard
--   collapses every profile's rows onto one. Doing the additive thing is not a
--   shortcut, it is the correct thing.
--
-- WHY `companies.note` IS NOT DROPPED
--   It stops being read and stops being written — PATCH /api/companies/:id no
--   longer lists it as editable and `rowToCompany` now surfaces
--   `progress.lead_note` instead — but the column stays, write-dead, for two
--   reasons:
--     1. Every export file this project has ever produced carries `note`, and
--        `functions/api/import.js` still inserts it into `companies`. Dropping
--        the column turns every old backup into an import that errors out.
--        IMPORT-FORMAT.md is a documented on-disk contract; it does not get to
--        break in the same migration that changes the storage underneath it.
--     2. There is no way back. If the backfill below picked the wrong owning
--        profile for some row, the original text is still sitting in
--        `companies.note` and can be re-read; after a DROP COLUMN it is gone,
--        and D1 has no undo.
--   A later migration can drop it once a real database has been eyeballed and
--   the backfill confirmed. That migration is cheap; this one is not reversible.
--
-- BACKFILL
--   Every note that exists today was typed by the profile that owns the company
--   row — `companies.profile_id`, stamped by 006 and defaulting to 1 — because
--   until now that was the only board the lead could appear on. So each
--   non-empty note moves into that one profile's progress row and nowhere else.
--   Adopters get '', which is correct: they never wrote it.
--
--   A progress row may not exist for that pair. 008's handlers deliberately do
--   not seed one ("no row" already means stage 'none'), so both cases are
--   handled: existing rows are UPDATEd, missing ones INSERTed.
--
-- ATOMICITY
--   Same reasoning as 008 and 010, verified there against this project's
--   wrangler and its local D1: no explicit transaction keywords, because
--   workerd rejects the SQL keywords outright ("please use the
--   state.storage.transaction() ... APIs instead") and wrangler's --file loader
--   both refuses a file carrying them and already runs the whole file as one
--   atomic unit.
--
--   Belt and braces anyway, because that guarantee is the tool's and not
--   SQLite's: nothing here is destructive. There is no DROP and no RENAME, so
--   there is no window in which the schema is unusable. A partial failure
--   leaves `progress` with the new column and some rows unbackfilled, and the
--   source text is still in `companies.note` to finish the job from.
--
-- RE-RUN SAFETY
--   NOT idempotent. The ADD COLUMN would fail on its own the second time, but
--   the real hazard is the backfill: on a database that has been live for a
--   week it would overwrite every lead note a user has since edited with the
--   stale text still frozen in `companies.note`. That is silent data loss, and
--   an error from the ALTER is not something to rely on to prevent it. So the
--   file refuses first, using 008's guard pattern: `m011_guard` has
--   CHECK (already_migrated = 0) and is fed the number of `lead_note` columns
--   already on `progress`. On a database that has run this once the INSERT
--   violates the CHECK and the whole file aborts before a single row is
--   touched. The guard is dropped again on success so it recomputes from the
--   live schema every time rather than trusting bookkeeping.
--
-- SCOPE
--   `progress` gains one column; no key, index, or existing column changes.
--   `stage`, `note`/`stage_note` and `updated_at` are not read or written here
--   — `updated_at` in particular is left alone on backfilled rows, because it
--   times the last STAGE change and is what import.js's last-write-wins merge
--   compares. Moving a note that predates this migration is not a stage event
--   and must not pretend to be one.
--   No new index: a lead note is only ever fetched alongside its progress row,
--   by the key that already exists.

-- ---------------------------------------------------------------------------
-- 0. Refuse a second run, before anything is written.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS m011_guard (
  already_migrated INTEGER NOT NULL CHECK (already_migrated = 0)
);
DELETE FROM m011_guard;
INSERT INTO m011_guard (already_migrated)
SELECT (SELECT COUNT(*) FROM pragma_table_info('progress') WHERE name = 'lead_note');

-- ---------------------------------------------------------------------------
-- 1. The column. Additive; every existing row gets ''.
-- ---------------------------------------------------------------------------
ALTER TABLE progress ADD COLUMN lead_note TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- 2. Backfill, existing rows first.
--
--    The pairing is `c.profile_id = p.profile_id`: the note goes to the owner
--    of the company row only. Without that condition an adopted lead would hand
--    the owner's note to every adopter, which is the leak this migration exists
--    to close.
-- ---------------------------------------------------------------------------
UPDATE progress
SET lead_note = (SELECT c.note FROM companies c WHERE c.id = progress.company_id)
WHERE EXISTS (
  SELECT 1 FROM companies c
  WHERE c.id = progress.company_id
    AND c.profile_id = progress.profile_id
    AND COALESCE(c.note, '') <> ''
);

-- ---------------------------------------------------------------------------
-- 3. Backfill, rows that do not exist yet.
--
--    A company can carry a note while its owner never set a stage, so there is
--    nothing to UPDATE. Columns are listed explicitly on both sides so the copy
--    cannot be reordered by a later schema edit. `stage` is seeded 'none' and
--    `note` (the stage note) '' — the values 008's readers already infer for a
--    missing row — and `updated_at` stays NULL rather than being given a
--    synthetic timestamp, because no stage has ever been set on this pair and
--    claiming otherwise would forge a data point for analytics and for
--    import.js's merge.
-- ---------------------------------------------------------------------------
INSERT INTO progress (profile_id, company_id, stage, note, updated_at, lead_note)
SELECT c.profile_id, c.id, 'none', '', NULL, c.note
FROM companies c
WHERE COALESCE(c.note, '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM progress p
    WHERE p.company_id = c.id AND p.profile_id = c.profile_id
  );

-- ---------------------------------------------------------------------------
-- 4. Success. Drop the guard so the next run recomputes from the live schema.
-- ---------------------------------------------------------------------------
DROP TABLE m011_guard;
