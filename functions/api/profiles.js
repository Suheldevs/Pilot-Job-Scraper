/** GET  /api/profiles  — list all, with is_default and lead counts
 *  POST /api/profiles  — create; body may include `copy_from` to clone
 *
 *  Auth is handled by functions/_middleware.js for the whole /api/* tree, so
 *  nothing is re-checked here.
 */
import { json, badRequest, notFound } from "../lib/db.js";
import {
  rowToProfile,
  coerceField,
  WRITABLE_FIELDS,
  ARRAY_FIELDS,
  parseId,
} from "../lib/profile.js";

/** Owned leads plus adopted-but-not-owned ones, counted without double
 *  counting a company that is both. */
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
   ORDER BY p.is_default DESC, p.id ASC
`;

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(LIST_SQL).all();
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
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected a JSON object");
  }

  // `copy_from` seeds every writable field from an existing profile; anything
  // also present in the body then overrides it. Cloning is the normal way to
  // make a second profile, so the clone starts at version 1 of its own — it has
  // judged nothing yet.
  let base = null;
  if (body.copy_from !== undefined && body.copy_from !== null) {
    const fromId = parseId(body.copy_from);
    if (!fromId) return badRequest("copy_from must be a profile id");
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

  const columns = Object.keys(values);
  const now = Date.now();
  const placeholders = columns.map((_, i) => `?${i + 1}`).join(",");
  const row = await env.DB.prepare(`
    INSERT INTO profiles (${columns.join(",")}, version, is_default, created_at, updated_at)
    VALUES (${placeholders}, 1, 0, ?${columns.length + 1}, ?${columns.length + 2})
    RETURNING *
  `).bind(...columns.map((c) => values[c]), now, now).first();

  const out = rowToProfile(row);
  out.owned_leads = 0;
  out.adopted_leads = 0;
  out.lead_count = 0;
  return json(out, { status: 201 });
}
