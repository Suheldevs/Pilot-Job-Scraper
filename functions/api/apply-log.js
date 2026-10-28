/** The auto-apply send log — the database copy of who was emailed, and when.
 *
 *  GET  /api/apply-log                     every row for the profile (restore + stats)
 *  POST /api/apply-log { action: "add", company_id, to_addr, sent_at, ... }
 *        — one first email. A company is logged once per profile (UNIQUE), so a
 *          retried POST cannot double-count; the first record wins.
 *  POST /api/apply-log { action: "update", company_id, followup_at | replied_at | bounced_at }
 *
 *  Profile-scoped like progress: the profile is resolved from an optional
 *  `?profile_id=`, defaulting to the user's default profile.
 */
import { json, badRequest } from "../lib/db.js";
import { resolveProfileId } from "../lib/profile.js";

const TEXT_FIELDS = ["company", "to_addr", "subject", "subject_tpl", "msg_id", "job", "tab", "grade", "platform"];
const TIME_FIELDS = ["followup_at", "replied_at", "bounced_at"];

export async function onRequestGet(context) {
  const { request, env } = context;
  const profile = await resolveProfileId(env, new URL(request.url), null, context.data.userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });
  const { results } = await env.DB
    .prepare("SELECT * FROM apply_log WHERE profile_id = ?1 ORDER BY sent_at DESC")
    .bind(profile.id).all();
  return json(results || []);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.company_id !== "string" || !body.company_id) return badRequest("company_id required");
  const profile = await resolveProfileId(env, new URL(request.url), body, context.data.userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  if (body.action === "add") {
    if (typeof body.to_addr !== "string" || !body.to_addr) return badRequest("to_addr required");
    const vals = TEXT_FIELDS.map((f) => String(body[f] ?? "").slice(0, 300));
    await env.DB.prepare(`
      INSERT INTO apply_log (profile_id, company_id, ${TEXT_FIELDS.join(", ")}, sent_at)
      VALUES (?1, ?2, ${TEXT_FIELDS.map((_, i) => `?${i + 3}`).join(", ")}, ?${TEXT_FIELDS.length + 3})
      ON CONFLICT(profile_id, company_id) DO NOTHING
    `).bind(profile.id, body.company_id, ...vals, Number(body.sent_at) || Date.now()).run();
    return json({ ok: true });
  }

  if (body.action === "update") {
    const sets = [], vals = [];
    for (const f of TIME_FIELDS) {
      if (body[f] !== undefined) { sets.push(`${f} = ?${vals.length + 3}`); vals.push(Number(body[f]) || Date.now()); }
    }
    if (!sets.length) return badRequest(`one of ${TIME_FIELDS.join(", ")} required`);
    await env.DB.prepare(`UPDATE apply_log SET ${sets.join(", ")} WHERE profile_id = ?1 AND company_id = ?2`)
      .bind(profile.id, body.company_id, ...vals).run();
    return json({ ok: true });
  }

  return badRequest("action must be 'add' or 'update'");
}
