import type { MessagingProvider, Providers } from "@actuate/sdk";
import { combineMessaging } from "./multi.js";
import type { ProviderCapability, ProviderContext, ProviderEvent, ProviderWebhookResult } from "./contract.js";
import { WebhookVerificationError } from "./contract.js";
import { PROVIDERS, getProvider, type AnyProviderDefinition } from "./registry.js";

/** `botToken` → `BOT_TOKEN`, `xSignatureKey` → `X_SIGNATURE_KEY`. */
export function envName(kind: string, field: string): string {
  return `${kind.replace(/-/g, "_")}_${field.replace(/([a-z0-9])([A-Z])/g, "$1_$2")}`.toUpperCase();
}

/** The environment variables a provider reads, e.g. telegram → ["TELEGRAM_BOT_TOKEN", ...]. */
export function envVarsFor(kind: string): Array<{ name: string; optional: boolean; label: string }> {
  const def = getProvider(kind);
  if (!def) throw new Error(`Unknown provider "${kind}"`);
  return def.credentialFields.map((f) => ({ name: envName(kind, f.key), optional: Boolean(f.optional), label: f.label }));
}

export interface ConfiguredProvider {
  capability: ProviderCapability;
  definition: AnyProviderDefinition;
  credentials: unknown;
}

const CAPABILITIES: ProviderCapability[] = ["messaging", "payment", "llm"];

/**
 * Read provider choices and credentials from environment variables:
 *
 * ```
 * ACTUATE_MESSAGING=telegram,slack     (several: the first is the default channel)
 * TELEGRAM_BOT_TOKEN=123:abc
 * SLACK_WEBHOOK_URL=https://hooks.slack.com/...
 * ACTUATE_PAYMENT=billplz
 * BILLPLZ_API_KEY=...  BILLPLZ_COLLECTION_ID=...  BILLPLZ_X_SIGNATURE_KEY=...
 * ```
 *
 * Capabilities without an `ACTUATE_<CAPABILITY>` variable are left out.
 */
export function configuredFromEnv(env: Record<string, unknown>): ConfiguredProvider[] {
  const out: ConfiguredProvider[] = [];
  for (const capability of CAPABILITIES) {
    const value = env[`ACTUATE_${capability.toUpperCase()}`];
    if (typeof value !== "string" || !value.trim()) continue;
    // Messaging takes a list (the first is the default channel); payment and llm take one.
    const kinds = value.split(",").map((k) => k.trim()).filter(Boolean);
    if (kinds.length > 1 && capability !== "messaging") {
      throw new Error(`ACTUATE_${capability.toUpperCase()} takes one provider; only messaging can list several.`);
    }
    if (new Set(kinds).size !== kinds.length) throw new Error(`ACTUATE_${capability.toUpperCase()} lists a provider twice.`);
    for (const kind of kinds) out.push(configureFromEnv(env, capability, kind));
  }
  return out;
}

function configureFromEnv(env: Record<string, unknown>, capability: ProviderCapability, kind: string): ConfiguredProvider {
  const definition = getProvider(kind);
  if (!definition || definition.capability !== capability) {
    const options = Object.values(PROVIDERS).filter((p) => p.capability === capability).map((p) => p.kind);
    throw new Error(`ACTUATE_${capability.toUpperCase()}="${kind}" is not a ${capability} provider. Use one of: ${options.join(", ")}.`);
  }
  const input: Record<string, unknown> = {};
  for (const field of definition.credentialFields) {
    const value = env[envName(kind, field.key)];
    if (value !== undefined && value !== "") input[field.key] = value;
  }
  return { capability, definition, credentials: definition.parseCredentials(input) };
}

/** Build provider clients from {@link configuredFromEnv}. `baseUrl` is the actuator's public origin. */
export function providersFromEnv(env: Record<string, unknown>, baseUrl: string, fetchImpl: typeof fetch = fetch): Partial<Providers> {
  const providers: Partial<Providers> = {};
  const messaging: Array<{ kind: string; provider: MessagingProvider }> = [];
  for (const p of configuredFromEnv(env)) {
    const ctx: ProviderContext = {
      fetch: fetchImpl,
      webhookUrl: `${baseUrl}/providers/${p.definition.kind}/webhook`,
      defaultReturnUrl: `${baseUrl}/health`,
    };
    const client = p.definition.create(p.credentials, ctx);
    if (p.capability === "messaging")
      messaging.push({
        kind: p.definition.kind,
        provider: client as MessagingProvider,
      });
    else (providers as Record<string, unknown>)[p.capability] = client;
  }
  if (messaging.length) providers.messaging = combineMessaging(messaging);
  return providers;
}

/**
 * Verify an inbound provider webhook (e.g. POST /providers/billplz/webhook) and
 * translate it into an actuator event. Returns null for valid but irrelevant
 * webhooks; throws WebhookVerificationError for bad signatures.
 */
export async function parseProviderWebhookFromEnv(
  env: Record<string, unknown>,
  kind: string,
  request: Request,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderWebhookResult | { reply: string }> {
  const configured = configuredFromEnv(env).find((p) => p.definition.kind === kind);
  if (!configured?.definition.parseWebhook) throw new WebhookVerificationError(`No ${kind} provider is configured.`);
  const reply = configured.definition.handshake?.(request, configured.credentials);
  if (reply != null) return { reply };
  return configured.definition.parseWebhook(request, configured.credentials, {
    fetch: fetchImpl,
  });
}
