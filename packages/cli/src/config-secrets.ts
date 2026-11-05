import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { MIN_SECRET_LENGTH, secretFields } from "@actuate/runtime";
import type { Diagnostic } from "./check.js";
import type { PlatformIssue } from "./platform-checks.js";

export const CONFIG_SECRET_RULE = "config-secret";

/**
 * Whether git would commit `file` (relative to `cwd`): `cwd` is inside a git work tree and the file is not
 * ignored (`git check-ignore` exits 1; a tracked file counts as not ignored, whatever .gitignore says).
 * False outside a work tree, when git is missing, or on any other git error: then nothing can be said.
 */
export function gitWouldCommit(cwd: string, file: string): boolean {
  const git = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== "true") return false;
  return git(["check-ignore", "-q", "--", file]).status === 1;
}

/**
 * A warning when actuate.config.json sets a secret (`writeOnly`) field and git would commit the file. Secrets
 * belong in the dashboard: the platform keeps a stored secret when a deploy's config leaves it out.
 */
export function committedSecretIssue(cwd: string, configSchema: unknown, config: unknown): PlatformIssue | null {
  const fields = secretFields(configSchema, config);
  if (!fields.length || !gitWouldCommit(cwd, "actuate.config.json")) return null;
  const one = fields.length === 1;
  return {
    severity: "warning",
    rule: CONFIG_SECRET_RULE,
    message:
      `actuate.config.json sets the secret field${one ? "" : "s"} ${fields.join(", ")}, and git does not ignore the file, so ${one ? "it" : "they"} would be committed. ` +
      `Set ${one ? "it" : "them"} in the dashboard (Config tab) and leave ${one ? "it" : "them"} out of the file: the platform keeps a stored secret when the file omits it. ` +
      `For \`actuate dev\`, put ${one ? "it" : "them"} in .dev.vars as ACTUATE_CONFIG.`,
  };
}

export const SECRET_DEFAULT_RULE = "secret-default-not-redacted";

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

/** True for a default value redaction would leave in clear: a boolean, or a string or number shorter than MIN_SECRET_LENGTH. */
function unredacted(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value).length < MIN_SECRET_LENGTH;
  if (Array.isArray(value)) return value.some(unredacted);
  if (isNode(value)) return Object.values(value).some(unredacted);
  return false;
}

/**
 * Paths of secret (`writeOnly`) config fields whose schema default would never be redacted: booleans, and strings or
 * numbers shorter than MIN_SECRET_LENGTH. A default on a non-secret parent counts for the secret children it sets.
 * Paths use the runtime's notation (`a.b`, `list[]`, `keys.*`).
 */
export function unredactedSecretDefaults(configSchema: unknown): string[] {
  const root = isNode(configSchema) ? configSchema : {};
  const found = new Set<string>();
  const resolve = (node: Node, seen: Set<string>): Node | null => {
    const ref = node.$ref;
    if (typeof ref !== "string") return node;
    if (!ref.startsWith("#/") || seen.has(ref)) return null;
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) target = isNode(target) ? target[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
    return isNode(target) ? { ...target, ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== "$ref")) } : null;
  };
  const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
  // `inherited`: a default some ancestor set for this node's position, so a parent's default reaches its secret children.
  const walk = (raw: unknown, path: string, secret: boolean, inherited: unknown, seen: Set<string>): void => {
    if (!isNode(raw)) return;
    const node = resolve(raw, seen);
    if (!node) return;
    const nextSeen = typeof raw.$ref === "string" ? new Set(seen).add(raw.$ref) : seen;
    const isSecret = secret || node.writeOnly === true;
    const fallback = "default" in node ? node.default : inherited;
    if (isSecret && fallback !== undefined && unredacted(fallback)) found.add(path);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const list = node[key];
      if (Array.isArray(list)) for (const sub of list) walk(sub, path, isSecret, fallback, nextSeen);
    }
    const props = node.properties;
    if (isNode(props)) {
      for (const [k, sub] of Object.entries(props)) walk(sub, join(path, k), isSecret, isNode(fallback) ? fallback[k] : undefined, nextSeen);
    }
    if (node.items !== undefined && !Array.isArray(node.items)) walk(node.items, `${path}[]`, isSecret, undefined, nextSeen);
    if (isNode(node.additionalProperties)) walk(node.additionalProperties, join(path, "*"), isSecret, undefined, nextSeen);
  };
  walk(root, "", false, undefined, new Set());
  return [...found];
}

/** Warnings for secret fields whose schema default would show in clear (see {@link unredactedSecretDefaults}). */
export function unredactedSecretDefaultIssues(configSchema: unknown): PlatformIssue[] {
  return unredactedSecretDefaults(configSchema).map((path) => ({
    severity: "warning" as const,
    rule: SECRET_DEFAULT_RULE,
    message:
      `Secret field "${path || "(the whole config)"}" has a default that is never redacted (booleans and values shorter than ${MIN_SECRET_LENGTH} characters are not). ` +
      `Remove the default, or set the value in the dashboard instead.`,
  }));
}

/** Whether a config holds any value at all (not only `{}`, `null`s and `""`s). */
const hasAnyValue = (v: unknown): boolean =>
  typeof v === "string" ? v !== "" : Array.isArray(v) ? v.some(hasAnyValue) : typeof v === "object" && v !== null ? Object.values(v).some(hasAnyValue) : v !== null && v !== undefined;

/** The actuator's config JSON Schema, by loading the file (top-level code runs). */
async function loadConfigSchema(cwd: string, file: string): Promise<unknown> {
  const { describeActuator, loadActuator } = await import("./load.js");
  return describeActuator(await loadActuator(resolve(cwd, file), join(cwd, ".actuate", "tmp"))).configSchema;
}

/**
 * The same warning for plain `actuate check`, as a diagnostic on actuate.config.json. Loads the actuator for its
 * config schema only when it can matter: the file holds some value and git would commit it. Never throws: an
 * actuator that doesn't load is for the other checks to report.
 */
export async function committedSecretDiagnostic(
  cwd: string,
  file: string,
  loadSchema: (cwd: string, file: string) => Promise<unknown> = loadConfigSchema,
): Promise<Diagnostic | null> {
  const { readConfigFile } = await import("./deploy.js");
  const config = readConfigFile(cwd);
  if (!config || !("value" in config) || !hasAnyValue(config.value) || !gitWouldCommit(cwd, "actuate.config.json")) return null;
  try {
    const issue = committedSecretIssue(cwd, await loadSchema(cwd, file), config.value);
    return issue ? { file: "actuate.config.json", line: 1, column: 1, severity: "warning", rule: issue.rule, message: issue.message } : null;
  } catch {
    return null;
  }
}
