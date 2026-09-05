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
 *    - owned by the requesting profile
 *                           see PER-PROFILE below
 *    - stage  = 'none'      you did not apply — and nor did any other profile
 *                           sharing the lead
 *    - no note              a note you typed is a deliberate human signal
 *    - created_at older than `days`
 *
 *  Note a contact address does NOT protect a row. An extracted email is
 *  machine output, not evidence you were interested, and treating it as
 *  protection was letting the database fill with unapplied leads.
 *
 *  PER-PROFILE (migration 008)
 *  ---------------------------
 *  Pruning deletes the `companies` row itself, which is shared: one row, many
 *  profiles that can see it. So "prune within my profile" has to mean
 *  `companies.profile_id = me` — the leads I own — and NOT "everything visible
 *  to me". Pruning on visibility would let a profile that merely adopted the
 *  parent's 292 leads delete the parent's data, which is the opposite of the
 *  isolation 008 exists to provide.
 *
 *  The stage/note test is then doubled up on purpose:
 *    - `p.stage`/`p.note` are MY progress row, so I prune by my own board;
 *    - the NOT EXISTS says nobody else has touched it either. Without that,
 *      the owner could delete a lead another profile had adopted and marked
 *      'interviewing', taking that profile's work with it. On the parent
 *      database only profile 1 has rows, so this changes nothing today.
 *
 *  POST /api/maintenance/prune  { days?: 10, dry_run?: false, profile_id?: N }
 *  GET  /api/maintenance/prune?days=10[&profile_id=N]
 */
import { json, badRequest } from "../../lib/db.js";
import { resolveProfileId, PROGRESS_ON_PROFILE } from "../../lib/profile.js";

const DEFAULT_DAYS = 10;

// ?1 = profile id, ?2 = cutoff. Same numbering as everywhere else in the app.
const WHERE = `
  c.source = 'scraped'
  AND c.profile_id = ?1
  AND COALESCE(p.stage, 'none') = 'none'
  AND COALESCE(p.note, '') = ''
  AND NOT EXISTS (
    SELECT 1 FROM progress p2
     WHERE p2.company_id = c.id
       AND (p2.stage != 'none' OR COALESCE(p2.note, '') != '')
  )
  AND c.created_at < ?2
`;

const SELECT_SQL = `
  SELECT c.id, c.name, c.tab, c.grade, c.created_at
  FROM companies c LEFT JOIN progress p ON ${PROGRESS_ON_PROFILE}
  WHERE ${WHERE}
  ORDER BY c.created_at
`;

function parseDays(raw) {
  const days = raw === undefined || raw === null || raw === "" ? DEFAULT_DAYS : Number(raw);
  if (!Number.isFinite(days) || days < 1 || days > 365) return { error: "days must be between 1 and 365" };
  return { days };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));

  const { days, error } = parseDays(body.days);
  if (error) return badRequest(error);

  const profile = await resolveProfileId(env, url, body, userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const cutoff = Date.now() - days * 86400000;
  const dryRun = Boolean(body.dry_run);

  const { results } = await env.DB.prepare(SELECT_SQL).bind(profile.id, cutoff).all();

  if (dryRun) {
    return json({ dry_run: true, profile_id: profile.id, days, would_remove: results.length, rows: results });
  }
  if (!results.length) {
    return json({ profile_id: profile.id, days, removed: 0, rows: [] });
  }

  const ids = results.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const marks = chunk.map((_, n) => `?${n + 1}`).join(",");
    // The company row is going away, so its dependents go for EVERY profile,
    // not just this one — a scoped delete here would leave orphan rows that a
    // future company reusing the same slug would inherit. Which companies may
    // be deleted at all is already decided by the WHERE above.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM stage_history WHERE company_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM progress WHERE company_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM profile_companies WHERE company_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM companies WHERE id IN (${marks})`).bind(...chunk),
    ]);
  }

  return json({ profile_id: profile.id, days, removed: ids.length, rows: results });
}

/** GET returns the same list without deleting — used by the dashboard preview. */
export async function onRequestGet(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);

  const { days, error } = parseDays(url.searchParams.get("days"));
  if (error) return badRequest(error);

  const profile = await resolveProfileId(env, url, null, userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const cutoff = Date.now() - days * 86400000;
  const { results } = await env.DB.prepare(SELECT_SQL).bind(profile.id, cutoff).all();

  return json({ profile_id: profile.id, days, would_remove: results.length, rows: results });
}
