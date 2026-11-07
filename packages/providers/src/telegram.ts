// Docs: https://core.telegram.org/bots/api#sendmessage
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
  timingSafeEqual,
  withoutLinkLines,
  type ApproverRules,
  type ButtonClick,
  type ProviderDefinition,
} from "./contract.js";
import type { ApprovalPrompt, InboundMessage, MessagingProvider } from "@actuate/sdk";
import { messageEvent, optionalString, parseWith, ProviderApiError, requestJson } from "./util.js";

const schema = z.object({
  botToken: z
    .string({ error: "botToken is required" })
    .trim()
    .regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "botToken must look like 123456789:AA... (from @BotFather)"),
  /** Optional secret_token set via setWebhook; checked against X-Telegram-Bot-Api-Secret-Token. */
  webhookSecretToken: optionalString(),
  /** Optional: Telegram user IDs allowed to press Approve and Reject (normalised by parseApprovers). */
  approvers: optionalString(),
});
export type TelegramCredentials = z.output<typeof schema>;

/** Telegram user IDs are positive integers (at most 52 significant bits); chats can be negative, users can't. */
const APPROVER_RULES: ApproverRules = { provider: "Telegram", user: /^[1-9]\d{0,15}$/, userHint: "Telegram numeric user IDs (e.g. 123456789)" };

interface TelegramResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
  error_code?: number;
}

/** https://core.telegram.org/bots/api#inlinekeyboardbutton: exactly one of url or callback_data per button here. */
type InlineButton = { text: string; url: string } | { text: string; callback_data: string };
interface InlineKeyboardMarkup {
  inline_keyboard: InlineButton[][];
}

/** editMessageText's text limit: 1-4096 characters after entity parsing (we send plain text). */
const MAX_TEXT = 4096;
/** answerCallbackQuery's notification text: 0-200 characters. */
const MAX_CALLBACK_TEXT = 200;

/**
 * A URL Telegram takes for a `url` button: "HTTP or tg:// URL". We only ever put http(s) confirm-page links on
 * buttons, and skip hosts Telegram refuses as button URLs (localhost, bare names, IP literals: `actuate dev`
 * without a public URL), because one bad button URL fails the whole sendMessage. The text keeps the links.
 */
function buttonUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return null;
  return url.toString();
}

/**
 * The inline keyboard for an approval notification, or undefined for none:
 * - an approval with a button nonce, when the bot can receive clicks (a webhook secret token): Approve and Reject
 *   callback buttons, `callback_data` = `encodeButtonPayload` (at most 47 of Telegram's 64 bytes);
 * - any other approval: URL buttons to the Approve and Reject confirm pages;
 * - input: an "Answer" URL button.
 */
function approvalKeyboard(approval: ApprovalPrompt | undefined, credentials: TelegramCredentials): InlineKeyboardMarkup | undefined {
  if (!approval) return undefined;
  if (approval.kind === "input") {
    const answer = buttonUrl(approval.answerUrl);
    return answer ? { inline_keyboard: [[{ text: "Answer", url: answer }]] } : undefined;
  }
  if (approval.kind !== "approval") return undefined;
  if (approval.buttons && credentials.webhookSecretToken) {
    try {
      const { route, nonce } = approval.buttons;
      return {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: encodeButtonPayload({ route, nonce, action: "approve" }) },
            { text: "Reject", callback_data: encodeButtonPayload({ route, nonce, action: "reject" }) },
          ],
        ],
      };
    } catch {
      // A malformed route or nonce: link buttons instead (the runtime never makes one, but never fail the send).
    }
  }
  const approve = buttonUrl(approval.approveUrl);
  const reject = buttonUrl(approval.rejectUrl);
  return approve && reject
    ? { inline_keyboard: [[{ text: "Approve", url: approve }, { text: "Reject", url: reject }]] }
    : undefined;
}

const hasUrlButton = (markup: InlineKeyboardMarkup | undefined) => Boolean(markup?.inline_keyboard.some((row) => row.some((b) => "url" in b)));

/** What respondInteraction needs from the callback query. Never logged. */
interface TelegramClickContext {
  callbackQueryId: string;
  /** Null when the query has no accessible message (inline mode, or a message older than the bot can see). */
  chatId: number | string | null;
  messageId: number | null;
  /** The message text as the chat shows it (entities removed). */
  text: string;
}

function checkSecret(request: Request, credentials: TelegramCredentials): void {
  const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!timingSafeEqual(got, credentials.webhookSecretToken ?? "")) throw new WebhookVerificationError("Telegram secret token mismatch");
}

const parseJson = (raw: string): TelegramUpdate | null => {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as TelegramUpdate) : null;
  } catch {
    return null;
  }
};

/** "Wei Tan", or "@wei" when the user has no name we can use. Unverified: the user chose it. */
function displayName(from: TelegramUser): string | undefined {
  const name = [from.first_name, from.last_name].filter((s) => typeof s === "string" && s.trim()).join(" ").trim();
  if (name) return name;
  return typeof from.username === "string" && from.username ? `@${from.username}` : undefined;
}

type DecidedOutcome = Parameters<typeof decidedMessageText>[1];

/** The edited text: the original without its link lines, then the decision; trimmed to Telegram's 4096 characters. */
function editedText(original: string, outcome: DecidedOutcome): string {
  const full = decidedMessageText(original, outcome);
  if (full.length <= MAX_TEXT) return full;
  const line = clickOutcomeText(outcome);
  return `${withoutLinkLines(original).slice(0, MAX_TEXT - line.length - 3).trimEnd()}…\n\n${line}`;
}

export const telegram: ProviderDefinition<TelegramCredentials, "messaging"> = {
  kind: "telegram",
  capability: "messaging",
  label: "Telegram Bot",
  credentialFields: [
    { key: "botToken", label: "Bot token", secret: true, help: "Create a bot with @BotFather and paste its token." },
    {
      key: "webhookSecretToken",
      label: "Webhook secret token",
      secret: true,
      optional: true,
      help: "Needed to receive messages and Approve/Reject button clicks: any string of A-Z, a-z, 0-9, _ and -, passed as secret_token when you call setWebhook (with allowed_updates [\"message\",\"callback_query\"]). Without it, approvals get link buttons.",
    },
    approversCredentialField(
      "Telegram user IDs allowed to press Approve and Reject, separated by spaces or commas. Empty: anyone in the chat. This restricts the buttons only: the links in the message still work for whoever has them.",
    ),
  ],
  parseCredentials(input) {
    const parsed = parseWith("Telegram", schema, input);
    const approvers = formatApprovers(parseApprovers(parsed.approvers, APPROVER_RULES));
    return { ...parsed, approvers };
  },
  create(credentials, ctx): MessagingProvider {
    const sendMessage = (payload: Record<string, unknown>) =>
      // The bot token is part of the URL, so errors never include the URL (requestJson strips it).
      requestJson<TelegramResponse>("Telegram", ctx.fetch, `https://api.telegram.org/bot${credentials.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    return {
      async send(to, text, options) {
        if (!to?.trim()) throw new Error("Telegram send needs a chat ID in `to`");
        // Idempotency: the Bot API's sendMessage has no idempotency key or dedup field, so options.idempotencyKey
        // is unused. A retried step whose first attempt reached Telegram sends the message again.
        const payload = { chat_id: to.trim(), text, ...(options?.format === "html" ? { parse_mode: "HTML" } : {}) };
        const markup = approvalKeyboard(options?.approval, credentials);
        let body: TelegramResponse;
        try {
          body = await sendMessage(markup ? { ...payload, reply_markup: markup } : payload);
        } catch (err) {
          // Telegram refuses the whole message over a button URL it doesn't like (400 "...button URL... invalid"):
          // nothing was sent, so send it again without the buttons. The text carries the same links.
          if (!(err instanceof ProviderApiError && err.status === 400 && hasUrlButton(markup) && /button|url/i.test(err.message))) throw err;
          body = await sendMessage(payload);
        }
        if (!body?.ok || !body.result) throw new ProviderApiError("Telegram", body?.error_code ?? 200, body?.description ?? "sendMessage failed");
        return { id: String(body.result.message_id), channel: "telegram" };
      },
    };
  },
  routeHint(body) {
    // UNVERIFIED (no secret check): only for routing on the hosted platform.
    return parseButtonPayload(parseJson(body)?.callback_query?.data)?.route ?? null;
  },
  async parseInteraction(request, credentials) {
    // Without the secret token anyone could post fake clicks, so clicks need it (and approvals get link buttons).
    if (!credentials.webhookSecretToken) return null;
    checkSecret(request, credentials);
    // A clone: on null the same request goes on to parseWebhook, which reads the body itself.
    const query = parseJson(await request.clone().text())?.callback_query;
    if (!query || typeof query !== "object") return null;
    const payload = parseButtonPayload(query.data);
    if (!payload || typeof query.from?.id !== "number") {
      // Not one of our buttons (another callback, a game): still answer it, without text, so the clicker's
      // progress bar stops. parseWebhook would ignore it anyway.
      return typeof query.id === "string" && query.id ? { reply: jsonReply({ method: "answerCallbackQuery", callback_query_id: query.id }) } : null;
    }
    if (typeof query.id !== "string" || !query.id) return null;
    const m = query.message;
    // An InaccessibleMessage has date 0 and no text: the click still decides, there is just nothing to edit.
    const accessible = Boolean(m && m.date !== 0 && m.chat?.id !== undefined && typeof m.message_id === "number");
    const context: TelegramClickContext = {
      callbackQueryId: query.id,
      chatId: accessible ? m!.chat!.id : null,
      messageId: accessible ? m!.message_id! : null,
      text: accessible ? String(m!.text ?? m!.caption ?? "") : "",
    };
    const name = displayName(query.from);
    const click: ButtonClick = { ...payload, actor: { id: String(query.from.id), ...(name ? { name } : {}) }, context: { ...context } };
    return { click };
  },
  isApprover: (actor, credentials) => isListedApprover(parseApprovers(credentials.approvers, APPROVER_RULES), actor),
  respondInteraction(click, outcome, credentials, ctx) {
    const context = click.context as unknown as TelegramClickContext;
    // Answered in the webhook response: Telegram calls the method for us (we get no result back), and the
    // clicker's progress bar stops. Plain text, no links.
    const reply = jsonReply({
      method: "answerCallbackQuery",
      callback_query_id: context.callbackQueryId,
      text: clickOutcomeText(outcome).slice(0, MAX_CALLBACK_TEXT),
    });
    if (outcome.status !== "decided" || context.chatId === null || context.messageId === null) return { reply };
    const { chatId, messageId, text } = context;
    const decided = outcome as DecidedOutcome;
    return {
      reply,
      after: async () => {
        // Plain text (no parse_mode), so a name can't inject markup; an empty keyboard removes the buttons.
        const body = await requestJson<TelegramResponse>("Telegram", ctx.fetch, `https://api.telegram.org/bot${credentials.botToken}/editMessageText`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: editedText(text, decided), reply_markup: { inline_keyboard: [] } }),
        });
        if (!body?.ok) throw new ProviderApiError("Telegram", body?.error_code ?? 200, body?.description ?? "editMessageText failed");
      },
    };
  },
  async parseWebhook(request, credentials) {
    // Without the secret token anyone could post fake updates, so inbound needs it.
    if (!credentials.webhookSecretToken) return null;
    checkSecret(request, credentials);
    const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
    // A button click (callback_query) is parseInteraction's, never a message event, even when it isn't ours.
    if (!update || update.callback_query) return null;
    const m = update.message;
    if (!m?.chat?.id) return null;
    const from = String(m.chat.id);
    const type = m.text !== undefined ? "text" : (["photo", "video", "document", "voice", "audio", "location", "contact", "sticker"].find((k) => k in m) ?? "unknown");
    const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ");
    const message: InboundMessage = {
      channel: "telegram",
      from,
      text: m.text ?? m.caption ?? "",
      type,
      id: String(m.message_id),
      at: (m.date ?? 0) * 1000,
      ...(name ? { name } : {}),
    };
    return { event: messageEvent("telegram", from), payload: { ...message } };
  },
};

interface TelegramUser {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramUpdate {
  message?: {
    message_id: number;
    date?: number;
    chat?: { id: number | string };
    from?: { first_name?: string; last_name?: string };
    text?: string;
    caption?: string;
  } & Record<string, unknown>;
  /** https://core.telegram.org/bots/api#callbackquery */
  callback_query?: {
    id?: string;
    from?: TelegramUser;
    /** A Message, or an InaccessibleMessage (date 0). Absent for inline-mode messages. */
    message?: { message_id?: number; date?: number; chat?: { id: number | string }; text?: string; caption?: string };
    data?: string;
  };
}
