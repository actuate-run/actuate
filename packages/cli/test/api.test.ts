import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { errorMessage, writeCredentials } from "../src/api.js";

describe("writeCredentials", () => {
  const before = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  });

  it.skipIf(process.platform === "win32")("keeps the token file and its folder owner-only", () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "actuate-creds-"));
    const p = writeCredentials({ apiUrl: "https://api.actuate.run", token: "t" });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(process.env.XDG_CONFIG_HOME, "actuate")).mode & 0o777).toBe(0o700);
  });
});

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
