import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * API tokens. The users file stores only the SHA-256 of each token, never the token itself.
 * Tokens are 18 random bytes or more, so a fast hash is enough (no password stretching needed).
 * The seeded users in data/test-users.json are TEST USERS: their tokens are public in
 * data/test-tokens.json, and the server refuses them in production unless explicitly allowed.
 */
const UsersFile = z.strictObject({
  test_only: z.boolean(),
  note: z.string().optional(),
  users: z
    .array(
      z.strictObject({
        user_id: z.string().regex(/^u_[a-z0-9_]{1,40}$/),
        name: z.string().min(1).max(80),
        token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1),
});

export interface User {
  user_id: string;
  name: string;
  test_user: boolean;
}

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest();

export class Authenticator {
  private readonly users: { user: User; hash: Buffer }[];
  readonly testOnly: boolean;

  constructor(file: string, opts: { production: boolean; allowTestUsers: boolean }) {
    const parsed = UsersFile.parse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.test_only && opts.production && !opts.allowTestUsers) {
      throw new Error(`${file} holds test users with public tokens. In production set USERS_FILE to your own users file (scripts/new-token.ts), or ALLOW_TEST_USERS=1 for a throwaway demo.`);
    }
    const ids = new Set<string>();
    for (const u of parsed.users) {
      if (ids.has(u.user_id)) throw new Error(`duplicate user_id ${u.user_id} in ${file}`);
      ids.add(u.user_id);
    }
    this.testOnly = parsed.test_only;
    this.users = parsed.users.map((u) => ({ user: { user_id: u.user_id, name: u.name, test_user: parsed.test_only }, hash: Buffer.from(u.token_sha256, "hex") }));
  }

  /** Returns the user for an Authorization header value, or null. Compares every hash in constant time. */
  authenticate(header: string | undefined): User | null {
    if (!header) return null;
    const m = /^Bearer ([A-Za-z0-9_.~+/=-]{16,200})$/.exec(header);
    if (!m) return null;
    const h = hashToken(m[1]!);
    let found: User | null = null;
    for (const u of this.users) if (timingSafeEqual(u.hash, h)) found = u.user;
    return found;
  }
}
