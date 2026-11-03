# @actuate/cli

The `actuate` command, and `@actuate/cli/testing` for your tests. Projects made with `npm create actuate` include it, so run it with `npx actuate` inside a project.

| Command | |
| --- | --- |
| `actuate init [dir]` | New project with an example test, optionally from a template (`--template refund-order`) |
| `actuate doctor` | Check Node, the project, its deploy checks, providers in `.dev.vars`, and login |
| `actuate dev` | Run locally on `workerd`, with real SQLite and alarms and the hosted platform's guards |
| `actuate test` | Run the project's tests: Vitest if they import it, `node:test` otherwise (TypeScript, no setup) |
| `actuate check [--platform]` | Lint for replay safety; `--platform` also runs the platform's deploy checks |
| `actuate deploy [--dry-run]` | Check, bundle and deploy to [actuate.run](https://actuate.run) |
| `actuate run '<json>'` / `actuate logs [runId]` | Start a run; list runs or show one, with passes and rows |
| `actuate event` / `approve` / `reject` / `answer` / `cancel` | Move a waiting run on |
| `actuate login` | Save an API token |
| `actuate providers` | List providers and the `.dev.vars` entries they read |

Every command has `--help` with examples. Run commands take `--local` for `actuate dev`; most take `--json`. Exit codes: 0 success, 1 failure (errors found, tests failed, deploy refused, a run that ended `FAILED`), 2 wrong usage.

## Testing

```ts
// actuator.test.ts: run with `npx actuate test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

test("refunds after approval", async () => {
  const t = testActuator(actuator, { config: { approver: "lead" } });
  const run = await t.start({ orderId: "A-1001", amount: 20 });
  await t.approve();                          // through the signed link, as a click would
  assert.equal(t.run(run.runId).status, "COMPLETED");
  assert.equal(t.refunds.length, 1);          // recording fakes for every provider
  assert.ok(t.usage(run.runId).rowsWritten <= 20);
});
```

`t.approve()`, `t.reject()` and `t.answer()` throw, saying what is waiting, when nothing matches; to test that an expired or used link is refused, keep a link from `t.approvals` and call `t.followLink(url)`, which returns `{ ok, reason }`. `t.run(runId).output` is typed from the actuator's `run`. The payment fake returns the same bill or refund for a repeated idempotency key.

`testActuator` runs the real step engine on `node:sqlite` with a clock you move (`t.advance("1 day")` fires every alarm on the way; `Date.now()` follows it), recording fakes for messaging, payment, LLM and HTTP (behind your real `http.allow`), `t.approve()` / `t.reject()` / `t.answer()` / `t.event()` / `t.pay()` / `t.cron()`, `t.rows(table)`, and rows read and written per run, metered the way Durable Objects bill them. The hosted platform's guards apply for a plan (`plan: "sandbox"` by default, or `actuate test --plan maker`): per-pass limits, the 1 MiB step result limit, the SQL the platform refuses, the plan's longest wait and passes per run.

## Before you deploy

Every deploy attempt counts against your plan's deploy budget, refused ones included. `actuate deploy` therefore runs the platform's deploy checks locally first and stops on errors: cron count and frequency for your plan, `http.allow`, regexes in the input schema, capabilities on your plan, `actuate.config.json` against the config schema, and, logged in, providers set up, actuator count and deploys left. When the deployed version already runs the same code, it updates only the configuration. The checks mirror the platform's rules; the platform has the final say.

The plan comes from `--plan`, else `ACTUATE_PLAN`, else your account (`GET /v1/me` when logged in, or the plan saved at login if the API can't be reached; `--offline` skips the API), else Sandbox. When nobody chose a plan, the plan's own rules (capabilities, cron limits) are warnings rather than errors, so a fresh project from a template that sends messages passes `npm run check`, and `actuate dev` doesn't refuse its providers.

> Outside a project, use `npx @actuate/cli <command>`: the unscoped `actuate` package on npm is unrelated.

Reference: [CLI](https://actuate.run/docs/reference/cli/). Requires Node.js 22 or later (22.13 or later for `node:sqlite` without a flag).

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
