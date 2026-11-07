// Docs: https://docs.slack.dev/reference/methods/chat.postMessage and https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
// Buttons: https://docs.slack.dev/reference/block-kit/block-elements/button-element, .../blocks/actions-block,
// https://docs.slack.dev/reference/interaction-payloads/block_actions-payload, https://docs.slack.dev/interactivity/handling-user-interaction
// Signing: https://docs.slack.dev/authentication/verifying-requests-from-slack
import { z } from "zod";
import type { ApprovalPrompt, MessagingProvider } from "@actuate/sdk";
import {
  WebhookVerificationError,
  approversCredentialField,
  clickOutcomeText,
  decidedMessageText,
  encodeButtonPayload,
  formatApprovers,
  hmacSha256Hex,
  isListedApprover,
  parseApprovers,
  parseButtonPayload,
  textReply,
  timingSafeEqual,
  type ApproverRules,
  type ButtonClick,
  type ClickOutcome,
  type ProviderDefinition,
  type ProviderReply,
} from "./contract.js";
import { escapeSlack, htmlToSlack } from "./chat-format.js";
import { optionalString, parseWith, ProviderApiError, requestJson } from "./util.js";

const APPROVER_RULES: ApproverRules = { provider: "Slack", user: /^[UW][A-Z0-9]{2,}$/, userHint: "Slack member IDs (U... or W...)" };

const schema = z
  .object({
    botToken: optionalString().refine((v) => v === undefined || v.startsWith("xoxb-"), 'botToken must start with "xoxb-"'),
    webhookUrl: optionalString().refine(
      (v) => v === undefined || v.startsWith("https://hooks.slack.com/"),
      "webhookUrl must be a Slack incoming webhook URL (https://hooks.slack.com/...)",
    ),
    defaultChannel: optionalString(),
    signingSecret: optionalString(),
    approvers: optionalString(),
  })
  .refine((c) => c.botToken || c.webhookUrl, { message: "Set botToken (to post to any channel) or webhookUrl (one fixed channel)" });
export type SlackCredentials = z.output<typeof schema>;

// ---------------------------------------------------------------- Block Kit limits (button element, actions and section blocks)

/** A button's `text` (plain_text), at most 75 characters. */
export const SLACK_BUTTON_TEXT_MAX = 75;
/** A button's `value`, at most 2000 characters. */
export const SLACK_BUTTON_VALUE_MAX = 2000;
/** A button's `action_id` (and any `block_id`), at most 255 characters. */
export const SLACK_ACTION_ID_MAX = 255;
/** A button's `url`, at most 3000 characters. */
export const SLACK_BUTTON_URL_MAX = 3000;
/** A section block's `text`, 1 to 3000 characters. */
export const SLACK_SECTION_TEXT_MAX = 3000;
/** Blocks in one message. */
const SLACK_MAX_BLOCKS = 50;
/** Slack rejects requests whose timestamp is more than five minutes from now (replay protection). */
export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

/** The action IDs of Actuate's buttons. Interactive ones carry the button payload in `value`; link ones open a confirm page. */
export const SLACK_ACTION_IDS = {
  approve: "actuate_approve",
  reject: "actuate_reject",
  approveLink: "actuate_approve_link",
  rejectLink: "actuate_reject_link",
  answerLink: "actuate_answer_link",
} as const;

type Block = Record<string, unknown>;

/** The text as one or more mrkdwn section blocks, each within the 3000-character limit (split at a line break where possible). */
function sections(text: string, room: number): Block[] {
  const out: Block[] = [];
  let rest = text.trim() || " ";
  while (rest && out.length < room) {
    let cut = rest.length;
    if (cut > SLACK_SECTION_TEXT_MAX) {
      const nl = rest.lastIndexOf("\n", SLACK_SECTION_TEXT_MAX);
      cut = nl > SLACK_SECTION_TEXT_MAX / 2 ? nl : SLACK_SECTION_TEXT_MAX;
    }
    const part = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, "");
    out.push({ type: "section", text: { type: "mrkdwn", text: part.trim() ? part : " " } });
  }
  return out;
}

function button(text: string, actionId: string, extra: { value?: string; url?: string; style?: "primary" | "danger" }): Block | null {
  if (extra.url !== undefined && (extra.url.length > SLACK_BUTTON_URL_MAX || !/^https?:\/\//i.test(extra.url))) return null;
  return { type: "button", action_id: actionId, text: { type: "plain_text", text, emoji: false }, ...extra };
}

/**
 * The Block Kit blocks of an approval or input message: the message (mrkdwn, links included, as in `text`), then an
 * actions block. Interactive Approve and Reject buttons (payload in `value`) when the credentials have a signing
 * secret and the runtime made a button nonce; otherwise url buttons to the confirm pages. Input gets an "Answer"
 * url button. A url over Slack's 3000-character limit gets no button (the link is still in the text).
 */
export function slackApprovalBlocks(body: string, approval: ApprovalPrompt, interactive: boolean): Block[] {
  const elements: Block[] = [];
  if (approval.kind === "input") {
    const answer = approval.answerUrl ? button("Answer", SLACK_ACTION_IDS.answerLink, { url: approval.answerUrl, style: "primary" }) : null;
    if (answer) elements.push(answer);
  } else if (interactive && approval.buttons) {
    const { route, nonce } = approval.buttons;
    elements.push(
      button("Approve", SLACK_ACTION_IDS.approve, { value: encodeButtonPayload({ route, nonce, action: "approve" }), style: "primary" })!,
      button("Reject", SLACK_ACTION_IDS.reject, { value: encodeButtonPayload({ route, nonce, action: "reject" }), style: "danger" })!,
    );
  } else {
    const approve = approval.approveUrl ? button("Approve", SLACK_ACTION_IDS.approveLink, { url: approval.approveUrl, style: "primary" }) : null;
    const reject = approval.rejectUrl ? button("Reject", SLACK_ACTION_IDS.rejectLink, { url: approval.rejectUrl, style: "danger" }) : null;
    for (const b of [approve, reject]) if (b) elements.push(b);
  }
  const blocks = sections(body, elements.length ? SLACK_MAX_BLOCKS - 1 : SLACK_MAX_BLOCKS);
  if (elements.length) blocks.push({ type: "actions", block_id: "actuate_approval", elements });
  return blocks;
}

// ---------------------------------------------------------------- request signing

/**
 * Verify Slack's request signature: `X-Slack-Signature` is `v0=` + hex HMAC-SHA256 (keyed with the app's signing
 * secret) of `v0:<X-Slack-Request-Timestamp>:<raw body>`, compared in constant time, and the timestamp must be within
 * five minutes of now. Throws `WebhookVerificationError` otherwise.
 */
export async function verifySlackSignature(signingSecret: string, headers: Headers, rawBody: string, nowMs: number = Date.now()): Promise<void> {
  const timestamp = headers.get("x-slack-request-timestamp") ?? "";
  const signature = headers.get("x-slack-signature") ?? "";
  if (!signature || !timestamp) throw new WebhookVerificationError("Slack signature headers are missing");
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > SLACK_SIGNATURE_MAX_AGE_SECONDS) {
    throw new WebhookVerificationError("Slack request timestamp is outside the five-minute window");
  }
  const expected = `v0=${await hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`;
  if (!timingSafeEqual(signature, expected)) throw new WebhookVerificationError("Slack signature mismatch");
}

// ---------------------------------------------------------------- interaction payloads

interface BlockActionsPayload {
  type?: unknown;
  user?: { id?: unknown; name?: unknown; username?: unknown };
  message?: { text?: unknown };
  response_url?: unknown;
  actions?: Array<{ action_id?: unknown; value?: unknown }>;
}

/** The JSON `payload` field of a form-encoded interaction body, or null. */
function interactionPayload(raw: string, contentType: string | null): BlockActionsPayload | null {
  if (!/^application\/x-www-form-urlencoded\b/i.test(contentType ?? "")) return null;
  const field = new URLSearchParams(raw).get("payload");
  if (!field) return null;
  try {
    const parsed = JSON.parse(field) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as BlockActionsPayload) : null;
  } catch {
    return null;
  }
}

/** The first action whose `value` is one of our button payloads. */
function ourAction(payload: BlockActionsPayload) {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  for (const action of actions) {
    const parsed = action && typeof action === "object" ? parseButtonPayload(action.value) : null;
    if (parsed) return parsed;
  }
  return null;
}

/** What respondInteraction needs from the click. Never logged: the response_url lets anyone post to the conversation. */
interface SlackClickContext {
  responseUrl: string | null;
  text: string;
}

/** Slack's response URLs (hooks.slack.com, or GovSlack's hooks.slack-gov.com). Nothing else is ever posted to. */
const RESPONSE_URL = /^https:\/\/hooks\.slack(?:-gov)?\.com\/[^\s]*$/;

function clickContext(click: ButtonClick): SlackClickContext {
  const c = (click.context ?? {}) as Partial<SlackClickContext>;
  return {
    responseUrl: typeof c.responseUrl === "string" && RESPONSE_URL.test(c.responseUrl) ? c.responseUrl : null,
    text: typeof c.text === "string" ? c.text : "",
  };
}

/** The response_url body for a click's outcome: the decided message in place of the original, or an ephemeral note to the clicker. */
export function slackResponseBody(outcome: ClickOutcome, originalText: string): Record<string, unknown> {
  if (outcome.status === "decided") {
    // The original is Slack mrkdwn already; only the clicker's name is new text, so only it is escaped.
    const text = decidedMessageText(originalText, { ...outcome, status: "decided", by: escapeSlack(outcome.by) });
    return { replace_original: true, text, blocks: sections(text, SLACK_MAX_BLOCKS) };
  }
  return { response_type: "ephemeral", replace_original: false, text: escapeSlack(clickOutcomeText(outcome)) };
}

/** The ack Slack needs within 3 seconds: 200 with an empty body. */
const ACK: ProviderReply = textReply("");

export const slack: ProviderDefinition<SlackCredentials, "messaging"> = {
  kind: "slack",
  capability: "messaging",
  label: "Slack",
  credentialFields: [
    {
      key: "botToken",
      label: "Bot token",
      secret: true,
      optional: true,
      help: "xoxb-... from a Slack app with chat:write. Posts to any channel the bot is in; `to` is a channel ID like C0123456789.",
    },
    {
      key: "webhookUrl",
      label: "Incoming webhook URL",
      secret: true,
      optional: true,
      help: "Simpler: posts to the one channel the webhook was made for, and `to` is ignored.",
    },
    { key: "defaultChannel", label: "Default channel ID", secret: false, optional: true, help: "Used with the bot token when `to` is empty." },
    {
      key: "signingSecret",
      label: "Signing secret",
      secret: true,
      optional: true,
      help: "Turns on Approve and Reject buttons: the app's Basic Information > Signing Secret. Also turn on Interactivity & Shortcuts with Actuate's interactions URL as the Request URL. Without it, the buttons open the confirm pages.",
    },
    approversCredentialField(
      "Slack member IDs (U... or W...) allowed to decide with a button, separated by spaces or commas (profile > ⋯ > Copy member ID). Empty: anyone in the channel. The signed links in the message still work for whoever holds them.",
    ),
  ],
  parseCredentials(input) {
    const parsed = parseWith("Slack", schema, input);
    // Normalised ("U1 U2"), so a bad list fails here rather than at the first click.
    return { ...parsed, approvers: formatApprovers(parseApprovers(parsed.approvers, APPROVER_RULES)) };
  },
  create(credentials, ctx): MessagingProvider {
    return {
      async send(to, text, options) {
        // Idempotency: neither chat.postMessage nor incoming webhooks take an idempotency key, so
        // options.idempotencyKey is unused. A retried send can post twice.
        const body = options?.format === "html" ? htmlToSlack(text) : escapeSlack(text);
        // An approval or question: Block Kit buttons, with `text` (links included) as the notification fallback.
        const approval = options?.approval;
        const blocks = approval ? slackApprovalBlocks(body, approval, Boolean(credentials.signingSecret)) : undefined;
        const channel = (to ?? "").trim() || credentials.defaultChannel;
        if (credentials.botToken && channel) {
          const res = await requestJson<{ ok: boolean; ts?: string; channel?: string; error?: string }>(
            "Slack",
            ctx.fetch,
            "https://slack.com/api/chat.postMessage",
            {
              method: "POST",
              headers: { authorization: `Bearer ${credentials.botToken}`, "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify({ channel, text: body, ...(blocks ? { blocks } : {}), unfurl_links: false }),
            },
          );
          if (!res?.ok || !res.ts) throw new ProviderApiError("Slack", 200, res?.error ?? "chat.postMessage failed");
          return { id: `${res.channel ?? channel}:${res.ts}`, channel: "slack" };
        }
        if (!credentials.webhookUrl) throw new Error("Slack send needs `to` as a channel ID (or set a default channel)");
        // The webhook URL is a secret: requestJson strips URLs from network errors.
        await requestJson("Slack", ctx.fetch, credentials.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: body, ...(blocks ? { blocks } : {}) }),
        });
        return { id: "webhook", channel: "slack" };
      },
    };
  },

  // ---------------------------------------------------------------- button clicks

  routeHint(body, contentType) {
    // UNVERIFIED: for routing on the hosted platform only.
    const payload = interactionPayload(body, contentType);
    return payload?.type === "block_actions" ? (ourAction(payload)?.route ?? null) : null;
  },

  /**
   * Null without a signing secret (buttons are url buttons, and nothing here can verify a click). Otherwise every
   * request must carry a valid signature (else `WebhookVerificationError`); the body is read once from
   * `request.clone()`. A block_actions click on one of our Approve or Reject buttons is `{ click }`; any other
   * block_actions (a url button, which Slack also reports) gets the empty 200 ack; anything else is null.
   */
  async parseInteraction(request, credentials) {
    if (!credentials.signingSecret) return null;
    const raw = await request.clone().text();
    await verifySlackSignature(credentials.signingSecret, request.headers, raw);
    const payload = interactionPayload(raw, request.headers.get("content-type"));
    if (!payload || payload.type !== "block_actions") return null;
    const pressed = ourAction(payload);
    const id = payload.user?.id;
    if (!pressed || typeof id !== "string" || !id) return { reply: ACK };
    const named = [payload.user?.name, payload.user?.username].find((n): n is string => typeof n === "string" && n.trim() !== "");
    const context: SlackClickContext = {
      responseUrl: typeof payload.response_url === "string" ? payload.response_url : null,
      text: typeof payload.message?.text === "string" ? payload.message.text : "",
    };
    return { click: { ...pressed, actor: { id, ...(named ? { name: named } : {}) }, context: { ...context } } };
  },

  isApprover: (actor, credentials) => isListedApprover(parseApprovers(credentials.approvers, APPROVER_RULES), actor),

  /**
   * The reply is always the empty 200 ack. The follow-up posts to the click's response_url: on "decided" it
   * replaces the message (link lines and buttons gone, "Approved by ... at HH:MM UTC" in); otherwise an ephemeral
   * note only the clicker sees. Errors name no URL.
   */
  respondInteraction(click, outcome, _credentials, ctx) {
    const { responseUrl, text } = clickContext(click);
    if (!responseUrl) return { reply: ACK };
    const fetcher = ctx.fetch; // called unbound (workerd)
    return {
      reply: ACK,
      after: async () => {
        let res: Response;
        try {
          res = await fetcher(responseUrl, {
            method: "POST",
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify(slackResponseBody(outcome, text)),
          });
        } catch {
          throw new Error("Slack response_url request failed");
        }
        const answer = (await res.text().catch(() => "")).slice(0, 200);
        if (!res.ok) throw new ProviderApiError("Slack", res.status, /^[a-z_]+$/.test(answer) ? answer : "response_url update failed");
      },
    };
  },
};
