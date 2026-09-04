/** Accepts either shape:
 *   new  { companies:[{tab,section,n,hr,em,wa,note,job,stage,...}], template }
 *   old  { state:{id:{stage,at,note}}, custom:{sectionKey:[{n,hr,em,wa,...}]}, tpl }
 *        (hey.html's localStorage export — `custom` is keyed by SECTION, not tab)
 *
 * Companies are only added, never overwritten. Progress is merged newest-wins.
 *
 * Everything imported lands on ONE profile: `?profile_id=` (or `profile_id` in
 * the body), defaulting to the default profile. Since migration 008 the stages
 * in an import file belong to whoever exported it, so writing them without a
 * profile would have dropped another profile's stages on top of this one's.
 */
import { json, badRequest, defaultSection, VALID_STAGES, VALID_TABS } from "../lib/db.js";
import { companyId, slugify } from "../lib/slug.js";
import { resolveProfileId, VISIBLE_TO_PROFILE } from "../lib/profile.js";

const SECTION_TO_TAB = {
  s1: "blr", s2: "blr", s3: "blr",
  p1: "pune", p2: "pune", p3: "pune",
  l1: "lko", l2: "lko", l3: "lko",
  n1: "noida", n2: "noida",
  r1: "rem",
};

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return badRequest("invalid JSON");

  const profile = await resolveProfileId(env, url, body);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });
  const pid = profile.id;

  const now = Date.now();
  const statements = [];
  let companiesAdded = 0;
  let progressMerged = 0;

  const pushCompany = (c, tab, section) => {
    const hr = Array.isArray(c.hr) ? c.hr : [];
    const em = Array.isArray(c.em) ? c.em : [];
    const wa = Array.isArray(c.wa) ? c.wa : [];
    const jobUrl = c.job_url || (c.job && c.job.u) || "";
    const jobTitle = c.job_title || (c.job && c.job.t) || "";
    const name = c.n || c.name;
    if (!name || !tab) return;
    const id = companyId(tab, name);

    statements.push(env.DB.prepare(`
      INSERT INTO companies (id, tab, section, name, li, hr, em, wa, land, note, job_url, job_title, source, scraped_from, created_at, profile_id)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      id, tab, section || defaultSection(tab, { hr, wa, job: jobUrl }), name, c.li || "",
      JSON.stringify(hr), JSON.stringify(em), JSON.stringify(wa),
      c.land || "", c.note || "", jobUrl, jobTitle,
      c.source || "import", c.scraped_from || "", c.created_at || now,
      // Stamped for the same reason as the manual add: GET /api/companies
      // filters on ownership, so a lead imported into profile 2 has to be
      // owned by profile 2 to show up there.
      pid
    ));
    statements.push(env.DB.prepare(`
      INSERT INTO progress (profile_id, company_id, stage, note, updated_at) VALUES (?1,?2,'none','',?3)
      ON CONFLICT(profile_id, company_id) DO NOTHING
    `).bind(pid, id, now));
    companiesAdded++;

    if (c.stage && VALID_STAGES.includes(c.stage) && c.stage !== "none") {
      statements.push(progressUpsert(env, pid, id, c.stage, c.stage_note || "", c.stage_at || now));
      progressMerged++;
    }
  };

  // --- new shape
  if (Array.isArray(body.companies)) {
    for (const c of body.companies) {
      if (!c) continue;
      pushCompany(c, c.tab, c.section);
    }
  }

  // --- old shape: `custom` keyed by section (s1, p2, r1…) — but the scraper's
  // own JSON keys it by city instead, so accept both rather than silently
  // importing nothing.
  if (body.custom && typeof body.custom === "object") {
    for (const [key, list] of Object.entries(body.custom)) {
      if (!Array.isArray(list)) continue;
      const sectionTab = SECTION_TO_TAB[key];
      if (sectionTab) {
        for (const c of list) pushCompany(c, sectionTab, key);
      } else if (VALID_TABS.includes(key)) {
        for (const c of list) pushCompany(c, key, c.section);
      }
      // anything else isn't a section or a city — ignore it
    }
  }

  // --- old shape: progress, keyed by bare slug (no tab prefix).
  // Resolve each against existing companies by matching the slug part.
  // Only against companies this profile can see: resolving a slug to a lead
  // that belongs to somebody else would write a stage for a company that will
  // never appear on this profile's board.
  if (body.state && typeof body.state === "object") {
    const { results } = await env.DB.prepare(`
      SELECT c.id AS id FROM companies c WHERE ${VISIBLE_TO_PROFILE}
    `).bind(pid).all();
    const bySlug = new Map();
    for (const row of results) {
      const slug = row.id.split(":").slice(1).join(":");
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(row.id);
    }
    for (const [oldId, rec] of Object.entries(body.state)) {
      if (!rec || !VALID_STAGES.includes(rec.stage) || rec.stage === "none") continue;
      const matches = bySlug.get(slugify(oldId)) || bySlug.get(oldId) || [];
      for (const id of matches) {
        statements.push(progressUpsert(env, pid, id, rec.stage, rec.note || "", rec.at || now));
        progressMerged++;
      }
    }
  }

  const template = typeof body.template === "string" ? body.template
                 : typeof body.tpl === "string" ? body.tpl : null;
  if (template) {
    statements.push(env.DB.prepare(`
      INSERT INTO settings (key, value) VALUES ('template', ?1)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(template));
  }

  for (let i = 0; i < statements.length; i += 80) {
    await env.DB.batch(statements.slice(i, i + 80));
  }

  return json({ profile_id: pid, companies_added: companiesAdded, progress_merged: progressMerged });
}

/** Newest-wins: only overwrite if the incoming timestamp is at least as new.
 *  Newest-wins *within one profile* — the conflict target is the composite key,
 *  so an import into profile 2 can never outbid profile 1's note. */
function progressUpsert(env, profileId, id, stage, note, at) {
  return env.DB.prepare(`
    INSERT INTO progress (profile_id, company_id, stage, note, updated_at)
    VALUES (?1,?2,?3,?4,?5)
    ON CONFLICT(profile_id, company_id) DO UPDATE SET
      stage = CASE WHEN excluded.updated_at >= COALESCE(progress.updated_at,0) THEN excluded.stage ELSE progress.stage END,
      note  = CASE WHEN excluded.updated_at >= COALESCE(progress.updated_at,0) THEN excluded.note  ELSE progress.note  END,
      updated_at = MAX(COALESCE(progress.updated_at,0), excluded.updated_at)
  `).bind(profileId, id, stage, note, at);
}
