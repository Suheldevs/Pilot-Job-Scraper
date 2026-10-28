/** One way in for every notification: store it in the feed, then push it.
 *
 *  The feed row is written first and unconditionally — a push can be dropped by
 *  the phone, the browser or the push service, and the bell in the dashboard is
 *  what guarantees nothing is missed. The push is then sent to each of the
 *  user's devices, filtered by their `notify_prefs` setting. Push failures never
 *  fail the request; a subscription the push service calls gone (404/410) is
 *  deleted so it is not retried forever.
 */
import { sendPush } from "./webpush.js";
import { defaultProfileId } from "./profile.js";

export const KINDS = ["reply", "applied", "reminder", "scrape", "summary", "error", "info"];
// Every kind is pushed unless switched off in the dashboard. Replies and errors
// are the ones worth waking a phone for, so they go out as high urgency.
const URGENT = new Set(["reply", "error"]);
const KEEP = 300;

export async function notifyPrefs(env, userId) {
  const pid = await defaultProfileId(env, userId);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE profile_id = ?1 AND key = 'notify_prefs'")
    .bind(pid).first();
  try {
    return { ...Object.fromEntries(KINDS.map((k) => [k, true])), ...(row ? JSON.parse(row.value) : {}) };
  } catch {
    return Object.fromEntries(KINDS.map((k) => [k, true]));
  }
}

export async function createNotification(env, userId, { kind = "info", title, body = "", url = "/" }) {
  if (!KINDS.includes(kind)) kind = "info";
  const now = Date.now();
  const res = await env.DB.prepare(
    "INSERT INTO notifications (user_id, kind, title, body, url, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(userId, kind, String(title).slice(0, 200), String(body).slice(0, 2000), String(url).slice(0, 300), now).run();
  // Keep the feed bounded: the newest KEEP rows per user.
  await env.DB.prepare(`DELETE FROM notifications WHERE user_id = ?1 AND id NOT IN
    (SELECT id FROM notifications WHERE user_id = ?1 ORDER BY id DESC LIMIT ${KEEP})`).bind(userId).run();

  const pushed = { sent: 0, failed: 0, skipped: false };
  const prefs = await notifyPrefs(env, userId);
  if (!prefs[kind] || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    pushed.skipped = true;
    return { id: res.meta?.last_row_id, pushed };
  }
  const { results } = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?1").bind(userId).all();
  const payload = { title, body, url, kind, tag: `pilot-${kind}-${now}` };
  for (const sub of results || []) {
    try {
      const status = await sendPush(env, sub, payload, { urgent: URGENT.has(kind) });
      if (status === 404 || status === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(sub.id).run();
        pushed.failed++;
      } else if (status >= 200 && status < 300) {
        await env.DB.prepare("UPDATE push_subscriptions SET last_ok_at = ?1 WHERE id = ?2").bind(now, sub.id).run();
        pushed.sent++;
      } else {
        pushed.failed++;
      }
    } catch {
      pushed.failed++;
    }
  }
  return { id: res.meta?.last_row_id, pushed };
}
