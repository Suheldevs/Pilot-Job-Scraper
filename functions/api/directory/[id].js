/** PUT /api/directory/:id — set this profile's outreach status and/or note
 *  for one directory company. Body: { status?, note? }.
 *
 *  Each key is written only when present, like `lead_note` on /api/progress:
 *  tapping a status chip sends no note and must not erase the one typed earlier,
 *  and the note box autosaves without moving the status.
 */
import { json, badRequest, notFound, companyIdParam } from "../../lib/db.js";
import { resolveProfileId } from "../../lib/profile.js";

export const DIRECTORY_STATUSES = ["none", "scheduled", "contacted", "called", "whatsapp", "emailed", "replied", "interview", "no"];

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const id = companyIdParam(params);
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("JSON body required");

  const hasStatus = body.status !== undefined;
  const hasNote = typeof body.note === "string";
  if (!hasStatus && !hasNote) return badRequest("status or note required");
  if (hasStatus && !DIRECTORY_STATUSES.includes(body.status)) return badRequest("invalid status");

  const profile = await resolveProfileId(env, url, body, context.data.userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const row = await env.DB.prepare("SELECT id FROM directory WHERE id = ?1").bind(id).first();
  if (!row) return notFound("directory company not found");

  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO directory_progress (profile_id, dir_id, status, note, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(profile_id, dir_id) DO UPDATE SET
      status     = CASE WHEN ?6 = 1 THEN excluded.status ELSE directory_progress.status END,
      note       = CASE WHEN ?7 = 1 THEN excluded.note ELSE directory_progress.note END,
      updated_at = CASE WHEN ?6 = 1 THEN excluded.updated_at ELSE directory_progress.updated_at END
  `).bind(
    profile.id, id,
    hasStatus ? body.status : "none",
    hasNote ? body.note.slice(0, 2000) : "",
    now,
    hasStatus ? 1 : 0,
    hasNote ? 1 : 0,
  ).run();

  return json({ ok: true, id, status: hasStatus ? body.status : undefined, updated_at: now });
}
