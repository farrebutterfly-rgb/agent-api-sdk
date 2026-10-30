/**
 * Create (or extend) a users file for a real deployment. Prints the new token once; the file
 * stores only its SHA-256.
 *   node --import tsx scripts/new-token.ts <users-file> <user_id> "<display name>"
 * Then start the server with USERS_FILE=<users-file>.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hashToken } from "../server/auth.ts";

const [file, userId, name] = process.argv.slice(2);
if (!file || !userId || !name || !/^u_[a-z0-9_]{1,40}$/.test(userId)) {
  console.error('usage: scripts/new-token.ts <users-file> <user_id like u_ops_1> "<display name>"');
  process.exit(2);
}
const doc = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { test_only: boolean; users: { user_id: string; name: string; token_sha256: string }[] }) : { test_only: false, users: [] };
if (doc.test_only) {
  console.error(`${file} is a test users file; write real users to a separate file`);
  process.exit(2);
}
if (doc.users.some((u) => u.user_id === userId)) {
  console.error(`${userId} already exists in ${file}`);
  process.exit(2);
}
const token = `ers_${randomBytes(24).toString("base64url")}`;
doc.users.push({ user_id: userId, name, token_sha256: hashToken(token).toString("hex") });
writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
console.log(`added ${userId} to ${file}. Token (shown once, store it in a secret manager):\n${token}`);
