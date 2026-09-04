/** GET /api/export[?profile_id=N] — JSON backup of one profile's board.
 *
 *  Scoped since migration 008: the export carries the stages and notes of the
 *  requesting profile, for the leads that profile owns or has adopted. An
 *  unscoped export would have mixed one profile's leads with another's stages,
 *  and re-importing it would have written those stages back over the top.
 *
 *  No `?profile_id=` means the default profile, so the dashboard's
 *  "Download JSON backup" link keeps producing what it always produced.
 */
import { json, rowToCompany } from "../lib/db.js";
import { resolveProfileId, VISIBLE_TO_PROFILE, PROGRESS_ON_PROFILE } from "../lib/profile.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const profile = await resolveProfileId(env, url);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const { results } = await env.DB.prepare(`
    SELECT c.*, p.stage, p.note AS stage_note, p.updated_at AS stage_updated_at
    FROM companies c LEFT JOIN progress p ON ${PROGRESS_ON_PROFILE}
    WHERE ${VISIBLE_TO_PROFILE}
    ORDER BY c.tab, c.section, c.created_at
  `).bind(profile.id).all();

  const template = await env.DB.prepare("SELECT value FROM settings WHERE key = 'template'").first();

  return json({
    exported_at: Date.now(),
    profile_id: profile.id,
    companies: results.map(rowToCompany),
    template: template ? template.value : "",
  }, {
    headers: {
      "Content-Disposition": `attachment; filename="pilot-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
