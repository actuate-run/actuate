import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

/**
 * The runtime names `@actuate/sdk` exports. They are covered by the compatibility policy (COMPATIBILITY.md):
 * removing or renaming one is a breaking change, so this list only grows within a major version. A failure
 * here means the public API changed: update the list on purpose, with a changeset that says so.
 *
 * Types are not listed (they don't exist at run time); `pnpm typecheck` over the examples, the templates'
 * tests and e2e/ is what holds them.
 */
const EXPORTS = [
  "ActuatorError",
  "CAPABILITIES",
  "NOTIFY_OWNER",
  "NOTIFY_OWNER_MAX_SUBJECT",
  "NOTIFY_OWNER_MAX_TEXT",
  "NonRetryableError",
  "NotSupportedError",
  "SuspendSignal",
  "TOOL_ERROR_CODE",
  "TOOL_ERROR_MAX_DETAILS",
  "ToolError",
  "defineActuator",
  "isActuator",
  "isNonRetryable",
  "isSuspendSignal",
  "parseDuration",
  "secret",
  "toolErrorInfo",
  "z",
];

describe("@actuate/sdk public API", () => {
  it("exports exactly the documented names", () => {
    expect(Object.keys(sdk).sort()).toEqual(EXPORTS);
  });
});
