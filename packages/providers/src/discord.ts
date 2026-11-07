// Docs: https://discord.com/developers/docs/resources/message#create-message and https://discord.com/developers/docs/resources/webhook#execute-webhook
// Buttons: https://discord.com/developers/docs/components/reference#button and
// https://discord.com/developers/docs/interactions/receiving-and-responding
import { z } from "zod";
import {
  WebhookVerificationError,
  approversCredentialField,
  clickOutcomeText,
  decidedMessageText,
  encodeButtonPayload,
  formatApprovers,
  isListedApprover,
  jsonReply,
  parseApprovers,
  parseButtonPayload,
  type ApproverRules,
  type ButtonClick,
  type ClickOutcome,
  type ProviderDefinition,
} from "./contract.js";
import type { ApprovalPrompt, MessagingProvider } from "@actuate/sdk";
import { htmlToDiscord } from "./chat-format.js";
import { ProviderApiError, idempotencyNonce, optionalString, parseWith, requestJson } from "./util.js";

const MAX_LENGTH = 2000;
/** A link button's `url` is at most 512 characters (components reference). */
export const DISCORD_MAX_BUTTON_URL = 512;
/** A button's `custom_id` is 1-100 characters. */
export const DISCORD_MAX_CUSTOM_ID = 100;
/** How far X-Signature-Timestamp may be from now: Discord gives no window, so we keep replays to 5 minutes. */
const MAX_SKEW_MS = 5 * 60 * 1000;

// Snowflakes: 17-20 digits today; a little slack either side for old and future IDs.
const SNOWFLAKE = /^\d{15,21}$/;
const approverRules: ApproverRules = { provider: "Discord", user: SNOWFLAKE, userHint: "Discord user IDs", role: SNOWFLAKE };

const schema = z
  .object({
    botToken: optionalString(),
    webhookUrl: optionalString().refine(
      (v) => v === undefined || /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(v),
      "webhookUrl must be a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)",
    ),
    defaultChannel: optionalString(),
    publicKey: optionalString()
      .refine((v) => v === undefined || /^[0-9a-fA-F]{64}$/.test(v), "publicKey must be the 64-character hex Public Key from your application's General Information page")
      .transform((v) => v?.toLowerCase()),
    approvers: optionalString(),
  })
  .refine((c) => c.botToken || c.webhookUrl, { message: "Set botToken (to post to any channel) or webhookUrl (one fixed channel)" });
export type DiscordCredentials = z.output<typeof schema>;

// ---------------------------------------------------------------- components

type Button =
  | { type: 2; style: 3 | 4; label: string; custom_id: string }
  | { type: 2; style: 5; label: string; url: string };
interface ActionRow {
  type: 1;
  components: Button[];
}

const linkable = (url: string | undefined): url is string => typeof url === "string" && url.length <= DISCORD_MAX_BUTTON_URL && /^https?:\/\//i.test(url);

/**
 * The action row for an approval or input message, or null for text only.
 *
 * - `interactive` (bot token and public key, sent through the bot, the runtime made a nonce): Approve (Success) and
 *   Reject (Danger) buttons whose `custom_id` is the button payload; clicks come to the Interactions Endpoint URL.
 * - Otherwise link buttons (Link style, no interaction) to the signed confirm pages, when every URL fits in 512
 *   characters; an input request gets one "Answer" link button. A longer URL leaves the message as text only.
 *
 * The content keeps the links in every case.
 */
function approvalComponents(approval: ApprovalPrompt | undefined, interactive: boolean): ActionRow[] | null {
  if (!approval) return null;
  if (approval.kind === "input") {
    return linkable(approval.answerUrl) ? [{ type: 1, components: [{ type: 2, style: 5, label: "Answer", url: approval.answerUrl }] }] : null;
  }
  if (interactive && approval.buttons) {
    try {
      const { route, nonce } = approval.buttons;
      return [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: "Approve", custom_id: encodeButtonPayload({ route, nonce, action: "approve" }) },
            { type: 2, style: 4, label: "Reject", custom_id: encodeButtonPayload({ route, nonce, action: "reject" }) },
          ],
        },
      ];
    } catch {
      // A malformed route or nonce: fall back to link buttons below.
    }
  }
  if (!linkable(approval.approveUrl) || !linkable(approval.rejectUrl)) return null;
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 5, label: "Approve", url: approval.approveUrl },
        { type: 2, style: 5, label: "Reject", url: approval.rejectUrl },
      ],
    },
  ];
}

// ---------------------------------------------------------------- interactions

const enc = new TextEncoder();

function hexBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// The imported public key, kept for the next request (a CryptoKey holds no I/O, so workerd may share it).
let cachedKey: { hex: string; key: CryptoKey } | null = null;
async function publicKeyFor(hex: string): Promise<CryptoKey> {
  if (cachedKey?.hex === hex) return cachedKey.key;
  const key = await crypto.subtle.importKey("raw", hexBytes(hex)!, { name: "Ed25519" }, false, ["verify"]);
  cachedKey = { hex, key };
  return key;
}

/**
 * Verify Discord's `X-Signature-Ed25519` (hex) over `X-Signature-Timestamp` + the raw body with the application's
 * public key, and that the timestamp (Unix seconds) is within 5 minutes of now. One error for every failure.
 */
export async function verifyDiscordSignature(publicKey: string, signature: string | null, timestamp: string | null, body: string, now = Date.now()): Promise<void> {
  const fail = () => new WebhookVerificationError("Discord signature verification failed");
  const sig = signature && signature.length === 128 ? hexBytes(signature) : null;
  if (!sig || !timestamp || !/^\d{1,12}$/.test(timestamp)) throw fail();
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: "Ed25519" }, await publicKeyFor(publicKey), sig, enc.encode(timestamp + body));
  } catch {
    ok = false;
  }
  if (!ok || Math.abs(now - Number(timestamp) * 1000) > MAX_SKEW_MS) throw fail();
}

interface DiscordUser {
  id?: string;
  username?: string;
  global_name?: string | null;
}
interface Interaction {
  type?: number;
  data?: { custom_id?: unknown; component_type?: number };
  member?: { user?: DiscordUser; roles?: unknown };
  user?: DiscordUser;
  message?: { content?: unknown };
}

const NOT_OURS = "This app only handles Actuate approval buttons.";

// Discord markdown and mention characters in a clicker's name, so "Approved by *Bob*" shows the name as typed.
const escapeMarkdown = (s: string) => s.replace(/[\\*_~`|<>#@[\]]/g, "\\$&");
const plainOutcome = (outcome: ClickOutcome): ClickOutcome => ("by" in outcome ? { ...outcome, by: escapeMarkdown(outcome.by) } : outcome);

/** An ephemeral reply, seen by the clicker only (CHANNEL_MESSAGE_WITH_SOURCE with the EPHEMERAL flag). */
const ephemeral = (content: string) => jsonReply({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });

export const discord: ProviderDefinition<DiscordCredentials, "messaging"> = {
  kind: "discord",
  capability: "messaging",
  label: "Discord",
  credentialFields: [
    {
      key: "botToken",
      label: "Bot token",
      secret: true,
      optional: true,
      help: "From your Discord application's Bot page. Posts to any channel the bot can see; `to` is a channel ID.",
    },
    {
      key: "webhookUrl",
      label: "Webhook URL",
      secret: true,
      optional: true,
      help: "Simpler: Channel settings → Integrations → Webhooks. Posts to that channel, and `to` is ignored.",
    },
    { key: "defaultChannel", label: "Default channel ID", secret: false, optional: true, help: "Used with the bot token when `to` is empty." },
    {
      key: "publicKey",
      label: "Public key",
      secret: false,
      optional: true,
      help: "For Approve and Reject buttons (needs the bot token): your application's General Information → Public Key. Then paste Actuate's Interactions URL into Interactions Endpoint URL there.",
    },
    approversCredentialField(
      "Optional: who may decide with a button. Discord user IDs, and role:<role ID> for everyone with a role, separated by spaces or commas (Developer Mode, then right-click → Copy ID). Empty: anyone in the channel. The signed links in the message still work for whoever holds them.",
    ),
  ],
  parseCredentials(input) {
    const c = parseWith("Discord", schema, input);
    return { ...c, approvers: formatApprovers(parseApprovers(c.approvers, approverRules)) };
  },
  create(credentials, ctx): MessagingProvider {
    return {
      async send(to, text, options) {
        const content = options?.format === "html" ? htmlToDiscord(text) : text;
        if (content.length > MAX_LENGTH) throw new Error(`Discord messages are at most ${MAX_LENGTH} characters (this one is ${content.length})`);
        // Never ping @everyone or roles from automation.
        const message = { content, allowed_mentions: { parse: ["users"] } };
        const channel = (to ?? "").trim() || credentials.defaultChannel;
        const viaBot = Boolean(credentials.botToken && channel);
        // Interactive buttons only from the bot (channel webhooks can't send them) and only when clicks can reach us.
        const components = approvalComponents(options?.approval, viaBot && Boolean(credentials.publicKey));
        // A 400 for the components (a URL Discord refuses) means nothing was posted: send the text alone, which has
        // the same links.
        const post = async <T>(url: (withComponents: boolean) => string, init: (body: object) => RequestInit): Promise<T> => {
          if (components) {
            try {
              return await requestJson<T>("Discord", ctx.fetch, url(true), init({ ...message, components }));
            } catch (err) {
              if (!(err instanceof ProviderApiError && err.status === 400)) throw err;
            }
          }
          return requestJson<T>("Discord", ctx.fetch, url(false), init(message));
        };
        if (viaBot) {
          if (!/^\d{5,25}$/.test(channel!)) throw new Error("Discord send needs `to` as a numeric channel ID");
          // Idempotency: Create Message checks `nonce` (at most 25 characters) for uniqueness over the past few
          // minutes when `enforce_nonce` is set, and returns the earlier message instead of posting again. So a
          // quick retry is deduplicated; one after a longer backoff may post twice.
          const nonce = options?.idempotencyKey ? await idempotencyNonce(options.idempotencyKey, 25) : undefined;
          const res = await post<{ id: string }>(
            () => `https://discord.com/api/v10/channels/${channel}/messages`,
            (body) => ({
              method: "POST",
              headers: { authorization: `Bot ${credentials.botToken}`, "content-type": "application/json" },
              body: JSON.stringify(nonce ? { ...body, nonce, enforce_nonce: true } : body),
            }),
          );
          return { id: res.id, channel: "discord" };
        }
        if (!credentials.webhookUrl) throw new Error("Discord send needs `to` as a channel ID (or set a default channel)");
        // Execute Webhook takes no nonce: webhook sends cannot be deduplicated, so the idempotency key is unused.
        // A channel webhook isn't application-owned: with `with_components=true` it may send link buttons, never
        // interactive ones.
        const res = await post<{ id?: string }>(
          (withComponents) => `${credentials.webhookUrl}?wait=true${withComponents ? "&with_components=true" : ""}`,
          (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        );
        return { id: res?.id ?? "webhook", channel: "discord" };
      },
    };
  },

  routeHint(body) {
    try {
      const i = JSON.parse(body) as Interaction;
      return i?.type === 3 ? (parseButtonPayload(i.data?.custom_id)?.route ?? null) : null;
    } catch {
      return null;
    }
  },

  /**
   * Discord's Interactions Endpoint URL. Without a public key this provider takes no interactions (null). With one,
   * every request must carry a valid Ed25519 signature (else 401, which Discord's endpoint check also expects), and
   * every verified request gets an answer, so nothing falls through to `parseWebhook` (Discord has none):
   *
   * - PING → PONG (`{"type":1}`).
   * - A click on an Approve or Reject button (MESSAGE_COMPONENT with an `ap1:` custom_id) → the click.
   * - Autocomplete → an empty choice list; any other interaction (a slash command, another button of the same
   *   application, a modal) → a polite ephemeral "This app only handles Actuate approval buttons.", so the user
   *   doesn't see "This interaction failed".
   *
   * The body is read once from `request.clone()`.
   */
  async parseInteraction(request, credentials) {
    if (!credentials.publicKey) return null;
    const body = await request.clone().text();
    await verifyDiscordSignature(credentials.publicKey, request.headers.get("x-signature-ed25519"), request.headers.get("x-signature-timestamp"), body);
    let interaction: Interaction;
    try {
      interaction = JSON.parse(body) as Interaction;
    } catch {
      return { reply: jsonReply({ error: "Interaction body must be JSON" }, 400) };
    }
    if (interaction?.type === 1) return { reply: jsonReply({ type: 1 }) };
    if (interaction?.type === 4) return { reply: jsonReply({ type: 8, data: { choices: [] } }) };
    const payload = interaction?.type === 3 ? parseButtonPayload(interaction.data?.custom_id) : null;
    // `member` in a guild, `user` in a DM.
    const user = interaction?.member?.user ?? interaction?.user;
    if (!payload || typeof user?.id !== "string") return { reply: ephemeral(NOT_OURS) };
    const name = user.global_name || user.username;
    const roles = Array.isArray(interaction.member?.roles) ? interaction.member.roles.filter((r): r is string => typeof r === "string") : undefined;
    const click: ButtonClick = {
      ...payload,
      actor: { id: user.id, ...(name ? { name } : {}), ...(roles ? { roles } : {}) },
      context: { text: typeof interaction.message?.content === "string" ? interaction.message.content : "" },
    };
    return { click };
  },

  isApprover: (actor, credentials) => isListedApprover(parseApprovers(credentials.approvers, approverRules), actor),

  /**
   * Answer in the interaction response itself (application/json), so no follow-up is needed: a decided click
   * edits the message (UPDATE_MESSAGE, type 7: links and buttons removed, "Approved by ... at HH:MM UTC");
   * anything else tells only the clicker (type 4 with the EPHEMERAL flag).
   *
   * If the response misses Discord's 3-second deadline, the user sees "This interaction failed" but the decision
   * still stands; the message then keeps its buttons (a later click says "Already ..."). A fallback could edit it
   * with the bot token (PATCH /channels/{channel_id}/messages/{message_id}, ids from the interaction); not built.
   */
  respondInteraction(click, outcome) {
    const shown = plainOutcome(outcome);
    if (shown.status === "decided") {
      const original = (click.context as { text?: unknown } | null)?.text;
      let content = decidedMessageText(typeof original === "string" ? original : "", { ...shown, status: "decided" });
      if (content.length > MAX_LENGTH) {
        const line = clickOutcomeText(shown);
        content = `${content.slice(0, MAX_LENGTH - line.length - 3)}…\n\n${line}`;
      }
      return { reply: jsonReply({ type: 7, data: { content, components: [], allowed_mentions: { parse: [] } } }) };
    }
    return { reply: ephemeral(clickOutcomeText(shown)) };
  },
};
