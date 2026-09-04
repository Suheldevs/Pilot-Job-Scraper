/** GET /api/progress/:id  — this profile's stage and note for one company
 *  PUT /api/progress/:id  — set them
 *
 *  Both take the profile from an optional `?profile_id=` query parameter and
 *  fall back to the default profile when it is absent, so index.html — which
 *  does not send one — keeps hitting profile 1 exactly as it did before
 *  migration 008. `progress` is keyed by (profile_id, company_id) now, so a
 *  stage set here can never be read by another profile.
 */
import { json, badRequest, notFound, VALID_STAGES } from "../../lib/db.js";
import { resolveProfileId } from "../../lib/profile.js";

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  const profile = await resolveProfileId(env, url);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const row = await env.DB
    .prepare("SELECT * FROM progress WHERE profile_id = ?1 AND company_id = ?2")
    .bind(profile.id, params.id)
    .first();
  if (row) return json(row);

  // No row for this profile yet. Before 008 that could not really happen —
  // every writer seeded a 'none' row — but a profile that adopted a lead has
  // deliberately not been given one, because "no row" *is* 'none' and copying
  // 292 empty rows per profile would be waste. So answer the question the
  // caller actually asked instead of 404-ing on a company that exists: the
  // stage is 'none'. A 404 is still the answer for a company we do not have.
  const company = await env.DB.prepare("SELECT id FROM companies WHERE id = ?1").bind(params.id).first();
  if (!company) return notFound();

  return json({
    profile_id: profile.id,
    company_id: params.id,
    stage: "none",
    note: "",
    updated_at: null,
  });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const id = params.id;
  const body = await request.json().catch(() => null);
  if (!body || !VALID_STAGES.includes(body.stage)) return badRequest("valid stage required");

  const profile = await resolveProfileId(env, url, body);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const company = await env.DB.prepare("SELECT id FROM companies WHERE id = ?1").bind(id).first();
  if (!company) return notFound("company not found");

  const now = Date.now();
  const note = typeof body.note === "string" ? body.note : "";

  const statements = [
    env.DB.prepare(`
      INSERT INTO progress (profile_id, company_id, stage, note, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(profile_id, company_id) DO UPDATE SET stage = excluded.stage, note = excluded.note, updated_at = excluded.updated_at
    `).bind(profile.id, id, body.stage, note, now),
  ];

  // Only log a history row on an actual stage change, not a note-only edit.
  // Read scoped to this profile too: profile B moving a shared lead to
  // 'contacted' must log a transition even when profile A already had it there.
  const current = await env.DB
    .prepare("SELECT stage FROM progress WHERE profile_id = ?1 AND company_id = ?2")
    .bind(profile.id, id)
    .first();
  if (!current || current.stage !== body.stage) {
    statements.push(
      env.DB.prepare("INSERT INTO stage_history (profile_id, company_id, stage, at) VALUES (?1, ?2, ?3, ?4)")
        .bind(profile.id, id, body.stage, now)
    );
  }

  await env.DB.batch(statements);
  return json({ ok: true, profile_id: profile.id, updated_at: now });
}
