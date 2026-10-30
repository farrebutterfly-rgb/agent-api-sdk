# Progress

## 2026-10-30, session 1

Done: vendored review-workflow and durable-jobs at recorded commits with a check script; API server (node:http) with test-user token auth, per-user fixed-window rate limit, allowlist JSON logger, durable three-step extraction jobs, review routes and static web serving; zod contract shared by server, SDK and `openapi.json`; typed SDK with its own README; React review UI built with Vite; SDK example, Python client, smoke script, Dockerfile; API, SDK, end-to-end and browser tests; API.md, DEMO.md.

Not done: live model run (needs `ANTHROPIC_API_KEY`), Docker image build (no Docker daemon in the build container), any deployment, a run by a second person from a clean machine.

Next: build and run the image locally (`make docker-build`), deploy it to a cloud host and run `make smoke BASE_URL=...` against the real URL (only then update "verified public URL"), then `make live`.
