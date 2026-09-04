-- A run log for the scraper.
--
-- The scraper runs unattended every 6 hours, so a source that starts failing
-- is invisible until someone opens scrape.log. One row per interesting thing
-- that happened during a run makes it visible in the dashboard instead:
-- which source returned nothing, which layer dropped everything, whether the
-- push and prune actually landed.
--
-- Additive only — this is applied to a live database that has to keep working,
-- so nothing here alters or drops an existing object.

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,                 -- groups every event from one run
  at          INTEGER NOT NULL,              -- epoch ms
  kind        TEXT NOT NULL,                 -- run_start | run_end | source |
                                             -- layer | push | prune | error
  name        TEXT NOT NULL DEFAULT '',      -- source or layer name, e.g. "keka"
  status      TEXT NOT NULL DEFAULT 'ok',    -- ok | fail | skip | partial
  message     TEXT NOT NULL DEFAULT '',
  counts      TEXT NOT NULL DEFAULT '{}',    -- JSON, e.g. {"collected":55,"kept":3}
  duration_ms INTEGER                        -- null when the step wasn't timed
);

-- One index per way the dashboard reads this: a whole run at once, the newest
-- events across all runs, and "just the failures" (kind='error' newest first).
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
CREATE INDEX IF NOT EXISTS idx_events_kind_at ON events(kind, at);
