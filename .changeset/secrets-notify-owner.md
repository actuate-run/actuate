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
