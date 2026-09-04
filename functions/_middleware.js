import { signSession, verifySession, parseCookie } from "./lib/auth.js";

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
  input{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--ink);
    border-radius:9px;padding:11px 12px;font:inherit;font-size:15px;min-height:44px}
  button{width:100%;margin-top:12px;background:var(--accent);border:none;color:#fff;
    border-radius:9px;padding:11px;font:inherit;font-weight:600;font-size:15px;min-height:44px;cursor:pointer}
  .err{color:#c0392b;font-size:13px;margin:10px 0 0}
</style>
</head>
<body>
<form method="POST" action="/api/login">
  <h1>Pilot</h1>
  <p>Enter your passphrase to continue.</p>
  <input type="password" name="password" placeholder="Passphrase" autofocus required>
  <button type="submit">Sign in</button>
  ${error ? `<p class="err">${error}</p>` : ""}
</form>
</body>
</html>`;

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (url.pathname === "/api/login") {
    return handleLogin(request, env);
  }

  const secret = env.SESSION_SECRET;
  const token = parseCookie(request.headers.get("Cookie"), "session");
  const valid = await verifySession(secret, token);

  if (!valid) {
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

  return next();
}

async function handleLogin(request, env) {
  if (request.method !== "POST") {
    return new Response(LOGIN_PAGE(null), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  let password = "";
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    password = body.password || "";
  } else {
    const form = await request.formData();
    password = form.get("password") || "";
  }

  if (!env.SITE_PASSWORD || password !== env.SITE_PASSWORD) {
    return new Response(LOGIN_PAGE("Wrong passphrase."), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const token = await signSession(env.SESSION_SECRET, 30);
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`,
    },
  });
}
