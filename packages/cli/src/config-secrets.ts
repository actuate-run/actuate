import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { secretFields } from "@actuate/runtime";
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

/**
 * The same warning for plain `actuate check`, as a diagnostic on actuate.config.json. Asks git first, and
 * loads the actuator for its config schema only when the file would be committed. Never throws: an actuator
 * that doesn't load is for the other checks to report.
 */
export async function committedSecretDiagnostic(cwd: string, file: string): Promise<Diagnostic | null> {
  const { readConfigFile } = await import("./deploy.js");
  const config = readConfigFile(cwd);
  if (!config || !("value" in config) || !gitWouldCommit(cwd, "actuate.config.json")) return null;
  try {
    const { describeActuator, loadActuator } = await import("./load.js");
    const actuator = await loadActuator(resolve(cwd, file), join(cwd, ".actuate", "tmp"));
    const issue = committedSecretIssue(cwd, describeActuator(actuator).configSchema, config.value);
    return issue ? { file: "actuate.config.json", line: 1, column: 1, severity: "warning", rule: issue.rule, message: issue.message } : null;
  } catch {
    return null;
  }
}
