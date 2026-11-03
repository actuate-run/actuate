# create-actuate

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

## 0.2.0

### Patch Changes

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

## 0.1.2

## 0.1.1

### Patch Changes

- First release published from GitHub Actions, with npm provenance. No code changes since 0.1.0.

## 0.1.0

### Minor Changes

- 62a1af6: First public release: the actuator SDK, the durable step engine for workerd, provider adapters, the `actuate` CLI and `npm create actuate`.
