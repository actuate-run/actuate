#!/usr/bin/env node
import { relative } from "node:path";
import { parseArgs } from "node:util";
import { scaffold } from "./index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { template: { type: "string", short: "t" }, ref: { type: "string" }, help: { type: "boolean", short: "h" } },
});

if (values.help) {
  console.log("Usage: npm create actuate [dir] -- [--template <name>] [--ref <git-ref>]\n\nTemplates: https://github.com/actuate-run/templates");
  process.exit(0);
}

try {
  const dir = await scaffold({
    dir: positionals[0] ?? "my-actuator",
    ...(values.template ? { template: values.template } : {}),
    ...(values.ref ? { ref: values.ref } : {}),
  });
  const cd = relative(process.cwd(), dir);
  console.log(`
Next:
${cd ? `  cd ${cd}\n` : ""}  npm install
  npx actuate dev       run it locally, with the platform's guards
  npx actuate test      run its tests
  npx actuate doctor    check Node, providers and login

Docs: https://actuate.run/docs/getting-started/quickstart/
`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
