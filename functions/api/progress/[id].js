/** GET /api/progress/:id  — this profile's stage and notes for one company
 *  PUT /api/progress/:id  — set them
 *
 *  TWO notes live on this row and they are not the same field. `note` (exposed
 *  elsewhere as `stage_note`) is about the conversation — "waiting on their
 *  reply". `lead_note`, added by 011, is about the lead itself — "careers page
 *  lists 3 backend roles" — and is what the board renders as a company's note.
 *  It moved here from the shared `companies.note`, which is write-dead, so this
 *  endpoint is now the ONLY way a lead note can be saved.
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
  const userId = context.data.userId;
  const url = new URL(request.url);

  const profile = await resolveProfileId(env, url, null, userId);
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
    lead_note: "",
    updated_at: null,
  });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);
  const id = params.id;
  const body = await request.json().catch(() => null);
  if (!body || !VALID_STAGES.includes(body.stage)) return badRequest("valid stage required");

  const profile = await resolveProfileId(env, url, body, userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const company = await env.DB.prepare("SELECT id FROM companies WHERE id = ?1").bind(id).first();
  if (!company) return notFound("company not found");

  const now = Date.now();
  const note = typeof body.note === "string" ? body.note : "";

  // `lead_note` is written only when the key is actually present, unlike `note`.
  // The stage buttons PUT here on every card move and send no lead note, so
  // treating an absent key as "" the way `note` does would erase the lead note
  // each time somebody dragged a card — and there is no second writer to restore
  // it from, since `companies.note` is write-dead. A present empty string is
  // still honoured: that is a deliberate "clear this note".
  const hasLeadNote = typeof body.lead_note === "string";
  const leadNote = hasLeadNote ? body.lead_note : "";

  const statements = [
    // The flag rides in as its own bind rather than being branched on in JS,
    // so there is one statement and one conflict target to keep in step.
    env.DB.prepare(`
      INSERT INTO progress (profile_id, company_id, stage, note, updated_at, lead_note)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(profile_id, company_id) DO UPDATE SET
        stage = excluded.stage,
        note = excluded.note,
        updated_at = excluded.updated_at,
        lead_note = CASE WHEN ?7 = 1 THEN excluded.lead_note ELSE progress.lead_note END
    `).bind(profile.id, id, body.stage, note, now, leadNote, hasLeadNote ? 1 : 0),
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
  // Echo whether the lead note was written. Sending `lead_note` as anything but
  // a string is silently a no-op above, and a save that quietly did nothing is
  // exactly the failure the board would never notice.
  return json({ ok: true, profile_id: profile.id, updated_at: now, lead_note: hasLeadNote });
}
