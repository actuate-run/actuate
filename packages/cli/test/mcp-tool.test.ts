import { describe, expect, it } from "vitest";
import { defineActuator, z } from "@actuate/sdk";
import { mcpToolEntry } from "@actuate/runtime";
import { describeActuator, type ActuatorMetadata } from "../src/load.js";

/**
 * The platform gateway's toolFor (actuate-run/platform apps/gateway/src/mcp.ts), copied verbatim as of 0.4.1 apart
 * from its parameter type. mcpToolEntry must match it byte for byte on every actuator without an idempotencyKey,
 * so the gateway can delegate to it after 0.5.0 without changing a single tools/list entry.
 */
function platformToolFor(actuator: { name: string; metadata: ActuatorMetadata }) {
  const { $schema: _ignored, ...inputSchema } = actuator.metadata.inputSchema as Record<string, unknown>;
  const output = actuator.metadata.outputSchema as Record<string, unknown> | null;
  const hints = actuator.metadata.hints ?? {};
  const readOnly = hints.readOnly === true && hints.destructive !== true;
  const external = [...(actuator.metadata.capabilities ?? []), ...(actuator.metadata.optionalCapabilities ?? [])].length > 0;
  const title = actuator.name.replace(/_/g, " ");
  return {
    name: actuator.name,
    title,
    description: actuator.metadata.description,
    inputSchema: { type: "object", ...inputSchema },
    ...(output && output.type === "object" ? { outputSchema: stripSchemaKey(output) } : {}),
    annotations: {
      title,
      readOnlyHint: readOnly,
      destructiveHint: readOnly ? false : (hints.destructive ?? true),
      idempotentHint: readOnly ? true : (hints.idempotent ?? false),
      openWorldHint: hints.openWorld ?? external,
    },
  };
}
function stripSchemaKey(schema: Record<string, unknown>) {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

const base = { name: "refund_order", description: "Refunds an order after approval.", input: z.object({ orderId: z.string(), amount: z.number().positive() }), run: () => null };
const describe_ = (def: Record<string, unknown>) => describeActuator(defineActuator({ ...base, ...def } as never));

const HINTS = [
  {},
  { readOnly: true },
  { readOnly: true, destructive: true },
  { readOnly: false, destructive: false },
  { destructive: false, idempotent: true, openWorld: true },
  { idempotent: false },
  { idempotent: true },
  { openWorld: false },
  { readOnly: true, idempotent: false },
] as const;

const FIXTURES: ActuatorMetadata[] = [
  ...HINTS.map((hints) => describe_({ hints })),
  ...HINTS.map((hints) => describe_({ hints, capabilities: ["http"], http: { allow: ["api.example.com"] } })),
  describe_({ optionalCapabilities: ["messaging"] }),
  describe_({ name: "plain" }),
  describe_({ output: z.object({ refundId: z.string(), status: z.enum(["REFUNDED", "REJECTED"]) }) }),
  describe_({ output: z.string() }),
  describe_({ output: z.array(z.string()) }),
  describe_({ input: z.object({}).describe("No arguments") }),
  describe_({ input: z.object({ when: z.iso.datetime(), tags: z.array(z.string()).max(3), note: z.string().optional() }) }),
];

describe("mcpToolEntry", () => {
  it("builds the same tools/list entry as the platform gateway, byte for byte", () => {
    for (const metadata of FIXTURES) {
      expect(JSON.stringify(mcpToolEntry(metadata))).toBe(JSON.stringify(platformToolFor({ name: metadata.name, metadata })));
    }
  });

  it("is explicit about every annotation, and leaves $schema out", () => {
    const entry = mcpToolEntry(describe_({ output: z.object({ ok: z.boolean() }) }));
    expect(entry).toEqual({
      name: "refund_order",
      title: "refund order",
      description: "Refunds an order after approval.",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string" }, amount: { type: "number", exclusiveMinimum: 0 } },
        required: ["orderId", "amount"],
      },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
      annotations: { title: "refund order", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    });
    expect(JSON.stringify(entry)).not.toContain("$schema");
  });

  it("calls a tool with an idempotencyKey idempotent, unless hints.idempotent is false", () => {
    const keyed = (hints?: Record<string, boolean>) => mcpToolEntry(describe_({ idempotencyKey: ["orderId"], ...(hints ? { hints } : {}) })).annotations.idempotentHint;
    expect(keyed()).toBe(true);
    expect(keyed({ idempotent: true })).toBe(true);
    expect(keyed({ idempotent: false })).toBe(false);
    expect(keyed({ readOnly: true, idempotent: false })).toBe(true); // read-only is always idempotent
    expect(mcpToolEntry({ ...describe_({}), idempotencyKey: [] }).annotations.idempotentHint).toBe(false);
    // Everything else is as without the key.
    const { idempotentHint: _a, ...rest } = mcpToolEntry(describe_({ idempotencyKey: ["orderId"] })).annotations;
    const { idempotentHint: _b, ...plain } = mcpToolEntry(describe_({})).annotations;
    expect(rest).toEqual(plain);
  });
});
