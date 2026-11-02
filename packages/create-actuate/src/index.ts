import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATES_REPO = "actuate-run/templates";

/**
 * The range scaffolded projects use for @actuate/sdk and @actuate/cli: this package's own
 * version, which changesets keeps equal to theirs (one "fixed" group in .changeset/config.json).
 */
export const SDK_VERSION = `^${(JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }).version}`;

export interface ScaffoldOptions {
  dir: string;
  /** Template folder name in the templates repo, or "hello" for the built-in starter. */
  template?: string;
  /** Git ref of the templates repo. Default "main". */
  ref?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export const HELLO_ACTUATOR = `import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  greeting: z.string().default("Hello"),
  followUpAfter: z.enum(["10 seconds", "1 hour", "1 day"]).default("10 seconds"),
});

export const InputSchema = z.object({
  name: z.string().min(1).describe("Who to greet"),
});

export default defineActuator({
  name: "hello",
  description: "Greets someone, waits, then follows up. A starting point for your own actuator.",
  config: ConfigSchema,
  input: InputSchema,
  // For MCP clients: this tool adds a row and sends nothing outside, so it isn't destructive.
  hints: { destructive: false, openWorld: false },
  async run(ctx, input, config) {
    await ctx.db.migrate([
      "CREATE TABLE greetings (run_id TEXT PRIMARY KEY, name TEXT NOT NULL, greeted_at TEXT NOT NULL)",
    ]);

    const greetedAt = await ctx.step.do("greet", async () => {
      const at = new Date().toISOString();
      await ctx.db.sql\`INSERT INTO greetings (run_id, name, greeted_at) VALUES (\${ctx.runId}, \${input.name}, \${at})\`;
      ctx.log.info(\`\${config.greeting}, \${input.name}!\`);
      return at;
    });

    // The run hibernates here. Nothing runs, and nothing is billed, until it wakes.
    await ctx.step.sleep(config.followUpAfter);

    await ctx.step.do("follow-up", () => ctx.log.info(\`Still there, \${input.name}?\`));
    return { greetedAt };
  },
});
`;

export function scaffoldFiles(name: string, actuatorSource: string, extra: Record<string, string> = {}): Record<string, string> {
  const pkg = {
    name,
    private: true,
    type: "module",
    scripts: { dev: "actuate dev", check: "actuate check", deploy: "actuate deploy", typecheck: "tsc --noEmit" },
    dependencies: { "@actuate/sdk": SDK_VERSION },
    devDependencies: { "@actuate/cli": SDK_VERSION, typescript: "^5.9.3" },
  };
  return {
    "package.json": JSON.stringify(pkg, null, 2) + "\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            lib: ["ES2023", "DOM"],
          },
          include: ["*.ts"],
        },
        null,
        2,
      ) + "\n",
    ".gitignore": "node_modules/\n.actuate/\n.dev.vars\n.env\n",
    "actuate.config.json": "{}\n",
    "actuator.ts": actuatorSource,
    ...extra,
  };
}

async function fetchTemplate(template: string, ref: string, doFetch: typeof fetch): Promise<Record<string, string>> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(template)) throw new Error(`Invalid template name "${template}"`);
  const raw = (file: string) => `https://raw.githubusercontent.com/${TEMPLATES_REPO}/${ref}/${template}/${file}`;
  const res = await doFetch(raw("actuator.ts"));
  if (!res.ok) {
    throw new Error(`Template "${template}" not found in ${TEMPLATES_REPO}@${ref} (HTTP ${res.status}). Templates: https://github.com/${TEMPLATES_REPO}`);
  }
  const files: Record<string, string> = { "actuator.ts": await res.text() };
  for (const optional of ["README.md", ".env.example", "actuate.config.json"]) {
    const r = await doFetch(raw(optional));
    if (r.ok) files[optional] = await r.text();
  }
  return files;
}

/** Create a new actuator project. Returns the absolute directory. */
export async function scaffold(options: ScaffoldOptions): Promise<string> {
  const dir = resolve(options.dir);
  const log = options.log ?? console.log;
  if (existsSync(dir) && readdirSync(dir).filter((f) => f !== ".git").length > 0) {
    throw new Error(`${dir} is not empty.`);
  }
  const template = options.template ?? "hello";
  let files: Record<string, string>;
  if (template === "hello") {
    files = scaffoldFiles(basename(dir), HELLO_ACTUATOR);
  } else {
    const fetched = await fetchTemplate(template, options.ref ?? "main", options.fetch ?? fetch);
    const { "actuator.ts": source, ...rest } = fetched;
    files = scaffoldFiles(basename(dir), source!, rest);
  }
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  log(`Created ${template} actuator in ${dir}`);
  return dir;
}
