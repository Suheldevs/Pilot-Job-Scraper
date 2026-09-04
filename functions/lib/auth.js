/** HMAC-signed session tokens — no session storage needed, just a secret. */

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

export async function signSession(secret, days = 30) {
  const exp = Date.now() + days * 86400000;
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ exp }));
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${b64url(payloadBytes)}.${b64url(sig)}`;
}

export async function verifySession(secret, token) {
  if (!secret || !token || !token.includes(".")) return false;
  const [p, s] = token.split(".");
  try {
    const payloadBytes = b64urlToBytes(p);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!payload.exp || Date.now() > payload.exp) return false;
    const key = await importKey(secret);
    return await crypto.subtle.verify("HMAC", key, b64urlToBytes(s), payloadBytes);
  } catch {
    return false;
  }
}

export function parseCookie(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
