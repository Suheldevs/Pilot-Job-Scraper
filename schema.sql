-- job-outreach D1 schema

CREATE TABLE IF NOT EXISTS companies (
  id           TEXT PRIMARY KEY,             -- slug of name, e.g. "capgemini"
  tab          TEXT NOT NULL,                -- blr | pune | lko | noida | rem
  section      TEXT NOT NULL,                -- s1/s2/s3, p1/p2/p3, l1/l2/l3, n1/n2, r1
  name         TEXT NOT NULL,
  li           TEXT DEFAULT '',              -- linkedin handle or full url
  hr           TEXT NOT NULL DEFAULT '[]',   -- JSON array of emails
  em           TEXT NOT NULL DEFAULT '[]',   -- JSON array of emails
  wa           TEXT NOT NULL DEFAULT '[]',   -- JSON array of phone numbers
  land         TEXT DEFAULT '',              -- landline, if any
  note         TEXT DEFAULT '',
  job_url      TEXT DEFAULT '',
  job_title    TEXT DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'manual', -- manual | scraped | import | seed
  scraped_from TEXT DEFAULT '',               -- legacy loose source string
  created_at   INTEGER NOT NULL,

  -- the two tags (see migrations/002-tags.sql)
  platform      TEXT NOT NULL DEFAULT '',   -- tag 1: greenhouse|lever|ashby|remotive|
                                            -- arbeitnow|remoteok|weworkremotely|linkedin|
                                            -- extension|manual
  grade         TEXT NOT NULL DEFAULT '',   -- tag 2: A | B | C | D
  score         INTEGER NOT NULL DEFAULT 0, -- 0-100 behind the grade
  score_reasons TEXT NOT NULL DEFAULT '[]', -- JSON array of why-strings
  jd_excerpt    TEXT NOT NULL DEFAULT '',   -- first chunk of the JD, for context
  posted_at     INTEGER,                    -- when the opening was posted

  -- optional per-job detail (see migrations/005-job-fields.sql)
  -- Sources differ in what they give, so all of this is optional. Numeric
  -- columns stay nullable: "no salary given" must not read as 0.
  source_job_id   TEXT NOT NULL DEFAULT '', -- the source's own id, for its API
  apply_url       TEXT NOT NULL DEFAULT '', -- when the apply link differs from job_url
  employment_type TEXT NOT NULL DEFAULT '', -- full-time | contract | internship | ...
  remote_type     TEXT NOT NULL DEFAULT '', -- remote | hybrid | onsite
  department      TEXT NOT NULL DEFAULT '', -- team or function
  salary_raw      TEXT NOT NULL DEFAULT '', -- as written, e.g. "8-14 LPA"
  salary_min      INTEGER,                  -- normalized, annual, source currency
  salary_max      INTEGER,
  salary_currency TEXT NOT NULL DEFAULT '',
  experience_raw  TEXT NOT NULL DEFAULT '', -- as written, e.g. "2 to 4 years"
  experience_min  REAL,                     -- REAL: postings say "1.5 to 3 years"
  experience_max  REAL,
  company_size    TEXT NOT NULL DEFAULT '',
  company_website TEXT NOT NULL DEFAULT '',
  openings_count  INTEGER,
  raw_data        TEXT NOT NULL DEFAULT ''  -- untouched source payload, as JSON
);

CREATE INDEX IF NOT EXISTS idx_companies_tab ON companies(tab);
CREATE INDEX IF NOT EXISTS idx_companies_grade ON companies(grade);
CREATE INDEX IF NOT EXISTS idx_companies_platform ON companies(platform);

CREATE TABLE IF NOT EXISTS progress (
  company_id  TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL DEFAULT 'none',  -- none|contacted|replied|interviewing|offer|rejected
  note        TEXT DEFAULT '',
  updated_at  INTEGER
);

-- One row per stage transition — powers the analytics timeline.
CREATE TABLE IF NOT EXISTS stage_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  TEXT NOT NULL,
  stage       TEXT NOT NULL,
  at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_company ON stage_history(company_id);
CREATE INDEX IF NOT EXISTS idx_history_at ON stage_history(at);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
