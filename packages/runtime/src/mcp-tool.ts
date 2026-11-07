import type { ToolHints } from "@actuate/sdk";

/** What {@link mcpToolEntry} reads from an actuator's deploy metadata (`describeActuator` in @actuate/cli). */
export interface McpToolMetadata {
  name: string;
  description: string;
  capabilities?: readonly string[];
  optionalCapabilities?: readonly string[];
  hints?: ToolHints;
  /** The input's JSON Schema (input side). */
  inputSchema: unknown;
  /** The output's JSON Schema, or null. Published only when it describes an object. */
  outputSchema?: unknown;
  idempotencyKey?: readonly string[];
}

export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** One entry of an MCP `tools/list` result. */
export interface McpToolEntry {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

/**
 * The MCP `tools/list` entry for an actuator, as the hosted platform's MCP endpoint serves it. `actuate deploy
 * --dry-run` prints it.
 *
 * Annotations are always explicit, so directories and clients never fall back to the spec's permissive defaults:
 * - read-only only when `hints.readOnly` is true and `hints.destructive` isn't;
 * - destructive unless read-only or `hints.destructive` is false;
 * - idempotent when read-only, else `hints.idempotent`, else whether `idempotencyKey` is declared;
 * - open-world as `hints.openWorld` says, else when the actuator declares any capability (required or optional):
 *   one without only touches its own database.
 */
export function mcpToolEntry(metadata: McpToolMetadata): McpToolEntry {
  const { $schema: _ignored, ...inputSchema } = (metadata.inputSchema ?? {}) as Record<string, unknown>;
  const output = (metadata.outputSchema ?? null) as Record<string, unknown> | null;
  const hints = metadata.hints ?? {};
  const readOnly = hints.readOnly === true && hints.destructive !== true;
  const external = [...(metadata.capabilities ?? []), ...(metadata.optionalCapabilities ?? [])].length > 0;
  const keyed = (metadata.idempotencyKey?.length ?? 0) > 0;
  const title = metadata.name.replace(/_/g, " ");
  return {
    name: metadata.name,
    title,
    description: metadata.description,
    inputSchema: { type: "object", ...inputSchema },
    ...(output && output.type === "object" ? { outputSchema: withoutSchemaKey(output) } : {}),
    annotations: {
      title,
      readOnlyHint: readOnly,
      destructiveHint: readOnly ? false : (hints.destructive ?? true),
      idempotentHint: readOnly ? true : (hints.idempotent ?? keyed),
      openWorldHint: hints.openWorld ?? external,
    },
  };
}

function withoutSchemaKey(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}
