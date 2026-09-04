-- The two tags: where a company came from, and how strong the lead is.
-- `scraped_from` already held a loose source string; `platform` supersedes it
-- as a constrained provenance key, and the grade/score columns carry layer 4's
-- verdict so the dashboard can filter and sort on it without recomputing.

ALTER TABLE companies ADD COLUMN platform TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN grade TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN score_reasons TEXT NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN jd_excerpt TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN posted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_companies_grade ON companies(grade);
CREATE INDEX IF NOT EXISTS idx_companies_platform ON companies(platform);

-- Backfill provenance for rows that predate this migration.
UPDATE companies SET platform = scraped_from
  WHERE platform = '' AND scraped_from != '';
UPDATE companies SET platform = 'manual'
  WHERE platform = '' AND source IN ('manual', 'seed', 'import');
