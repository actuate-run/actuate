# @actuate/providers

## 0.4.1

### Patch Changes

- Updated dependencies [bb8c52d]
  - @actuate/sdk@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [ebf7434]
  - @actuate/sdk@0.4.0

## 0.3.0

### Minor Changes

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
  - @actuate/sdk@0.2.0

## 0.1.2

### Patch Changes

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
