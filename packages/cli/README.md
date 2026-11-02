# @actuate/cli

The `actuate` command. Projects made with `npm create actuate` include it, so run it with `npx actuate` inside a project.

| Command | |
| --- | --- |
| `actuate init [dir]` | New project, optionally from a template (`--template refund-order`) |
| `actuate dev` | Run locally on `workerd`, with real SQLite and alarms |
| `actuate check` | Lint for side effects outside `ctx.step.do` (replay safety) |
| `actuate deploy` | Deploy to [actuate.run](https://actuate.run) |
| `actuate run '<json>'` / `actuate logs [runId]` | Start a run; list runs or show one |
| `actuate login` | Save an API token |
| `actuate providers` | List providers and the `.dev.vars` entries they read |

> Outside a project, use `npx @actuate/cli <command>`: the unscoped `actuate` package on npm is unrelated.

Reference: [CLI](https://actuate.run/docs/reference/cli/). Requires Node.js 22 or later.

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
