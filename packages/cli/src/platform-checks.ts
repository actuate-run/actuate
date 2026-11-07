import { z, type Actuator } from "@actuate/sdk";
import { unredactedSecretDefaultIssues } from "./config-secrets.js";
import { cronProblem, parseCron } from "./cron.js";
import type { ActuatorMetadata } from "./load.js";
import { MAX_BUNDLE_BYTES, type PlanRules } from "./plans.js";

/**
 * The hosted platform's deploy checks, mirrored so `actuate check --platform`
 * and `actuate deploy` can stop before an upload that would be refused. Every
 * deploy attempt counts against the plan's deploy budget, refused ones
 * included. The platform re-runs its own checks and has the final say.
 */
export interface PlatformIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
}

/** What the account says (GET /v1/me, /v1/providers, /v1/actuators), when logged in. */
export interface AccountFacts {
  /** Capabilities with a provider set up in the dashboard. */
  configuredCapabilities?: readonly string[];
  /** Whether this actuator is already deployed, and how many the account has. */
  exists?: boolean;
  actuatorCount?: number;
  /** Deploy attempts this month (failed ones included). */
  deploysThisMonth?: number;
}

export interface PlatformCheckInput {
  metadata: ActuatorMetadata;
  /** The loaded actuator, for the checks that need its schemas. */
  actuator?: Actuator;
  plan: PlanRules;
  /**
   * The plan is only the default (nobody said which: not logged in, no --plan). Then the plan's own rules (capabilities,
   * cron limits) are warnings, not errors: a fresh project made from a template that sends messages passes `check`.
   */
  planDefaulted?: boolean;
  bundleBytes?: number;
  /** actuate.config.json as it would be sent: its value, or why it couldn't be read. Omit when no config is sent. */
  config?: { value: unknown } | { error: string };
  /** Where `config` came from, for its error message. Default "actuate.config.json". */
  configSource?: string;
  account?: AccountFacts;
}

/** Every rule, for `--help` and `--json`: what it checks and what it needs. */
export const PLATFORM_RULES: ReadonlyArray<{ rule: string; checks: string; needs?: "plan" | "login" }> = [
  { rule: "bundle-size", checks: "the bundle is at most 5 MB" },
  { rule: "name", checks: "the name is lowercase letters, digits and underscores (at most 64), not starting with actuate_" },
  { rule: "cron", checks: "cron syntax, how many schedules, and how often they fire (alone and together)", needs: "plan" },
  { rule: "cron-input", checks: "the input schema accepts {}, the input every cron run gets; with idempotencyKey it can't, and cron runs never use the key (warning)" },
  { rule: "idempotency-key", checks: "every idempotencyKey field is a required, top-level string, number, integer or boolean input field" },
  { rule: "http-allow", checks: "http.allow: at most 20 hostnames, no IP addresses, no actuate.run, no wildcard over a shared zone" },
  { rule: "input-regex", checks: "no regex in the input schema with nested quantifiers such as (a+)+" },
  { rule: "plan-capability", checks: "every required capability is on the plan (optional ones get a warning)", needs: "plan" },
  { rule: "config", checks: "actuate.config.json is JSON and matches the config schema" },
  { rule: "config-secret", checks: "actuate.config.json sets no secret field while git would commit it (warning; local only)" },
  { rule: "secret-default-not-redacted", checks: "no secret field has a default redaction can't hide: a boolean, or shorter than 6 characters (warning)" },
  { rule: "provider-missing", checks: "a provider is set up for every required capability", needs: "login" },
  { rule: "actuator-limit", checks: "a new actuator fits the plan's actuator count", needs: "login" },
  { rule: "deploy-budget", checks: "deploy attempts left this month", needs: "login" },
];

export function platformChecks(input: PlatformCheckInput): PlatformIssue[] {
  const issues: PlatformIssue[] = [];
  const error = (rule: string, message: string) => void issues.push({ severity: "error", rule, message });
  const warn = (rule: string, message: string) => void issues.push({ severity: "warning", rule, message });
  const { metadata: m, plan } = input;
  const yours = "That is only the default plan here: log in or pass --plan to check against yours.";
  const planRule = (rule: string, message: string) => (input.planDefaulted ? warn(rule, `${message} ${yours}`) : error(rule, message));

  if (input.bundleBytes !== undefined && input.bundleBytes > MAX_BUNDLE_BYTES) {
    error("bundle-size", `Bundle is larger than 5 MB (${(input.bundleBytes / 1024 / 1024).toFixed(1)} MB).`);
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(m.name)) error("name", `Invalid actuator name "${m.name}"`);
  // The platform's MCP endpoint has its own tools under this prefix. Self-hosted actuators may still use it.
  else if (m.name.startsWith("actuate_")) {
    error("name", `Actuator names starting with "actuate_" are reserved for Actuate's built-in tools (actuate_get_run, actuate_list_runs, actuate_cancel_run). Rename it.`);
  }

  // A malformed expression is refused on every plan, so it is an error even when the plan is only the default.
  // The plan's limits are still checked on the count of all schedules and on the expressions that parse.
  const parsable: string[] = [];
  for (const expr of m.cron) {
    try {
      parseCron(expr);
      parsable.push(expr);
    } catch (err) {
      error("cron", (err as Error).message);
    }
  }
  const cron =
    m.cron.length > plan.limits.cronsPerActuator
      ? cronProblem(m.cron, plan.limits.cronsPerActuator, plan.limits.minCronIntervalMinutes)
      : cronProblem(parsable, plan.limits.cronsPerActuator, plan.limits.minCronIntervalMinutes);
  if (cron) planRule("cron", `${cron} The ${plan.name} plan allows ${plan.limits.cronsPerActuator} schedules, at least ${plan.limits.minCronIntervalMinutes} min apart.`);
  const keyed = (m.idempotencyKey?.length ?? 0) > 0;
  const cronRejects = m.cron.length > 0 && !!input.actuator && !input.actuator.input.safeParse({}).success;
  if (cronRejects && keyed) {
    warn("cron-input", "Every cron run starts with the input {}, which the input schema rejects (the idempotencyKey fields are required), so every firing fails. Cron runs never use idempotencyKey: move the schedule to an actuator of its own.");
  } else if (cronRejects) {
    warn("cron-input", "Every cron run starts with the input {}, which the input schema rejects, so every firing fails. Make the fields optional or give them defaults.");
  }
  for (const problem of idempotencyKeyProblems(m.inputSchema, m.idempotencyKey)) error("idempotency-key", problem);

  for (const problem of httpAllowProblems(m.httpAllow)) error("http-allow", problem);
  for (const problem of regexProblems(m.inputSchema)) error("input-regex", problem);

  const disallowed = m.capabilities.filter((c) => !plan.capabilities.includes(c as never));
  if (disallowed.length) {
    planRule("plan-capability", `The ${plan.name} plan cannot use ${disallowed.join(", ")}. Upgrade to Maker to use providers.`);
  }
  const optionalOff = m.optionalCapabilities.filter((c) => !plan.capabilities.includes(c as never));
  if (optionalOff.length) {
    warn("plan-capability", `The ${plan.name} plan has no ${optionalOff.join(", ")} providers, so ${optionalOff.map((c) => `ctx.${c}`).join(" and ")} will be undefined.`);
  }

  if (input.config && "error" in input.config) error("config", input.config.error);
  else if (input.config && input.actuator) {
    const parsed = (input.actuator.config ?? z.object({})).safeParse(input.config.value);
    if (!parsed.success) error("config", `Invalid config in ${input.configSource ?? "actuate.config.json"}:${formatIssues(parsed.error.issues)}`);
  }
  // A secret field's default ships in the code and is redacted like the value, unless redaction can't catch it.
  issues.push(...unredactedSecretDefaultIssues(m.configSchema));

  const a = input.account;
  if (a?.configuredCapabilities) {
    const missing = m.capabilities.filter((c) => c !== "http" && plan.capabilities.includes(c as never) && !a.configuredCapabilities!.includes(c));
    if (missing.length) error("provider-missing", `No provider configured for: ${missing.join(", ")}. Add one in the dashboard (Settings → Providers) first.`);
  }
  if (a?.exists === false && a.actuatorCount !== undefined && a.actuatorCount >= plan.maxActuators) {
    error("actuator-limit", `The ${plan.name} plan allows ${plan.maxActuators} actuators.`);
  }
  if (a?.deploysThisMonth !== undefined) {
    const max = plan.limits.deploysPerMonth;
    if (a.deploysThisMonth >= max) {
      error("deploy-budget", `The ${plan.name} plan allows ${max.toLocaleString("en")} deploys a month (failed ones and rollbacks count). The count resets on the 1st (UTC).`);
    } else if (a.deploysThisMonth >= max * 0.9) {
      warn("deploy-budget", `${a.deploysThisMonth.toLocaleString("en")} of ${max.toLocaleString("en")} deploys used this month.`);
    }
  }
  return issues;
}

const KEY_TYPES = new Set(["string", "number", "integer", "boolean"]);
const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * What is wrong with an actuator's `idempotencyKey`, judged on the input's JSON Schema (input side), as the
 * platform judges it: each field must be a top-level property listed in `required`, of type string, number,
 * integer or boolean (or an enum or const of those). A field with a default is not required: the key is computed
 * from the input as sent, so it must always be there.
 */
export function idempotencyKeyProblems(inputSchema: unknown, fields: readonly string[] | undefined): string[] {
  if (fields === undefined) return [];
  if (!Array.isArray(fields) || fields.length === 0) return ["idempotencyKey lists no fields. List the input fields that identify a request, or leave it out."];
  const root = (inputSchema && typeof inputSchema === "object" ? inputSchema : {}) as Record<string, unknown>;
  type ObjectSchema = { properties?: Record<string, Record<string, unknown>>; required?: unknown };
  // The input itself may be a $ref (zod's `.meta({ id })` on the object): `{"$ref":"#/$defs/Order","$defs":{...}}`.
  const schema = (resolveLocalRef(root, root) ?? {}) as ObjectSchema;
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    const name = String(field);
    if (seen.has(name)) {
      problems.push(`idempotencyKey lists "${name}" twice.`);
      continue;
    }
    seen.add(name);
    const prop = Object.prototype.hasOwnProperty.call(properties, name) ? resolveLocalRef(root, properties[name]) : undefined;
    if (typeof field !== "string" || !prop) {
      problems.push(`idempotencyKey field "${name}" is not a top-level field of the input schema.`);
      continue;
    }
    const scalar =
      (typeof prop.type === "string" && KEY_TYPES.has(prop.type)) ||
      (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.every(isScalar)) ||
      ("const" in prop && isScalar(prop.const));
    if (!scalar) problems.push(`idempotencyKey field "${name}" must be a string, number, integer or boolean.`);
    else if (!required.includes(name)) {
      problems.push(`idempotencyKey field "${name}" must be required in the input schema (not optional, no default): the run key is computed from the input as sent.`);
    }
  }
  return problems;
}

/**
 * Follow a local `$ref` (`#/$defs/<id>` or `#/definitions/<id>`, as zod emits for a schema with `.meta({ id })`),
 * keeping the referring node's own keywords. Anything else, and a ref that names no definition, is returned as it is.
 *
 * zod writes ids as they are (`#/$defs/50%`), while JSON Pointer percent-encodes them (`#/$defs/a%20b`), so the
 * segment is looked up raw first, then JSON-Pointer-unescaped (`~1` is `/`, `~0` is `~`), then percent-decoded and
 * unescaped. A segment that can't be percent-decoded simply has no decoded candidate.
 */
function resolveLocalRef(root: { $defs?: unknown; definitions?: unknown }, node: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  let current = node;
  for (let i = 0; current && typeof current.$ref === "string" && i < 16; i++) {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(current.$ref);
    const defs = m ? (root[m[1] as "$defs" | "definitions"] as Record<string, Record<string, unknown>> | undefined) : undefined;
    const target = m && defs && typeof defs === "object" ? refCandidates(m[2]!).map((n) => (Object.prototype.hasOwnProperty.call(defs, n) ? defs[n] : undefined)).find(Boolean) : undefined;
    if (!target || typeof target !== "object") return current;
    const { $ref: _ref, ...own } = current;
    current = { ...target, ...own };
  }
  return current;
}

function refCandidates(segment: string): string[] {
  const unescape = (v: string) => v.replace(/~1/g, "/").replace(/~0/g, "~");
  const out = [segment, unescape(segment)];
  try {
    out.push(unescape(decodeURIComponent(segment)));
  } catch {
    // Not percent-encoded (e.g. a raw "50%"): the raw candidates are all there is.
  }
  return [...new Set(out)];
}

export function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues.map((i) => `\n  ${i.path.length ? i.path.map(String).join(".") : "(root)"}: ${i.message}`).join("");
}

/** Multi-label public suffixes and shared hosting zones, where a wildcard would cover other people's sites. */
const SHARED_ZONES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.my", "net.my", "org.my", "edu.my", "gov.my", "com.sg", "edu.sg", "gov.sg",
  "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "or.jp", "com.br", "co.in", "com.cn", "com.hk", "com.tw",
  "co.id", "or.id", "com.ph", "co.th", "in.th", "com.vn", "com.mx", "co.za", "com.tr", "co.kr",
  "github.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "herokuapp.com", "appspot.com", "web.app",
  "firebaseapp.com", "cloudfront.net", "amazonaws.com", "azurewebsites.net", "onrender.com", "fly.dev", "r2.dev",
]);
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function httpAllowProblems(entries: readonly string[]): string[] {
  const problems: string[] = [];
  if (entries.length > 20) problems.push("http.allow may list at most 20 domains.");
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase().replace(/\.$/, "");
    const wildcard = entry.startsWith("*.");
    const host = wildcard ? entry.slice(2) : entry;
    const labels = host.split(".");
    if (!host || labels.some((l) => !LABEL.test(l)) || labels.length < 2) {
      problems.push(`http.allow entry "${raw}" must be a hostname like api.example.com or *.example.com.`);
    } else if (/^\d+$/.test(labels[labels.length - 1]!)) {
      problems.push(`http.allow entry "${raw}": IP addresses are not allowed.`);
    } else if (host === "actuate.run" || host.endsWith(".actuate.run")) {
      problems.push(`http.allow entry "${raw}": an actuator cannot call the platform.`);
    } else if (wildcard && SHARED_ZONES.has(host)) {
      problems.push(`http.allow entry "${raw}" is too broad: a wildcard must sit under a domain you control (e.g. *.example.com).`);
    }
  }
  return problems;
}

/** The exact patterns zod emits for its built-in string formats: vetted upstream, so not flagged. */
let zodPatterns: ReadonlySet<string> | undefined;
function zodFormatPatterns(): ReadonlySet<string> {
  if (zodPatterns) return zodPatterns;
  const props = z
    .object({
      a: z.email(), b: z.uuid(), c: z.guid(), d: z.iso.datetime(), e: z.iso.date(), f: z.iso.time(), g: z.iso.duration(),
      h: z.ipv4(), i: z.ipv6(), j: z.cuid(), k: z.cuid2(), l: z.ulid(), m: z.nanoid(), n: z.base64(), o: z.base64url(),
      p: z.e164(), q: z.emoji(), r: z.ksuid(), s: z.xid(), t: z.cidrv4(), u: z.cidrv6(), v: z.url(), w: z.hostname(),
    })
    .toJSONSchema().properties as Record<string, { pattern?: string }>;
  return (zodPatterns = new Set(Object.values(props).map((p) => p.pattern).filter((p): p is string => Boolean(p))));
}

/** A repeated group that itself contains a repeat, e.g. (a+)+ or (\w*)*: catastrophic backtracking. */
const NESTED = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,)/;

export function regexProblems(schema: unknown): string[] {
  const problems: string[] = [];
  const vetted = zodFormatPatterns();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "pattern" && typeof v === "string" && !vetted.has(v) && NESTED.test(v)) {
        problems.push(`The regex /${v}/ can backtrack catastrophically (a repeated group containing a repeat). Simplify it.`);
      }
      if (k === "patternProperties" && v && typeof v === "object") {
        for (const key of Object.keys(v)) if (NESTED.test(key)) problems.push(`The regex /${key}/ can backtrack catastrophically.`);
      }
      walk(v);
    }
  };
  walk(schema);
  return problems;
}
