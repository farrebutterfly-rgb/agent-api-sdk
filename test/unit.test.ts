import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Authenticator } from "../server/auth.ts";
import { ROOT } from "../server/config.ts";
import { Logger } from "../server/log.ts";
import { FixedWindowLimiter } from "../server/rateLimit.ts";
import { tmp, TOKENS } from "./helpers.ts";

test("fixed window: limit per key, reset at the window boundary", () => {
  let now = 10_000;
  const l = new FixedWindowLimiter(2, 1000, () => now);
  assert.deepEqual([l.hit("a").allowed, l.hit("a").allowed, l.hit("a").allowed], [true, true, false]);
  assert.equal(l.hit("b").allowed, true, "keys are independent");
  now = 10_400;
  const d = l.hit("a");
  assert.equal(d.allowed, false);
  assert.equal(d.resetMs, 600);
  now = 11_000;
  assert.equal(l.hit("a").allowed, true, "new window");
});

test("tokens: only hashes in the users file, known tokens map to their user", () => {
  const file = join(ROOT, "data/test-users.json");
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes(TOKENS.a) && !raw.includes(TOKENS.b), "plaintext token in the users file");
  const auth = new Authenticator(file, { production: false, allowTestUsers: false });
  assert.equal(auth.authenticate(`Bearer ${TOKENS.a}`)?.user_id, "u_test_a");
  assert.equal(auth.authenticate(`Bearer ${TOKENS.b}`)?.user_id, "u_test_b");
  assert.equal(auth.authenticate(`Bearer ${TOKENS.a.slice(0, -1)}`), null);
  assert.equal(auth.authenticate(TOKENS.a), null, "scheme required");
  assert.equal(auth.authenticate(undefined), null);
});

test("users file is validated", () => {
  const dir = tmp();
  const f = join(dir, "u.json");
  writeFileSync(f, JSON.stringify({ test_only: false, users: [{ user_id: "u_x", name: "X", token: "plaintext" }] }));
  assert.throws(() => new Authenticator(f, { production: true, allowTestUsers: false }));
  writeFileSync(f, JSON.stringify({ test_only: false, users: [{ user_id: "u_x", name: "X", token_sha256: "a".repeat(64) }] }));
  assert.doesNotThrow(() => new Authenticator(f, { production: true, allowTestUsers: false }));
});

test("logger writes only allowlisted keys and cuts long strings", () => {
  const f = join(tmp(), "log.jsonl");
  const log = new Logger(f, false);
  log.info({ event: "x", user_id: "u_a", authorization: `Bearer ${TOKENS.a}`, text: "document body", route: "r".repeat(300) } as never);
  const line = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(Object.keys(line).sort(), ["event", "level", "route", "ts", "user_id"]);
  assert.ok(line.route.length < 130);
});
