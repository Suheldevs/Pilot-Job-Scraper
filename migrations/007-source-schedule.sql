-- Per-source scheduling.
--
-- Every source used to share one 6-hour clock, which is wrong in both
-- directions: the Hacker News "who is hiring" thread is monthly (so a 6h poll
-- asks ~120x too often) while ATS boards change daily. One row per source
-- carries its own interval, its last outcome, and an on/off switch.
--
-- This is NOT the circuit breaker in http_cache.py. That one handles a source
-- that is *failing*; this one handles a source that is already *fresh enough*.
-- The two are deliberately independent — a source can be due and still be
-- skipped by an open breaker, and vice versa.
--
-- Additive only: applied to a live database, so nothing here alters or drops
-- an existing object, and the seed rows use ON CONFLICT DO NOTHING so
-- re-running the migration never resets an interval someone tuned by hand.

CREATE TABLE IF NOT EXISTS source_schedule (
  source        TEXT PRIMARY KEY,
  interval_mins INTEGER NOT NULL,
  last_run_at   INTEGER,                    -- epoch ms, same unit as events.at
  last_status   TEXT NOT NULL DEFAULT '',   -- ok | fail | skip | partial
  enabled       INTEGER NOT NULL DEFAULT 1
);

-- Seeds. last_run_at stays NULL so every source is due on the first run.
INSERT INTO source_schedule (source, interval_mins) VALUES
  -- sitemap crawl: cheap (conditional 304s) and Naukri churns fastest
  ('naukri_sitemap', 360),
  -- aggregators with real Indian volume
  ('instahyre', 720),
  -- ATS boards: refreshed daily-ish by the companies themselves
  ('greenhouse', 720),
  ('lever', 720),
  ('ashby', 720),
  ('keka', 720),
  -- remote feeds: slow-moving, daily is plenty
  ('remotive', 1440),
  ('arbeitnow', 1440),
  ('remoteok', 1440),
  ('weworkremotely', 1440),
  -- the one that gets you rate-limited; ask once a day, not four times
  ('linkedin', 1440),
  -- the thread is monthly; weekly is already generous, and scheduler.py
  -- additionally treats a new thread objectID as an event that forces a run
  ('hackernews', 10080)
ON CONFLICT(source) DO NOTHING;
