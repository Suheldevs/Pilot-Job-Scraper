/** Phone push subscriptions.
 *
 *  GET    /api/push                          { key, devices } — the VAPID public key the
 *                                            browser subscribes with, and how many
 *                                            devices this user has subscribed
 *  POST   /api/push { subscription, label }  save this device (upsert by endpoint)
 *  POST   /api/push { action: "test" }       send a test notification to every device
 *  DELETE /api/push { endpoint }             forget this device
 */
import { json, badRequest } from "../lib/db.js";
import { createNotification } from "../lib/notify.js";

export async function onRequestGet(context) {
  const { env } = context;
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1")
    .bind(context.data.userId).first();
  return json({ key: env.VAPID_PUBLIC_KEY || "", devices: n ? n.n : 0 });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("invalid JSON body");

  if (body.action === "test") {
    // `all: true` sends one of each kind, so every look (buttons, sticky reply,
    // silent scrape) can be checked on the phone in one go.
    const samples = body.all ? [
      { kind: "applied", title: "Applied to 2 companies (test)", body: "• CepiaLabs — Full Stack Developer\n• Nimbus Softech — MERN Stack Developer" },
      { kind: "summary", title: "Pilot today — 2 applied, 1 replied (test)", body: "✉️ Applied to 2 today\n🔎 40 new leads (12 grade A/B)" },
      { kind: "scrape", title: "Scrape done — 40 leads (test)", body: "Lucknow 3 · Noida 9 · Remote 12\n5 with an HR email" },
      { kind: "reply", title: "CepiaLabs replied! (test)", body: "About: Full Stack Developer\nFrom sakshi.gupta@cepialabs.in — check your Gmail." },
    ] : [{ kind: "info", title: "Pilot notifications are on",
           body: "You'll hear about replies, applications, scrapes and the 5pm summary here." }];
    let out = null;
    for (const n of samples) out = await createNotification(env, userId, n);
    return json({ ok: true, sent: samples.length, ...out });
  }

  const sub = body.subscription;
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return badRequest("subscription with endpoint and keys required");
  }
  if (!/^https:\/\//.test(sub.endpoint)) return badRequest("endpoint must be https");
  await env.DB.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
      auth = excluded.auth, label = excluded.label
  `).bind(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(body.label || "").slice(0, 80), Date.now()).run();
  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.endpoint !== "string") return badRequest("endpoint required");
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2")
    .bind(context.data.userId, body.endpoint).run();
  return json({ ok: true });
}
