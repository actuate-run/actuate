#!/usr/bin/env node
/**
 * Publish the packages for a release tag. Run by .github/workflows/release.yml on a pushed v* tag;
 * locally, `node scripts/publish.mjs v0.2.0 --dry-run` shows what it would do.
 *
 * - The tag must equal every package's version (they release together; see .changeset/config.json).
 * - Versions already on npm are skipped, so a re-run after a partial failure is safe.
 * - Each package is packed with pnpm (workspace:* becomes the real version), then published with
 *   npm, which handles trusted publishing (OIDC) and provenance in CI.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tag = args.find((a) => !a.startsWith("--")) ?? process.env.GITHUB_REF_NAME ?? "";

// Dependency order: a package is published after the ones it depends on.
const ORDER = ["sdk", "providers", "runtime", "create-actuate", "cli"];

const fail = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) fail(`"${tag}" is not a release tag like v0.2.0.`);
const version = tag.slice(1);

const packages = ORDER.map((dir) => {
  const pkg = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  return { dir, name: pkg.name, version: pkg.version };
});
const extra = readdirSync(join(root, "packages")).filter((d) => !ORDER.includes(d));
if (extra.length) fail(`packages/ has ${extra.join(", ")}, which isn't in the publish order. Add it to ORDER.`);
const mismatched = packages.filter((p) => p.version !== version);
if (mismatched.length) {
  fail(`Tag ${tag} doesn't match ${mismatched.map((p) => `${p.name}@${p.version}`).join(", ")}. Run \`pnpm changeset version\`, merge, then tag.`);
}

const published = (name, v) => {
  try {
    return execFileSync("npm", ["view", `${name}@${v}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === v;
  } catch {
    return false; // 404: not published yet
  }
};

const out = mkdtempSync(join(tmpdir(), "actuate-publish-"));
const preid = version.includes("-") ? version.split("-")[1].split(".")[0] : null; // e.g. 0.3.0-beta.1 → "beta"
for (const p of packages) {
  if (published(p.name, version)) {
    console.log(`• ${p.name}@${version} is already on npm, skipping`);
    continue;
  }
  const dir = join(root, "packages", p.dir);
  const tarball = execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: dir, encoding: "utf8" }).trim().split("\n").pop();
  const publishArgs = ["publish", tarball, "--access", "public", ...(preid ? ["--tag", preid] : [])];
  if (dryRun) publishArgs.push("--dry-run");
  else if (process.env.CI) publishArgs.push("--provenance");
  console.log(`→ npm ${publishArgs.join(" ")}`);
  execFileSync("npm", publishArgs, { cwd: dir, stdio: "inherit" });
}
console.log(dryRun ? "Dry run done; nothing was published." : `Released ${tag}.`);
