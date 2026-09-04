-- Profiles — the candidate stops being hardcoded.
--
-- Additive only. This runs against a live database holding 292 companies, so
-- every statement is either CREATE TABLE IF NOT EXISTS, an ALTER that adds a
-- column with a default, or a guarded INSERT. Nothing is dropped, rewritten or
-- backfilled destructively: existing rows land on profile 1 version 1 (the
-- parent) purely through the column defaults.
--
-- Field names and types come from PROFILE-CONTRACT.md verbatim.

CREATE TABLE IF NOT EXISTS profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  version         INTEGER NOT NULL DEFAULT 1,
  name            TEXT NOT NULL,
  is_default      INTEGER NOT NULL DEFAULT 0,   -- exactly one row has 1
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  -- identity, used to fill message templates
  full_name       TEXT NOT NULL DEFAULT '',
  headline        TEXT NOT NULL DEFAULT '',
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
  search_roles     TEXT NOT NULL DEFAULT '[]',  -- QUERY terms
  search_locations TEXT NOT NULL DEFAULT '[]',  -- QUERY terms
  match_keywords   TEXT NOT NULL DEFAULT '[]',  -- FILTER tokens
  must_have        TEXT NOT NULL DEFAULT '[]',
  nice_to_have     TEXT NOT NULL DEFAULT '[]',
  exclude_titles   TEXT NOT NULL DEFAULT '[]',
  exclude_stacks   TEXT NOT NULL DEFAULT '[]',
  cities           TEXT NOT NULL DEFAULT '[]',  -- tab keys, a subset of the five
  exp_min          REAL NOT NULL DEFAULT 0,
  exp_max          REAL NOT NULL DEFAULT 99,
  remote_pref      TEXT NOT NULL DEFAULT 'any',
  employment_type  TEXT NOT NULL DEFAULT 'any',
  min_grade        TEXT NOT NULL DEFAULT 'C'
);

-- Stamping leads. Existing rows inherit 1/1 from the defaults, which is
-- exactly right: the parent profile judged them.
ALTER TABLE companies ADD COLUMN profile_id      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_companies_profile ON companies(profile_id);

-- Sharing leads across similar profiles WITHOUT duplicating company rows.
-- A company row keeps its originating `profile_id`; adoption is a second,
-- many-to-many visibility edge on top of it.
CREATE TABLE IF NOT EXISTS profile_companies (
  profile_id  INTEGER NOT NULL,
  company_id  TEXT NOT NULL,
  adopted_at  INTEGER NOT NULL,
  PRIMARY KEY (profile_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_companies_company ON profile_companies(company_id);

-- ---------------------------------------------------------------------------
-- Seed profile 1 — the parent. Values are lifted from the files that hold them
-- today, not invented:
--   identity          index.html `ME`
--   years             scoring.CANDIDATE_YEARS
--   search_roles      config.ROLE_KEYWORDS
--   search_locations  config.LOCATIONS
--   match_keywords    config.MATCH_KEYWORDS
--   exp_min/exp_max   config.MIN_EXPERIENCE_YEARS / MAX_EXPERIENCE_YEARS
--   exclude_titles    relevance.TOO_SENIOR + relevance.TOO_JUNIOR
--   exclude_stacks    relevance.WRONG_DISCIPLINE
--   must_have         scoring.CANDIDATE_SKILLS — the stack keys
--   nice_to_have      scoring.CANDIDATE_SKILLS — the AI keys
--   cities            the five existing tab keys
--
-- ON CONFLICT DO NOTHING on the explicit id 1: re-running this migration
-- neither duplicates the row nor overwrites edits made through the API.
INSERT INTO profiles (
  id, version, name, is_default, created_at, updated_at,
  full_name, headline, years, current_company, email, phone,
  linkedin, github, portfolio, resume_url, notice_period,
  search_roles, search_locations, match_keywords,
  must_have, nice_to_have, exclude_titles, exclude_stacks, cities,
  exp_min, exp_max, remote_pref, employment_type, min_grade
) VALUES (
  1, 1, 'Mohd Suhel', 1, 1730000000000, 1730000000000,
  'Mohd Suhel',
  'Full-stack developer (React / Node)',
  2,
  'Jamtech Technologies',
  'mohdsuhel.dev@gmail.com',
  '919519838720',
  'https://www.linkedin.com/in/mohd-suhel-4b2072257',
  'https://github.com/Suheldevs',
  'https://mohdsuhel.netlify.app/',
  'https://drive.google.com/file/d/1_-uaMxN4XP4evy416qIrA0HlUv5YKWti/view?usp=sharing',
  '30 days',
  '["full stack developer","mern stack developer","react developer","node js developer"]',
  '["Bangalore","Pune","Lucknow","Noida","Remote"]',
  '["react","node","mern","full stack","fullstack","javascript","typescript","next.js","nextjs","frontend","front-end","backend","express","mongodb"]',
  '["react","next","react native","node","express","mongodb","javascript","typescript","mern"]',
  '["ai workflows","agents","vector search"]',
  '["senior","sr","lead","principal","staff","architect","head","director","vp","vice president","manager","chief","cto","intern","internship","trainee","apprentice","fresher only"]',
  '["java",".net","dot net","dotnet","net developer","net full stack","asp net","c#","php","laravel","ruby on rails","rails","ror","golang","go developer","django","flask","python developer","salesforce","sap","sharepoint","wordpress","drupal","shopify","flutter","android","ios","swift","kotlin","unity","devops","sre","site reliability","cloud engineer","network","data engineer","data scientist","ml engineer","machine learning","qa","quality assurance","tester","testing","automation test","business analyst","product manager","designer","ui/ux","graphic","sales","marketing","recruiter","hr ","accountant","finance","support engineer","customer success","technical writer","embedded","firmware","mainframe","cobol","oracle","dba"]',
  '["blr","pune","lko","noida","rem"]',
  1, 3, 'any', 'any', 'C'
)
ON CONFLICT(id) DO NOTHING;
