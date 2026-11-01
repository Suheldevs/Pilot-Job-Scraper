-- Directory — hand-researched company lists (Lucknow ranked list, Noida /
-- Greater Noida / Delhi contact list), kept apart from `companies`.
--
-- `companies` holds scraped leads: one per opening, graded against a profile,
-- adopted between profiles. A directory entry is a different thing: a company
-- researched once, with its public HR contacts, that anyone may want to call.
-- So it is shared reference data (no profile_id on the row), and only the
-- caller's outreach status and note are private, on `directory_progress`,
-- keyed (profile_id, dir_id) exactly the way `progress` is since 008.
--
-- Additive only, safe to re-run (deploy.mjs --migrate re-applies every file).
-- The rows themselves come from 015-directory-seed.sql.

CREATE TABLE IF NOT EXISTS directory (
  id            TEXT PRIMARY KEY,              -- "lko:jamtech-technologies", "ncr:appinventiv"
  region        TEXT NOT NULL,                 -- lko | ncr
  city          TEXT NOT NULL DEFAULT '',      -- Lucknow | Noida | Greater Noida | Delhi
  sort          INTEGER NOT NULL DEFAULT 0,    -- list order within the region
  rank          INTEGER,                       -- Lucknow: overall rank; NCR: position in its city
  name          TEXT NOT NULL,
  area          TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT '',      -- Service | Product | MNC ...
  size          TEXT NOT NULL DEFAULT '',
  tier          TEXT NOT NULL DEFAULT '',      -- Lucknow only: Tier 1..4
  score         REAL,                          -- Lucknow only: total score /100
  rating        TEXT NOT NULL DEFAULT '',
  stack         TEXT NOT NULL DEFAULT '',
  mern          TEXT NOT NULL DEFAULT '',      -- Strong | Partial | None | Unknown (lko); Yes | No | Unknown (ncr)
  hiring        INTEGER NOT NULL DEFAULT 0,    -- 1 = current relevant MERN/React/Node opening seen
  hiring_label  TEXT NOT NULL DEFAULT '',
  job_title     TEXT NOT NULL DEFAULT '',
  job_url       TEXT NOT NULL DEFAULT '',
  emails        TEXT NOT NULL DEFAULT '[]',    -- JSON [{e, t: hr|gen, s: V|PDF|Dir}] HR first
  phones        TEXT NOT NULL DEFAULT '[]',    -- JSON [{n, l: label, s, m: 1 if mobile}] HR first
  careers_url   TEXT NOT NULL DEFAULT '',
  website       TEXT NOT NULL DEFAULT '',
  linkedin      TEXT NOT NULL DEFAULT '',
  contact_status TEXT NOT NULL DEFAULT '',     -- Verified | Found elsewhere | From my PDF | Not found ...
  warning       TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  checked       TEXT NOT NULL DEFAULT ''       -- date the contacts were last checked
);

CREATE INDEX IF NOT EXISTS idx_directory_region ON directory(region, sort);

CREATE TABLE IF NOT EXISTS directory_progress (
  profile_id  INTEGER NOT NULL,
  dir_id      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'none',    -- none|scheduled|contacted|called|whatsapp|emailed|replied|interview|no
  note        TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER,
  PRIMARY KEY (profile_id, dir_id)
);
