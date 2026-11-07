/**
 * Runtime side of interactive approval buttons: nonces, routes and approver labels. The payload format itself
 * (`ap1:<route>:<nonce>:<a|r>`) lives in `@actuate/providers` (`encodeButtonPayload` / `parseButtonPayload`).
 */

import type { ClickOutcome } from "@actuate/sdk";

/** The button route of a self-hosted actuator: its worker has only one actuator. */
export const LOCAL_BUTTON_ROUTE = "local";

/** A route: 1-24 characters of `[A-Za-z0-9_-]`, so a payload fits Telegram's 64-byte `callback_data`. */
export function isButtonRoute(route: unknown): route is string {
  return typeof route === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(route);
}

/** A button nonce: 96 random bits as base64url, 16 characters. */
export function newButtonNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

/** A nonce's shape, checked before any lookup. */
export function isButtonNonce(nonce: unknown): nonce is string {
  return typeof nonce === "string" && /^[A-Za-z0-9_-]{16}$/.test(nonce);
}

/** A decision as a provider's `respondInteraction` gets it: without the run and step, which are the host's. */
export function clickOutcome(decision: ButtonDecision): ClickOutcome {
  if (decision.status !== "decided" && decision.status !== "already") return decision;
  return { status: decision.status, decision: decision.decision, by: decision.by, at: decision.at };
}

/**
 * A provider kind as a button is bound to it (`RunManager.bindButtonKind`) and a click names it: 1-32 characters
 * of lowercase letters, digits and hyphens, e.g. "telegram" or "custom-webhook".
 */
export function isButtonKind(kind: unknown): kind is string {
  return typeof kind === "string" && /^[a-z0-9-]{1,32}$/.test(kind);
}

/**
 * The provider kind behind a `MessageReceipt.channel`: Resend's channel is "email", every other provider's
 * channel is its kind.
 */
export function buttonKindOfChannel(channel: string): string {
  const name = String(channel ?? "").trim().toLowerCase();
  return name === "email" ? "resend" : name;
}

/**
 * The verified `by` of a chat button decision: `<channel>:<user id>`, plus ` (<display name>)` when the provider
 * gives one, e.g. `telegram:123456789 (Alice)`. Control characters become spaces, the ID loses whitespace and is
 * cut at 64 characters, the name at 60, so the label fits `ApprovalResult.by` (120).
 */
export function chatApproverLabel(channel: string, actor: { id: string; name?: string }): string {
  const clean = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  const kind = clean(channel).replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 24) || "chat";
  const id = clean(actor.id).replace(/\s+/g, "").slice(0, 64) || "unknown";
  const name = clean(actor.name).replace(/\s+/g, " ").trim().slice(0, 60);
  return name ? `${kind}:${id} (${name})` : `${kind}:${id}`;
}

/**
 * What became of a button click, from `RunManager.decideByButton`. "decided": this click decided. "already": the
 * step was decided before (by a button, a link or the dashboard), with that decision. Both name the run and step
 * the nonce belongs to. "expired": too late. "unknown": no such nonce, another provider's click, or the step or run
 * is no longer waiting for another reason (timed out, cancelled). Assignable to `ClickOutcome`, which adds the
 * provider-side "not-approver" and "foreign"; `clickOutcome` drops `runId` and `step` for a provider's reply.
 */
export type ButtonDecision =
  | { status: "decided" | "already"; decision: "approved" | "rejected"; by: string; at: string; runId: string; step: string }
  | { status: "expired" }
  | { status: "unknown" };
