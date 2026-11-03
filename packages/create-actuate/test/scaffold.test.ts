import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffold } from "../src/index.js";

const quiet = () => {};

describe("scaffold", () => {
  it("writes the hello starter", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ca-")), "my-bot");
    await scaffold({ dir, log: quiet });
    expect(readdirSync(dir).sort()).toEqual([".gitignore", "actuate.config.json", "actuator.ts", "package.json", "tsconfig.json"]);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).toMatchObject({ name: "my-bot", scripts: { dev: "actuate dev" } });
  });

  it("fetches a named template from the templates repo", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      if (url.endsWith("/actuator.ts")) return new Response("// template");
      if (url.endsWith("/README.md")) return new Response("# readme");
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const dir = join(mkdtempSync(join(tmpdir(), "ca-")), "x");
    await scaffold({ dir, template: "daily-report", fetch: fakeFetch, log: quiet });
    expect(urls[0]).toBe("https://raw.githubusercontent.com/actuate-run/templates/main/daily-report/actuator.ts");
    expect(readFileSync(join(dir, "actuator.ts"), "utf8")).toBe("// template");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# readme");
  });

  it("refuses non-empty directories and bad template names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ca-"));
    await scaffold({ dir: join(dir, "a"), log: quiet });
    await expect(scaffold({ dir: join(dir, "a"), log: quiet })).rejects.toThrow(/not empty/);
    await expect(scaffold({ dir: join(dir, "b"), template: "../etc", log: quiet })).rejects.toThrow(/Invalid template/);
    for (const ref of ["../../evil/repo/main", "main/../../x", "-x", "a b"]) {
      await expect(scaffold({ dir: join(dir, "b"), template: "daily-report", ref, log: quiet })).rejects.toThrow(/Invalid git ref/);
    }
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(scaffold({ dir: join(dir, "c"), template: "nope", fetch: notFound, log: quiet })).rejects.toThrow(
      /not found in actuate-run\/templates@main \(HTTP 404\)\. Templates: https:\/\/github\.com\/actuate-run\/templates/,
    );
  });
});

describe("versions", () => {
  it("scaffolds projects on this release's SDK and CLI, not a hard-coded range", async () => {
    const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const fixed = JSON.parse(readFileSync(new URL("../../../.changeset/config.json", import.meta.url), "utf8")).fixed as string[][];
    // create-actuate's version only tracks the SDK's if changesets releases them together.
    expect(fixed.find((g) => g.includes("create-actuate"))).toEqual(expect.arrayContaining(["@actuate/sdk", "@actuate/cli"]));
    const dir = join(mkdtempSync(join(tmpdir(), "ca-")), "v");
    await scaffold({ dir, log: quiet });
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@actuate/sdk"]).toBe(`^${own}`);
    expect(pkg.devDependencies["@actuate/cli"]).toBe(`^${own}`);
  });
});
