---
"@actuate/sdk": minor
"@actuate/runtime": minor
"@actuate/cli": minor
---

Secret config fields.

- **sdk:** new `secret(schema)` marks a config field as secret (`apiKey: secret(z.string())`; the same as `.meta({ writeOnly: true })`, so its JSON Schema gets `"writeOnly": true`). It works on fields inside nested objects and arrays, and with `.optional()`, `.nullable()` and `.default()`.
- **runtime:** the values of secret fields become `[secret]` in run logs, run and step errors (as they are written), and in everything the runtime serves: `POST /run`, `GET /runs`, `GET /runs/:id` (output, steps, logs), the approval queue and approval pages, and approval messages sent to an approver. Stored step results keep the real value, so replays still see it. Values shorter than 6 characters are not redacted. Self-hosted and under `actuate dev`, this works from the config schema and `ACTUATE_CONFIG` with nothing to set up.
- **runtime:** new `collectSecrets(configJsonSchema, config)`, `redactSecrets(value, secrets)`, `secretFields(configJsonSchema, config)` and `omitSecrets(configJsonSchema, config)`, which work on plain JSON Schema. `RunManager` takes a `secrets: () => string[]` option and applies the redaction itself; its new `redact(value)` method applies it to anything else.
- **cli:** when the deployed version already runs the same code, `actuate deploy` compares `actuate.config.json` with the deployed configuration without the secret fields (the platform shows them as `null`), and always sends a file that sets a secret.

`ctx.notifyOwner`: message the actuator's owner.

- **sdk:** new `ctx.notifyOwner(text, { subject })` on every actuator, no capability to declare. On the hosted platform it emails the account (and the account's alert channel, when one is set up); under `actuate dev` it prints the message in the terminal. Call it inside `ctx.step.do`: each message gets an idempotency key derived from the step's, `<runId>:<step>:notifyOwner:<n>`, so a retried step does not send it twice. `text` is 1 to 4,000 characters and `subject` at most 200. It resolves to `{ sent, reason? }`: a message that can't go out (a daily cap reached) resolves to `{ sent: false, reason }`, logged as a warning, instead of throwing. New types `NotifyOwnerOptions`, `NotifyOwnerResult`, `OwnerNotification` and `OwnerNotifier`.
- **runtime:** `executePass` takes an `owner` notifier, and `createRuntime` a `notifyOwner: (env) => OwnerNotifier` option (secret config values are redacted before it sees a message). Without one, the message is written to the run's log and the call resolves to `{ sent: false }`. New `consoleOwnerNotifier()`, which `actuate dev` uses.
- **cli:** `@actuate/cli/testing` records messages in `t.ownerNotifications`.
- **cli:** `actuate check` reports `ctx.notifyOwner()` outside `ctx.step.do` as an error (`no-notify-outside-step`).
