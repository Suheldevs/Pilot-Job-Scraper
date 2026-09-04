/** POST /api/ai/resume — read a resume, propose profile fields.
 *
 *  Returns a DRAFT, never a saved profile. Nothing here writes to the database:
 *  the user reviews the draft in the UI and the save goes through the existing
 *  `POST /api/profiles` / `PUT /api/profile/:id`, which own validation and the
 *  `version` bump rule. An AI extraction that silently rewrote someone's
 *  targeting — and bumped their version, invalidating grades — would be a much
 *  worse bug than a draft the user has to confirm.
 *
 *  Body is one of:
 *    { text: "...plain resume text..." }          200 – 40,000 chars
 *    { base64: "...", mime: "application/pdf" }   passed through as inline_data
 *
 *  The prompt's real job is the distinction PROFILE-CONTRACT.md is built on:
 *  `search_roles` are the few natural job-title queries that become real
 *  search URLs against rate-limited sites, `match_keywords` are the many loose
 *  tokens used to filter unfiltered feeds after fetching. Left unsaid, a model
 *  produces the same list twice, which makes searches useless *and* filtering
 *  too narrow. It is spelled out below with sizing rules and examples.
 *
 *  Contact details are never invented. Anything the model returns for
 *  email/phone/linkedin/github/portfolio is checked back against the submitted
 *  text; a value that isn't in the source is dropped and said so in `notes`.
 *  (For a PDF we have no text to check against, so the check is skipped and
 *  `notes` says the contacts are unverified.)
 */
import { json, badRequest } from "../../lib/db.js";
import { callGemini, geminiErrorResponse, hasKey, missingKeyError } from "../../lib/gemini.js";

const MIN_TEXT = 200;
const MAX_TEXT = 40_000;

/** ~6 MB of PDF once decoded. Bigger than any real resume; a bigger upload is
 *  a mistake or an attack, and it would blow the model's input limit anyway. */
const MAX_BASE64_CHARS = 8_000_000;

const ALLOWED_MIME = new Set(["application/pdf"]);

const STRING_FIELDS = [
  "full_name",
  "headline",
  "current_company",
  "email",
  "phone",
  "linkedin",
  "github",
  "portfolio",
];
const CONTACT_FIELDS = ["email", "phone", "linkedin", "github", "portfolio"];
const ARRAY_FIELDS = [
  "search_roles",
  "match_keywords",
  "must_have",
  "nice_to_have",
  "exclude_titles",
  "exclude_stacks",
];
const NUMBER_FIELDS = ["years", "exp_min", "exp_max"];

/** Sizing caps, applied server-side so a chatty model cannot produce a profile
 *  that costs 40 requests per scrape run. search_roles is the expensive list:
 *  every entry is a real search URL against LinkedIn/Naukri. */
const ARRAY_CAPS = {
  search_roles: 6,
  match_keywords: 30,
  must_have: 14,
  nice_to_have: 10,
  exclude_titles: 24,
  exclude_stacks: 30,
};

const CONFIDENCE = ["high", "medium", "low"];

const S = { type: "STRING" };
const STR_ARRAY = { type: "ARRAY", items: { type: "STRING" } };
const CONF = { type: "STRING", enum: CONFIDENCE };

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    draft: {
      type: "OBJECT",
      properties: {
        full_name: S,
        headline: S,
        years: { type: "NUMBER" },
        current_company: S,
        email: S,
        phone: S,
        linkedin: S,
        github: S,
        portfolio: S,
        search_roles: STR_ARRAY,
        match_keywords: STR_ARRAY,
        must_have: STR_ARRAY,
        nice_to_have: STR_ARRAY,
        exclude_titles: STR_ARRAY,
        exclude_stacks: STR_ARRAY,
        exp_min: { type: "NUMBER" },
        exp_max: { type: "NUMBER" },
      },
      required: [
        "full_name",
        "headline",
        "years",
        "current_company",
        "email",
        "phone",
        "linkedin",
        "github",
        "portfolio",
        "search_roles",
        "match_keywords",
        "must_have",
        "nice_to_have",
        "exclude_titles",
        "exclude_stacks",
        "exp_min",
        "exp_max",
      ],
    },
    // An open map is not expressible in the OpenAPI subset responseSchema
    // accepts, so the per-field confidence keys are declared explicitly.
    confidence: {
      type: "OBJECT",
      properties: {
        full_name: CONF,
        headline: CONF,
        years: CONF,
        current_company: CONF,
        email: CONF,
        phone: CONF,
        linkedin: CONF,
        github: CONF,
        portfolio: CONF,
        search_roles: CONF,
        match_keywords: CONF,
        must_have: CONF,
        nice_to_have: CONF,
        exclude_titles: CONF,
        exclude_stacks: CONF,
        exp_min: CONF,
        exp_max: CONF,
      },
    },
    notes: STR_ARRAY,
  },
  required: ["draft", "confidence", "notes"],
};

const SYSTEM = `You extract structured job-search targeting from resumes for a job-application tracker.
You only report what the resume supports. You never invent contact details, employers, or years of experience.
You always answer with JSON matching the requested schema.`;

function buildPrompt(hasSourceText) {
  return `Read the resume and fill in a DRAFT job-search profile. The user will review and edit it before anything is saved, so a confident guess you label as a guess is more useful than a blank.

THE ONE DISTINCTION THAT MATTERS — do not put the same values in both lists:

1. "search_roles" = QUERY TERMS. These are pasted verbatim into job-board search
   boxes (LinkedIn, Naukri) to build search URLs. So:
   - FEW: 2 to 5 entries, maximum 6. Each one costs an HTTP request against a
     rate-limited site, so a long list makes the scraper slower, not better.
   - NATURAL JOB TITLES a recruiter would actually post, lowercase, no
     punctuation, no boolean operators, no seniority words.
   - Good: "full stack developer", "mern stack developer", "react developer".
   - Bad: "react", "js", "developer", "react OR node", "full stack dev (2 yrs)".

2. "match_keywords" = FILTER TOKENS. These are matched against job titles and
   descriptions that were already fetched, to throw away irrelevant postings.
   So:
   - MANY: 12 to 30 short tokens.
   - SINGLE TECHNOLOGIES AND SHORT VARIANTS, including spelling variants,
     because they are matched literally: "react", "reactjs", "node", "nodejs",
     "express", "mongodb", "mern", "typescript", "next.js", "nextjs",
     "frontend", "front-end", "javascript".
   - Bad: a full job title like "senior full stack developer at a startup".

If a value belongs in both, that is a mistake — a job title is a search_role, a
technology name is a match_keyword.

THE OTHER FIELDS

- "full_name", "current_company": exactly as written in the resume.
- "headline": one short line, the way the candidate would describe themselves,
  e.g. "Full-stack developer (React / Node)". Under 60 characters.
- "years": total professional experience in years as a number. Compute it from
  the employment dates if it is not stated outright. Exclude internships unless
  they are the only experience. Use a decimal if the resume implies one (2.5).
- "must_have": named technologies the candidate genuinely works in day to day
  and would expect a matching job to mention. Lowercase, one technology each.
- "nice_to_have": technologies they have touched or are moving toward.
- "exclude_titles": seniority words that make a posting the wrong LEVEL for
  this candidate, in BOTH directions — too senior ("senior", "lead",
  "principal", "staff", "architect", "manager", "director", "head") and too
  junior ("intern", "internship", "trainee", "fresher"). Judge from their
  years: someone with 8 years should not exclude "senior".
- "exclude_stacks": technologies and disciplines this candidate cannot
  credibly claim, so a posting centred on one is the wrong kind of job
  entirely, e.g. "java", ".net", "php", "salesforce", "qa", "data scientist",
  "devops", "android". Only list things the resume gives no evidence for.
- "exp_min" / "exp_max": the years-of-experience band of postings worth
  applying to. Roughly one year below to one or two years above "years"; never
  a band that excludes the candidate's own experience.

CONTACT DETAILS — HARD RULE

"email", "phone", "linkedin", "github", "portfolio" must be copied character
for character from the resume. If one is not present, return "" for it and add
a note saying which contact fields were absent. Never construct a plausible
address from the person's name, never guess a github username, never complete a
partial URL.${hasSourceText ? " The submitted text is checked against your answer, and any contact value not found in it will be discarded." : ""}

CONFIDENCE AND NOTES

- "confidence": one of "high", "medium", "low" for each field you filled.
  "high" = read directly off the page. "medium" = derived from something stated
  (years computed from dates). "low" = inferred from context or convention
  (exclude_stacks, which the resume never states).
- "notes": 2 to 6 short lines, in plain language, saying what you READ versus
  what you INFERRED, and naming anything absent or ambiguous. This is what the
  user reads before accepting the draft, so be specific: "years computed from
  Mar 2023 – present, not stated"; "no phone number in the resume".

Return only the JSON.`;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Checked before the body is read: a deployment with no key must say so
  // plainly, not fail somewhere further in.
  if (!hasKey(env)) return geminiErrorResponse(missingKeyError());

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected { text } or { base64, mime }");
  }

  const parsedInput = readInput(body);
  if (parsedInput.error) return badRequest(parsedInput.error);
  const { parts, sourceText } = parsedInput;

  let result;
  try {
    result = await callGemini(env, {
      system: SYSTEM,
      parts: [{ text: buildPrompt(Boolean(sourceText)) }, ...parts],
      schema: RESPONSE_SCHEMA,
      // Extraction, not writing. Low but not zero: at 0 the model tends to
      // return one-word headlines.
      temperature: 0.15,
      maxOutputTokens: 4096,
      timeoutMs: 45_000,
    });
  } catch (err) {
    return geminiErrorResponse(err);
  }

  if (!result.json || typeof result.json !== "object" || Array.isArray(result.json)) {
    return json({ error: "Gemini returned an unexpected shape for the draft", reason: "bad_shape" }, { status: 502 });
  }

  const shaped = shapeDraft(result.json, sourceText);
  return json({
    draft: shaped.draft,
    confidence: shaped.confidence,
    notes: shaped.notes,
    model: result.model,
    // The draft is deliberately not persisted — say so in the payload so a
    // caller cannot mistake a 200 here for a saved profile.
    saved: false,
  });
}

/** Validate the body into Gemini parts plus, when we have it, the raw text to
 *  check contact claims against. */
function readInput(body) {
  const hasText = typeof body.text === "string" && body.text.trim() !== "";
  const hasFile = typeof body.base64 === "string" && body.base64.trim() !== "";

  if (hasText && hasFile) return { error: "send either { text } or { base64, mime }, not both" };

  if (hasText) {
    const text = body.text.trim();
    if (text.length < MIN_TEXT) {
      return { error: `text is too short to be a resume (${text.length} chars, minimum ${MIN_TEXT})` };
    }
    if (text.length > MAX_TEXT) {
      return { error: `text is too long (${text.length} chars, maximum ${MAX_TEXT})` };
    }
    return { parts: [{ text: `\n\n--- RESUME TEXT ---\n${text}\n--- END RESUME ---` }], sourceText: text };
  }

  if (hasFile) {
    const mime = typeof body.mime === "string" ? body.mime.trim().toLowerCase() : "";
    if (!ALLOWED_MIME.has(mime)) {
      return { error: `mime must be one of ${[...ALLOWED_MIME].join(", ")} (got ${mime || "nothing"})` };
    }
    // Strip a data: URL prefix — the obvious thing a browser sends.
    const clean = body.base64.replace(/^data:[^;]*;base64,/, "").replace(/\s+/g, "");
    if (clean.length > MAX_BASE64_CHARS) {
      return { error: `file is too large (${clean.length} base64 chars, maximum ${MAX_BASE64_CHARS})` };
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return { error: "base64 is not valid base64" };
    return {
      parts: [{ inline_data: { mime_type: mime, data: clean } }],
      sourceText: "", // no text to verify contacts against
    };
  }

  return { error: "expected { text } or { base64, mime }" };
}

/** Coerce, cap and sanity-check whatever came back. The model is asked for the
 *  right shape; it is not trusted to have produced it. */
function shapeDraft(raw, sourceText) {
  const inDraft = raw.draft && typeof raw.draft === "object" && !Array.isArray(raw.draft) ? raw.draft : {};
  const inConf = raw.confidence && typeof raw.confidence === "object" && !Array.isArray(raw.confidence) ? raw.confidence : {};
  const notes = (Array.isArray(raw.notes) ? raw.notes : [])
    .filter((n) => typeof n === "string" && n.trim())
    .map((n) => n.trim().slice(0, 300))
    .slice(0, 10);

  const draft = {};
  for (const f of STRING_FIELDS) draft[f] = str(inDraft[f]);
  for (const f of NUMBER_FIELDS) draft[f] = num(inDraft[f]);
  for (const f of ARRAY_FIELDS) draft[f] = arr(inDraft[f], ARRAY_CAPS[f]);

  // exp_min/exp_max must describe a band, not a pair in the wrong order.
  if (draft.exp_max && draft.exp_max < draft.exp_min) {
    const lo = draft.exp_max;
    draft.exp_max = draft.exp_min;
    draft.exp_min = lo;
    notes.push("exp_min/exp_max came back reversed and were swapped.");
  }
  if (!draft.exp_max) {
    draft.exp_max = Math.max(draft.exp_min, Math.round((draft.years + 2) * 10) / 10) || 99;
    notes.push("exp_max was empty; defaulted to years + 2.");
  }

  // The contract's central distinction, enforced rather than merely requested.
  // A model that ignores the instruction returns the same list twice; that is
  // reported, not silently accepted, because the fix is the user's to make.
  const roleSet = new Set(draft.search_roles.map(lower));
  const dupes = draft.match_keywords.filter((k) => roleSet.has(lower(k)));
  if (dupes.length) {
    notes.push(
      `${dupes.length} value(s) appeared in both search_roles and match_keywords (${dupes.slice(0, 4).join(", ")}) — they are different kinds of list; review before saving.`
    );
  }
  if (draft.search_roles.length > ARRAY_CAPS.search_roles) {
    notes.push(`search_roles was trimmed to ${ARRAY_CAPS.search_roles}; each one is a live search request.`);
  }

  // Contact details: verified against the submitted text, or flagged as
  // unverifiable. Never returned on trust.
  const stripped = sourceText ? sourceText.toLowerCase() : "";
  const digitsOnly = sourceText ? sourceText.replace(/[^0-9]/g, "") : "";
  const dropped = [];
  const missing = [];
  for (const f of CONTACT_FIELDS) {
    if (!draft[f]) {
      missing.push(f);
      continue;
    }
    if (!sourceText) continue;
    const ok =
      f === "phone"
        ? digitsOnly.includes(draft[f].replace(/[^0-9]/g, "")) && draft[f].replace(/[^0-9]/g, "").length >= 7
        : stripped.includes(draft[f].toLowerCase()) ||
          // A URL is often written without its scheme in a resume.
          stripped.includes(draft[f].toLowerCase().replace(/^https?:\/\//, ""));
    if (!ok) {
      draft[f] = "";
      dropped.push(f);
    }
  }
  if (dropped.length) {
    notes.push(
      `Dropped ${dropped.join(", ")} — the value returned does not appear in the submitted text, so it was not read from the resume.`
    );
  }
  if (missing.length) {
    notes.push(`Not present in the resume, left empty: ${missing.join(", ")}.`);
  }
  if (!sourceText) {
    notes.push(
      "Input was a PDF, so contact details could not be checked against source text — verify email, phone and links yourself before saving."
    );
  }

  // Confidence for exactly the fields we are returning, defaulted rather than
  // omitted so the UI can render a badge for every row.
  const confidence = {};
  for (const f of [...STRING_FIELDS, ...NUMBER_FIELDS, ...ARRAY_FIELDS]) {
    const v = lower(inConf[f]);
    const filled = Array.isArray(draft[f]) ? draft[f].length > 0 : Boolean(draft[f]);
    confidence[f] = CONFIDENCE.includes(v) ? v : filled ? "medium" : "low";
    if (dropped.includes(f)) confidence[f] = "low";
  }

  return { draft, confidence, notes: notes.slice(0, 12) };
}

const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const str = (v) => (typeof v === "string" ? v.trim().slice(0, 500) : "");

function num(v) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(Math.min(n, 60) * 10) / 10;
}

function arr(v, cap) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const t = item.trim().slice(0, 80);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= (cap || 30)) break;
  }
  return out;
}
