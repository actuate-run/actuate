import { describe, expect, expectTypeOf, it } from "vitest";
import { ActuatorError, defineActuator, isActuator, parseDuration, z, type Context, type PaymentClient, type PaymentProvider } from "../src/index.js";

const base = { name: "t", description: "test", input: z.object({}), run: () => null };

describe("defineActuator", () => {
  it("returns a frozen actuator that isActuator recognises", () => {
    const act = defineActuator({ ...base, capabilities: ["messaging"], optionalCapabilities: ["payment"] });
    expect(isActuator(act)).toBe(true);
    expect(Object.isFrozen(act)).toBe(true);
    expect(act.name).toBe("t");
    expect(isActuator({ ...base })).toBe(false);
    expect(isActuator(null)).toBe(false);
  });

  it.each(["", "Refund", "refund-order", "1st", "a b", "a".repeat(65)])("refuses the name %j", (name) => {
    expect(() => defineActuator({ ...base, name })).toThrow(ActuatorError);
  });

  it("needs a description", () => {
    expect(() => defineActuator({ ...base, description: "  " })).toThrow(/needs a description/);
  });

  it("refuses unknown capabilities, and one listed as both required and optional", () => {
    expect(() => defineActuator({ ...base, capabilities: ["sms" as never] })).toThrow(/Unknown capability "sms"/);
    expect(() => defineActuator({ ...base, capabilities: ["llm"], optionalCapabilities: ["llm"] })).toThrow(/both required and optional/);
  });

  it("needs http.allow with the http capability, which cannot be optional", () => {
    expect(() => defineActuator({ ...base, capabilities: ["http"] })).toThrow(/no http.allow domains/);
    expect(() => defineActuator({ ...base, optionalCapabilities: ["http" as never] })).toThrow(/cannot be optional/);
    expect(isActuator(defineActuator({ ...base, capabilities: ["http"], http: { allow: ["api.example.com"] } }))).toBe(true);
  });

  describe("idempotencyKey", () => {
    const input = z.object({ orderId: z.string(), amount: z.number().optional(), kind: z.enum(["a", "b"]), tags: z.array(z.string()), meta: z.object({}) });
    const withKey = (idempotencyKey: unknown) => () => defineActuator({ ...base, input, idempotencyKey: idempotencyKey as never });

    it("accepts top-level scalar fields", () => {
      expect(withKey(["orderId"])).not.toThrow();
      expect(withKey(["orderId", "amount", "kind"])).not.toThrow();
    });

    it("refuses anything else, saying what is wrong", () => {
      expect(withKey("orderId")).toThrow(/must be an array of input field names/);
      expect(withKey([])).toThrow(/lists no fields/);
      expect(withKey(["nope"])).toThrow(/"nope" is not a top-level field/);
      expect(withKey(["orderId", "orderId"])).toThrow(/lists "orderId" twice/);
      expect(withKey(["tags"])).toThrow(/"tags" must be a string, number, integer or boolean field \(it is an array\)/);
      expect(withKey(["meta"])).toThrow(/it is an object/);
      expect(() => defineActuator({ ...base, input: z.string() as never, idempotencyKey: ["x"] })).toThrow(/needs an object input schema/);
    });
  });
});

describe("ctx types", () => {
  it("has a client for each declared capability, and maybe one for each optional capability", () => {
    expectTypeOf<Context<"payment">>().toHaveProperty("payment");
    expectTypeOf<Context<never, "messaging">["messaging"]>().toBeNullable();
    expectTypeOf<Context>().not.toHaveProperty("payment");
  });

  it("makes refund always callable on ctx.payment, while an adapter may leave it out", () => {
    expectTypeOf<Context<"payment">["payment"]>().toEqualTypeOf<PaymentClient>();
    expectTypeOf<PaymentClient["refund"]>().toBeFunction();
    expectTypeOf<PaymentProvider["refund"]>().toBeNullable();
  });
});

describe("parseDuration", () => {
  it.each([
    [0, 0],
    [1500, 1500],
    ["500ms", 500],
    ["30 seconds", 30_000],
    ["5m", 300_000],
    ["2 hours", 7_200_000],
    ["1.5h", 5_400_000],
    ["3 days", 259_200_000],
    ["1 week", 604_800_000],
    [" 10 Minutes ", 600_000],
  ])("reads %j as %i ms", (value, ms) => {
    expect(parseDuration(value as never)).toBe(ms);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "", "soon", "5 fortnights", "-5m", "5", "m"])("refuses %j", (value) => {
    expect(() => parseDuration(value as never)).toThrow(RangeError);
  });
});
