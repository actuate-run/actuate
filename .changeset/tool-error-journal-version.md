---
"@actuate/sdk": minor
"@actuate/runtime": minor
"@actuate/cli": minor
"@actuate/providers": minor
"create-actuate": minor
---

Errors a caller can act on, `ctx.payment.refund` always callable, a version on the journal, and a compatibility policy.

- **sdk:** new `ToolError(code, message, { retryable, details })`. Throwing it fails the run with an error that carries the code (upper-case letters, digits and underscores, at most 64 characters; anything else throws a `TypeError` where the error is made), whether the caller may make the same call again later (`retryable`, default `false`), and small JSON details (at most 4,096 characters of JSON, `TOOL_ERROR_MAX_DETAILS`; larger or unserialisable details are left out). Thrown in a step, it fails the step at once: the step's `retries` are not used, whatever `retryable` says (that is advice to the caller). New `toolErrorInfo(err)` and `isNonRetryable(err)`, which go by shape and name as well as class, so they hold for an error from another copy of the SDK or one rebuilt after RPC.
- **sdk:** `ctx.payment.refund` is always there: `ctx.payment` is now a `PaymentClient` (`Required<PaymentProvider>`), so `ctx.payment.refund!(...)` can be written `ctx.payment.refund(...)` (the `!` still compiles). `PaymentProvider.refund` stays optional for adapters. New `Clients` type (what `ctx` holds per capability). New `NotSupportedError(provider, operation)`, a `NonRetryableError`.
- **runtime:** a run that failed with a `ToolError` is stored and read with `error.code`, `error.retryable` and `error.details` (`SerializedError` gains the three optional fields); secret config values in the message and details are redacted like any error. Other errors are unchanged: a `code` property on an ordinary `Error` is not copied.
- **runtime:** `ctx.payment.refund` is defined whatever the adapter: on one that leaves `refund` out, calling it throws `NotSupportedError`. **Behaviour change:** code that tested `if (!ctx.payment.refund)` or called `ctx.payment.refund?.(...)` to detect a provider without refunds no longer takes that branch under this runtime, `actuate dev` and `actuate test`. It never did on the hosted platform, where `refund` was always defined and threw. Catch `NotSupportedError` instead. A `NotSupportedError` also no longer uses a step's retries.
- **runtime:** the journal has a version. New table `_actuate_meta` holds `schema_version` (`JOURNAL_SCHEMA_VERSION`, now 1). Databases from 0.1 to 0.5 are upgraded and stamped when first opened; runs that were sleeping or waiting carry on. A database stamped by a newer runtime is refused with the new `JournalVersionError` before anything is created or altered. Opening a stamped database runs two statements, where every open used to run the whole schema. New `journalSchemaVersion(sql)`.
- **providers:** `NotSupportedError` is now the SDK's class, re-exported (same name and message; `instanceof NonRetryableError` is now true).
- **cli:** `actuate run` and `actuate logs` lead a failed run's error with its code, add "(retryable)" when it is, and print its details on the next line.
- **sdk:** `LlmProvider` is marked `@experimental`: the `llm` capability is outside the compatibility policy until it has tool calls, structured output and streaming.
- New `COMPATIBILITY.md`: what is stable from 1.0 (the actuator contract, run semantics, the journal, the runtime HTTP API, the CLI), what is not (`llm`, the host API exported from `@actuate/runtime`, the adapter contract, the journal's tables), which changes count as additions, and how deprecations work. `@actuate/sdk` gains its own tests, one of which holds the list of exported names.
