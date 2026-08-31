/**
 * Signed session cookies.
 *
 * Deliberately dependency-free and built on Web Crypto, because this module is
 * imported by `middleware.js`, which Next runs on the Edge runtime — no
 * `node:crypto`, no Buffer, no database. Password hashing lives in
 * `password.js` instead, which only ever loads inside Node route handlers.
 *
 * The session that shipped before this was the literal string
 * "authenticated_session_active": unsigned, identical for everyone, and
 * trivially forged by typing it into devtools. A signed payload means the
 * middleware can trust the role it reads without a database round trip it
 * could not make anyway.
 */

export const SESSION_COOKIE = "auth_token";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // seconds

const encoder = new TextEncoder();

function b64urlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function secret() {
  const value = process.env.SESSION_SECRET;
  // Refused rather than defaulted. A fallback secret would silently make every
  // deployment that forgot to set one share the same forgeable signing key.
  if (!value || value.length < 32) {
    throw new Error(
      "SESSION_SECRET is missing or shorter than 32 characters. Generate one with: openssl rand -base64 48"
    );
  }
  return value;
}

async function hmacKey() {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Signs `{ userId, email, role }` into a `payload.signature` token. */
export async function signSession({ userId, email, role }) {
  const payload = {
    userId,
    email,
    role,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  };
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(), encoder.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(signature))}`;
}

/**
 * Returns the payload for a valid, unexpired token, or null.
 *
 * Never throws on malformed input — a hand-edited cookie is an expected case,
 * not an error, and it must read as "logged out" rather than a 500.
 */
export async function verifySession(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const [body, signature] = token.split(".");
    if (!body || !signature) return null;

    // crypto.subtle.verify is constant-time, so this does not leak the
    // signature through timing the way a string comparison would.
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(),
      b64urlDecode(signature),
      encoder.encode(body)
    );
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const ROLES = { ADMIN: "admin", VIEWER: "viewer" };
export const isAdmin = (session) => session?.role === ROLES.ADMIN;
