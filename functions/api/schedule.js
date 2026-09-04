/** Per-source scheduling.
 *
 *  Sources used to share one 6-hour clock. `source_schedule` gives each one its
 *  own interval so the monthly HN thread isn't polled 120x too often and ATS
 *  boards still get looked at daily.
 *
 *  This is separate from the circuit breaker in http_cache.py: that handles a
 *  source that is *failing*, this handles a source that is already *fresh
 *  enough*. Nothing here knows or cares about breaker state.
 *
 *  GET  /api/schedule                     every row + computed due/next_due_at
 *  PUT  /api/schedule  { sources: [...] } set interval_mins and/or enabled
 *  POST /api/schedule  { source, status, at }  record a run's outcome
 *
 *  Auth is already handled by functions/_middleware.js for every /api/* route,
 *  so nothing here re-checks it.
 */
import { json, badRequest, notFound } from "../lib/db.js";

// 5 minutes is the floor that keeps a mistyped interval from turning into a
// self-inflicted DoS on someone else's site; 40320 minutes is 28 days, which
// covers the monthly HN thread with room to spare.
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 40320;

// Same allow-list as the events table so one run's outcome reads identically
// in both places.
const VALID_STATUSES = ["ok", "fail", "skip", "partial"];

const MAX_UPDATES = 50;

export async function onRequestGet(context) {
  const { env } = context;
  const now = Date.now();

  const rows = await env.DB.prepare(`
    SELECT source, interval_mins, last_run_at, last_status, enabled
    FROM source_schedule
    ORDER BY interval_mins ASC, source ASC
  `).all();

  const sources = rows.results.map((r) => decorate(r, now));

  return json({
    now,
    count: sources.length,
    due_count: sources.filter((s) => s.due).length,
    sources,
  });
}

/** Update intervals / enabled flags.
 *
 *  Accepts either one source (`{source, interval_mins}`) or a batch
 *  (`{sources: [{source, interval_mins, enabled}, ...]}`) so the dashboard can
 *  save a whole edited table in one request.
 *
 *  An unknown source name is rejected rather than inserted: the set of sources
 *  is defined by pipeline.py's registries, and letting the API invent rows
 *  would create schedule entries that no scrape can ever satisfy.
 */
export async function onRequestPut(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("expected a JSON body");

  const items = Array.isArray(body.sources) ? body.sources
              : body.source ? [body]
              : null;
  if (!items || !items.length) {
    return badRequest("expected { source, interval_mins } or { sources: [...] }");
  }
  if (items.length > MAX_UPDATES) {
    return badRequest(`at most ${MAX_UPDATES} sources per request`);
  }

  // Validate everything before writing anything — a half-applied batch would
  // leave the caller unable to tell which half landed.
  const updates = [];
  for (const item of items) {
    const source = String(item?.source || "").trim();
    if (!source) return badRequest("each entry needs a source name");

    const setInterval = item.interval_mins !== undefined && item.interval_mins !== null;
    const setEnabled = item.enabled !== undefined && item.enabled !== null;
    if (!setInterval && !setEnabled) {
      return badRequest(`${source}: nothing to update — pass interval_mins and/or enabled`);
    }

    let interval = null;
    if (setInterval) {
      interval = Number(item.interval_mins);
      if (!Number.isFinite(interval) || interval < MIN_INTERVAL || interval > MAX_INTERVAL) {
        return badRequest(
          `${source}: interval_mins must be between ${MIN_INTERVAL} and ${MAX_INTERVAL} minutes`
        );
      }
      interval = Math.round(interval);
    }

    updates.push({
      source,
      interval,
      enabled: setEnabled ? (truthy(item.enabled) ? 1 : 0) : null,
    });
  }

  const known = await knownSources(env);
  const unknown = updates.map((u) => u.source).filter((s) => !known.has(s));
  if (unknown.length) {
    return notFound(`unknown source(s): ${unknown.join(", ")}. ` +
                    `Known: ${[...known].sort().join(", ")}`);
  }

  const statements = updates.map((u) => {
    // COALESCE keeps the column untouched when the caller didn't send it, so
    // a PUT of just `enabled` can't silently clobber a tuned interval.
    return env.DB.prepare(`
      UPDATE source_schedule
      SET interval_mins = COALESCE(?2, interval_mins),
          enabled       = COALESCE(?3, enabled)
      WHERE source = ?1
    `).bind(u.source, u.interval, u.enabled);
  });

  await env.DB.batch(statements);

  const now = Date.now();
  const refreshed = await env.DB.prepare(`
    SELECT source, interval_mins, last_run_at, last_status, enabled
    FROM source_schedule
    WHERE source IN (${updates.map((_, i) => `?${i + 1}`).join(",")})
  `).bind(...updates.map((u) => u.source)).all();

  return json({
    updated: updates.length,
    sources: refreshed.results.map((r) => decorate(r, now)),
  });
}

/** Record a run: stamps last_run_at / last_status, which is what makes the
 *  source stop being due. `at` is optional and defaults to now. */
export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("expected { source, status, at }");

  const source = String(body.source || "").trim();
  if (!source) return badRequest("source is required");

  const status = String(body.status || "ok");
  if (!VALID_STATUSES.includes(status)) {
    return badRequest(`status must be one of ${VALID_STATUSES.join("|")}`);
  }

  const rawAt = Number(body.at);
  const at = Number.isFinite(rawAt) && rawAt > 0 ? Math.round(rawAt) : Date.now();

  const result = await env.DB.prepare(`
    UPDATE source_schedule
    SET last_run_at = ?2, last_status = ?3
    WHERE source = ?1
  `).bind(source, at, status).run();

  if (!(result.meta?.changes)) {
    return notFound(`unknown source: ${source}`);
  }

  const row = await env.DB.prepare(`
    SELECT source, interval_mins, last_run_at, last_status, enabled
    FROM source_schedule WHERE source = ?1
  `).bind(source).first();

  return json({ recorded: true, source: decorate(row, Date.now()) });
}

/** Row -> API shape. `due` and `next_due_at` are computed here rather than
 *  stored so they can never go stale, and so the dashboard and the scraper
 *  agree on the answer without duplicating the arithmetic. */
function decorate(row, now) {
  const intervalMs = row.interval_mins * 60000;
  const lastRun = row.last_run_at ?? null;
  const enabled = !!row.enabled;
  // Never run before = due now. A disabled source is never due, whatever the
  // clock says — that's the point of the switch.
  const nextDueAt = lastRun === null ? now : lastRun + intervalMs;

  return {
    source: row.source,
    interval_mins: row.interval_mins,
    last_run_at: lastRun,
    last_status: row.last_status || "",
    enabled,
    due: enabled && (lastRun === null || nextDueAt <= now),
    next_due_at: nextDueAt,
    // Negative once overdue; the UI reads the sign to pick "in 4h" vs "overdue".
    due_in_mins: Math.round((nextDueAt - now) / 60000),
  };
}

async function knownSources(env) {
  const rows = await env.DB.prepare(`SELECT source FROM source_schedule`).all();
  return new Set(rows.results.map((r) => r.source));
}

/** JSON gives us true/false, but a form or a CLI gives us "1"/"0"/"false". */
function truthy(v) {
  if (typeof v === "string") return !["0", "false", "no", "off", ""].includes(v.toLowerCase());
  return !!v;
}
