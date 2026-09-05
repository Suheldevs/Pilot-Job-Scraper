-- Users, profile ownership, and per-profile settings.
--
-- WHAT THIS FIXES
--   Until now there was no concept of a *user*. `_middleware.js` gated the
--   whole site on one shared `SITE_PASSWORD`, and the session token's payload
--   was `{exp}` — no subject. Profiles were therefore a view filter, not a
--   security boundary: any holder of a valid cookie could pass `?profile_id=N`
--   for any N and read that profile's board, stages, notes and analytics,
--   because `resolveProfileId` only ever checked that the profile EXISTS.
--
--   PROFILE-CONTRACT.md's isolation promise ("stages and notes never leak
--   between profiles") was true row-by-row after 008, but meaningless while a
--   single password opened every profile. This migration adds the missing
--   half: who is asking.
--
-- THE OWNERSHIP MODEL
--   users 1..N, each owning 0..N profiles (`profiles.owner_user_id`). One user
--   with several profiles is the normal case — the same person targeting two
--   different roles — so this is deliberately not 1:1.
--
--   Lead SHARING is unchanged and still happens at the profile level via
--   `profile_companies`. That is the point: two users whose profiles are
--   similar adopt each other's leads instead of re-scraping, while `progress`
--   stays keyed (profile_id, company_id) from 008 so stages and notes remain
--   private. Sharing a lead must never mean sharing what you wrote about it.
--
-- PASSWORD STORAGE
--   `pw_hash` holds PBKDF2-SHA256 as `pbkdf2$<iterations>$<salt>$<hash>`, salt
--   and hash base64url. Workers has no bcrypt or argon2 without pulling in
--   WASM; PBKDF2 is what `crypto.subtle` gives us natively and is the right
--   call over hand-rolling anything. See functions/lib/password.js.
--
--   The seeded parent user is created with an EMPTY `pw_hash` on purpose. An
--   empty hash means "no password set yet", and functions/lib/password.js
--   refuses to verify against it — it can never match. The login handler falls
--   back to `SITE_PASSWORD` for that user only and only while the hash is
--   empty, so an existing deployment keeps working through the upgrade and
--   stops falling back the moment a real password is set.
--
-- WHY A TABLE REBUILD FOR `settings`
--   `settings` is keyed by `key` alone, so message templates are global — every
--   user would read and overwrite the same rows. The fix is the composite key
--   (profile_id, key), and SQLite cannot ALTER a primary key, so the same
--   four-step dance 008 used for `progress` applies: create, copy, drop,
--   rename. Existing rows belong to the parent profile and are stamped 1.
--
-- ATOMICITY
--   Same reasoning as 008, which verified it against this project's wrangler
--   and local D1: no explicit transaction keywords (workerd rejects them and
--   wrangler's --file loader already runs the file as one atomic unit), and the
--   statements are ordered so any partial failure leaves a *working* table.
--   `users` and the `profiles` column are additive and finish before `settings`
--   is touched. Inside the settings block the only unrecoverable window is
--   between the DROP and the RENAME — two adjacent, cheap DDL statements; if
--   the process died in that gap, `settings_new` still holds every migrated row
--   and `ALTER TABLE settings_new RENAME TO settings;` finishes it by hand.
--
-- RE-RUN SAFETY
--   NOT idempotent, and a blind second run would be destructive in exactly the
--   way 008's would: it would copy the already-migrated `settings` into a fresh
--   `settings_new` and drop the real table. So it refuses, using 008's guard
--   pattern — `m010_guard` has CHECK (already_migrated = 0) and is fed the
--   number of already-present markers. On a database that has run this once the
--   INSERT violates the CHECK and the whole file aborts before anything is
--   dropped. The guard is dropped again on success so it recomputes from the
--   live schema every time rather than trusting bookkeeping.
--
-- SCOPE
--   No foreign keys to `users` or `profiles`, consistent with 006 and 008 —
--   the API handlers validate instead. Nothing here touches `companies`,
--   `progress` or `stage_history`; `companies.note` is still shared and is
--   dealt with separately in 011.

-- ---------------------------------------------------------------------------
-- 0. Refuse a second run, before anything destructive happens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS m010_guard (
  already_migrated INTEGER NOT NULL CHECK (already_migrated = 0)
);
DELETE FROM m010_guard;
INSERT INTO m010_guard (already_migrated)
SELECT (SELECT COUNT(*) FROM pragma_table_info('profiles') WHERE name = 'owner_user_id')
     + (SELECT COUNT(*) FROM pragma_table_info('settings') WHERE name = 'profile_id');

-- ---------------------------------------------------------------------------
-- 1. users. Additive, so nothing can be lost here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  -- '' means "no password set" — never verifiable. See password.js.
  pw_hash       TEXT NOT NULL DEFAULT '',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  -- Session revocation. Sessions are stateless HMAC tokens with no server-side
  -- record, so without this there is no way to invalidate one: changing a
  -- password would leave every already-issued cookie working for its full 30
  -- days, including the one an attacker took the password from. Every token
  -- carries the epoch it was minted at; _middleware.js rejects a token whose
  -- epoch is behind the user's current one, so bumping this signs that user out
  -- everywhere. Rotating SESSION_SECRET is the only alternative and it signs
  -- out every user at once.
  session_epoch INTEGER NOT NULL DEFAULT 0
);

-- Case-insensitive: an address differing only in case is the same account, and
-- letting both exist would silently split one person's profiles across two
-- users. Enforced in the index rather than the handler so it holds for the
-- migration's own seed and for any future direct insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));

-- The parent user. Email is profile 1's own, seeded by 006 from index.html's
-- `ME` block, so the person who already owns this database is who it belongs
-- to. Empty pw_hash -> SITE_PASSWORD fallback until a real password is set.
INSERT INTO users (id, email, name, pw_hash, is_admin, created_at)
SELECT 1,
       COALESCE(NULLIF((SELECT email FROM profiles WHERE id = 1), ''), 'owner@localhost'),
       COALESCE(NULLIF((SELECT full_name FROM profiles WHERE id = 1), ''), 'Owner'),
       '',
       1,
       1730000000000
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 1);

-- ---------------------------------------------------------------------------
-- 2. profiles.owner_user_id. A plain ADD COLUMN stamps every existing row with
--    1 in one statement and cannot lose a row — the same reasoning 008 used for
--    stage_history. Every profile that exists today is the parent's.
-- ---------------------------------------------------------------------------
ALTER TABLE profiles ADD COLUMN owner_user_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles(owner_user_id);

-- ---------------------------------------------------------------------------
-- 3. settings: rebuild on the composite primary key (profile_id, key).
-- ---------------------------------------------------------------------------
CREATE TABLE settings_new (
  profile_id INTEGER NOT NULL DEFAULT 1,
  key        TEXT NOT NULL,
  value      TEXT,
  PRIMARY KEY (profile_id, key)
);

-- Every existing settings row is the parent profile's.
INSERT INTO settings_new (profile_id, key, value)
SELECT 1, key, value FROM settings;

DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

-- ---------------------------------------------------------------------------
-- 4. Success. Drop the guard so the next run recomputes from the live schema.
-- ---------------------------------------------------------------------------
DROP TABLE m010_guard;
