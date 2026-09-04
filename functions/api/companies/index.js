import { json, badRequest, rowToCompany, defaultSection, VALID_TABS } from "../../lib/db.js";
import { companyId } from "../../lib/slug.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab");

  const query = `
    SELECT c.*, p.stage, p.note AS stage_note, p.updated_at AS stage_updated_at
    FROM companies c
    LEFT JOIN progress p ON p.company_id = c.id
    ${tab ? "WHERE c.tab = ?1" : ""}
    ORDER BY c.created_at DESC
  `;
  const stmt = tab ? env.DB.prepare(query).bind(tab) : env.DB.prepare(query);
  const { results } = await stmt.all();
  return json(results.map(rowToCompany));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.tab) return badRequest("name and tab are required");
  if (!VALID_TABS.includes(body.tab)) return badRequest("invalid tab");

  const hr = Array.isArray(body.hr) ? body.hr : [];
  const em = Array.isArray(body.em) ? body.em : [];
  const wa = Array.isArray(body.wa) ? body.wa : [];
  const id = companyId(body.tab, body.name);
  const section = body.section || defaultSection(body.tab, { hr, wa, job: body.job_url });
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO companies (id, tab, section, name, li, hr, em, wa, land, note, job_url, job_title,
                             source, scraped_from, created_at, platform)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
      ON CONFLICT(id) DO UPDATE SET
        li = excluded.li, note = excluded.note,
        job_url = excluded.job_url, job_title = excluded.job_title
    `).bind(
      id, body.tab, section, body.name, body.li || "",
      JSON.stringify(hr), JSON.stringify(em), JSON.stringify(wa),
      body.land || "", body.note || "", body.job_url || "", body.job_title || "",
      body.source || "manual", body.scraped_from || "", now,
      body.platform || "manual"
    ),
    env.DB.prepare(`
      INSERT INTO progress (company_id, stage, note, updated_at)
      VALUES (?1, 'none', '', ?2)
      ON CONFLICT(company_id) DO NOTHING
    `).bind(id, now),
  ]);

  return json({ id }, { status: 201 });
}
