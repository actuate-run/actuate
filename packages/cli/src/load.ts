import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  const out = join(workDir, `actuator-${Date.now()}.mjs`);
  writeFileSync(out, code.outputFiles[0]!.text);
  const mod = (await import(pathToFileURL(out).href)) as { default?: unknown };
  if (!isActuator(mod.default)) {
    throw new Error(`${file} must \`export default defineActuator({ ... })\`.`);
  }
  return mod.default;
}

export interface ActuatorMetadata {
  name: string;
  description: string;
  capabilities: string[];
  httpAllow: string[];
  cron: string[];
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
    httpAllow: [...(actuator.http?.allow ?? [])],
    cron: [...(actuator.cron ?? [])],
    inputSchema: z.toJSONSchema(actuator.input, opts),
    configSchema: z.toJSONSchema(actuator.config ?? z.object({}), opts),
    outputSchema: actuator.output ? z.toJSONSchema(actuator.output, { ...opts, io: "output" }) : null,
  };
}

export function packageDir(specifier: string): string {
  return dirname(cliResolve(`${specifier}/package.json`));
}
