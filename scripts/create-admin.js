/**
 * Creates or resets the admin account directly in the database.
 *
 *   node scripts/create-admin.js admin@rainbow.com 'the-password'
 *
 * The normal path is the ADMIN_USERNAME / ADMIN_PASSWORD seed, which runs on
 * first login while the users collection is empty. This exists for the cases
 * that path cannot cover: a locked-out admin, or setting up a fresh database
 * without putting credentials into the deployment's environment.
 *
 * The hashing here MUST match src/lib/password.js exactly — scrypt, 64-byte
 * key, per-user hex salt — or the account is created and login silently fails.
 */
import { MongoClient } from "mongodb";
import { scrypt, randomBytes } from "crypto";
import { readFileSync } from "fs";

const KEY_LENGTH = 64;

const derive = (password, salt) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, key) => (err ? reject(err) : resolve(key)));
  });

function connectionString() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  // Falls back to .env.local so the script works the same way the app does.
  const file = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const match = file.match(/^MONGODB_URI=(.+)$/m);
  if (!match) throw new Error("MONGODB_URI not set and not found in .env.local");
  return match[1].trim();
}

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: node scripts/create-admin.js <email> <password>");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const client = new MongoClient(connectionString(), { serverSelectionTimeoutMS: 20000 });

try {
  await client.connect();
  const db = client.db();
  const users = db.collection("users");

  // Matches the app: emails are stored lowercased and only looked up that way.
  const normalised = String(email).trim().toLowerCase();
  const salt = randomBytes(16).toString("hex");
  const passwordHash = (await derive(password, salt)).toString("hex");

  const existing = await users.findOne({ email: normalised });

  if (existing) {
    await users.updateOne(
      { _id: existing._id },
      { $set: { passwordHash, salt, role: "admin", disabled: false } }
    );
    console.log(`Updated ${normalised}: password reset, role admin, enabled.`);
  } else {
    await users.insertOne({
      email: normalised,
      passwordHash,
      salt,
      role: "admin",
      // Empty lists mean unrestricted; the admin is never scoped anyway.
      scope: { branches: [], categories: [], subCategories: [], products: [] },
      disabled: false,
      createdAt: new Date(),
      createdBy: "create-admin script",
      lastLoginAt: null,
    });
    console.log(`Created ${normalised} as admin.`);
  }

  // The unique index on email is what actually prevents duplicates; without it
  // a second account on the same address would decide the role by whichever
  // document the query happened to return first.
  await users.createIndex({ email: 1 }, { name: "email_unique", unique: true }).catch(() => {});

  const all = await users.find({}, { projection: { passwordHash: 0, salt: 0 } }).toArray();
  console.log(`\n${all.length} user(s):`);
  for (const u of all) {
    console.log(`  ${u.email}  ${u.role}${u.disabled ? "  (disabled)" : ""}`);
  }
} finally {
  await client.close();
}
