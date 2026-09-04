/** POST /api/profile/:id/adopt  { from_profile_id }
 *
 *  Makes another profile's leads visible to this one WITHOUT copying company
 *  rows. Duplicating them would fork the contact data, the grade and the JD
 *  excerpt — two rows that drift apart for the same opening — and would break
 *  `companies.id`, which is a slug of the name and therefore already unique per
 *  company. So adoption is a row in the `profile_companies` join table: one
 *  company, many profiles that can see it.
 *
 *  Stages and notes are NOT shared. Migration 008 re-keyed `progress` (and
 *  `stage_history`) to (profile_id, company_id), so an adopted lead starts at
 *  'none' for the adopting profile no matter what the originating profile had
 *  set, and either profile can move it without the other seeing a change. That
 *  is what PROFILE-CONTRACT.md means by "leads are shared, but each profile
 *  keeps its own `progress` row".
 *
 *  No `progress` rows are written here on purpose: an absent row already reads
 *  as 'none' everywhere (the readers all LEFT JOIN), so seeding 292 empty rows
 *  per adopting profile would cost writes and buy nothing.
 */
import { json, badRequest, notFound } from "../../../lib/db.js";
import { rowToProfile, similarity, SIMILARITY_THRESHOLD, parseId } from "../../../lib/profile.js";

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const id = parseId(params.id);
  if (!id) return badRequest("invalid profile id");

  const body = await request.json().catch(() => null);
  const fromId = parseId(body?.from_profile_id);
  if (!fromId) return badRequest("from_profile_id is required");
  if (fromId === id) return badRequest("cannot adopt from the same profile");

  const mineRow = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(id).first();
  if (!mineRow) return notFound("profile not found");
  const fromRow = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(fromId).first();
  if (!fromRow) return notFound(`profile ${fromId} not found`);

  const score = similarity(rowToProfile(mineRow), rowToProfile(fromRow));
  // The point of adoption is skipping a re-scrape for a profile that would
  // have found the same leads. Adopting across a dissimilar profile would just
  // import irrelevant companies, so it is refused with the number that failed —
  // `force: true` is the deliberate override.
  if (score < SIMILARITY_THRESHOLD && body?.force !== true) {
    return json(
      {
        error: `profile ${fromId} is only ${score} similar (threshold ${SIMILARITY_THRESHOLD}); pass force: true to adopt anyway`,
        similarity: score,
      },
      { status: 409 }
    );
  }

  // Every company visible to the source profile — owned or itself adopted —
  // that this profile cannot already see.
  const { results } = await env.DB.prepare(`
    SELECT theirs.company_id AS company_id FROM (
      SELECT id AS company_id FROM companies WHERE profile_id = ?1
      UNION
      SELECT company_id FROM profile_companies WHERE profile_id = ?1
    ) theirs
    WHERE theirs.company_id NOT IN (
      SELECT id FROM companies WHERE profile_id = ?2
      UNION
      SELECT company_id FROM profile_companies WHERE profile_id = ?2
    )
  `).bind(fromId, id).all();

  const ids = (results || []).map((r) => r.company_id);
  if (!ids.length) {
    return json({ ok: true, adopted: 0, similarity: score, message: "nothing new to adopt" });
  }

  const now = Date.now();
  // Chunked because D1 caps how many statements one batch may carry, and the
  // parent profile has 292 leads today with room to grow.
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    await env.DB.batch(
      ids.slice(i, i + CHUNK).map((companyId) =>
        env.DB.prepare(`
          INSERT INTO profile_companies (profile_id, company_id, adopted_at)
          VALUES (?1, ?2, ?3)
          ON CONFLICT(profile_id, company_id) DO NOTHING
        `).bind(id, companyId, now)
      )
    );
  }

  return json({
    ok: true,
    adopted: ids.length,
    from_profile_id: fromId,
    similarity: score,
    // Surfaced in the response, not just the source comments, so a UI knows
    // what it got: shared visibility, independent progress.
    note: "leads are shared, not copied; stage and notes are per profile (progress is keyed by profile_id + company_id) and start at 'none' here",
  });
}
