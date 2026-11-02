import type { ProviderCapability, ProviderDefinition } from "./contract.js";
import { anthropic } from "./anthropic.js";
import { billplz } from "./billplz.js";
import { chip } from "./chip.js";
import { discord } from "./discord.js";
import { google } from "./google.js";
import { openai } from "./openai.js";
import { openaiCompatible } from "./openai-compatible.js";
import { resend } from "./resend.js";
import { slack } from "./slack.js";
import { stripe } from "./stripe.js";
import { telegram } from "./telegram.js";
import { toyyibpay } from "./toyyibpay.js";
import { whatsapp } from "./whatsapp.js";

export { anthropic, billplz, chip, discord, google, openai, openaiCompatible, resend, slack, stripe, telegram, toyyibpay, whatsapp };
export { NotSupportedError, ProviderApiError } from "./util.js";
export { verifyStripeSignature } from "./stripe.js";
export { billplzSignature } from "./billplz.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProviderDefinition = ProviderDefinition<any, ProviderCapability>;

/** Every provider adapter, keyed by kind. */
export const PROVIDERS = {
  telegram,
  whatsapp,
  slack,
  discord,
  resend,
  stripe,
  toyyibpay,
  billplz,
  chip,
  anthropic,
  openai,
  google,
  "openai-compatible": openaiCompatible,
} as const satisfies Record<string, AnyProviderDefinition>;

export type ProviderKind = keyof typeof PROVIDERS;

export function isProviderKind(kind: string): kind is ProviderKind {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, kind);
}

/** Look up a provider by kind; undefined for unknown kinds. */
export function getProvider<K extends ProviderKind>(kind: K): (typeof PROVIDERS)[K];
export function getProvider(kind: string): AnyProviderDefinition | undefined;
export function getProvider(kind: string): AnyProviderDefinition | undefined {
  return isProviderKind(kind) ? PROVIDERS[kind] : undefined;
}

/** Providers offering one capability, for the dashboard's picker. */
export function providersFor(capability: ProviderCapability): AnyProviderDefinition[] {
  return Object.values(PROVIDERS).filter((p: AnyProviderDefinition) => p.capability === capability);
}
