---
"@actuate/sdk": patch
"@actuate/cli": patch
---

- **sdk:** `Trigger` declares `agent?: { id: string; name: string }`, the API token or MCP connection that started the run (its ID and name, never the token). The hosted platform sets it for runs started with an API token or over MCP; it is absent for webhooks, cron and the open-source runtime. Code that read it with a cast, `(ctx.trigger as { agent?: ... }).agent`, can use `ctx.trigger.agent` directly.
- **cli:** the deploy checks (`actuate check --platform`, `actuate deploy`, `actuate dev`, `actuate doctor`) warn when a `secret()` field has a default that redaction can't hide: a boolean, or a value shorter than 6 characters (rule `secret-default-not-redacted`). A default on a non-secret parent object counts for the secret fields it sets.
- **cli:** `testActuator` takes `redactSecrets: true` to redact `secret()` config values the way the platform and `actuate dev` do: run output, step results, logs, errors and `t.ownerNotifications` show `[secret]`, while replays still see the real value. It is off by default, so existing tests keep asserting on real values.
