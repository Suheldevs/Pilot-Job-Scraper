/** Fallback for Android's share sheet (manifest share_target → POST /share-target).
 *
 *  Normally sw.js answers this POST itself: it keeps the shared screenshots and
 *  opens the Add screen to read them. If the service worker is not running yet —
 *  the very first launch after installing, or storage cleared — the POST reaches
 *  the server instead, and without this route it would end on an error page.
 *  Files cannot be parked here, so this opens the Add screen with a note asking
 *  to share once more (by then the service worker is up).
 */
export async function onRequestPost() {
  return new Response(null, { status: 303, headers: { Location: "/?view=add&shared=retry" } });
}

export async function onRequestGet() {
  return new Response(null, { status: 303, headers: { Location: "/?view=add" } });
}
