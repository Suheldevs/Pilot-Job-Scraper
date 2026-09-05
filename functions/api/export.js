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
  const userId = context.data.userId;
  const url = new URL(request.url);

  const profile = await resolveProfileId(env, url, null, userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  // `p.lead_note` rather than `c.note`: since 011 the lead note lives on the
  // progress row and the company column is shared and write-dead, so exporting
  // it would put another profile's sentence in this profile's backup. The alias
  // is what rowToCompany reads to fill the response's `note` key — without it
  // every exported note comes back empty.
  const { results } = await env.DB.prepare(`
    SELECT c.*, p.stage, p.note AS stage_note, p.updated_at AS stage_updated_at,
           p.lead_note AS lead_note
    FROM companies c LEFT JOIN progress p ON ${PROGRESS_ON_PROFILE}
    WHERE ${VISIBLE_TO_PROFILE}
    ORDER BY c.tab, c.section, c.created_at
  `).bind(profile.id).all();

  // Scoped for the same reason as the board above: 010 keyed `settings` by
  // (profile_id, key), so an unscoped read hands back whichever profile's
  // `template` row SQLite reached first and writes a stranger's outreach message
  // into this profile's backup file.
  const template = await env.DB
    .prepare("SELECT value FROM settings WHERE profile_id = ?1 AND key = 'template'")
    .bind(profile.id)
    .first();

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
