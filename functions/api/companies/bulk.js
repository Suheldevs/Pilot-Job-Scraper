/** Bulk insert used by the scraper. Anything a human may have edited —
 *  contacts, notes, stage — is never overwritten, matching hey.html's old
 *  "import only adds" rule. Machine-derived columns are allowed to improve:
 *  a higher-scoring re-scrape replaces them, and any scrape may fill one that
 *  is still blank.
 *
 *  The scraped note is part of that promise and no longer part of the company
 *  row: since 011 it belongs to `progress.lead_note`, per profile, and the
 *  second statement below is what writes it. */
import { json, badRequest, defaultSection, VALID_TABS, VALID_PLATFORMS, VALID_GRADES } from "../../lib/db.js";
import { companyId } from "../../lib/slug.js";
import { resolveProfileId } from "../../lib/profile.js";

// The optional job detail models.py::Job carries. Declared as ordered lists so
// the column list, the placeholder numbers and the bind order are all derived
// from one place — hand-numbering ?1..?37 three times is how they drift apart.
const TEXT_FIELDS = [
  "source_job_id", "apply_url", "employment_type", "remote_type", "department",
  "salary_raw", "salary_currency", "experience_raw",
  "company_size", "company_website", "raw_data",
];
const NUM_FIELDS = ["salary_min", "salary_max", "experience_min", "experience_max", "openings_count"];
const EXTRA_FIELDS = [...TEXT_FIELDS, ...NUM_FIELDS];

// The hand-written head of the statement ends at ?21; the extras follow it.
// (?21 is `profile_id`, added by migration 008's reader pass — bump this and
// the head's own numbering together or the binds silently shift. It was ?22
// until `note` came off the head, which is exactly the kind of edit that
// shifts every extra field by one if this constant is left behind.)
const BASE_PARAMS = 21;
const EXTRA_PLACEHOLDERS = EXTRA_FIELDS.map((_, i) => `?${BASE_PARAMS + 1 + i}`).join(",");

// Two ways an extra field gets written on conflict: the incoming lead outscores
// what we stored (it is the better posting, so it wins), or what we stored is
// blank (there is nothing to lose). A weaker row can therefore fill a gap — a
// later scrape that finally has a salary — without clobbering good data, and an
// empty incoming value never overwrites anything.
const textFill = (col) => `${col} = CASE
            WHEN excluded.${col} != ''
             AND (excluded.score > companies.score OR COALESCE(companies.${col}, '') = '')
            THEN excluded.${col} ELSE companies.${col} END`;
const numFill = (col) => `${col} = CASE
            WHEN excluded.${col} IS NOT NULL
             AND (excluded.score > companies.score OR companies.${col} IS NULL)
            THEN excluded.${col} ELSE companies.${col} END`;

const EXTRA_UPDATES = [...TEXT_FIELDS.map(textFill), ...NUM_FIELDS.map(numFill)].join(",\n          ");

// Mirrors Job.raw_json()'s cap. A payload past it is replaced rather than
// sliced: half a JSON document is unparseable, and a marker at least tells
// whoever reads the column later that something was there.
const RAW_MAX = 8000;

// These are short labels and URLs, not prose — same reasoning as jd_excerpt's
// 600-char clip: a source that dumps a paragraph into `department` should not
// be able to grow the row.
const FIELD_MAX = 400;
const text = (v) => (v == null ? "" : String(v).slice(0, FIELD_MAX));
const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function rawData(c) {
  // `raw_data` is what the pusher sends (already a JSON string from
  // Job.raw_json()); `raw` is accepted too in case a caller passes the object.
  let value = typeof c.raw_data === "string" ? c.raw_data
            : c.raw_data && typeof c.raw_data === "object" ? JSON.stringify(c.raw_data)
            : typeof c.raw === "string" ? c.raw
            : c.raw && typeof c.raw === "object" ? JSON.stringify(c.raw)
            : "";
  if (value.length > RAW_MAX) value = JSON.stringify({ _truncated: true, _chars: value.length });
  return value;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.companies)) return badRequest("expected { companies: [...] }");

  // The pusher (push.py) sends no `profile_id`, so this resolves to the default
  // profile — id 1 on the parent database, i.e. exactly where the scraper's
  // leads and their 'none' progress rows already went.
  const profile = await resolveProfileId(env, url, body, userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const now = Date.now();
  const statements = [];
  let skipped = 0;

  for (const c of body.companies) {
    if (!c || !c.name || !VALID_TABS.includes(c.tab)) { skipped++; continue; }
    const hr = Array.isArray(c.hr) ? c.hr : [];
    const em = Array.isArray(c.em) ? c.em : [];
    const wa = Array.isArray(c.wa) ? c.wa : [];
    const id = companyId(c.tab, c.name);
    const section = c.section || defaultSection(c.tab, { hr, wa, job: c.job_url });

    const platform = VALID_PLATFORMS.includes(c.platform) ? c.platform
                   : VALID_PLATFORMS.includes(c.scraped_from) ? c.scraped_from : "";
    const grade = VALID_GRADES.includes(c.grade) ? c.grade : "";
    const reasons = Array.isArray(c.reasons) ? c.reasons : [];

    statements.push(
      env.DB.prepare(`
        INSERT INTO companies (id, tab, section, name, li, hr, em, wa, land, job_url, job_title,
                               source, scraped_from, created_at,
                               platform, grade, score, score_reasons, jd_excerpt, posted_at,
                               profile_id,
                               ${EXTRA_FIELDS.join(", ")})
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,
                ${EXTRA_PLACEHOLDERS})
        ON CONFLICT(id) DO UPDATE SET
          -- a re-scrape may find a better-graded posting for a company we
          -- already have; take the stronger grade but never touch contacts or
          -- stage, which a human may have edited. The note is not on this row
          -- at all any more — it is written per profile below, under the same
          -- rule.
          grade         = CASE WHEN excluded.score > companies.score THEN excluded.grade         ELSE companies.grade END,
          score         = CASE WHEN excluded.score > companies.score THEN excluded.score         ELSE companies.score END,
          score_reasons = CASE WHEN excluded.score > companies.score THEN excluded.score_reasons ELSE companies.score_reasons END,
          job_url       = CASE WHEN excluded.score > companies.score AND excluded.job_url != '' THEN excluded.job_url   ELSE companies.job_url END,
          job_title     = CASE WHEN excluded.score > companies.score AND excluded.job_url != '' THEN excluded.job_title ELSE companies.job_title END,
          platform      = CASE WHEN excluded.score > companies.score THEN excluded.platform      ELSE companies.platform END,
          ${EXTRA_UPDATES}
      `).bind(
        id, c.tab, section, c.name, c.li || "",
        JSON.stringify(hr), JSON.stringify(em), JSON.stringify(wa),
        c.land || "", c.job_url || "", c.job_title || "",
        c.source || "scraped", c.scraped_from || "", now,
        platform, grade, Number(c.score) || 0, JSON.stringify(reasons),
        (c.jd_excerpt || "").slice(0, 600), c.posted_at || null,
        // ?21. Absent from the ON CONFLICT list on purpose: a re-scrape may
        // find a better posting for a company another profile already owns,
        // and taking the better grade must not also transfer ownership.
        profile.id,
        // Same order as EXTRA_FIELDS — text first, then numeric.
        ...TEXT_FIELDS.map((f) => (f === "raw_data" ? rawData(c) : text(c[f]))),
        ...NUM_FIELDS.map((f) => numOrNull(c[f]))
      )
    );
    // The scraper's note is the LEAD note, so this is the row it belongs on.
    // Writing it to `companies.note` was writing to a column nothing has read
    // since 011 — rowToCompany takes the note off the progress join — so every
    // scraped note rendered blank on the board.
    //
    // The DO UPDATE is guarded twice, and unlike the manual-add path this pattern
    // comes from, both halves are load-bearing here:
    //   excluded.lead_note <> ''  a scrape carrying no note must not blank one;
    //   progress.lead_note = ''   a scrape carrying one must not overwrite what
    //                             the user has typed since.
    // The second clause is what keeps this file's "never overwrite anything a
    // human may have edited" promise true, and it is not optional: pipeline.py
    // builds a note for EVERY job it emits ("<role> — via <platform>. Auto-
    // scraped, verify before contacting."), so on the non-empty guard alone the
    // next nightly run would replace every hand-written lead note with that
    // boilerplate. Filling a blank one is still allowed — there is nothing to
    // lose, and it is what makes scraped notes appear at all.
    statements.push(
      env.DB.prepare(`
        INSERT INTO progress (profile_id, company_id, stage, note, updated_at, lead_note)
        VALUES (?1, ?2, 'none', '', ?3, ?4)
        ON CONFLICT(profile_id, company_id) DO UPDATE SET lead_note = excluded.lead_note
          WHERE excluded.lead_note <> '' AND progress.lead_note = ''
      `).bind(profile.id, id, now, typeof c.note === "string" ? c.note : "")
    );
  }

  if (statements.length) {
    // D1 batches cap around 100 statements per call — chunk to be safe.
    for (let i = 0; i < statements.length; i += 80) {
      await env.DB.batch(statements.slice(i, i + 80));
    }
  }

  return json({ submitted: body.companies.length, skipped });
}
