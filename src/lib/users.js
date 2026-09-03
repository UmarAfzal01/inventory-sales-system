import mongoose from "mongoose";
import { COL } from "@/lib/schema";
import { hashPassword, validatePassword } from "@/lib/password";
import { ROLES } from "@/lib/session";
import { sanitiseScope } from "@/lib/scope";

const db = () => mongoose.connection.db;

/**
 * Emails are stored lowercased and trimmed, and only ever looked up that way.
 * Without it "Admin@x.com" and "admin@x.com" are two accounts as far as the
 * unique index is concerned, and which one you log into depends on how you
 * typed it.
 */
export const normaliseEmail = (email) => String(email ?? "").trim().toLowerCase();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const validateEmail = (email) =>
  EMAIL_RE.test(normaliseEmail(email)) ? null : "Enter a valid email address.";

/** The shape sent to the browser. Never includes passwordHash or salt. */
export const publicUser = (u) =>
  u && {
    id: String(u._id),
    email: u.email,
    role: u.role,
    disabled: Boolean(u.disabled),
    scope: u.scope ?? { branches: [], categories: [], subCategories: [], products: [] },
    createdAt: u.createdAt,
    createdBy: u.createdBy ?? null,
    lastLoginAt: u.lastLoginAt ?? null,
  };

export async function findUserByEmail(email) {
  return db().collection(COL.USERS).findOne({ email: normaliseEmail(email) });
}

export async function listUsers() {
  const rows = await db()
    .collection(COL.USERS)
    .find({}, { projection: { passwordHash: 0, salt: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
  return rows.map(publicUser);
}

/**
 * Creates a user. Returns `{ error }` for anything the caller should show,
 * rather than throwing — a duplicate email is an ordinary outcome of a form.
 */
export async function createUser({
  email, password, role = ROLES.VIEWER, createdBy = null, scope = null,
}) {
  const emailError = validateEmail(email);
  if (emailError) return { error: emailError };
  const passwordError = validatePassword(password);
  if (passwordError) return { error: passwordError };
  if (role !== ROLES.ADMIN && role !== ROLES.VIEWER) return { error: "Unknown role." };

  const { passwordHash, salt } = await hashPassword(password);
  const doc = {
    email: normaliseEmail(email),
    passwordHash,
    salt,
    role,
    // Empty lists mean unrestricted, so a new user starts with full visibility
    // until the admin narrows it.
    scope: sanitiseScope(scope),
    disabled: false,
    createdAt: new Date(),
    createdBy,
    lastLoginAt: null,
  };

  try {
    const res = await db().collection(COL.USERS).insertOne(doc);
    return { user: publicUser({ ...doc, _id: res.insertedId }) };
  } catch (err) {
    // Relying on the unique index rather than a prior findOne: a check-then-
    // insert races two simultaneous submissions of the same address.
    if (err.code === 11000) return { error: "That email already has an account." };
    throw err;
  }
}

export async function setPassword(userId, password) {
  const passwordError = validatePassword(password);
  if (passwordError) return { error: passwordError };
  const { passwordHash, salt } = await hashPassword(password);
  await db()
    .collection(COL.USERS)
    .updateOne({ _id: new mongoose.Types.ObjectId(String(userId)) }, { $set: { passwordHash, salt } });
  return { ok: true };
}

/**
 * Seeds the first admin from ADMIN_USERNAME / ADMIN_PASSWORD.
 *
 * Runs only while the users collection is empty, so it cannot resurrect or
 * overwrite an admin whose password was later changed in the app — once a real
 * account exists the env vars are inert and can be deleted.
 */
export async function seedAdminIfEmpty() {
  const users = db().collection(COL.USERS);
  if (await users.findOne({}, { projection: { _id: 1 } })) return { seeded: false };

  const email = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    return { seeded: false, error: "No users exist and ADMIN_USERNAME/ADMIN_PASSWORD are not set." };
  }

  const result = await createUser({ email, password, role: ROLES.ADMIN, createdBy: "env-seed" });
  if (result.error) return { seeded: false, error: result.error };
  return { seeded: true, user: result.user };
}
