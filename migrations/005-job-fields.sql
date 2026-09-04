-- The optional per-job detail models.py::Job now carries.
-- Sources vary wildly in what they give: a Keka record has salary, experience
-- and a headcount, a Naukri sitemap slug has a title and a city. These columns
-- exist so the rich sources are not flattened down to the poorest one, and so
-- a lead can be judged (pay band, seniority, remote policy) without reopening
-- the posting.
--
-- Additive only — this runs against a live DB. Text columns take NOT NULL
-- DEFAULT '' so existing rows stay valid and the API never has to guess
-- between "empty" and NULL. The numeric ones stay nullable on purpose:
-- 0 LPA and "no salary given" are not the same fact, and treating them alike
-- would make an unknown look like an offer of nothing.

ALTER TABLE companies ADD COLUMN source_job_id TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN apply_url TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN employment_type TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN remote_type TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN department TEXT NOT NULL DEFAULT '';

ALTER TABLE companies ADD COLUMN salary_raw TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN salary_min INTEGER;
ALTER TABLE companies ADD COLUMN salary_max INTEGER;
ALTER TABLE companies ADD COLUMN salary_currency TEXT NOT NULL DEFAULT '';

-- REAL, not INTEGER: postings say "1.5 to 3 years" as often as "2 to 4".
ALTER TABLE companies ADD COLUMN experience_raw TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN experience_min REAL;
ALTER TABLE companies ADD COLUMN experience_max REAL;

ALTER TABLE companies ADD COLUMN company_size TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN company_website TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN openings_count INTEGER;

-- The untouched source payload (Job.raw_json(), already capped writer-side).
-- Kept so a parsing bug can be fixed and the fields above re-derived without
-- re-scraping, and so a field we did not think to model is not lost.
ALTER TABLE companies ADD COLUMN raw_data TEXT NOT NULL DEFAULT '';
