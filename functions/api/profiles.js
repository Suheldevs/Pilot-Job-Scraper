/** GET  /api/profiles  — list the caller's profiles, with is_default and counts
 *  POST /api/profiles  — create; body may include `copy_from` to clone
 *
 *  _middleware.js authenticates the whole /api/* tree, so the caller here is
 *  always *a* user — but since 010 that is no longer enough. `rowToProfile`
 *  returns identity fields (email, phone, linkedin, github, portfolio,
 *  resume_url, notice_period), so an unscoped listing would hand every tenant
 *  every other tenant's contact details on page load. Who is asking is
 *  `context.data.userId`, and both handlers below are scoped by it.
 */
import { json, badRequest, notFound } from "../lib/db.js";
import {
  rowToProfile,
  coerceField,
  assertProfileOwner,
  WRITABLE_FIELDS,
  ARRAY_FIELDS,
  parseId,
} from "../lib/profile.js";

/** Owned leads plus adopted-but-not-owned ones, counted without double
 *  counting a company that is both.
 *
 *  The `owner_user_id` predicate is on `profiles`, not on the lead counts: a
 *  profile's counts include leads it adopted from another tenant, because
 *  adopted leads are genuinely visible to it. Lead SHARING is the feature;
 *  identity is what must not cross. */
const LIST_SQL = `
  SELECT p.*,
         (SELECT COUNT(*) FROM companies c WHERE c.profile_id = p.id) AS owned_leads,
         (SELECT COUNT(*) FROM profile_companies pc
            WHERE pc.profile_id = p.id
              AND NOT EXISTS (
                SELECT 1 FROM companies c2
                 WHERE c2.id = pc.company_id AND c2.profile_id = p.id
              )) AS adopted_leads
    FROM profiles p
   WHERE p.owner_user_id = ?1
   ORDER BY p.is_default DESC, p.id ASC
`;

export async function onRequestGet(context) {
  const { env } = context;
  const userId = context.data.userId;
  const { results } = await env.DB.prepare(LIST_SQL).bind(userId).all();
  return json(
    (results || []).map((row) => {
      const out = rowToProfile(row);
      out.owned_leads = row.owned_leads || 0;
      out.adopted_leads = row.adopted_leads || 0;
      out.lead_count = out.owned_leads + out.adopted_leads;
      return out;
    })
  );
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const isAdmin = !!context.data.user?.is_admin;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected a JSON object");
  }

  // `copy_from` seeds every writable field from an existing profile; anything
  // also present in the body then overrides it. Cloning is the normal way to
  // make a second profile, so the clone starts at version 1 of its own — it has
  // judged nothing yet.
  //
  // The source must be a profile the caller owns. Cloning copies every writable
  // field — identity *and* targeting — so allowing an arbitrary id would let one
  // tenant read another's phone number and lead targeting through a create call,
  // which is exactly what the scoped GET above refuses to do.
  let base = null;
  if (body.copy_from !== undefined && body.copy_from !== null) {
    const fromId = parseId(body.copy_from);
    if (!fromId) return badRequest("copy_from must be a profile id");
    const owner = await assertProfileOwner(env, fromId, userId, isAdmin);
    if (owner.error) return json({ error: owner.error }, { status: owner.status });
    base = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(fromId).first();
    if (!base) return notFound(`profile ${fromId} not found (copy_from)`);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name && !base) return badRequest("name is required");

  const values = {};
  for (const field of WRITABLE_FIELDS) {
    if (base) {
      values[field] = ARRAY_FIELDS.includes(field) ? String(base[field] ?? "[]") : base[field];
    }
  }
  if (base) values.name = name || `${base.name} (copy)`;
  else values.name = name;

  for (const field of WRITABLE_FIELDS) {
    if (!(field in body)) continue;
    if (field === "name") continue; // already handled, and required
    const { value, error } = coerceField(field, body[field]);
    if (error) return badRequest(error);
    values[field] = value;
  }

  // An admin may create a profile FOR another user — onboarding a new tenant is
  // administration, and the alternative is making them create it themselves
  // before they have anything to look at. Everyone else silently owns what they
  // create: a non-admin naming `owner_user_id` is refused rather than ignored,
  // because quietly discarding it would let a client believe it had handed a
  // profile to someone when it had actually kept it.
  let ownerUserId = userId;
  if (body.owner_user_id !== undefined && body.owner_user_id !== null) {
    if (!isAdmin) return json({ error: "only an admin may set owner_user_id" }, { status: 403 });
    const target = parseId(body.owner_user_id);
    if (!target) return badRequest("owner_user_id must be a positive integer");
    const exists = await env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(target).first();
    if (!exists) return notFound(`user ${target} not found (owner_user_id)`);
    ownerUserId = target;
  }

  const columns = Object.keys(values);
  const now = Date.now();
  const placeholders = columns.map((_, i) => `?${i + 1}`).join(",");
  // `owner_user_id` comes from `ownerUserId` above — the session for everyone
  // except an admin who explicitly named a target, which is checked there. It is
  // never taken raw from the body: a client that could name its own owner could
  // hand a profile to another tenant, or plant one inside theirs.
  const row = await env.DB.prepare(`
    INSERT INTO profiles (${columns.join(",")}, version, is_default, created_at, updated_at, owner_user_id)
    VALUES (${placeholders}, 1, 0, ?${columns.length + 1}, ?${columns.length + 2}, ?${columns.length + 3})
    RETURNING *
  `).bind(...columns.map((c) => values[c]), now, now, ownerUserId).first();

  const out = rowToProfile(row);
  out.owned_leads = 0;
  out.adopted_leads = 0;
  out.lead_count = 0;
  return json(out, { status: 201 });
}
