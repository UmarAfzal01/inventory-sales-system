import { scrypt, randomBytes, timingSafeEqual } from "crypto";

/**
 * Password hashing with scrypt.
 *
 * Node ships scrypt, so this needs no dependency, and scrypt is deliberately
 * expensive in both CPU and memory — which is the point of a password hash.
 * Kept apart from `session.js` because `node:crypto` does not exist on the Edge
 * runtime where the middleware runs.
 */

const KEY_LENGTH = 64;
// Defaults (N=16384, r=8, p=1) need ~16MB per hash. Raising N would need
// maxmem raised alongside it, so the cost is left at the documented default.
const derive = (password, salt) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, key) => (err ? reject(err) : resolve(key)));
  });

export const MIN_PASSWORD_LENGTH = 8;

/** Rejects the passwords that make everything else pointless. */
export function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return "Password must be under 200 characters.";
  return null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return { passwordHash: key.toString("hex"), salt };
}

/**
 * Constant-time verification.
 *
 * Returns false rather than throwing for a user record with no hash — a
 * half-written user must fail closed, not crash the login route.
 */
export async function verifyPassword(password, passwordHash, salt) {
  if (!password || !passwordHash || !salt) return false;
  try {
    const key = await derive(password, salt);
    const stored = Buffer.from(passwordHash, "hex");
    if (stored.length !== key.length) return false;
    return timingSafeEqual(key, stored);
  } catch {
    return false;
  }
}
