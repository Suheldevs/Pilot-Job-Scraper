import { json, rowToCompany } from "../lib/db.js";

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(`
    SELECT c.*, p.stage, p.note AS stage_note, p.updated_at AS stage_updated_at
    FROM companies c LEFT JOIN progress p ON p.company_id = c.id
    ORDER BY c.tab, c.section, c.created_at
  `).all();

  const template = await env.DB.prepare("SELECT value FROM settings WHERE key = 'template'").first();

  return json({
    exported_at: Date.now(),
    companies: results.map(rowToCompany),
    template: template ? template.value : "",
  }, {
    headers: {
      "Content-Disposition": `attachment; filename="pilot-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
