# Contributing

Thanks for helping. Bug reports, docs fixes, new provider adapters and runtime improvements are all welcome.

## Before you start

- **Bugs:** open an issue with what you ran, what you expected and what happened. A failing actuator file or test is the fastest way to a fix.
- **Larger changes** (a new capability, an API change, a new provider): open an issue first so we can agree on the shape before you write it.
- **Security issues:** don't open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

Node.js 22 or later and pnpm 10.

```bash
pnpm install
pnpm check   # build, typecheck, test
```

Tests run locally and need no Cloudflare account: unit tests use `node:sqlite`, and the end-to-end tests in `e2e/` run the real runtime on `workerd` through Miniflare, with real SQLite-backed Durable Objects and alarms.

## Layout

| Path | |
| --- | --- |
| `packages/sdk` | The public API: `defineActuator`, the `ctx` types, provider interfaces |
| `packages/runtime` | The step engine (`RunManager`, journal, replay) and the `workerd` host (`createRuntime`) |
| `packages/cli` | The `actuate` command, including the replay-safety linter (`actuate check`) |
| `packages/providers` | Provider adapters; each implements the contract in `src/contract.ts` |
| `packages/create-actuate` | `npm create actuate` |
| `e2e/` | End-to-end tests on `workerd` |
| `examples/` | Typechecked examples; the README's example is `examples/refund-order.ts` |

## Conventions

- **Tests with every change.** Engine changes need a test in `packages/runtime/test`; behaviour visible from HTTP needs one in `e2e/`.
- **Replay safety.** Anything that touches the outside world runs inside `ctx.step.do`. If you add a new kind of side effect, teach `actuate check` about it.
- **Providers** take the user's own credentials and never log them. Verify every inbound webhook (signature, secret token or a re-query of the provider's API) before turning it into an event, and add tests with recorded responses in `packages/providers/test`.
- **Changesets.** User-visible changes to a published package need a changeset: run `pnpm changeset` and describe the change for the changelog.
- **Docs** live in [actuate-run/docs](https://github.com/actuate-run/docs). If your change alters behaviour described there, open a PR there too.

## Pull requests

Keep a PR to one change, with a description of what changed and how you tested it. Run `pnpm check` before you push.

By contributing, you agree that your contributions are licensed under the [Apache-2.0](LICENSE) license.
