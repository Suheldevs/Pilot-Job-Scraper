-- Auto-apply log, the notification feed, and phone push subscriptions.
--
-- WHY
--   auto_apply.py kept its "who was emailed when" record only in a local file
--   (apply_state.json). That file is the dedupe guard — lose the PC or the file
--   and every company could be emailed a second time — and nothing in the
--   dashboard could report a reply rate from it. `apply_log` puts the same
--   record in the database: the sender writes every send there, restores from
--   it on start, and the Analytics view computes reply rates from it.
--
--   `notifications` is the in-app activity feed (scrape finished, applied to N,
--   HR replied, daily summary, errors). Every event lands here whether or not a
--   phone push went out, so nothing is missed when a push is dropped.
--
--   `push_subscriptions` holds each device's Web Push endpoint and keys, per
--   user. A subscription that the push service reports gone (404/410) is
--   deleted by the sender.
--
-- SAFE TO RE-RUN
--   Additive only: three new tables and their indexes, all IF NOT EXISTS. No
--   existing table or row is touched.

CREATE TABLE IF NOT EXISTS apply_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  INTEGER NOT NULL,
  company_id  TEXT    NOT NULL,
  company     TEXT    NOT NULL DEFAULT '',
  to_addr     TEXT    NOT NULL,
  subject     TEXT    NOT NULL DEFAULT '',
  subject_tpl TEXT    NOT NULL DEFAULT '',   -- the template it was filled from, for A/B stats
  msg_id      TEXT    NOT NULL DEFAULT '',
  job         TEXT    NOT NULL DEFAULT '',
  tab         TEXT    NOT NULL DEFAULT '',
  grade       TEXT    NOT NULL DEFAULT '',
  platform    TEXT    NOT NULL DEFAULT '',
  sent_at     INTEGER NOT NULL,
  followup_at INTEGER,
  replied_at  INTEGER,
  bounced_at  INTEGER,
  UNIQUE (profile_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_apply_log_sent ON apply_log (profile_id, sent_at);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  url        TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  endpoint   TEXT    NOT NULL UNIQUE,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  label      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);
