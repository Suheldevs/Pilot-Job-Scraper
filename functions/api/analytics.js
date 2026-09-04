import { json } from "../lib/db.js";

export async function onRequestGet(context) {
  const { env } = context;
  const sixtyDaysAgo = Date.now() - 60 * 86400000;

  const [byTab, byStage, bySource, byScrapedFrom, timeline, byGrade, byPlatform] = await Promise.all([
    env.DB.prepare(`
      SELECT c.tab,
        COUNT(*) AS total,
        SUM(CASE WHEN COALESCE(p.stage,'none') != 'none' THEN 1 ELSE 0 END) AS contacted,
        SUM(CASE WHEN p.stage = 'replied' THEN 1 ELSE 0 END) AS replied,
        SUM(CASE WHEN p.stage = 'interviewing' THEN 1 ELSE 0 END) AS interviewing,
        SUM(CASE WHEN p.stage = 'offer' THEN 1 ELSE 0 END) AS offer,
        SUM(CASE WHEN p.stage = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM companies c LEFT JOIN progress p ON p.company_id = c.id
      GROUP BY c.tab
    `).all(),
    env.DB.prepare(`
      SELECT COALESCE(p.stage,'none') AS stage, COUNT(*) AS count
      FROM companies c LEFT JOIN progress p ON p.company_id = c.id
      GROUP BY stage
    `).all(),
    env.DB.prepare(`SELECT source, COUNT(*) AS count FROM companies GROUP BY source`).all(),
    env.DB.prepare(`
      SELECT scraped_from, COUNT(*) AS count FROM companies
      WHERE scraped_from != '' GROUP BY scraped_from
    `).all(),
    env.DB.prepare(`
      SELECT date(at/1000, 'unixepoch') AS day, stage, COUNT(*) AS count
      FROM stage_history WHERE at >= ?1
      GROUP BY day, stage ORDER BY day ASC
    `).bind(sixtyDaysAgo).all(),
    // tag 2 — lead strength, and how each grade is converting
    env.DB.prepare(`
      SELECT c.grade,
        COUNT(*) AS total,
        SUM(CASE WHEN COALESCE(p.stage,'none') != 'none' THEN 1 ELSE 0 END) AS contacted,
        SUM(CASE WHEN p.stage IN ('replied','interviewing','offer') THEN 1 ELSE 0 END) AS responded
      FROM companies c LEFT JOIN progress p ON p.company_id = c.id
      WHERE c.grade != '' GROUP BY c.grade ORDER BY c.grade
    `).all(),
    // tag 1 — provenance
    env.DB.prepare(`
      SELECT platform, COUNT(*) AS count FROM companies
      WHERE platform != '' GROUP BY platform ORDER BY count DESC
    `).all(),
  ]);

  const totals = { companies: 0, none: 0, contacted: 0, replied: 0, interviewing: 0, offer: 0, rejected: 0 };
  for (const row of byStage.results) {
    totals.companies += row.count;
    totals[row.stage] = (totals[row.stage] || 0) + row.count;
  }
  const everContacted = totals.companies - totals.none;
  const responded = totals.replied + totals.interviewing + totals.offer;
  const responseRate = everContacted > 0 ? Math.round((responded / everContacted) * 1000) / 10 : 0;

  return json({
    totals,
    response_rate: responseRate,
    by_tab: byTab.results,
    by_stage: byStage.results,
    by_source: bySource.results,
    by_scraped_from: byScrapedFrom.results,
    timeline: timeline.results,
    by_grade: byGrade.results,
    by_platform: byPlatform.results,
  });
}
