export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

export function badRequest(message) {
  return json({ error: message }, { status: 400 });
}

export function notFound(message = "not found") {
  return json({ error: message }, { status: 404 });
}

/** DB row -> API shape (parses the JSON-array columns). */
export function rowToCompany(row) {
  return {
    id: row.id,
    tab: row.tab,
    section: row.section,
    n: row.name,
    li: row.li || "",
    hr: safeArray(row.hr),
    em: safeArray(row.em),
    wa: safeArray(row.wa),
    land: row.land || "",
    note: row.note || "",
    job: row.job_url ? { u: row.job_url, t: row.job_title || "" } : null,
    source: row.source,
    scraped_from: row.scraped_from || "",
    created_at: row.created_at,
    // the two tags
    platform: row.platform || row.scraped_from || "manual",
    grade: row.grade || "",
    score: row.score || 0,
    reasons: safeArray(row.score_reasons),
    jd_excerpt: row.jd_excerpt || "",
    posted_at: row.posted_at || null,
    // optional per-job detail — absent from thin sources, so `null`/"" here
    // means "the source didn't say", not "zero".
    source_job_id: row.source_job_id || "",
    apply_url: row.apply_url || "",
    employment_type: row.employment_type || "",
    remote_type: row.remote_type || "",
    department: row.department || "",
    salary_raw: row.salary_raw || "",
    salary_min: row.salary_min ?? null,
    salary_max: row.salary_max ?? null,
    salary_currency: row.salary_currency || "",
    experience_raw: row.experience_raw || "",
    experience_min: row.experience_min ?? null,
    experience_max: row.experience_max ?? null,
    company_size: row.company_size || "",
    company_website: row.company_website || "",
    openings_count: row.openings_count ?? null,
    raw: safeObject(row.raw_data),
    stage: row.stage || "none",
    stage_note: row.stage_note || "",
    stage_at: row.stage_updated_at || null,
  };
}

function safeArray(text) {
  try {
    const v = JSON.parse(text || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Same defensive parse for an object column (raw_data).
 *  The column holds whatever a source returned, capped writer-side — so a
 *  truncated or half-written payload is a realistic possibility. One bad row
 *  must not take down the whole listing, so it degrades to {}. Arrays and
 *  scalars are rejected too: callers index into this by key. */
function safeObject(text) {
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const SECTION_BY_TAB = {
  blr: ["s1", "s2", "s3"],
  pune: ["p1", "p2", "p3"],
  lko: ["l1", "l2", "l3"],
  noida: ["n1", "n2"],
  rem: ["r1"],
};

/** Best-guess section (contact-quality tier) for a company we didn't get an explicit section for. */
export function defaultSection(tab, { hr = [], wa = [], job = null } = {}) {
  const tiers = SECTION_BY_TAB[tab] || ["s1"];
  if (hr.length) return tiers[0];
  if (wa.length || job) return tiers[1] || tiers[0];
  return tiers[tiers.length - 1];
}

export const VALID_TABS = ["blr", "pune", "lko", "noida", "rem"];
export const VALID_STAGES = ["none", "contacted", "replied", "interviewing", "offer", "rejected"];

/** Tag 1 — provenance. Ordered best-evidence first. */
export const VALID_PLATFORMS = [
  "greenhouse", "lever", "ashby", "keka",       // the company's own ATS board
  "hackernews",                                  // the employer posted it itself
  "remotive", "arbeitnow", "remoteok", "weworkremotely", "instahyre", // aggregators
  "linkedin", "naukri", "firecrawl",             // search / sitemap / rendered page
  "extension",                                   // harvested from a logged-in page
  "manual",
];

/** Tag 2 — how strong the lead is. */
export const VALID_GRADES = ["A", "B", "C", "D"];
