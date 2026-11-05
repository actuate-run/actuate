import { describe, expect, it } from "vitest";
import { describeJsonError } from "../src/index.js";

const fail = (text: string) => {
  try {
    JSON.parse(text);
  } catch (err) {
    return err;
  }
  throw new Error("parsed");
};

describe("describeJsonError", () => {
  it("gives the position, never the text", () => {
    for (const text of ['{"apiKey": "sk_live_PARTIAL" oops}', '{"a":\n "sk_live_PARTIAL', '{"a": sk_live_PARTIAL}', '{"a": "sk_live_PARTIAL"}}']) {
      const described = describeJsonError(fail(text), text);
      expect(described).toMatch(/^is not valid JSON( \(line \d+, column \d+\))?$/);
      expect(described).not.toContain("sk_live");
    }
    expect(describeJsonError(fail('{"apiKey": "sk_live_PARTIAL" oops}'))).toBe("is not valid JSON (line 1, column 30)");
    expect(describeJsonError(new SyntaxError("Bad thing in JSON at position 4"), "ab\ncdef")).toBe("is not valid JSON (line 2, column 2)");
    expect(describeJsonError(new SyntaxError("Bad thing in JSON at position 4"))).toBe("is not valid JSON (at character 5)");
    expect(describeJsonError("nope")).toBe("is not valid JSON");
  });
});
