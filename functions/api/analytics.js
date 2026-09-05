/** GET /api/analytics[?profile_id=N]
 *
 *  Every aggregate here is per-profile since migration 008. Two scopings are
 *  needed and they are not interchangeable:
 *
 *    which companies count   — the ones this profile owns or has adopted
 *                              (`VISIBLE_TO_PROFILE`)
 *    whose stage counts      — this profile's `progress` row, via the join
 *                              condition (`PROGRESS_ON_PROFILE`)
 *
 *  Getting only the first would count the right companies with another
 *  profile's stages attached; getting only the second would report this
 *  profile's stages across every profile's leads. `timeline` reads
 *  `stage_history`, which carries its own `profile_id`, so it filters directly.
 *
 *  With no `?profile_id=` the default profile is used, so the dashboard — which
 *  sends none — gets byte-identical numbers to before 008.
 */
import { json } from "../lib/db.js";
import { resolveProfileId, VISIBLE_TO_PROFILE, PROGRESS_ON_PROFILE } from "../lib/profile.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);
  const sixtyDaysAgo = Date.now() - 60 * 86400000;

  const profile = await resolveProfileId(env, url, null, userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });
  const pid = profile.id;

  // ?1 is the profile id in every statement below; ?2, where present, is a
  // timestamp. Keeping the numbering uniform is what stops a copy-paste from
  // scoping one aggregate and silently leaving the next one global.
  const [byTab, byStage, bySource, byScrapedFrom, timeline, byGrade, byPlatform] = await Promise.all([
    env.DB.prepare(`
      SELECT c.tab,
        COUNT(*) AS total,
        SUM(CASE WHEN COALESCE(p.stage,'none') != 'none' THEN 1 ELSE 0 END) AS contacted,
        SUM(CASE WHEN p.stage = 'replied' THEN 1 ELSE 0 END) AS replied,
        SUM(CASE WHEN p.stage = 'interviewing' THEN 1 ELSE 0 END) AS interviewing,
        SUM(CASE WHEN p.stage = 'offer' THEN 1 ELSE 0 END) AS offer,
        SUM(CASE WHEN p.stage = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM companies c LEFT JOIN progress p ON ${PROGRESS_ON_PROFILE}
      WHERE ${VISIBLE_TO_PROFILE}
      GROUP BY c.tab
    `).bind(pid).all(),
    env.DB.prepare(`
      SELECT COALESCE(p.stage,'none') AS stage, COUNT(*) AS count
      FROM companies c LEFT JOIN progress p ON ${PROGRESS_ON_PROFILE}
      WHERE ${VISIBLE_TO_PROFILE}
      GROUP BY stage
    `).bind(pid).all(),
    env.DB.prepare(`
      SELECT c.source AS source, COUNT(*) AS count FROM companies c
      WHERE ${VISIBLE_TO_PROFILE}
      GROUP BY c.source
    `).bind(pid).all(),
    env.DB.prepare(`
      SELECT c.scraped_from AS scraped_from, COUNT(*) AS count FROM companies c
      WHERE c.scraped_from != '' AND ${VISIBLE_TO_PROFILE}
      GROUP BY c.scraped_from
    `).bind(pid).all(),
    // `stage_history` is keyed by (profile_id, company_id) worth of scoping in
    // its own right, so no join to `companies` is needed — and none is wanted:
    // a transition this profile recorded stays in its timeline even if the
    // company was later pruned.
    env.DB.prepare(`
      SELECT date(at/1000, 'unixepoch') AS day, stage, COUNT(*) AS count
      FROM stage_history WHERE profile_id = ?1 AND at >= ?2
      GROUP BY day, stage ORDER BY day ASC
    `).bind(pid, sixtyDaysAgo).all(),
    // tag 2 — lead strength, and how each grade is converting
    env.DB.prepare(`
      SELECT c.grade,
        COUNT(*) AS total,
        SUM(CASE WHEN COALESCE(p.stage,'none') != 'none' THEN 1 ELSE 0 END) AS contacted,
        SUM(CASE WHEN p.stage IN ('replied','interviewing','offer') THEN 1 ELSE 0 END) AS responded
      FROM companies c LEFT JOIN progress p ON ${PROGRESS_ON_PROFILE}
      WHERE c.grade != '' AND ${VISIBLE_TO_PROFILE}
      GROUP BY c.grade ORDER BY c.grade
    `).bind(pid).all(),
    // tag 1 — provenance
    env.DB.prepare(`
      SELECT c.platform AS platform, COUNT(*) AS count FROM companies c
      WHERE c.platform != '' AND ${VISIBLE_TO_PROFILE}
      GROUP BY c.platform ORDER BY count DESC
    `).bind(pid).all(),
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
    profile_id: pid,
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
