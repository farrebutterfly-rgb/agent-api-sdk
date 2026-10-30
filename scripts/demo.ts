/**
 * make demo: start the server (fixture extraction, no API key, no cost), run the SDK example
 * and the Python client against it, check the server log for secrets, stop the server.
 * Writes evidence/demo-<date>.log and evidence/demo-server-<date>.jsonl.
 */
import { execSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "../server/config.ts";

const stamp = new Date().toISOString().slice(0, 10);
const sh = (c: string) => { try { return execSync(c, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "unknown"; } };
const rev = sh("git rev-parse --short HEAD");
const python = process.env.PYTHON ?? "python3";
const session = { type: "session", ts: new Date().toISOString(), code_rev: rev, dataset: "invoices-v1 (7 samples from review-workflow)", node: process.version, python: sh(`${python} --version`), mode: "fixture" };

mkdirSync(join(ROOT, "evidence"), { recursive: true });
const outFile = join(ROOT, "evidence", `demo-${stamp}.log`);
const logFile = join(ROOT, "evidence", `demo-server-${stamp}.jsonl`);
const dataDir = join(ROOT, ".data", `demo-${Date.now()}`);
writeFileSync(outFile, JSON.stringify(session) + "\n");
writeFileSync(logFile, JSON.stringify(session) + "\n");
const say = (s: string) => {
  console.log(s);
  appendFileSync(outFile, s + "\n");
};

say(`agent-api-sdk demo  (fixture extraction, scripted models, no API key, no cost)  rev=${rev}`);
const server = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", "server/main.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, LOG_FILE: logFile, LOG_QUIET: "1", STEP_DELAY_MS: "150", EXTRACTION_MODE: "fixture" },
  stdio: ["ignore", "ignore", "pipe"],
});
const url = await new Promise<string>((resolve, reject) => {
  let err = "";
  server.stderr.on("data", (d: Buffer) => {
    err += d.toString();
    const m = /listening on (http:\/\/[\d.]+:\d+)/.exec(err);
    if (m) resolve(m[1]!);
  });
  server.once("exit", (code) => reject(new Error(`server exited ${code}: ${err}`)));
});
say(`server started on ${url} (pid ${server.pid}), data in ${relative(ROOT, dataDir)} (kept after the demo; .data/ is git-ignored)`);

const runChild = (label: string, cmd: string, args: string[]) =>
  new Promise<number>((resolve) => {
    say(`\n$ ${label}`);
    const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, API_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) say(l);
    };
    c.stdout.on("data", onData);
    c.stderr.on("data", onData);
    c.on("close", (code) => {
      if (buf) say(buf);
      resolve(code ?? 1);
    });
  });

let failed = 0;
failed += (await runChild("npm run example -- INV-016   (examples/sdk-client.ts, typed SDK)", process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", "examples/sdk-client.ts", "INV-016"])) === 0 ? 0 : 1;
failed += (await runChild(`${python} examples/python_client.py INV-005   (stdlib Python client)`, python, ["examples/python_client.py", "INV-005"])) === 0 ? 0 : 1;

server.kill("SIGTERM");
await new Promise((r) => server.once("exit", r));

const log = readFileSync(logFile, "utf8");
const tokens = Object.values((JSON.parse(readFileSync(join(ROOT, "data/test-tokens.json"), "utf8")) as { tokens: Record<string, string> }).tokens);
const docLines = ["INV-016.txt", "INV-005.txt"].map((f) => readFileSync(join(ROOT, "data/samples", f), "utf8").split("\n")[0]!);
const leaks = [...tokens, ...docLines].filter((s) => log.includes(s)).length;
const lines = log.trim().split("\n").length - 1;
say(`\nserver stopped. structured log: ${lines} lines in ${relative(ROOT, logFile)}; token or document-text occurrences: ${leaks}`);
say(`web build present: ${existsSync(join(ROOT, "web/dist/index.html")) ? "yes (open the server URL to use the UI)" : "no (run make build for the UI)"}`);
say(failed === 0 && leaks === 0 ? "demo OK" : "demo FAILED");
process.exit(failed === 0 && leaks === 0 ? 0 : 1);
