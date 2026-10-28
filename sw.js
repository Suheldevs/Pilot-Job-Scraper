/* Pilot service worker — makes the dashboard installable and readable offline.
 *
 * Everything is NETWORK-FIRST. Online, every request goes to the server exactly
 * as it did before this file existed, so the web app never sees stale code or
 * stale data. The cache is only a fallback for when the network fails.
 *
 * What is kept, and for how long:
 *   SHELL — the offline page, manifest and icons. Not user data.
 *   DATA  — the dashboard page and the last good answer to every GET /api/*.
 *           This IS the signed-in user's data, so it is wiped on sign-out, on
 *           any 401 and whenever the server hands back the login page — the
 *           next person to sign in on this device must never see it.
 *   FONTS — Google Fonts, cache-first (they never change for a given URL).
 *
 * Writes (PUT/POST/PATCH/DELETE) are never touched: offline they fail, and the
 * dashboard says so. Nothing is queued to replay later.
 */
const SHELL = "pilot-shell-v5";
// Shown in the dashboard's notification panel, so you can tell which copy of
// this file your phone is actually running.
const SW_VERSION = "5";
const DATA = "pilot-data-v1";
const FONTS = "pilot-fonts-v1";
const SHELL_FILES = [
  "/offline",   // Pages serves offline.html here; the .html URL 308s, and a redirected
                 // response cannot answer a navigation
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  const keep = [SHELL, DATA, FONTS];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const clearData = () => caches.delete(DATA);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    if (req.method === "GET") event.respondWith(cacheFirst(req, FONTS));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Sign-out wipes this user's saved data even if the request itself fails.
  if (url.pathname === "/api/logout") {
    event.respondWith(clearData().then(() => fetch(req)).catch(offlinePage));
    return;
  }
  // Android's share sheet POSTs here (manifest share_target). The files are
  // parked in a cache and the app opens on the Add screen to read them.
  if (url.pathname === "/share-target" && req.method === "POST") {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== "GET" || url.pathname === "/api/login") return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(apiNetworkFirst(req));
  } else if (req.mode === "navigate") {
    event.respondWith(pageNetworkFirst(req, url));
  } else if (SHELL_FILES.includes(url.pathname)) {
    event.respondWith(cacheFirst(req, SHELL));
  }
});

async function apiNetworkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.status === 401) {
      await clearData();
    } else if (res.ok) {
      // Stamp when it was saved so the dashboard can say how old offline data is.
      const headers = new Headers(res.headers);
      headers.set("x-pilot-saved-at", String(Date.now()));
      const copy = new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
      await (await caches.open(DATA)).put(req, copy);
    }
    return res;
  } catch {
    const cached = await caches.match(req, { cacheName: DATA });
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "You're offline, and this hasn't been saved on this device yet." }), {
      status: 503,
      headers: { "content-type": "application/json", "x-pilot-offline": "1" },
    });
  }
}

async function pageNetworkFirst(req, url) {
  try {
    const res = await fetch(req);
    if (url.pathname === "/" && res.ok) {
      // Unauthenticated, "/" answers 200 with the login page. That must never be
      // cached as the app, and it means the session is gone — so drop the data.
      const text = await res.clone().text();
      if (text.includes('name="pilot-app"')) await (await caches.open(DATA)).put("/", res.clone());
      else await clearData();
    }
    return res;
  } catch {
    if (url.pathname === "/") {
      const cached = await caches.match("/", { cacheName: DATA });
      if (cached) return cached;
    }
    return offlinePage();
  }
}

async function offlinePage() {
  return (await caches.match("/offline", { cacheName: SHELL })) ||
    new Response("You're offline.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req, { cacheName });
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") await (await caches.open(cacheName)).put(req, res.clone());
  return res;
}

/* ---- phone notifications ------------------------------------------------
 * The server (functions/lib/notify.js) pushes { title, body, url, kind, tag }.
 * Replies and errors stay on screen until dismissed; the rest auto-collapse
 * into the shade like any app's. Tapping one focuses an open Pilot window, or
 * opens one, on the notification's url. */
/* How each kind looks on the phone. Replies and errors stay on screen until
   dismissed and vibrate; a finished scrape arrives silently. The status-bar badge
   is a white silhouette (Android paints it in one colour; a full-colour icon
   there shows up as a plain white square). */
const KIND = {
  reply:   { emoji: "🎉", view: "pipeline",  sticky: true,  silent: false, actions: [["gmail", "Open Gmail"], ["open", "Open Pilot"]] },
  applied: { emoji: "✉️", view: "pipeline",  sticky: false, silent: false, actions: [["open", "Open Pilot"]] },
  scrape:  { emoji: "🔎", view: "overview",  sticky: false, silent: true,  actions: [["open", "Open Pilot"]] },
  summary: { emoji: "📊", view: "overview",  sticky: false, silent: false, actions: [["open", "Open Pilot"]] },
  error:   { emoji: "⚠️", view: "data",      sticky: true,  silent: false, actions: [["open", "Open Pilot"]] },
  // Morning nudge for leads only a human can contact (WhatsApp, LinkedIn, a job
  // link). Sticky on purpose: it stays until tapped or swiped.
  reminder:{ emoji: "📝", view: "pipeline",  sticky: true,  silent: false, actions: [["open", "Apply now"]] },
  info:    { emoji: "🔔", view: "overview",  sticky: false, silent: false, actions: [["open", "Open Pilot"]] },
};

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Pilot", body: event.data && event.data.text() }; }
  const k = KIND[data.kind] || KIND.info;
  const title = data.title || "Pilot";
  // Open the screen the event is about unless the sender named a page itself.
  const url = data.url && data.url !== "/" ? data.url : "/?view=" + k.view;
  event.waitUntil(self.registration.showNotification(
    k.emoji && !title.startsWith(k.emoji) ? `${k.emoji} ${title}` : title, {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: data.tag || undefined,
    timestamp: Date.now(),
    data: { url },
    requireInteraction: k.sticky,
    silent: k.silent,
    vibrate: k.sticky ? [120, 60, 120] : undefined,
    actions: k.actions.map(([action, t]) => ({ action, title: t })),
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "gmail") {
    event.waitUntil(self.clients.openWindow("https://mail.google.com/mail/u/0/#inbox"));
    return;
  }
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        if ("navigate" in w) await w.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

const SHARE = "pilot-share";
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const cache = await caches.open(SHARE);
    for (const key of await cache.keys()) await cache.delete(key);   // one share at a time
    const files = form.getAll("images").filter((f) => f && typeof f !== "string").slice(0, 6);
    await Promise.all(files.map((f, i) =>
      cache.put(`/shared/${i}`, new Response(f, { headers: { "content-type": f.type || "image/jpeg" } }))));
    await cache.put("/shared/meta", new Response(JSON.stringify({
      count: files.length,
      title: String(form.get("title") || ""), text: String(form.get("text") || ""), url: String(form.get("url") || ""),
    }), { headers: { "content-type": "application/json" } }));
  } catch { /* the app will just open on Add with nothing preloaded */ }
  return Response.redirect("/?view=add&shared=1", 303);
}

self.addEventListener("message", (event) => {
  if (event.data === "version" && event.ports && event.ports[0]) event.ports[0].postMessage(SW_VERSION);
});
