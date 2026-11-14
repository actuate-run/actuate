import { describe, expect, it } from "vitest";
import { ActuatorError, NonRetryableError, NotSupportedError, SuspendSignal, ToolError, isNonRetryable, isSuspendSignal, toolErrorInfo } from "../src/index.js";

describe("ToolError", () => {
  it("carries a code, a message and whether calling again may help", () => {
    const err = new ToolError("CARD_DECLINED", "The card was declined.");
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: "ToolError", code: "CARD_DECLINED", message: "The card was declined.", retryable: false });
    expect(err.details).toBeUndefined();

    const busy = new ToolError("UPSTREAM_BUSY", "Try again in a minute.", { retryable: true, details: { retryAfterSeconds: 60 }, cause: err });
    expect(busy).toMatchObject({ retryable: true, details: { retryAfterSeconds: 60 }, cause: err });
  });

  it("is not retryable unless retryable is exactly true", () => {
    expect(new ToolError("X", "m", { retryable: "yes" as never }).retryable).toBe(false);
  });

  it("uses the code as the message when none is given", () => {
    expect(new ToolError("OUT_OF_STOCK", "").message).toBe("OUT_OF_STOCK");
  });

  it.each(["", "card_declined", "Card", "1ST", "NOT-FOUND", "A B", "A".repeat(65), 5, null, undefined])("refuses the code %j", (code) => {
    expect(() => new ToolError(code as never, "m")).toThrow(TypeError);
  });

  it.each(["A", "E404", "ORDER_NOT_FOUND", "A".repeat(64)])("accepts the code %j", (code) => {
    expect(new ToolError(code, "m").code).toBe(code);
  });
});

describe("toolErrorInfo", () => {
  it("reads a ToolError", () => {
    expect(toolErrorInfo(new ToolError("A", "m"))).toEqual({ code: "A", retryable: false });
    expect(toolErrorInfo(new ToolError("A", "m", { retryable: true, details: [1] }))).toEqual({ code: "A", retryable: true, details: [1] });
  });

  it("goes by shape, so another copy of the class or an error rebuilt after RPC still counts", () => {
    const rebuilt = Object.assign(new Error("m"), { name: "ToolError", code: "A", retryable: true });
    expect(toolErrorInfo(rebuilt)).toEqual({ code: "A", retryable: true });
    expect(toolErrorInfo({ name: "ToolError", code: "A" })).toEqual({ code: "A", retryable: false });
  });

  it("is null for anything else, and for a code that is not well formed", () => {
    for (const value of [null, undefined, "ToolError", 5, new Error("m"), new NonRetryableError("m"), { name: "ToolError" }, { name: "ToolError", code: "nope" }, { name: "Error", code: "A" }]) {
      expect(toolErrorInfo(value)).toBeNull();
    }
  });
});

describe("isNonRetryable", () => {
  it("is true for the errors that end a step without its retries", () => {
    expect(isNonRetryable(new NonRetryableError("m"))).toBe(true);
    expect(isNonRetryable(new NotSupportedError("Billplz", "refund"))).toBe(true);
    expect(isNonRetryable(new ToolError("A", "m"))).toBe(true);
    // Retryable is advice to the caller; the step still ends.
    expect(isNonRetryable(new ToolError("A", "m", { retryable: true }))).toBe(true);
  });

  it("goes by name too", () => {
    expect(isNonRetryable(Object.assign(new Error("m"), { name: "NonRetryableError" }))).toBe(true);
    expect(isNonRetryable(Object.assign(new Error("m"), { name: "NotSupportedError" }))).toBe(true);
    expect(isNonRetryable(Object.assign(new Error("m"), { name: "ToolError", code: "A" }))).toBe(true);
  });

  it("is false for everything else", () => {
    for (const value of [new Error("m"), new ActuatorError("m"), new TypeError("m"), "NonRetryableError", null, undefined, { name: "ToolError", code: "bad code" }]) {
      expect(isNonRetryable(value)).toBe(false);
    }
  });
});

describe("NotSupportedError", () => {
  it("names the provider and the operation, and is a NonRetryableError", () => {
    const err = new NotSupportedError("Billplz", "refund");
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err).toMatchObject({ name: "NotSupportedError", message: "refund is not supported by Billplz", provider: "Billplz", operation: "refund" });
  });
});

describe("SuspendSignal", () => {
  it("is recognised by its marker, not its class", () => {
    expect(isSuspendSignal(new SuspendSignal("sleeping"))).toBe(true);
    expect(isSuspendSignal({ __actuateSuspend: true })).toBe(true);
    expect(isSuspendSignal(new Error("sleeping"))).toBe(false);
    expect(isSuspendSignal(null)).toBe(false);
  });
});
