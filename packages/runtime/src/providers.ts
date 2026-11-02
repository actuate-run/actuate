import type { Bill, CreateBillRequest, HttpProvider, MessageReceipt, MessagingProvider, PaymentProvider, Providers } from "@actuate/sdk";

/**
 * Check a hostname against an allow-list. Entries are exact hostnames or
 * `*.example.com` wildcards (which match subdomains, not the apex).
 */
export function hostAllowed(hostname: string, allow: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => {
    const e = entry.toLowerCase().replace(/\.$/, "");
    return e.startsWith("*.") ? host.endsWith(e.slice(1)) && host.length > e.length - 1 : host === e;
  });
}

export interface HttpProviderOptions {
  allow: readonly string[];
  /** Origins that belong to this actuator; requests to them are refused to stop webhook loops. */
  selfOrigins?: readonly string[];
  fetch?: typeof fetch;
}

/** Outbound HTTP limited to declared domains, HTTPS only, never back to the actuator itself. */
export function createHttpProvider(options: HttpProviderOptions): HttpProvider {
  const doFetch = options.fetch ?? fetch;
  return {
    async fetch(input, init) {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.protocol !== "https:") throw new Error(`ctx.http: only https:// URLs are allowed (got ${url.protocol}).`);
      if (options.selfOrigins?.includes(url.origin)) throw new Error("ctx.http: an actuator cannot call its own URL.");
      if (!hostAllowed(url.hostname, options.allow)) {
        throw new Error(`ctx.http: ${url.hostname} is not in this actuator's http.allow list.`);
      }
      return doFetch(url.toString(), { ...init, redirect: "manual" });
    },
  };
}

/** Prints messages to the console instead of sending them. Used by `actuate dev`. */
export function consoleMessaging(log: (line: string) => void = console.log): MessagingProvider {
  let n = 0;
  return {
    async send(to, text, options): Promise<MessageReceipt> {
      const id = `dev-msg-${++n}`;
      log(`\n📨  [dev messaging → ${to}${options?.channel ? ` via ${options.channel}` : ""}]\n${text}\n`);
      return { id, channel: options?.channel ?? "console" };
    },
  };
}

/**
 * A fake payment provider for local development. Bills are "paid" by posting
 * the event `payment.<referenceId>` to the actuator's /events endpoint.
 */
export function fakePayment(baseUrl = "http://localhost:8787"): PaymentProvider {
  const bills = new Map<string, Bill>();
  return {
    async createBill(request: CreateBillRequest): Promise<Bill> {
      const id = `dev-bill-${bills.size + 1}`;
      const bill: Bill = {
        id,
        url: `${baseUrl}/events/payment.${encodeURIComponent(request.referenceId)}`,
        status: "pending",
        amount: request.amount,
        currency: request.currency ?? "MYR",
        referenceId: request.referenceId,
      };
      bills.set(id, bill);
      return bill;
    },
    async getBill(id) {
      const bill = bills.get(id);
      if (!bill) throw new Error(`Unknown bill ${id}`);
      return bill;
    },
  };
}

/** Providers for `actuate dev`: console messaging and a fake payment provider. */
export function devProviders(baseUrl?: string): Partial<Providers> {
  return { messaging: consoleMessaging(), payment: fakePayment(baseUrl) };
}
