/**
 * Regression harness for Pilot.
 *
 *   node regression.mjs                  compare both deployments + invariants
 *   node regression.mjs --target=main    check one deployment in isolation
 *   node regression.mjs --target=clone
 *   node regression.mjs --verbose        show the values behind every check
 *   node regression.mjs --allow-writes   also run the checks that must write
 *
 * The clone (pilot-78d / D1 `pilot-profiles`) was seeded from an export of the
 * original (pilot-78c / D1 `job-outreach`). This proves the two still answer
 * the same questions the same way, and that a set of invariants holds on each
 * one independently.
 *
 * Read-only by default. The only writing check is the progress-isolation one,
 * it is opt-in behind --allow-writes, it creates its own throwaway company and
 * profile, it deletes both afterwards, and it refuses to run against `main`
 * at all.
 *
 * Conventions (credentials, colours, pass/fail reporting) are lifted from
 * deploy.mjs so the two read the same way.
 *
 * Exit codes:  0 everything passed   1 a check failed   2 a target was
 * unreachable (so this can gate a deploy).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath handles the Windows drive letter and percent-decoding — this
// project lives under a path with a space in it, so a hand-rolled conversion
// leaves "%20" behind and every fs call misses. (Same reason as deploy.mjs.)
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------- targets --- */
// Mirrors deploy.mjs's TARGETS. Deliberately duplicated rather than imported:
// a regression test that reads its expectations out of the thing under test
// cannot notice when that thing changes.
const TARGETS = {
  main: {
    name: "main",
    project: "pilot",
    site: "https://pilot-78c.pages.dev",
    db: "job-outreach",
    secrets: ".secrets-generated.txt",
    // The original has no profiles/profile_companies/source_schedule tables.
    profiles: false,
    // Never, under any flag, write to the system in daily use.
    writable: false,
  },
  clone: {
    name: "clone",
    project: "pilot-78d",
    site: "https://pilot-78d.pages.dev",
    db: "pilot-profiles",
    secrets: ".secrets-78d.txt",
    profiles: true,
    writable: true,
  },
};

/* --------------------------------------------------- expected constants --- */
// The five tab keys and four grades. Hardcoded on purpose (see the note on
// TARGETS): these are the contract, functions/lib/db.js is the implementation.
const VALID_TABS = ["blr", "pune", "lko", "noida", "rem"];
const VALID_GRADES = ["A", "B", "C", "D"];

// Fields of rowToCompany() that are allowed to differ between the two
// deployments. Printed in the output so a reader knows what was NOT compared.
const PARITY_EXCLUSIONS = ["profile_id", "profile_version"];

// The parent profile, per PROFILE-CONTRACT.md and config.py -> profile.DEFAULTS.
const EXPECTED_DEFAULT_PROFILE = {
  name: "Mohd Suhel",
  search_roles: [
    "full stack developer",
    "mern stack developer",
    "react developer",
    "node js developer",
  ],
  cities: ["blr", "pune", "lko", "noida", "rem"],
  exp_min: 1,
  exp_max: 3,
};

// migrations/007-source-schedule.sql seeds exactly these twelve.
const EXPECTED_SOURCES = [
  "arbeitnow", "ashby", "greenhouse", "hackernews", "instahyre", "keka",
  "linkedin", "lever", "naukri_sitemap", "remoteok", "remotive", "weworkremotely",
];

// Paths that must never hand back a credential. Same list deploy.mjs verifies.
const SECRET_PATHS = ["/.cf-credentials", "/.dev.vars", "/wrangler.toml", "/push.py"];

const COMPANY_SAMPLE_SIZE = 10;
const MAX_IDS_SHOWN = 20;
const MAX_FIELD_DIFFS_SHOWN = 10;
const HTTP_TIMEOUT_MS = 30000;

/* ------------------------------------------------------------------ cli --- */
const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose") || args.includes("-v");
const ALLOW_WRITES = args.includes("--allow-writes");
const targetArg = (args.find((a) => a.startsWith("--target=")) || "").split("=")[1];

if (targetArg && !TARGETS[targetArg]) {
  console.error(`\nunknown --target=${targetArg}. Use one of: ${Object.keys(TARGETS).join(", ")}\n`);
  process.exit(1);
}
const SELECTED = targetArg ? [TARGETS[targetArg]] : [TARGETS.main, TARGETS.clone];
const COMPARING = SELECTED.length === 2;

/* --------------------------------------------------------- reporting ----- */
const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m", b: "\x1b[1m" };
const tally = { ok: 0, fail: 0, skip: 0 };
const failures = [];

const step = (m) => console.log(`\n${C.b}${m}${C.x}`);
const note = (m) => console.log(`${C.d}        ${m}${C.x}`);

/** One line per check. `detail` is the actual value — mandatory on a failure. */
function ok(name, detail = "") {
  tally.ok++;
  console.log(`${C.g}  ok${C.x}  ${name}${detail ? ` ${C.d}(${detail})${C.x}` : ""}`);
}
function fail(name, detail = "") {
  tally.fail++;
  failures.push(name);
  console.log(`${C.r}FAIL${C.x}  ${name}${detail ? ` ${C.d}(${detail})${C.x}` : ""}`);
}
function skip(name, why) {
  tally.skip++;
  console.log(`${C.y}skip${C.x}  ${name} ${C.d}(${why})${C.x}`);
}
/** cond ? ok : fail — `detail` is shown either way so --verbose reads well. */
function check(name, cond, detail = "") {
  if (cond) ok(name, VERBOSE ? detail : detail && String(detail).length <= 60 ? detail : "");
  else fail(name, detail);
}

/* ------------------------------------------------------------- helpers --- */
class Unreachable extends Error {}

/** Stable stringify — key order must not decide whether two payloads match. */
function stable(v) {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}
const same = (a, b) => stable(a) === stable(b);

/** Short, single-line rendering of a value for a failure line. */
function show(v, cap = 90) {
  let s = typeof v === "string" ? v : stable(v);
  s = String(s).replace(/\s+/g, " ");
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

function listCapped(items, cap = MAX_IDS_SHOWN) {
  const shown = items.slice(0, cap).join(", ");
  return items.length > cap ? `${shown}, … +${items.length - cap} more` : shown;
}

/* --------------------------------------------------------- credentials --- */
// Same parse as deploy.mjs: read the passphrase by KEY, not by shape. Matching
// it by shape silently skipped every authenticated check the moment the
// passphrase changed.
function readSecretsFile(file) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return {};
  const out = {};
  for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.+)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// Every live secret value we know of, from BOTH targets' files plus the
// Cloudflare credentials. Used only for `text.includes(value)` — never printed.
const SECRET_VALUES = [];
for (const file of [".secrets-generated.txt", ".secrets-78d.txt", ".cf-credentials"]) {
  for (const v of Object.values(readSecretsFile(file))) {
    if (v && v.length > 6 && !SECRET_VALUES.includes(v)) SECRET_VALUES.push(v);
  }
}

for (const t of SELECTED) {
  t.password = readSecretsFile(t.secrets).SITE_PASSWORD || "";
}

/* -------------------------------------------------------------- fetches --- */
async function request(t, pathname, { method = "GET", body, auth = true, redirect = "manual" } = {}) {
  const headers = {};
  if (auth && t.token) headers.Cookie = `session=${t.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(t.site + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Unreachable(`${t.name} ${method} ${pathname}: ${e.message}`);
  }
  return res;
}

/** GET a JSON endpoint. Returns { status, data, error } — never throws on a
 *  non-200, because "this endpoint 500s on main" is itself a finding. */
async function getJson(t, pathname) {
  const res = await request(t, pathname);
  const text = await res.text();
  let data = null;
  let error = null;
  try {
    data = JSON.parse(text);
  } catch {
    error = `non-JSON body: ${show(text, 120)}`;
  }
  return { status: res.status, data, error };
}

async function login(t) {
  if (!t.password) {
    throw new Unreachable(`no SITE_PASSWORD line in ${t.secrets}`);
  }
  const res = await request(t, "/api/login", { method: "POST", body: { password: t.password }, auth: false });
  const cookie = String(res.headers.get("set-cookie") || "");
  const token = (/session=([^;]+)/.exec(cookie) || [])[1];
  return { status: res.status, token };
}

/* ========================================================================= */
const started = Date.now();
console.log(
  `\n${C.b}Pilot regression${C.x}  ${C.d}[${SELECTED.map((t) => `${t.name} -> ${t.site.replace("https://", "")} (db ${t.db})`).join(", ")}]${C.x}`
);
if (ALLOW_WRITES) console.log(`${C.y}        --allow-writes: writing checks are enabled (clone only)${C.x}`);

let sawUnreachable = false;

/* ----------------------------------------------------- 1. reachability --- */
step("1. Reachability and login");
for (const t of SELECTED) {
  try {
    const { status, token } = await login(t);
    t.token = token;
    check(`${t.name}: login returns 302 with a session cookie`, status === 302 && Boolean(token),
      `HTTP ${status}, cookie ${token ? "present" : "MISSING"}`);
  } catch (e) {
    if (e instanceof Unreachable) {
      sawUnreachable = true;
      fail(`${t.name}: reachable`, e.message);
    } else throw e;
  }
}
if (sawUnreachable) {
  console.log(`\n${C.r}${C.b}A deployment was unreachable — nothing further was checked.${C.x}\n`);
  process.exit(2);
}

/* ------------------------------------------------------- 2. invariants --- */
/** These must hold on each deployment on its own, whatever the other says. */
async function invariants(t) {
  step(`2. Invariants — ${t.name} ${C.d}[${t.site}]${C.x}`);

  // -- auth wall ----------------------------------------------------------
  {
    const res = await request(t, "/api/companies", { auth: false });
    check(`${t.name}: unauthenticated GET /api/companies is 401`, res.status === 401, `HTTP ${res.status}`);
  }
  {
    const res = await request(t, "/", { auth: false });
    const body = await res.text();
    const isLogin = res.status === 200 && body.includes("Sign in") && body.includes('action="/api/login"');
    check(`${t.name}: unauthenticated GET / serves the login page`, isLogin,
      `HTTP ${res.status}, ${body.length} bytes, "Sign in" ${body.includes("Sign in") ? "present" : "MISSING"}`);
  }
  {
    // A password that cannot collide with the real one. The real value is never
    // echoed anywhere in this file.
    const res = await request(t, "/api/login", {
      method: "POST",
      auth: false,
      body: { password: `wrong-passphrase-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    });
    const cookie = String(res.headers.get("set-cookie") || "");
    const issued = /session=[^;]+/.test(cookie);
    check(`${t.name}: wrong password is 401 and issues no cookie`, res.status === 401 && !issued,
      `HTTP ${res.status}, cookie ${issued ? "ISSUED" : "none"}`);
  }

  // -- row shape ----------------------------------------------------------
  const companies = await getJson(t, "/api/companies");
  if (companies.status !== 200 || !Array.isArray(companies.data)) {
    fail(`${t.name}: GET /api/companies returns an array`,
      `HTTP ${companies.status}${companies.error ? `, ${companies.error}` : ""}`);
  } else {
    const rows = companies.data;
    ok(`${t.name}: GET /api/companies returns an array`, `${rows.length} rows`);

    const badTab = rows.filter((r) => !r.tab || !VALID_TABS.includes(r.tab));
    check(`${t.name}: every row has a tab from ${VALID_TABS.join("/")}`, badTab.length === 0,
      badTab.length ? `${badTab.length} bad: ${listCapped(badTab.map((r) => `${r.id}=${JSON.stringify(r.tab)}`))}`
                    : `${rows.length} rows checked`);

    const badGrade = rows.filter((r) => r.grade !== "" && !VALID_GRADES.includes(r.grade));
    check(`${t.name}: every grade is empty or one of ${VALID_GRADES.join("/")}`, badGrade.length === 0,
      badGrade.length ? `${badGrade.length} bad: ${listCapped(badGrade.map((r) => `${r.id}=${JSON.stringify(r.grade)}`))}`
                      : `${rows.length} rows checked`);

    const badArrays = [];
    for (const r of rows) {
      for (const f of ["hr", "em", "wa"]) {
        if (!Array.isArray(r[f])) badArrays.push(`${r.id}.${f}=${show(r[f], 30)}`);
      }
    }
    check(`${t.name}: hr/em/wa are always arrays`, badArrays.length === 0,
      badArrays.length ? `${badArrays.length} bad: ${listCapped(badArrays)}` : `${rows.length * 3} fields checked`);
  }

  // -- prune preview (a GET; deletes nothing) -----------------------------
  {
    const p = await getJson(t, "/api/maintenance/prune?days=10");
    const n = p.data?.would_remove;
    check(`${t.name}: GET /api/maintenance/prune?days=10 previews a count`,
      p.status === 200 && typeof n === "number" && Number.isFinite(n),
      `HTTP ${p.status}, would_remove=${show(n, 40)}`);
  }

  // -- no secret is fetchable ---------------------------------------------
  if (!SECRET_VALUES.length) {
    skip(`${t.name}: secret files are not fetchable`, "no secret values could be read locally to screen for");
  } else {
    const leaked = [];
    for (const p of SECRET_PATHS) {
      const res = await request(t, p);
      const text = await res.text();
      if (SECRET_VALUES.some((v) => text.includes(v))) leaked.push(p);
    }
    check(`${t.name}: ${SECRET_PATHS.join(", ")} carry no secret`, leaked.length === 0,
      leaked.length ? `LEAKED via ${leaked.join(", ")}` : `${SECRET_PATHS.length} paths x ${SECRET_VALUES.length} values screened`);
  }
}

/* ----------------------------------------------------- 3. clone-only ----- */
/** Profile-system checks. On a target without the profile tables every one of
 *  these skips with "not present on this target". */
async function cloneOnly(t) {
  step(`3. Profile system — ${t.name}`);

  const NOT_PRESENT = "not present on this target";
  const profiles = t.profiles ? await getJson(t, "/api/profiles") : { status: 0, data: null };
  const havePlist = profiles.status === 200 && Array.isArray(profiles.data);

  if (!havePlist) {
    const why = t.profiles ? `${NOT_PRESENT} — GET /api/profiles HTTP ${profiles.status}` : NOT_PRESENT;
    skip(`${t.name}: exactly one profile is is_default`, why);
    skip(`${t.name}: default profile matches config.py / PROFILE-CONTRACT.md`, why);
  } else {
    const list = profiles.data;
    const defaults = list.filter((p) => p.is_default === 1 || p.is_default === true);
    check(`${t.name}: exactly one profile has is_default = 1`, defaults.length === 1,
      `${list.length} profile(s), ${defaults.length} default(s): ${listCapped(defaults.map((p) => `${p.id}:${p.name}`))}`);

    const parent = defaults[0];
    if (!parent) {
      skip(`${t.name}: default profile matches config.py / PROFILE-CONTRACT.md`, "no default profile to inspect");
    } else {
      // The list endpoint already parses the JSON arrays; re-read the single
      // profile so the check covers the shape the app actually consumes.
      const one = await getJson(t, `/api/profile/${parent.id}`);
      const p = one.status === 200 && one.data ? one.data : parent;

      check(`${t.name}: default profile is named "${EXPECTED_DEFAULT_PROFILE.name}"`,
        p.name === EXPECTED_DEFAULT_PROFILE.name, `name=${show(p.name)}`);
      check(`${t.name}: default profile search_roles match config.ROLE_KEYWORDS`,
        same(p.search_roles, EXPECTED_DEFAULT_PROFILE.search_roles),
        `expected ${show(EXPECTED_DEFAULT_PROFILE.search_roles)} got ${show(p.search_roles)}`);
      check(`${t.name}: default profile cities are the five tab keys`,
        same(p.cities, EXPECTED_DEFAULT_PROFILE.cities),
        `expected ${show(EXPECTED_DEFAULT_PROFILE.cities)} got ${show(p.cities)}`);
      check(`${t.name}: default profile experience band is ${EXPECTED_DEFAULT_PROFILE.exp_min}-${EXPECTED_DEFAULT_PROFILE.exp_max} years`,
        Number(p.exp_min) === EXPECTED_DEFAULT_PROFILE.exp_min && Number(p.exp_max) === EXPECTED_DEFAULT_PROFILE.exp_max,
        `exp_min=${show(p.exp_min)} exp_max=${show(p.exp_max)}`);
    }
  }

  // -- schedule ------------------------------------------------------------
  const sched = t.profiles ? await getJson(t, "/api/schedule") : { status: 0, data: null };
  if (sched.status !== 200 || !Array.isArray(sched.data?.sources)) {
    skip(`${t.name}: /api/schedule lists all 12 sources`,
      t.profiles ? `${NOT_PRESENT} — GET /api/schedule HTTP ${sched.status}` : NOT_PRESENT);
  } else {
    const got = sched.data.sources.map((s) => s.source).sort();
    const missing = EXPECTED_SOURCES.filter((s) => !got.includes(s));
    const extra = got.filter((s) => !EXPECTED_SOURCES.includes(s));
    check(`${t.name}: /api/schedule lists all 12 sources`,
      got.length === EXPECTED_SOURCES.length && !missing.length && !extra.length,
      `${got.length} sources${missing.length ? `, missing: ${missing.join(", ")}` : ""}${extra.length ? `, unexpected: ${extra.join(", ")}` : ""}`);
  }

  // -- the progress-isolation invariant -----------------------------------
  await progressIsolation(t, havePlist ? profiles.data : null, NOT_PRESENT);
}

/** Setting a stage under one profile must not change it under another.
 *
 *  Read-only path: with fewer than two profiles the invariant is vacuous, so it
 *  skips rather than pretending to have proved something. With two or more it
 *  probes whether the API is profile-aware at all, which is the strongest
 *  read-only statement available.
 *
 *  Write path (--allow-writes, clone only): creates a throwaway company and a
 *  throwaway second profile, sets a stage under one, reads it back under the
 *  other, then deletes both. Nothing pre-existing is touched.
 */
async function progressIsolation(t, profileList, NOT_PRESENT) {
  const NAME = `${t.name}: progress does not leak between profiles`;

  if (!profileList) {
    skip(NAME, t.profiles ? `${NOT_PRESENT} — no profile list` : NOT_PRESENT);
    return;
  }

  if (!ALLOW_WRITES) {
    if (profileList.length < 2) {
      skip(NAME, `only ${profileList.length} profile exists, so the invariant is vacuous; ` +
                 `re-run with --allow-writes to create a throwaway second profile and prove it`);
    } else {
      // Two real profiles exist: at minimum the listing must respond to the
      // profile selector, otherwise per-profile progress cannot be isolated.
      const [a, b] = profileList;
      const one = await getJson(t, `/api/companies?profile_id=${a.id}`);
      const two = await getJson(t, `/api/companies?profile_id=${b.id}`);
      const aware = one.status === 200 && two.status === 200 &&
        !same((one.data || []).map((r) => r.id), (two.data || []).map((r) => r.id));
      check(`${NAME} ${C.d}(read-only: API is profile-aware)${C.x}`, aware,
        `?profile_id=${a.id} -> ${one.data?.length} rows, ?profile_id=${b.id} -> ${two.data?.length} rows; ` +
        `identical row sets mean the profile selector is ignored`);
    }
    return;
  }

  if (!t.writable) {
    skip(NAME, "writing checks are never run against main");
    return;
  }

  console.log(`${C.y}      WRITE${C.x} ${C.d}creating a throwaway company + profile on ${t.name}, deleting both after${C.x}`);
  const stamp = Date.now();
  const parent = profileList.find((p) => p.is_default) || profileList[0];
  let companyId = null;
  let tempProfileId = null;

  try {
    const created = await request(t, "/api/companies", {
      method: "POST",
      body: {
        name: `zz Regression Probe ${stamp}`,
        tab: "rem",
        source: "manual",
        note: "created by regression.mjs — safe to delete",
      },
    });
    const createdBody = await created.json().catch(() => null);
    companyId = createdBody?.id || null;
    if (!companyId) {
      fail(NAME, `could not create the probe company: HTTP ${created.status} ${show(createdBody)}`);
      return;
    }

    const madeProfile = await request(t, "/api/profiles", {
      method: "POST",
      body: { name: `zz regression probe ${stamp}`, copy_from: parent.id },
    });
    const profileBody = await madeProfile.json().catch(() => null);
    tempProfileId = profileBody?.id || null;
    if (!tempProfileId) {
      fail(NAME, `could not create the probe profile: HTTP ${madeProfile.status} ${show(profileBody)}`);
      return;
    }

    // Stage it under the parent profile...
    //
    // The id is interpolated RAW. Company ids look like "rem:zz-probe-123" and
    // a percent-encoded colon does not survive into `params.id` on Pages, so
    // encodeURIComponent() here makes every /api/progress/:id and
    // /api/companies/:id call 404 — including the cleanup DELETE, which then
    // silently leaves the probe row behind. A colon is legal in a path segment.
    const put = await request(t, `/api/progress/${companyId}?profile_id=${parent.id}`, {
      method: "PUT",
      body: { stage: "contacted", note: `regression ${stamp}` },
    });
    if (put.status !== 200) {
      fail(NAME, `PUT /api/progress under profile ${parent.id} returned HTTP ${put.status}`);
      return;
    }

    // ...and read it back under the throwaway one. A fresh profile must see
    // 'none' (or no row at all), never the parent's stage.
    const asOther = await getJson(t, `/api/progress/${companyId}?profile_id=${tempProfileId}`);
    const leakedStage = asOther.status === 200 ? (asOther.data?.stage ?? null) : null;
    const isolated = asOther.status === 404 || leakedStage === "none" || leakedStage === null;
    check(NAME, isolated,
      `stage set to "contacted" under profile ${parent.id}; profile ${tempProfileId} sees ` +
      `HTTP ${asOther.status} stage=${show(leakedStage)} (expected 404 or "none")`);
  } catch (e) {
    if (e instanceof Unreachable) fail(NAME, e.message);
    else fail(NAME, `unexpected error: ${e.message}`);
  } finally {
    // Clean up in reverse order, then PROVE it — a leftover probe row would
    // corrupt every future parity run (293 vs 292). The DELETE handlers answer
    // {ok:true} whether or not they matched anything, so their status code is
    // not evidence; only re-reading the listings is.
    const cleaned = [];
    if (companyId) {
      const r = await request(t, `/api/companies/${companyId}`, { method: "DELETE" }).catch(() => ({ status: 0 }));
      cleaned.push(`DELETE company ${companyId} -> HTTP ${r.status}`);
    }
    if (tempProfileId) {
      const r = await request(t, `/api/profile/${tempProfileId}`, { method: "DELETE" }).catch(() => ({ status: 0 }));
      cleaned.push(`DELETE profile ${tempProfileId} -> HTTP ${r.status}`);
    }
    if (cleaned.length) {
      const [afterCo, afterPr] = await Promise.all([
        getJson(t, "/api/companies"),
        getJson(t, "/api/profiles"),
      ]);
      const companyGone = !companyId ||
        !(afterCo.data || []).some((r) => r.id === companyId);
      const profileGone = !tempProfileId ||
        !(afterPr.data || []).some((p) => p.id === tempProfileId);
      check(`${t.name}: write-check cleanup removed everything it created`, companyGone && profileGone,
        `${cleaned.join("; ")}; verified: company ${companyGone ? "gone" : "STILL PRESENT"}, ` +
        `profile ${profileGone ? "gone" : "STILL PRESENT"}; ${afterCo.data?.length} companies, ` +
        `${afterPr.data?.length} profile(s) remain`);
    }
  }
}

/* ---------------------------------------------------------- 4. parity ---- */
/** Everything the two deployments must answer identically. */
async function parity(a, b) {
  step(`4. Parity — ${a.name} vs ${b.name}`);
  note(`fields excluded from the row-level comparison: ${PARITY_EXCLUSIONS.join(", ")} ` +
       `(profile stamping is expected to differ)`);

  const [ca, cb] = await Promise.all([getJson(a, "/api/companies"), getJson(b, "/api/companies")]);
  if (!Array.isArray(ca.data) || !Array.isArray(cb.data)) {
    fail("companies: both endpoints return arrays",
      `${a.name} HTTP ${ca.status}, ${b.name} HTTP ${cb.status}`);
    return;
  }
  const rowsA = ca.data;
  const rowsB = cb.data;

  // -- count and id set ---------------------------------------------------
  check("company count matches", rowsA.length === rowsB.length, `${a.name}=${rowsA.length} ${b.name}=${rowsB.length}`);

  const idsA = new Set(rowsA.map((r) => r.id));
  const idsB = new Set(rowsB.map((r) => r.id));
  const onlyA = [...idsA].filter((id) => !idsB.has(id)).sort();
  const onlyB = [...idsB].filter((id) => !idsA.has(id)).sort();
  check("company id sets match", onlyA.length === 0 && onlyB.length === 0,
    `only in ${a.name} (${onlyA.length}): ${listCapped(onlyA) || "-"} | only in ${b.name} (${onlyB.length}): ${listCapped(onlyB) || "-"}`);

  // -- grouped counts, derived from the same endpoint on both -------------
  const [aa, ab] = await Promise.all([getJson(a, "/api/analytics"), getJson(b, "/api/analytics")]);
  if (aa.status !== 200 || ab.status !== 200) {
    fail("analytics: both endpoints answer 200", `${a.name} HTTP ${aa.status}, ${b.name} HTTP ${ab.status}`);
  } else {
    const counts = (payload, rows, key, value) =>
      Object.fromEntries((payload.data?.[rows] || []).map((r) => [String(r[key]), Number(r[value])]));

    for (const [label, rowsKey, keyField, valueField] of [
      ["per-city counts", "by_tab", "tab", "total"],
      ["per-grade counts", "by_grade", "grade", "total"],
      ["per-platform counts", "by_platform", "platform", "count"],
    ]) {
      const ma = counts(aa, rowsKey, keyField, valueField);
      const mb = counts(ab, rowsKey, keyField, valueField);
      const keys = [...new Set([...Object.keys(ma), ...Object.keys(mb)])].sort();
      const diffs = keys.filter((k) => ma[k] !== mb[k]).map((k) => `${k}: ${a.name}=${ma[k] ?? "-"} ${b.name}=${mb[k] ?? "-"}`);
      check(`${label} match`, diffs.length === 0,
        diffs.length ? diffs.join(", ") : keys.map((k) => `${k}=${ma[k]}`).join(" "));
    }

    const ta = aa.data?.totals;
    const tb = ab.data?.totals;
    const totalKeys = [...new Set([...Object.keys(ta || {}), ...Object.keys(tb || {})])].sort();
    const totalDiffs = totalKeys.filter((k) => ta?.[k] !== tb?.[k]).map((k) => `${k}: ${a.name}=${ta?.[k]} ${b.name}=${tb?.[k]}`);
    check("analytics.totals match", totalDiffs.length === 0,
      totalDiffs.length ? totalDiffs.join(", ") : totalKeys.map((k) => `${k}=${ta[k]}`).join(" "));

    check("analytics.response_rate matches", aa.data?.response_rate === ab.data?.response_rate,
      `${a.name}=${show(aa.data?.response_rate)} ${b.name}=${show(ab.data?.response_rate)}`);
  }

  // -- templates / settings payload ---------------------------------------
  const [ma, mb] = await Promise.all([getJson(a, "/api/templates"), getJson(b, "/api/templates")]);
  if (ma.status !== 200 || mb.status !== 200) {
    fail("templates: both endpoints answer 200", `${a.name} HTTP ${ma.status}, ${b.name} HTTP ${mb.status}`);
  } else {
    const keys = [...new Set([...Object.keys(ma.data || {}), ...Object.keys(mb.data || {})])].sort();
    const diffs = keys
      .filter((k) => !same(ma.data?.[k], mb.data?.[k]))
      .map((k) => `${k}: ${a.name}=${show(ma.data?.[k], 60)} ${b.name}=${show(mb.data?.[k], 60)}`);
    check("templates/settings payload matches", diffs.length === 0,
      diffs.length ? diffs.join(" | ") : `keys: ${keys.join(", ")}`);
  }

  // -- field-level sample -------------------------------------------------
  const shared = [...idsA].filter((id) => idsB.has(id)).sort();
  if (!shared.length) {
    skip("sampled companies match field for field", "no company id is present on both targets");
    return;
  }
  // Evenly spaced through the sorted intersection rather than the first N, so
  // the sample is deterministic but not clustered at one end of the table.
  const stride = Math.max(1, Math.floor(shared.length / COMPANY_SAMPLE_SIZE));
  const sample = [];
  for (let i = 0; i < shared.length && sample.length < COMPANY_SAMPLE_SIZE; i += stride) sample.push(shared[i]);

  const byIdA = new Map(rowsA.map((r) => [r.id, r]));
  const byIdB = new Map(rowsB.map((r) => [r.id, r]));
  const diffs = [];
  let fieldsCompared = 0;
  for (const id of sample) {
    const ra = byIdA.get(id);
    const rb = byIdB.get(id);
    const fields = [...new Set([...Object.keys(ra), ...Object.keys(rb)])]
      .filter((f) => !PARITY_EXCLUSIONS.includes(f))
      .sort();
    for (const f of fields) {
      fieldsCompared++;
      if (!same(ra[f], rb[f])) {
        diffs.push(`${id}.${f}: ${a.name}=${show(ra[f], 50)} ${b.name}=${show(rb[f], 50)}`);
      }
    }
  }
  check(`${sample.length} sampled companies match field for field`, diffs.length === 0,
    diffs.length
      ? `${diffs.length} mismatch(es): ${diffs.slice(0, MAX_FIELD_DIFFS_SHOWN).join(" | ")}${diffs.length > MAX_FIELD_DIFFS_SHOWN ? ` | … +${diffs.length - MAX_FIELD_DIFFS_SHOWN} more` : ""}`
      : `${fieldsCompared} fields across ${sample.length} rows; sample: ${listCapped(sample, 10)}`);
  if (VERBOSE) note(`sampled ids: ${sample.join(", ")}`);
}

/* ------------------------------------------------------------- run it ---- */
try {
  for (const t of SELECTED) await invariants(t);
  for (const t of SELECTED) await cloneOnly(t);
  if (COMPARING) await parity(SELECTED[0], SELECTED[1]);
  else step(`4. Parity — skipped ${C.d}(single --target=${SELECTED[0].name} run)${C.x}`);
} catch (e) {
  if (e instanceof Unreachable) {
    console.log(`\n${C.r}${C.b}Unreachable:${C.x} ${e.message}\n`);
    process.exit(2);
  }
  throw e;
}

/* ------------------------------------------------------------ summary ---- */
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${C.b}Summary${C.x}`);
console.log(
  `        ${C.g}${tally.ok} passed${C.x}  ` +
  `${tally.fail ? C.r : C.d}${tally.fail} failed${C.x}  ` +
  `${tally.skip ? C.y : C.d}${tally.skip} skipped${C.x}  ${C.d}in ${seconds}s${C.x}`
);
if (!ALLOW_WRITES) console.log(`${C.d}        read-only run — no deployment was written to${C.x}`);

if (tally.fail) {
  console.log(`\n${C.r}${C.b}${tally.fail} check(s) failed:${C.x}`);
  for (const f of failures) console.log(`${C.r}        - ${f}${C.x}`);
  console.log("");
  process.exit(1);
}
console.log(`\n${C.g}${C.b}All checks passed.${C.x}\n`);
process.exit(0);
