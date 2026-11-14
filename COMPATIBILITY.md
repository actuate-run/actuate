# Compatibility

What you can rely on staying the same between versions of Actuate, and what may change.

The five packages (`@actuate/sdk`, `@actuate/runtime`, `@actuate/cli`, `@actuate/providers`, `create-actuate`) share one version and follow [semantic versioning](https://semver.org). Until 1.0.0, a minor release (0.6 to 0.7) may include breaking changes; each one is listed in the changelog under a **Breaking** or **Behaviour change** heading with what to do about it. From 1.0.0, the rules below hold: a breaking change to anything marked **stable** needs a new major version.

## What is stable

| Surface | Covers |
| --- | --- |
| **The actuator contract**, `@actuate/sdk` | `defineActuator` and its fields; `ctx` (`step`, `db`, `log`, `trigger`, `notifyOwner`, the `messaging`, `payment` and `http` clients); `secret`; durations; the error classes; every exported name (held by a test, `packages/sdk/test/api-surface.test.ts`) |
| **Run semantics** | What a step, a sleep and a wait do on replay; what a wait resolves to; how idempotency keys are derived and matched. See [Behaviour you can rely on](#behaviour-you-can-rely-on) |
| **The journal** | A runtime opens and upgrades databases written by earlier versions. See [The journal](#the-journal) |
| **The runtime HTTP API**, `createRuntime` from `@actuate/runtime/worker` | Routes, request and response fields, status codes, and `createRuntime`'s options |
| **The CLI** | Command names, flags, exit codes and `--json` output; `@actuate/cli/testing` |
| **Hosted platform** | The platform API (`api.actuate.run/v1`), the run and MCP endpoints, and the error codes in tool errors |

Stable does not mean frozen. These are additions, not breaking changes, and can arrive in any minor release:

- a new optional field on an options object, a result or a response;
- a new member of a union the SDK returns, such as `TriggerKind`, `ApprovalResult["via"]` or a run status. Write a `default` branch when you switch over one;
- a new error code. Treat a code you don't know as not retryable;
- a new capability, CLI command, flag or HTTP route;
- different wording in a human-readable message. Match on `code`, `name` and `status`, never on message text.

## What is not covered

| Surface | Why |
| --- | --- |
| **The `llm` capability** (`ctx.llm`, `LlmProvider`) | Experimental. It is one text completion today, with no tool calls, structured output or streaming, and its shape will change when those arrive |
| **The host API**: everything `@actuate/runtime` exports from its root entry (`RunManager`, `executePass`, `Journal`, the SQL, secrets and button helpers) | It is what `actuate dev`, the test harness and the hosted platform are built on. You may build your own host on it, but pin an exact version: it can change in a minor release, with a changelog entry |
| **The adapter contract**: `@actuate/providers`' `ProviderDefinition`, registry and helpers | The same. Using the adapters through `ctx` is stable; writing your own adapter against the contract is not yet |
| **The journal's tables** (`_actuate_*`) | Read runs through the HTTP API or the CLI, not with SQL. The tables change shape between versions; the runtime upgrades them |
| Anything marked `@experimental` or `@internal` in its documentation comment | |

## Zod

`@actuate/sdk` re-exports `z` from Zod 4, and your input, output and config schemas are Zod schemas. A new major version of Zod is therefore a breaking change to the SDK and comes with a major version of Actuate. Import `z` from `@actuate/sdk` rather than from `zod`, so that an actuator and the SDK never use two different Zod versions.

## Behaviour you can rely on

**Steps.** A step is identified by its name within a run. A completed step never runs again: every replay, and a retried call, gets its stored result (as it came back from JSON). Step names are unique per run. Steps run one at a time: starting a step while another is running throws. Running steps concurrently may be allowed in a later version; nothing that works today will stop working when it is.

**Retries.** `retries` defaults to 0, with a first delay of 1 second that doubles each time. `NonRetryableError`, `NotSupportedError` and `ToolError` end a step without using its retries.

**Waits.** `waitForEvent`, `waitForApproval` and `waitForInput` resolve to `null` when they time out, and only then. An event sent with no payload, or with `null`, arrives as `{}`. Test for a timeout with `=== null`: an event's payload can be any other JSON value, including `0`, `false` and `""`.

**Errors.** Throwing `ToolError(code, message, { retryable, details })` fails the run, and the run's error carries `code`, `retryable` and `details` wherever it is read. Codes are yours: upper-case letters, digits and underscores. The platform's own codes (`INVALID_ARGUMENTS`, `RATE_LIMITED`, `BUDGET_EXHAUSTED`, `ACTUATOR_PAUSED`, `ACCOUNT_SUSPENDED`, `STORAGE_FULL`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `RUN_FAILED`, `RUN_CANCELLED`, `NOT_CANCELLABLE`, `INTERNAL`) are a separate list that only grows; your code travels beside the platform's, and never replaces it.

**Provider methods.** Every method on `ctx.messaging`, `ctx.payment` and `ctx.http` is always callable. One the configured provider's API does not offer (`ctx.payment.refund` on Billplz or ToyyibPay) throws `NotSupportedError`.

**Idempotency keys.** A key the caller sends (`Idempotency-Key`, MCP `_meta`) matches a run in any state. A key derived from the actuator's `idempotencyKey` fields matches a run that is running or waiting, or that completed in the last 24 hours; a failed or cancelled run never blocks a new one. The 24 hours is a default: it will not get shorter, and may become configurable.

**Config.** A run reads the configuration as it is when each pass runs, not as it was when the run started, so a rotated credential reaches runs that are sleeping. On the hosted platform a run keeps the code version it started on; if the configuration no longer fits that version's schema, the run fails with an error saying so, and retrying it moves it to the current version.

## The journal

Each actuator's database holds the runtime's own tables next to yours. They carry a version (`_actuate_meta`, `schema_version`; `JOURNAL_SCHEMA_VERSION` in `@actuate/runtime`).

- **Upgrades are automatic and in place.** Opening a database with a newer runtime brings its tables up to date before anything else happens. Runs that were sleeping or waiting carry on, with their completed steps.
- **A runtime reads databases from its own major version and the one before.** A run that slept through an upgrade from 1.x to 2.x wakes on 2.x. To cross two majors, deploy the one in between first.
- **Downgrades are refused, not attempted.** A runtime that opens a database written by a newer one stops with `JournalVersionError` before changing anything. Deploy the newer runtime again and the database is as it was.
- **The version only goes up with a release that says so** in its changelog.

Databases written by 0.1 to 0.5 have no version stamp. 0.6 and later upgrade and stamp them when first opened.

## Deprecations

From 1.0.0, something stable is removed only in a major version, and only after it has been marked `@deprecated` (with what to use instead) in a release at least 90 days earlier.

## Supported versions

Fixes go into the latest release. An actuator deployed to the hosted platform keeps the SDK it was built with until you deploy it again, and the platform runs actuators built with its current major version of the SDK or the one before. Node.js 22 or later is required for the CLI; actuators themselves run on `workerd`.
