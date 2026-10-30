import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import { createClient } from "extract-review-sdk";
import { ROOT } from "../server/config.ts";
import { api, spawnServer, TOKENS, type Spawned } from "./helpers.ts";

const run = promisify(execFile);
const PYTHON = process.env.PYTHON ?? "python3";

describe("end to end: one server, the web build, the SDK example, the Python client, the smoke script", () => {
  let srv: Spawned;
  before(async () => {
    srv = await spawnServer();
  });
  after(() => srv.stop());

  test("the web build exists and is served by the API server", async () => {
    const index = join(ROOT, "web/dist/index.html");
    assert.ok(existsSync(index), "web/dist/index.html missing: run npm run build first");
    const html = await api(srv.url, "GET", "/");
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const js = /src="(\/assets\/[^"]+\.js)"/.exec(String(html.json))?.[1];
    assert.ok(js, "index.html references a built script");
    const asset = await fetch(srv.url + js);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    const body = await asset.text();
    assert.ok(body.includes("/api/v1/jobs"), "the bundle talks to the same API (the SDK is bundled in)");
    const deep = await api(srv.url, "GET", "/jobs/anything");
    assert.equal(deep.status, 200, "SPA fallback");
    assert.equal((await api(srv.url, "GET", "/../../etc/passwd")).status, 200, "path traversal falls back to index.html");
    assert.ok(!String((await api(srv.url, "GET", "/%2e%2e/%2e%2e/etc/passwd")).json).includes("root:"));
  });

  test("examples/sdk-client.ts completes a job through the API", async () => {
    const { stdout } = await run(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", "examples/sdk-client.ts", "INV-016"], { cwd: ROOT, env: { ...process.env, API_URL: srv.url } });
    assert.match(stdout, /created=true/);
    assert.match(stdout, /created=false {2}\(same job: true\)/);
    assert.match(stdout, /#3 net: null -> 10000/);
    assert.match(stdout, /exported exports\/u_test_a\/job_[0-9a-f]{12}\.draft\.json/);
    assert.match(stdout, /second user reads job_[0-9a-f]{12}: 404 JOB_NOT_FOUND/);
    assert.match(stdout, /empty create request: 400 INVALID_INPUT/);
    const id = /done: (job_[0-9a-f]{12}) succeeded/.exec(stdout)?.[1];
    assert.ok(id);
    // The same job, read back by a fresh SDK client, is in the state the example left it.
    const job = await createClient({ baseUrl: srv.url, token: TOKENS.a }).getJob(id);
    assert.equal(job.review?.state, "exported");
    assert.equal(job.review?.corrections.length, 3);
    assert.ok(existsSync(join(srv.dataDir, "exports/u_test_a", `${id}.draft.json`)));
  });

  test("examples/python_client.py runs against the same API", async () => {
    const { stdout } = await run(PYTHON, ["examples/python_client.py", "INV-005"], { cwd: ROOT, env: { ...process.env, API_URL: srv.url } });
    assert.match(stdout, /bad token -> 401 UNAUTHENTICATED/);
    assert.match(stdout, /job succeeded/);
    assert.match(stdout, /validator findings \['TOTAL_MISMATCH'\]/);
  });

  test("scripts/smoke.sh passes against the running server", async () => {
    const { stdout } = await run("bash", ["scripts/smoke.sh", srv.url], { cwd: ROOT, env: { ...process.env, API_TOKEN: TOKENS.a } });
    assert.match(stdout, /SMOKE OK/);
  });

  test("the server log of the whole run holds no token and no document text", () => {
    const log = readFileSync(srv.logFile, "utf8");
    assert.ok(log.length > 1000);
    const sample = readFileSync(join(ROOT, "data/samples/INV-016.txt"), "utf8");
    for (const s of [TOKENS.a, TOKENS.b, "Mälarö Måleri", "Faktura 7731", sample.split("\n")[0]!]) assert.ok(!log.includes(s), `log contains ${s}`);
  });
});

describe("repo contracts", () => {
  test("openapi.json is generated from the current zod schemas", async () => {
    const { stdout } = await run(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", "scripts/gen-openapi.ts", "--check"], { cwd: ROOT });
    assert.match(stdout, /up to date/);
  });

  test("scripts/check-vendor.sh: copies match the recorded commits (or skips without siblings)", async () => {
    const { stdout } = await run("bash", ["scripts/check-vendor.sh"], { cwd: ROOT });
    assert.match(stdout, /(ok|skip) +review-workflow/);
    assert.match(stdout, /(ok|skip) +durable-jobs/);
    assert.ok(!/FAIL/.test(stdout));
  });

  test("no file:../ dependencies", () => {
    for (const f of ["package.json", "sdk/package.json", "web/package.json"]) {
      const txt = readFileSync(join(ROOT, f), "utf8");
      assert.ok(!/file:|link:|\^|~\d/.test(txt), `${f} has a local or unpinned dependency`);
    }
  });
});
