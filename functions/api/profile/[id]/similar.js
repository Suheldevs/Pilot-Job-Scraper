/** GET /api/profile/:id/similar
 *
 *  [{ id, name, similarity, shared_leads }] for every other profile whose
 *  weighted-Jaccard similarity clears the 0.6 threshold in PROFILE-CONTRACT.md.
 *  The formula itself lives in functions/lib/profile.js so the API and any
 *  future pipeline caller agree on it.
 *
 *  `shared_leads` is what adopting would actually gain you: how many of the
 *  other profile's leads this profile cannot already see.
 */
import { json, badRequest, notFound } from "../../../lib/db.js";
import { rowToProfile, similarity, SIMILARITY_THRESHOLD, parseId } from "../../../lib/profile.js";

export async function onRequestGet(context) {
  const { env, params } = context;
  const id = parseId(params.id);
  if (!id) return badRequest("invalid profile id");

  const mine = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(id).first();
  if (!mine) return notFound("profile not found");
  const me = rowToProfile(mine);

  const { results } = await env.DB.prepare("SELECT * FROM profiles WHERE id != ?1 ORDER BY id ASC")
    .bind(id)
    .all();

  const candidates = (results || [])
    .map((row) => ({ row, profile: rowToProfile(row) }))
    .map(({ row, profile }) => ({ row, profile, score: similarity(me, profile) }))
    .filter(({ score }) => score >= SIMILARITY_THRESHOLD);

  const out = [];
  for (const { profile, score } of candidates) {
    // A lead is visible to a profile when it owns the company row or has
    // adopted it. Counted in SQL rather than in JS so this stays one query per
    // candidate instead of pulling 292 rows per profile.
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT id AS company_id FROM companies WHERE profile_id = ?1
        UNION
        SELECT company_id FROM profile_companies WHERE profile_id = ?1
      ) theirs
      WHERE theirs.company_id NOT IN (
        SELECT id FROM companies WHERE profile_id = ?2
        UNION
        SELECT company_id FROM profile_companies WHERE profile_id = ?2
      )
    `).bind(profile.id, id).first();

    out.push({
      id: profile.id,
      name: profile.name,
      similarity: score,
      shared_leads: row?.n || 0,
    });
  }

  out.sort((a, b) => b.similarity - a.similarity || a.id - b.id);
  return json(out);
}
