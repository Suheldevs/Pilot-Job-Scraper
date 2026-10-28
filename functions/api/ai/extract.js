/** Read job openings out of screenshots, pasted text or a link.
 *
 *  POST /api/ai/extract { images?: [{ mime, data }], text?: string, url?: string }
 *    images — base64 (no data: prefix), already shrunk by the browser to ~1600px
 *    text   — anything pasted or shared alongside (a post's text, a JD)
 *    url    — a shared link; a public LinkedIn post is read for its full text
 *             (LinkedIn serves those without a login, with the body in JSON-LD),
 *             any other page is fetched and stripped to text
 *  → { items: [{ company, role, tab, location, hr, em, wa, li, job_url, experience, note }] }
 *
 *  Nothing is saved here. The dashboard shows the result for a one-tap save —
 *  a model reading a blurry screenshot can misspell a name or an address, and a
 *  wrong lead saved silently is one auto-apply could then email.
 */
import { json, badRequest } from "../../lib/db.js";
import { callGemini, geminiErrorResponse, hasKey, missingKeyError } from "../../lib/gemini.js";

const MAX_IMAGES = 6;
const MAX_IMAGE_B64 = 4_000_000;          // ~3 MB of image per screenshot after base64
const TABS = ["blr", "pune", "lko", "noida", "rem"];

const SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string",
      description: "Every piece of text visible in the images, copied verbatim, top to bottom. Write this FIRST." },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string", description: "Hiring company's name exactly as shown. Empty if not shown." },
          role: { type: "string", description: "Job title, e.g. 'Full Stack Developer'." },
          location: { type: "string", description: "Location as written, e.g. 'Noida, Sector 62' or 'Remote'." },
          city: { type: "string", enum: ["blr", "pune", "lko", "noida", "rem", "other"],
                  description: "blr=Bangalore/Bengaluru, pune=Pune, lko=Lucknow, noida=Noida/Delhi NCR/Gurgaon/Ghaziabad, rem=Remote/WFH, other=anything else or unknown." },
          city_name: { type: "string", description: "Just the city's name, e.g. 'Hyderabad' (not the area or state). Empty if not shown." },
          hr_emails: { type: "array", items: { type: "string" }, description: "Emails to send a CV/resume to." },
          other_emails: { type: "array", items: { type: "string" }, description: "Any other emails shown." },
          phones: { type: "array", items: { type: "string" }, description: "Phone / WhatsApp numbers, digits only with country code if shown." },
          linkedin: { type: "string", description: "Company LinkedIn URL or handle if shown." },
          job_url: { type: "string", description: "Apply or job link if shown." },
          experience: { type: "string", description: "Experience asked, e.g. '2-4 years'." },
          note: { type: "string", description: "One short line: stack, salary, work mode or anything useful. No marketing fluff." },
          uncertain: { type: "array", items: { type: "string",
            enum: ["company", "role", "location", "city", "hr_emails", "other_emails", "phones", "linkedin", "job_url", "experience"] },
            description: "Fields that were blurry, cut off or ambiguous in the source." },
        },
        required: ["company", "role"],
      },
    },
  },
  required: ["transcript", "items"],
  propertyOrdering: ["transcript", "items"],
};

const PROMPT = `You read job postings for a job seeker. The input is one or more screenshots and/or text of
LinkedIn posts, job boards, WhatsApp forwards, careers pages or hiring images.

First write "transcript": all visible text, verbatim. Then return every distinct job opening. Rules:
- Take every field from the transcript. Copy emails, phone numbers and links EXACTLY, character for
  character; never guess, complete or "correct" one. If any character is unreadable, still copy what
  you can see and list that field in "uncertain".
- The company is the employer named in the post (logo text, "at X", "X is hiring", company page name),
  not the job board or the person who shared it.
- If the poster is a recruiter or consultancy hiring for a client, use the client's name when it is shown.
- One opening per item; a post listing several roles at one company gives several items.
- Skip ads, course promotions and "open to work" posts — those are not openings. If nothing is an opening, return an empty list.`;

function cleanEmails(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const e = String(raw).trim().toLowerCase().replace(/^mailto:/, "");
    if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

function cleanPhones(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    let d = String(raw).replace(/\D/g, "");
    if (d.length === 10 && /^[6-9]/.test(d)) d = "91" + d;   // bare Indian mobile
    if (d.length >= 11 && d.length <= 15 && !out.includes(d)) out.push(d);
  }
  return out;
}

async function readUrl(url) {
  let u;
  try { u = new URL(url); } catch { return ""; }
  if (!/^https?:$/.test(u.protocol)) return "";
  const res = await fetch(u.href, {
    headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
               "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow",
  }).catch(() => null);
  if (!res || !res.ok) return "";
  const html = (await res.text()).slice(0, 600_000);
  if (/linkedin\.com\/(posts|feed\/update)/.test(res.url || u.href)) {
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try {
        const d = JSON.parse(m[1]);
        if (d && d.articleBody) {
          const author = d.author && d.author.name ? `Posted by ${d.author.name}${d.author["@type"] === "Organization" ? " (company page)" : ""}.\n` : "";
          return author + d.articleBody;
        }
      } catch { /* try the next block */ }
    }
  }
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").slice(0, 15_000);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!hasKey(env)) return geminiErrorResponse(missingKeyError());
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("invalid JSON body");

  const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)
    .filter((i) => i && /^image\/(png|jpe?g|webp|heic|heif)$/.test(i.mime) && typeof i.data === "string" && i.data.length <= MAX_IMAGE_B64);
  let text = typeof body.text === "string" ? body.text.slice(0, 20_000) : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  // Android often shares a link inside the text rather than as `url`.
  const linkInText = !url && (text.match(/https?:\/\/\S+/) || [])[0];
  const link = url || linkInText || "";
  if (link) {
    const page = await readUrl(link);
    if (page) text = `${text}\n\nContent of ${link}:\n${page}`;
  }
  if (!images.length && !text.trim()) return badRequest("send at least one screenshot, some text or a link");

  const parts = [{ text: PROMPT + (text.trim() ? `\n\nText provided:\n${text}` : "") }];
  for (const img of images) parts.push({ inline_data: { mime_type: img.mime, data: img.data } });

  let out;
  try {
    out = await callGemini(env, { parts, schema: SCHEMA, temperature: 0, timeoutMs: 90_000,
                                  maxOutputTokens: 8192, thinkingLevel: "medium" });
  } catch (err) {
    return geminiErrorResponse(err);
  }

  // Anti-invention check: a contact only survives if it is literally in what the
  // model read (its own verbatim transcript) or in the text we sent. An address
  // it "completed" or "corrected" will not be in either, and is dropped — a
  // wrong email that auto-apply then writes to is worse than none.
  const source = `${(out.json && out.json.transcript) || ""}
${text}`;
  const flat = source.toLowerCase().replace(/\s+/g, "");
  const digits = source.replace(/\D/g, "");
  const seenEmail = (e) => flat.includes(e.toLowerCase());
  const seenPhone = (p) => digits.includes(p.slice(-10));
  let dropped = 0;

  const items = (out.json && Array.isArray(out.json.items) ? out.json.items : []).slice(0, 25).map((it) => {
    const cityName = String(it.city_name || "").trim().slice(0, 60);
    // A city outside the five tabs lands in "Other" with its name, rather than
    // being forced into whatever city the form happens to have selected.
    const tab = TABS.includes(it.city) ? it.city : (it.city === "other" && cityName ? "oth" : "");
    const keepE = (list) => { const k = cleanEmails(list); const ok = k.filter(seenEmail); dropped += k.length - ok.length; return ok; };
    const hr = keepE(it.hr_emails);
    const em = keepE(it.other_emails).filter((e) => !hr.includes(e));
    const phones = cleanPhones(it.phones);
    const wa = phones.filter(seenPhone);
    dropped += phones.length - wa.length;
    const unsure = Array.isArray(it.uncertain) ? it.uncertain.filter((f) => typeof f === "string") : [];
    return {
      company: String(it.company || "").trim().slice(0, 120),
      role: String(it.role || "").trim().slice(0, 160),
      tab,
      city: tab === "oth" ? cityName : "",
      location: String(it.location || "").trim().slice(0, 120),
      hr, em,
      wa,
      uncertain: unsure,
      li: String(it.linkedin || "").trim().slice(0, 200),
      job_url: /^https?:\/\//.test(String(it.job_url || "")) ? String(it.job_url).trim().slice(0, 500)
             : (link && /linkedin\.com\/(posts|feed)/.test(link) ? link : ""),
      experience: String(it.experience || "").trim().slice(0, 60),
      note: String(it.note || "").trim().slice(0, 300),
    };
  }).filter((it) => it.company || it.role);

  return json({ items, dropped, model: out.model });
}
