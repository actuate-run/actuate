import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/api.js";

describe("errorMessage", () => {
  it("lists validation issues under the error, so `actuate run` shows what was wrong", () => {
    const body = {
      error: "Invalid input",
      issues: [
        { path: ["name"], message: "Too small: expected string to have >=1 characters" },
        { path: [], message: "Unrecognized key: \"x\"" },
      ],
    };
    expect(errorMessage(body, "")).toBe(
      'Invalid input\n  name: Too small: expected string to have >=1 characters\n  (input): Unrecognized key: "x"',
    );
  });

  it("reads the platform's JSON-pointer paths too", () => {
    const body = { error: "Invalid input", issues: [{ path: "/customer/phone", message: "bad" }, { path: "/", message: "missing name" }] };
    expect(errorMessage(body, "")).toBe("Invalid input\n  customer.phone: bad\n  (input): missing name");
  });

  it("falls back to the error field or the raw text", () => {
    expect(errorMessage({ error: "unauthorized" }, "")).toBe("unauthorized");
    expect(errorMessage("Bad gateway", "Bad gateway")).toBe("Bad gateway");
  });
});
