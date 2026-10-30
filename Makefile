PYTHON ?= python3
export PYTHON
BASE_URL ?= http://127.0.0.1:8787
.PHONY: install build serve demo test test-py test-ts test-ui typecheck vendor-check smoke docker-build live check evidence
install:      ## pinned dependencies from package-lock.json, then the web build
	npm ci
	npm run build
build:        ## React app -> web/dist (served by the API server)
	npm run build
web/dist/index.html:
	npm run build
serve:        ## API + web UI on :8787, fixture extraction, test users; Ctrl+C stops
	STEP_DELAY_MS=400 npm run serve
demo:         ## start server, run the SDK example and the Python client, stop server; no API key
	npm run --silent demo
test: test-py test-ts
test-py:      ## the vendored Python validator's unit tests (run PYTHON=python3.10 to check 3.10)
	$(PYTHON) -m unittest discover -s vendor/review-workflow/validator
test-ts: web/dist/index.html  ## API, SDK (spawned server), end-to-end; the browser test skips
	npm test
test-ui: web/dist/index.html  ## Playwright browser test; needs playwright and Chromium installed
	PLAYWRIGHT=1 node --no-warnings=ExperimentalWarning --import tsx --test test/ui.playwright.test.ts
typecheck:
	npm run typecheck
vendor-check: ## vendored files byte-identical to the recorded commits (skips without sibling repos)
	scripts/check-vendor.sh
smoke:        ## smoke test a running server: make smoke BASE_URL=https://host API_TOKEN=...
	scripts/smoke.sh $(BASE_URL)
docker-build: ## build the deployment image (prepared, not deployed)
	docker build -t agent-api-sdk:0.1.0 .
live:         ## real model extraction, needs ANTHROPIC_API_KEY, costs money; exits 2 without a key
	EXTRACTION_MODE=live npm run serve
check: typecheck build test demo
evidence:     ## re-run tests and write evidence/test-<date>.log with a session header
	scripts/record-tests.sh
