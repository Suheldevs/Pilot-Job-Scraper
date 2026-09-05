/** GET    /api/user/:id  — one user. Self or admin.
 *  PATCH  /api/user/:id  — name/email (self or admin); is_admin (admin only).
 *  DELETE /api/user/:id  — admin only; refused for the last admin and for a
 *                          user who still owns profiles.
 *
 *  _middleware.js authenticates the whole /api/* tree, so what is decided here
 *  is only who may act on WHICH user. Two different rules, deliberately:
 *  reading and editing your own record is self-service, but the tenant
 *  directory as a whole (and anything that mints or revokes access) is an
 *  admin's. Hence GET/PATCH allow self-or-admin while DELETE does not — a user
 *  deleting themselves is indistinguishable at the API from a hijacked session
 *  destroying an account, and the profiles-still-owned refusal below is the
 *  thing that makes that recoverable.
 *
 *  The refusals mirror functions/api/profile/[id].js: a 409 carrying a sentence
 *  the person can act on and the number that caused it, never a 500 from a
 *  constraint further down. Same reason as there — "cannot delete" is a fact
 *  about the data, and the caller is the one who can change the data.
 *
 *  Existence is distinguished from permission (404 vs 403) exactly as
 *  profile/[id].js does it: user ids are sequential and already guessable, so
 *  hiding existence buys nothing while making a mistyped id impossible to tell
 *  from a real permissions bug.
 *
 *  `pw_hash` is never selected. See the note in ../users.js on why the column
 *  list is written out instead of SELECT *.
 */
import { json, badRequest, notFound } from "../../lib/db.js";

const USER_COLUMNS = `
  u.id, u.email, u.name, u.is_admin, u.created_at, u.last_login_at,
  (u.pw_hash <> '') AS has_password,
  (SELECT COUNT(*) FROM profiles p WHERE p.owner_user_id = u.id) AS profile_count
`;

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

/** Local rather than lib/profile.js's identical `parseId`: that module is the
 *  profile domain (rowToProfile, similarity, resolveProfileId), and a user
 *  route should not import it to borrow four lines of arithmetic. */
function parseUserId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Same rules and the same reasoning as ../users.js. */
function normaliseEmail(raw) {
  const email = typeof raw === "string" ? raw.trim() : "";
  if (!email) return { error: "email cannot be empty" };
  if (email.length > 254) return { error: "email is too long" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: `not a valid email address: ${email}` };
  return { email };
}

function coerceFlag(raw, field) {
  if (raw === true || raw === 1) return { value: 1 };
  if (raw === false || raw === 0) return { value: 0 };
  return { error: `${field} must be true or false` };
}

async function countAdmins(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").first();
  return row?.n || 0;
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const id = parseUserId(params.id);
  if (!id) return badRequest("invalid user id");

  const caller = context.data.user;
  if (id !== context.data.userId && !caller?.is_admin) {
    return forbidden("you may only read your own user record");
  }

  const row = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?1`)
    .bind(id)
    .first();
  if (!row) return notFound("user not found");
  return json(rowToUser(row));
}

export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const id = parseUserId(params.id);
  if (!id) return badRequest("invalid user id");

  const caller = context.data.user;
  const isAdmin = !!caller?.is_admin;
  const isSelf = id === context.data.userId;
  if (!isSelf && !isAdmin) return forbidden("you may only edit your own user record");

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected a JSON object");
  }

  const existing = await env.DB
    .prepare("SELECT id, email, is_admin FROM users WHERE id = ?1")
    .bind(id)
    .first();
  if (!existing) return notFound("user not found");

  const updates = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string") return badRequest("name must be a string");
    // Empty is allowed, unlike a profile's name: `users.name` is NOT NULL
    // DEFAULT '' and a user created without one is a normal state, so clearing
    // it back to that is not a broken row.
    updates.name = body.name.trim();
  }

  if (body.email !== undefined) {
    const parsed = normaliseEmail(body.email);
    if (parsed.error) return badRequest(parsed.error);
    updates.email = parsed.email;
  }

  // Escalation is the whole risk on this route: the flag that decides who may
  // list the directory must not be settable by someone who is not already in
  // it. Presence in the body is refused rather than ignored even when it would
  // be a no-op, so a client never gets a 200 for a privilege change that did
  // not happen.
  if (body.is_admin !== undefined) {
    if (!isAdmin) return forbidden("only an admin may change is_admin");
    const flag = coerceFlag(body.is_admin, "is_admin");
    if (flag.error) return badRequest(flag.error);
    updates.is_admin = flag.value;
  }

  if (!Object.keys(updates).length) return badRequest("no user fields to update");

  // A deployment with zero admins cannot create a user, promote anyone, or
  // delete anything, and nothing in the API can undo it — the only way back is
  // a hand-written UPDATE against D1. So the last admin flag is not removable,
  // by its holder or by another admin. Checked against the live count rather
  // than "is this me", because demoting the other of two admins ends up in the
  // same unrecoverable place.
  if (updates.is_admin === 0 && existing.is_admin) {
    if ((await countAdmins(env)) <= 1) {
      return json(
        {
          error: `cannot remove admin from user ${id} — it is the only admin left. Make another user an admin first, then remove it here.`,
          admin_count: 1,
        },
        { status: 409 }
      );
    }
  }

  // Pre-checked against lower(email) because that is what the unique index is
  // on, so a case-only duplicate is a 409 here rather than a 500 from the
  // UPDATE. `id != ?2` so re-saving your own address unchanged is not a clash.
  if (updates.email) {
    const clash = await env.DB
      .prepare("SELECT id FROM users WHERE lower(email) = lower(?1) AND id != ?2")
      .bind(updates.email, id)
      .first();
    if (clash) {
      return json(
        { error: `a user with the email ${updates.email} already exists (id ${clash.id}); addresses are matched case-insensitively`, id: clash.id },
        { status: 409 }
      );
    }
  }

  const cols = Object.keys(updates);
  const assignments = cols.map((c, i) => `${c} = ?${i + 1}`);
  const binds = cols.map((c) => updates[c]);

  try {
    await env.DB
      .prepare(`UPDATE users SET ${assignments.join(", ")} WHERE id = ?${binds.length + 1}`)
      .bind(...binds, id)
      .run();
  } catch (err) {
    // The race the pre-check above cannot close: two edits claiming the same
    // address at once. Same 409, same sentence.
    if (/UNIQUE constraint/i.test(String(err?.message || err))) {
      return json(
        { error: `a user with the email ${updates.email} already exists; addresses are matched case-insensitively` },
        { status: 409 }
      );
    }
    throw err;
  }

  const row = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?1`)
    .bind(id)
    .first();
  const out = rowToUser(row);
  out.changed_fields = cols;
  return json(out);
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const id = parseUserId(params.id);
  if (!id) return badRequest("invalid user id");

  if (!context.data.user?.is_admin) return forbidden("only an admin may delete users");

  const existing = await env.DB
    .prepare("SELECT id, email, is_admin FROM users WHERE id = ?1")
    .bind(id)
    .first();
  if (!existing) return notFound("user not found");

  // Same unrecoverable state as the PATCH guard, reached by a different door.
  if (existing.is_admin && (await countAdmins(env)) <= 1) {
    return json(
      {
        error: `cannot delete user ${id} — it is the only admin left. Make another user an admin first, then delete it here.`,
        admin_count: 1,
      },
      { status: 409 }
    );
  }

  // The `profiles` refusal, mirroring how profile/[id].js refuses to delete a
  // profile that still owns leads, and for the stronger version of the same
  // reason: 010 added no foreign key from `profiles.owner_user_id` to `users`,
  // so nothing would clean these up. They would sit there owned by a dead id
  // until AUTOINCREMENT handed that id to a new user, who would inherit a
  // stranger's profiles — and with them their leads, notes and stage history.
  // Cascading instead of refusing is not an option worth having: it would make
  // one click delete an unbounded amount of somebody's work.
  const owned = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM profiles WHERE owner_user_id = ?1")
    .bind(id)
    .first();
  if ((owned?.n || 0) > 0) {
    return json(
      {
        error: `cannot delete user ${id} — it still owns ${owned.n} profile(s). Reassign or delete them first.`,
        owned_profiles: owned.n,
      },
      { status: 409 }
    );
  }

  await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(id).run();
  return json({ ok: true, deleted: id });
}
