/** Auth gate for the whole site — static assets included.
 *
 *  Runs before everything. A request either carries a valid session cookie and
 *  falls through to `next()`, or it gets the login page (HTML routes) or a 401
 *  (API routes).
 *
 *  WHAT CHANGED WITH MULTI-TENANCY
 *  There used to be one `SITE_PASSWORD` and no notion of a user: the session
 *  payload was `{exp}`, so once you were in, `?profile_id=N` reached any profile
 *  in the database. Login is now per-user against the `users` table added in
 *  migration 010, the session carries `uid`, and this middleware publishes it on
 *  `context.data` so downstream handlers can authorise rather than just
 *  authenticate. `resolveProfileId` is what consumes it.
 *
 *  THE SITE_PASSWORD BOOTSTRAP
 *  Migration 010 seeds the parent user with an empty `pw_hash`, meaning "no
 *  password set yet". For that user only, and only while the hash is empty,
 *  `SITE_PASSWORD` is still accepted. Without it, applying 010 to the live
 *  database would lock the owner out of their own app with no way back in —
 *  there is no shell on Pages to run a password reset from. The fallback closes
 *  itself the moment a real password is set, because a non-empty hash takes the
 *  branch above it. Nothing else in the app reads SITE_PASSWORD any more.
 *
 *  SESSION REVOCATION
 *  Tokens are stateless, so there is no session table to delete a row from. Each
 *  one carries the user's `session_epoch` from migration 010, and the API branch
 *  below refuses a token whose epoch is behind the row's. Bumping that column is
 *  therefore a per-user "sign out everywhere" — which is what makes a password
 *  change able to revoke the sessions it was prompted by.
 *
 *  NOT SOLVED HERE: there is still no rate limiting on login. It belongs in a
 *  Cloudflare rate-limiting rule on /api/login rather than in a D1 write per
 *  attempt, which would put a write on the unauthenticated path — exactly what
 *  an attacker would want to amplify.
 */
import { signSession, verifySession, parseCookie } from "./lib/auth.js";
import { verifyPassword, hasNoPassword, needsRehash, hashPassword } from "./lib/password.js";

const LOGIN_PAGE = (error) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in — Pilot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{ --bg:#f7f6f3; --card:#fff; --ink:#16181d; --mute:#5d636e; --line:#e2e0da; --accent:#1d6b3f; }
  @media (prefers-color-scheme:dark){ :root{ --bg:#14161a; --card:#1c1f25; --ink:#e9eaec; --mute:#9aa1ac; --line:#2c313a; --accent:#5fbd88; } }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:var(--bg);color:var(--ink);
    font:15px/1.5 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    -moz-osx-font-smoothing:grayscale;-webkit-font-smoothing:antialiased}
  form{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;width:100%;max-width:320px}
  h1{font-size:18px;margin:0 0 4px}
  p{margin:0 0 18px;color:var(--mute);font-size:13px}
  label{display:block;font-size:13px;color:var(--mute);margin:0 0 5px}
  input{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--ink);
    border-radius:9px;padding:11px 12px;font:inherit;font-size:15px;min-height:44px}
  input + label{margin-top:12px}
  button{width:100%;margin-top:14px;background:var(--accent);border:none;color:#fff;
    border-radius:9px;padding:11px;font:inherit;font-weight:600;font-size:15px;min-height:44px;cursor:pointer}
  .err{color:#c0392b;font-size:13px;margin:10px 0 0}
</style>
</head>
<body>
<form method="POST" action="/api/login">
  <h1>Pilot</h1>
  <p>Sign in to continue.</p>
  <label for="email">Email</label>
  <input id="email" type="email" name="email" autocomplete="username" autofocus required>
  <label for="password">Passphrase</label>
  <input id="password" type="password" name="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
  ${error ? `<p class="err">${error}</p>` : ""}
</form>
</body>
</html>`;

export async function onRequest(context) {
  const { request, env, next, data } = context;
  const url = new URL(request.url);

  if (url.pathname === "/api/login") {
    return handleLogin(request, env);
  }

  const session = await verifySession(env.SESSION_SECRET, parseCookie(request.headers.get("Cookie"), "session"));

  if (!session) {
    if (url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(LOGIN_PAGE(null), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Published for every route so a handler never has to re-parse the cookie.
  data.userId = session.uid;

  // The full row is fetched only for API routes. Static assets pass through this
  // middleware too, and a D1 lookup per image and stylesheet would be a query
  // per asset to answer a question no asset asks. The lookup doubles as a
  // liveness check on the account: a user deleted after their token was minted
  // fails here, so their session stops working on the first API call it makes.
  if (url.pathname.startsWith("/api/")) {
    const user = await env.DB
      .prepare("SELECT id, email, name, is_admin, session_epoch FROM users WHERE id = ?1")
      .bind(session.uid)
      .first();
    // A token minted before the user's epoch was bumped is dead: that is how a
    // password change signs out the sessions it was changed because of. Checked
    // here rather than in verifySession because only this side has the row.
    if (!user || Number(session.ep || 0) < Number(user.session_epoch || 0)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    data.user = { id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin };
  }

  return next();
}

async function handleLogin(request, env) {
  if (request.method !== "POST") {
    return new Response(LOGIN_PAGE(null), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  let email = "";
  let password = "";
  const contentType = request.headers.get("content-type") || "";
  const wantsJson = contentType.includes("application/json");
  if (wantsJson) {
    const body = await request.json().catch(() => ({}));
    email = String(body.email || "");
    password = String(body.password || "");
  } else {
    const form = await request.formData();
    email = String(form.get("email") || "");
    password = String(form.get("password") || "");
  }

  const reject = (message) =>
    wantsJson
      ? new Response(JSON.stringify({ error: message }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      : new Response(LOGIN_PAGE(message), {
          status: 401,
          headers: { "content-type": "text/html; charset=utf-8" },
        });

  // One message for "no such user" and for "wrong passphrase", deliberately.
  // Distinguishing them turns this form into an account-existence oracle, and
  // the honest error is no more actionable to the person who typed it.
  const WRONG = "Wrong email or passphrase.";

  if (!email.trim() || !password) return reject(WRONG);

  // lower(email) is what the UNIQUE INDEX in migration 010 is built on, so this
  // lookup and that constraint agree on what counts as the same address.
  const user = await env.DB
    .prepare("SELECT id, pw_hash, session_epoch FROM users WHERE lower(email) = lower(?1)")
    .bind(email.trim())
    .first();
  if (!user) return reject(WRONG);

  let ok = false;
  let bootstrapped = false;

  if (hasNoPassword(user.pw_hash)) {
    // See the header: the seeded owner has no hash yet, so SITE_PASSWORD is the
    // only way in until they set one. Guarded on the env var actually being
    // configured — an unset SITE_PASSWORD must not make an empty password valid.
    ok = Boolean(env.SITE_PASSWORD) && password === env.SITE_PASSWORD;
    bootstrapped = ok;
  } else {
    ok = await verifyPassword(password, user.pw_hash);
  }

  if (!ok) return reject(WRONG);

  const now = Date.now();
  const writes = [
    env.DB.prepare("UPDATE users SET last_login_at = ?1 WHERE id = ?2").bind(now, user.id),
  ];

  // Transparently upgrade a hash written at a lower iteration count. This is the
  // only moment the plaintext is available to re-derive from, so it is the only
  // place the upgrade can happen.
  if (!bootstrapped && needsRehash(user.pw_hash)) {
    writes.push(
      env.DB.prepare("UPDATE users SET pw_hash = ?1 WHERE id = ?2").bind(await hashPassword(password), user.id)
    );
  }
  await env.DB.batch(writes);

  const token = await signSession(env.SESSION_SECRET, user.id, user.session_epoch || 0, 30);
  const cookie = `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`;

  if (wantsJson) {
    // push.py and the browser extension log in over JSON and read the cookie off
    // the response, so they need a body rather than a redirect they would follow
    // into the dashboard HTML.
    return new Response(JSON.stringify({ ok: true, user_id: user.id, must_set_password: bootstrapped }), {
      status: 200,
      headers: { "content-type": "application/json", "Set-Cookie": cookie },
    });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": cookie },
  });
}
