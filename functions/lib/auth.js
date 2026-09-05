/** HMAC-signed session tokens — no session storage needed, just a secret.
 *
 *  The payload carries the signed-in user's id as well as the expiry. Before
 *  multi-tenancy it was `{exp}` alone: one shared passphrase opened the site and
 *  there was nobody to identify. Now `resolveProfileId` refuses a profile the
 *  caller does not own, and the only trustworthy source for "who is the caller"
 *  is this token — it is HMAC-signed, so a `uid` claim inside it cannot be
 *  forged by the browser holding it.
 *
 *  The payload also carries `ep`, the user's `session_epoch` at the moment the
 *  token was minted. Bumping that column signs the user out everywhere without
 *  rotating SESSION_SECRET, which would sign out everyone. See migration 010.
 *
 *  `verifySession` returns the PAYLOAD (or null), not a boolean. That is a
 *  deliberate breaking change: a caller that just wants a yes/no still reads
 *  correctly as truthy/falsy, but a caller that needs the user id cannot get it
 *  from a boolean, and having two functions parse the same token twice is how
 *  the two drift apart.
 */

async function importKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function b64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Mint a session for one user at their current `session_epoch`. */
export async function signSession(secret, uid, epoch = 0, days = 30) {
  const id = Number(uid);
  if (!Number.isInteger(id) || id < 1) {
    // A session with no subject is exactly the pre-multi-tenancy token this
    // module exists to stop accepting, so it must not be mintable either.
    throw new Error("signSession requires a positive integer user id");
  }
  const ep = Number(epoch) || 0;
  const exp = Date.now() + days * 86400000;
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ uid: id, ep, exp }));
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${b64url(payloadBytes)}.${b64url(sig)}`;
}

/** Verify a session token.
 *
 *  Returns `{ uid, ep, exp }` on success, `null` on any failure.
 *
 *  A token whose signature is good but which carries no `uid` is REJECTED. Those
 *  are the sessions minted before this migration, when one passphrase opened
 *  everything. Honouring them would mean a cookie issued under the old rules
 *  kept ambient access to every profile under the new ones, which is the whole
 *  hole being closed — so the upgrade deliberately signs everyone out once.
 */
export async function verifySession(secret, token) {
  if (!secret || !token || !token.includes(".")) return null;
  const [p, s] = token.split(".");
  try {
    const payloadBytes = b64urlToBytes(p);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!payload || typeof payload !== "object") return null;
    if (!payload.exp || Date.now() > payload.exp) return null;

    const uid = Number(payload.uid);
    if (!Number.isInteger(uid) || uid < 1) return null;

    const key = await importKey(secret);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(s), payloadBytes);
    // `ep` is returned but NOT judged here: this function only knows what the
    // token claims, and whether that epoch is still current is a fact about the
    // `users` row. _middleware.js already loads that row and does the compare.
    return ok ? { uid, ep: Number(payload.ep) || 0, exp: payload.exp } : null;
  } catch {
    return null;
  }
}

export function parseCookie(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
