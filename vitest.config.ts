import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "e2e/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
