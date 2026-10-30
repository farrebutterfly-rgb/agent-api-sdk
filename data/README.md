# Data provenance

Everything here is synthetic and invented. No real company, person, organisation number or invoice.

## samples/

Seven plain-text invoice-like documents copied unchanged from the `review-workflow` repo (review-workflow), dataset version `invoices-v1`, commit `b9d05133d46f20ef1262a84605857217191c38a2`, files `data/docs/INV-001.txt`, `003`, `005`, `006`, `010`, `013`, `016`. They were written by hand for that repo on 2026-10-30. Supplier and customer names, addresses, organisation numbers, invoice and bank giro numbers and amounts are invented. No emails appear in them.

| Sample | What it shows |
| --- | --- |
| INV-001 | complete Swedish invoice: every field found, no findings |
| INV-003 | no due date, only payment terms: due date stays null with a reason |
| INV-005 | net + vat does not equal total on the paper: validator error `TOTAL_MISMATCH` blocks approval until acknowledged |
| INV-006 | ambiguous dates `03/04/2026`: stay null, not guessed |
| INV-010 | currency only "kr": currency stays null |
| INV-013 | credit note with negative amounts |
| INV-016 | held-out document in review-workflow: invoice number without a label and net under "Summa", so the fixture extractor leaves three fields null and the reviewer fills them in |

The fixture extractor is review-workflow's scripted planner and worker over hand-written reading rules. Its results on these documents measure those rules, not a language model.

## test-users.json and test-tokens.json

**Test credentials for the local demo only.** `test-users.json` holds two users (`u_test_a`, `u_test_b`) with the SHA-256 of their tokens; this is the file the server reads. `test-tokens.json` holds the matching plaintext tokens so the demo, the tests and the examples can sign in. Both are public, so they protect nothing; they exist to exercise the access checks. The server refuses a file marked `test_only` when `NODE_ENV=production` unless `ALLOW_TEST_USERS=1`. Real users: `scripts/new-token.ts`.
