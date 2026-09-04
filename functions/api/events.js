/** The scraper's run log.
 *
 *  The scraper runs unattended every 6 hours. Without this, the only record of
 *  a source that quietly started returning nothing is scrape.log on whichever
 *  machine ran it — so the dashboard reads these rows instead and shows which
 *  source or layer failed.
 *
 *  POST   /api/events  { run_id, events: [...] }   append a run's events
 *  GET    /api/events?limit&run_id&kind&status&since
 *  DELETE /api/events?days=30                      evict old rows
 *
 *  Auth is already handled by functions/_middleware.js for every /api/* route,
 *  so nothing here re-checks it.
 */
import { json, badRequest } from "../lib/db.js";

/** Allow-lists. An unknown kind or status is almost always a typo in a caller,
 *  and letting it through would make the dashboard's per-status columns lie. */
const VALID_KINDS = ["run_start", "run_end", "source", "layer", "push", "prune", "error"];
const VALID_STATUSES = ["ok", "fail", "skip", "partial"];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_RUNS = 20;

const DEFAULT_PRUNE_DAYS = 30;

// A message is for a human skimming a list, not a stack trace dump; a runaway
// exception string would otherwise bloat every row of the table.
const MAX_MESSAGE = 500;
const MAX_COUNTS = 500;

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.events)) return badRequest("expected { run_id, events: [...] }");

  const runId = String(body.run_id || "").slice(0, 80);
  if (!runId) return badRequest("run_id is required");

  const now = Date.now();
  const statements = [];
  let skipped = 0;

  for (const e of body.events) {
    // Skip the bad row, don't fail the batch: this is observability, and
    // losing the whole run's log because one event was malformed is worse
    // than losing that one event.
    if (!e || !VALID_KINDS.includes(e.kind)) { skipped++; continue; }
    const status = VALID_STATUSES.includes(e.status) ? e.status : null;
    if (status === null) { skipped++; continue; }

    const at = Number(e.at);
    const duration = Number(e.duration_ms);

    statements.push(
      env.DB.prepare(`
        INSERT INTO events (run_id, at, kind, name, status, message, counts, duration_ms)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
      `).bind(
        runId,
        Number.isFinite(at) ? Math.round(at) : now,
        e.kind,
        String(e.name || "").slice(0, 80),
        status,
        String(e.message || "").slice(0, MAX_MESSAGE),
        stringifyCounts(e.counts),
        Number.isFinite(duration) ? Math.round(duration) : null
      )
    );
  }

  if (statements.length) {
    // D1 batches cap around 100 statements per call — chunk to be safe.
    for (let i = 0; i < statements.length; i += 80) {
      await env.DB.batch(statements.slice(i, i + 80));
    }
  }

  return json({ inserted: statements.length, skipped });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const rawLimit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) ? Math.min(MAX_LIMIT, Math.max(1, Math.round(rawLimit)))
                                          : DEFAULT_LIMIT;

  const runId = url.searchParams.get("run_id") || "";
  const kind = url.searchParams.get("kind") || "";
  const status = url.searchParams.get("status") || "";
  const since = Number(url.searchParams.get("since"));

  if (kind && !VALID_KINDS.includes(kind)) return badRequest(`kind must be one of ${VALID_KINDS.join("|")}`);
  if (status && !VALID_STATUSES.includes(status)) return badRequest(`status must be one of ${VALID_STATUSES.join("|")}`);

  // Built as a list so the placeholder numbers stay in step with the binds
  // however many filters the caller actually passed.
  const where = [];
  const binds = [];
  if (runId) { binds.push(runId); where.push(`run_id = ?${binds.length}`); }
  if (kind) { binds.push(kind); where.push(`kind = ?${binds.length}`); }
  if (status) { binds.push(status); where.push(`status = ?${binds.length}`); }
  if (Number.isFinite(since)) { binds.push(Math.round(since)); where.push(`at >= ?${binds.length}`); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  binds.push(limit);
  const limitMark = `?${binds.length}`;

  // The runs summary ships with the events so the UI can render one row per
  // run without a second request. It deliberately ignores the filters above:
  // "which runs exist" shouldn't change because you clicked kind=error.
  const [events, runs] = await Promise.all([
    env.DB.prepare(`
      SELECT id, run_id, at, kind, name, status, message, counts, duration_ms
      FROM events
      ${clause}
      ORDER BY at DESC, id DESC
      LIMIT ${limitMark}
    `).bind(...binds).all(),
    env.DB.prepare(`
      SELECT run_id,
        MIN(at) AS started_at,
        -- null ended_at is the interesting case: the run died before it could
        -- log run_end, which is exactly the failure this table exists to show.
        MAX(CASE WHEN kind = 'run_end' THEN at END) AS ended_at,
        MAX(at) AS last_at,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) AS fail,
        SUM(CASE WHEN status = 'skip' THEN 1 ELSE 0 END) AS skip,
        SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial
      FROM events
      GROUP BY run_id
      ORDER BY started_at DESC
      LIMIT ${MAX_RUNS}
    `).all(),
  ]);

  return json({
    limit,
    count: events.results.length,
    events: events.results.map(rowToEvent),
    runs: runs.results.map((r) => ({
      run_id: r.run_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      last_at: r.last_at,
      total: r.total,
      statuses: { ok: r.ok, fail: r.fail, skip: r.skip, partial: r.partial },
    })),
  });
}

/** Events are append-only and another batch arrives every 6 hours, so the
 *  table needs its own eviction — nothing else will ever delete from it. */
export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const days = Number(url.searchParams.get("days") || DEFAULT_PRUNE_DAYS);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return badRequest("days must be between 1 and 365");
  }
  const cutoff = Date.now() - days * 86400000;

  const result = await env.DB.prepare(`DELETE FROM events WHERE at < ?1`).bind(cutoff).run();

  return json({ days, removed: result.meta?.changes ?? 0 });
}

/** DB row -> API shape. `counts` is stored as JSON text, so parse it back
 *  rather than making every consumer of this endpoint do it. */
function rowToEvent(row) {
  return {
    id: row.id,
    run_id: row.run_id,
    at: row.at,
    kind: row.kind,
    name: row.name || "",
    status: row.status,
    message: row.message || "",
    counts: safeCounts(row.counts),
    duration_ms: row.duration_ms ?? null,
  };
}

function safeCounts(text) {
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Store only a flat JSON object. An array or scalar here would break the
 *  `{"collected":55}` shape the dashboard reads. */
function stringifyCounts(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return "{}";
  try {
    const text = JSON.stringify(counts);
    // Truncating JSON would store text that no longer parses, so an
    // oversized object is dropped whole instead of half-stored.
    return text.length <= MAX_COUNTS ? text : "{}";
  } catch {
    return "{}";
  }
}
