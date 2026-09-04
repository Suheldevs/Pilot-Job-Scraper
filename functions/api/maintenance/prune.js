/** Drop scraped leads you never applied to, after `days`.
 *
 *  The rule is exactly "if I applied, keep it; if I didn't, evict it" — so the
 *  only thing that keeps a scraped lead alive past the window is you having
 *  moved it off 'Not contacted'. Any stage at all (contacted, replied,
 *  interviewing, offer, even rejected) keeps it permanently.
 *
 *  Removes a row only when ALL of these hold:
 *    - source = 'scraped'   never the 84 hand-researched companies, never a
 *                           manual add, never an imported file — those are your
 *                           own work, not scraper output, so they are never
 *                           evicted regardless of age
 *    - stage  = 'none'      you did not apply
 *    - no note              a note you typed is a deliberate human signal
 *    - created_at older than `days`
 *
 *  Note a contact address does NOT protect a row. An extracted email is
 *  machine output, not evidence you were interested, and treating it as
 *  protection was letting the database fill with unapplied leads.
 *
 *  POST /api/maintenance/prune  { days?: 10, dry_run?: false }
 */
import { json, badRequest } from "../../lib/db.js";

const DEFAULT_DAYS = 10;

const WHERE = `
  c.source = 'scraped'
  AND COALESCE(p.stage, 'none') = 'none'
  AND COALESCE(p.note, '') = ''
  AND c.created_at < ?1
`;

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => ({}));

  const days = body.days === undefined ? DEFAULT_DAYS : Number(body.days);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return badRequest("days must be between 1 and 365");
  }
  const cutoff = Date.now() - days * 86400000;
  const dryRun = Boolean(body.dry_run);

  const { results } = await env.DB.prepare(`
    SELECT c.id, c.name, c.tab, c.grade, c.created_at
    FROM companies c LEFT JOIN progress p ON p.company_id = c.id
    WHERE ${WHERE}
    ORDER BY c.created_at
  `).bind(cutoff).all();

  if (dryRun) {
    return json({ dry_run: true, days, would_remove: results.length, rows: results });
  }
  if (!results.length) {
    return json({ days, removed: 0, rows: [] });
  }

  const ids = results.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const marks = chunk.map((_, n) => `?${n + 1}`).join(",");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM stage_history WHERE company_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM progress WHERE company_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM companies WHERE id IN (${marks})`).bind(...chunk),
    ]);
  }

  return json({ days, removed: ids.length, rows: results });
}

/** GET returns the same list without deleting — used by the dashboard preview. */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days") || DEFAULT_DAYS);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return badRequest("days must be between 1 and 365");
  }
  const cutoff = Date.now() - days * 86400000;
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.name, c.tab, c.grade, c.created_at
    FROM companies c LEFT JOIN progress p ON p.company_id = c.id
    WHERE ${WHERE}
    ORDER BY c.created_at
  `).bind(cutoff).all();

  return json({ days, would_remove: results.length, rows: results });
}
