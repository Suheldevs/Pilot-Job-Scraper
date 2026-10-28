-- A typed city name for companies outside the five fixed tabs.
--
-- The add-company form gained an "Other" city (tab "oth") where the city is
-- typed by hand — Hyderabad, Indore, Jaipur… The tab alone cannot carry the
-- name, so it gets its own column. Empty for every other tab, and for every
-- existing row.
--
-- SAFE TO RE-RUN: a single ADD COLUMN with a default; a second run fails with
-- "duplicate column name", which deploy.mjs treats as already applied.

ALTER TABLE companies ADD COLUMN city TEXT NOT NULL DEFAULT '';
