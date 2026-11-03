---
"@actuate/cli": patch
---

Fixes and polish after trying every command and porting the templates to `@actuate/cli/testing`.

- **cli:** `actuate dev` and `actuate test` now ask the account for its plan (`GET /v1/me`, 3 s timeout) when logged in, as `check` and `deploy` do, and fall back to the plan saved at login. Every command says exactly where the plan came from, e.g. "Sandbox plan (the default: not logged in)". New `--offline` on `check`, `dev` and `test` skips the API, as on `doctor`.
- **cli:** when no plan was chosen (not logged in, no `--plan`), the plan's own rules (capabilities, cron limits) are warnings, not errors. A fresh project made from a template that uses messaging, payment or an LLM passes `npm run check`. With a plan you chose, they stay errors.
- **cli:** `actuate dev` warns loudly at startup when the plan lacks a capability the actuator needs. With a chosen plan and the guards on, calls on that capability fail with the platform's message; an optional one is undefined, as on the platform. It also checks the bundle size at startup.
- **cli:** with `--json`, every command prints one JSON object on stdout, failures included (`{ ok: false, error, ... }`, with the issues or diagnostics that stopped a deploy), and exits non-zero. `check` and `deploy` results carry `ok`. `run --json` always prints the run record `POST /run` returned.
- **cli:** `actuate test` prints its "Platform guards" line once, only when tests run, and says a test can pick its own plan. It runs the project's node:test files even when Vitest-only files can't run (they are reported as skipped, exit 1). It runs `actuator.ts`'s deploy checks alongside the tests and reports them after, only when they find something (`--no-checks` to skip). `--watch` handles projects that mix Vitest and node:test. `--pass-with-no-tests` exits 0 when there are none; without it, no tests is exit 1, so an empty suite doesn't pass CI.
- **cli:** `check --plan` implies `--platform`. Numbers in CLI output are formatted consistently (2,000). The platform's own messages stay word for word.
- **cli:** `actuate check` knows `ctx.db.batch` and `commitWithStep`. Write statements in a `ctx.db.batch([...])` outside a step are warnings, like `ctx.db.query` writes, and `ctx.db.commitWithStep()` outside a step is an error.
- **cli (testing):** `t.rows()` and `t.query()` return plain objects, so `node:assert/strict` compares them as written. `t.followLink(url)` follows a signed link and returns `{ ok, reason }`, for testing refusals; `approve()`, `reject()` and `answer()` still throw with what is waiting. `t.run(runId).output` is typed from the actuator (or `t.run<T>()`). `t.approvals[i].message` is always a string. The payment fake deduplicates bills and refunds by idempotency key.
