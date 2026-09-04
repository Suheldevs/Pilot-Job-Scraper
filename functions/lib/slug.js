/** Matches hey.html's idOf() exactly, so ids stay stable across the migration. */
export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* Legal-entity suffixes only. "Zethic Technologies Pvt Ltd", "Zethic
 * Technologies Private Limited" and "Zethic Technologies" are one company and
 * must collapse to one id — otherwise every scrape run that phrases the name
 * differently creates a duplicate row.
 *
 * Deliberately NOT stripped: descriptive words like "Technologies", "Labs",
 * "Systems", "Solutions", "Digital", "Software". Those distinguish real,
 * different companies ("Acme Labs" is not "Acme Systems"), so removing them
 * would merge rows that should stay apart. Over-merging is worse than a
 * duplicate: it silently hides a lead.
 */
const ENTITY_SUFFIXES = [
  "private limited", "pvt limited", "pvt ltd", "pvt. ltd.", "pvt", "private",
  "limited", "ltd", "llp", "llc", "inc", "incorporated", "corp", "corporation",
  "co", "company", "gmbh", "bv", "nv", "ab", "oy", "sa", "srl", "spa", "plc",
  "pte", "pte ltd", "sdn bhd", "s a r l", "ag", "kg", "as",
];

/** Canonical form used for identity: entity suffixes and punctuation removed. */
export function canonicalName(name) {
  let s = String(name || "").toLowerCase();

  s = s.replace(/[.,]/g, " ")           // "Pvt. Ltd." -> "pvt ltd"
       .replace(/[()\[\]]/g, " ")
       .replace(/&/g, " and ")
       .replace(/\s+/g, " ")
       .trim();

  // Strip trailing entity suffixes repeatedly — "Foo Pvt Ltd" has two.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of ENTITY_SUFFIXES) {
      if (s.endsWith(" " + suffix)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return s || String(name || "").toLowerCase().trim();
}

/** A company's identity is (city, canonical name) — one row per company per city. */
export function companyId(tab, name) {
  return `${tab}:${slugify(canonicalName(name))}`;
}
