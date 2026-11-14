import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { NotSupportedError, ToolError, defineActuator, toolErrorInfo, z, type Actuator, type Providers } from "@actuate/sdk";
import { RunManager, executePass, nodeSqlite, serializeError } from "../src/index.js";

function harness(actuator: Actuator, opts: { providers?: Partial<Providers>; secrets?: string[] } = {}) {
  let now = Date.parse("2026-11-14T00:00:00Z");
  const manager = new RunManager({
    sql: nodeSqlite(new DatabaseSync(":memory:")),
    approvalSecret: "test-secret",
    approvalUrl: "https://example.test/approve",
    now: () => now,
    consoleLogs: false,
    ...(opts.secrets ? { secrets: () => opts.secrets! } : {}),
    invoke: (request, journal) => executePass(actuator, request, { journal, config: {}, ...(opts.providers ? { providers: opts.providers } : {}) }),
  });
  return {
    manager,
    start: (input: unknown = {}) => manager.start({ input: input as never, trigger: { kind: "api" } }),
    advance: async (ms: number) => {
      now += ms;
      await manager.alarm();
    },
  };
}

const define = (run: Parameters<typeof defineActuator>[0]["run"], extra: Partial<Parameters<typeof defineActuator>[0]> = {}) =>
  defineActuator({ name: "t", description: "test", input: z.object({}), ...extra, run } as never) as Actuator;

describe("ToolError", () => {
  it("fails the run with its code, retryable flag and details next to the message", async () => {
    const h = harness(
      define(() => {
        throw new ToolError("ALREADY_REFUNDED", "Order A-1 was refunded yesterday.", { details: { refundId: "re_1" } });
      }),
    );
    const { run } = await h.start();
    expect(run.status).toBe("FAILED");
    expect(run.error).toMatchObject({ name: "ToolError", message: "Order A-1 was refunded yesterday.", code: "ALREADY_REFUNDED", retryable: false, details: { refundId: "re_1" } });
    // What every later read returns.
    expect(h.manager.getRun(run.runId)!.error).toMatchObject({ code: "ALREADY_REFUNDED", retryable: false, details: { refundId: "re_1" } });
  });

  it("passes retryable on to the caller", async () => {
    const h = harness(
      define(() => {
        throw new ToolError("UPSTREAM_BUSY", "The courier's API is busy.", { retryable: true });
      }),
    );
    const { run } = await h.start();
    expect(run.error).toMatchObject({ code: "UPSTREAM_BUSY", retryable: true });
    expect(run.error).not.toHaveProperty("details");
  });

  it("thrown in a step, fails the step at once: the step's retries are not used", async () => {
    let attempts = 0;
    const h = harness(
      define(async (ctx) => {
        await ctx.step.do("charge", { retries: 5 }, () => {
          attempts++;
          // Retryable is advice to the caller, not to the step.
          throw new ToolError("CARD_DECLINED", "The card was declined.", { retryable: true });
        });
      }),
    );
    const { run } = await h.start();
    expect(run.status).toBe("FAILED");
    expect(attempts).toBe(1);
    expect(run.error).toMatchObject({ code: "CARD_DECLINED", retryable: true });
    expect(h.manager.getSteps(run.runId)).toMatchObject([{ name: "charge", status: "FAILED", attempts: 1, error: "The card was declined." }]);
  });

  it("an ordinary error in a step still retries, and has no code", async () => {
    let attempts = 0;
    const h = harness(
      define(async (ctx) => {
        await ctx.step.do("flaky", { retries: 1, backoff: "1 second" }, () => {
          attempts++;
          throw new Error("socket hang up");
        });
      }),
    );
    const { run } = await h.start();
    expect(run.status).toBe("WAITING");
    await h.advance(1_000);
    expect(attempts).toBe(2);
    const failed = h.manager.getRun(run.runId)!;
    expect(failed.status).toBe("FAILED");
    expect(failed.error).not.toHaveProperty("code");
    expect(failed.error).not.toHaveProperty("retryable");
  });

  it("can be caught by the actuator, which then decides the outcome itself", async () => {
    const h = harness(
      define(async (ctx) => {
        try {
          await ctx.step.do("charge", () => {
            throw new ToolError("CARD_DECLINED", "declined");
          });
        } catch (err) {
          return { status: "DECLINED", code: (err as ToolError).code };
        }
      }),
    );
    const { run } = await h.start();
    expect(run).toMatchObject({ status: "COMPLETED", output: { status: "DECLINED", code: "CARD_DECLINED" } });
  });

  it("is met again on replay with the same name, code and details, so a catch takes the same branch on every pass", async () => {
    const seen: unknown[] = [];
    const h = harness(
      define(async (ctx) => {
        try {
          await ctx.step.do("charge", () => {
            throw new ToolError("CARD_DECLINED", "The card was declined.", { retryable: true, details: { last4: "4242" } });
          });
        } catch (err) {
          seen.push({ name: (err as Error).name, message: (err as Error).message, info: toolErrorInfo(err) });
          if (toolErrorInfo(err)?.code !== "CARD_DECLINED") throw err;
          await ctx.step.sleep("cool-off", "1 minute"); // the run suspends: the catch runs again on the next pass
          return { status: "DECLINED" };
        }
      }),
    );
    const { run } = await h.start();
    expect(run.status).toBe("WAITING");
    await h.advance(60_000);
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { status: "DECLINED" } });
    const first = { name: "ToolError", message: "The card was declined.", info: { code: "CARD_DECLINED", retryable: true, details: { last4: "4242" } } };
    expect(seen).toEqual([first, first]);
  });

  it("keeps its code when the actuator cleans up after it across a suspension and throws it again", async () => {
    let releases = 0;
    const h = harness(
      define(async (ctx) => {
        try {
          await ctx.step.do("charge", () => {
            throw new ToolError("CARD_DECLINED", "The card was declined.", { details: { last4: "4242" } });
          });
        } catch (err) {
          await ctx.step.do("release-hold", { retries: 2, backoff: "1 second" }, () => {
            if (++releases === 1) throw new Error("busy");
          });
          throw err;
        }
      }),
    );
    const { run } = await h.start();
    expect(run.status).toBe("WAITING");
    await h.advance(1_000);
    const failed = h.manager.getRun(run.runId)!;
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatchObject({ name: "ToolError", message: "The card was declined.", code: "CARD_DECLINED", retryable: false, details: { last4: "4242" } });
  });

  it("replays any step failure under the name it was thrown with", async () => {
    const names: string[] = [];
    const h = harness(
      define(
        async (ctx) => {
          try {
            await ctx.step.do("refund", () => (ctx as unknown as { payment: Required<Providers["payment"]> }).payment.refund({ billId: "b1" }));
          } catch (err) {
            names.push((err as Error).name);
            if ((err as Error).name !== "NotSupportedError") throw err;
            const ok = await ctx.step.waitForApproval("manual-refund", { message: "Refund by hand?" });
            return { status: ok?.approved ? "MANUAL" : "DECLINED" };
          }
        },
        { capabilities: ["payment"] } as never,
      ),
      { providers: { payment: { createBill: async () => never(), getBill: async () => never() } } },
    );
    const { run } = await h.start();
    expect(run.status).toBe("WAITING");
    await h.manager.decideDirect(run.runId, "manual-refund", true);
    await h.manager.alarm();
    expect(h.manager.getRun(run.runId)).toMatchObject({ status: "COMPLETED", output: { status: "MANUAL" } });
    expect(new Set(names)).toEqual(new Set(["NotSupportedError"]));
    expect(names.length).toBeGreaterThan(1);
  });

  it("stores a code that held a secret as REDACTED, still a well-formed code", async () => {
    const h = harness(
      define(async (ctx) => {
        await ctx.step.do("leak", () => {
          throw new ToolError("SK_LIVE_ABCDEF123456", "m");
        });
      }),
      { secrets: ["SK_LIVE_ABCDEF123456"] },
    );
    const { run } = await h.start();
    expect(run.error).toMatchObject({ name: "ToolError", code: "REDACTED" });
    expect(toolErrorInfo(run.error)).toMatchObject({ code: "REDACTED" });
    expect(JSON.stringify(h.manager.getSteps(run.runId))).not.toContain("SK_LIVE_ABCDEF123456");
  });

  it("redacts secret config values in the message and the details", async () => {
    const h = harness(
      define(() => {
        throw new ToolError("UPSTREAM_REJECTED", "The API refused key sk_live_abcdef123456.", { details: { sent: "Bearer sk_live_abcdef123456" } });
      }),
      { secrets: ["sk_live_abcdef123456"] },
    );
    const { run } = await h.start();
    expect(JSON.stringify(run.error)).not.toContain("sk_live_abcdef123456");
    expect(run.error).toMatchObject({ code: "UPSTREAM_REJECTED", message: "The API refused key [secret].", details: { sent: "Bearer [secret]" } });
  });
});

describe("serializeError", () => {
  it("leaves out details that are too large or can't be stored, keeping the code and message", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const details of ["x".repeat(5_000), cycle, { n: 10n }, () => 1]) {
      const stored = serializeError(new ToolError("TOO_MUCH", "m", { details }));
      expect(stored).toMatchObject({ name: "ToolError", code: "TOO_MUCH", retryable: false, message: "m" });
      expect(stored).not.toHaveProperty("details");
    }
  });

  it("stores details as plain JSON", () => {
    expect(serializeError(new ToolError("A", "m", { details: { at: new Date(0), skip: undefined, n: 1 } })).details).toEqual({ at: "1970-01-01T00:00:00.000Z", n: 1 });
  });

  it("reads a ToolError by shape (another copy of the SDK, or an error rebuilt after RPC)", () => {
    expect(serializeError(Object.assign(new Error("m"), { name: "ToolError", code: "A", retryable: true }))).toMatchObject({ code: "A", retryable: true });
  });

  it("stores something thrown that is shaped like a ToolError as one, as the step treats it", () => {
    expect(serializeError({ name: "ToolError", code: "FAKE", message: "m" })).toEqual({ name: "ToolError", message: "m", code: "FAKE", retryable: false });
    expect(serializeError({ name: "ToolError", code: "FAKE" })).toMatchObject({ message: "FAKE" });
  });

  it("gives other errors no code, whatever properties they carry", () => {
    const stored = serializeError(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT", retryable: true, details: { a: 1 } }));
    expect(stored).toEqual({ name: "Error", message: "ENOENT: no such file", stack: expect.any(String) });
    expect(serializeError("boom")).toEqual({ name: "Error", message: "boom" });
  });
});

const never = (): never => {
  throw new Error("not used");
};

describe("ctx.payment.refund", () => {
  const bill = { id: "b1", url: "https://pay.test/b1", status: "pending" as const, amount: 5, currency: "MYR", referenceId: "r" };
  const refundAct = (attempts: { n: number }) =>
    define(
      async (ctx) => {
        await (ctx as unknown as { step: typeof ctx.step; payment: Providers["payment"] }).step.do("refund", { retries: 3 }, async () => {
          attempts.n++;
          return (ctx as unknown as { payment: Required<Providers["payment"]> }).payment.refund({ billId: "b1" });
        });
      },
      { capabilities: ["payment"] } as never,
    );

  it("is callable on an adapter that leaves refund out: it throws NotSupportedError and the step does not retry", async () => {
    const attempts = { n: 0 };
    const h = harness(refundAct(attempts), { providers: { payment: { createBill: async () => bill, getBill: async () => bill } } });
    const { run } = await h.start();
    expect(run.status).toBe("FAILED");
    expect(attempts.n).toBe(1);
    expect(run.error).toMatchObject({ name: "NotSupportedError", message: "refund is not supported by this payment provider" });
  });

  it("does not retry an adapter's own NotSupportedError either", async () => {
    const attempts = { n: 0 };
    const refund = async () => {
      throw new NotSupportedError("Billplz", "refund");
    };
    const h = harness(refundAct(attempts), { providers: { payment: { createBill: async () => bill, getBill: async () => bill, refund } } });
    const { run } = await h.start();
    expect(run.status).toBe("FAILED");
    expect(attempts.n).toBe(1);
    expect(run.error).toMatchObject({ name: "NotSupportedError", message: "refund is not supported by Billplz" });
  });

  it("still must be called inside a step", async () => {
    const h = harness(
      define((ctx) => (ctx as unknown as { payment: Required<Providers["payment"]> }).payment.refund({ billId: "b1" }), { capabilities: ["payment"] } as never),
      { providers: { payment: { createBill: async () => bill, getBill: async () => bill } } },
    );
    const { run } = await h.start();
    expect(run.error?.message).toMatch(/ctx\.payment\.refund\(\) must be called inside ctx\.step\.do/);
  });

  it("leaves other missing members undefined", async () => {
    const h = harness(
      define(async (ctx) => typeof (ctx as unknown as { payment: Record<string, unknown> }).payment.capture, { capabilities: ["payment"] } as never),
      { providers: { payment: { createBill: async () => bill, getBill: async () => bill } } },
    );
    expect((await h.start()).run).toMatchObject({ status: "COMPLETED", output: "undefined" });
  });
});
