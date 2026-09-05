/** GET /api/profile/:id/similar
 *
 *  [{ id, similarity, shared_leads, owned }] — plus `name` only for profiles the
 *  caller owns — for every other profile whose weighted-Jaccard similarity
 *  clears the 0.6 threshold in PROFILE-CONTRACT.md. The formula itself lives in
 *  functions/lib/profile.js so the API and any future pipeline caller agree on
 *  it.
 *
 *  `shared_leads` is what adopting would actually gain you: how many of the
 *  other profile's leads this profile cannot already see.
 *
 *  WHY THIS ROUTE LOOKS ACROSS TENANTS AT ALL
 *  Similarity is deliberately computed over EVERY profile in the table,
 *  including profiles belonging to other users. That is the entire reason the
 *  feature exists: a new tenant whose targeting matches an existing one adopts
 *  their leads instead of re-running the scrape, and re-scraping is what gets
 *  this project rate-limited by LinkedIn and Naukri. Scoping this query to the
 *  caller's own profiles would leave a brand-new user with nothing to adopt —
 *  they own exactly one profile, and it is the one they are asking about.
 *
 *  WHY THE RESPONSE IS NOT THE SAME SHAPE FOR BOTH
 *  Computing over another tenant's row is not the same as returning it. The
 *  only things a caller needs in order to decide whether to adopt are: which id
 *  to POST to /adopt, how similar it is, and how many new leads it would bring.
 *  Everything else on the row is that tenant's business, and `name` is the
 *  sharpest of them — profiles are named after people ("Mohd Suhel" is profile
 *  1), so returning it would turn this endpoint into a user directory that any
 *  logged-in tenant could enumerate. So a profile the caller does not own is
 *  returned with id, similarity, shared_leads and `owned: false` and NOTHING
 *  else — never name, never a targeting field, never a count that is not already
 *  implied by shared_leads. Any new field added to this response must be added
 *  inside the `owned` branch unless it is provably not tenant data.
 */
import { json, badRequest, notFound } from "../../../lib/db.js";
import {
  rowToProfile,
  similarity,
  assertProfileOwner,
  SIMILARITY_THRESHOLD,
  parseId,
} from "../../../lib/profile.js";

export async function onRequestGet(context) {
  const { env, params } = context;
  const userId = context.data.userId;
  const id = parseId(params.id);
  if (!id) return badRequest("invalid profile id");

  // The profile being compared FROM must be the caller's. Without this, a
  // tenant could aim the comparison at someone else's profile and read that
  // profile's similarity fingerprint against the whole table.
  const owner = await assertProfileOwner(env, id, userId);
  if (owner.error) return json({ error: owner.error }, { status: owner.status });

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
  for (const { row: candidateRow, profile, score } of candidates) {
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

    // Ownership is read off the raw row: `rowToProfile` does not carry
    // `owner_user_id` through, and adding it there would push it into every
    // other profile response too. Compared with Number() on both sides because
    // the D1 column is INTEGER while the session subject arrives as whatever
    // _middleware.js decoded — a string "2" must not read as a different user
    // from 2, and an absent userId must fail closed (NaN matches nothing).
    const owned = Number(candidateRow.owner_user_id) === Number(userId);
    const entry = {
      id: profile.id,
      similarity: score,
      shared_leads: row?.n || 0,
      owned,
    };
    // `name` is the caller's own label for their own profile, so it is safe
    // here and useful — it is how a user tells their two profiles apart. See
    // the header: nothing else may join it.
    if (owned) entry.name = profile.name;
    out.push(entry);
  }

  out.sort((a, b) => b.similarity - a.similarity || a.id - b.id);
  return json(out);
}
