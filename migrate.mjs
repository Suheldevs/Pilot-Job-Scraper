/** One-time migration: pull the embedded company list out of index.html's
 *  BUNDLED + SEED literals and emit SQL to load them into D1 as source='seed'.
 *
 *  Usage: node migrate.mjs > seed-data.sql
 */
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

function readLiteral(name) {
  // Match `const NAME = { ... };` up to the line that closes it at column 0.
  const re = new RegExp(`const\\s+${name}\\s*=\\s*(\\{[\\s\\S]*?\\n\\});`, "m");
  const m = html.match(re);
  if (!m) throw new Error(`could not locate ${name}`);
  return Function(`"use strict";return (${m[1]})`)();
}

const BUNDLED = readLiteral("BUNDLED");
const SEED = readLiteral("SEED");
const DATA = Object.assign({}, BUNDLED, SEED);

const SECTION_TO_TAB = {
  s1: "blr", s2: "blr", s3: "blr",
  p1: "pune", p2: "pune", p3: "pune",
  l1: "lko", l2: "lko", l3: "lko",
  n1: "noida", n2: "noida",
  r1: "rem",
};

const slugify = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const esc = (v) => `'${String(v ?? "").replace(/'/g, "''")}'`;

const now = Date.now();
const lines = [];
let count = 0;
const seen = new Set();

for (const [section, list] of Object.entries(DATA)) {
  const tab = SECTION_TO_TAB[section];
  if (!tab || !Array.isArray(list)) continue;

  for (const c of list) {
    if (!c || !c.n) continue;
    const id = `${tab}:${slugify(c.n)}`;
    if (seen.has(id)) continue; // same company listed twice in one city
    seen.add(id);

    const job = c.job || null;
    lines.push(
      `INSERT INTO companies (id, tab, section, name, li, hr, em, wa, land, note, job_url, job_title, source, scraped_from, created_at) VALUES (` +
      [
        esc(id), esc(tab), esc(section), esc(c.n), esc(c.li || ""),
        esc(JSON.stringify(c.hr || [])), esc(JSON.stringify(c.em || [])),
        esc(JSON.stringify(c.wa || [])),
        esc(c.land || ""), esc(c.note || ""),
        esc(job ? job.u : ""), esc(job ? job.t : ""),
        esc("seed"), esc(""), now,
      ].join(", ") + `) ON CONFLICT(id) DO NOTHING;`
    );
    lines.push(
      `INSERT INTO progress (company_id, stage, note, updated_at) VALUES (${esc(id)}, 'none', '', ${now}) ON CONFLICT(company_id) DO NOTHING;`
    );
    count++;
  }
}

// The outreach message template, so it carries over too.
const tplMatch = html.match(/const DEFAULT_TPL\s*=\s*([\s\S]*?);\n/);
if (tplMatch) {
  const tpl = Function(`"use strict";return (${tplMatch[1]})`)();
  lines.push(`INSERT INTO settings (key, value) VALUES ('template', ${esc(tpl)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
}

console.log(lines.join("\n"));
console.error(`-- migrated ${count} companies across ${Object.keys(DATA).length} sections`);
