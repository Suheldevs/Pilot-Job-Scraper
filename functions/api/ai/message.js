/** POST /api/ai/message — draft one outreach message for one company.
 *
 *  ON-DEMAND ONLY. This endpoint must never be called from the scrape loop, a
 *  scheduled run, a bulk action, or any "draft messages for all leads" button.
 *  It is one Gemini call per company the user has actually opened and chosen to
 *  write to. A scrape run touches hundreds of leads per pass; wiring an AI call
 *  into that path would burn the quota in a single run, make every run slow and
 *  flaky, and produce drafts for leads nobody will ever contact. The scraper
 *  writes `jd_excerpt`, and the user writes the lead note; a human clicking
 *  "draft" is what turns those into a message.
 *
 *  Body: { company_id, channel: "email" | "whatsapp" | "linkedin", profile_id? }
 *  `company_id` is the companies table's TEXT slug id ("pune:coditude"), not an
 *  integer. `profile_id` defaults to the caller's own default profile, and every
 *  per-profile thing this endpoint reads — the templates, the lead note, the
 *  candidate identity it writes as — is scoped to it.
 *
 *  Returns { subject?, body, used_template, template_key, warnings[] }.
 *  `subject` is present for email only — WhatsApp and LinkedIn have no subject
 *  line and inventing one would just get pasted into the message.
 *
 *  The saved template for the channel (see templates.js for the settings keys
 *  and its legacy fallback) is passed in as a STYLE REFERENCE, not a form to
 *  fill: the draft should sound like the person whose template it is. Channel
 *  discipline is in the prompt because it is the difference between a usable
 *  draft and a wasted one — a 900-character LinkedIn note cannot be sent, and
 *  an essay on WhatsApp does not get read.
 */
import { json, badRequest, notFound } from "../../lib/db.js";
import { rowToProfile, resolveProfileId, PROGRESS_ON_PROFILE, VISIBLE_TO_PROFILE } from "../../lib/profile.js";
import { callGemini, geminiErrorResponse, hasKey, missingKeyError } from "../../lib/gemini.js";

const TPL_KEYS = {
  email: { subject: "tpl_email_subject", body: "tpl_email_body" },
  whatsapp: { body: "tpl_whatsapp_body" },
  linkedin: { body: "tpl_linkedin_body" },
};
const LEGACY_KEY = "template";

const CHANNELS = Object.keys(TPL_KEYS);

/** Practical, not theoretical, limits.
 *  - LinkedIn connection notes are hard-capped at 300 characters by LinkedIn
 *    itself, so anything over that literally cannot be sent.
 *  - WhatsApp allows far more, but a cold message read on a phone stops being
 *    read past a few lines; 700 is the point where it becomes a wall of text.
 *  - Email has room for a real pitch but not a cover letter.
 *  Exceeding one of these is a warning, not a rejection — the user can still
 *  send a slightly long WhatsApp message, and losing the whole draft over 20
 *  characters would be worse. LinkedIn's is flagged as a hard limit. */
const LIMITS = {
  email: { body: 1800, subject: 90, hard: false },
  whatsapp: { body: 700, hard: false },
  linkedin: { body: 300, hard: true },
};

const CHANNEL_RULES = {
  email: `CHANNEL: EMAIL.
- There IS a subject line. Write one: specific, under 80 characters, no
  "Re:", no clickbait, no emoji. It should read like a person applying, e.g.
  "Full-stack developer (2 yrs, React/Node) — <role> at <company>".
- The body may be longer here, but 120–180 words is the target. Short
  paragraphs or at most 3 short bullets. No headers, no markdown, no bold.
- One clear ask at the end (a look at the resume, or a short call).
- Sign off with the candidate's name.`,
  whatsapp: `CHANNEL: WHATSAPP.
- NO subject line. Leave "subject" empty.
- This is read on a phone, from an unknown number. Keep it to 2–4 short
  sentences, under 600 characters total. Under 60 words.
- Open by saying who you are and which role you are writing about in the FIRST
  sentence — nobody scrolls a cold WhatsApp message.
- No bullet lists, no markdown, no links stacked up. One link at most.
- Polite and direct. No "Hope this message finds you well".`,
  linkedin: `CHANNEL: LINKEDIN NOTE.
- NO subject line. Leave "subject" empty.
- HARD LIMIT: 300 characters, including spaces. LinkedIn will not send a
  longer connection note. Aim for 250 to leave room.
- That is roughly 2 sentences: who you are, and the specific role you saw.
- No links (they are stripped), no bullet points, no sign-off block — just a
  first name at most.`,
};

const SYSTEM = `You draft short, specific job-application outreach messages on behalf of one candidate.
You write in that candidate's voice, using their saved template as the style reference.
You never invent facts about the candidate or the company. You always answer with JSON matching the requested schema.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    subject: { type: "STRING" },
    body: { type: "STRING" },
    notes: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["subject", "body"],
};

export async function onRequestPost(context) {
  const { request, env } = context;
  const userId = context.data.userId;
  const url = new URL(request.url);

  if (!hasKey(env)) return geminiErrorResponse(missingKeyError());

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected { company_id, channel, profile_id? }");
  }

  const companyId = typeof body.company_id === "string" ? body.company_id.trim() : "";
  if (!companyId) return badRequest("company_id is required");
  const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
  if (!CHANNELS.includes(channel)) {
    return badRequest(`channel must be one of ${CHANNELS.join(", ")}`);
  }

  // Resolved through the shared helper rather than by hand, because
  // `body.profile_id` is caller-controlled and this endpoint reads that
  // profile's saved templates, its private lead note and the identity it signs
  // the message with. resolveProfileId is the one place that checks the caller
  // owns the profile at all, and it fails closed without a userId. Its
  // no-profile_id fallback is the caller's OWN default; the previous global
  // `is_default = 1` lookup would have handed a second tenant the parent's
  // identity to write as.
  const resolved = await resolveProfileId(env, url, body, userId);
  if (resolved.error) return json({ error: resolved.error }, { status: resolved.status });

  // `p.lead_note`, not `c.note`: 011 moved the lead note onto the progress row
  // precisely because the company column is shared by every profile that adopted
  // the lead. It goes into the prompt below, so reading the shared column would
  // have fed one tenant's private sentence to another tenant's draft — on top of
  // being stale, since nothing writes it any more.
  //
  // VISIBLE_TO_PROFILE scopes the COMPANY ROW, which the join alone never did.
  // Keying the note by profile only made the note private; every other field
  // selected here — the name, the job title, the JD excerpt, and `c.hr`/`em`/`wa`
  // the moment anyone adds them to this list — sits on the shared row and came
  // back for any `company_id` that existed, from any tenant, to any caller with
  // an account. `company_id` is a guessable slug ("pune:coditude"), so that was a
  // read of another tenant's board dressed up as a draft request.
  //
  // Deliberate behaviour change: a lead this profile neither owns nor adopted now
  // takes the not-found path below instead of returning a draft. Not-found rather
  // than a 403, because on this endpoint the two are the same answer — a board
  // you are not on has no company by that id — and saying "exists, but not
  // yours" would confirm the very row we are refusing to show.
  const company = await env.DB.prepare(`
    SELECT c.id, c.name, c.tab, c.job_title, c.job_url, c.jd_excerpt, c.grade, c.score,
           c.experience_raw, c.employment_type, c.remote_type, c.department, c.salary_raw,
           p.lead_note AS lead_note
      FROM companies c
      LEFT JOIN progress p ON ${PROGRESS_ON_PROFILE}
     WHERE c.id = ?2
       AND ${VISIBLE_TO_PROFILE}
  `).bind(resolved.id, companyId).first();
  if (!company) return notFound(`company '${companyId}' not found`);

  const profileRow = await env.DB
    .prepare("SELECT * FROM profiles WHERE id = ?1")
    .bind(resolved.id)
    .first();
  // Still reachable despite the resolve above: the default path falls back to
  // the parent id on a database whose `profiles` table was never seeded.
  if (!profileRow) return notFound(`profile ${resolved.id} not found`);
  const profile = rowToProfile(profileRow);

  const tpl = await loadTemplate(env, channel, resolved.id);

  const warnings = [];
  if (!tpl.body) {
    warnings.push(
      `No saved ${channel} template — the draft has no style reference, so it will sound more generic. Save one under Settings to fix that.`
    );
  }
  if (tpl.migrated) {
    warnings.push(
      `Using the legacy single template as the ${channel} style reference; save a per-channel template to replace it.`
    );
  }
  if (!company.jd_excerpt && !company.job_title) {
    warnings.push(
      "This lead has no job title and no JD excerpt stored, so the draft cannot reference a specific role."
    );
  }

  let result;
  try {
    result = await callGemini(env, {
      system: SYSTEM,
      prompt: buildPrompt({ channel, company, profile, tpl }),
      schema: RESPONSE_SCHEMA,
      // Higher than the extraction endpoint: this is writing, and 0.15 produces
      // four near-identical drafts for four different companies.
      temperature: 0.6,
      maxOutputTokens: 1500,
      timeoutMs: 30_000,
    });
  } catch (err) {
    return geminiErrorResponse(err);
  }

  const out = result.json && typeof result.json === "object" ? result.json : {};
  let draftBody = clean(out.body);
  let subject = clean(out.subject);

  if (!draftBody) {
    return json({ error: "Gemini returned an empty message body", reason: "empty_draft" }, { status: 502 });
  }

  const limit = LIMITS[channel];
  if (channel === "email") {
    if (!subject) {
      subject = tpl.subject || "";
      warnings.push("Gemini returned no subject; fell back to the saved template subject.");
    }
    if (subject.length > limit.subject) {
      warnings.push(`Subject is ${subject.length} characters — inboxes truncate around ${limit.subject}.`);
    }
  } else if (subject) {
    // A subject on WhatsApp/LinkedIn is a prompt failure, not content: dropped
    // rather than returned, since the UI would paste it into the message.
    subject = "";
  }

  if (draftBody.length > limit.body) {
    warnings.push(
      limit.hard
        ? `Draft is ${draftBody.length} characters — LinkedIn hard-caps connection notes at ${limit.body}, so this will not send as-is. Trim it before using.`
        : `Draft is ${draftBody.length} characters — past the ${limit.body}-character point where a ${channel} message stops getting read.`
    );
  }

  // Whatever Gemini says about its own draft is worth surfacing, but under the
  // same `warnings` key rather than a second field the UI would have to learn.
  for (const n of Array.isArray(out.notes) ? out.notes : []) {
    if (typeof n === "string" && n.trim()) warnings.push(n.trim().slice(0, 200));
  }

  const payload = {
    body: draftBody,
    used_template: Boolean(tpl.body),
    template_key: tpl.key,
    warnings: warnings.slice(0, 8),
    channel,
    company: { id: company.id, name: company.name, job_title: company.job_title || "" },
    profile_id: profileRow.id,
    chars: draftBody.length,
    limit: limit.body,
    model: result.model,
  };
  if (channel === "email") payload.subject = subject;
  return json(payload);
}

/** The channel's saved template, with templates.js's legacy fallback so a user
 *  who never migrated still gets their own voice as the reference.
 *
 *  Scoped to one profile: 010 keyed `settings` by (profile_id, key), so the same
 *  template keys now exist once per profile and an unscoped read would draft the
 *  message in whichever tenant's voice SQLite reached first. */
async function loadTemplate(env, channel, profileId) {
  const keys = TPL_KEYS[channel];
  const wanted = [...Object.values(keys), LEGACY_KEY];
  // ?1 is the profile, so the generated key placeholders start at ?2 and the
  // binds are pushed along by one to match — same shape as templates.js, which
  // reads these very rows.
  const placeholders = wanted.map((_, i) => `?${i + 2}`).join(",");
  const { results } = await env.DB
    .prepare(`SELECT key, value FROM settings WHERE profile_id = ?1 AND key IN (${placeholders})`)
    .bind(profileId, ...wanted)
    .all();
  const stored = new Map((results || []).map((r) => [r.key, r.value]));

  const rawLegacy = stored.get(LEGACY_KEY);
  const legacy = typeof rawLegacy === "string" && rawLegacy !== "" ? rawLegacy : null;

  // `has` rather than a falsy check, matching templates.js: an empty string is
  // a deliberate "cleared this channel" save and must not be refilled.
  let bodyText = "";
  let key = "";
  let migrated = false;
  if (stored.has(keys.body)) {
    bodyText = stored.get(keys.body) == null ? "" : String(stored.get(keys.body));
    key = keys.body;
  } else if (legacy !== null) {
    bodyText = legacy;
    key = LEGACY_KEY;
    migrated = true;
  }

  const subject = keys.subject && stored.has(keys.subject) ? String(stored.get(keys.subject) ?? "") : "";
  return { body: bodyText, subject, key, migrated };
}

function buildPrompt({ channel, company, profile, tpl }) {
  const lines = [];
  lines.push("Draft one outreach message for this specific job lead.");
  lines.push("");
  lines.push("=== THE CANDIDATE (this is who you are writing as) ===");
  lines.push(`Name: ${profile.full_name || profile.name}`);
  if (profile.headline) lines.push(`Headline: ${profile.headline}`);
  if (profile.years) lines.push(`Experience: ${profile.years} years`);
  if (profile.current_company) lines.push(`Currently at: ${profile.current_company}`);
  if (profile.must_have?.length) lines.push(`Core stack: ${profile.must_have.join(", ")}`);
  if (profile.nice_to_have?.length) lines.push(`Also works with: ${profile.nice_to_have.join(", ")}`);
  if (profile.notice_period) lines.push(`Notice period: ${profile.notice_period}`);
  if (profile.portfolio) lines.push(`Portfolio: ${profile.portfolio}`);
  if (profile.github) lines.push(`GitHub: ${profile.github}`);
  if (profile.linkedin) lines.push(`LinkedIn: ${profile.linkedin}`);
  if (profile.resume_url) lines.push(`Resume link: ${profile.resume_url}`);
  if (profile.email) lines.push(`Email: ${profile.email}`);
  if (profile.phone) lines.push(`Phone: ${profile.phone}`);

  lines.push("");
  lines.push("=== THE COMPANY / ROLE ===");
  lines.push(`Company: ${company.name}`);
  lines.push(`Role: ${company.job_title || "(no title recorded)"}`);
  lines.push(`Location bucket: ${company.tab}`);
  if (company.department) lines.push(`Department: ${company.department}`);
  if (company.employment_type) lines.push(`Employment type: ${company.employment_type}`);
  if (company.remote_type) lines.push(`Remote type: ${company.remote_type}`);
  if (company.experience_raw) lines.push(`Experience asked for: ${company.experience_raw}`);
  if (company.lead_note) lines.push(`Our own note on this lead: ${trunc(company.lead_note, 400)}`);
  if (company.jd_excerpt) {
    lines.push("Job description excerpt (may be truncated mid-sentence):");
    lines.push(trunc(company.jd_excerpt, 2500));
  } else {
    lines.push("No job description was captured for this lead.");
  }

  lines.push("");
  lines.push("=== STYLE REFERENCE ===");
  if (tpl.body) {
    lines.push(
      "Below is the candidate's own saved template for this channel. Match its VOICE, register, " +
        "greeting style, length instinct and sign-off. Do NOT fill it in like a form and do NOT " +
        "copy it sentence for sentence — rewrite it for this specific company and role, keeping " +
        "any placeholder the candidate uses resolved to real values."
    );
    if (tpl.subject) lines.push(`Their saved subject line: ${trunc(tpl.subject, 200)}`);
    lines.push("--- TEMPLATE ---");
    lines.push(trunc(tpl.body, 2000));
    lines.push("--- END TEMPLATE ---");
  } else {
    lines.push(
      "The candidate has not saved a template for this channel. Write plainly and directly in a " +
        "normal working register — the voice of a developer writing their own email, not a " +
        "recruiter or a marketer."
    );
  }

  lines.push("");
  lines.push("=== CHANNEL DISCIPLINE (this is not optional) ===");
  lines.push(CHANNEL_RULES[channel]);

  lines.push("");
  lines.push("=== RULES ===");
  lines.push(
    "- Reference something REAL and specific about this role or company, taken from the fields " +
      "above. One concrete detail beats three generic compliments."
  );
  lines.push(
    "- Never invent a fact: no fake mutual connections, no praise for a product you were not told " +
      "about, no claim about the candidate's experience beyond what is listed, no salary talk."
  );
  lines.push(
    "- If the role or JD is missing, write about the company generally and do not pretend to know " +
      "the opening's details."
  );
  lines.push("- It must read like the candidate wrote it. No AI tells: no \"I hope this email finds you well\", no \"I am reaching out to express my keen interest\", no \"leverage\", no \"synergy\", no em-dash-heavy phrasing, no bulleted \"Why me\" section.");
  lines.push("- Plain text only. No markdown, no bold, no headers.");
  lines.push("- Do not include any placeholder like [Company] or {{name}} — every value is above.");
  lines.push(
    `- "notes": at most 2 short strings, only if there is something the candidate should know ` +
      `before sending (a detail you had to leave out, an assumption you made). Otherwise return [].`
  );
  lines.push(
    channel === "email"
      ? '- Return {"subject": "...", "body": "...", "notes": [...]}.'
      : '- Return {"subject": "", "body": "...", "notes": [...]} — subject MUST be empty for this channel.'
  );
  return lines.join("\n");
}

function clean(v) {
  if (typeof v !== "string") return "";
  // Models occasionally wrap the answer in a fence even under a JSON schema.
  return v.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
}

const trunc = (s, n) => {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
