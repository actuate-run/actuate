/**
 * A self-hosted worker with a fake chat provider that takes Approve and Reject button clicks, the way Telegram,
 * Slack and Discord do: its API is https://chat.example.test (mocked by the test), and a click is a JSON POST to
 * /providers/fakechat/webhook signed with HMAC-SHA256 of the body.
 */
import { defineActuator, z, type MessagingProvider } from "@actuate/sdk";
import { createRuntime } from "@actuate/runtime/worker";
import {
  WebhookVerificationError,
  clickOutcomeText,
  decidedMessageText,
  encodeButtonPayload,
  hmacSha256Hex,
  isListedApprover,
  jsonReply,
  parseApprovers,
  parseButtonPayload,
  providerInteractions,
  timingSafeEqual,
  type ProviderDefinition,
} from "@actuate/providers";

interface FakeCredentials {
  secret: string;
  approvers?: string;
}

const API = "https://chat.example.test";
const rules = { provider: "Fake chat", user: /^\d{1,20}$/, userHint: "numeric user IDs" };

export const fakechat: ProviderDefinition<FakeCredentials, "messaging"> = {
  kind: "fakechat",
  capability: "messaging",
  label: "Fake chat",
  credentialFields: [
    { key: "secret", label: "Signing secret", secret: true },
    { key: "approvers", label: "Approvers", secret: false, optional: true },
  ],
  parseCredentials(input) {
    const c = input as FakeCredentials;
    parseApprovers(c.approvers, rules);
    return c;
  },
  create(_credentials, ctx): MessagingProvider {
    return {
      async send(to, text, options) {
        const buttons = options?.approval?.buttons;
        const payloads = buttons ? (["approve", "reject"] as const).map((action) => encodeButtonPayload({ ...buttons, action })) : [];
        const res = await ctx.fetch(`${API}/send`, {
          method: "POST",
          body: JSON.stringify({ to, text, buttons: payloads, ...(options?.channel ? { channel: options.channel } : {}) }),
        });
        return { id: String(((await res.json()) as { id?: string }).id ?? "1"), channel: "fakechat" };
      },
    };
  },
  async parseInteraction(request, credentials) {
    if (request.headers.get("x-fake-ping")) return { reply: jsonReply({ type: 1 }) };
    const raw = await request.clone().text();
    const body = JSON.parse(raw || "{}") as { callback?: string; from?: { id: string; name?: string }; message?: { id: string; text: string } };
    if (body.callback === undefined) return null; // an ordinary message: parseWebhook's
    const sig = request.headers.get("x-fake-signature") ?? "";
    if (!timingSafeEqual(sig, await hmacSha256Hex(credentials.secret, raw))) throw new WebhookVerificationError("Fake chat signature mismatch");
    const payload = parseButtonPayload(body.callback);
    if (!payload || !body.from) return { reply: jsonReply({ ok: true }) };
    return { click: { ...payload, actor: { id: body.from.id, ...(body.from.name ? { name: body.from.name } : {}) }, context: { message: body.message ?? null } } };
  },
  isApprover: (actor, credentials) => isListedApprover(parseApprovers(credentials.approvers, rules), actor),
  respondInteraction(click, outcome, _credentials, ctx) {
    // Test hooks: a reply that throws, and a follow-up that throws synchronously.
    if (click.actor.id === "500") throw new Error("reply failed for https://chat.example.test/secret-url");
    if (click.actor.id === "501") return { reply: jsonReply({ text: clickOutcomeText(outcome) }), after: (() => { throw new Error("sync"); }) as never };
    const message = (click.context as { message: { id: string; text: string } | null }).message;
    return {
      reply: jsonReply({ text: clickOutcomeText(outcome) }),
      ...(outcome.status === "decided" && message
        ? { after: async () => void (await ctx.fetch(`${API}/edit`, { method: "POST", body: JSON.stringify({ id: message.id, text: decidedMessageText(message.text, outcome) }) })) }
        : {}),
    };
  },
  async parseWebhook(request) {
    const body = (await request.json()) as { from?: { id: string }; text?: string };
    return body.from ? { event: `message.fakechat.${body.from.id}`, payload: { text: body.text ?? "" } } : null;
  },
};

const actuator = defineActuator({
  name: "buttons",
  description: "E2E fixture: an approval with chat buttons.",
  input: z.object({ to: z.string(), channel: z.string().optional() }),
  capabilities: ["messaging"],
  async run(ctx, input) {
    const decision = await ctx.step.waitForApproval("ok", {
      message: "Refund RM 20?",
      notify: input.channel ? { to: input.to, channel: input.channel } : input.to,
      timeout: "1 hour",
    });
    return decision;
  },
});

const credentials = (env: Record<string, unknown>): FakeCredentials =>
  fakechat.parseCredentials({ secret: String(env.FAKE_SECRET), approvers: env.FAKE_APPROVERS as string | undefined });

const runtime = createRuntime(actuator, {
  providers: (env, publicUrl) => ({
    messaging: fakechat.create(credentials(env), { fetch: (input, init) => fetch(input, init), webhookUrl: `${publicUrl}/providers/fakechat/webhook`, defaultReturnUrl: publicUrl }),
  }),
  providerWebhook: async (kind, request, env) => (kind === "fakechat" ? fakechat.parseWebhook!(request, credentials(env)) : null),
  providerInteractions: (kind, env) => (kind === "fakechat" ? providerInteractions(fakechat, credentials(env)) : null),
});
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
