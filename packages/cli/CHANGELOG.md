# @actuate/cli

## 0.4.0

### Minor Changes

- ebf7434: Secret config fields.

  - **sdk:** new `secret(schema)` marks a config field as secret (`apiKey: secret(z.string())`; the same as `.meta({ writeOnly: true })`, so its JSON Schema gets `"writeOnly": true`). It works on fields inside nested objects and arrays, and with `.optional()`, `.nullable()` and `.default()`.
  - **runtime:** the values of secret fields become `[secret]` in run logs, run and step errors (as they are written), and in everything the runtime serves: `POST /run`, `GET /runs`, `GET /runs/:id` (output, steps, logs), the approval queue and approval pages, and approval messages sent to an approver. Stored step results keep the real value, so replays still see it. Numbers are redacted too (as their digits); values shorter than 6 characters and booleans are not. A secret is also caught JSON-escaped (once or twice) and URL- or form-encoded; base64 and other encodings are not. Overlapping secrets are replaced as one span. Self-hosted and under `actuate dev`, this works from the config schema and `ACTUATE_CONFIG` with nothing to set up.
  - **runtime:** new `collectSecrets(configJsonSchema, config)`, `redactSecrets(value, secrets)`, `secretFields(configJsonSchema, config)`, `secretPaths(configJsonSchema)`, `omitSecrets(configJsonSchema, config)` and `mergeSecrets(...lists)`, which work on plain JSON Schema. `secretPaths` lists every secret field the schema declares, set or not: keys joined with dots, `[]` for each array element, `*` for each record value (`apiKey`, `slack.botToken`, `webhooks[].secret`, `keys.*`). `RunManager` takes a `secrets: () => readonly string[]` option and applies the redaction itself; its new `redact(value)` method applies it to anything else. Known limits: reads are redacted with the secrets configured now, so output stored before a key rotation shows the old key, and `/tables` (the actuator's own data) is not redacted.
  - **runtime:** a malformed `ACTUATE_CONFIG` is reported as "not valid JSON" with its line and column, never with the parser's message (which quotes the text around the error). An error a config schema's transform or refine throws is redacted with the raw config's secrets; when a custom `config(env)` throws, or the schema has no JSON Schema, only the error's name is given (the full error goes to the worker's logs). These messages are served on `GET /` and become every run's error, so agent tokens can read them. New `describeJsonError(err, text)`. The CLI reports a malformed `actuate.config.json` the same way.
  - **cli:** when the deployed version already runs the same code, `actuate deploy` compares `actuate.config.json` with the deployed configuration without the secret fields (the platform shows them as `null`), and always sends a file that mentions a secret field (a value, or `""` / `[]` / `null` to clear it). A file that leaves a secret out never clears it. When it updates only the configuration, it prints the platform's warnings too (such as secrets dropped from a list whose length changed), and includes them in `--json` output.

  `ctx.notifyOwner`: message the actuator's owner.

  - **sdk:** new `ctx.notifyOwner(text, { subject })` on every actuator, no capability to declare. On the hosted platform it emails the account (and the account's alert channel, when one is set up); under `actuate dev` it prints the message in the terminal. Call it inside `ctx.step.do`: each message gets an idempotency key derived from the step's, `<runId>:<step>:notifyOwner:<n>`, where `n` counts that step attempt's `notifyOwner` calls from 0, so a retried step does not send it twice. `text` is 1 to 4,000 characters and `subject` one line of at most 200. It resolves to `{ sent, reason? }`: a message the notifier refuses (a daily cap reached) resolves to `{ sent: false, reason }`, with the reason logged as a `warn` line, instead of throwing. New types `NotifyOwnerOptions`, `NotifyOwnerResult`, `OwnerNotification` and `OwnerNotifier`. **Type change:** `notifyOwner` is a new required member of `BaseContext`, so code that builds a `BaseContext` itself (a hand-rolled test context) must add it. Known limit, as for provider calls' keys: the per-attempt counter is kept with the running step, which steps run concurrently would share.
  - **runtime:** `executePass` takes an `owner` notifier, and `createRuntime` a `notifyOwner: (env) => OwnerNotifier` option (secret config values are redacted before it sees a message). Without one, the message is written to the run's log as an `info` line and the call resolves to `{ sent: false, reason }`. New `consoleOwnerNotifier()`, which `actuate dev` uses.
  - **cli:** `@actuate/cli/testing` records messages in `t.ownerNotifications`.
  - **cli:** `actuate check` reports `ctx.notifyOwner()` outside `ctx.step.do` as an error (`no-notify-outside-step`).

  Committed secrets.

  - **cli:** `actuate check`, `actuate deploy` (and `check --platform`, `deploy --dry-run`) and, once at startup, `actuate dev` warn when `actuate.config.json` sets a value for a secret field and git would commit the file (inside a git work tree, not ignored). The warning names the fields and says to set them in the dashboard (Config tab) and leave them out of the file (the platform keeps a stored secret when the file omits it), and, for `actuate dev`, to put them in `.dev.vars` as `ACTUATE_CONFIG`. It is a warning, never an error, and it is in `--json` output too (rule `config-secret`). Outside a git repository, or without git, nothing is said.
  - **cli:** `actuate dev` takes local secrets from the git-ignored `.dev.vars`: an `ACTUATE_CONFIG` there (a JSON object) is deep-merged over `actuate.config.json` (objects merge, anything else from `.dev.vars` wins), and the banner says the config came from both. Invalid JSON there stops `actuate dev` with a clear error (its position, not its text); an empty `ACTUATE_CONFIG=` is ignored. Without it, nothing changes. A merged config that fails validation is reported with both sources named. The committed-secret warning suggests it.
  - **cli:** `actuate dev` hands every value from `.env`, `.dev.vars` and the config to wrangler as a secret (a generated `.actuate/.dev.vars`), so wrangler's startup banner shows them as `(hidden)` instead of printing them.
  - **cli:** the deploy checks refuse actuator names starting with `actuate_`, which the hosted platform keeps for its built-in MCP tools (`actuate_get_run`, `actuate_list_runs`, `actuate_cancel_run`). Self-hosted actuators may still use them; `defineActuator` is unchanged.
  - **cli:** `@actuate/cli/testing` does not redact secret config values, so tests can assert on the real ones.
  - **create-actuate:** the starter's `AGENTS.md` says to mark API keys with `secret()` and set them in the dashboard.

### Patch Changes

- Updated dependencies [ebf7434]
  - @actuate/sdk@0.4.0
  - @actuate/runtime@0.4.0
  - create-actuate@0.4.0
  - @actuate/providers@0.4.0

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

### Patch Changes

- 45b67c8: Fixes and polish after trying every command and porting the templates to `@actuate/cli/testing`.

  - **cli:** `actuate dev` and `actuate test` now ask the account for its plan (`GET /v1/me`, 3 s timeout) when logged in, as `check` and `deploy` do, and fall back to the plan saved at login. Every command says exactly where the plan came from, e.g. "Sandbox plan (the default: not logged in)". New `--offline` on `check`, `dev` and `test` skips the API, as on `doctor`.
  - **cli:** when no plan was chosen (not logged in, no `--plan`), the plan's own rules (capabilities, cron limits) are warnings, not errors. A fresh project made from a template that uses messaging, payment or an LLM passes `npm run check`. With a plan you chose, they stay errors.
  - **cli:** `actuate dev` warns loudly at startup when the plan lacks a capability the actuator needs. With a chosen plan and the guards on, calls on that capability fail with the platform's message; an optional one is undefined, as on the platform. It also checks the bundle size at startup.
  - **cli:** with `--json`, every command prints one JSON object on stdout, failures included (`{ ok: false, error, ... }`, with the issues or diagnostics that stopped a deploy), and exits non-zero. `check` and `deploy` results carry `ok`. `run --json` always prints the run record `POST /run` returned.
  - **cli:** `actuate test` prints its "Platform guards" line once, only when tests run, and says a test can pick its own plan. It runs the project's node:test files even when Vitest-only files can't run (they are reported as skipped, exit 1). It runs `actuator.ts`'s deploy checks alongside the tests and reports them after, only when they find something (`--no-checks` to skip). `--watch` handles projects that mix Vitest and node:test. `--pass-with-no-tests` exits 0 when there are none; without it, no tests is exit 1, so an empty suite doesn't pass CI.
  - **cli:** `check --plan` implies `--platform`. Numbers in CLI output are formatted consistently (2,000). The platform's own messages stay word for word.
  - **cli:** `actuate check` knows `ctx.db.batch` and `commitWithStep`. Write statements in a `ctx.db.batch([...])` outside a step are warnings, like `ctx.db.query` writes, and `ctx.db.commitWithStep()` outside a step is an error.
  - **cli (testing):** `t.rows()` and `t.query()` return plain objects, so `node:assert/strict` compares them as written. `t.followLink(url)` follows a signed link and returns `{ ok, reason }`, for testing refusals; `approve()`, `reject()` and `answer()` still throw with what is waiting. `t.run(runId).output` is typed from the actuator (or `t.run<T>()`). `t.approvals[i].message` is always a string. The payment fake deduplicates bills and refunds by idempotency key.

- Updated dependencies [f6ad391]
- Updated dependencies [b9ea870]
  - @actuate/runtime@0.3.0
  - create-actuate@0.3.0
  - @actuate/sdk@0.3.0
  - @actuate/providers@0.3.0

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

- Updated dependencies [e06474e]
  - @actuate/runtime@0.2.0
  - @actuate/providers@0.2.0
  - create-actuate@0.2.0
  - @actuate/sdk@0.2.0

## 0.1.2

### Patch Changes

- a678fbe: The runtime no longer lists Miniflare's internal `__miniflare_do_name` table under `/tables` in `actuate dev`, and it reads to the end any request body a route ignores, so workerd stops logging "Can't read from request stream after response has been sent". The CLI help now says MCP comes with deploying to Actuate.
- Updated dependencies [a678fbe]
  - @actuate/runtime@0.1.2
  - @actuate/sdk@0.1.2
  - @actuate/providers@0.1.2
  - create-actuate@0.1.2

## 0.1.1

### Patch Changes

- First release published from GitHub Actions, with npm provenance. No code changes since 0.1.0.
- Updated dependencies
  - @actuate/sdk@0.1.1
  - @actuate/runtime@0.1.1
  - @actuate/providers@0.1.1
  - create-actuate@0.1.1

## 0.1.0

### Minor Changes

- 62a1af6: First public release: the actuator SDK, the durable step engine for workerd, provider adapters, the `actuate` CLI and `npm create actuate`.

### Patch Changes

- Updated dependencies [62a1af6]
  - @actuate/sdk@0.1.0
  - @actuate/runtime@0.1.0
  - @actuate/providers@0.1.0
  - create-actuate@0.1.0
