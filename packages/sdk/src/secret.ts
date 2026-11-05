import type { z } from "zod";

/**
 * Mark a config field as secret: an API key, a token, a password. Its value never shows in run logs, errors,
 * run records or step outputs (each occurrence becomes `[secret]`), and on the hosted platform it is set in
 * the dashboard's Config tab, kept when a deploy's config leaves it out, and never read back.
 *
 * ```ts
 * config: z.object({
 *   apiKey: secret(z.string()),
 *   webhookToken: secret(z.string()).optional(),
 * }),
 * ```
 *
 * The same as `schema.meta({ writeOnly: true })`: the field's JSON Schema gets `"writeOnly": true`, which is
 * what the runtime and the platform look for. Use it on the field itself (also inside nested objects and
 * arrays); it survives `.optional()`, `.nullable()` and `.default()`. Strings, and numbers as their digits,
 * are redacted; values shorter than 6 characters and booleans are not, nor are encodings the runtime doesn't
 * know (base64 of a secret, say). Redaction uses the secrets configured now: output stored before a key was
 * changed shows the old key.
 */
export function secret<T extends z.ZodType>(schema: T): T {
  // The schema's own `meta`, not a registry imported here: on the platform the actuator's bundled zod writes its JSON Schema.
  return schema.meta({ writeOnly: true }) as T;
}
