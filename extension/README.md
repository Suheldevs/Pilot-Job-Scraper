# Pilot — Job Board Grabber (Chrome extension)

One click on a job-board page (**LinkedIn, Naukri, Wellfound, Internshala,
Indeed**) pulls the company names, recruiter **emails** and **phone numbers** out
of the posts on your screen, works out which Pilot tab each belongs to, and
files them into your dashboard through `POST /api/companies/bulk` — the same
endpoint `push.py` uses, with the same "only ever adds, never overwrites" rule.

> ⚠️ It can only capture contacts the recruiter actually typed into the post or
> the JD. A post that hides the contact behind an **Apply** button has nothing
> to grab.

## Why this is the legitimate way to get these emails

The recruiter published the address. You are already signed in, already on the
page, already reading it. This extension does not log in for you, does not open
pages you didn't open, does not run on a timer, and does not touch the network
until **you press a button** — and when you do, it reads the text that is
already rendered in your own browser, exactly what you could have copied by
hand. There is no separate crawl of the site, no API abuse, no credential
sharing. It is a faster clipboard, not a scraper farm.

The **Grab what's on screen** button keeps it that way. **Auto-scroll & grab**
makes the page scroll itself, which is the one behaviour here that a site could
plausibly flag as automated, so it is deliberately the second button: slow, with
randomised human-ish pauses, stopping as soon as the page stops growing, and
hard-capped at 40 scroll steps. Manual grabbing is safer. Use auto-scroll
sparingly.

## Install (1 minute)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this `extension` folder.
5. Pin **Pilot Grabber** to the toolbar.

No build step, no dependencies, nothing to compile.

## Use

1. Click the toolbar icon and sign in with your **dashboard passphrase** (the
   same one the dashboard's sign-in page asks for). The passphrase and the
   dashboard URL are remembered in this browser profile.
2. Go to a supported job board, run your search, and scroll so the posts you
   care about are loaded.
3. Click the icon, then either:
   - **Grab what's on screen** — reads only what is rendered right now.
   - **Auto-scroll & grab** — scrolls and harvests until the page stops growing.
     It runs in the extension's service worker, so you can close the popup;
     reopen it (or watch the toolbar badge) for the result.
4. The popup reports **found / sent / dropped / skipped**, and the badge shows
   how many brand-new rows landed in the dashboard.

## What it sends

For each block of text that contains a contact, it parses out a name, the
emails, the phones and a location, then posts:

```json
{
  "name": "Acme Infotech",
  "tab": "blr",
  "hr": ["careers@acmeinfotech.com"],
  "em": ["ravi@acmeinfotech.com"],
  "wa": ["9876543210"],
  "note": "first ~200 chars of the text it matched on",
  "source": "extension",
  "scraped_from": "linkedin.com"
}
```

- `tab` comes from a JS mirror of `locations.py` — remote wins over any city,
  then Bengaluru / Pune / Lucknow / Noida-NCR, and **anything else is dropped**
  because the API rejects tabs outside `VALID_TABS`.
- `hr` vs `em`: addresses whose local part reads as recruitment (`hr`,
  `career(s)`, `job(s)`, `recruit`, `talent`, `hiring`, `apply`, `resume`, `cv`)
  go in `hr`, everyone else in `em`.
- `wa` takes Indian mobiles only — 10 digits starting 6-9, or 12 starting `91`
  then 6-9 — stored as digits.
- `section` is left out on purpose so the API assigns the contact-quality tier
  itself, exactly as it does for `push.py`.
- A company with **no contact at all is never sent**. A row you cannot email or
  WhatsApp is just noise in the tracker.

## The session-cookie caveat (read this if grabs 401)

The dashboard has no bearer token. `POST /api/login` answers a correct
passphrase with a **302** and a `session` cookie marked `HttpOnly; Secure;
SameSite=Strict`. `HttpOnly` means the extension can never read the cookie, and
`SameSite=Strict` means Chrome may refuse to attach it to a request whose
initiator is `chrome-extension://…` — whether it does depends on the Chrome
version. That is a real limitation of this approach, not something the extension
can fix from its own side.

So it handles all three cases instead of failing silently:

1. Login and the bulk POST both use `credentials: "include"`, with the dashboard
   origin in `host_permissions`. On current Chrome this normally just works.
2. Right after a successful login the extension probes `GET /api/companies`. If
   that comes back **401**, the popup tells you immediately rather than at grab
   time.
3. If a bulk POST 401s, it re-logs in and retries once (a lapsed 30-day
   session), and if it still 401s it **posts through a dashboard tab instead** —
   `chrome.scripting.executeScript` with `world: "MAIN"` running
   `fetch("/api/companies/bulk")` inside the page. A request from that page is
   same-site by definition, so Chrome attaches the cookie.

**The workaround, if you ever see the warning:** keep
`https://pilot-78c.pages.dev` open in a tab and signed in. Grabs are then routed
through it automatically. If no such tab is open, the popup says exactly that
instead of half-failing.

## Settings

- The dashboard URL defaults to `https://pilot-78c.pages.dev`. Point it at
  `http://localhost:8788` for `wrangler pages dev` (both are pre-authorised in
  the manifest); any other URL triggers a one-time Chrome permission prompt.
- The passphrase is kept in `chrome.storage.local` — unavoidable, since the
  session cookie is unreadable and the background grab has to be able to
  re-authenticate on its own. Treat the browser profile as trusted, and sign out
  from the popup to erase it.

## Honest limits

- It reads only what is **rendered**. Collapsed "see more" text and posts you
  haven't scrolled to are not there yet.
- Emails written to dodge scrapers — `name [at] gmail [dot] com`, an address
  split across elements, or one baked into an image — are **not** caught. Plain
  `name@domain.com` is.
- Posts that route applications through an Apply button expose no contact, so
  there is nothing to extract; they are skipped, not guessed at.
- The company name is a **heuristic**: an explicit `Company:` label, then
  phrases like "X is hiring" / "… at X", then a line ending in a legal or
  industry suffix, then the mail domain (`careers@acme-labs.co.in` → "Acme
  Labs"). Free-mail addresses yield no name, so a gmail-only post is skipped
  unless the name appears in the text. Check `note` on a row before you contact
  anyone.
- Anything outside Bengaluru / Pune / Lucknow / Noida-NCR / remote is dropped —
  the tracker has no bucket for it.
- Post segmentation anchors on the contact ("the smallest box containing this
  email"), not on per-site CSS selectors, so it survives site redesigns but can
  occasionally merge two adjacent posts or clip a wide card.
- Unpacked dev extension. Not on the Chrome Web Store, no icons bundled.

## Note for whoever deploys the dashboard

`wrangler.toml` sets `pages_build_output_dir = "."`, so **everything in the repo
root ships as a public asset**. Add a line for this folder to `.assetsignore`
(alongside `sources`) so the extension source isn't served from
`pilot-78c.pages.dev/extension/`.
