/**
 * Browser test of the React UI against a spawned server. Runs only with PLAYWRIGHT=1 and needs
 * the `playwright` package and a Chromium it can launch (not a dependency of this repo):
 *   npm i --no-save playwright@1.64.1 && npx playwright install chromium
 *   make test-ui
 * Without PLAYWRIGHT=1 it is skipped, so `make test` passes without a browser.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { createClient } from "extract-review-sdk";
import { ROOT } from "../server/config.ts";
import { spawnServer, TOKENS } from "./helpers.ts";

const enabled = process.env.PLAYWRIGHT === "1";

// Loose type on purpose: playwright is not a declared dependency, so its types are not installed.
type PW = { chromium: { launch(o?: object): Promise<any> } };

test("web UI: the SDK's job reviewed in the browser, a job started in the browser, a denied read", { skip: enabled ? false : "set PLAYWRIGHT=1 to run the browser test" }, async () => {
  const { chromium } = createRequire(import.meta.url)("playwright") as PW;
  const shots = join(ROOT, "evidence", "ui");
  mkdirSync(shots, { recursive: true });
  const srv = await spawnServer({ STEP_DELAY_MS: "250" });
  const browser = await chromium.launch();
  try {
    // 1. The SDK creates a job and waits for it.
    const sdk = createClient({ baseUrl: srv.url, token: TOKENS.a });
    const { job_id } = await sdk.createJob({ sample: "INV-016" }, { idempotencyKey: "ui-shared-1" });
    await sdk.waitForJob(job_id);

    // 2. A wrong token is refused at sign-in.
    const pageA = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })).newPage();
    await pageA.goto(srv.url + "/");
    await pageA.fill("#token", "ers_test_wrong_token_0000");
    await pageA.click("text=Open the desk");
    await pageA.waitForSelector("text=401 UNAUTHENTICATED");

    // 3. User A signs in and opens the SDK's job.
    await pageA.fill("#token", TOKENS.a);
    await pageA.click("text=Open the desk");
    await pageA.waitForSelector("[data-testid=who] >> text=Test user A");
    await pageA.goto(`${srv.url}/#/jobs/${job_id}`);
    await pageA.waitForSelector("[data-testid=review-state] >> text=in review");
    assert.equal(await pageA.locator('li[data-field="net"] .nullv').count(), 1, "net starts as no value");
    assert.ok((await pageA.locator('mark[data-field="total"]').textContent())?.includes("12 500,00"), "the total's quote is highlighted in the document");
    await pageA.evaluate(() => window.scrollTo(0, 0));
    await pageA.screenshot({ path: join(shots, "1-review.png"), fullPage: true });

    // 4. Correct net in the UI, with a quote selected from the document text.
    await pageA.click('li[data-field="net"] >> text=Correct');
    await pageA.fill('li[data-field="net"] input[name=value]', "10000");
    await pageA.evaluate(() => {
      const pre = document.querySelector("[data-testid=document]")!;
      const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf("10 000,00");
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + "10 000,00".length);
          const s = window.getSelection()!;
          s.removeAllRanges();
          s.addRange(r);
          pre.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return;
        }
      }
      throw new Error("text not found");
    });
    await pageA.click('li[data-field="net"] >> text=Use selection');
    assert.equal(await pageA.inputValue('li[data-field="net"] input[name=quote]'), "10 000,00");
    await pageA.click('li[data-field="net"] >> text=Save correction');
    await pageA.waitForSelector('li[data-field="net"] .src.human');

    // 5. A bad correction shows the API's field issue.
    await pageA.click('li[data-field="invoice_number"] >> text=Correct');
    await pageA.fill('li[data-field="invoice_number"] input[name=value]', "7731");
    await pageA.fill('li[data-field="invoice_number"] input[name=quote]', "Invoice 7731");
    await pageA.click('li[data-field="invoice_number"] >> text=Save correction');
    await pageA.waitForSelector('li[data-field="invoice_number"] >> text=400 INVALID_INPUT');
    await pageA.click('li[data-field="invoice_number"] >> text=Cancel');

    // 6. Approve and export; the browser receives the draft JSON.
    await pageA.click("text=Approve draft");
    await pageA.waitForSelector("[data-testid=review-state] >> text=approved");
    const [download] = await Promise.all([pageA.waitForEvent("download"), pageA.click("text=Export local draft")]);
    const draft = JSON.parse(readFileSync(await download.path(), "utf8"));
    assert.equal(draft.fields.net.value, 10000);
    assert.equal(draft.fields.net.source, "human");
    assert.equal(draft.model_proposal.fields.net.value, null);
    await pageA.waitForSelector("[data-testid=notice] >> text=Exported");
    await pageA.evaluate(() => window.scrollTo(0, 0));
    await pageA.screenshot({ path: join(shots, "2-exported.png"), fullPage: true });

    // 7. The SDK sees what the browser did: same job, same API.
    const back = await sdk.getJob(job_id);
    assert.equal(back.review?.state, "exported");
    assert.equal(back.review?.corrections[0]?.field, "net");
    assert.equal(back.review?.corrections[0]?.reviewer, "u_test_a");

    // 8. A job started in the browser runs through its steps.
    await pageA.click('label:has-text("INV-001")');
    await pageA.click("text=Start extraction");
    await pageA.waitForSelector("[data-testid=job-status] >> text=succeeded", { timeout: 15_000 });
    const list = await sdk.listJobs();
    assert.equal(list.jobs.length, 2);
    assert.equal(list.jobs[0]?.document_name, "INV-001.txt");

    // 9. User B is denied user A's job.
    const pageB = await (await browser.newContext({ viewport: { width: 1200, height: 700 } })).newPage();
    await pageB.goto(srv.url + "/");
    await pageB.fill("#token", TOKENS.b);
    await pageB.click("text=Open the desk");
    await pageB.waitForSelector("[data-testid=who] >> text=Test user B");
    await pageB.goto(`${srv.url}/#/jobs/${job_id}`);
    await pageB.waitForSelector("text=404 JOB_NOT_FOUND");
    await pageB.screenshot({ path: join(shots, "3-denied.png") });
    assert.equal(await pageB.locator(".jobrow").count(), 0, "user B's list is empty");
  } finally {
    await browser.close();
    await srv.stop();
  }
});
