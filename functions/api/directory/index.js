/** GET /api/directory?region=lko|ncr — the hand-researched company lists.
 *
 *  `directory` is shared reference data (migration 014): every user sees the
 *  same companies and contacts. What is private is the outreach status and
 *  note, joined in from `directory_progress` for the asking profile only —
 *  the same (profile_id, ...) scoping `progress` uses, so one user's "Called"
 *  never shows on another user's list.
 */
import { json, badRequest } from "../../lib/db.js";
import { resolveProfileId } from "../../lib/profile.js";

export const DIRECTORY_REGIONS = ["lko", "ncr"];

function safeArray(text) {
  try {
    const v = JSON.parse(text || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const region = url.searchParams.get("region");
  if (region && !DIRECTORY_REGIONS.includes(region)) return badRequest("region must be lko or ncr");

  const profile = await resolveProfileId(env, url, null, context.data.userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const query = `
    SELECT d.*, dp.status, dp.note AS my_note, dp.updated_at AS status_at
    FROM directory d
    LEFT JOIN directory_progress dp ON dp.dir_id = d.id AND dp.profile_id = ?1
    ${region ? "WHERE d.region = ?2" : ""}
    ORDER BY d.region, d.sort
  `;
  const stmt = region ? env.DB.prepare(query).bind(profile.id, region) : env.DB.prepare(query).bind(profile.id);
  const { results } = await stmt.all();
  return json(results.map((r) => ({
    ...r,
    emails: safeArray(r.emails),
    phones: safeArray(r.phones),
    status: r.status || "none",
    my_note: r.my_note || "",
    status_at: r.status_at || null,
  })));
}
