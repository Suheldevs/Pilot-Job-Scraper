/** Web Push from a Worker, with nothing but WebCrypto.
 *
 *  The usual `web-push` npm package needs Node's crypto and will not run on
 *  Cloudflare, so this implements the two RFCs it wraps:
 *    - RFC 8291 — message encryption (ECDH P-256 + HKDF + AES-128-GCM, the
 *      "aes128gcm" content coding), so only the subscribed browser can read it;
 *    - RFC 8292 — VAPID, an ES256-signed JWT proving the push comes from us.
 *
 *  Keys live in Pages secrets: VAPID_PUBLIC_KEY (65-byte uncompressed point,
 *  base64url), VAPID_PRIVATE_KEY (the 32-byte `d`, base64url), VAPID_SUBJECT
 *  (a mailto: the push services can contact). `encrypt` takes an optional
 *  fixed sender key and salt only so the RFC 8291 test vector can be checked.
 */
const enc = new TextEncoder();

export function b64uToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64u(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** P-256 private key from its raw `d` plus the matching uncompressed public point. */
async function importPrivate(dB64u, publicBytes, usage) {
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    x: bytesToB64u(publicBytes.slice(1, 33)),
    y: bytesToB64u(publicBytes.slice(33, 65)),
    d: dB64u,
  };
  const alg = usage === "sign" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "ECDH", namedCurve: "P-256" };
  return crypto.subtle.importKey("jwk", jwk, alg, false, usage === "sign" ? ["sign"] : ["deriveBits"]);
}

/** RFC 8291 aes128gcm body for one subscription. */
export async function encrypt(sub, plaintext, testing = null) {
  const uaPublic = b64uToBytes(sub.p256dh);
  const authSecret = b64uToBytes(sub.auth);

  let asPublic, asPrivate;
  if (testing) {
    asPublic = b64uToBytes(testing.asPublic);
    asPrivate = await importPrivate(testing.asPrivate, asPublic, "derive");
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    asPrivate = pair.privateKey;
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));

  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = testing ? b64uToBytes(testing.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const record = concat(typeof plaintext === "string" ? enc.encode(plaintext) : plaintext, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));

  // header: salt(16) | record size(4, big-endian 4096) | key id length(1) | sender public key
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic, ct);
}

/** RFC 8292 VAPID JWT for the push service that owns `endpoint`. */
export async function vapidJwt(endpoint, subject, publicB64u, privateB64u) {
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await importPrivate(privateB64u, b64uToBytes(publicB64u), "sign");
  // WebCrypto's ECDSA output is already the raw r||s form JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${bytesToB64u(sig)}`;
}

/** Send one push. Returns the push service's HTTP status (201 = accepted;
 *  404/410 = the subscription is gone and should be deleted). */
export async function sendPush(env, sub, data, { urgent = false } = {}) {
  const body = await encrypt(sub, JSON.stringify(data));
  const jwt = await vapidJwt(sub.endpoint, env.VAPID_SUBJECT || "mailto:pilot@example.com",
                             env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: urgent ? "high" : "normal",
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body,
  });
  return res.status;
}
