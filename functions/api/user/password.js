/** POST /api/user/password  — change a password.
 *
 *  Two callers, one route:
 *    { current_password, new_password }          — the signed-in user's own.
 *    { user_id, new_password }                   — an admin resetting someone
 *                                                  else's. Admin only.
 *
 *  WHY `current_password` IS REQUIRED FOR YOUR OWN
 *  The session cookie proves the browser is signed in, not that the person at
 *  the keyboard is the account holder. An unattended laptop or a stolen token
 *  would otherwise be enough to take the account over. The current password is
 *  the one thing an attacker holding a session does not have, so it is what
 *  re-authenticates the change.
 *
 *  EVERY CHANGE HERE SIGNS THE TARGET OUT EVERYWHERE
 *  A password change that left old cookies working would be worth very little:
 *  the admin reset below is the "this account is compromised, cut it off"
 *  button, and an attacker whose stolen session survived it would still be
 *  inside. So both paths bump `users.session_epoch`, which _middleware.js
 *  compares against the `ep` in every presented token and 401s when the token
 *  is behind. That is the entire revocation mechanism for sessions that are
 *  otherwise stateless HMACs with no server-side record.
 *
 *  THE ONE EXCEPTION — THE BOOTSTRAP
 *  Migration 010 seeds the parent user with `pw_hash = ''`, meaning "no password
 *  set yet", and the login handler falls back to SITE_PASSWORD for exactly that
 *  case. There is no current password to prove, so demanding one would leave the
 *  seeded owner permanently unable to leave the shared-password world — the
 *  upgrade would have no exit. `hasNoPassword` gates it, and it stops being true
 *  the moment this handler writes a real hash, so the door closes behind the
 *  first use on its own rather than by a flag someone has to remember to clear.
 *  The caller is still an authenticated session that got in via SITE_PASSWORD,
 *  so this is not an unauthenticated write.
 *
 *  WHY AN ADMIN RESETTING THEMSELVES IS NOT A SHORTCUT
 *  `user_id` pointing at the caller is routed down the self path, current
 *  password and all. Otherwise every admin session would carry a way to rewrite
 *  its own credential without knowing it, which is the exact capability the
 *  first paragraph exists to deny.
 *
 *  ROUTING
 *  This file sits beside `[id].js`; Pages Functions matches the static segment
 *  before the dynamic one, so /api/user/password lands here and never in the
 *  `:id` handler. Even if it did not, `[id].js` exports no POST, so the failure
 *  would be a 405 rather than something silently wrong.
 *
 *  Nothing here reads or returns `pw_hash` beyond what verifyPassword needs, and
 *  no response ever echoes a password back.
 */
import { json, badRequest, notFound } from "../../lib/db.js";
import { hashPassword, verifyPassword, hasNoPassword } from "../../lib/password.js";

/** Matches ../users.js — see the note there on why the constant is stated in
 *  both files, and on why twelve. */
const MIN_PASSPHRASE_LENGTH = 12;

function forbidden(message) {
  return json({ error: message }, { status: 403 });
}

function parseUserId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const callerId = context.data.userId;
  const isAdmin = !!context.data.user?.is_admin;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected a JSON object");
  }

  // Validated before anything is looked up or verified, so a caller cannot use
  // the difference between "wrong current password" and "new one too short" to
  // learn anything, and so an admin reset cannot half-happen.
  if (typeof body.new_password !== "string") return badRequest("new_password (string) is required");
  const newPassword = body.new_password;
  if (!newPassword.trim()) return badRequest("new_password cannot be blank");
  if (newPassword.length < MIN_PASSPHRASE_LENGTH) {
    return badRequest(`new_password must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }

  let targetId = callerId;
  if (body.user_id !== undefined && body.user_id !== null) {
    const parsed = parseUserId(body.user_id);
    if (!parsed) return badRequest("user_id must be a positive integer");
    targetId = parsed;
  }
  const isSelf = targetId === callerId;

  if (!isSelf && !isAdmin) {
    return forbidden("only an admin may reset another user's password");
  }

  const target = await env.DB
    .prepare("SELECT id, pw_hash FROM users WHERE id = ?1")
    .bind(targetId)
    .first();
  if (!target) return notFound("user not found");

  // `bootstrap` is reported in the response because it is the difference
  // between "you changed your password" and "this account had none until now",
  // and the seeded owner has no other way to be told the SITE_PASSWORD fallback
  // has just stopped applying to them.
  const bootstrap = isSelf && hasNoPassword(target.pw_hash);

  if (isSelf && !bootstrap) {
    if (typeof body.current_password !== "string" || !body.current_password) {
      return badRequest("current_password is required to change your own password");
    }
    const ok = await verifyPassword(body.current_password, target.pw_hash);
    // 403, not 400: the request was well formed and the caller is simply not
    // permitted to make this change. The message says nothing about the stored
    // hash beyond the fact that this attempt did not match it.
    if (!ok) return forbidden("current_password is incorrect");
  }

  const pwHash = await hashPassword(newPassword);
  // One statement, not two: a new hash that is live while the old sessions are
  // still valid is exactly the window this is meant to close, and there is no
  // transaction wrapping these handlers to make a two-step version safe.
  //
  // `session_epoch + 1` is computed by SQLite rather than read into JS and
  // written back, so two changes racing on the same user cannot both read N and
  // both write N+1 — leaving a token minted at N+1 still valid after what the
  // second caller believed was a revocation.
  await env.DB
    .prepare("UPDATE users SET pw_hash = ?1, session_epoch = session_epoch + 1 WHERE id = ?2")
    .bind(pwHash, targetId)
    .run();

  return json({
    ok: true,
    user_id: targetId,
    bootstrap,
    // In the response body because a browser client has to act on it, not just
    // know it: on the self path the cookie that made this very request is now
    // one epoch behind, so the next call to any /api/* route answers 401. A
    // dashboard that does not redirect to the login page here looks broken
    // rather than secure.
    signed_out_everywhere: true,
    note: isSelf
      ? "every session for this account is now invalid, including the one that made this request — re-authenticate before the next API call"
      : `every existing session for user ${targetId} is now invalid; they must sign in again with the new password`,
  });
}
