/** Profile helpers — one place that knows the shape of a `profiles` row.
 *
 *  The JSON-array columns are handled exactly the way `hr`/`em`/`wa` are in
 *  db.js: parsed defensively on read (a bad row degrades to `[]` rather than
 *  500-ing the listing) and stringified on write. Callers never see or send a
 *  JSON string.
 */
import { VALID_TABS } from "./db.js";

/** The JSON-array columns. */
export const ARRAY_FIELDS = [
  "search_roles",
  "search_locations",
  "match_keywords",
  "must_have",
  "nice_to_have",
  "exclude_titles",
  "exclude_stacks",
  "cities",
];

/** Identity — fills message templates, never changes who gets scraped. */
export const IDENTITY_FIELDS = [
  "name",
  "full_name",
  "headline",
  "years",
  "current_company",
  "email",
  "phone",
  "linkedin",
  "github",
  "portfolio",
  "resume_url",
  "notice_period",
];

/** Targeting — changing any of these changes which leads qualify and how they
 *  score, so `version` bumps and newly-judged leads get stamped with the new
 *  number. `min_grade` is in here on purpose: it is a gate on what reaches the
 *  board, so a lead accepted under `C` is not comparable to one accepted under
 *  `B`. This list is the single source of truth for the bump rule — the PUT
 *  handler must not keep its own copy. */
export const TARGETING_FIELDS = [
  "search_roles",
  "search_locations",
  "match_keywords",
  "must_have",
  "nice_to_have",
  "exclude_titles",
  "exclude_stacks",
  "cities",
  "exp_min",
  "exp_max",
  "remote_pref",
  "employment_type",
  "min_grade",
];

export const NUMBER_FIELDS = ["years", "exp_min", "exp_max"];

export const ENUMS = {
  remote_pref: ["any", "remote", "hybrid", "onsite"],
  employment_type: ["any", "full-time", "contract", "internship"],
  min_grade: ["A", "B", "C", "D"],
};

/** Every writable field, identity + targeting. `version`, `is_default`,
 *  `created_at` and `updated_at` are managed by the handlers, not the body. */
export const WRITABLE_FIELDS = [...IDENTITY_FIELDS, ...TARGETING_FIELDS];

function safeArray(text) {
  if (Array.isArray(text)) return text;
  try {
    const v = JSON.parse(text || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** DB row -> API shape (parses the JSON-array columns). */
export function rowToProfile(row) {
  if (!row) return null;
  const out = {
    id: row.id,
    version: row.version,
    name: row.name,
    is_default: row.is_default ? 1 : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    full_name: row.full_name || "",
    headline: row.headline || "",
    years: row.years ?? 0,
    current_company: row.current_company || "",
    email: row.email || "",
    phone: row.phone || "",
    linkedin: row.linkedin || "",
    github: row.github || "",
    portfolio: row.portfolio || "",
    resume_url: row.resume_url || "",
    notice_period: row.notice_period || "",
    exp_min: row.exp_min ?? 0,
    exp_max: row.exp_max ?? 99,
    remote_pref: row.remote_pref || "any",
    employment_type: row.employment_type || "any",
    min_grade: row.min_grade || "C",
  };
  for (const f of ARRAY_FIELDS) out[f] = safeArray(row[f]);
  if (row.lead_count !== undefined) out.lead_count = row.lead_count;
  return out;
}

/** Normalize one incoming field value to what the column stores.
 *  Returns { value } or { error }. */
export function coerceField(field, raw) {
  if (ARRAY_FIELDS.includes(field)) {
    if (!Array.isArray(raw)) return { error: `${field} must be an array` };
    const items = raw
      .filter((v) => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
    if (field === "cities") {
      const bad = items.filter((c) => !VALID_TABS.includes(c));
      // The five tab keys are fixed until SECTIONS is collapsed — a profile may
      // use a subset, never a new one. See PROFILE-CONTRACT.md.
      if (bad.length) return { error: `invalid city keys: ${bad.join(", ")} (allowed: ${VALID_TABS.join(", ")})` };
    }
    return { value: JSON.stringify(dedupe(items)) };
  }
  if (NUMBER_FIELDS.includes(field)) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0) return { error: `${field} must be a non-negative number` };
    return { value: n };
  }
  if (ENUMS[field]) {
    const v = String(raw ?? "");
    if (!ENUMS[field].includes(v)) return { error: `${field} must be one of ${ENUMS[field].join(", ")}` };
    return { value: v };
  }
  if (typeof raw !== "string") return { error: `${field} must be a string` };
  return { value: raw.trim().slice(0, 500) };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** True when this write touches a targeting field with a genuinely different
 *  value. Compares the *stored* representation of both sides, so re-saving the
 *  same array in a different order still bumps (order matters to search URLs)
 *  but re-saving an identical body does not. */
export function targetingChanged(existingRow, updates) {
  for (const field of TARGETING_FIELDS) {
    if (!(field in updates)) continue;
    const before = ARRAY_FIELDS.includes(field)
      ? JSON.stringify(safeArray(existingRow[field]))
      : existingRow[field];
    const after = updates[field];
    // Loose compare on the numerics: SQLite hands REAL columns back as 1 or 1.0
    // depending on the driver, and that is not a targeting change.
    if (NUMBER_FIELDS.includes(field)) {
      if (Number(before) !== Number(after)) return true;
    } else if (String(before) !== String(after)) {
      return true;
    }
  }
  return false;
}

function jaccard(a, b) {
  const A = new Set(a.map((v) => String(v).toLowerCase().trim()).filter(Boolean));
  const B = new Set(b.map((v) => String(v).toLowerCase().trim()).filter(Boolean));
  // Two empty sets are vacuously identical: neither profile constrains on this
  // axis, so it should not drag the score down.
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const v of A) if (B.has(v)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/** Experience-band overlap as a fraction of the union of the two bands. */
function bandOverlap(aMin, aMax, bMin, bMax) {
  const a0 = Math.min(Number(aMin) || 0, Number(aMax) || 0);
  const a1 = Math.max(Number(aMin) || 0, Number(aMax) || 0);
  const b0 = Math.min(Number(bMin) || 0, Number(bMax) || 0);
  const b1 = Math.max(Number(bMin) || 0, Number(bMax) || 0);
  const interLo = Math.max(a0, b0);
  const interHi = Math.min(a1, b1);
  const inter = Math.max(0, interHi - interLo);
  const union = Math.max(a1, b1) - Math.min(a0, b0);
  if (union <= 0) {
    // Both bands are a single point — identical points overlap fully.
    return a0 === b0 && a1 === b1 ? 1 : 0;
  }
  return inter / union;
}

export const SIMILARITY_WEIGHTS = {
  match_keywords: 0.35,
  cities: 0.30,
  experience: 0.20,
  search_roles: 0.15,
};

export const SIMILARITY_THRESHOLD = 0.6;

/** Weighted-Jaccard similarity between two profiles, per PROFILE-CONTRACT.md.
 *  Takes API-shaped objects (real arrays), not raw rows. */
export function similarity(a, b) {
  const w = SIMILARITY_WEIGHTS;
  const score =
    w.match_keywords * jaccard(a.match_keywords || [], b.match_keywords || []) +
    w.cities * jaccard(a.cities || [], b.cities || []) +
    w.experience * bandOverlap(a.exp_min, a.exp_max, b.exp_min, b.exp_max) +
    w.search_roles * jaccard(a.search_roles || [], b.search_roles || []);
  return Math.round(score * 1000) / 1000;
}

/** Parse a `:id` path segment. Returns null when it is not a positive int. */
export function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const PROFILE_COLUMNS = [
  "version",
  ...WRITABLE_FIELDS,
];

/* --------------------------------------------------------------------------
 * Which profile is a request talking about?
 *
 * `progress` and `stage_history` are keyed by (profile_id, company_id) since
 * migration 008, so every reader has to answer this question — and they must
 * all answer it the same way, hence one helper here rather than a copy per
 * handler.
 *
 * The convention, everywhere: an optional `?profile_id=` query parameter
 * (POST handlers also accept `profile_id` in the JSON body). When it is absent
 * the default profile is used, which is what keeps a client that has never
 * heard of profiles — index.html today — working unchanged.
 * ------------------------------------------------------------------------ */

/** Last-resort id. PROFILE-CONTRACT.md pins the parent profile at id 1, and
 *  `companies.profile_id` / 008's backfill both default to 1, so an empty
 *  `profiles` table (a database that has not run migration 006's seed) still
 *  resolves to the same place the data was stamped with. */
export const PARENT_PROFILE_ID = 1;

/** The id of the profile flagged `is_default`, scoped to one user.
 *  Exactly one row should hold the flag — profile/[id].js PUT enforces that —
 *  but this tolerates none and many rather than throwing, because returning
 *  the wrong-but-stable id degrades better than 500-ing every read in the app.
 *
 *  `is_default` is global rather than per-user, so the flagged row may belong to
 *  somebody else. Scoping by owner first is what stops a second tenant whose own
 *  profile is not flagged from silently defaulting onto the parent's board — the
 *  exact ambient-access bug the ownership check below exists to close. A user
 *  with no profiles at all gets PARENT_PROFILE_ID, which then fails the
 *  ownership check rather than resolving to somebody else's data.
 */
export async function defaultProfileId(env, userId = null) {
  const uid = Number(userId);
  if (Number.isInteger(uid) && uid > 0) {
    const mine = await env.DB
      .prepare(`SELECT id FROM profiles WHERE owner_user_id = ?1
                 ORDER BY is_default DESC, id ASC LIMIT 1`)
      .bind(uid)
      .first();
    if (mine) return mine.id;
    return PARENT_PROFILE_ID;
  }

  const flagged = await env.DB
    .prepare("SELECT id FROM profiles WHERE is_default = 1 ORDER BY id ASC LIMIT 1")
    .first();
  if (flagged) return flagged.id;
  const first = await env.DB.prepare("SELECT id FROM profiles ORDER BY id ASC LIMIT 1").first();
  return first ? first.id : PARENT_PROFILE_ID;
}

/** Assert that `userId` owns `profileId`.
 *
 *  Returns `{ ok: true }`, or `{ error, status }` with 404 when the profile does
 *  not exist and 403 when it exists but belongs to someone else. Those two are
 *  deliberately distinguishable: this app has no public surface — every caller
 *  is already authenticated by _middleware.js — so hiding existence behind a
 *  blanket 404 would only make a tenant's own typo unreadable while telling an
 *  attacker who already has an account nothing they could not learn from
 *  /api/profile/:id/similar anyway.
 *
 *  A null/absent `userId` fails closed. Handlers must pass the id from
 *  `context.data.userId`; forgetting to is a bug, and it should present as a
 *  refusal rather than as unrestricted access.
 *
 *  THE ADMIN PATH
 *  `isAdmin` lets an administrator through on a profile they do not own. It is
 *  opt-in per call site rather than a blanket rule, because "can administer the
 *  installation" and "may read this tenant's board" are different powers and
 *  collapsing them would quietly turn every lead-reading endpoint into an
 *  admin-can-see-everything endpoint. Only profile MANAGEMENT passes it — see
 *  functions/api/profile/[id].js. It never reaches `resolveProfileId`, so
 *  `?profile_id=` stays owner-only for admins too: an admin who wants to read
 *  another tenant's leads has to be given that profile, not merely ask for it.
 */
export async function assertProfileOwner(env, profileId, userId, isAdmin = false) {
  const id = parseId(profileId);
  if (!id) return { error: "invalid profile id", status: 400 };

  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid < 1) {
    return { error: "not authenticated", status: 401 };
  }

  const row = await env.DB
    .prepare("SELECT id, owner_user_id FROM profiles WHERE id = ?1")
    .bind(id)
    .first();
  if (!row) return { error: `profile ${id} not found`, status: 404 };
  if (Number(row.owner_user_id) !== uid && !isAdmin) {
    return { error: `profile ${id} belongs to another user`, status: 403 };
  }
  return { ok: true };
}

/** Resolve the profile a request operates on.
 *
 *  Returns `{ id }` on success, or `{ error, status }` when the caller named a
 *  profile that is not a positive integer (400) or does not exist (404). An
 *  explicitly requested profile is always validated against the table: scoping
 *  every query by an id nobody checked would silently return an empty board
 *  instead of saying why.
 *
 *  @param url  the request URL, for `?profile_id=`
 *  @param body an already-parsed JSON body, or null. Only consulted when the
 *              query string does not carry the parameter, so a URL always wins.
 */
export async function resolveProfileId(env, url, body = null, userId = null) {
  let raw = url && url.searchParams ? url.searchParams.get("profile_id") : null;
  if (raw === null || raw === "") {
    raw = body && typeof body === "object" && body.profile_id !== undefined && body.profile_id !== null
      ? body.profile_id
      : null;
  }
  if (raw === null || raw === "") return { id: await defaultProfileId(env, userId) };

  const id = parseId(raw);
  if (!id) return { error: "profile_id must be a positive integer", status: 400 };

  // The ownership check is HERE, in the one function every profile-scoped
  // handler already routes through, rather than repeated per endpoint. Ten
  // handlers resolve a profile; a check copied ten times is a check that is
  // missing from the eleventh. `?profile_id=` is attacker-controlled input on
  // every one of them, so this is the single place that decides whether naming
  // a profile is allowed.
  // FAILS CLOSED on a missing userId, rather than falling back to the old
  // existence-only check. Every route that reaches here is behind
  // _middleware.js, which sets `context.data.userId` for all of them — push.py
  // and the extension included, since they authenticate through /api/login like
  // any browser. So "no userId" cannot mean "a legitimate caller without an
  // account"; it can only mean a handler forgot to pass it, or the middleware
  // stopped populating it. Both are bugs, and a permissive default would let
  // either one silently restore pre-multi-tenancy behaviour on every profile-
  // scoped route at once, with no error to notice it by.
  const owned = await assertProfileOwner(env, id, userId);
  return owned.ok ? { id } : owned;
}

/** SQL predicate for "company `c` is visible to profile ?1".
 *
 *  A lead is visible when the profile owns the company row (`companies.
 *  profile_id`, stamped by 006) or has adopted it (`profile_companies`, the
 *  many-to-many visibility edge). Written as EXISTS rather than a join so it
 *  can be dropped into a WHERE clause without changing the row count of the
 *  query it is added to — a company adopted twice must still be counted once.
 *
 *  Requires the `companies` table to be aliased `c` and profile_id bound to ?1.
 */
export const VISIBLE_TO_PROFILE = `(
    c.profile_id = ?1
    OR EXISTS (SELECT 1 FROM profile_companies pc
                WHERE pc.company_id = c.id AND pc.profile_id = ?1)
  )`;

/** SQL join condition pairing `progress` with the requesting profile.
 *  Belongs in the ON clause of a LEFT JOIN, never the WHERE: moving it to the
 *  WHERE would turn the outer join inner and drop every company this profile
 *  has not set a stage on yet. */
export const PROGRESS_ON_PROFILE = "p.company_id = c.id AND p.profile_id = ?1";
