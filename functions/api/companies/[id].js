import { json, badRequest, notFound } from "../../lib/db.js";

export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const id = params.id;
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("invalid JSON body");

  const existing = await env.DB.prepare("SELECT id FROM companies WHERE id = ?1").bind(id).first();
  if (!existing) return notFound("company not found");

  const fields = [];
  const values = [];
  const editable = { li: "li", note: "note", land: "land", section: "section" };
  for (const [key, col] of Object.entries(editable)) {
    if (key in body) { fields.push(`${col} = ?`); values.push(body[key]); }
  }
  for (const key of ["hr", "em", "wa"]) {
    if (key in body && Array.isArray(body[key])) {
      fields.push(`${key} = ?`);
      values.push(JSON.stringify(body[key]));
    }
  }
  if (body.job_url !== undefined) { fields.push("job_url = ?"); values.push(body.job_url); }
  if (body.job_title !== undefined) { fields.push("job_title = ?"); values.push(body.job_title); }

  if (!fields.length) return badRequest("no editable fields provided");

  values.push(id);
  await env.DB.prepare(`UPDATE companies SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const id = params.id;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM progress WHERE company_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM stage_history WHERE company_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM companies WHERE id = ?1").bind(id),
  ]);
  return json({ ok: true });
}
