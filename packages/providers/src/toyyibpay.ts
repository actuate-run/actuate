// Docs: https://toyyibpay.com/apireference/
import { z } from "zod";
import { WebhookVerificationError, type ProviderContext, type ProviderEvent } from "./contract.js";
import type { Bill, PaymentProvider } from "@actuate/sdk";
import { type ProviderDefinitionWithWebhookLookup, looseBoolean, NotSupportedError, parseWith, ProviderApiError, readForm, requestJson, requireMyr, requiredString, toMinor, webhookFetch } from "./util.js";

const schema = z.object({
  userSecretKey: requiredString("userSecretKey"),
  categoryCode: requiredString("categoryCode"),
  /** Use dev.toyyibpay.com (needs a separate sandbox account). */
  sandbox: looseBoolean(),
  /** 0 = FPX, 1 = card, 2 = both. Card needs to be enabled on the account. */
  paymentChannel: z.enum(["0", "1", "2"], { error: 'paymentChannel must be "0" (FPX), "1" (card) or "2" (both)' }).optional().default("0"),
});
export type ToyyibPayCredentials = z.output<typeof schema>;

export function toyyibPayBase(credentials: Pick<ToyyibPayCredentials, "sandbox">): string {
  return credentials.sandbox ? "https://dev.toyyibpay.com" : "https://toyyibpay.com";
}

/** billName/billDescription accept only letters, digits, spaces and underscores. */
function sanitise(text: string, max: number): string {
  return text.replace(/[^A-Za-z0-9 _]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

interface Transaction {
  billName?: string;
  billpaymentStatus?: string;
  billpaymentAmount?: string;
  billExternalReferenceNo?: string;
  billpaymentInvoiceNo?: string;
}

function form(data: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) if (v !== undefined) p.append(k, v);
  return p.toString();
}

/** ToyyibPay answers 200 even on errors; error bodies are JSON {status:"error",msg} or bare text codes like [KEY-DID-NOT-EXIST]. */
async function call(fetcher: typeof fetch, url: string, data: Record<string, string | undefined>): Promise<unknown> {
  const body = await requestJson<unknown>("ToyyibPay", fetcher, url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(data),
  });
  if (typeof body === "string") throw new ProviderApiError("ToyyibPay", 200, body.trim().slice(0, 200) || "empty response");
  if (body && !Array.isArray(body) && typeof body === "object" && (body as { status?: string }).status === "error") {
    throw new ProviderApiError("ToyyibPay", 200, String((body as { msg?: unknown }).msg ?? "request failed"));
  }
  return body;
}

async function getTransactions(fetcher: typeof fetch, credentials: ToyyibPayCredentials, billCode: string): Promise<Transaction[]> {
  const body = await call(fetcher, `${toyyibPayBase(credentials)}/index.php/api/getBillTransactions`, {
    billCode,
    userSecretKey: credentials.userSecretKey,
  });
  // No transactions yet comes back as a non-array (e.g. [{"msg":"..."}] without payment fields, or an object).
  if (!Array.isArray(body)) return [];
  return (body as Transaction[]).filter((t) => t && typeof t === "object" && t.billpaymentStatus !== undefined);
}

const STATUS: Record<string, Bill["status"]> = { "1": "paid", "2": "pending", "3": "failed", "4": "pending" };

/** Newest first; a successful transaction wins over later failed retries. */
function summarise(txs: Transaction[]): { status: Bill["status"]; tx: Transaction | undefined } {
  const paid = txs.find((t) => t.billpaymentStatus === "1");
  if (paid) return { status: "paid", tx: paid };
  const latest = txs[0];
  return { status: latest ? (STATUS[latest.billpaymentStatus ?? ""] ?? "pending") : "pending", tx: latest };
}

export const toyyibpay: ProviderDefinitionWithWebhookLookup<ToyyibPayCredentials, "payment"> = {
  kind: "toyyibpay",
  capability: "payment",
  label: "ToyyibPay",
  credentialFields: [
    { key: "userSecretKey", label: "User secret key", secret: true },
    { key: "categoryCode", label: "Category code", secret: false, help: "Create a category in the ToyyibPay dashboard and paste its code." },
    { key: "sandbox", label: "Sandbox (dev.toyyibpay.com)", secret: false, optional: true },
    { key: "paymentChannel", label: "Payment channel", secret: false, optional: true, help: '"0" FPX (default), "1" card, "2" both.' },
  ],
  parseCredentials: (input) => parseWith("ToyyibPay", schema, input),
  create(credentials, ctx): PaymentProvider {
    const base = toyyibPayBase(credentials);
    return {
      async createBill(req) {
        const currency = requireMyr("ToyyibPay", req.currency);
        if (!req.referenceId) throw new Error("referenceId is required");
        const amountSen = toMinor(req.amount, currency);
        if (amountSen < 100) throw new Error("ToyyibPay requires an amount of at least RM 1.00");
        const label = req.description || req.referenceId;
        const hasPayer = Boolean(req.customer?.name || req.customer?.email || req.customer?.phone);
        const body = await call(ctx.fetch, `${base}/index.php/api/createBill`, {
          userSecretKey: credentials.userSecretKey,
          categoryCode: credentials.categoryCode,
          billName: sanitise(label, 30) || "Payment",
          billDescription: sanitise(label, 100) || "Payment",
          billPriceSetting: "1",
          billPayorInfo: hasPayer ? "1" : "0",
          billAmount: String(amountSen),
          billReturnUrl: req.returnUrl ?? ctx.defaultReturnUrl,
          billCallbackUrl: ctx.webhookUrl,
          billExternalReferenceNo: req.referenceId,
          billTo: req.customer?.name ?? "",
          billEmail: req.customer?.email ?? "",
          billPhone: (req.customer?.phone ?? "").replace(/\D/g, ""),
          billPaymentChannel: credentials.paymentChannel,
        });
        const code = Array.isArray(body) ? (body[0] as { BillCode?: string } | undefined)?.BillCode : undefined;
        if (!code) throw new ProviderApiError("ToyyibPay", 200, "createBill returned no BillCode");
        return { id: code, url: `${base}/${code}`, status: "pending", amount: req.amount, currency, referenceId: req.referenceId };
      },
      async getBill(id) {
        const txs = await getTransactions(ctx.fetch, credentials, id);
        const { status, tx } = summarise(txs);
        return {
          id,
          url: `${base}/${id}`,
          status,
          // ToyyibPay has no "get bill" endpoint; amount and reference are only known once a transaction exists.
          amount: tx?.billpaymentAmount ? Number(tx.billpaymentAmount) : 0,
          currency: "MYR",
          referenceId: tx?.billExternalReferenceNo ?? "",
        };
      },
      async refund() {
        throw new NotSupportedError("ToyyibPay", "refund");
      },
    };
  },
  /**
   * ToyyibPay callbacks are form posts with no signature we can check in Workers
   * (the documented `hash` is MD5), so the callback is only a hint: the status
   * is taken from getBillTransactions using the tenant's own secret key.
   */
  async parseWebhook(request: Request, credentials: ToyyibPayCredentials, ctx?: Pick<ProviderContext, "fetch">): Promise<ProviderEvent | null> {
    const fields = await readForm(request);
    const billCode = fields.billcode?.trim();
    if (!billCode || !/^[A-Za-z0-9]+$/.test(billCode)) throw new WebhookVerificationError("ToyyibPay callback has no valid billcode");
    const txs = await getTransactions(webhookFetch(ctx), credentials, billCode);
    if (txs.length === 0) throw new WebhookVerificationError("ToyyibPay callback does not match any transaction on this account");
    const { status, tx } = summarise(txs);
    if (status !== "paid" && status !== "failed") return null;
    // ToyyibPay callbacks are unsigned: trust only what the authenticated re-query returns, never the callback's order_id.
    const referenceId = tx?.billExternalReferenceNo;
    if (!referenceId) return null;
    return {
      event: `payment.${referenceId}`,
      payload: {
        provider: "toyyibpay",
        status,
        billId: billCode,
        amount: Number(tx?.billpaymentAmount ?? 0),
        currency: "MYR",
        referenceId,
        transactionRef: tx?.billpaymentInvoiceNo ?? fields.refno ?? null,
      },
    };
  },
};
