# create-actuate

Start an Actuate project.

```bash
npm create actuate                                  # the hello starter in ./my-actuator
npm create actuate my-tool -- --template refund-order
```

Templates come from [actuate-run/templates](https://github.com/actuate-run/templates): agent tools such as `refund-order`, `lead-intake` and `escalate-to-human`, and automations such as `deposit-reminder` and `daily-report`. Then:

```bash
cd my-tool && npm install && npx actuate dev
```

The hello starter comes with `actuator.test.ts` (run it with `npx actuate test`; it uses `node:test` and `@actuate/cli/testing`, nothing else to install) and an `AGENTS.md` that tells coding agents how to check an actuator before it's deployed. A template that ships its own `actuator.test.ts` gets it too.

[Quickstart](https://actuate.run/docs/getting-started/quickstart/)

---

[Docs](https://actuate.run/docs) · [Source](https://github.com/actuate-run/actuate) · [Templates](https://github.com/actuate-run/templates) · Apache-2.0
