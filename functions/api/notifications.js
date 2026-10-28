/** The notification feed and the way events get into it.
 *
 *  GET  /api/notifications?limit=50        newest first, plus the unread count
 *  POST /api/notifications  { action: "read", ids?: [..] }   mark read (all when no ids)
 *  POST /api/notifications  { action: "notify", kind, title, body?, url? }
 *        — how push.py, auto_apply.py and the daily summary report what they
 *          did. Stored in the feed, then pushed to the user's phones.
 *
 *  Scoped to the signed-in user, not a profile: a notification is about the
 *  person ("HR replied"), and they should see it whichever profile is active.
 */
import { json, badRequest } from "../lib/db.js";
import { createNotification } from "../lib/notify.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
  const { results } = await env.DB
    .prepare("SELECT * FROM notifications WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2")
    .bind(userId, limit).all();
  const unread = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND read_at IS NULL")
    .bind(userId).first();
  return json({ items: results || [], unread: unread ? unread.n : 0 });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("invalid JSON body");

  if (body.action === "read") {
    const now = Date.now();
    if (Array.isArray(body.ids) && body.ids.length) {
      const ids = body.ids.map(Number).filter((n) => Number.isInteger(n)).slice(0, 200);
      const marks = ids.map((_, i) => `?${i + 3}`).join(",");
      await env.DB.prepare(`UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL AND id IN (${marks})`)
        .bind(now, userId, ...ids).run();
    } else {
      await env.DB.prepare("UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL")
        .bind(now, userId).run();
    }
    return json({ ok: true });
  }

  if (body.action === "notify") {
    if (!body.title || typeof body.title !== "string") return badRequest("title required");
    const out = await createNotification(env, userId, body);
    return json({ ok: true, ...out });
  }

  return badRequest("action must be 'read' or 'notify'");
}
