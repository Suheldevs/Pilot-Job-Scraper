/**
 * One-command deploy for Pilot.
 *
 *   node deploy.mjs              build, check, deploy, verify
 *   node deploy.mjs --dry-run    everything except the deploy
 *   node deploy.mjs --migrate    also apply migrations/*.sql to the remote D1
 *
 * It deploys from a clean staging copy, never the project folder directly.
 * That is deliberate: a straight `pages deploy .` once uploaded 1,558 files
 * because it swept up venv/, and it would have published .cf-credentials and
 * .dev.vars as fetchable assets. Only the web assets and functions/ ship.
 *
 * The run aborts before uploading if a secret is found in the bundle or any
 * JS file fails to parse.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath handles the Windows drive letter and percent-decoding — this
// project lives under a path with a space in it, so a hand-rolled conversion
// leaves "%20" behind and every fs call misses.
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* Two deployment targets.
 *
 * `main` is the working system — 292 leads, the one being used day to day.
 * `clone` is the profile-system build: its own Pages project AND its own D1,
 * seeded from a copy of main's data, so the profile work cannot touch the
 * system that already works. Deploying one never affects the other.
 */
const TARGETS = {
  main: {
    project: "pilot",
    site: "https://pilot-78c.pages.dev",
    db: { name: "job-outreach", id: "e655ed5e-a357-44f2-aeb3-0441d996374b" },
    secrets: ".secrets-generated.txt",
  },
  clone: {
    project: "pilot-78d",
    site: "https://pilot-78d.pages.dev",
    db: { name: "pilot-profiles", id: "2423856f-9708-4a79-9ecb-c875be4626e3" },
    secrets: ".secrets-78d.txt",
  },
};

const targetArg = (process.argv.find((a) => a.startsWith("--target=")) || "").split("=")[1];
const TARGET_NAME = targetArg || "main";
const TARGET = TARGETS[TARGET_NAME];
if (!TARGET) {
  console.error(`
unknown --target=${TARGET_NAME}. Use one of: ${Object.keys(TARGETS).join(", ")}
`);
  process.exit(1);
}
const PROJECT = TARGET.project;
const SITE = TARGET.site;

// Only these ship. Everything else in the project is tooling or secrets.
const ASSETS = ["index.html", "sample-import.csv", "IMPORT-FORMAT.md", "README.md", "DOCS.md"];
const DIRS = ["functions"];

const WRANGLER = `
name = "${PROJECT}"
pages_build_output_dir = "."
compatibility_date = "2026-01-01"

[[d1_databases]]
binding = "DB"
database_name = "${TARGET.db.name}"
database_id = "${TARGET.db.id}"
`.trimStart();

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const MIGRATE = args.includes("--migrate");

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m", b: "\x1b[1m" };
const ok = (m) => console.log(`${C.g}  ok${C.x}  ${m}`);
const warn = (m) => console.log(`${C.y}warn${C.x}  ${m}`);
const step = (m) => console.log(`\n${C.b}${m}${C.x}`);
function die(m) {
  console.error(`\n${C.r}ABORTED${C.x}  ${m}\n`);
  process.exit(1);
}

/* ---------------------------------------------------------- credentials -- */
step(`1. Credentials  ${C.d}[target: ${TARGET_NAME} -> ${PROJECT}, db ${TARGET.db.name}]${C.x}`);
const credPath = path.join(ROOT, ".cf-credentials");
if (!fs.existsSync(credPath)) {
  die(`.cf-credentials not found in ${ROOT}\n` +
      `        It must define CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.`);
}
const env = { ...process.env };
for (const line of fs.readFileSync(credPath, "utf8").split(/\r?\n/)) {
  const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (!env[key]) die(`${key} missing from .cf-credentials`);
}
// Collect the secret VALUES so we can prove none of them ship.
const SECRET_VALUES = [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID];
const genPath = path.join(ROOT, TARGET.secrets);
// Keys in the secrets file whose value is NOT a credential, so they must not
// join SECRET_VALUES. SITE_EMAIL is one: it is the address the owner signs in
// with, migration 010 seeds it from profile 1's `email` column, and index.html
// and README already publish it. Screening the bundle for it would abort every
// deploy on a string the site is meant to carry, and a scanner that cries wolf
// on a non-secret is one people learn to route around. The passphrase it is
// paired with is still screened for, unchanged.
const NON_SECRET_KEYS = new Set(["SITE_EMAIL"]);
if (fs.existsSync(genPath)) {
  for (const line of fs.readFileSync(genPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.+)$/.exec(line.trim());
    if (m && m[2].length > 6 && !NON_SECRET_KEYS.has(m[1])) SECRET_VALUES.push(m[2]);
  }
}
ok(`token + account id loaded (${SECRET_VALUES.length} secret values will be screened for)`);

/* ------------------------------------------------------------- preflight -- */
step("2. Preflight");
for (const f of ASSETS) {
  if (!fs.existsSync(path.join(ROOT, f))) die(`missing asset: ${f}`);
}
for (const d of DIRS) {
  if (!fs.existsSync(path.join(ROOT, d))) die(`missing directory: ${d}`);
}
ok(`${ASSETS.length} assets + ${DIRS.join(", ")} present`);

// Parse-check every function file. A syntax error here becomes a broken
// Worker for the whole site, so it must never reach upload.
const jsFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) jsFiles.push(p);
  }
})(path.join(ROOT, "functions"));

for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) die(`${path.relative(ROOT, f)} failed to parse:\n${r.stderr}`);
}
ok(`${jsFiles.length} function files parse cleanly`);

// The dashboard's inline script is the other thing that can break silently.
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const inline = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!inline) die("index.html has no inline <script> — that can't be right");
const tmpJs = path.join(os.tmpdir(), `pilot-inline-${process.pid}.js`);
fs.writeFileSync(tmpJs, inline[1]);
const chk = spawnSync(process.execPath, ["--check", tmpJs], { encoding: "utf8" });
fs.rmSync(tmpJs, { force: true });
if (chk.status !== 0) die(`index.html inline script failed to parse:\n${chk.stderr}`);
ok("index.html inline script parses cleanly");

/* --------------------------------------------------------------- staging -- */
step("3. Staging a clean bundle");
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-deploy-"));
for (const f of ASSETS) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
for (const d of DIRS) fs.cpSync(path.join(ROOT, d), path.join(stage, d), { recursive: true });
fs.writeFileSync(path.join(stage, "wrangler.toml"), WRANGLER);
fs.writeFileSync(path.join(stage, ".assetsignore"), "wrangler.toml\n.assetsignore\n");

const staged = [];
(function walk(dir, rel = "") {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, path.join(rel, e.name));
    else staged.push(path.join(rel, e.name));
  }
})(stage);
ok(`${staged.length} files staged (project folder is untouched)`);
console.log(C.d + staged.map((f) => "        " + f).join("\n") + C.x);

/* ----------------------------------------------------------- secret scan -- */
step("4. Secret scan");
// Two independent screens.
//
// The exact-value check below is the one that actually protects us: it matches
// the live secrets byte-for-byte, so it cannot false-positive.
//
// These shape patterns are the backstop for a credential added to the project
// later that we don't yet know the value of. They deliberately require a
// credential-SHAPED value rather than "anything after the =", because the
// README documents these variable names and `CLOUDFLARE_API_TOKEN=...` in a
// setup snippet is not a leak. PLACEHOLDER filters those out.
const PLACEHOLDER = /^(\.{2,}|<[^>]*>|x{3,}|whatever|your[-_ ]|paste|token|secret|abc123|changeme|\$\{)/i;
const SHAPES = [
  ["a Cloudflare API token", /cfut_[A-Za-z0-9]{20,}/, null],
  ["a Firecrawl API key", /fc-[a-f0-9]{24,}/, null],
  ["a Google/Gemini API key", /AQ\.[A-Za-z0-9_-]{30,}/, null],
  ["a Google API key", /AIza[A-Za-z0-9_-]{30,}/, null],
  ["CLOUDFLARE_API_TOKEN", /CLOUDFLARE_API_TOKEN\s*=\s*(\S+)/, 1],
  ["SESSION_SECRET", /SESSION_SECRET\s*=\s*(\S+)/, 1],
  ["JO_PASSWORD", /JO_PASSWORD\s*=\s*(\S+)/, 1],
  ["SITE_PASSWORD", /SITE_PASSWORD\s*=\s*(\S+)/, 1],
  ["FIRECRAWL_API_KEY", /FIRECRAWL_API_KEY\s*=\s*(\S+)/, 1],
  ["GEMINI_API_KEY", /GEMINI_API_KEY\s*=\s*(\S+)/, 1],
];

/** True when a captured value looks like a real credential, not a doc stub. */
function looksReal(value) {
  if (!value) return false;
  if (PLACEHOLDER.test(value)) return false;
  // Real tokens/secrets here are long and dense; a passphrase is word-word-NNNN.
  return value.length >= 16 || /^[a-z]+-[a-z]+-\d{4}$/.test(value);
}
let found = 0;
for (const rel of staged) {
  const full = path.join(stage, rel);
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch {
    continue;
  }
  for (const [label, re, group] of SHAPES) {
    const m = re.exec(text);
    if (!m) continue;
    const value = group === null ? m[0] : m[group];
    if (!looksReal(value)) continue;   // documented placeholder, not a leak
    console.error(`${C.r}  !! ${rel}: looks like ${label}${C.x}`);
    found++;
  }
  for (const v of SECRET_VALUES) {
    if (v && v.length > 6 && text.includes(v)) {
      console.error(`${C.r}  !! ${rel}: contains a live secret value${C.x}`);
      found++;
    }
  }
}
if (found) {
  fs.rmSync(stage, { recursive: true, force: true });
  die(`${found} secret match(es) in the bundle. Nothing was uploaded.`);
}
ok("no secrets in the bundle");

/* ------------------------------------------------------------ migrations -- */
const migDir = path.join(ROOT, "migrations");
if (fs.existsSync(migDir)) {
  const migs = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  if (migs.length) {
    step("5. Migrations");
    if (MIGRATE) {
      // SQLite has no "ADD COLUMN IF NOT EXISTS", so re-running a migration
      // that already landed reports a duplicate column. That is the
      // already-applied signal, not a failure — anything else is fatal.
      // SQLite has no "ADD COLUMN IF NOT EXISTS", and a table-rebuild
      // migration can't use IF NOT EXISTS at all — 008 guards itself with a
      // CHECK that fails once it has run. All three of these mean
      // "already applied", not "broken".
      const APPLIED = /duplicate column name|already exists|already_migrated/i;
      let appliedCount = 0;
      let skippedCount = 0;
      for (const m of migs) {
        const r = spawnSync("npx", ["--yes", "wrangler@latest", "d1", "execute", TARGET.db.name,
          "--remote", "-y", `--file=migrations/${m}`],
          { cwd: ROOT, env, encoding: "utf8", shell: true });
        const out = `${r.stdout || ""}${r.stderr || ""}`;
        if (r.status === 0) {
          console.log(`${C.d}        applied ${m}${C.x}`);
          appliedCount++;
        } else if (APPLIED.test(out)) {
          console.log(`${C.d}        ${m} already applied${C.x}`);
          skippedCount++;
        } else {
          die(`migration ${m} failed:\n${out}`);
        }
      }
      ok(`migrations: ${appliedCount} applied, ${skippedCount} already present`);
    } else {
      warn(`${migs.length} migration file(s) exist and were NOT applied: ${migs.join(", ")}`);
      console.log(`${C.d}        They are additive and safe to re-run. Use --migrate to apply.${C.x}`);
    }
  }
}

/* ---------------------------------------------------------------- deploy -- */
if (DRY) {
  step("Dry run — stopping before upload");
  console.log(`${C.d}        staged at ${stage}${C.x}`);
  process.exit(0);
}

step("6. Deploy");
const dep = spawnSync("npx", ["--yes", "wrangler@latest", "pages", "deploy", ".",
  "--project-name", PROJECT, "--branch", "main", "--commit-dirty=true"],
  { cwd: stage, env, encoding: "utf8", shell: true });
console.log(C.d + (dep.stdout || "").trim().split("\n").map((l) => "        " + l).join("\n") + C.x);
if (dep.status !== 0) {
  console.error(dep.stderr);
  die("wrangler deploy failed — the live site is unchanged.");
}
const preview = /https:\/\/[a-z0-9]+\.pilot[-a-z0-9]*\.pages\.dev/.exec(dep.stdout || "");
ok(`uploaded${preview ? ` (preview: ${preview[0]})` : ""}`);
fs.rmSync(stage, { recursive: true, force: true });

/* ---------------------------------------------------------------- verify -- */
step("7. Verify live");
const pass = [];
const fail = [];
const check = (name, cond, detail = "") =>
  (cond ? pass : fail).push(name + (detail ? ` ${C.d}(${detail})${C.x}` : ""));

// Give the edge a moment to pick up the new Worker. A single fixed wait is not
// enough: the production alias can still be answering from the previous
// deployment seconds after wrangler reports success, and how long that takes
// varies per project — one target passed this check on the first try while the
// other reported a MISSING email field for a deployment that was in fact
// correct. A false failure here is worse than a slow one, because it sends you
// hunting a bug in code that already deployed fine, so poll instead.

// Read the passphrase by key, not by shape — it was matched with a
// word-word-NNNN pattern before, which silently skipped every authenticated
// check the moment the passphrase was changed to something else.
const secretsText = fs.existsSync(genPath) ? fs.readFileSync(genPath, "utf8") : "";
const readSecretKey = (key) => {
  const m = new RegExp(`^${key}=(.+)$`, "m").exec(secretsText);
  return m ? m[1].trim() : "";
};
const pw = readSecretKey("SITE_PASSWORD");
// Login is per-user since migration 010, so a passphrase on its own identifies
// nobody. JO_EMAIL is the fallback because a CI box keeps the address in its
// environment rather than in a file that is deliberately not committed.
const loginEmail = readSecretKey("SITE_EMAIL") || env.JO_EMAIL || "";
/** Fetch the root until it looks like the deployment we just uploaded, or the
 *  budget runs out. Returns the last response either way, so a genuine failure
 *  still reports the real body rather than a timeout. */
async function fetchRootWhenLive(totalMs = 45000, everyMs = 3000) {
  const deadline = Date.now() + totalMs;
  let last;
  for (;;) {
    last = await fetch(SITE + "/", { redirect: "manual" });
    const text = await last.text();
    if (last.status === 200 && /name="email"/.test(text)) return { r: last, body: text };
    if (Date.now() >= deadline) return { r: last, body: text };
    await new Promise((res) => setTimeout(res, everyMs));
  }
}

try {
  const { r: rootRes, body } = await fetchRootWhenLive();
  let r = rootRes;
  // "Sign in" is still the button label and the title on the login page in
  // functions/_middleware.js, so the original assertion stands. The email field
  // is asserted alongside it: the page grew one when login became per-user, and
  // a deployment still serving the passphrase-only form is one where the whole
  // ownership check downstream has nothing to identify the caller by.
  const hasEmailField = /name="email"/.test(body);
  check("unauth root serves the login page", r.status === 200 && body.includes("Sign in") && hasEmailField,
    `HTTP ${r.status}, email field ${hasEmailField ? "present" : "MISSING"}`);

  r = await fetch(SITE + "/api/companies");
  check("unauth API is refused", r.status === 401, `HTTP ${r.status}`);

  const missingCreds = [!loginEmail && "SITE_EMAIL (or a JO_EMAIL env var)", !pw && "SITE_PASSWORD"].filter(Boolean);
  if (missingCreds.length) {
    // Same posture as before: a deploy is not failed over a missing local
    // credential. The upload already succeeded and the unauthenticated checks
    // above still ran; only the signed-in half is skipped, and loudly.
    warn(`${missingCreds.join(" and ")} not found for ${TARGET_NAME} (${TARGET.secrets}) — skipping authenticated checks`);
  } else {
    r = await fetch(SITE + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: loginEmail, password: pw }),
      redirect: "manual",
    });
    // A JSON login answers 200 with a body since 010 — push.py and the
    // extension read the cookie off the response and cannot follow a redirect
    // into dashboard HTML. 302 is still tolerated so this does not report a
    // false failure against an edge that has not picked up the new Worker yet.
    const tok = (/session=([^;]+)/.exec(String(r.headers.get("set-cookie"))) || [])[1];
    check("login issues a session cookie", (r.status === 200 || r.status === 302) && Boolean(tok),
      `HTTP ${r.status}`);

    if (tok) {
      const H = { Cookie: "session=" + tok };
      r = await fetch(SITE + "/api/companies", { headers: H });
      const cos = await r.json();
      check("companies endpoint", r.status === 200 && Array.isArray(cos), `${cos.length} rows`);
      check("rows carry both tags", cos.length === 0 || ("platform" in cos[0] && "grade" in cos[0]));

      r = await fetch(SITE + "/api/analytics", { headers: H });
      const a = await r.json();
      check("analytics endpoint", r.status === 200 && a.totals, `${a.totals?.companies} companies`);

      r = await fetch(SITE + "/api/maintenance/prune?days=10", { headers: H });
      const p = await r.json();
      check("prune endpoint", r.status === 200, `${p.would_remove} evictable`);

      r = await fetch(SITE + "/sample-import.csv", { headers: H });
      check("sample CSV downloads", r.status === 200);

      // The thing that actually matters: secrets must not be fetchable.
      for (const p2 of ["/.cf-credentials", "/.dev.vars", "/wrangler.toml", "/push.py"]) {
        const x = await fetch(SITE + p2, { headers: H });
        const t = await x.text();
        const leaked = SECRET_VALUES.some((v) => v && v.length > 6 && t.includes(v));
        check(`${p2} carries no secret`, !leaked);
      }
    }
  }
} catch (e) {
  fail.push(`verification request failed: ${e.message}`);
}

for (const p of pass) console.log(`${C.g}  ok${C.x}  ${p}`);
for (const f of fail) console.log(`${C.r}FAIL${C.x}  ${f}`);

console.log("");
if (fail.length) {
  console.log(`${C.r}${C.b}Deployed, but ${fail.length} check(s) failed.${C.x} ` +
              `The upload succeeded — investigate before relying on it.`);
  process.exit(2);
}
console.log(`${C.g}${C.b}Live and verified:${C.x} ${SITE}`);
console.log(`${C.d}Passphrase is in .secrets-generated.txt${C.x}\n`);
