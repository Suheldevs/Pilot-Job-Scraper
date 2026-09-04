import { json, badRequest } from "../../lib/db.js";

export async function onRequestGet(context) {
  const { env, params } = context;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(params.key).first();
  return json({ key: params.key, value: row ? row.value : null });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.value !== "string") return badRequest("value (string) required");

  await env.DB.prepare(`
    INSERT INTO settings (key, value) VALUES (?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(params.key, body.value).run();

  return json({ ok: true });
}
