import { describe, expect, it } from "vitest";
import { fakePayment } from "../src/index.js";

describe("fakePayment (actuate dev)", () => {
  it("creates bills paid through the local events route", async () => {
    const pay = fakePayment("http://localhost:9999", () => {});
    const bill = await pay.createBill({ amount: 50, referenceId: "run_1" });
    expect(bill.url).toBe("http://localhost:9999/events/payment.run_1");
    expect(await pay.getBill(bill.id)).toEqual(bill);
  });

  it("refunds, so refund templates run locally without a real provider", async () => {
    const lines: string[] = [];
    const pay = fakePayment(undefined, (l) => lines.push(l));
    expect(pay.refund).toBeTypeOf("function");
    const first = await pay.refund!({ billId: "pi_1", amount: 120, idempotencyKey: "k1" });
    expect(first).toEqual({ id: "dev-refund-1", status: "succeeded" });
    // A retried step reuses its idempotency key and gets the same refund back.
    expect(await pay.refund!({ billId: "pi_1", amount: 120, idempotencyKey: "k1" })).toEqual(first);
    expect((await pay.refund!({ billId: "pi_2" })).id).toBe("dev-refund-2");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/refund 120 on pi_1/);
  });
});
