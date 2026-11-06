import type { TriggerKind } from "@actuate/sdk";

/** Prefix of a run key derived from input fields, keeping it apart from `mcp:...` keys and HTTP `Idempotency-Key`s. */
export const INPUT_KEY_PREFIX = "input:";

/** How long a COMPLETED run keeps matching its derived key, ms (24 hours). RUNNING and WAITING runs always match. */
export const INPUT_KEY_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether runs started by this trigger get a key derived from `idempotencyKey` when the caller sends none:
 * MCP tool calls and the run API. Never cron (every firing has the same input) and never webhooks (a delivery
 * key, when the sender has one, is the right key there).
 */
export function triggerDerivesInputKey(kind: TriggerKind): boolean {
  return kind === "mcp" || kind === "api";
}

/** JSON with object keys sorted, so the same value always encodes the same way. `undefined` becomes `null`. */
function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The text a derived key hashes: a JSON array of `input`'s values for `fields`, in the order of `fields`
 * (a missing field is `null`). Other fields, and the order of the input's own keys, make no difference.
 */
export function inputKeyMaterial(fields: readonly string[], input: unknown): string {
  const record = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return canonicalJson(fields.map((f) => (Object.prototype.hasOwnProperty.call(record, f) ? record[f] : null)));
}

/**
 * The run key derived from an actuator's `idempotencyKey` fields: `input:<SHA-256 hex of inputKeyMaterial>`,
 * or `undefined` (no key: every call starts a run) when no fields are declared or the input lacks one of them
 * (absent or `undefined`), so calls that leave an optional key field out never share a key. Pass the input as the caller sent it, after it passed validation
 * (the JSON Schema check, or `safeParse` succeeding) but before zod's defaults, coercion and transforms, so
 * every host computes the same key. Keys are per actuator: compare them only within one actuator's runs.
 * Pass it to `RunManager.start` as `inputKey`, and only when the caller sent no idempotency key of its own.
 */
export async function deriveInputKey(fields: readonly string[] | undefined, input: unknown): Promise<string | undefined> {
  if (!fields?.length) return undefined;
  const record = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (fields.some((f) => !Object.prototype.hasOwnProperty.call(record, f) || record[f] === undefined)) return undefined;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inputKeyMaterial(fields, input))));
  return INPUT_KEY_PREFIX + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
