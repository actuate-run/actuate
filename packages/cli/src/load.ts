import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type BuildOptions, type Plugin } from "esbuild";
import { isActuator, z, type Actuator } from "@actuate/sdk";

const require = createRequire(import.meta.url);

/**
 * zod's `z` namespace pulls in ~60 locale packs (about half of a bundle).
 * Actuators only need English messages, so every other locale is dropped.
 * `z.locales.en` keeps working; other locales are undefined.
 */
export const zodEnglishOnly: Plugin = {
  name: "actuate-zod-english-only",
  setup(b) {
    b.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/ }, () => ({
      contents: `export { default as en } from "./en.js";`,
      loader: "js",
    }));
  },
};

/** esbuild options shared by every bundle that targets workerd. */
export const workerBuildOptions: BuildOptions = {
  plugins: [zodEnglishOnly],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  conditions: ["workerd", "worker", "browser", "import", "default"],
  mainFields: ["module", "main"],
  external: ["cloudflare:workers", "node:*"],
  logLevel: "silent",
};

/** Resolve a package from the CLI's own dependencies, so user projects need only @actuate/sdk. */
export function cliResolve(specifier: string): string {
  return require.resolve(specifier);
}

/** Bundle the actuator file into one ESM module (SDK and zod included). This is what `deploy` uploads. */
export async function bundleActuator(file: string): Promise<string> {
  // Whitespace and syntax are minified; identifiers are kept so stack traces stay readable.
  const out = await build({
    ...workerBuildOptions,
    entryPoints: [resolve(file)],
    write: false,
    sourcemap: false,
    minifyWhitespace: true,
    minifySyntax: true,
  });
  return out.outputFiles[0]!.text;
}

/** Import the actuator in Node to read its metadata. Top-level code in the file runs. */
export async function loadActuator(file: string, workDir: string): Promise<Actuator> {
  const code = await build({
    entryPoints: [resolve(file)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
    logLevel: "silent",
  });
  mkdirSync(workDir, { recursive: true });
  const out = join(workDir, `actuator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(out, code.outputFiles[0]!.text);
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(out).href)) as { default?: unknown };
  } finally {
    rmSync(out, { force: true }); // imported modules stay loaded; the file isn't needed again
  }
  if (!isActuator(mod.default)) {
    throw new Error(`${file} must \`export default defineActuator({ ... })\`.`);
  }
  return mod.default;
}

export interface ActuatorMetadata {
  name: string;
  description: string;
  capabilities: string[];
  optionalCapabilities: string[];
  httpAllow: string[];
  cron: string[];
  hints: { readOnly?: boolean; idempotent?: boolean; destructive?: boolean; openWorld?: boolean };
  inputSchema: unknown;
  configSchema: unknown;
  outputSchema: unknown | null;
}

export function describeActuator(actuator: Actuator): ActuatorMetadata {
  const opts = { io: "input", unrepresentable: "any" } as const;
  return {
    name: actuator.name,
    description: actuator.description,
    capabilities: [...(actuator.capabilities ?? [])],
    optionalCapabilities: [...(actuator.optionalCapabilities ?? [])],
    httpAllow: [...(actuator.http?.allow ?? [])],
    cron: [...(actuator.cron ?? [])],
    hints: { ...(actuator.hints ?? {}) },
    inputSchema: z.toJSONSchema(actuator.input, opts),
    configSchema: z.toJSONSchema(actuator.config ?? z.object({}), opts),
    outputSchema: actuator.output ? z.toJSONSchema(actuator.output, { ...opts, io: "output" }) : null,
  };
}

export function packageDir(specifier: string): string {
  return dirname(cliResolve(`${specifier}/package.json`));
}

/** A module of this package, as built (dist, .js) or as source (tests, .ts). */
export function ownModule(name: string): string {
  for (const ext of [".js", ".ts"]) {
    const path = fileURLToPath(new URL(`./${name}${ext}`, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error(`@actuate/cli is missing its ${name} module. Reinstall it.`);
}

/** The folder of package `name` as installed for a project in `cwd` (node_modules, walking up), or null. */
export function findPackage(cwd: string, name: string): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}
