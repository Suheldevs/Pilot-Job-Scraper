import { json, badRequest, notFound, VALID_STAGES } from "../../lib/db.js";

export async function onRequestGet(context) {
  const { env, params } = context;
  const row = await env.DB.prepare("SELECT * FROM progress WHERE company_id = ?1").bind(params.id).first();
  if (!row) return notFound();
  return json(row);
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const id = params.id;
  const body = await request.json().catch(() => null);
  if (!body || !VALID_STAGES.includes(body.stage)) return badRequest("valid stage required");

  const company = await env.DB.prepare("SELECT id FROM companies WHERE id = ?1").bind(id).first();
  if (!company) return notFound("company not found");

  const now = Date.now();
  const note = typeof body.note === "string" ? body.note : "";

  const statements = [
    env.DB.prepare(`
      INSERT INTO progress (company_id, stage, note, updated_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(company_id) DO UPDATE SET stage = excluded.stage, note = excluded.note, updated_at = excluded.updated_at
    `).bind(id, body.stage, note, now),
  ];

  // Only log a history row on an actual stage change, not a note-only edit.
  const current = await env.DB.prepare("SELECT stage FROM progress WHERE company_id = ?1").bind(id).first();
  if (!current || current.stage !== body.stage) {
    statements.push(
      env.DB.prepare("INSERT INTO stage_history (company_id, stage, at) VALUES (?1, ?2, ?3)").bind(id, body.stage, now)
    );
  }

  await env.DB.batch(statements);
  return json({ ok: true, updated_at: now });
}
