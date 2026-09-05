/** GET  /api/users  — list every user. Admin only.
 *  POST /api/users  — create a user. Admin only.
 *
 *  _middleware.js authenticates the whole /api/* tree, so the caller here is
 *  always *a* user and the session is never re-checked. What is checked is
 *  authorisation, and both handlers are admin-only for the same reason: this is
 *  the tenant directory. A listing hands out every other tenant's email address,
 *  and a create call mints a login into the deployment. Neither is something one
 *  tenant may do to another, and 010's whole point was that "holds a valid
 *  cookie" is no longer the same question as "may see this".
 *
 *  `pw_hash` is never selected. Every statement below names its columns rather
 *  than using SELECT *, so a future ALTER TABLE cannot quietly widen a response
 *  into leaking the hash — the failure mode of SELECT * is that nobody has to
 *  make a decision for the leak to happen. `has_password` is computed in SQL
 *  (`pw_hash <> ''`) precisely so the hash never enters the Worker's memory to
 *  begin with; a UI still needs to know who cannot log in yet, and that is the
 *  only fact about the hash anyone outside password.js is entitled to.
 */
import { json, badRequest } from "../lib/db.js";
import { hashPassword } from "../lib/password.js";

/** Matches functions/api/user/password.js. Kept as two constants rather than a
 *  shared export because the two files are separate route modules and neither
 *  is a natural home for the other's policy; if this changes, change both.
 *  Twelve because the login page asks for a "passphrase", not a password, and a
 *  passphrase floor below that is theatre. */
const MIN_PASSPHRASE_LENGTH = 12;

/** The public shape of a user. `profile_count` mirrors the `lead_count` that
 *  profiles.js attaches: it is what makes the DELETE refusal in user/[id].js
 *  predictable from a listing instead of a surprise at the click. */
const USER_COLUMNS = `
  u.id, u.email, u.name, u.is_admin, u.created_at, u.last_login_at,
  (u.pw_hash <> '') AS has_password,
  (SELECT COUNT(*) FROM profiles p WHERE p.owner_user_id = u.id) AS profile_count
`;

/** SQLite has no booleans, so the integers come back as 0/1. Normalised here so
 *  a client can treat `is_admin` and `has_password` as flags without knowing
 *  which of them is a stored column and which is an expression. */
function rowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || "",
    is_admin: row.is_admin ? 1 : 0,
    created_at: row.created_at,
    last_login_at: row.last_login_at ?? null,
    has_password: !!row.has_password,
    profile_count: row.profile_count || 0,
  };
}

function forbidden(message) {
  return json({ error: message }, { status: 403 });
}

/** Deliberately minimal: one @, no whitespace, a dot in the domain, and inside
 *  the RFC's 254-octet limit. Anything stricter rejects addresses that really do
 *  deliver (plus-tags, single-letter locals, new TLDs), and the only thing this
 *  check has to buy is that an obvious typo does not become an account nobody
 *  can log into. Deliverability is proved by the person signing in, not by a
 *  regex. */
function normaliseEmail(raw) {
  const email = typeof raw === "string" ? raw.trim() : "";
  if (!email) return { error: "email is required" };
  if (email.length > 254) return { error: "email is too long" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: `not a valid email address: ${email}` };
  // Stored as typed. The UNIQUE INDEX is on lower(email), so case cannot split
  // one person into two accounts, and lower-casing on the way in would only
  // throw away how they capitalise their own name.
  return { email };
}

/** true/false and 1/0 both, because a JSON client and an HTML form disagree
 *  about which one they send. Anything else is a mistake worth naming rather
 *  than coercing — `is_admin: "no"` is truthy and would silently make an admin. */
function coerceFlag(raw, field) {
  if (raw === true || raw === 1) return { value: 1 };
  if (raw === false || raw === 0) return { value: 0 };
  return { error: `${field} must be true or false` };
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!context.data.user?.is_admin) return forbidden("only an admin may list users");

  const { results } = await env.DB.prepare(`
    SELECT ${USER_COLUMNS}
      FROM users u
     ORDER BY u.id ASC
  `).all();
  return json((results || []).map(rowToUser));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!context.data.user?.is_admin) return forbidden("only an admin may create users");

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected a JSON object");
  }

  const parsed = normaliseEmail(body.email);
  if (parsed.error) return badRequest(parsed.error);
  const email = parsed.email;

  const name = typeof body.name === "string" ? body.name.trim() : "";

  let isAdmin = 0;
  if (body.is_admin !== undefined) {
    const flag = coerceFlag(body.is_admin, "is_admin");
    if (flag.error) return badRequest(flag.error);
    isAdmin = flag.value;
  }

  // An omitted password is a supported way to create a user, not an oversight:
  // it is how an admin adds someone before deciding how to hand them a secret.
  // '' is 010's "no password set" sentinel and verifyPassword can never match
  // it, so the account exists and owns nothing until password.js sets one.
  let pwHash = "";
  if (body.password !== undefined && body.password !== null && body.password !== "") {
    const password = String(body.password);
    if (!password.trim()) return badRequest("password cannot be blank");
    if (password.length < MIN_PASSPHRASE_LENGTH) {
      return badRequest(`password must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    }
    pwHash = await hashPassword(password);
  }

  // Checked before the INSERT so the common collision answers with the address
  // that clashed rather than with a driver error, and checked again by catching
  // the constraint below because two admins creating the same person at once
  // would both pass this read. The index is on lower(email), so this comparison
  // has to be too — otherwise "Sam@x.com" would pass the check and then blow up
  // as a 500 on an index this handler was supposed to be speaking for.
  const clash = await env.DB
    .prepare("SELECT id FROM users WHERE lower(email) = lower(?1)")
    .bind(email)
    .first();
  if (clash) {
    return json(
      { error: `a user with the email ${email} already exists (id ${clash.id}); addresses are matched case-insensitively`, id: clash.id },
      { status: 409 }
    );
  }

  const now = Date.now();
  let created;
  try {
    created = await env.DB.prepare(`
      INSERT INTO users (email, name, pw_hash, is_admin, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      RETURNING id
    `).bind(email, name, pwHash, isAdmin, now).first();
  } catch (err) {
    // The race the pre-check cannot close. Same 409, same sentence — a caller
    // must not have to tell the two apart.
    if (/UNIQUE constraint/i.test(String(err?.message || err))) {
      return json(
        { error: `a user with the email ${email} already exists; addresses are matched case-insensitively` },
        { status: 409 }
      );
    }
    throw err;
  }

  const row = await env.DB.prepare(`
    SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?1
  `).bind(created.id).first();

  const out = rowToUser(row);
  // Said in the response rather than left for the admin to infer from
  // has_password: a created user who silently cannot sign in is the kind of
  // thing that gets discovered a week later by the person locked out.
  if (!out.has_password) {
    out.message = "no password set — this user cannot sign in until one is set via POST /api/user/password";
  }
  return json(out, { status: 201 });
}
