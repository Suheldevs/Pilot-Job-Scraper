/** Per-channel outreach templates.
 *
 *  There used to be one template (settings key `template`) behind both the
 *  WhatsApp and the email link, which forced one compromise message: WhatsApp
 *  wants two short lines and has no subject, email wants a subject and can
 *  carry a real pitch. They are stored separately now, one settings row per
 *  channel field.
 *
 *  The legacy key is still read on GET so nobody's existing message disappears
 *  the moment this ships — see MIGRATION below.
 */
import { json, badRequest } from "../lib/db.js";

const KEYS = {
  emailSubject: "tpl_email_subject",
  emailBody: "tpl_email_body",
  whatsappBody: "tpl_whatsapp_body",
  linkedinBody: "tpl_linkedin_body",
};
const LEGACY_KEY = "template";

// Fallback only. index.html owns the live copy of this string (`const SUBJECT`);
// it is duplicated here so a user who has never saved a template still gets a
// sensible subject instead of an empty one. Keep the two in sync.
const DEFAULT_EMAIL_SUBJECT = "Full-stack / AI developer (2 yrs, React · Node) — application";

// Long enough for a real email, short enough that a runaway paste cannot bloat
// the settings row. Values are truncated rather than rejected: silently losing
// a whole save because it ran 20 characters over is worse.
const MAX_LEN = 4000;

export async function onRequestGet(context) {
  const { env } = context;
  const wanted = [...Object.values(KEYS), LEGACY_KEY];
  const placeholders = wanted.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await env.DB
    .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .bind(...wanted)
    .all();

  const stored = new Map((results || []).map((r) => [r.key, r.value]));
  const rawLegacy = stored.get(LEGACY_KEY);
  const legacy = typeof rawLegacy === "string" && rawLegacy !== "" ? rawLegacy : null;

  // MIGRATION: a channel with no row of its own falls back to the one legacy
  // template (and, for email, to the subject index.html used to hard-code), so
  // an existing user's message is never silently lost. Per-channel rather than
  // all-or-nothing, so saving just WhatsApp does not blank out email either.
  // `migrated` tells the UI to prompt a save — the save is what actually
  // writes the new keys and retires the legacy one.
  let migrated = false;
  const body = (key) => {
    // `has` rather than a falsy check: an empty string is a deliberate save
    // ("cleared this channel"), and must not be refilled from the legacy key.
    if (stored.has(key)) return str(stored.get(key));
    if (legacy === null) return "";
    migrated = true;
    return legacy;
  };

  const payload = {
    email: {
      // The subject has no legacy row of its own — index.html hard-coded it —
      // so the default stands in whenever nothing was ever saved.
      subject: stored.has(KEYS.emailSubject) ? str(stored.get(KEYS.emailSubject)) : DEFAULT_EMAIL_SUBJECT,
      body: body(KEYS.emailBody),
    },
    whatsapp: { body: body(KEYS.whatsappBody) },
    linkedin: { body: body(KEYS.linkedinBody) },
  };
  if (migrated) payload.migrated = true;

  return json(payload);
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected { email:{subject,body}, whatsapp:{body}, linkedin:{body} }");
  }

  // Partial updates are the normal case — the settings UI saves the channel
  // being edited — so an absent channel or field leaves its row untouched
  // rather than being written as "".
  const updates = [];
  for (const [channel, fields] of [
    ["email", [["subject", KEYS.emailSubject], ["body", KEYS.emailBody]]],
    ["whatsapp", [["body", KEYS.whatsappBody]]],
    ["linkedin", [["body", KEYS.linkedinBody]]],
  ]) {
    const incoming = body[channel];
    if (incoming === undefined || incoming === null) continue;
    if (typeof incoming !== "object" || Array.isArray(incoming)) {
      return badRequest(`${channel} must be an object`);
    }
    for (const [field, key] of fields) {
      const value = incoming[field];
      if (value === undefined) continue;
      if (typeof value !== "string") return badRequest(`${channel}.${field} must be a string`);
      updates.push([key, value.slice(0, MAX_LEN)]);
    }
  }

  if (!updates.length) return badRequest("no template fields to save");

  await env.DB.batch(updates.map(([key, value]) => env.DB.prepare(`
    INSERT INTO settings (key, value) VALUES (?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(key, value)));

  return json({ ok: true, saved: updates.map(([key]) => key) });
}

const str = (v) => (v == null ? "" : String(v));
