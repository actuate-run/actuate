/**
 * Node module hooks that let `node --test` run TypeScript test files as they
 * are: `.ts` files are compiled with esbuild (inline source maps, so stack
 * traces point at your lines), and `./actuator.js` finds `./actuator.ts`.
 * Registered by test-register.ts; used by `actuate test`.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const TS = /\.[cm]?tsx?$/;

interface ResolveContext {
  parentURL?: string;
}
type NextResolve = (specifier: string, context: ResolveContext) => Promise<{ url: string }>;
type NextLoad = (url: string, context: unknown) => Promise<{ format?: string; source?: unknown }>;

/** `./x.js` → `./x.ts`, `./x` → `./x.ts` or `./x/index.ts`, as TypeScript resolves them. */
function candidates(specifier: string): string[] {
  if (/\.js$/.test(specifier)) return [specifier.replace(/\.js$/, ".ts"), specifier.replace(/\.js$/, ".tsx")];
  if (/\.mjs$/.test(specifier)) return [specifier.replace(/\.mjs$/, ".mts")];
  if (/\.cjs$/.test(specifier)) return [specifier.replace(/\.cjs$/, ".cts")];
  if (!/\.[a-z]+$/i.test(specifier)) return [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`];
  return [];
}

export async function resolve(specifier: string, context: ResolveContext, next: NextResolve): Promise<{ url: string; shortCircuit?: boolean }> {
  const relative = specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || specifier.startsWith("file:");
  if (relative && context.parentURL?.startsWith("file:")) {
    const exact = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(exact))) {
      for (const candidate of candidates(specifier)) {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}

export async function load(url: string, context: unknown, next: NextLoad): Promise<{ format?: string; source?: unknown; shortCircuit?: boolean }> {
  if (url.startsWith("file:") && TS.test(new URL(url).pathname) && !url.includes("/node_modules/")) {
    const path = fileURLToPath(url);
    const cjs = path.endsWith(".cts");
    const out = await transform(await readFile(path, "utf8"), {
      loader: path.endsWith("x") ? "tsx" : "ts",
      format: cjs ? "cjs" : "esm",
      target: "node22",
      sourcemap: "inline",
      sourcefile: path,
    });
    return { format: cjs ? "commonjs" : "module", source: out.code, shortCircuit: true };
  }
  return next(url, context);
}
