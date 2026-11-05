# @actuate/sdk

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

## 0.3.0

### Minor Changes

- b9ea870: Default idempotency keys for provider calls, and atomic database writes.

  - **runtime:** inside `ctx.step.do`, `ctx.messaging.send`, `ctx.payment.createBill` and `ctx.payment.refund` now get an idempotency key when you pass none, as `MessagingSendOptions.idempotencyKey` always documented. Each call gets its own key, `<runId>:<step>:<method>:<n>`, where `n` counts that method's calls in this attempt of the step from 0, so two sends in one step are not deduplicated against each other, and a retried step sends the same key for the same call. A key you pass is used as is. Keys are at most 255 characters. This works the same self-hosted and on the hosted platform, because the runtime adds the key before the call reaches the provider. **Behaviour change:** a retried step whose earlier attempt reached Stripe or Resend now gets the first attempt's result instead of a second checkout session, refund or email. If the retry sends different parameters with the same key, Stripe and Resend reject it. Keys expire after 24 hours at both, so a retry after a longer backoff is not deduplicated.
  - **providers:** Stripe sends the key as `Idempotency-Key` on `createBill` and `refund` (as before). Resend sends it as `Idempotency-Key`. Discord bot-token sends now pass a nonce derived from it with `enforce_nonce`, so Discord drops duplicates within a few minutes. A key too long for an API is shortened with a hash, never cut off, so keys that differ only at the end stay distinct. Telegram, WhatsApp, Slack, Discord webhooks, CHIP, ToyyibPay and Billplz document no idempotency key, so those adapters do not use it: a retried call can repeat there. The dev payment provider (`actuate dev`) now returns the same bill for a repeated key, as Stripe does.
  - **sdk, runtime:** `ctx.db.batch([...statements])` runs several parameterised statements in one transaction, all or nothing (`transactionSync` on a Durable Object), and resolves to each statement's rows. If one fails, none is applied, and the error says which one failed. Build statements with `` ctx.db.statement`...${value}` `` or `{ sql, params }`. Statements that control a transaction (`BEGIN`, `COMMIT`, `SAVEPOINT`, ...) and tables starting with `_actuate_` are refused.
  - **sdk, runtime:** `ctx.db.commitWithStep([...statements])`, inside `ctx.step.do`, queues writes to apply in the same transaction that records the step as completed. A failed or retried attempt applies none of them, and a completed step never applies them again, even when the run is replayed. Use it for writes that must happen exactly once with the step's result. The step can't read the writes or their rows; use `ctx.db.batch` when it needs them.
  - **runtime:** `Journal` has two new optional methods, `batch` and `commitStep`. A host whose journal lacks them (for example, a hosted platform still on 0.2) rejects `ctx.db.batch` and `commitWithStep` with an error instead of applying writes partly.

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
