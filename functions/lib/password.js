/** Password hashing for the `users` table.
 *
 *  PBKDF2-SHA256, because it is what `crypto.subtle` offers natively on
 *  Workers. bcrypt/argon2 would mean shipping WASM into every request's cold
 *  start, and hand-rolling either is not on the table.
 *
 *  Stored form: `pbkdf2$<iterations>$<salt>$<hash>`, salt and hash base64url.
 *  The iteration count travels WITH the hash rather than being read from a
 *  constant at verify time, so raising ITERATIONS later does not invalidate
 *  every existing password — old hashes keep verifying at the count they were
 *  written with, and `needsRehash` says which ones to upgrade on next login.
 */

/** OWASP's floor for PBKDF2-HMAC-SHA256. Raise freely: see the note above on
 *  why old hashes survive it. */
const ITERATIONS = 600000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

function b64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BITS
  );
}

/** Hash a new password. Returns the full stored form. */
export async function hashPassword(password) {
  const pw = String(password ?? "");
  if (!pw) throw new Error("refusing to hash an empty password");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await derive(pw, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(bits)}`;
}

/** Constant-time byte comparison. `crypto.subtle.verify` does this for us on
 *  the session HMAC, but PBKDF2 gives raw bits and `===` on the base64 would
 *  leak how many leading characters matched. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Verify a password against a stored hash.
 *
 *  An empty or malformed `stored` returns false rather than throwing: migration
 *  010 seeds the parent user with `pw_hash = ''` to mean "no password set yet",
 *  and that value must never verify against anything. The SITE_PASSWORD
 *  fallback for that case lives in the login handler, not here — this function
 *  has exactly one job.
 */
export async function verifyPassword(password, stored) {
  const pw = String(password ?? "");
  const s = String(stored ?? "");
  if (!pw || !s) return false;

  const parts = s.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  try {
    const salt = b64urlToBytes(parts[2]);
    const expected = b64urlToBytes(parts[3]);
    const actual = new Uint8Array(await derive(pw, salt, iterations));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash was written at a lower iteration count than we use
 *  now, so the login handler can transparently re-hash on a successful sign-in. */
export function needsRehash(stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  return Number(parts[1]) < ITERATIONS;
}

/** True when this user has no password set and is therefore eligible for the
 *  SITE_PASSWORD bootstrap fallback. */
export function hasNoPassword(stored) {
  return !String(stored ?? "").trim();
}

export const PBKDF2_ITERATIONS = ITERATIONS;
