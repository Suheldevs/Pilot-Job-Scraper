/** Generic single-setting read/write.
 *
 *  010 keyed `settings` by (profile_id, key), so every statement here is
 *  scoped: the same key held by two profiles is two rows, and an unscoped read
 *  or write would cross tenants. `profile_id` is echoed back so a caller can
 *  see which profile answered when it did not name one.
 */
import { json, badRequest } from "../../lib/db.js";
import { resolveProfileId } from "../../lib/profile.js";

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  // Optional `?profile_id=`; absent means the default profile, so a client that
  // does not know about profiles reads exactly the value it read before.
  const profile = await resolveProfileId(env, url, null, context.data.userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const row = await env.DB
    .prepare("SELECT value FROM settings WHERE profile_id = ?1 AND key = ?2")
    .bind(profile.id, params.key)
    .first();
  return json({ key: params.key, value: row ? row.value : null, profile_id: profile.id });
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.value !== "string") return badRequest("value (string) required");

  const profile = await resolveProfileId(env, url, body, context.data.userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  // ON CONFLICT must name the whole primary key (profile_id, key) that 010
  // created; `key` alone matches no index now and would fail, and a row this
  // profile does not own must never be the one updated.
  await env.DB.prepare(`
    INSERT INTO settings (profile_id, key, value) VALUES (?1, ?2, ?3)
    ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value
  `).bind(profile.id, params.key, body.value).run();

  return json({ ok: true, profile_id: profile.id });
}
