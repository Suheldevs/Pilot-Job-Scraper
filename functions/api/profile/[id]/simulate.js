/** GET  /api/profile/:id/simulate — what would this profile match?
 *  POST /api/profile/:id/simulate — same, with an unsaved edit applied first.
 *
 *  Answers "if I changed my targeting, what would I actually get?" before the
 *  change is saved and before anything is scraped. It runs entirely against
 *  leads already in the database: no network, no AI, no Gemini call, no writes.
 *  POST takes an override body so an in-progress form edit can be simulated
 *  without saving — which matters because saving a targeting field bumps
 *  `version`, and a version bump is not something to do speculatively.
 *
 *  ⚠️ THIS IS AN APPROXIMATION OF relevance.py, NOT A REPLAY OF IT.
 *  relevance.py runs at scrape time against a live `Job`: the full job
 *  description, the source's tag list, and the raw location string. This runs
 *  after the fact against stored columns, so it differs in ways that will make
 *  the numbers disagree with a real scrape:
 *
 *   - TITLE ONLY, NO TAGS. relevance.py matches role terms against
 *     `title + tags`; the tag list is never persisted, so only `job_title` is
 *     available here. Leads whose stack was proven by a tag look unmatched.
 *   - JD EXCERPT, NOT THE JD. The rescue path (an engineering title whose
 *     stack is only stated in the description) reads `jd_excerpt`, which is
 *     the first chunk of the JD and is empty for the thin sources entirely.
 *   - `tab`, NOT THE LOCATION STRING. The city gate compares the already
 *     classified `tab` against the profile's `cities`, so it cannot reproduce
 *     `locations.classify` — including its rule that "remote" wins over any
 *     city name in the same string.
 *   - SURVIVORS ONLY. Every row in the table already passed the *previous*
 *     profile's gate. Leads that gate rejected were never written, so
 *     loosening a profile can only ever be under-counted here: this can show
 *     you what you would LOSE precisely, and only hint at what you would gain.
 *   - EXPERIENCE IS EXTRA. relevance.py has no experience check at all (that
 *     lives in the scrape config); it is included here because it is the edit
 *     users most want to test, and it is applied last so it never masks a
 *     relevance reason. It only fires when the row actually recorded an
 *     experience range — a null is "the source didn't say", not zero.
 *   - NO SCORING. `min_grade`, `remote_pref` and `employment_type` are not
 *     applied. This is the relevance gate, not scoring.py's 0-100; a lead that
 *     matches here could still be graded below the profile's `min_grade`.
 *
 *  What it does reproduce faithfully is the matching itself: WORD-BOUNDARY, not
 *  substring. relevance.py documents `"react"` as a bare substring matching
 *  "Associate Director Reactivations Outbound" as a real production false
 *  positive. The same `(?<![a-z0-9])term(?![a-z0-9])` guard is used here so the
 *  simulator cannot reintroduce it, and the rejection reason is the first
 *  matching term, in the profile's declared order, exactly as there.
 */
import { json, badRequest, notFound, VALID_TABS } from "../../../lib/db.js";
import { rowToProfile, parseId } from "../../../lib/profile.js";

/** Ported verbatim from relevance.GENERIC_ROLE_WORDS. Generic role words are
 *  plausibly ours but say nothing about which stack, so they do not earn a
 *  hybrid title the wrong-discipline exemption. */
const GENERIC_ROLE_WORDS = new Set([
  "full stack", "fullstack", "full-stack",
  "frontend", "front end", "front-end",
  "backend", "back end", "back-end", "web developer",
  "software engineer", "software developer", "sde",
]);

/** relevance.JUNIOR_TITLE_WORDS — splits exclude_titles into two distinct
 *  rejection reasons ("is senior-level" vs "is an intern"). Anything
 *  unrecognised is treated as a seniority word, same as there. */
const JUNIOR_TITLE_WORDS = new Set([
  "intern", "internship", "trainee", "apprentice", "fresher only",
  "junior", "jr", "fresher",
]);

/** relevance.ENGINEERING_NOUNS — only these titles get their relevance decided
 *  by the description, so "Growth Analyst" at a company whose JD mentions
 *  React cannot sneak in. */
const ENGINEERING_NOUNS = [
  "developer", "engineer", "programmer", "sde", "swe", "software",
  "technologist", "coder",
];

/** relevance.py reads the first 2000 chars of the JD on the rescue path. */
const JD_RESCUE_CHARS = 2000;

const SAMPLE_MATCHES = 20;
const SAMPLE_REJECTS = 10;

/** A guard, not a page: 292 rows in production, and the whole point is a total.
 *  If the table ever grows past this the answer stops being trustworthy, so it
 *  says so rather than quietly truncating. */
const MAX_SCAN = 20_000;

/** Fields an override may change. Only the ones this gate actually reads —
 *  anything else in the body is reported back as ignored rather than silently
 *  swallowed, so a caller never thinks they simulated `min_grade`. */
const SIMULATABLE_ARRAYS = ["must_have", "nice_to_have", "exclude_titles", "exclude_stacks", "cities"];
const SIMULATABLE_NUMBERS = ["exp_min", "exp_max"];

const REASONS = {
  NO_TITLE: "no role title recorded",
  NO_ROLE: "no role/stack match",
  TOO_SENIOR: "title is senior-level",
  TOO_JUNIOR: "title is too junior",
  WRONG_DISCIPLINE: "title centred on an excluded stack",
  CITY: "city not in profile",
  EXPERIENCE: "experience outside band",
};

export async function onRequestGet(context) {
  return handle(context, null);
}

export async function onRequestPost(context) {
  const { request } = context;
  const raw = await request.json().catch(() => null);
  if (raw === null) {
    return badRequest("POST expects a JSON object of profile overrides (send GET to simulate the saved profile)");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return badRequest("expected a JSON object");
  // Accept either the fields at the top level or nested under `profile`, since
  // a UI holding a whole form object is the obvious caller.
  const source = raw.profile && typeof raw.profile === "object" && !Array.isArray(raw.profile) ? raw.profile : raw;
  return handle(context, source);
}

async function handle(context, override) {
  const { env, params } = context;
  const id = parseId(params.id);
  if (!id) return badRequest("invalid profile id");

  const row = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(id).first();
  if (!row) return notFound("profile not found");
  const saved = rowToProfile(row);

  const applied = override ? applyOverride(saved, override) : { profile: saved, changed: [], ignored: [] };
  if (applied.error) return badRequest(applied.error);
  const simulated = applied.profile;

  const { results } = await env.DB.prepare(`
    SELECT id, name, tab, job_title, jd_excerpt, grade, score,
           experience_min, experience_max, experience_raw
      FROM companies
     ORDER BY id
     LIMIT ${MAX_SCAN + 1}
  `).all();
  const companies = results || [];
  const truncated = companies.length > MAX_SCAN;
  if (truncated) companies.length = MAX_SCAN;

  const simRun = runGate(companies, simulated);
  // The saved profile is evaluated on every request, override or not: the delta
  // is the whole point, and a GET with no override should still be able to say
  // "this is your baseline" without a second round trip.
  const curRun = applied.changed.length ? runGate(companies, saved) : simRun;

  const caveats = buildCaveats(simulated, companies, truncated);

  return json({
    profile_id: id,
    profile_name: saved.name,
    profile_version: saved.version,
    simulated: applied.changed.length > 0,
    overridden_fields: applied.changed,
    ignored_fields: applied.ignored,

    total_scanned: simRun.scanned,
    would_match: simRun.matched.length,
    would_reject: simRun.rejected.length,
    by_reason: simRun.byReason,
    by_city: simRun.byCity,

    sample_matches: simRun.matched.slice(0, SAMPLE_MATCHES).map((m) => ({
      id: m.id,
      name: m.name,
      tab: m.tab,
      job_title: m.job_title,
      matched_on: m.matched_on,
      via: m.via,
      grade: m.grade || "",
      score: m.score || 0,
    })),
    sample_rejects: simRun.rejected.slice(0, SAMPLE_REJECTS).map((r) => ({
      id: r.id,
      name: r.name,
      tab: r.tab,
      job_title: r.job_title,
      reason: r.reason,
      detail: r.detail,
    })),

    vs_current: {
      current_would_match: curRun.matched.length,
      current_would_reject: curRun.rejected.length,
      simulated_would_match: simRun.matched.length,
      delta: simRun.matched.length - curRun.matched.length,
      ...diff(curRun, simRun),
    },

    effective_targeting: {
      must_have: simulated.must_have,
      nice_to_have: simulated.nice_to_have,
      exclude_titles: simulated.exclude_titles,
      exclude_stacks: simulated.exclude_stacks,
      cities: simulated.cities,
      exp_min: simulated.exp_min,
      exp_max: simulated.exp_max,
    },
    caveats,
  });
}

/* ------------------------------------------------------------------ override */

function applyOverride(saved, body) {
  const profile = { ...saved };
  const changed = [];
  const ignored = [];

  for (const [key, value] of Object.entries(body)) {
    if (key === "profile") continue;
    if (SIMULATABLE_ARRAYS.includes(key)) {
      if (!Array.isArray(value)) return { error: `${key} must be an array` };
      const items = dedupe(
        value.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean)
      );
      if (key === "cities") {
        const bad = items.filter((c) => !VALID_TABS.includes(c));
        if (bad.length) {
          return { error: `invalid city keys: ${bad.join(", ")} (allowed: ${VALID_TABS.join(", ")})` };
        }
      }
      if (JSON.stringify(items) !== JSON.stringify(saved[key])) changed.push(key);
      profile[key] = items;
      continue;
    }
    if (SIMULATABLE_NUMBERS.includes(key)) {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n) || n < 0) return { error: `${key} must be a non-negative number` };
      if (Number(saved[key]) !== n) changed.push(key);
      profile[key] = n;
      continue;
    }
    // Deliberately not simulated: identity fields change nothing about
    // matching, and min_grade / remote_pref / employment_type belong to
    // scoring, which this endpoint does not run.
    ignored.push(key);
  }

  if (Number(profile.exp_min) > Number(profile.exp_max)) {
    return { error: `exp_min (${profile.exp_min}) is above exp_max (${profile.exp_max})` };
  }
  return { profile, changed, ignored };
}

/* ---------------------------------------------------------------- the gate */

/** relevance._terms(), in JS. Order inside each list is load-bearing: the
 *  first matching term is the reported reason, so must_have comes first. */
function buildTerms(profile) {
  const stack = dedupe([...(profile.must_have || []), ...(profile.nice_to_have || [])]);
  const titles = profile.exclude_titles || [];
  return {
    roleTerms: compile(stack),
    specificStack: compile(stack.filter((t) => !GENERIC_ROLE_WORDS.has(t.toLowerCase()))),
    tooSenior: compile(titles.filter((t) => !JUNIOR_TITLE_WORDS.has(t.toLowerCase()))),
    tooJunior: compile(titles.filter((t) => JUNIOR_TITLE_WORDS.has(t.toLowerCase()))),
    wrongDiscipline: compile(profile.exclude_stacks || []),
    engineeringNouns: compile(ENGINEERING_NOUNS),
  };
}

/** Compile once per run, not once per company — 292 rows x ~90 terms is 26k
 *  regex constructions otherwise. */
function compile(terms) {
  const out = [];
  for (const raw of terms) {
    const term = String(raw || "").trim().toLowerCase();
    if (!term) continue;
    try {
      // The word-boundary guard relevance.py uses. Not \b: \b would treat the
      // "." in "next.js" and the "#" in "c#" as boundaries, which is how the
      // substring false positives creep back in.
      out.push({ term: raw, re: new RegExp(`(?<![a-z0-9])${escapeRe(term)}(?![a-z0-9])`) });
    } catch {
      // A term that will not compile degrades to a literal containment test
      // rather than taking the whole simulation down, same as relevance.py's
      // `except re.error` fallback.
      out.push({ term: raw, re: null, literal: term });
    }
  }
  return out;
}

/** First term present as a whole word/phrase, else null. */
function hasTerm(text, compiled) {
  if (!text) return null;
  const low = String(text).toLowerCase();
  for (const t of compiled) {
    if (t.re ? t.re.test(low) : low.includes(t.literal)) return t.term;
  }
  return null;
}

function runGate(companies, profile) {
  const terms = buildTerms(profile);
  const cities = (profile.cities || []).filter(Boolean);
  const cityGate = cities.length ? new Set(cities) : null;
  const expMin = Number(profile.exp_min);
  const expMax = Number(profile.exp_max);

  const matched = [];
  const rejected = [];
  const byReason = {};
  const byCity = {};

  for (const row of companies) {
    const tab = row.tab || "?";
    if (!byCity[tab]) byCity[tab] = { scanned: 0, matched: 0, rejected: 0 };
    byCity[tab].scanned += 1;

    const verdict = evaluate(row, terms, { cityGate, expMin, expMax });
    if (verdict.keep) {
      byCity[tab].matched += 1;
      matched.push({
        id: row.id,
        name: row.name,
        tab,
        job_title: row.job_title || "",
        matched_on: verdict.hit,
        via: verdict.via,
        grade: row.grade,
        score: row.score,
      });
    } else {
      byCity[tab].rejected += 1;
      byReason[verdict.reason] = (byReason[verdict.reason] || 0) + 1;
      rejected.push({
        id: row.id,
        name: row.name,
        tab,
        job_title: row.job_title || "",
        reason: verdict.reason,
        detail: verdict.detail,
      });
    }
  }

  // Biggest bucket first — the useful reading order for "why am I getting
  // nothing?".
  const sortedReasons = Object.fromEntries(Object.entries(byReason).sort((a, b) => b[1] - a[1]));

  return { scanned: companies.length, matched, rejected, byReason: sortedReasons, byCity };
}

/** relevance.is_relevant(), in the same order, with the two documented
 *  substitutions (title-only haystack, tab instead of location string) and the
 *  experience check appended last. */
function evaluate(row, terms, gates) {
  const title = row.job_title || "";

  // 1. Right kind of work? Title first; the JD excerpt may only rescue a post
  //    whose title is at least an engineering role.
  if (!title) {
    // relevance.py would fold this into "no role/stack match", but a lead the
    // scraper stored with no title at all is a data gap rather than a
    // targeting decision, and conflating the two hides how much of the board
    // this endpoint simply cannot judge.
    return { keep: false, reason: REASONS.NO_TITLE, detail: "the stored lead has no job_title to match against" };
  }

  let hit = hasTerm(title, terms.roleTerms);
  let via = "title";
  if (!hit && hasTerm(title, terms.engineeringNouns)) {
    hit = hasTerm(String(row.jd_excerpt || "").slice(0, JD_RESCUE_CHARS), terms.roleTerms);
    if (hit) via = "jd_excerpt";
  }
  if (!hit) {
    return {
      keep: false,
      reason: REASONS.NO_ROLE,
      detail: `no must_have/nice_to_have term appears in "${trunc(title, 80)}"`,
    };
  }

  // 2. Right level? Title-only — JD boilerplate mentions seniority constantly.
  const senior = hasTerm(title, terms.tooSenior);
  if (senior) {
    return { keep: false, reason: REASONS.TOO_SENIOR, detail: `title contains excluded seniority term "${senior}"` };
  }
  const junior = hasTerm(title, terms.tooJunior);
  if (junior) {
    return { keep: false, reason: REASONS.TOO_JUNIOR, detail: `title contains excluded junior term "${junior}"` };
  }

  // 3. Right discipline? Title-only, with the hybrid-title exemption: it takes
  //    a *specific* stack word, not a generic one. "React / Java Full Stack"
  //    is genuinely half ours; ".NET Full Stack Developer" is a .NET job that
  //    happens to say "full stack".
  const wrong = hasTerm(title, terms.wrongDiscipline);
  if (wrong && !hasTerm(title, terms.specificStack)) {
    return {
      keep: false,
      reason: REASONS.WRONG_DISCIPLINE,
      detail: `title is centred on "${String(wrong).trim()}" with no specific stack term to offset it`,
    };
  }

  // 4. Somewhere we actually work? Against the stored tab, not the raw string.
  if (gates.cityGate && !gates.cityGate.has(row.tab)) {
    return { keep: false, reason: REASONS.CITY, detail: `tab "${row.tab}" is not in the profile's cities` };
  }

  // 5. Experience band. Not part of relevance.py; applied last so it can never
  //    mask a relevance reason. Skipped entirely when the row recorded no
  //    range — null means "the source didn't say", not zero.
  const cMin = row.experience_min;
  const cMax = row.experience_max;
  if (cMin != null || cMax != null) {
    const lo = cMin != null ? Number(cMin) : Number(cMax);
    const hi = cMax != null ? Number(cMax) : Number(cMin);
    if (Number.isFinite(lo) && Number.isFinite(hi) && (hi < gates.expMin || lo > gates.expMax)) {
      return {
        keep: false,
        reason: REASONS.EXPERIENCE,
        detail: `role asks ${row.experience_raw || `${lo}-${hi}y`}, profile band is ${gates.expMin}-${gates.expMax}y`,
      };
    }
  }

  return { keep: true, hit, via };
}

/* ------------------------------------------------------------------- deltas */

function diff(curRun, simRun) {
  const before = new Map(curRun.matched.map((m) => [m.id, m]));
  const after = new Map(simRun.matched.map((m) => [m.id, m]));

  const gained = [];
  for (const [id, m] of after) if (!before.has(id)) gained.push(m);
  const lost = [];
  for (const [id, m] of before) if (!after.has(id)) lost.push(m);

  const reasonDelta = {};
  for (const key of new Set([...Object.keys(curRun.byReason), ...Object.keys(simRun.byReason)])) {
    const d = (simRun.byReason[key] || 0) - (curRun.byReason[key] || 0);
    if (d !== 0) reasonDelta[key] = d;
  }

  const brief = (m) => ({ id: m.id, name: m.name, tab: m.tab, job_title: m.job_title });
  return {
    gained_count: gained.length,
    lost_count: lost.length,
    gained: gained.slice(0, SAMPLE_MATCHES).map(brief),
    // Losses are the ones the simulator can measure exactly, so show more of
    // them — see the header note about survivor bias on gains.
    lost: lost.slice(0, SAMPLE_MATCHES).map((m) => ({
      ...brief(m),
      new_reason: simRun.rejected.find((r) => r.id === m.id)?.reason || "",
    })),
    by_reason_delta: reasonDelta,
  };
}

/* ------------------------------------------------------------------ caveats */

function buildCaveats(profile, companies, truncated) {
  const out = [
    "Approximation of relevance.py, not a replay: it matches the stored job_title and jd_excerpt columns, not the full job description or the source's tag list, so a real scrape will not agree perfectly.",
    "Every lead in the table already passed some earlier profile's gate, so a loosened profile is under-counted here — losses are exact, gains are a floor.",
    "min_grade, remote_pref and employment_type are not applied: this is the relevance gate, not scoring.py.",
  ];

  const noTitle = companies.filter((c) => !c.job_title).length;
  if (noTitle) {
    out.push(
      `${noTitle} of ${companies.length} leads have no stored job_title, so nothing can be matched against them — they are counted under "${REASONS.NO_TITLE}", not judged.`
    );
  }
  const noJd = companies.filter((c) => !c.jd_excerpt).length;
  if (noJd) {
    out.push(
      `${noJd} leads have no jd_excerpt, so the description rescue path (an engineering title whose stack is only stated in the JD) cannot fire for them.`
    );
  }
  const withExp = companies.filter((c) => c.experience_min != null || c.experience_max != null).length;
  out.push(
    withExp
      ? `The experience band was applied to the ${withExp} leads that recorded one; the other ${companies.length - withExp} skip that check.`
      : "No lead in the table recorded an experience range, so the exp_min/exp_max band changed nothing in this run."
  );
  if (!(profile.cities || []).length) {
    out.push("The profile lists no cities, so the city gate was skipped entirely rather than rejecting every lead.");
  }
  if (truncated) {
    out.push(`Only the first ${MAX_SCAN} leads were scanned; the totals are a lower bound.`);
  }
  return out;
}

/* ------------------------------------------------------------------- utils */

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = String(item).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const trunc = (s, n) => {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
