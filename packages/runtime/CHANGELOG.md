# @actuate/runtime

## 0.3.0

### Minor Changes

- f6ad391: Catch what would fail on the hosted platform before you deploy, and test actuators without hand-rolled harnesses.

  - **cli:** new `actuate test`. It finds `*.test.ts` / `*.spec.ts` files and runs them with the project's Vitest if they import it, otherwise with `node --test`, TypeScript included, no setup needed. `--watch`, `--grep`, `--plan`.
  - **cli:** new `@actuate/cli/testing`. `testActuator(actuator)` runs the real engine on `node:sqlite` with a clock you move (`t.advance("1 day")` fires every alarm on the way, and `Date.now()` follows it). It has recording fakes for messaging, payment, LLM and HTTP (behind the real `http.allow` check), `t.approve()` / `t.reject()` / `t.answer()` through the signed links, `t.event()`, `t.pay()`, `t.cron()`, `t.rows(table)`, and `t.usage(runId)`: passes, and rows read and written as Durable Objects bill them. The hosted platform's guards apply for a plan (Sandbox by default).
  - **cli:** `actuate check --platform` runs the hosted platform's deploy checks locally: bundle size, cron count and frequency for the plan, the cron input, `http.allow`, regexes in the input schema, capabilities on the plan, and `actuate.config.json` against the config schema. Logged in, it also checks that providers are set up, the actuator count, and the deploys left this month. `--plan sandbox|maker|agency`, or the plan of the logged-in account (`GET /v1/me`).
  - **cli:** `actuate deploy` runs those checks first and stops on errors, because a refused deploy still counts against the deploy budget (`--force` deploys anyway). When the deployed version already runs the same code, it updates only the configuration (no deploy used), or does nothing. It also says how many deploys you've used this month. `--dry-run` runs the checks too, and exits 1 when they fail; `--json` prints a result for scripts.
  - **cli:** `actuate dev` applies the hosted platform's guards for a plan, with the platform's messages: per-pass limits on statements, steps, rows, HTTP requests and wall time; 1 MiB step results; the SQL the platform refuses; the plan's longest wait and passes per run. `--plan`, and `--no-guards` to turn them off. It also prints the deploy checks as warnings at startup.
  - **cli:** under `actuate dev`, run records carry `usage` (rows read and written, journal included, from Cloudflare's own counters), and `actuate run --local` and `actuate logs --local` show it. Reads made to answer `actuate logs` aren't counted.
  - **cli:** new `actuate event`, `approve`, `reject`, `answer` and `cancel` for moving a waiting run on, locally (`--local`) or on the deployed actuator. New `actuate doctor` checks Node, the project, the SDK version, the deploy checks, providers in `.dev.vars`, `.gitignore` and login.
  - **cli:** `actuate run` and `actuate logs <runId>` print a summary (status, passes, rows, steps, output or error) with the command that moves a waiting run on; `--json` prints the raw record, as `actuate run` used to by default. `actuate logs` takes `--status` and `--limit`. `actuate run` takes `--idempotency-key`.
  - **cli:** every command has `--help` with examples. Unknown commands and options exit 2, with a suggestion. `run` and `logs <runId>` exit 1 for a run that ended `FAILED`. `actuate login` checks the token and refuses agent (run-scoped) tokens. Errors suggest a next step, for example when `actuate dev` isn't running. An `actuate.config.json` that isn't valid JSON is now an error instead of being skipped silently. `actuate --help` starts in about 40 ms (it no longer loads TypeScript).
  - **runtime:** new `meteredNodeSqlite(db, { onStatement })`, `nodeSqlite` with a meter of the rows Durable Objects would bill. Rows written match Cloudflare's counts for the journal; full table scans count the whole table. New `checkActuatorSql(sql, params)`, which refuses what the hosted platform refuses.
  - **create-actuate:** the hello starter includes `actuator.test.ts` (node:test with `@actuate/cli/testing`), an `AGENTS.md` for coding agents, and the scripts `test` (`actuate test`) and `check` (`actuate check --platform`). It also fetches a template's own `actuator.test.ts` when there is one.

- b9ea870: Default idempotency keys for provider calls, and atomic database writes.

  - **runtime:** inside `ctx.step.do`, `ctx.messaging.send`, `ctx.payment.createBill` and `ctx.payment.refund` now get an idempotency key when you pass none, as `MessagingSendOptions.idempotencyKey` always documented. Each call gets its own key, `<runId>:<step>:<method>:<n>`, where `n` counts that method's calls in this attempt of the step from 0, so two sends in one step are not deduplicated against each other, and a retried step sends the same key for the same call. A key you pass is used as is. Keys are at most 255 characters. This works the same self-hosted and on the hosted platform, because the runtime adds the key before the call reaches the provider. **Behaviour change:** a retried step whose earlier attempt reached Stripe or Resend now gets the first attempt's result instead of a second checkout session, refund or email. If the retry sends different parameters with the same key, Stripe and Resend reject it. Keys expire after 24 hours at both, so a retry after a longer backoff is not deduplicated.
  - **providers:** Stripe sends the key as `Idempotency-Key` on `createBill` and `refund` (as before). Resend sends it as `Idempotency-Key`. Discord bot-token sends now pass a nonce derived from it with `enforce_nonce`, so Discord drops duplicates within a few minutes. A key too long for an API is shortened with a hash, never cut off, so keys that differ only at the end stay distinct. Telegram, WhatsApp, Slack, Discord webhooks, CHIP, ToyyibPay and Billplz document no idempotency key, so those adapters do not use it: a retried call can repeat there. The dev payment provider (`actuate dev`) now returns the same bill for a repeated key, as Stripe does.
  - **sdk, runtime:** `ctx.db.batch([...statements])` runs several parameterised statements in one transaction, all or nothing (`transactionSync` on a Durable Object), and resolves to each statement's rows. If one fails, none is applied, and the error says which one failed. Build statements with `` ctx.db.statement`...${value}` `` or `{ sql, params }`. Statements that control a transaction (`BEGIN`, `COMMIT`, `SAVEPOINT`, ...) and tables starting with `_actuate_` are refused.
  - **sdk, runtime:** `ctx.db.commitWithStep([...statements])`, inside `ctx.step.do`, queues writes to apply in the same transaction that records the step as completed. A failed or retried attempt applies none of them, and a completed step never applies them again, even when the run is replayed. Use it for writes that must happen exactly once with the step's result. The step can't read the writes or their rows; use `ctx.db.batch` when it needs them.
  - **runtime:** `Journal` has two new optional methods, `batch` and `commitStep`. A host whose journal lacks them (for example, a hosted platform still on 0.2) rejects `ctx.db.batch` and `commitWithStep` with an error instead of applying writes partly.

### Patch Changes

- Updated dependencies [b9ea870]
  - @actuate/sdk@0.3.0

## 0.2.0

### Minor Changes

- e06474e: Security hardening.

  - **runtime:** new `ACTUATE_RUN_TOKEN` for agents. It can describe the actuator, start runs (`POST /run`) and read a run (`GET /runs/:runId`), and nothing else: it can't approve, answer an input step, fetch approval links, post events, cancel or read tables. `ACTUATE_TOKEN` stays the owner's token for every route. Give your agent the run token, so the agent a run is gated against can't approve itself.
  - **runtime:** under `actuate dev`, routes left open because their secret is unset (the admin API and `/webhook`) now answer only requests to `localhost`, and refuse cross-site and cross-origin requests from browsers (`403`). A web page the developer has open can no longer start runs with the real providers in `.dev.vars`, fake payments through `GET /events`, or read data through DNS rebinding. Requests through a tunnel reach the public routes (`/approve`, `/providers/:kind/webhook`) as before; set `ACTUATE_TOKEN` to use the admin API through one.
  - **runtime:** `GET /events/:key` is accepted only under `actuate dev`; use `POST` elsewhere.
  - **runtime:** without `ACTUATE_PUBLIC_URL`, the origin for approval links and provider callbacks is learned only from a request made with `ACTUATE_TOKEN` (under `actuate dev`, from a request to localhost), not from whoever calls first. Set `ACTUATE_PUBLIC_URL` in production.
  - **runtime:** the approval page is sent with `Cache-Control: no-store`, `X-Frame-Options: DENY` and a restrictive Content-Security-Policy.
  - **providers:** Stripe payment events take their reference only from the `actuate_reference_id` metadata that `createBill` sets, not from `client_reference_id`, which buyers can set themselves on Payment Links and pricing tables.
  - **cli:** `actuate login` creates the credentials file as `0600` (and its folder as `0700`) from the start.
  - **cli:** `actuate login` points at the dashboard's new origin, `https://app.actuate.run/settings/tokens`.
  - **create-actuate:** `--ref` must be a plain git ref.

### Patch Changes

- Updated dependencies [e06474e]
  - @actuate/sdk@0.2.0

## 0.1.2

### Patch Changes

- a678fbe: The runtime no longer lists Miniflare's internal `__miniflare_do_name` table under `/tables` in `actuate dev`, and it reads to the end any request body a route ignores, so workerd stops logging "Can't read from request stream after response has been sent". The CLI help now says MCP comes with deploying to Actuate.
  - @actuate/sdk@0.1.2

## 0.1.1

### Patch Changes

- First release published from GitHub Actions, with npm provenance. No code changes since 0.1.0.
- Updated dependencies
  - @actuate/sdk@0.1.1

## 0.1.0

### Minor Changes

- 62a1af6: First public release: the actuator SDK, the durable step engine for workerd, provider adapters, the `actuate` CLI and `npm create actuate`.

### Patch Changes

- Updated dependencies [62a1af6]
  - @actuate/sdk@0.1.0
