/** The README's example is examples/refund-order.ts (typechecked and linted there), verbatim. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("README shows examples/refund-order.ts exactly", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const example = readFileSync(new URL("../examples/refund-order.ts", import.meta.url), "utf8").trim();
  expect(readme).toContain("```ts\n" + example + "\n```");
});
