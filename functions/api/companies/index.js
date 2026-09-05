import { json, badRequest, rowToCompany, defaultSection, VALID_TABS } from "../../lib/db.js";
import { companyId } from "../../lib/slug.js";
import { resolveProfileId, VISIBLE_TO_PROFILE, PROGRESS_ON_PROFILE } from "../../lib/profile.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab");

  // Optional `?profile_id=`; absent means the default profile, so a client that
  // does not know about profiles sees exactly the board it saw before.
  const profile = await resolveProfileId(env, url, null, userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  // Two separate scopings, both required:
  //   the JOIN  — pairs each company with THIS profile's progress row, so a
  //               stage or lead note another profile set is invisible here;
  //   the WHERE — limits the list to leads this profile owns or has adopted.
  // Without the join condition the query would happily attach profile 2's
  // stage to profile 1's row, which is the exact leak 008 exists to close.
  //
  // `p.lead_note` is aliased through because 011 moved the lead note off the
  // shared `companies.note` column and rowToCompany reads it from the join now:
  // omit the alias and every card on the board renders an empty note.
  const query = `
    SELECT c.*, p.stage, p.note AS stage_note, p.updated_at AS stage_updated_at,
           p.lead_note AS lead_note
    FROM companies c
    LEFT JOIN progress p ON ${PROGRESS_ON_PROFILE}
    WHERE ${VISIBLE_TO_PROFILE}
    ${tab ? "AND c.tab = ?2" : ""}
    ORDER BY c.created_at DESC
  `;
  const stmt = tab
    ? env.DB.prepare(query).bind(profile.id, tab)
    : env.DB.prepare(query).bind(profile.id);
  const { results } = await stmt.all();
  return json(results.map(rowToCompany));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.tab) return badRequest("name and tab are required");
  if (!VALID_TABS.includes(body.tab)) return badRequest("invalid tab");

  const profile = await resolveProfileId(env, url, body, userId);
  if (profile.error) return json({ error: profile.error }, { status: profile.status });

  const hr = Array.isArray(body.hr) ? body.hr : [];
  const em = Array.isArray(body.em) ? body.em : [];
  const wa = Array.isArray(body.wa) ? body.wa : [];
  const id = companyId(body.tab, body.name);
  const section = body.section || defaultSection(body.tab, { hr, wa, job: body.job_url });
  const now = Date.now();

  // `body.note` is NOT discarded — it is routed to this profile's
  // `progress.lead_note` below instead of to `companies.note`, which 011 left
  // write-dead. Writing the company column would have failed twice over: nothing
  // reads it back any more (rowToCompany takes the note off the progress row),
  // so the text the user typed would vanish from the board, and it lives on the
  // SHARED company row, so it would also have republished that text to every
  // other profile that adopted the lead. The column is therefore dropped from
  // this INSERT and from its conflict list rather than kept for appearances.
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO companies (id, tab, section, name, li, hr, em, wa, land, job_url, job_title,
                             source, scraped_from, created_at, platform, profile_id)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
      ON CONFLICT(id) DO UPDATE SET
        li = excluded.li,
        job_url = excluded.job_url, job_title = excluded.job_title
    `).bind(
      id, body.tab, section, body.name, body.li || "",
      JSON.stringify(hr), JSON.stringify(em), JSON.stringify(wa),
      body.land || "", body.job_url || "", body.job_title || "",
      body.source || "manual", body.scraped_from || "", now,
      body.platform || "manual",
      // Stamped, not left to the column default, because GET now filters on
      // it: a company added under profile 2 and stamped 1 would vanish from
      // the board of the profile that just created it. With no `profile_id` in
      // the request this resolves to the default profile, which for the parent
      // database is 1 — the same value the column default gives.
      profile.id
    ),
    // DO UPDATE rather than the old DO NOTHING, because this row now carries the
    // note and re-posting a company the profile already has has to be able to
    // edit it. Guarded on a non-empty incoming note: re-posts that carry none —
    // the extension resending contact details for a lead already on the board —
    // must not blank what the user wrote. `stage`, the stage note and
    // `updated_at` are deliberately left alone: `updated_at` times the last
    // STAGE change and import.js's merge compares it, so a note edit must not
    // move it.
    env.DB.prepare(`
      INSERT INTO progress (profile_id, company_id, stage, note, updated_at, lead_note)
      VALUES (?1, ?2, 'none', '', ?3, ?4)
      ON CONFLICT(profile_id, company_id) DO UPDATE SET lead_note = excluded.lead_note
        WHERE excluded.lead_note <> ''
    `).bind(profile.id, id, now, typeof body.note === "string" ? body.note : ""),
  ]);

  return json({ id, profile_id: profile.id }, { status: 201 });
}
