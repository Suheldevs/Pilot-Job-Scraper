// Pilot — Job Board Grabber, background service worker.
//
// Everything that touches the network or the page lives here rather than in the
// popup: the auto-scroll grab takes 30-60s and the popup can be closed at any
// moment, and keeping one copy of the parser (instead of one per surface) means
// the manual and auto grabs can never drift apart. The popup is only UI.
//
// Flow: inject a collector into the tab you are already logged into -> get back
// the text blocks that actually contain a contact -> parse them here into the
// dashboard's company shape -> POST /api/companies/bulk.

const DEFAULT_BASE = 'https://pilot-78c.pages.dev';

// Job boards the grab buttons are allowed to run on. KEEP IN SYNC with
// host_permissions in manifest.json — the manifest decides what Chrome will let
// us inject into, this regex decides what we bother asking about.
const SUPPORTED = /(linkedin|naukri|wellfound|internshala|indeed)\./i;

// push.py sends 100 companies per request; the API chunks D1 statements
// internally but a smaller body still fails faster and reports sooner.
const CHUNK = 100;

const get = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const set = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));
const trimBase = (url) => String(url || DEFAULT_BASE).trim().replace(/\/+$/, '');

function badge(text) {
  // Wrapped because setBadge* throws if the action is mid-teardown.
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#1d6b3f' });
    chrome.action.setBadgeText({ text: String(text) });
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// Location -> tab. Mirror of locations.py, deliberately literal.
// ─────────────────────────────────────────────────────────────

// Same keys, same order, same keywords as locations.py's TAB_KEYWORDS. Order
// matters: JS objects keep insertion order, so the city loop below walks them in
// exactly the order Python does, which is what decides ties like "Noida/Delhi".
const TAB_KEYWORDS = {
  blr: ['bangalore', 'bengaluru', 'blr'],
  pune: ['pune'],
  lko: ['lucknow', 'lko'],
  noida: ['noida', 'greater noida', 'ncr', 'gurugram', 'gurgaon', 'delhi', 'ghaziabad', 'faridabad'],
  rem: ['remote', 'work from home', 'wfh', 'anywhere', 'hybrid remote'],
};

const ALL_LOCATION_WORDS = Object.values(TAB_KEYWORDS).flat();

/** Returns a VALID_TABS key, or null when the location isn't one Pilot tracks.
 *  Companies with null are dropped before we POST — the API rejects any tab
 *  outside VALID_TABS, so sending them would just inflate its "skipped" count. */
function classifyLocation(raw) {
  if (!raw) return null;
  const text = String(raw).toLowerCase().replace(/[^a-z0-9\s]/g, ' ');

  // Remote wins over any city that happens to share the string ("Remote (India),
  // team in Bangalore") — same precedence as locations.py.
  for (const keyword of TAB_KEYWORDS.rem) {
    if (text.includes(keyword)) return 'rem';
  }
  for (const [tab, keywords] of Object.entries(TAB_KEYWORDS)) {
    if (tab === 'rem') continue;
    for (const keyword of keywords) {
      if (text.includes(keyword)) return tab;
    }
  }
  return null;
}

/** Narrow a whole post down to the bit that is actually a location, so
 *  classifyLocation() sees something as small as the location_raw field
 *  locations.py was written for. Feeding it the entire post would let one
 *  stray "delhi" anywhere in a JD decide the tab. */
function locationText(block) {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);

  // 1. An explicit label is the most trustworthy thing on the page.
  for (const line of lines) {
    const m = line.match(/^(?:job\s+|work\s+|office\s+)?locations?\s*[:\-–]\s*(.+)$/i);
    if (m) return m[1];
  }
  // 2. Otherwise the shortest line mentioning a city we track: short lines are
  //    location chips ("Bengaluru, Karnataka") rather than prose.
  let best = null;
  for (const line of lines) {
    const low = line.toLowerCase();
    if (!ALL_LOCATION_WORDS.some((w) => low.includes(w))) continue;
    if (!best || line.length < best.length) best = line;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────
// Contact extraction
// ─────────────────────────────────────────────────────────────

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

// Addresses that exist but are not a route to a human who can hire you, plus
// the boards' own transactional senders that show up in page furniture.
const EMAIL_NOISE = /(?:^|[.\-_])(?:no-?reply|donotreply|do-not-reply|noreply|postmaster|abuse|unsubscribe)(?:$|[.\-_])/i;
const NOISE_DOMAINS = [
  'linkedin.com', 'naukri.com', 'indeed.com', 'internshala.com', 'wellfound.com',
  'angel.co', 'example.com', 'example.org', 'sentry.io', 'gstatic.com', 'w3.org',
];

// Free mail hosts: a company name can never be recovered from these domains.
const FREE_MAIL = new Set([
  'gmail', 'googlemail', 'yahoo', 'ymail', 'rocketmail', 'hotmail', 'outlook',
  'live', 'msn', 'rediffmail', 'rediff', 'icloud', 'me', 'protonmail', 'proton',
  'aol', 'zoho', 'mail', 'gmx', 'yandex', 'inbox', 'hey',
]);

// Trailing labels to peel off a domain before what's left is the company name.
const TLD_PARTS = new Set([
  'com', 'net', 'org', 'in', 'co', 'io', 'ai', 'dev', 'app', 'me', 'us', 'uk',
  'info', 'biz', 'xyz', 'site', 'online', 'cloud', 'tech', 'digital', 'agency',
  'solutions', 'services', 'company', 'careers', 'jobs', 'edu', 'gov', 'ac',
]);

// Local parts that mean "this mailbox is for hiring". Exactly the list the task
// specifies; matched against the local part split into words.
const HR_WORDS = ['hr', 'career', 'careers', 'job', 'jobs', 'recruit', 'talent', 'hiring', 'apply', 'resume', 'cv'];

/** hr[] vs em[]: is this mailbox a recruitment address?
 *  Words are matched as whole tokens, and only long words are allowed to match
 *  as a prefix ("recruitment", "talentacquisition", "hiringteam"). Short ones
 *  must be exact, otherwise names like "jobin@" or "hrithik@" get misfiled. */
function isHrEmail(email) {
  const local = email.split('@')[0].toLowerCase();
  const words = local.split(/[^a-z]+/).filter(Boolean);
  return words.some((w) =>
    HR_WORDS.some((hw) => w === hw || (hw.length >= 5 && w.startsWith(hw))));
}

function extractEmails(text) {
  const out = [];
  for (const raw of text.match(EMAIL_RE) || []) {
    const email = raw.toLowerCase().replace(/[.,;:)\]]+$/, '');
    const [local, domain] = email.split('@');
    if (!local || !domain || !/\.[a-z]{2,}$/.test(domain)) continue;
    if (/\.(?:png|jpe?g|gif|svg|webp|css|js)$/.test(domain)) continue; // asset URL, not an address
    if (EMAIL_NOISE.test(local)) continue;
    if (NOISE_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) continue;
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

/** Indian mobiles only, digits only — that's what the dashboard's wa[] is for
 *  (it builds wa.me links). 10 digits starting 6-9, or 12 starting 91 then 6-9. */
function extractPhones(text) {
  // Recruiters break numbers up ("98765 43210", "+91-98765-43210", "(98765) 43210").
  // Collapse separators that sit *between two digits* so one regex can validate
  // the result. This can also glue unrelated numbers together ("5 - 8 LPA" ->
  // "58"), which is harmless: the validation below throws away anything that
  // isn't a plausible mobile.
  const flat = text.replace(/(\d)[\s.\-()]{1,3}(?=\d)/g, '$1');
  const out = [];
  const seen = new Set();
  // The digit guards on both ends stop us slicing a mobile-looking window out of
  // a longer number (an order id, a PAN, a 16-digit anything).
  for (const m of flat.matchAll(/(?<![\d])(\+?91)?([6-9]\d{9})(?![\d])/g)) {
    const digits = (m[1] ? '91' : '') + m[2];
    const last10 = digits.slice(-10); // "9198..." and "98..." are one number
    if (seen.has(last10)) continue;
    seen.add(last10);
    out.push(digits);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Company name
// ─────────────────────────────────────────────────────────────

// Words a real company name ends with. Used to spot the name on its own line.
const CORP_SUFFIX = /\b(?:pvt\.?\s*ltd|private\s+limited|limited|ltd|llp|inc|incorporated|corp|corporation|technologies|technology|solutions|systems|software|labs|infotech|consultancy|consulting|services|studios?|media|group|ventures|analytics|networks|enterprises|industries|associates)\b\.?$/i;

// Lines that look like a name but are really page furniture or JD headings.
const NOT_A_NAME = /\b(?:hiring|urgent|apply|walk\s?in|job|jobs|vacancy|opening|opportunit|location|experience|salary|ctc|stipend|skill|qualification|responsibilit|requirement|immediate|joiner|notice\s+period|shift|fresher|internship|full\s?time|part\s?time|posted|ago|followers?|connections?|promoted|sponsored|save|share|repost|comment|like|view|profile|message|easy\s+apply|be\s+an\s+early\s+applicant)\b/i;

function cleanName(raw) {
  return String(raw)
    .replace(/[\s ]+/g, ' ')
    .replace(/^["'“”‘’(\[|\-–\s]+/, '')
    .replace(/["'“”‘’)\]|\-–.,;:!\s]+$/, '')
    .trim();
}

function plausibleName(name) {
  if (!name) return false;
  const n = cleanName(name);
  if (n.length < 2 || n.length > 70) return false;
  if (!/[a-z]/i.test(n)) return false;               // must contain letters
  if (/[@]|https?:|www\./i.test(n)) return false;    // that's a contact, not a name
  if (n.split(/\s+/).length > 7) return false;       // a sentence, not a name
  if (NOT_A_NAME.test(n)) return false;
  if (/^\d/.test(n)) return false;
  return true;
}

/** Turn "careers.acme-labs.co.in" into "Acme Labs". Returns null for free mail
 *  hosts, where the domain says nothing about the employer. */
function nameFromDomain(domain) {
  const parts = domain.toLowerCase().split('.');
  while (parts.length > 1 && TLD_PARTS.has(parts[parts.length - 1])) parts.pop();
  const label = parts[parts.length - 1];
  if (!label || label.length < 3 || FREE_MAIL.has(label)) return null;
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Best-effort company name for one block of post text. Ordered most to least
 *  trustworthy; returns null rather than guessing, because a nameless row would
 *  land in the dashboard as an unusable duplicate-magnet. */
function guessName(block, emails) {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);

  // 1. An explicit label ("Company: Acme Labs").
  for (const line of lines) {
    const m = line.match(/^(?:company|organi[sz]ation|employer|firm|client)(?:\s+name)?\s*[:\-–]\s*(.+)$/i);
    if (m && plausibleName(m[1])) return cleanName(m[1]);
  }

  // 2. The phrases recruiters actually write. "<X> is hiring", "hiring at <X>",
  //    and on LinkedIn the poster's headline: "Talent Acquisition at <X>".
  for (const line of lines) {
    const patterns = [
      /^(.{2,60}?)\s+is\s+(?:urgently\s+)?(?:hiring|looking\s+for|recruiting)/i,
      /\b(?:hiring|opening|openings|vacancy|position|role|opportunity|we|working)\s+(?:for\s+|at\s+|@\s*)([A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*){0,4})/,
      /\b(?:at|@)\s+([A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*){0,4})\s*[.!|,]?\s*$/,
    ];
    for (const re of patterns) {
      const m = line.match(re);
      if (m && plausibleName(m[1])) return cleanName(m[1]);
    }
  }

  // 3. A line that is just a company name, recognised by its legal/industry
  //    suffix ("Acme Infotech Pvt Ltd").
  for (const line of lines) {
    const candidate = cleanName(line);
    if (CORP_SUFFIX.test(candidate) && plausibleName(candidate)) return candidate;
  }

  // 4. Last resort: the mail domain. Only works for company-hosted mailboxes,
  //    which is exactly the case where it is reliable.
  for (const email of emails) {
    const fromDomain = nameFromDomain(email.split('@')[1] || '');
    if (fromDomain && plausibleName(fromDomain)) return fromDomain;
  }

  return null;
}

/** Mirror of functions/lib/slug.js so our in-extension dedupe key matches the
 *  row id the API will generate — two blocks about one company must merge here
 *  rather than race each other's INSERT ... DO NOTHING on the server. */
function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** note[] is for the human who later reads the row: the raw text we matched on,
 *  so they can sanity-check the parse before contacting anyone. */
function snippet(block) {
  const flat = block.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? flat.slice(0, 197) + '...' : flat;
}

const mergeInto = (target, values) => {
  for (const v of values) if (!target.includes(v)) target.push(v);
};

/** blocks -> the API's company shape. Returns every candidate we could name and
 *  reach, plus how many had no city (those can't be sent). */
function buildCompanies(blocks, scrapedFrom) {
  const byId = new Map();

  for (const block of blocks) {
    const emails = extractEmails(block);
    const phones = extractPhones(block);
    // A name with no contact route is useless to this tool — a row you can't
    // email or WhatsApp is just noise in the dashboard.
    if (!emails.length && !phones.length) continue;

    const name = guessName(block, emails);
    if (!name) continue;

    const tab = classifyLocation(locationText(block));
    const key = `${tab || '?'}:${slugify(name)}`;
    const hr = emails.filter(isHrEmail);
    const em = emails.filter((e) => !isHrEmail(e));

    const existing = byId.get(key);
    if (existing) {
      mergeInto(existing.hr, hr);
      mergeInto(existing.em, em);
      mergeInto(existing.wa, phones);
      continue;
    }
    byId.set(key, {
      name,
      tab,
      // section omitted on purpose — the API derives it from hr/wa/job_url.
      hr,
      em,
      wa: phones,
      note: snippet(block),
      source: 'extension',
      scraped_from: scrapedFrom,
    });
  }

  const all = [...byId.values()];
  const companies = all.filter((c) => c.tab);
  return { found: all.length, noCity: all.length - companies.length, companies };
}

// ─────────────────────────────────────────────────────────────
// Injected into the job-board page
// ─────────────────────────────────────────────────────────────

/** Runs IN the page (so it inherits your logged-in session and sees only what is
 *  rendered for you). Returns an array of text blocks.
 *
 *  It anchors on the contact rather than on per-site CSS selectors: every board
 *  has a different DOM and reshuffles it constantly, but "the smallest box that
 *  contains this email address" is a decent stand-in for "one job post"
 *  everywhere, and a post with no contact is one we would discard anyway.
 *
 *  Must be self-contained — executeScript serialises the function, so nothing
 *  from module scope is available in here. */
async function pageCollect(autoScroll) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CONTACT = /[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}|(?:\+?91[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}/i;
  const root = document.querySelector('main') || document.body;
  const blocks = new Map(); // first 160 chars -> block, so repeat harvests dedupe
  const MAX_BLOCKS = 300;

  const harvest = () => {
    // Text nodes first: testing nodeValue is cheap, while innerText forces a
    // layout. On a long LinkedIn feed the difference is seconds per pass.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (blocks.size >= MAX_BLOCKS) return;
      const raw = walker.currentNode.nodeValue || '';
      if (raw.length > 400 || !CONTACT.test(raw)) continue;

      let node = walker.currentNode.parentElement;
      if (!node) continue;
      let text = node.innerText || '';
      if (!text) continue; // innerText is empty for hidden nodes: not rendered, skip

      // Climb until the block is big enough to also carry the company name and
      // location, but stop before we swallow the whole feed.
      while (node.parentElement && node.parentElement !== document.body) {
        const parentText = node.parentElement.innerText || '';
        if (parentText.length > 4000) break;
        node = node.parentElement;
        text = parentText;
        if (text.length >= 400) break;
      }

      const key = text.slice(0, 160);
      if (!blocks.has(key)) blocks.set(key, text);
    }
  };

  if (!autoScroll) {
    harvest();
    return [...blocks.values()];
  }

  // Scroll slowly with randomised pauses, harvesting as we go, until the page
  // stops growing (nothing left to lazy-load) or the hard cap trips. The pauses
  // are what keep this looking like a person reading rather than a crawler.
  const MAX_STEPS = 40; // safety cap, ~1-2 min worst case
  let lastHeight = 0;
  let stable = 0;
  for (let i = 0; i < MAX_STEPS; i++) {
    harvest();
    window.scrollBy(0, Math.round(window.innerHeight * 0.85));
    await sleep(700 + Math.random() * 900);
    const h = document.body.scrollHeight;
    if (h <= lastHeight) {
      if (++stable >= 3) break; // nothing new loaded 3x in a row -> done
    } else {
      stable = 0;
      lastHeight = h;
    }
  }
  harvest();
  return [...blocks.values()];
}

/** Runs in the MAIN world of a dashboard tab — see postBulkViaTab() for why.
 *  Relative URL on purpose: it must be the page's own origin. */
function pagePostBulk(companies) {
  return fetch('/api/companies/bulk', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ companies }),
  })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }))
    .catch((e) => ({ status: 0, error: String(e && e.message ? e.message : e) }));
}

// ─────────────────────────────────────────────────────────────
// Talking to the dashboard
// ─────────────────────────────────────────────────────────────

/** POST /api/login. The dashboard has no token auth — since it went
 *  multi-tenant the credential is a per-user email plus passphrase, and a JSON
 *  request is answered with a 200 and a JSON body (the browser's own form still
 *  gets the 302). Either way the session arrives as an HttpOnly, Secure,
 *  SameSite=Strict `session` cookie, so there is nothing for us to read or
 *  store; we can only ask Chrome to send the cookie back for us
 *  (credentials: "include"). */
async function login(base, email, password) {
  let res;
  try {
    res = await fetch(`${base}/api/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      // "manual" leaves a redirect unfollowed: following it would download the
      // whole dashboard just to learn we succeeded. Chrome still stores the
      // Set-Cookie, and wrong credentials still arrive as a readable 401.
      redirect: 'manual',
    });
  } catch (e) {
    return { error: `Could not reach ${base} (${e && e.message ? e.message : e}).` };
  }

  if (res.status === 401) {
    // The API deliberately returns one message for an unknown address and for a
    // bad passphrase, so the extension cannot be used to test whether an account
    // exists. Echoing its wording keeps the two surfaces from ever disagreeing;
    // the literal is only the floor for a deployment that sends no body.
    const body = await res.json().catch(() => ({}));
    return { error: body.error || 'Wrong email or passphrase.' };
  }

  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    // The account is still on the SITE_PASSWORD bootstrap and has no passphrase
    // of its own yet. Only the dashboard can set one, so this is carried back to
    // the popup as something to tell the user rather than acted on here.
    return { ok: true, mustSetPassword: !!body.must_set_password };
  }

  // A dashboard deployed before the JSON reply existed answers with a 302, which
  // an unfollowed redirect surfaces as type "opaqueredirect" with status 0. One
  // extra condition means a stale deployment degrades instead of hard-failing.
  if (res.type === 'opaqueredirect' || res.status === 0 || res.status === 302) {
    return { ok: true, mustSetPassword: false };
  }

  return { error: `Unexpected reply from ${base}: HTTP ${res.status}. Is that the dashboard URL?` };
}

/** Can the session cookie actually reach the API from the extension's own
 *  origin? SameSite=Strict lets Chrome refuse to attach it to a request whose
 *  initiator is chrome-extension://…, and whether it does depends on the Chrome
 *  version. Probing right after login means the popup can warn now instead of
 *  the user discovering it mid-grab. */
async function probeSession(base) {
  try {
    // ?tab= a value no company can have, so the reply is an empty array rather
    // than the whole table — we only care about 401 vs 200.
    const res = await fetch(`${base}/api/companies?tab=__probe`, { credentials: 'include' });
    return res.status !== 401;
  } catch {
    return false;
  }
}

async function postBulk(base, companies) {
  let res;
  try {
    res = await fetch(`${base}/api/companies/bulk`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companies }),
    });
  } catch (e) {
    return { error: `Could not reach ${base} (${e && e.message ? e.message : e}).` };
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** Fallback for the SameSite=Strict case: post through a tab that is already on
 *  the dashboard. A fetch from that page is same-site by definition, so Chrome
 *  attaches the HttpOnly cookie. world: "MAIN" matters — an isolated content
 *  script's requests are attributed to the extension, which is the very thing
 *  we are working around. */
async function postBulkViaTab(base, companies) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: `${base}/*` });
  } catch {}
  const tab = tabs.find((t) => t.status === 'complete') || tabs[0];
  if (!tab) {
    return {
      error: `Chrome would not send your session cookie from the extension (the dashboard sets it SameSite=Strict). Open ${base} in a tab, sign in there, leave it open, then press the button again.`,
    };
  }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: pagePostBulk,
      args: [companies],
    });
    if (!result) return { error: 'The dashboard tab did not answer. Reload it and try again.' };
    if (result.status === 401) {
      return { error: `The dashboard tab is signed out. Open ${base}, sign in there, then try again.` };
    }
    if (result.status !== 200) {
      return { error: `Dashboard replied HTTP ${result.status}${result.error ? ` (${result.error})` : ''}.` };
    }
    return { status: 200, data: result.data || {} };
  } catch (e) {
    return { error: `Could not use the dashboard tab (${e && e.message ? e.message : e}).` };
  }
}

/** Send every company, chunked. Escalates through three ways of getting the
 *  cookie attached before giving up with an actionable message. */
async function submit(base, companies, email, passphrase) {
  let submitted = 0;
  let skipped = 0;

  for (let i = 0; i < companies.length; i += CHUNK) {
    const chunk = companies.slice(i, i + CHUNK);

    let res = await postBulk(base, chunk);
    if (res.error) return { error: res.error };

    if (res.status === 401 && email && passphrase) {
      // Most likely the 30-day session simply expired: sign in and retry once.
      const relogin = await login(base, email, passphrase);
      if (relogin.error) return { error: relogin.error };
      res = await postBulk(base, chunk);
      if (res.error) return { error: res.error };
    }

    if (res.status === 401) {
      // Login worked but the cookie still isn't reaching the API from here.
      res = await postBulkViaTab(base, chunk);
      if (res.error) return { error: res.error };
    }

    if (res.status !== 200) {
      return { error: `Dashboard replied HTTP ${res.status}${res.data && res.data.error ? `: ${res.data.error}` : ''}.` };
    }
    submitted += Number(res.data.submitted) || 0;
    skipped += Number(res.data.skipped) || 0;
  }

  return { submitted, skipped };
}

// ─────────────────────────────────────────────────────────────
// The grab
// ─────────────────────────────────────────────────────────────

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function runGrab(autoScroll) {
  const { serverUrl, email, passphrase } = await get(['serverUrl', 'email', 'passphrase']);
  const base = trimBase(serverUrl);
  if (!passphrase) return { error: 'Sign in again to keep grabbing.', needLogin: true };
  // An install carried over from before the dashboard went multi-tenant has a
  // passphrase but no email, and the API will not take one without the other.
  // Saying so here beats letting the grab run and die on a 401 it cannot explain.
  if (!email) {
    return { error: 'The dashboard now signs you in by email. Add yours to keep grabbing.', needLogin: true };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // tab.url is only readable for hosts we hold permission for, so an undefined
  // url means "not a supported board" just as reliably as a non-matching one.
  if (!tab || !SUPPORTED.test(tab.url || '')) {
    return { error: 'Open LinkedIn, Naukri, Wellfound, Internshala or Indeed first, then press this again.' };
  }

  badge('..');
  let blocks;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageCollect,
      args: [!!autoScroll],
    });
    blocks = Array.isArray(result) ? result : [];
  } catch (e) {
    badge('');
    return { error: `Could not read the page (${e && e.message ? e.message : e}). Reload the tab and try again.` };
  }

  if (!blocks.length) {
    badge('');
    return { found: 0, sent: 0, saved: 0, skipped: 0, noCity: 0 };
  }

  const { companies, found, noCity } = buildCompanies(blocks, hostOf(tab.url));
  if (!companies.length) {
    badge('');
    return { found, sent: 0, saved: 0, skipped: 0, noCity };
  }

  const res = await submit(base, companies, email, passphrase);
  if (res.error) {
    badge('');
    return { error: res.error, found, sent: 0 };
  }

  const saved = Math.max(0, res.submitted - res.skipped);
  badge(saved || '');
  return { found, sent: companies.length, saved, skipped: res.skipped, noCity };
}

/** The auto-scroll grab outlives the popup, so the popup's sendResponse may
 *  never be heard. Recording "running" and the finished result in storage lets a
 *  reopened popup pick the answer up instead of showing a blank screen. */
async function trackedGrab(autoScroll) {
  await set({ running: true, runningAuto: !!autoScroll });
  try {
    const result = await runGrab(autoScroll);
    await set({ lastResult: result, lastResultAt: Date.now() });
    return result;
  } finally {
    await set({ running: false });
  }
}

// ─────────────────────────────────────────────────────────────
// Messages from the popup
// ─────────────────────────────────────────────────────────────

const HANDLERS = {
  async login(msg) {
    const base = trimBase(msg.serverUrl);
    // Trimmed because the address is retyped by hand here rather than picked
    // from a browser autofill, and the API matches on lower(email) anyway.
    const email = String(msg.email || '').trim();
    const passphrase = String(msg.passphrase || '');
    if (!email) return { error: 'Enter the email you sign in to the dashboard with.' };
    if (!passphrase) return { error: 'Enter your passphrase.' };

    const res = await login(base, email, passphrase);
    if (res.error) return res;

    // Remembered so the grab can re-login by itself when the session lapses —
    // there is no token to keep, the cookie is HttpOnly and unreadable from here.
    await set({ serverUrl: base, email, passphrase });
    const cookieReachesApi = await probeSession(base);
    return { ok: true, cookieReachesApi, mustSetPassword: !!res.mustSetPassword };
  },

  async logout() {
    // Only the passphrase is the secret. The email is left behind for the same
    // reason serverUrl always has been: it is what you would have to retype, and
    // erasing it buys no privacy the passphrase's removal has not already bought.
    await set({ passphrase: null, lastResult: null });
    badge('');
    return { ok: true };
  },

  async status() {
    const stored = await get(['serverUrl', 'email', 'passphrase', 'lastResult', 'running', 'runningAuto']);
    return {
      serverUrl: trimBase(stored.serverUrl),
      email: stored.email || '',
      signedIn: !!(stored.passphrase && stored.email),
      // True only for an install upgraded from the single-password dashboard: the
      // passphrase survived but has nothing to pair with. The popup uses it to
      // explain why it is asking again instead of showing a bare login form.
      needsEmail: !!stored.passphrase && !stored.email,
      lastResult: stored.lastResult || null,
      running: !!stored.running,
      runningAuto: !!stored.runningAuto,
    };
  },

  grab: () => trackedGrab(false),
  autograb: () => trackedGrab(true),

  clearBadge() {
    badge('');
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg && msg.type];
  if (!handler) return;
  Promise.resolve(handler(msg))
    .then(sendResponse)
    .catch((e) => sendResponse({ error: (e && e.message) || 'Something went wrong.' }));
  return true; // keep the channel open for the async reply
});
